import { sentenceAt } from './sentence.js'

/**
 * 联想记忆图：惰性衰减的带权无向图。
 *
 * 权重更新遵循 SPEC.md 的定稿公式：
 *   w(t) = w_birth * (1 - i/g_s) ^ (t - last_t)
 *   命中边  w += (h+1)^alpha * x + y
 *   新边    w  = (h+1)^alpha * x + w0
 * 衰减在读取时才结算（惰性），与逐轮相乘严格等价。
 */

export const DEFAULTS = {
  alpha: 1.0,
  x: 0.03,
  y: 0.06,
  w0: 0.05,
  i: 0.005,
  wmax: 0.9,
  thr: 0.05,
  deleteLine: 0.005,
  maxInject: 8,
  gBase: 3,
  /** 边解释模式：'off' | 'context'（零 LLM）| 'llm' */
  edgeMode: 'context',
}

function norm(a, b) {
  return a < b ? [a, b] : [b, a]
}

function edgeKey(a, b) {
  const [u, v] = norm(a, b)
  return u + '\u0000' + v
}

export class MemoryGraph {
  constructor(params = {}) {
    this.params = { ...DEFAULTS, ...params }
    /** @type {Map<string, {a:string,b:string,w:number,bornS:number,lastT:number,bornT:number,hit:number}>} */
    this.edges = new Map()
    /** @type {Map<string, Map<string, true>>} */
    this.adj = new Map()
    /**
     * 多边结构（团）：同一句话里同时出现的全部概念，作为整体存一条解释。
     *
     * 为什么不能只用二元边：一句话里出现 ABC，这条关联是**三元**的，
     * 硬拆成 AB、BC、AC 三条边各写一句解释，既重复又丢掉了「三者同时在场」这个信息。
     * key 是排序后的词名用 \u0000 连接，value 是 { names, gloss, glossKind, dist }。
     *
     * 与二元边不冲突：ABC 存一条团解释，AB（不含 C）仍可另存一条边解释。
     * @type {Map<string, {names: string[], gloss: string, glossKind: string, dist: number}>}
     */
    this.cliques = new Map()
    this.round = 0
  }

  gOf(s) {
    const base = this.params.gBase
    return Math.pow(base, Math.max(0, Math.min(3, s | 0)))
  }

  /** 惰性结算：把边推到当前轮次 */
  settle(edge, now = this.round) {
    if (edge.lastT === now) return edge.w
    const rate = 1 - this.params.i / this.gOf(edge.bornS)
    const steps = now - edge.lastT
    edge.w = edge.w * Math.pow(Math.max(0, rate), steps)
    edge.lastT = now
    return edge.w
  }

  link(a, b) {
    const key = edgeKey(a, b)
    let set = this.adj.get(a)
    if (!set) { set = new Map(); this.adj.set(a, set) }
    set.set(b, true)
    set = this.adj.get(b)
    if (!set) { set = new Map(); this.adj.set(b, set) }
    set.set(a, true)
    return key
  }

