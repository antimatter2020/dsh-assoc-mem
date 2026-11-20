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

const MAX_CHARS = 900
const GLOSS_MAX = 40

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

function glossOf(store, name) {
  const node = store.nodes.get(name)
  if (!node || !node.gloss.length) return ''
  const g = node.gloss[node.gloss.length - 1].text
  return g.length > GLOSS_MAX ? g.slice(0, GLOSS_MAX) + '…' : g
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
  return '【记忆】\n' + lines.join('\n')
}

export function previewLines(store, tokenizer, text, options = {}) {
  const raw = buildInjection(store, tokenizer, text, options)
  if (!raw) return { text: '', chars: 0, items: 0 }
  const items = raw.split('\n').filter((l) => l && !l.startsWith('【')).length
  return { text: raw, chars: raw.length, items }
}
