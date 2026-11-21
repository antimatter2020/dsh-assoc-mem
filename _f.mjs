import { execSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'

const msg = `fix: 解释流加硬超时，避免任务永久挂住

实测 lastAskedNouns=15 但 replyLen=0 且无错误：流既不返回内容
也不报错，任务永远挂着，running 不释放，后续每轮被 busy 挡掉。

AbortController 只能请求取消，adapter 不保证遵守。
改为 Promise.race 加 60 秒硬超时，超时当作失败处理并解除冷却。

附：本轮 explainEdges 首次出现非零（1 条），链路已通，
但模型仍误解任务为「合并连通分量」，提示词需重写（见 HANDOFF 六）。
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