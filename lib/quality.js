/**
 * 句子质量判定：零 LLM，纯规则。
 *
 * 用途：名词解释在「上下文截取」模式下，第一次出现的句子可能很差
 * （「那就这样吧」「好的」），存进去等于没有解释。这里用一个打分器判断，
 * 差句标记为可替换，等该名词下次出现、切出更好的句子时换掉。
 *
 * 依据：Definition Extraction 的通行结论是——定义句靠**词汇句法模式**识别，
 * 不靠统计模型（Navigli & Velardi 的 WCL、以及对定义性动词模式的系列工作）。
 * 所以这里也只用模式，不训练、不调模型。
 *
 * 打分的三个维度：
 *  1. 长度：太短（<6 字）几乎不可能载住语义；过长（>80 字）往往一句话里塞了多个话题。
 *  2. 定义性线索：是否含有「是」「指」「就是」「称为」「属于」这类判断/定义动词。
 *  3. 信息量：实词数量、是否只有语气词/指代词。
 */

/** 定义性线索词：出现即加分，说明这句在为某个概念下判断 */
const DEF_PATTERNS = [
  /(?:是指|指的是|是|就是|即|为|称为|叫做|叫作|称为|属于|包括|意思是|用来)/,
  /(?:一种|一类|一个|某个|某种)/,
]

/** 纯功能/语气成分：整句只有这些，就是低质量句 */
const EMPTY_PATTERN = /^[\s，。、！？；：,.!?;:的了呢吧啊哦嗯好行对是嗯呐哈嘿哟哎呀哇]*$/

/** 指代/延续性开头：说明这句依赖上文，单独拿出来没信息量 */
const ANAPHORIC_HEAD = /^(?:这|那|它|他|她|其|该|此|上述|前面|然后|所以|因此|但是|不过|而且|另外|还有|就是)/

/** 质量阈值：低于它就算差句 */
export const SENTENCE_QUALITY_MIN = 3

/**
 * 给一句解释文本打分。
 *
 * @returns {{score: number, poor: boolean, reasons: string[]}}
 */
export function scoreSentence(raw, word = '') {
  const t = String(raw || '').trim()
  const reasons = []
  if (!t) return { score: 0, poor: true, reasons: ['空'] }

  let score = 0

  // 1) 长度
  if (t.length < 6) { reasons.push('过短') }
  else if (t.length <= 80) score += 2
  else { score += 1; reasons.push('过长') }

  // 2) 定义性线索
  if (DEF_PATTERNS.some((re) => re.test(t))) score += 2

  // 3) 信息量：中文实词（去掉标点与功能字后剩下的字数）
  const content = t.replace(/[\s，。、！？；：,.!?;:的了呢吧啊哦嗯好行对是的着过]/g, '')
  if (content.length >= 4) score += 2
  else if (content.length >= 2) score += 1
  else reasons.push('无实词')

  // 扣分项
  if (EMPTY_PATTERN.test(t)) { score -= 4; reasons.push('全是语气词') }
  // 指代/延续性开头要重罚：这种句子离开上文就读不通，
  // 而我们要存的正是「单独拿出来能看懂的该词解释」。
  if (ANAPHORIC_HEAD.test(t)) { score -= 3; reasons.push('指代开头') }
  // 句子里连该词都不出现，多半是误截
  if (word && !t.includes(word)) { score -= 2; reasons.push('不含该词') }

  return { score, poor: score < SENTENCE_QUALITY_MIN, reasons }
}
