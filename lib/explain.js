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

// 省 token：一次问太多，光输出就要几百 token。
// 小批量反而更容易一次全部答对，失败重试的代价也低。
const MAX_NOUNS = 6
const MAX_EDGES = 6
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
    '你的输出会被程序用正则逐行解析，任何多余格式都会导致整条丢弃。',
    '',
    '严禁：表格（| 和 ---）、Markdown 标题、代码块、粗体、编号、',
    '寒暄、开场白、结尾总结、说明你在做什么。',
    '只输出下面要求的数据行，不要有任何其它文字。',
    '',
    '词语行格式（全角竖线分隔）：',
    '词语｜解释',
    '词对行格式（左边两词用半角 | 分隔，再用全角｜接解释）：',
    'A|B｜关系',
    '',
    `每条解释不超过 ${GLOSS_MAX} 个字，只写这个词在当前语境里的意思。`,
    '功能词（如「所以」「一下」）的解释写：非名词',
    '',
    '示例（照这个格式，不要加任何其它内容）：',
    '牛顿｜提出经典力学的物理学家',
    '苹果｜这一轮指水果',
    '牛顿|苹果｜落下的苹果启发了万有引力',
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
    // 模型常加粗体、反引号、列表符、编号，全部先剥掉再解析
    let clean = raw
      .replace(/\*\*/g, '')
      .replace(/`/g, '')
      .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1')
      .trim()
      .replace(/^[-*·•]\s*/, '')
      .replace(/^\d+[.、)]\s*/, '')
      .replace(/^[（(]\d+[）)]\s*/, '')
      .trim()
    if (!clean) continue
    // 标题行、分隔线、寒暄之类直接跳过
    if (/^#{1,6}\s/.test(clean)) continue
    if (/^[-=]{3,}$/.test(clean)) continue

    // 兜底：Markdown 表格行 `| 词 | 解释 |`。
    // 提示词已经禁止表格，但模型不一定听话——真遇到了也不能全丢。
    if (clean.startsWith('|')) {
      const cells = clean.split('|').map((c) => c.trim()).filter(Boolean)
      if (cells.length >= 2) {
        const head = cells[0]
        const body = cells.slice(1).join(' ')
        const pairCells = head.split(/[|｜]/).map((x) => x.trim()).filter(Boolean)
        if (pairCells.length === 2) {
          const [a, b] = pairCells
          if (a && b && a !== b &&
            (!wantEdges.size || wantEdges.has(a + '|' + b) || wantEdges.has(b + '|' + a))) {
            edges.push({ a, b, gloss: body.length > GLOSS_MAX ? body.slice(0, GLOSS_MAX) : body })
          }
        } else if (wantNouns.has(head)) {
          const gloss = body.length > GLOSS_MAX ? body.slice(0, GLOSS_MAX) : body
          nouns.push({ word: head, gloss, reject: /^非名词$/.test(gloss) })
        }
      }
      continue
    }

    // 先判词对：形如 A|B｜关系 / A|B —— 关系 / A|B: 关系
    const SEP = '(?:[｜|]|\\u2014\\u2014|\\u2014|--|:|：)'
    const pairMatch = clean.match(new RegExp('^([^｜|\\u2014:：]+)[|｜]([^｜|\\u2014:：]+)\\s*' + SEP + '\\s*(.+)$'))
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

    // 再判单词：词｜解释 / 词 —— 解释 / 词: 解释
    const m = clean.match(/^([^｜|:：]+?)\s*[｜|]\s*(.+)$/) ||
      clean.match(/^([^:：\u2014]+?)\s*[:：]\s*(.+)$/) ||
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