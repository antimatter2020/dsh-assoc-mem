/**
 * 零 LLM 概念抽取。
 *
 * 完全本地：jieba 词典做词性判定 + Aho-Corasick 一次扫描 + 虚词过滤 + 新词挖掘。
 * 任何一步都不调用模型。
 *
 * 关键规则：
 *  - 只收名词类词性（n/nr/ns/nt/nz/nrt/nrfg/ng）
 *  - 允许重叠切分（长词与其内部的短词并存）
 *  - 位置重叠或字符串包含的词对不建边（由 caller 处理）
 *  - 中文语料里的外文词（拉丁字母、假名、谚文）直接整段当概念
 *  - 词典外的新词用 n-gram + 互信息 + 左右邻接熵挖掘后缓存
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const NOUN_TAGS = new Set(['n', 'nr', 'ns', 'nt', 'nz', 'nrt', 'nrfg', 'ng'])
const PROPER_TAGS = new Set(['nr', 'ns', 'nt', 'nz', 'nrt', 'nrfg'])

// 虚词字符：词里含这些字就直接丢弃
const STOP_CHARS = new Set('的了着过是在和与及或但而却把被让向从对为以于则若即又还更最才只已曾将会能可要该每各某不没很太真都也我你他她它这那哪谁什么怎啦呢吧啊呀嘛哦嗯么')

const CJK = /[\u4e00-\u9fff]/
const NON_CJK_WORD = /[A-Za-zÀ-ÿ0-9\u3040-\u30ff\uac00-\ud7af][A-Za-zÀ-ÿ0-9\u3040-\u30ff\uac00-\ud7af._\-]*/g

function isCjk(ch) {
  return CJK.test(ch)
}

/** Aho-Corasick 自动机 */
class Automaton {
  constructor() {
    this.goto = [new Map()]
    this.fail = [0]
    this.out = [[]]
  }

  add(word) {
    let cur = 0
    for (const ch of word) {
      let next = this.goto[cur].get(ch)
      if (next === undefined) {
        this.goto.push(new Map())
        this.fail.push(0)
        this.out.push([])
        next = this.goto.length - 1
        this.goto[cur].set(ch, next)
      }
      cur = next
    }
    this.out[cur].push(word)
  }

  build() {
    const queue = []
    for (const [, v] of this.goto[0]) { queue.push(v); this.fail[v] = 0 }
    let head = 0
    while (head < queue.length) {
      const u = queue[head]
      head += 1
      for (const [ch, v] of this.goto[u]) {
        let f = this.fail[u]
        while (f && !this.goto[f].has(ch)) f = this.fail[f]
        this.fail[v] = this.goto[f].has(ch) && this.goto[f].get(ch) !== v ? this.goto[f].get(ch) : 0
        this.out[v] = this.out[v].concat(this.out[this.fail[v]])
        queue.push(v)
      }
    }
    return this
  }

  /** 找出所有匹配 [start, end, word] */
  matchAll(text) {
    const found = []
    let cur = 0
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]
      while (cur && !this.goto[cur].has(ch)) cur = this.fail[cur]
      cur = this.goto[cur].has(ch) ? this.goto[cur].get(ch) : 0
      const outs = this.out[cur]
      if (outs && outs.length) {
        for (const w of outs) {
          const start = i - w.length + 1
          if (start >= 0) found.push([start, i + 1, w])
        }
      }
    }
    return found
  }
}

export class Tokenizer {
  constructor(options = {}) {
    this.dictPath = options.dictPath || ''
    this.extraWords = new Set(options.extraWords || [])
    this.blocked = new Set(options.blocked || [])
    this.customConcepts = new Set(options.customConcepts || [])
    this.freq = new Map()
    this.tag = new Map()
    this.ready = false
    this.ac = null
    this.singleHi = options.singleHi ?? 1500
    this.keepFreq = options.keepFreq ?? 200
    this.commonMax = options.commonMax ?? 100000
    this.minDf = options.minDf ?? 5
  }

  async load() {
    if (this.ready) return this
    try {
      const raw = await readFile(this.dictPath, 'utf8')
      for (const line of raw.split(/\r?\n/)) {
        const parts = line.split(' ')
        if (parts.length < 3) continue
        const w = parts[0]
        if (!w) continue
        const f = Number.parseInt(parts[1], 10)
        this.freq.set(w, Number.isFinite(f) ? f : 0)
        this.tag.set(w, parts[2])
      }
    } catch {
      // 词典缺失时降级为只认自定义词，不抛错
    }
    this.ready = true
    return this
  }

  buildAutomaton() {
    const ac = new Automaton()
    for (const w of this.freq.keys()) if (w.length >= 2) ac.add(w)
    for (const w of this.extraWords) if (w.length >= 2) ac.add(w)
    for (const w of this.customConcepts) if (w.length >= 2) ac.add(w)
    this.ac = ac.build()
    return this.ac
  }

