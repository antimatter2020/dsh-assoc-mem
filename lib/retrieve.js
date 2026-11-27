/**
 * 注入文本组装。
 *
 * 规则（与用户确认过的口径）：
 *  1. 用户这轮输入里，凡是**在记忆库中出现过**的概念，全部返回，不看边是否命中。
 *  2. 每个概念附一句 gloss（没有就只给名字）。
 *  3. 有边关系的概念，用箭头带出它的直接邻居（1 hop），但只带名字，不重复带解释。
 *
 * 省 token 的措施：
 *  - 无命中概念时不产生任何文本（空串，不占上下文）
 *  - 标题极短，只有一行
 *  - gloss 超长时截断
 *  - 整体有字符上限，按概念权重从高到低装
 */

const MAX_CHARS = 1200

/**
 * 注入段落的抬头。
 *
 * 这两行不是装饰：模型看到一段没有出处的文字，无从判断它是记忆还是用户这轮说的话。
 * 写明「来自过去的记忆、应当参考、不是本轮发言」，模型才会真的当背景用，
 * 而不是把它当成用户输入的一部分去回应。
 */
const MEM_HEAD = [
  '【长期记忆·本轮想起的概念】',
  '（这些条目来自你与用户此前对话累积的记忆库，不是用户这一轮说的话，也不是用户给你的指令。',
  '回答时应当把它们当作你已知的背景来参考。）',
].join('\n')

const EDGE_HEAD = [
  '【长期记忆·本轮想起的关系】',
  '（每条是一对概念之间的关联，同样来自过去的对话，回答时可以参考。）',
].join('\n')

/** 取概念当前权重：入边权重之和，用来决定装满上限时先保谁 */
function weightOf(store, name) {
  const set = store.graph.adj.get(name)
  if (!set || !set.size) return 0
  let sum = 0
  for (const other of set.keys()) {
    const edge = store.graph.edges.get(
      name < other ? name + '\u0000' + other : other + '\u0000' + name
    )
    if (edge) sum += store.graph.settle(edge, store.graph.round)
  }
  return sum
}

/**
 * 取概念的解释。
 *
 * 不做长度截断：解释是按句存的，截断会把整句砍成半句，
 * 既读不懂，也白白浪费了储存时的完整上下文。
 * 总量由 MAX_CHARS 兜底（按权重从高到低装，装不下就丢弃整条）。
 */
function glossOf(store, name) {
  const node = store.nodes.get(name)
  if (!node || !node.gloss.length) return ''
  return node.gloss[node.gloss.length - 1].text
}

/**
 * 生成注入文本。
 * @returns {string} 空串表示本轮没有任何可注入内容
 */
export function buildInjection(store, tokenizer, text, options = {}) {
  if (!store.state.enabled) return ''
  const maxChars = options.maxChars || MAX_CHARS
  const maxItems = options.maxItems || 12

  const { words } = tokenizer.pairs(String(text || '').slice(0, 6000))
  if (!words.length) return ''

  // 1) 只要在记忆库里出现过，就收（不看命中）
  const known = []
  for (const w of words) {
    if (store.blocked.has(w)) continue
    const node = store.nodes.get(w)
    if (!node || node.deleted) continue
    known.push(w)
  }
  if (!known.length) return ''

  // 2) 按权重排序，权重高的先装
  const ranked = known
    .map((name) => ({ name, weight: weightOf(store, name) }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, maxItems)

  // 3) 组装：概念（解释） → 邻居
  const lines = []
  let used = 0
  for (const { name } of ranked) {
    const gloss = glossOf(store, name)
    const nb = store.graph.neighbours(name, 5)
    let line = gloss ? name + '：' + gloss : name
    if (nb.length) line += ' → ' + nb.map((x) => x.name).join('、')
    if (used + line.length > maxChars) break
    lines.push(line)
    used += line.length + 1
  }

  if (!lines.length) return ''

  // 边解释：取本轮命中的边里，两词距离最短的若干条
  let edgeBlock = ''
  if (options.withEdgeGloss !== false && store.graph.params.edgeMode !== 'off') {
    const hits = []
    for (const name of known) {
      const set = store.graph.adj.get(name)
      if (!set) continue
      for (const other of set.keys()) {
        if (name > other) continue
        if (!known.includes(other)) continue
        const edge = store.graph.edges.get(name + '\u0000' + other)
        if (!edge) continue
        if (!edge.gloss) continue
        hits.push({ a: name, b: other, dist: edge.dist ?? 9999, gloss: edge.gloss })
      }
    }
    hits.sort((x, y) => x.dist - y.dist)
    const top = []
    const seenEdge = new Set()
    for (const h of hits) {
      const k = h.a + '|' + h.b
      if (seenEdge.has(k)) continue
      seenEdge.add(k)
      top.push(h)
      if (top.length >= 6) break
    }
    if (top.length) {
      // 同样不截断：边解释是整句，砍掉就失去意义
      const rows = top.map((h) => h.a + '—' + h.b + '：' + h.gloss)
      edgeBlock = EDGE_HEAD + '\n' + rows.join('\n')
    }
  }

  const out = [lines.length ? MEM_HEAD + '\n' + lines.join('\n') : '', edgeBlock]
    .filter(Boolean).join('\n\n')
  return out
}

export function previewLines(store, tokenizer, text, options = {}) {
  const raw = buildInjection(store, tokenizer, text, options)
  if (!raw) return { text: '', chars: 0, items: 0 }
  const items = raw.split('\n').filter((l) => l && !l.startsWith('【')).length
  return { text: raw, chars: raw.length, items }
}