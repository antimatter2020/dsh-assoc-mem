import { execSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'

const msg = `fix: 提示词强约束单行格式，解析器兼容表格兜底

实测模型无视格式要求，返回 Markdown 表格加开场白（replyLen 897，
解析 0 条）。两处一起改：

- 提示词加重约束：明令禁止表格/标题/代码块/粗体/编号/寒暄，
  并给出一段可被解析器原样解析的示例
- 解析器加表格兜底：遇到 | 开头的行按单元格取词与解释，
  模型不听话时不至于整批丢弃

另修 section 每轮被多次调用时重复触发任务的问题，
改为按轮次去重，避免第二次调用直接撞上 busy。
`

writeFileSync('.git-msg-tmp.txt', msg, 'utf8')
try {
  execSync('git add -A', { stdio: 'inherit' })
  execSync('git commit -F .git-msg-tmp.txt', { stdio: 'inherit' })
  execSync('git push origin main', { stdio: 'inherit' })
  console.log('ok')
} finally {
  writeFileSync('.git-msg-tmp.txt', '', 'utf8')
  unlinkSync('.git-msg-tmp.txt')
}