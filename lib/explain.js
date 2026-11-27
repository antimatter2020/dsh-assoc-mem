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
// 解释长度上限。
// 早先设 20 字，效果是把模型写好的句子拦腰砍断——
// 界面上会出现「多边 "元素"一词本身就是对多边结构中各」这种残句。
// 短语要有信息量，20 字太紧；放到 60 字，超出时按标点收口（见 clampGloss），
// 而不是硬切在小半个字上。
const GLOSS_MAX = 60
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
  // 多边结构（同句 >=3 个概念）单独成行，与二元边互不覆盖
  const cliques = (Array.isArray(opts.cliques) ? opts.cliques : [])
    .filter((c) => c && Array.isArray(c.names) && c.names.length >= 3)
  if (!nouns.length && !edges.length && !cliques.length) return { system: '', user: '' }

  // 语境是解释准确性的前提。早先只把词单独列出来问，模型只能望文生义，
  // 生成的解释和本轮对话无关（「脚本」被写成电影剧本就是实例）。
  // 现在把该词在用户原话里出现的那句一并给出，让模型有据可依。
  const ctx = typeof opts.contextOf === 'function' ? opts.contextOf : () => ''
  const ctxLine = (word) => String(ctx(word) || '').replace(/\s+/g, ' ').trim()

  const system = [
    '你是一个格式化文本生成器，不是聊天助手。',
    '用户消息里只有若干行待补全的条目，每行形如「左边｜____〔原话〕…」。',
    '你要做的就是给每一行的 ____ 位置填上解释，并原样输出。',
    '不要把用户消息当成提问，不要询问对方要什么，不要解释你在做什么。',
    '',
    '输出规则：',
    '1. 行数必须与输入相同，顺序不变，一行一条。',
    '2. 每行格式「左边｜解释」，左边原样抄，用全角竖线｜分隔。',
    '3. 解释不超过 ' + GLOSS_MAX + ' 个字，写成短语，不要句子、不要句号。',
    '4. 必须依据该行〔原话〕里这段文字。原话是这个词在本轮的真实语境，',
    '   它指什么就写什么，不要按这个词在其他场合的常见含义去猜。',
    '5. 不要写「多边」「组合」「该词指…」这类元描述，直接写它在这一句里的意思。',
    '6. 禁止表格、标题、代码块、粗体、编号、寒暄、反问、任何说明文字。',
    '7. 只有纯功能词（所以、一下、并且）、纯语气词（啊、嗯、吧）、',
    '   只指代无内容的词（这个、那个）才在右边写「非名词」。',
    '   凡在句中有具体所指的（哪怕抽象），一律写出意思。',
    '',
    '示例。输入：',
    '拔完牙｜____   〔原话〕拔完牙之后一直渗血，说话都漏风',
    '拔完牙|所以｜____   〔原话〕因为拔完牙，所以今天不想说话',
    '输出：',
    '拔完牙｜刚拔掉智齿，伤口在渗血',
    '拔完牙|所以｜因为刚拔完牙不舒服，所以才不想说话',
  ].join('\n')

  const rows = []
  const push = (left, word) => {
    const c = ctxLine(word)
    rows.push(c ? left + '｜____   〔原话〕' + c : left + '｜____')
  }
  for (const n of nouns) push(n, n)
  for (const e of edges) push(e.a + '|' + e.b, e.a)
  // 团：三个词用 | 连起来，一行一条，只问一次
  for (const c of cliques) push(c.names.join('|'), c.names[0])
  // user 必须自描述：早先只发裸行「bug｜____」，模型把它当成人发的对话，
  // 回复「你指出的是 bug｜ 后面的内容缺失了…把提示词贴过来」。
  // 现在用明确的分隔和指令包起来，就没有解读成提问的余地。
  const user = [
    '下面是 ' + rows.length + ' 行待补全条目，逐行补全 ____ 后原样输出，不要问任何问题：',
    '<<<BEGIN>>>',
    rows.join('\n'),
    '<<<END>>>',
  ].join('\n')

  return { system, user }
}

/**
 * 判断一句「解释」是不是元描述而非真解释。
 *
 * 典型污染：模型不写意思，改写它自己看到的结构——
 * 「多边 "书"+"店"+"知识"+"交易"」「该词由 a 和 b 组成」「组合：a|b|c」。
 * 这类文本入库后毫无用途，还会顶掉原来的好解释，必须丢弃。
 */
/**
 * 超长时按标点收口，避免切出残句。
 *
 * 优先级：句末标点 → 逗号顿号 → 空格 → 最后才硬切。
 * 早先直接 slice(0, N)，中文会被切在词中间，读起来是断的。
 */
function clampGloss(text) {
  const t = String(text || '').trim()
  if (t.length <= GLOSS_MAX) return t
  const head = t.slice(0, GLOSS_MAX)
  const cuts = [head.lastIndexOf('。'), head.lastIndexOf('，'), head.lastIndexOf('、'), head.lastIndexOf(' ')]
  for (const i of cuts) {
    if (i >= Math.floor(GLOSS_MAX * 0.5)) return head.slice(0, i + 1).trim()
  }
  return head.trim() + '…'
}

function isMetaDescription(gloss) {
  const t = String(gloss || '').trim()
  if (!t) return true
  // 直接点名结构术语
  if (/^(?:多边|单边|组合|二元|团|该词|这个词|此词|说明|解释|注意)/.test(t)) return true
  // 用 + 拼接多个带引号的词，是模型在复述结构而不是写意思
  if (/(?:"[^"]+"\s*[+]\s*){2,}/.test(t)) return true
  if (/(?:'[^']+'\s*[+]\s*){2,}/.test(t)) return true
  // 以竖线罗列多个词
  if (/\|/.test(t) && t.split('|').length >= 3) return true
  return false
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
  const cliques = []
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
    // 分隔标记本身不是内容
    if (/^<{2,}|>{2,}/.test(clean)) continue

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
            edges.push({ a, b, gloss: clampGloss(body) })
          }
        } else if (wantNouns.has(head)) {
          const gloss = clampGloss(body)
          nouns.push({ word: head, gloss, reject: /^非名词$/.test(gloss) })
        }
      }
      continue
    }

    // 先判团（多边）：形如 A|B|C｜关系，3 个及以上词用半角竖线连接。
    // 必须在二元判定之前，否则会被当成 A 与 "B|C" 的二元边。
    const cliqueMatch = clean.match(/^([^｜]+?)[｜]\s*(.+)$/)
    if (cliqueMatch) {
      const heads = cliqueMatch[1].split('|').map((x) => x.trim()).filter(Boolean)
      const body = cliqueMatch[2].trim().replace(/^["'\u300c]|["'\u300d]$/g, '')
      if (heads.length >= 3 && body && !/^_+$/.test(body) && !isMetaDescription(body)) {
        cliques.push({
          // 排序后返回，与 graph 里 clique 的 key 保持一致，写入时才对得上
          names: [...heads].sort(),
          gloss: clampGloss(body),
        })
        continue
      }
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
        if (isMetaDescription(body)) continue
        edges.push({ a, b, gloss: clampGloss(body) })
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
    const gloss = clampGloss(body)
    if (isMetaDescription(gloss)) continue
    if (/^非名词$/.test(gloss) || /^不是名词$/.test(gloss)) {
      nouns.push({ word, gloss, reject: true })
    } else {
      nouns.push({ word, gloss })
    }
  }
  return { nouns, edges, cliques }
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