  /** 词性是否可作概念 */
  accepts(word) {
    if (!word || word.length < 2) return false
    if (this.blocked.has(word)) return false
    if (this.customConcepts.has(word)) return true
    if (this.extraWords.has(word)) return true
    for (const ch of word) if (STOP_CHARS.has(ch)) return false
    const t = this.tag.get(word)
    if (t) {
      if (!NOUN_TAGS.has(t)) return false
      if (PROPER_TAGS.has(t)) return true
      const f = this.freq.get(word) || 0
      return f < this.commonMax
    }
    // 词典外：首尾字若都是高频常用字，多半是虚词连用
    const f0 = this.freq.get(word[0]) || 0
    const f1 = this.freq.get(word[word.length - 1]) || 0
    if (f0 >= this.singleHi && f1 >= this.singleHi) return false
    return true
  }

  /** 外文词直接当概念 */
  foreignWords(text) {
    const out = []
    if (!NON_CJK_WORD.test(text)) return out
    NON_CJK_WORD.lastIndex = 0
    let m
    while ((m = NON_CJK_WORD.exec(text)) !== null) {
      const w = m[0].replace(/[._\-]+$/, '')
      if (w.length >= 2 && /[A-Za-zÀ-ÿ\u3040-\u30ff\uac00-\ud7af]/.test(w)) out.push(w)
    }
    return out
  }

  /**
   * 抽取一个片段的全部候选。
   * @returns {{word:string, start:number, end:number}[]}
   */
  /**
   * 是否是中文语料。
   * 判据：中日韩汉字占非空白字符的比例 >= 阈值。
   * 非中文内容整段跳过——否则英文单词会被当成一堆概念。
   */
  isChineseText(text, ratio = 0.25) {
    const s = String(text || '')
    let cjk = 0
    let meaningful = 0
    for (const ch of s) {
      if (/\s/.test(ch)) continue
      meaningful += 1
      if (/[\u4e00-\u9fff]/.test(ch)) cjk += 1
    }
    if (meaningful === 0) return false
    // 短输入（如「牛顿的苹果」）只看占比，不设长度门槛，
    // 否则五个汉字的短语会被误判成非中文。
    return cjk / meaningful >= ratio
  }

  spans(text) {
    if (!this.ac) this.buildAutomaton()
    if (!this.isChineseText(text)) {
      // 非中文语料：只在有充足中文时才处理，避免英文词污染
      return []
    }
    const raw = []
    const seen = new Set()
    for (const [start, end, word] of this.ac.matchAll(text)) {
      if (!this.accepts(word)) continue
      const key = start + ':' + end
      if (seen.has(key)) continue
      seen.add(key)
      raw.push({ word, start, end })
    }
    // 外文词
    for (const w of this.foreignWords(text)) {
      let idx = text.indexOf(w)
      while (idx >= 0) {
        const key = idx + ':' + (idx + w.length)
        if (!seen.has(key)) { seen.add(key); raw.push({ word: w, start: idx, end: idx + w.length }) }
        idx = text.indexOf(w, idx + 1)
      }
    }
    return this.dropFragments(this.dropCrossBoundary(raw, text))
  }

  /**
   * 剔除跨词边界的误匹配。
   *
   * 典型：'失去9个子女' 里 '个'(量词) + '子' 拼成 '个子'(身高)，
   * 但这里的 '个' 属于数量结构 '9个'。判据：候选首字是量词/数词，
   * 且它前面紧跟数字或量词 -> 这是跨界拼接，丢弃。
   */
  dropCrossBoundary(spans, text) {
    const MEASURE = new Set('\u4e2a\u53ea\u6761\u5f20\u7247\u5757\u652f\u6839\u5934\u53e3\u53ea\u4f4d\u540d\u6b21\u56de\u987f\u7c92\u9897\u682a\u68f5\u53f0\u90e8\u518c\u9875\u7ae0\u8282\u5c42\u9876\u9762\u4efd\u7ec4\u5957\u526f\u53cc\u5bf9')
    const NUM = /[0-9\uff10-\uff19\uff11\uff12\uff13\uff14\uff15\uff16\uff17\uff18\uff19]/
    const CN_NUM = new Set('\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u5343\u51e0\u591a')
    const out = []
    for (const s of spans) {
      const word = s.word
      const prev = s.start > 0 ? text[s.start - 1] : ''
      const first = word[0]
      // 首字是量词，且前面是数字 -> 跨界
      if (MEASURE.has(first) && (NUM.test(prev) || CN_NUM.has(prev))) continue
      // 首字是数词，且前面也是数词 -> 跨界
      if (CN_NUM.has(first) && (NUM.test(prev) || CN_NUM.has(prev))) continue
      out.push(s)
    }
    return out
  }

