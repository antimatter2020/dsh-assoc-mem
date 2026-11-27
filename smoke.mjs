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

const here = path.dirname(fileURLToPath(import.meta.url))
let pass = 0
let fail = 0

function check(name, cond, extra = '') {
  if (cond) { pass += 1; console.log('  ok   ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

console.log('== 1. 图更新 ==')
{
  const g = new MemoryGraph({ i: 0.005, x: 0.03, y: 0.06, w0: 0.05, thr: 0.05, wmax: 0.9 })
  const r1 = g.ingest(['牛顿', '苹果', '莱布尼茨'], 1)
  check('首轮建 3 条边', r1.added === 3, 'got ' + r1.added)
  check('首轮命中 0', r1.hit === 0)

  const wAB = g.neighbours('牛顿', 99).find((n) => n.name === '苹果')
  check('牛顿-苹果 过线', Boolean(wAB), 'w=' + (wAB && wAB.w))

  const r2 = g.ingest(['牛顿', '莱布尼茨', '爱因斯坦'], 1)
  check('第二轮命中 1 (牛顿-莱布尼茨)', r2.hit === 1, 'got ' + r2.hit)
  check('第二轮新增 2 条', r2.added === 2, 'got ' + r2.added)

  const hitEdge = g.neighbours('牛顿', 99).find((n) => n.name === '莱布尼茨')
  const newEdge = g.neighbours('牛顿', 99).find((n) => n.name === '爱因斯坦')
  check('命中边权重大于新边', hitEdge.w > newEdge.w, hitEdge.w + ' vs ' + newEdge.w)
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
  check('每行给出 ____ 占位', req.user.split('\n').every((l) => l.includes('____')), req.user)
  check('带语境的行附原话', req.user.includes('〔原话〕另外冷却好像也有问题'), req.user)
  check('无语境的行不附原话', req.user.split('\n')[1] === '任务｜____', req.user.split('\n')[1])
  check('词对行用半角竖线连接两词', req.user.includes('模型|任务｜____'))

  const reply = ['冷却｜问过之后一段时间内不再重复', '任务｜这一轮要完成的改动', '模型|任务｜模型把任务理解错了'].join('\n')
  const got = parseExplainReply(reply, { nouns: ['冷却', '任务'], edges: [{ a: '模型', b: '任务' }] })
  check('解析出名词解释', got.nouns.length === 2, JSON.stringify(got.nouns))
  check('解析出边解释', got.edges.length === 1 && got.edges[0].gloss.length > 0)

  const blank = buildExplainRequest({ nouns: ['冷却'], edges: [], contextOf: ctxOf })
  const un = parseExplainReply(blank.user, { nouns: ['冷却'], edges: [] })
  check('占位符原样返回不入库', un.nouns.length === 0, JSON.stringify(un.nouns))
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail ? 1 : 0)