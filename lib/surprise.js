/**
 * 「惊讶」硬判定：为闪光灯效应（情绪唤起 → 记忆巩固加深）提供触发信号。
 *
 * 两个题目要分开，别混：
 *  - 效应**是否存在**：情绪唤起改变片段被巩固的强度。本项目用它，落点是重要性档位 s
 *    （s 调制衰减率 i/3^s），即「这段记忆活多久」。
 *  - 效应**产物准不准**：Talarico & Rubin (2003) 证明闪光灯记忆准确率并无提升，
 *    只是信心更强。那是「准不准」的问题，与「存在与否」无关。
 * 本模块判断的是：这段 AI 输出里有没有惊讶。
 *
 * 为什么用词典+正则而不是提示词：提示词是求模型配合，模型可以不理、可以编；
 * 硬判定是程序自己数，可复现、可测试。
 *
 * 防误判的做法（按文献）：
 *  1. 否定/弱化词介入即否决。Strohm & Klinger (2018) 指出 "not happy" 不是 happy，
 *     修饰词会翻转或削弱情绪词，必须先定 scope。这里用简化 scope：
 *     情绪词前 SCOPE_CHARS 字内出现否定词，该处作废。
 *  2. 程度词加权、弱化词打折，同一套 scope。
 *  3. 疑问不计数：「真的吗？」是提问，不是惊讶。
 *  4. 引号、代码块内的不算：那是引用别人的话，不是 AI 自己的反应。
 *  5. 阈值是累积分数不是布尔：一个「咦」不足以触发。
 */

/** 惊讶线索：[正则, 权重]。权重越高越确定是惊讶本身而非仅仅相关。 */
const SURPRISE_CUES = [
  [/(?:没|未曾|完全没)?(?:想|料)到/g, 3],
  [/出乎意料|意料之外|始料未及|万万没想到|没想到/g, 3],
  [/竟然|居然|竟是|赫然|竟会/g, 3],
  [/怎么会|怎么可能/g, 3],
  [/天哪|天啊|我的天|老天|哇哦|我靠|好家伙/g, 3],
  [/吃惊|震惊|惊到|吓一跳|大吃一惊|惊讶|诧异|瞠目/g, 3],
  [/不可思议|难以置信|不敢相信|真不敢相信/g, 3],
  [/意外地|意外的是|意外发现|出人意料/g, 2],
  [/奇怪的是|诡异的是|匪夷所思|蹊跷/g, 2],
  [/咦|诶|唉呀|欸/g, 1],
  [/不对啊|不对呀|等等|慢着|且慢/g, 2],
  [/原来如此|难怪|怪不得/g, 1],
]

/** 否定词：情绪词前若出现，该处判定作废（Strohm & Klinger 2018 的 scope 思路） */
const NEGATORS = [
  '不', '没', '没有', '并不', '并非', '不是', '毫无', '别',
  '无需', '不必', '谈不上', '算不上', '称不上', '没什么', '无可', '未尝', '不觉得',
]

/** 弱化词：削弱而非翻转，命中后权重打折 */
const DOWNTONERS = ['有点', '稍微', '略', '稍', '似乎', '好像', '大概', '也许', '有几分']

/** 程度词：加权 */
const AMPLIFIERS = ['真的', '实在', '确实', '太', '极其', '非常', '特别', '格外', '真是']

/** 否定的 scope：情绪词前多少字内算同一分句（中文分句短，15 字足够覆盖「并不觉得惊讶」） */
const SCOPE_CHARS = 15

/** 触发阈值：累积分数需达到 */
export const SURPRISE_THRESHOLD = 4

/** 单次最多扫描多少字符 */
const MAX_SCAN = 2000

/** 剥掉代码块、行内代码、引号引用——那些不是 AI 自己的反应 */
/**
 * 有些固定短语自带否定字却表达惊讶（难以置信、不可思议）。
 * 它们是**正面线索**，不能连词一起抹掉；要防的只是其中的「不」「没」
 * 被否定检测误当成「否定这个情绪」。
 * 做法：判定 scope 时，把这段 head 里属于这些短语的字符位置挖掉再找否定词。
 */
const NEG_LOOKALIKES = ['难以置信', '不敢相信', '不可思议']

/** 把 head 里与给定短语重叠的部分替换成占位空格，用于否定检测 */
function maskLookalikes(head) {
  let out = head
  for (const w of NEG_LOOKALIKES) {
    let i = out.indexOf(w)
    while (i >= 0) {
      out = out.slice(0, i) + ' '.repeat(w.length) + out.slice(i + w.length)
      i = out.indexOf(w, i + w.length)
    }
  }
  return out
}

function stripNonAuthored(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/「[^」]*」/g, ' ')
    .replace(/“[^”]*”/g, ' ')
    .replace(/"[^"]*"/g, ' ')
}

/**
 * 判断一段 AI 输出里有没有「惊讶」。
 *
 * @returns {{surprised: boolean, score: number, hits: Array}}
 *   score 是累积分数；hits 记命中片段，便于排查误判。
 */