  /**
   * 去掉「总是被更长词覆盖」的碎片。
   *
   * 判据：若某个短词的**每一处出现**都落在某个更长词的区间内，
   * 说明它从不独立成词（如「莱布」之于「莱布尼茨」），丢弃。
   * 反之，只要它能在长词之外独立出现，就去掉长词、保留短词。
   */
  dropFragments(spans) {
    if (spans.length < 2) return spans
    const byWord = new Map()
    for (const s of spans) {
      let arr = byWord.get(s.word)
      if (!arr) { arr = []; byWord.set(s.word, arr) }
      arr.push(s)
    }
    const coveredBy = (s) => {
      const out = []
      for (const other of spans) {
        if (other.word === s.word) continue
        if (other.word.length <= s.word.length) continue
        if (other.start <= s.start && other.end >= s.end) out.push(other.word)
      }
      return out
    }
    const drop = new Set()
    for (const [word, arr] of byWord) {
      const covers = arr.map(coveredBy)
      if (!covers.every((c) => c.length > 0)) continue      // 有独立出现 -> 保留
      if (this.customConcepts && this.customConcepts.has(word)) continue
      if (this.extraWords && this.extraWords.has(word)) continue
      const t = this.tag.get(word)
      const freq = this.freq.get(word) || 0
      // 词典里的高频名词本身就是独立概念（苹果 / 手机 / 力学），
      // 即便本片段里被「苹果树」「苹果公司」包住，也不丢。
      if (t && NOUN_TAGS.has(t) && freq >= this.keepFreq) continue
      drop.add(word)
    }
    if (!drop.size) return spans
    return spans.filter((s) => !drop.has(s.word))
  }

  /**
   * 片段 -> 去重概念 + 合法词对。
   * 位置重叠或字符串包含的词对不建边。
   */
  pairs(text) {
    const spans = this.spans(text)
    const words = [...new Set(spans.map((s) => s.word))]
    const out = []
    for (let i = 0; i < spans.length; i += 1) {
      for (let j = i + 1; j < spans.length; j += 1) {
        const s1 = spans[i]
        const s2 = spans[j]
        if (s1.word === s2.word) continue
        const overlap = !(s1.end <= s2.start || s2.end <= s1.start)
        if (overlap) continue
        if (s1.word.includes(s2.word) || s2.word.includes(s1.word)) continue
        out.push([s1.word, s2.word])
      }
    }
    return { words, pairs: out }
  }
}

/** n-gram 新词挖掘（离线，用于扩充 extraWords） */
export async function mineNewWords(texts, options = {}) {
  const minDf = options.minDf ?? 5
  const minMi = options.minMi ?? 1.5
  const minEntropy = options.minEntropy ?? 0.8
  const full = texts.join('\n')
  const len = full.length

  const ngrams = new Map()
  const left = new Map()
  const right = new Map()
  for (let n = 2; n <= 6; n += 1) {
    for (let i = 0; i + n <= len; i += 1) {
      const s = full.slice(i, i + n)
      let ok = true
      for (const ch of s) if (!isCjk(ch)) { ok = false; break }
      if (!ok) continue
      ngrams.set(s, (ngrams.get(s) || 0) + 1)
      if (i > 0) {
        let m = left.get(s)
        if (!m) { m = new Map(); left.set(s, m) }
        m.set(full[i - 1], (m.get(full[i - 1]) || 0) + 1)
      }
      const j = i + n
      if (j < len) {
        let m = right.get(s)
        if (!m) { m = new Map(); right.set(s, m) }
        m.set(full[j], (m.get(full[j]) || 0) + 1)
      }
    }
  }

  const uni = new Map()
  let total = 0
  for (const ch of full) {
    if (!isCjk(ch)) continue
    uni.set(ch, (uni.get(ch) || 0) + 1)
    total += 1
  }

  const entropy = (m) => {
    if (!m || !m.size) return 0
    let sum = 0
    let t = 0
    for (const v of m.values()) t += v
    for (const v of m.values()) { const p = v / t; sum -= p * Math.log(p) }
    return sum
  }

  const mi = (s) => {
    const ps = (ngrams.get(s) || 0) / total
    let best = Infinity
    for (let k = 1; k < s.length; k += 1) {
      const a = s.slice(0, k)
      const b = s.slice(k)
      const pl = a.length === 1 ? (uni.get(a) || 0) / total : (ngrams.get(a) || 0) / total
      const pr = b.length === 1 ? (uni.get(b) || 0) / total : (ngrams.get(b) || 0) / total
      if (pl <= 0 || pr <= 0) return 0
      best = Math.min(best, Math.log(ps / (pl * pr)))
    }
    return best
  }

  const out = []
  for (const [s, c] of ngrams) {
    if (c < minDf) continue
    if (mi(s) < minMi) continue
    if (entropy(left.get(s)) < minEntropy) continue
    if (entropy(right.get(s)) < minEntropy) continue
    out.push({ word: s, count: c })
  }
  out.sort((a, b) => b.count - a.count)
  return out
}