  /**
   * 摄入一个片段。
   * @param {string[]} concepts 本片段概念（已去重、已按重叠规则过滤）
   * @param {number} s 重要性档位 0..3
   * @returns {{added:number,hit:number,removed:number}}
   */
  /**
   * 摄入一个片段。
   * @param concepts 概念名数组
   * @param s 重要性档位
   * @param opts.positions Map<概念名, {start,end}>，用于算词间距与截取上下文
   * @param opts.text 原文，用于截取边解释
   * @param opts.edgeMode 'context' | 'llm' | 'off'
   */
  ingest(concepts, s = 1, opts = {}) {
    const P = this.params
    const now = ++this.round
    const list = [...new Set(concepts)].filter(Boolean)
    if (list.length < 2) return { added: 0, hit: 0, removed: 0, pendingEdges: [] }

    // 能形成团就不建单边（用户口径）：同一句话里 >=3 个概念时，
    // 这层关系由「团」整体承载，再拆成两两边属于重复并引入噪声。
    // 恰好 2 个概念时才是单边。
    const cliqueNames = list.length >= 3 ? [...list].sort() : null

    // 1) 先数命中（必须在建新边之前）
    const pairs = []
    let hit = 0
    for (let m = 0; m < list.length; m += 1) {
      for (let n = m + 1; n < list.length; n += 1) {
        const a = list[m]
        const b = list[n]
        const key = edgeKey(a, b)
        const edge = this.edges.get(key)
        pairs.push({ a, b, key, edge })
        if (edge) hit += 1
      }
    }

    // 2) 结算 + 加重
    const k = Math.pow(hit + 1, P.alpha)
    const boost = k * P.x
    let added = 0

    // 团：本句 >=3 个概念。已有则记一次命中，没有则新建。
    let cliqueTouched = null
    if (cliqueNames) {
      const key = cliqueNames.join('\u0000')
      let c = this.cliques.get(key)
      const isNew = !c
      if (!c) {
        c = { names: cliqueNames, gloss: '', glossKind: '', dist: 0, hit: 0, lastT: now, bornS: s | 0 }
        this.cliques.set(key, c)
        added += 1
      } else {
        c.hit = (c.hit || 0) + 1
        c.lastT = now
        hit += 1
      }
      // 团也要登记进 adj，否则 isolatePrune 会把这些节点当孤立概念删掉
      for (let i = 0; i < cliqueNames.length; i += 1) {
        for (let j = i + 1; j < cliqueNames.length; j += 1) this.link(cliqueNames[i], cliqueNames[j])
      }
      cliqueTouched = c
      // context 模式：团也存整句；llm 模式留空待生成
      if (!c.gloss && this.params.edgeMode !== 'off' && this.params.edgeMode !== 'llm') {
        const snip = cliqueContext(cliqueNames, opts)
        if (snip) { c.gloss = snip; c.glossKind = 'context' }
      }
    }

    // 单边：只在「本句恰好 2 个概念」时建立/加强。
    // 团成员之间的二元边一律不建，且已有的一并清掉（见 syncCliqueEdges）。
    if (!cliqueNames) {
      for (const p of pairs) {
        if (p.edge) {
          this.settle(p.edge, now)
          p.edge.w = Math.min(P.wmax, p.edge.w + boost + P.y)
          p.edge.hit = (p.edge.hit || 0) + 1
        } else {
          const edge = {
            a: norm(p.a, p.b)[0],
            b: norm(p.a, p.b)[1],
            w: Math.min(P.wmax, boost + P.w0),
            bornS: s | 0,
            lastT: now,
            bornT: now,
            hit: 0,
            dist: distanceOf(p.a, p.b, opts),
            gloss: '',
            glossKind: '',
          }
          if (this.params.edgeMode !== 'off' && this.params.edgeMode !== 'llm') {
            const snippet = edgeContext(p.a, p.b, opts)
            if (snippet) { edge.gloss = snippet; edge.glossKind = 'context' }
          }
          this.edges.set(p.key, edge)
          this.link(edge.a, edge.b)
          added += 1
        }
      }
    }

    // 团纳管后，清掉成员之间残留的二元边（旧数据或先前按二元建出来的）
    this.syncCliqueEdges()

    const removed = this.prune(now)

    // llm 模式下，收集需要生成边解释的新边（按距离最近优先）
    const pendingEdges = []
    if (this.params.edgeMode === 'llm') {
      for (const p of pairs) {
        const e = this.edges.get(p.key)
        if (e && !e.gloss) pendingEdges.push({ a: e.a, b: e.b, dist: e.dist })
      }
      pendingEdges.sort((x, y) => x.dist - y.dist)
    }

    // 需要生成解释的「团」：同句 >=3 个概念且还没写过解释
    const pendingCliques = []
    if (this.params.edgeMode === 'llm' && list.length >= 3) {
      const names = [...list].sort()
      const c = this.cliques.get(names.join('\u0000'))
      if (c && !c.gloss) pendingCliques.push({ names: c.names })
    }

    return { added, hit, removed, pendingEdges, pendingCliques }
  }

  /**
   * 清掉团成员之间已存在的二元边。
   *
   * 用户口径：能形成团就不能形成单边。旧数据里这些边是先按两句法定下的，
   * 团纳管之后必须删掉，否则同一段关系会同时以「团」和「多个单边」两种形式存在，
   * 界面上就会出现六个概念各挂一条同样的整句解释。
   *
   * @returns {number} 删掉的边数
   */
  syncCliqueEdges() {
    let removed = 0
    for (const c of this.cliques.values()) {
      const names = c && Array.isArray(c.names) ? c.names : []
      for (let i = 0; i < names.length; i += 1) {
        for (let j = i + 1; j < names.length; j += 1) {
          const key = edgeKey(names[i], names[j])
          if (!this.edges.has(key)) continue
          const edge = this.edges.get(key)
          this.edges.delete(key)
          if (edge) this.unlink(edge.a, edge.b)
          removed += 1
        }
      }
    }
    // 删边后为团成员重新连上 adj（团依赖它维持存活）
    for (const c of this.cliques.values()) {
      const names = c && Array.isArray(c.names) ? c.names : []
      for (let i = 0; i < names.length; i += 1) {
        for (let j = i + 1; j < names.length; j += 1) this.link(names[i], names[j])
      }
    }
    if (removed) this.dirty = true
    return removed
  }

