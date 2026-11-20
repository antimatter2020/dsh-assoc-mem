/**
 * 名词解释指令（方案 A：不抹除，用户可见可改）。
 *
 * 省 token：无待解释词时返回空串。
 * 可靠性：指令放在最前、措辞强硬、并带未完成催办。
 */

const MAX_ITEMS = 6
const GLOSS_MAX = 20
const DASH = '\u2014\u2014'

export function needGloss(pending) {
  return Array.isArray(pending) && pending.length > 0
}

/**
 * 生成指令。
 * @param pending 待解释的概念名
 * @param strike 连续漏做次数；>0 时追加催办措辞
 */
export function buildGlossInstruction(pending, strike = 0) {
  if (!needGloss(pending)) return ''
  const list = pending.slice(0, MAX_ITEMS).join('\u3001')
  const head = strike > 0
    ? '\u3010\u5fc5\u987b\u5b8c\u6210\u3011\u4e0a\u4e00\u8f6e\u4f60\u5df2\u7ecf\u6f0f\u6389\u8fd9\u4ef6\u4e8b\u3002'
    : '\u3010\u5fc5\u505a\u3011'
  return head + '\u56de\u7b54\u7684\u6700\u540e\u5fc5\u987b\u5305\u542b\u4e00\u884c\u300c\u8865\u5145\u89e3\u91ca\uff1a\u300d\uff0c' +
    '\u7136\u540e\u6bcf\u884c\u4e00\u6761\u300c\u540d\u8bcd ' + DASH + ' \u89e3\u91ca\u300d\uff08\u4e0d\u8d85\u8fc7' + GLOSS_MAX + '\u5b57\uff09\u3002' +
    '\u5f85\u89e3\u91ca\uff1a' + list + '\u3002' +
    '\u4e0d\u662f\u540d\u8bcd\u7684\u5199\u300c\u540d\u8bcd ' + DASH + ' \u975e\u540d\u8bcd\u300d\u3002'
}

const HEADER = /^\s*(?:\u8865\u5145\u89e3\u91ca|\u540d\u8bcd\u89e3\u91ca)\s*[:\uff1a]\s*(.*)$/

/** 回答里有没有出现过「补充解释：」标题 */
export function hasGlossSection(text) {
  return String(text || '').split(/\r?\n/).some((l) => HEADER.test(l.trim()))
}

export function parseGlossReply(text) {
  const lines = String(text || '').split(/\r?\n/)
  let armed = false
  const items = []
  const rejects = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const h = line.match(HEADER)
    if (h) {
      armed = true
      const rest = h[1].trim()
      if (rest) collect(rest, items, rejects)
      continue
    }
    if (!armed) continue
    if (/^[\u3010#]/.test(line)) break
    collect(line, items, rejects)
  }
  return { items, rejects }
}

function collect(line, items, rejects) {
  const m = line.match(/^\s*[-*\u00b7]?\s*([^\u2014\-:\uff1a]{1,20}?)\s*(?:\u2014\u2014|\u2014|--|[:\uff1a])\s*(.+)$/)
  if (!m) return
  const word = m[1].trim()
  const body = m[2].trim().replace(/^["'\u300c]|["'\u300d]$/g, '')
  if (!word || !body) return
  if (/^\u975e\u540d\u8bcd/.test(body) || /^\u4e0d\u662f\u540d\u8bcd/.test(body)) { rejects.push(word); return }
  items.push({ word, gloss: body.length > GLOSS_MAX ? body.slice(0, GLOSS_MAX) : body })
}
