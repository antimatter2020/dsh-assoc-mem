/**
 * 片段划分。
 *
 *  - 用户直接输入：整段算一个片段，不再切
 *  - 文件：按行（自然段）切；不足 minLen 的相邻行向上合并
 */

const CJK_CHARS_PER_TOKEN = 1.5

export function estimateTokens(text) {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk / CJK_CHARS_PER_TOKEN + other / 4)
}

/** 用户输入：整体一个片段 */
export function userFragment(text, maxChars = 20000) {
  const t = String(text || '').trim()
  if (!t) return []
  if (t.length <= maxChars) return [t]
  // 超长输入按段落切开，避免单次爆炸
  return splitParagraphs(t, 75)
}

/** 文件内容：按自然段切，短行向上合并 */
export function splitParagraphs(text, minChars = 75) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((ln) => ln.trim())
    .filter(Boolean)
  const out = []
  let buf = ''
  for (const ln of lines) {
    buf = buf ? buf + ln : ln
    if (buf.length >= minChars) {
      out.push(buf)
      buf = ''
    }
  }
  if (buf) {
    if (out.length) out[out.length - 1] += buf
    else out.push(buf)
  }
  return out
}
