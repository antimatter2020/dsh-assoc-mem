import { execSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'

const msg = `fix: 解释解析兼容实际输出格式，冷却改为拿到结果后才记

实测发现两处问题：

1. LLM 请求其实成功了（replyLen 434），但解析出 0 条。
   模型返回的是 Markdown 粗体加中文冒号的样式（**句子**：...），
   旧解析器只认全角竖线，全部丢弃。
   现已兼容：粗体/反引号/列表符/编号/中英文冒号/破折号/竖线，
   并跳过标题行与分隔线。

2. markAsked 在请求发出之前就调用，一次失败即锁死 10 轮，
   表现为「问过却永远没有解释」。改为只有真正拿到结果的条目
   才记冷却，没拿到的立即放行、下一轮重问。

另外把模型原文样本记进 diag.explainSample，
以后再遇到格式不匹配可以直接看到模型回了什么。
`

writeFileSync('.git-msg-tmp.txt', msg, 'utf8')
try {
  execSync('git add -A', { stdio: 'inherit' })
  execSync('git commit -F .git-msg-tmp.txt', { stdio: 'inherit' })
  execSync('git push origin main', { stdio: 'inherit' })
  console.log('commit+push ok')
} finally {
  unlinkSync('.git-msg-tmp.txt')
}