  /** 清理低于淘汰线的边 */
  prune(now = this.round) {
    const P = this.params
    let removed = 0
    for (const [key, edge] of this.edges) {
      this.settle(edge, now)
      if (edge.w < P.deleteLine) {
        this.edges.delete(key)
        this.unlink(edge.a, edge.b)
        removed += 1
      }
    }
    return removed
  }

  unlink(a, b) {
    const sa = this.adj.get(a)
    if (sa) { sa.delete(b); if (!sa.size) this.adj.delete(a) }
    const sb = this.adj.get(b)
    if (sb) { sb.delete(a); if (!sb.size) this.adj.delete(b) }
  }

/**
   * 1-hop 邻居，按权重降序。
   *
   * 只返回**二元边**上的邻居。团成员不算邻居——
   * 团是整体关系，成员之间的 adj 连接只是为了维持节点存活和清理判断，
   * 若在这里返回，界面上就会变成「每个成员都挂着其他成员 + 同一条团解释」，
   * 那正是要避免的重复呈现。
   */
  neighbours(name, limit = 0) {
    const set = this.adj.get(name)
    if (!set) return []
    const P = this.params
    const out = []
    for (const other of set.keys()) {
      const edge = this.edges.get(edgeKey(name, other))
      if (!edge) continue
      const w = this.settle(edge, this.round)
      if (w >= P.thr) out.push({ name: other, w })
    }
    out.sort((p, q) => q.w - p.w)
    return limit > 0 ? out.slice(0, limit) : out
  }

  /** 找出包含该词的团（可能多个） */
  cliquesOf(name) {
    const out = []
    for (const c of this.cliques.values()) {
      if (c && Array.isArray(c.names) && c.names.includes(name)) out.push(c)
    }
    return out
  }

  /**
   * 清理所有「一条过线边都没有」的孤立概念。
   * 用户的口径：下一轮如果某个概念连一条边都没有了，也要跟着清除。
   * @returns {number} 清掉的节点数
   */
  isolatePrune() {
    const P = this.params
    const alive = new Set()
    for (const edge of this.edges.values()) {
      this.settle(edge, this.round)
      if (edge.w >= P.thr) { alive.add(edge.a); alive.add(edge.b) }
    }
    // 团的成员也算存活。团本身没有 w 字段（它是整体关系，不参与衰减），
    // 只要团还在，成员就不该被判为孤立——否则会出现「团还在、词没了」的矛盾状态。
    for (const c of this.cliques.values()) {
      const names = c && Array.isArray(c.names) ? c.names : []
      for (const n of names) alive.add(n)
    }
    let dropped = 0
    for (const name of [...this.adj.keys()]) {
      if (alive.has(name)) continue
      this.dropNode(name)
      dropped += 1
    }
    return dropped
  }

  /** 删除一个概念及其全部边与所属团 */
  dropNode(name) {
    const set = this.adj.get(name)
    if (set) {
      for (const other of [...set.keys()]) {
        this.edges.delete(edgeKey(name, other))
      }
      this.adj.delete(name)
    }
    for (const [key, edge] of [...this.edges]) {
      if (edge.a === name || edge.b === name) this.edges.delete(key)
    }
    // 包含该词的团一并拆掉：少一个成员的团不再是原来的关系，
    // 留着只会在注入时渲染出一个残缺却还带着旧解释的组合。
    for (const [key, c] of [...this.cliques]) {
      const names = c && Array.isArray(c.names) ? c.names : []
      if (!names.includes(name)) continue
      this.cliques.delete(key)
      // 团删除后，其余成员之间那层「仅为存活而连」的 adj 也要撤掉
      for (let i = 0; i < names.length; i += 1) {
        for (let j = i + 1; j < names.length; j += 1) {
          if (names[i] === name || names[j] === name) continue
          if (this.edges.has(edgeKey(names[i], names[j]))) continue
          const still = this.cliquesOf(names[i]).length > 0
          if (!still) this.unlink(names[i], names[j])
        }
      }
    }
  }

  /** 合并两个概念：b 并入 a */
  mergeNodes(from, to) {
    const set = this.adj.get(from)
    if (set) {
      for (const other of [...set.keys()]) {
        if (other === to) { this.edges.delete(edgeKey(from, to)); continue }
        const keyOld = edgeKey(from, other)
        const old = this.edges.get(keyOld)
        if (old) {
          this.edges.delete(keyOld)
          this.unlink(from, other)
          const keyNew = edgeKey(to, other)
          const exist = this.edges.get(keyNew)
          if (exist) {
            this.settle(exist)
            exist.w = Math.min(this.params.wmax, exist.w + old.w)
          } else {
            this.edges.set(keyNew, { ...old, a: norm(to, other)[0], b: norm(to, other)[1] })
            this.link(to, other)
          }
        }
      }
    }
    this.dropNode(from)
  }

