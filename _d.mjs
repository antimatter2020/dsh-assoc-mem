import { execSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'

const msg = `fix: 解释任务卡死后永久 busy，改为超时可回收

实测 explainSkipped=busy 且 replyLen=0：请求发出后流不返回 finish，
running 标志永远不释放，之后每一轮都被 busy 挡掉，表现为插件彻底不动。

- 流调用加 AbortController + 60 秒超时
- running 记录 startedAt，超过 90 秒视为死任务并回收
- 失败的条目照旧解除冷却

同时按省 token 的要求收紧批量：一次 6 个词 + 6 条边（原 12/8）。
小批量更容易一次全答对，失败重试代价也更低。
`

writeFileSync('.git-msg-tmp.txt', msg, 'utf8')
try {
  execSync('git add -A', { stdio: 'inherit' })
  execSync('git commit -F .git-msg-tmp.txt', { stdio: 'inherit' })
  execSync('git push origin main', { stdio: 'inherit' })
  console.log('ok')
} finally {
  unlinkSync('.git-msg-tmp.txt')
}