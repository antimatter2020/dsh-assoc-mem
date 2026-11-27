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
 *  - 待解释条目一次问完，不设条数上限（分批只会让条目在冷却里排队）
 */

// 不设条数上限：有多少待解释的就一次问完。
// 分批问的代价是条目在冷却里排队，等得越久越容易「永远轮不到」。
const GLOSS_MAX = 20
const DASH = '\u2014\u2014'

/**
 * 构造请求用的 system + user 文本。
 * 让模型只输出纯行文本，便于解析，不要求 JSON（更省 token 也更稳）。
 *
 * @param opts.nouns 待解释的名词
 * @param opts.edges 待解释的边 [{a,b}]
 * @returns {{system: string, user: string}} 两者都为空串时表示无需请求
 */
export function buildExplainRequest(opts = {}) {
  const nouns = (Array.isArray(opts.nouns) ? opts.nouns : []).filter(Boolean)
  const edges = (Array.isArray(opts.edges) ? opts.edges : []).filter((e) => e && e.a && e.b)
  if (!nouns.length && !edges.length) return { system: '', user: '' }

  // 语境是解释准确性的前提。早先只把词单独列出来问，模型只能望文生义，
  // 生成的解释和本轮对话无关（「脚本」被写成电影剧本就是实例）。
  // 现在把该词在用户原话里出现的那句一并给出，让模型有据可依。
  const ctx = typeof opts.contextOf === 'function' ? opts.contextOf : () => ''
  const ctxLine = (word) => String(ctx(word) || '').replace(/\s+/g, ' ').trim()

  const system = [
    '你在补全一张解释表。每行左边已给出，你只补右边。',
    '',
    '规则：',
    '1. 只输出补全后的行，行数与原行数相同、顺序不变；左边原样抄，全角竖线｜分隔。',
    '2. 解释不超过 ' + GLOSS_MAX + ' 个字，写成短语。',
    '3. 必须依据行末〔原话〕。原话是这个词在本轮的真实语境，它指什么就写什么，',
    '   不要按这个词在其他场合的常见含义去猜。',
    '4. 禁止表格、标题、代码块、粗体、编号、寒暄、任何说明文字。',
    '5. 没有实义的功能词（「所以」「一下」）右边写：非名词',
    '',
    '示例。给你：',
    '拔完牙｜____   〔原话〕拔完牙之后一直渗血，说话都漏风',
    '拔完牙|所以｜____   〔原话〕因为拔完牙，所以今天不想说话',
    '你只输出：',
    '拔完牙｜刚拔掉智齿，伤口在渗血',
    '拔完牙|所以｜因为刚拔完牙不舒服，所以才不想说话',
    '',
    '现在补全下面这些行，不要输出其它任何内容：',
  ].join('\n')

  const rows = []
  const push = (left, word) => {
    const c = ctxLine(word)
    rows.push(c ? left + '｜____   〔原话〕' + c : left + '｜____')
  }
  for (const n of nouns) push(n, n)
  for (const e of edges) push(e.a + '|' + e.b, e.a)
  const user = rows.join('\n')

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
    // 行尾的〔原话〕是给模型看的语境，解析时去掉——
    // 否则「____   〔原话〕…」不匹配占位符判断，会被当成有效解释入库。
    clean = clean.replace(/[〔\[（(【]\s*原话\s*[〕\]）)】][\s\S]*$/, '').trim()
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
      // 模型没填、把占位符原样抄回来，不能当成解释入库
      if (a && b && a !== b && body && !/^_+$/.test(body)) {
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
    // 同上：占位符没被替换掉的，丢弃
    if (/^_+$/.test(body)) continue
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