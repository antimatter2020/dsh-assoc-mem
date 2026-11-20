import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MemoryGraph } from './lib/graph.js'
import { Tokenizer } from './lib/tokenizer.js'
import { splitParagraphs } from './lib/fragments.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const tk = new Tokenizer({ dictPath: path.join(here, 'data', 'jieba_dict.txt') })
await tk.load(); tk.buildAutomaton()

const text = ['牛顿在苹果树下思考。莱布尼茨也研究微积分。',
  '爱因斯坦提出了相对论，与牛顿的经典力学形成对照。',
  '苹果公司发布了新手机，这件事与物理学无关。'].join('\n')

const segs = splitParagraphs(text, 20)
console.log('片段数:', segs.length)

const g = new MemoryGraph()
for (const seg of segs) {
  const { words } = tk.pairs(seg)
  if (words.length >= 2) {
    console.log('  片段', JSON.stringify(words))
    g.ingest(words, 1)
  }
}
const all = new Set()
for (const e of g.edges.values()) { all.add(e.a); all.add(e.b) }
console.log('')
console.log('概念数:', all.size)
console.log('边数:', g.edges.size)
console.log('')
console.log('「牛顿」的关联:')
for (const n of g.neighbours('牛顿', 10)) console.log('  -', n.name, n.w.toFixed(4))
console.log('')
console.log('「苹果」的关联:')
for (const n of g.neighbours('苹果', 10)) console.log('  -', n.name, n.w.toFixed(4))
