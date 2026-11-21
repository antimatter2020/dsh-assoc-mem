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
          // 词间距：两端在原文里的字符距离
          dist: distanceOf(p.a, p.b, opts),
          // 边解释：context 模式直接存原文片段，llm 模式留空待生成
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

    return { added, hit, removed, pendingEdges }
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

  /** 1-hop 邻居，按权重降序，只返回过线边 */
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
    let dropped = 0
    for (const name of [...this.adj.keys()]) {
      if (alive.has(name)) continue
      this.dropNode(name)
      dropped += 1
    }
    return dropped
  }

  /** 删除一个概念及其全部边 */
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

/** 截取两个词之间的原文片段，限制在 EDGE_SPAN 字符内 */
function edgeContext(a, b, opts) {
  const text = opts && opts.text
  const pos = opts && opts.positions
  if (!text || !pos) return ''
  const pa = pos.get(a)
  const pb = pos.get(b)
  if (!pa || !pb) return ''
  const SPAN = 40
  const from = Math.min(pa.start, pb.start)
  const to = Math.max(pa.end, pb.end)
  if (to - from > SPAN) return ''
  return text.slice(from, to).replace(/\s+/g, ' ').trim()
}

export { edgeKey, norm }