/**
 * 句子切分：建边、语境截取、名词解释共用同一套规则。
 *
 * 为什么抽成独立模块：早先建边用一套（只认 。！？!?），语境用另一套（又多了逗号顿号），
 * 名词解释用第三套。规则一漂移，同一句话在三个地方被切得不一样。
 *
 * 切分分三层，由强到弱：
 *  1. 强边界：句末标点 。！？；… + 换行 + 英文句点（仅当后面是空白或行尾）
 *  2. 空格兜底：整段没有任何句末标点时，把连续空白也当边界。
 *     用户可能不用标点、纯靠空格断句（「我今天去学校 然后买东西 晚上回家」）。
 *     只在全文无强标点时启用，避免把正常中英混排按词切开。
 *  3. 逗号升级：有些用户只写逗号从不写句号，整段就是一句。
 *     切出来超过 SENTENCE_MAX 字时，把逗号顿号也当边界再切一次。
 */

/** 超过这个长度（字符）就把逗号当句边界——应对「只有逗号没有句号」的写法 */
export const SENTENCE_MAX = 60

/** 句末标点：中文句号问号叹号分号省略号 + 英文对应 */
const STRONG_PUNCT = '。！？；…!?;'

/** 只要出现这些就不再启用空格兜底（说明作者是会用标点的） */
function hasStrongPunct(text) {
  for (const ch of text) if (STRONG_PUNCT.includes(ch)) return true
  // 英文句点：后接空白或行尾才算句末，避免切断 README.md、v0.1.0、3.github
  if (/\.([\s]|$)/.test(text)) return true
  return false
}

/**
 * 按强边界切。返回的 text 是原文切片（不 trim），
 * 这样 start/end 与内部相对偏移始终对得上原文。
 */
function splitStrong(text) {
  const out = []
  let start = 0
  const push = (end) => {
    if (end > start) out.push({ start, end, text: text.slice(start, end) })
    start = end
  }
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '\n' || ch === '\r') { push(i + 1); continue }
    if (STRONG_PUNCT.includes(ch)) {
      // 连续标点（「？！？」「……」）当一个边界吞掉
      let j = i + 1
      while (j < text.length && (STRONG_PUNCT.includes(text[j]) || text[j] === '.')) j += 1
      push(j)
      i = j - 1
      continue
    }
    // 英文句点：只有后面是空白或行尾才算句末
    if (ch === '.' && (i + 1 >= text.length || /\s/.test(text[i + 1]))) {
      let j = i + 1
      while (j < text.length && text[j] === '.') j += 1
      push(j)
      i = j - 1
    }
  }
  push(text.length)
  return out
}

/** 按连续空白切（仅用于整段没有标点的用户） */
function splitBySpace(text) {
  const out = []
  const re = /[^\s]+/g
  let m
  while ((m = re.exec(text)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0] })
  }
  return out
}

/** 过长时把逗号顿号当边界再切一次 */
function splitByCommaIfLong(piece, text) {
  if (piece.text.length <= SENTENCE_MAX) return [piece]
  const out = []
  let start = piece.start
  for (let i = piece.start; i < piece.end; i += 1) {
    const ch = text[i]
    if (ch === '，' || ch === ',' || ch === '、' || ch === '：' || ch === ':') {
      out.push({ start, end: i + 1, text: text.slice(start, i + 1) })
      start = i + 1
    }
  }
  if (start < piece.end) out.push({ start, end: piece.end, text: text.slice(start, piece.end) })
  return out.length ? out : [piece]
}

/**
 * 切句。返回 [{start, end, text}]，start/end 是相对入参 text 的偏移。
 */
export function splitSentences(text) {
  const t = String(text || '')
  if (!t.trim()) return []
  let parts = splitStrong(t)
  // 整段没有句末标点，又有空白 → 认定这类用户靠空格断句
  if (!hasStrongPunct(t) && parts.length <= 1 && /\s/.test(t.trim())) {
    parts = splitBySpace(t)
  }
  const out = []
  for (const p of parts) {
    if (!p.text.trim()) continue
    for (const q of splitByCommaIfLong(p, t)) {
      if (q.text.trim()) out.push(q)
    }
  }
  return out
}

/**
 * 取包含指定位置的句子。用于语境截取与名词解释。
 * 返回 {start, end, text} 或 null。
 */
export function sentenceAt(text, index) {
  const t = String(text || '')
  const idx = Math.max(0, Math.min(t.length, Number(index) || 0))
  const parts = splitSentences(t)
  if (!parts.length) return null
  for (const p of parts) if (p.start <= idx && idx < p.end) return p
  return parts[parts.length - 1]
}
