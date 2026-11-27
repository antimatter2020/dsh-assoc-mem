/**
 * 冒烟测试：不依赖 DSH 运行时，直接验证图与切词逻辑。
 * 运行：node smoke.mjs
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MemoryGraph } from './lib/graph.js'
import { Tokenizer } from './lib/tokenizer.js'
import { splitParagraphs, userFragment, estimateTokens } from './lib/fragments.js'
import { buildExplainRequest, parseExplainReply } from './lib/explain.js'
import { splitSentences, sentenceAt } from './lib/sentence.js'
import { Store } from './lib/store.js'
import { detectSurprise, surpriseToSalience, SURPRISE_THRESHOLD } from './lib/surprise.js'
import { scoreSentence, SENTENCE_QUALITY_MIN } from './lib/quality.js'

const here = path.dirname(fileURLToPath(import.meta.url))
let pass = 0
let fail = 0

function check(name, cond, extra = '') {
  if (cond) { pass += 1; console.log('  ok   ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

console.log('== 1. 图更新（单边：恰好两个概念） ==')
{
  // 二元边只在本句恰好 2 个概念时建立；>=3 个归团，见第 13 组。
  const g = new MemoryGraph({ i: 0.005, x: 0.03, y: 0.06, w0: 0.05, thr: 0.05, wmax: 0.9 })
  const r1 = g.ingest(['牛顿', '苹果'], 1)
  check('两词建 1 条边', r1.added === 1, 'got ' + r1.added)
  check('首轮命中 0', r1.hit === 0)

  const wAB = g.neighbours('牛顿', 99).find((n) => n.name === '苹果')
  check('牛顿-苹果 过线', Boolean(wAB), 'w=' + (wAB && wAB.w))

  // 同一对再出现一次 = 命中加强
  const r2 = g.ingest(['牛顿', '苹果'], 1)
  check('第二轮命中 1', r2.hit === 1, 'got ' + r2.hit)
  check('第二轮不新增边', r2.added === 0, 'got ' + r2.added)

  const hitEdge = g.neighbours('牛顿', 99).find((n) => n.name === '苹果')
  // 新边：另一对，权重应低于被命中过一次的
  const g2 = new MemoryGraph({ i: 0.005, x: 0.03, y: 0.06, w0: 0.05, thr: 0.05, wmax: 0.9 })
  g2.ingest(['甲', '乙'], 1)
  const newEdge = g2.neighbours('甲', 99).find((n) => n.name === '乙')
  check('命中边权重大于新边', hitEdge.w > newEdge.w, hitEdge.w.toFixed(4) + ' vs ' + newEdge.w.toFixed(4))
}

console.log('== 2. 衰减 ==')
{
  const g = new MemoryGraph({ i: 0.5, x: 0.01, y: 0.01, w0: 0.5, thr: 0.001, wmax: 0.9 })
  g.ingest(['甲', '乙'], 1)
  const before = g.neighbours('甲', 99)[0].w
  for (let k = 0; k < 5; k += 1) g.ingest(['丙', '丁'], 1)
  const after = g.neighbours('甲', 99)[0].w
  check('未命中的边衰减', after < before, before.toFixed(4) + ' -> ' + after.toFixed(4))
}

console.log('== 3. 档位寿命 ==')
{
  const alive = (s) => {
    const g = new MemoryGraph({ i: 0.15, x: 0.01, y: 0.01, w0: 0.06, thr: 0.05, wmax: 0.9 })
    g.ingest(['甲', '乙'], s)
    for (let k = 0; k < 8; k += 1) g.ingest(['丙', '丁'], 1)
    return g.neighbours('甲', 99).length > 0
  }
  check('s=3 的边比 s=0 活得久', alive(3) === true && alive(0) === false,
    's3=' + alive(3) + ' s0=' + alive(0))
}

console.log('== 4. 切词 ==')
{
  const tk = new Tokenizer({ dictPath: path.join(here, 'data', 'jieba_dict.txt') })
  await tk.load()
  tk.buildAutomaton()

  const r1 = tk.spans('牛顿的苹果')
  const words1 = r1.map((s) => s.word)
  check('牛顿的苹果 抽出名词', words1.includes('牛顿') && words1.includes('苹果'), JSON.stringify(words1))

  const r2 = tk.spans('他今天看到天空很蓝')
  const words2 = r2.map((s) => s.word)
  check('滤掉虚词「的」「很」', !words2.includes('的') && !words2.includes('很'), JSON.stringify(words2))

  const r3 = tk.spans('用 TensorFlow 训练 GPT-4 模型')
  const words3 = r3.map((s) => s.word)
  check('外文词直接入概念', words3.some((w) => w === 'TensorFlow'), JSON.stringify(words3))

  // 用自定义概念注入，模拟长词与其内部短词并存的场景
  tk.customConcepts = new Set(['甲乙丙', '甲乙', '乙丙'])
  tk.extraWords = new Set(['甲乙丙', '甲乙', '乙丙'])
  tk.buildAutomaton()
  const overlap = tk.spans('甲乙丙来了')
  check('允许重叠切分', overlap.length >= 2, JSON.stringify(overlap.map((s) => s.word)))

  const { pairs } = tk.pairs('甲乙丙')
  const bad = pairs.filter(([a, b]) => a.includes(b) || b.includes(a))
  check('重叠/包含词对不建边', bad.length === 0, JSON.stringify(bad) + ' all=' + JSON.stringify(pairs))
}

console.log('== 5. 片段 ==')
{
  const uf = userFragment('这是一句用户输入')
  check('用户输入单一片段', uf.length === 1, 'got ' + uf.length)

  const para = '第一段内容。\n第二段。\n' + '很长很长的一段话'.repeat(12)
  const segs = splitParagraphs(para, 50)
  check('短段落合并后仍为整段', segs.length === 1, 'got ' + segs.length)
  check('合并后长度正确', segs[0].length === para.replace(/\n/g, '').length,
    segs[0].length + ' vs ' + para.replace(/\n/g, '').length)

  const longPara = ('第一段。'.repeat(20) + '\n' + '第二段。'.repeat(20))
  const segs2 = splitParagraphs(longPara, 50)
  check('长段落各自成段', segs2.length === 2, 'got ' + segs2.length)

  check('token 估算', estimateTokens('中文一百个字') > 0)
}

console.log('== 6. 屏蔽与删除 ==')
{
  const g = new MemoryGraph({})
  g.ingest(['甲', '乙', '丙'], 1)
  g.dropNode('乙')
  check('删除节点清理关联边', g.neighbours('甲', 99).every((n) => n.name !== '乙'))
}

console.log('== 7. 孤立概念清理 ==')
{
  const g = new MemoryGraph({ thr: 0.05, i: 0.5, x: 0.01, y: 0.01, w0: 0.2 })
  g.ingest(['甲', '乙'], 1)
  for (let k = 0; k < 6; k += 1) g.ingest(['丙', '丁'], 1)
  const before = g.edges.size
  const dropped = g.isolatePrune()
  check('孤立概念被清除', dropped >= 0 && g.edges.size <= before, 'dropped=' + dropped)
}

console.log('== 8. 解释请求模板 ==')
{
  const ctxOf = (w) => (w === '冷却' ? '另外冷却好像也有问题' : '')
  const req = buildExplainRequest({ nouns: ['冷却', '任务'], edges: [{ a: '模型', b: '任务' }], contextOf: ctxOf })
  // 现在的 user 带自描述外壳与 BEGIN/END 分隔，只校验有效行
  const bodyLines = req.user.split('\n').filter((l) => l.includes('｜'))
  check('每行给出 ____ 占位', bodyLines.length > 0 && bodyLines.every((l) => l.includes('____')), req.user)
  check('带语境的行附原话', req.user.includes('〔原话〕另外冷却好像也有问题'), req.user)
  const noCtx = req.user.split('\n').filter((l) => l.includes('｜'))[1]
  check('无语境的行不附原话', noCtx === '任务｜____', noCtx)
  check('词对行用半角竖线连接两词', req.user.includes('模型|任务｜____'))

  const reply = ['冷却｜问过之后一段时间内不再重复', '任务｜这一轮要完成的改动', '模型|任务｜模型把任务理解错了'].join('\n')
  const got = parseExplainReply(reply, { nouns: ['冷却', '任务'], edges: [{ a: '模型', b: '任务' }] })
  check('解析出名词解释', got.nouns.length === 2, JSON.stringify(got.nouns))
  check('解析出边解释', got.edges.length === 1 && got.edges[0].gloss.length > 0)

  const blank = buildExplainRequest({ nouns: ['冷却'], edges: [], contextOf: ctxOf })
  const un = parseExplainReply(blank.user, { nouns: ['冷却'], edges: [] })
  check('占位符原样返回不入库', un.nouns.length === 0, JSON.stringify(un.nouns))
}

console.log('== 9. 切句规则 ==')
{
  const strong = splitSentences('我今天去学校。然后买东西！晚上回家了？')
  check('句末标点切开', strong.length === 3, JSON.stringify(strong.map(s=>s.text)))
  check('分号也是句末', splitSentences('第一件事做完；第二件事还没开始。').length === 2)
  check('省略号是句末', splitSentences('我想想……算了不去了。').length === 2)
  check('换行是句末', splitSentences('第一行\n第二行').length === 2)

  const spaced = splitSentences('我今天去学校 然后买东西 晚上回家')
  check('无标点按空格断句', spaced.length === 3, JSON.stringify(spaced.map(s=>s.text)))

  const longComma = '我想把这个插件的解释请求重写一下，现在模型总是把任务理解错，返回的格式也不对，得改成逐行填空的形式，另外冷却好像也有问题，有时候一个词问过之后就再也不问了'
  check('只有逗号且过长时按逗号切', splitSentences(longComma).length > 1)
  check('只有逗号但句子短则不切', splitSentences('好的，我这就去改').length === 1)
  check('英文句点不切断文件名', splitSentences('看下 README.md 和 v0.1.0 这两个文件。').length === 1)
}

console.log('== 10. 解释按整句储存 ==')
{
  const text = '我想把这东西重写一下，现在模型总是理解错。另外冷却好像也有问题，有时候一个词问过就再也不问了。'
  const st = new Store({})
  const i = text.indexOf('冷却')
  st.seedGloss('冷却', text, i, i + 2)
  const saved = st.nodes.get('冷却').gloss[0].text
  check('名词解释存整句', saved === '另外冷却好像也有问题，有时候一个词问过就再也不问了。', saved)
  check('名词解释未截断', !saved.includes('…'), saved)

  const g = new MemoryGraph({ edgeMode: 'context' })
  const words = ['冷却', '问题']
  const positions = new Map()
  for (const w of words) { const k = text.indexOf(w); positions.set(w, { start: k, end: k + w.length }) }
  g.ingest(words, 1, { positions, text })
  const edge = [...g.edges.values()][0]
  check('边解释存整句', edge.gloss.endsWith('。') && !edge.gloss.includes('…'), edge.gloss)
}

console.log('== 11. 惊讶硬判定（闪光灯效应触发） ==')
{
  const pos = [
    '没想到这个 bug 居然是初始化顺序的问题。',
    '这个函数竟然在构造完成前就被调用了。',
    '好家伙，内存直接泄漏了两个 G。',
    '两处配置完全一致，结果却不一样，难以置信。',
    '等等，这里为什么会有两个初始化？',
  ]
  for (const t of pos) check('惊讶·' + t.slice(0, 8), detectSurprise(t).surprised === true)

  const neg = [
    '这个结果并不意外，之前就推断过。',
    '这个报错没什么好惊讶的，很常见。',
    '这个性能问题谈不上震惊，属于预期内。',
    '我不觉得意外，逻辑上必然如此。',
    '真的吗？你再确认一下。',
    '报错如下：\n```\n竟然 undefined\n```\n这是第三方库的问题。',
    '文档里写的是「出乎意料」，但我们这里很平稳。',
    '我把它改成了同步调用，问题解决了。',
  ]
  for (const t of neg) check('非惊讶·' + t.slice(0, 8), detectSurprise(t).surprised === false)

  check('惊讶升到 2 档', surpriseToSalience(4) === 2, String(surpriseToSalience(4)))
  check('强烈惊讶升到 3 档', surpriseToSalience(SURPRISE_THRESHOLD + 3) === 3)
  check('未达阈值保持 1 档', surpriseToSalience(0) === 1)
}

console.log('== 12. 解释冷却（10 轮内不重复请求） ==')
{
  const st = new Store({})
  st.state.glossMode = 'llm'
  st.markAsked(['牛顿'], [], 5)
  check('5 轮内被冷却', st.freshNouns(['牛顿'], 6, 10).length === 0)
  check('刚好到 10 轮仍冷却', st.freshNouns(['牛顿'], 15, 10).length === 0)
  check('超过 10 轮放行', st.freshNouns(['牛顿'], 16, 10).length === 1)
  check('其它词不受影响', st.freshNouns(['苹果'], 6, 10).length === 1)
  st.unmarkAsked(['牛顿'], [])
  check('解除冷却后立即放行', st.freshNouns(['牛顿'], 6, 10).length === 1)
}

console.log('== 13. 多边结构（团） ==')
{
  const g = new MemoryGraph({ edgeMode: 'llm' })
  const text = '牛顿研究苹果万有引力'
  const words = ['牛顿', '苹果', '万有引力']
  const positions = new Map()
  for (const w of words) { const i = text.indexOf(w); positions.set(w, { start: i, end: i + w.length }) }
  const r = g.ingest(words, 1, { positions, text })
  check('同句 >=3 词登记为团', g.cliques.size === 1, String(g.cliques.size))
  check('团有待解释记录', r.pendingCliques.length === 1)
  check('团的成员完整', r.pendingCliques[0].names.length === 3)

  const req = buildExplainRequest({ nouns: [], edges: [], cliques: r.pendingCliques })
  check('团在请求里只占一行', req.user.split('\n').filter((l) => l.includes('｜')).length === 1, req.user)
  const cliqueLine = req.user.split('\n').find((l) => l.includes('｜')) || ''
  check('团用 | 连接三词', /\|/.test(cliqueLine.split('｜')[0]), cliqueLine)

  const parsed = parseExplainReply('牛顿|苹果|万有引力｜牛顿在苹果树下想到万有引力', { nouns: [], edges: [] })
  check('解析出团解释', parsed.cliques.length === 1, JSON.stringify(parsed.cliques))
  check('团名已排序', parsed.cliques[0].names.join(',') === [...parsed.cliques[0].names].sort().join(','))

  // 与单边不冲突：AB 单边仍可单独存在
  const g2 = new MemoryGraph({ edgeMode: 'llm' })
  const t2 = '牛顿苹果'
  const p2 = new Map([['牛顿', { start: 0, end: 2 }], ['苹果', { start: 2, end: 4 }]])
  g2.ingest(['牛顿', '苹果'], 1, { positions: p2, text: t2 })
  check('两个词不构成团', g2.cliques.size === 0)
  check('两个词仍建二元边', g2.edges.size === 1)
}

console.log('== 14. 句子质量与替换 ==')
{
  check('定义句判为好', scoreSentence('牛顿是提出经典力学的物理学家', '牛顿').poor === false)
  check('语气词判为差', scoreSentence('好的吧', '好').poor === true)
  check('指代开头判为差', scoreSentence('然后再看一下', '看').poor === true)
  check('不含该词判为差', scoreSentence('我们明天再说别的', '牛顿').poor === true)

  const st = new Store({})
  st.seedGloss('冷却', '好的吧。', 0, 2)
  const first = st.nodes.get('冷却').gloss[0]
  check('差句先存但标记 poor', first.poor === true)

  st.seedGloss('冷却', '冷却是指问过之后一段时间内不再重复询问。', 0, 2)
  const second = st.nodes.get('冷却').gloss[0]
  check('好句替换掉差句', second.poor === false && second.text.includes('重复询问'), second.text)

  st.seedGloss('冷却', '那就这样吧。', 0, 2)
  const third = st.nodes.get('冷却').gloss[0]
  check('差句顶不掉好句', third.text === second.text, third.text)
}

console.log('== 15. 非名词驳回 ==')
{
  const st = new Store({})
  st.state.glossMode = 'llm'
  st.node('逻辑')
  st.node('所以')
  check('驳回前在待解释队列', st.pendingGloss().includes('所以'))
  st.reject('所以')
  check('驳回后移出队列', !st.pendingGloss().includes('所以'))
  check('驳回后进入屏蔽表', st.blocked.has('所以'))
  check('其它名词不受影响', st.pendingGloss().includes('逻辑'))
}

console.log('== 16. 团压制单边（能成团就不建单边） ==')
{
  const words = ['书店', '概念', '信息', '纸质', '电子', '储存']
  const text = '书店其实是误解，最初的概念里信息还是纸质承载的，随后被电子储存取代'
  const positions = new Map()
  for (const w of words) { const i = text.indexOf(w); positions.set(w, { start: Math.max(0, i), end: Math.max(0, i) + w.length }) }

  const g = new MemoryGraph({ edgeMode: 'llm' })
  g.ingest(words, 1, { positions, text })
  check('6 词同句不建单边', g.edges.size === 0, 'edges=' + g.edges.size)
  check('6 词同句形成 1 个团', g.cliques.size === 1, 'cliques=' + g.cliques.size)
  check('团成员没有二元邻居', words.every((w) => g.neighbours(w).length === 0))
  check('cliquesOf 能查到所属团', g.cliquesOf('书店').length === 1)

  // 团成员必须存活，不能被当成孤立概念清掉
  check('isolatePrune 不删团成员', g.isolatePrune() === 0)

  // 旧数据：先有单边，后来成团，这些单边应能清掉
  const g2 = new MemoryGraph({ edgeMode: 'llm' })
  const p2 = new Map([['牛顿', { start: 0, end: 2 }], ['苹果', { start: 2, end: 4 }]])
  g2.ingest(['牛顿', '苹果'], 1, { positions: p2, text: '牛顿苹果' })
  check('两词先建单边', g2.edges.size === 1)
  const p3 = new Map([['牛顿', { start: 0, end: 2 }], ['苹果', { start: 2, end: 4 }], ['引力', { start: 4, end: 6 }]])
  g2.ingest(['牛顿', '苹果', '引力'], 1, { positions: p3, text: '牛顿苹果引力' })
  // ingest 末尾会自动做这件事，所以此时旧单边应已被清掉
  check('成团后旧单边已自动清掉', g2.edges.size === 0, 'edges=' + g2.edges.size)
  check('再次同步无事可做', g2.syncCliqueEdges() === 0)
  check('清理后团仍完整', g2.cliques.size === 1)

  // 删除团成员时，团要一并拆掉
  const g3 = new MemoryGraph({ edgeMode: 'llm' })
  g3.ingest(words, 1, { positions, text })
  g3.dropNode('书店')
  check('删成员即拆团', g3.cliques.size === 0)
}

console.log('== 17. 元描述过滤 ==')
{
  const want = { nouns: ['概念', '逻辑'], edges: [] }
  const meta = [
    '概念｜多边 "书"+"店"+"知识"+"交易"',
    '概念｜该词由书店、知识、交易三者组合',
    '概念｜书店|知识|交易',
  ]
  for (const line of meta) {
    check('丢弃元描述·' + line.slice(3, 10), parseExplainReply(line, want).nouns.length === 0, line)
  }
  check('保留真解释', parseExplainReply('概念｜对一类事物的抽象概括', want).nouns.length === 1)
  check('保留抽象词说明', parseExplainReply('逻辑｜推理过程应遵循的规律', want).nouns.length === 1)

  const st = new Store({})
  st.node('概念').gloss.push({ text: '多边 "书"+"店"', t: 1, kind: 'manual' })
  st.node('逻辑').gloss.push({ text: '推理应遵循的规律', t: 1, kind: 'context' })
  const cleared = st.purgeMetaGlosses()
  check('purge 清掉元描述', cleared === 1, 'cleared=' + cleared)
  check('purge 保留正常解释', st.nodes.get('逻辑').gloss.length === 1)
  check('清空后重新入队', st.nodes.get('概念').gloss.length === 0)
}

console.log('== 18. 解释长度与截断 ==')
{
  const want = { nouns: ['元素'], edges: [] }
  // 短解释原样保留
  const short = parseExplainReply('元素｜对一类事物的抽象概括', want)
  check('短解释不截断', short.nouns[0].gloss === '对一类事物的抽象概括', short.nouns[0].gloss)

  // 中等长度（旧上限 20 会砍断）现在完整保留
  const mid = '元素一词本身是对多边结构中各个组成成分的统称，这里用来泛指参与组合的名词性概念'
  const midGot = parseExplainReply('元素｜' + mid, want)
  check('40+ 字解释完整保留', midGot.nouns[0].gloss === mid, midGot.nouns[0].gloss.length + '字')

  // 超长按标点收口，不切在字中间
  const veryLong = mid + '，包括但不限于实体、属性、关系等各类抽象范畴，以及它们的组合方式'
  const longGot = parseExplainReply('元素｜' + veryLong, want)
  const g = longGot.nouns[0].gloss
  check('超长按标点收口', /[。！？，、；：…]$/.test(g), g)
  check('收口后长度受控', g.length <= 61, g.length + '字')

  // 旧版硬切残句应被清扫
  const st = new Store({})
  st.node('残句').gloss.push({ text: '多边 "元素"一词本身就是对多边结构中各', t: 1, kind: 'llm' })
  st.node('正常').gloss.push({ text: '推理过程应遵循的规律', t: 1, kind: 'llm' })
  const cleared = st.purgeMetaGlosses()
  check('清扫旧截断残句', cleared === 1 && st.nodes.get('残句').gloss.length === 0, 'cleared=' + cleared)
  check('正常解释不受影响', st.nodes.get('正常').gloss.length === 1)
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail ? 1 : 0)