  stats() {
    const P = this.params
    const deg = new Map()
    let alive = 0
    for (const edge of this.edges.values()) {
      const w = this.settle(edge, this.round)
      if (w < P.thr) continue
      alive += 1
      deg.set(edge.a, (deg.get(edge.a) || 0) + 1)
      deg.set(edge.b, (deg.get(edge.b) || 0) + 1)
    }
    const byS = [0, 0, 0, 0]
    for (const edge of this.edges.values()) byS[edge.bornS] = (byS[edge.bornS] || 0) + 1
    return { total: this.edges.size, alive, round: this.round, degree: deg, byS }
  }

  toJSON() {
    return {
      params: this.params,
      round: this.round,
      edges: [...this.edges.values()],
      // 团结构也要落盘，否则重启后多边解释全丢
      cliques: [...this.cliques.values()],
    }
  }

  static fromJSON(raw) {
    const g = new MemoryGraph(raw && raw.params ? raw.params : {})
    g.round = raw && typeof raw.round === 'number' ? raw.round : 0
    const list = raw && Array.isArray(raw.edges) ? raw.edges : []
    for (const e of list) {
      if (!e || typeof e.a !== 'string' || typeof e.b !== 'string') continue
      g.edges.set(edgeKey(e.a, e.b), {
        a: e.a, b: e.b,
        w: Number(e.w) || 0,
        bornS: e.bornS | 0,
        lastT: e.lastT | 0,
        bornT: e.bornT | 0,
        hit: e.hit | 0,
        // 关系解释必须一起存回来，否则重启后全部丢失
        dist: Number.isFinite(Number(e.dist)) ? Number(e.dist) : 9999,
        gloss: typeof e.gloss === 'string' ? e.gloss : '',
        glossKind: typeof e.glossKind === 'string' ? e.glossKind : '',
      })
      g.link(e.a, e.b)
    }
    // 恢复团结构
    const cs = raw && Array.isArray(raw.cliques) ? raw.cliques : []
    for (const c of cs) {
      if (!c || !Array.isArray(c.names) || c.names.length < 3) continue
      const names = c.names.filter((x) => typeof x === 'string')
      if (names.length < 3) continue
      g.cliques.set(names.join('\u0000'), {
        names,
        gloss: typeof c.gloss === 'string' ? c.gloss : '',
        glossKind: typeof c.glossKind === 'string' ? c.glossKind : '',
        dist: Number(c.dist) || 0,
      })
    }
    return g
  }
}

function distanceOf(a, b, opts) {
  const pos = opts && opts.positions
  if (!pos) return 9999
  const pa = pos.get(a)
  const pb = pos.get(b)
  if (!pa || !pb) return 9999
  if (pa.end <= pb.start) return pb.start - pa.end
  if (pb.end <= pa.start) return pa.start - pb.end
  return 0
}

/**
 * 取两个词所在的**完整一句**原文。
 *
 * 语义：按句取，整句原样保存，不掐头去尾。
 * 早先是截 [a, b] 之间那一段并限制 40（后来 80）字符，结果是半句话——
 * 「香蕉和芭蕉」这种只剩两个词的碎片，读不出「为什么连在一起」。
 * 现在因为建边本身就只在同句内进行，两个词必然同句，直接返回整句即可。
 *
 * 仍用 sentenceAt 兜底：万一传入的 text 不止一句（例如手动喂文本），
 * 也能取到包含两词的那一句，而不是把整段塞进去。
 */
/** 团的整句原文：取成员所在的那一句，原样返回不截断 */
function cliqueContext(names, opts) {
  const text = opts && opts.text
  const pos = opts && opts.positions
  if (!text || !pos || !names.length) return ''
  const first = pos.get(names[0])
  if (!first) return String(text).trim()
  const s = sentenceAt(text, first.start)
  return s ? String(s.text).trim() : String(text).trim()
}

function edgeContext(a, b, opts) {
  const text = opts && opts.text
  const pos = opts && opts.positions
  if (!text || !pos) return ''
  const pa = pos.get(a)
  const pb = pos.get(b)
  if (!pa || !pb) return ''
  // 两词同句时整句返回；不同句则各取所在句子拼起来，仍然不截断
  const sa = sentenceAt(text, pa.start)
  const sb = sentenceAt(text, pb.start)
  if (!sa && !sb) return String(text).trim()
  if (!sa) return String(sb.text).trim()
  if (!sb) return String(sa.text).trim()
  if (sa.start === sb.start) return String(sa.text).trim()
  return (String(sa.text).trim() + String(sb.text).trim())
}
export { edgeKey, norm }