export function detectSurprise(rawText) {
  const text = stripNonAuthored(String(rawText || '').slice(0, MAX_SCAN))
  if (!text.trim()) return { surprised: false, score: 0, hits: [] }

  const hits = []
  let score = 0

  for (const [re, weight] of SURPRISE_CUES) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) {
      const at = m.index
      const head = text.slice(Math.max(0, at - SCOPE_CHARS), at)

      // 规则 1：否定 → 作废。分两种情况：
      //  a) 否定词在命中词**之前**：「并不意外」「没什么好惊讶的」「谈不上震惊」
      //  b) 否定字在命中词**自身内部**：「难以置信」「不可思议」
      //     这类是正面线索，其内部的「不」不能当作否定——先掩掉再判 head，
      //     同时命中词自身也不参与否定检查。
      const cue = m[0]
      const negHead = maskLookalikes(head)
      const cueIsLookalike = NEG_LOOKALIKES.some((w) => w.includes(cue) || cue.includes(w))
      if (!cueIsLookalike && NEGATORS.some((w) => negHead.includes(w))) continue

      // 规则 3：紧跟问号是提问，不是惊讶（强信号除外）
      const after = text.slice(at + m[0].length, at + m[0].length + 3)
      if (weight < 3 && /^[?？]/.test(after)) continue

      let w = weight
      // 规则 2：前有程度词加权，弱化词打折
      if (AMPLIFIERS.some((x) => head.includes(x))) w += 1
      if (DOWNTONERS.some((x) => head.includes(x))) w -= 1
      // 规则 6：弱信号后紧跟一个问句（「等等，这里为什么…」）是惊讶的典型形状，
      // 单纯一个「等等」不足以触发，但「等等 + 追问」是明确的意外反应。
      // 注意前提：该问句不能已被规则 3 判为纯提问（那是紧跟问号的同一句）。
      if (weight <= 2) {
        const tail = text.slice(at, at + 60)
        if (/[?？]/.test(tail)) w += 2
      }
      if (w <= 0) continue

      score += w
      hits.push({ cue: m[0], weight: w, at })
      // 单一强信号（weight>=3）本身就足以判定：
      // 「竟然」「好家伙」「震惊」出现一次就已经是明确惊讶，
      // 不该因为没凑够分数而漏判。阈值只约束弱信号累积。
      if (w >= 3 || score >= SURPRISE_THRESHOLD) return { surprised: true, score, hits }
    }
  }

  return { surprised: score >= SURPRISE_THRESHOLD, score, hits }
}

/**
 * 把惊讶信号换算成重要性档位 s（0–3）。
 *
 * 落点说明：s 不改变边的加强量，而是把衰减率除以 gBase^s，
 * 即「惊讶的片段记得更久」，这正是闪光灯效应在本项目里的用法。
 * 只有明确惊讶才升到 2 档；3 档留给「惊讶 + 程度词」的强烈情形。
 */
export function surpriseToSalience(score) {
  const s = Number(score) || 0
  if (s <= 0) return 1
  // 单一强信号本身就是 3 分（见 detectSurprise 的 w>=3 直接命中），
  // 这里必须与那套判定对齐，否则会出现「判为惊讶却仍是 1 档」的矛盾。
  if (s >= 6) return 3
  if (s >= 3) return 2
  return 1
}
/**
 * 从 session.log 里取最近一条 assistant 的文本。
 *
 * 存在的理由：插件目前只有 systemPrompt.section 这一个钩子，它在模型**回复之前**
 * 运行，当轮拿不到 AI 输出。要硬触发惊讶，只能在下一轮 section 运行时回看上一轮的回复，
 * 或者等 DSH 提供回复后钩子。这个函数是前者的取数部分。
 *
 * 取不到就返回空串，调用方按「无惊讶」处理，不影响主流程。
 */
export function latestAssistantText(context) {
  try {
    const agent = context && (context.agent || context.scope)
    const session = agent && agent.session
    if (!session || !Array.isArray(session.log)) return ''
    const log = session.log
    for (let i = log.length - 1; i >= Math.max(0, log.length - 300); i -= 1) {
      const ev = log[i]
      const data = ev && ev.data
      if (!data) continue
      const msg = data.message && typeof data.message === 'object' ? data.message : data
      const role = msg && msg.role
      const src = msg && msg.source && typeof msg.source === 'object' ? msg.source : null
      const kind = src && src.kind
      if (role !== 'assistant' && kind !== 'assistant') continue
      const content = msg && msg.content
      if (typeof content === 'string' && content.trim()) return content.trim()
      if (Array.isArray(content)) {
        const parts = []
        for (const b of content) {
          if (b && typeof b.text === 'string') parts.push(b.text)
        }
        const t = parts.join('\n').trim()
        if (t) return t
      }
    }
    return ''
  } catch {
    return ''
  }
}