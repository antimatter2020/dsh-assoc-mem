/**
 * 隐式解释请求：插件自己向 LLM 要解释，不让主对话模型在回复里写段落。
 *
 * 为什么改：主对话模型「死犟」——催了也不写关系段，写了也常漏格式。
 * 现在改由插件直接调 ctx.llm.stream()，一次请求同时要名词解释和边解释，
 * 结果由插件自己解析入库，不再依赖主对话配合。
 *
 * 省 token：
 *  - 没有待解释内容就不发请求
 *  - 名词和边合成一次调用，不分开问
 *  - 只问本轮新出现的、且尚未解释过的条目
 *  - 一次最多问 MAX_NOUNS 个词 + MAX_EDGES 条边
 */

const MAX_NOUNS = 12
const MAX_EDGES = 8
const GLOSS_MAX = 20
const DASH = '\u2014\u2014'

/** 一次请求最多覆盖多少条目（控制成本） */
export const EXPLAIN_LIMITS = { nouns: MAX_NOUNS, edges: MAX_EDGES }

/**
 * 构造请求用的 system + user 文本。
 * 让模型只输出纯行文本，便于解析，不要求 JSON（更省 token 也更稳）。
 *
 * @param opts.nouns 待解释的名词
 * @param opts.edges 待解释的边 [{a,b}]
 * @returns {{system: string, user: string}} 两者都为空串时表示无需请求
 */
export function buildExplainRequest(opts = {}) {
  const nouns = (Array.isArray(opts.nouns) ? opts.nouns : []).filter(Boolean).slice(0, MAX_NOUNS)
  const edges = (Array.isArray(opts.edges) ? opts.edges : []).slice(0, MAX_EDGES)
  if (!nouns.length && !edges.length) return { system: '', user: '' }

  const system = [
    '你是一个记忆库的解释生成器。用户会给你若干「词语」和「词对」，',
    '你只输出解释，不要寒暄、不要解释你在做什么、不要用 Markdown 标题。',
    '',
    '输出格式（严格遵守，每行一条）：',
    '对于每个词语，输出：词语｜解释',
    '对于每个词对，输出：A|B｜关系',
    '',
    `每条解释不超过 ${GLOSS_MAX} 个字，写它在当前语境下实际指什么，不要抄词典定义。`,
    '如果某个词不是名词（如「所以」「一下」这类功能词），解释写成：非名词',
    '词对的关系要说明这两个词为什么会一起出现。',
  ].join('\n')

  const lines = []
  if (nouns.length) lines.push('词语：' + nouns.join('、'))
  if (edges.length) lines.push('词对：' + edges.map((e) => e.a + '|' + e.b).join('、'))
  const user = lines.join('\n')

  return { system, user }
}

/**
 * 解析模型回复。
 * 主格式用全角竖线｜分隔；同时兼容半角 | 和破折号，避免格式细微差异就全丢。
 *
 * @returns {{nouns: {word:string,gloss:string}[], edges: {a:string,b:string,gloss:string}[]}}
 */
export function parseExplainReply(text, opts = {}) {
  const nouns = []
  const edges = []
  const wantNouns = new Set((opts.nouns || []).filter(Boolean))
  const wantEdges = new Set(
    (opts.edges || []).filter((e) => e && e.a && e.b).map((e) => e.a + '|' + e.b),
  )

  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*·]\s*/, '')
    if (!line) continue
    // 去掉可能的列表编号
    const clean = line.replace(/^\d+[.、)]\s*/, '')

    // 先判词对：左边必须**正好**是两个词，用半角 | 分隔。
    // 分隔符可能是全角竖线、半角竖线或破折号（模型不一定听话），三种都试。
    const SEP = '(?:[｜|]|\\u2014\\u2014|\\u2014|--)'
    const pairMatch = clean.match(new RegExp('^([^｜|\\u2014]+)\\|([^｜|\\u2014]+)\\s*' + SEP + '\\s*(.+)$'))
    if (pairMatch) {
      const a = pairMatch[1].trim()
      const b = pairMatch[2].trim()
      const body = pairMatch[3].trim().replace(/^["'\u300c]|["'\u300d]$/g, '')
      if (a && b && a !== b && body) {
        if (wantEdges.size && !wantEdges.has(a + '|' + b) && !wantEdges.has(b + '|' + a)) continue
        edges.push({ a, b, gloss: body.length > GLOSS_MAX ? body.slice(0, GLOSS_MAX) : body })
        continue
      }
    }

    // 再判单词
    const m = clean.match(/^([^｜|]+?)\s*[｜|]\s*(.+)$/) ||
      clean.match(/^([^\u2014]+?)\s*(?:\u2014\u2014|\u2014|--)\s*(.+)$/)
    if (!m) continue
    const word = m[1].trim()
    const body = m[2].trim().replace(/^["'\u300c]|["'\u300d]$/g, '')
    if (!word || !body) continue
    if (wantNouns.size && !wantNouns.has(word)) continue
    const gloss = body.length > GLOSS_MAX ? body.slice(0, GLOSS_MAX) : body
    if (/^非名词$/.test(gloss) || /^不是名词$/.test(gloss)) {
      nouns.push({ word, gloss, reject: true })
    } else {
      nouns.push({ word, gloss })
    }
  }
  return { nouns, edges }
}

/**
 * 把 AsyncIterable<StreamChunk> 收成一段文本。
 * 只取 text-delta；reasoning 不算解释内容。
 */
export async function collectStream(stream) {
  let out = ''
  let failure = null
  for await (const chunk of stream) {
    if (!chunk) continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
    else if (chunk.type === 'finish') {
      if (chunk.reason && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
        failure = chunk.reason.failure || { message: chunk.reason.kind }
      }
    }
  }
  return { text: out, failure }
}

export { GLOSS_MAX as EXPLAIN_GLOSS_MAX }