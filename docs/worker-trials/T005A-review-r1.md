# T005A 返修 1：并发合并只发送一次，读回成功的返回值一致

独立脚本：`.auto-ai/validation/T005A/merge-race.mjs`，主会话 2026-11-18 实跑。脚本只通过 Workflow 公开方法准备临时待验收任务，双角色批准，Runtime 注入 GitHub fixture；没有操作真实 GitHub 合并。

## 已复现输入与错误

1. `Promise.all([runtime.merge(id,input), runtime.merge(id,input)])`，input 为同一当前 head、confirmed=true、method=squash。fixture readIssue 等待 20ms，merge 等待 40ms 并返回 pending。实际 `mergePullRequest` 被调用 **2 次**。两个请求在 await 前都读到没有 intent，后面分别覆盖写 intent 并发送；持久意图不是异步互斥。
2. 上述 pending 后，将 fixture 的只读 PR 改为 MERGED、有效完整 SHA、同 head，再 `await runtime.merge(id,input)`。实际 Candidate 已是 completed，返回却是 `{merged:false,pending:true}`。`#reconcileIntent` 返回了 `#recordMergeResult` 的 HTTP 结果对象，调用者又把它当 intent 传给 `#intentResponse`，状态结构混用。

独立结果 `.auto-ai/validation/T005A/merge-race.json`：mutations=2、afterReadback.pending=true、candidateState=completed。

## 期望与回归

- 同一候选的并发 merge，在检查 intent、刷新来源、验证验收、写意图、发命令全过程串行或复用同一个在途 Promise。第二个请求只读/复用，不发第二个 merge；不同候选互不阻塞。
- tick 对 pending intent 的核验也要和显式 merge 的状态变更协调，避免旧 pending 写覆盖新 merged。
- `#reconcileIntent` 始终返回一种稳定结构；确认 MERGED 的显式请求本次就返回 `{merged:true,mergeSha}`，并与 getState 一致。
- 覆盖一次发送前后异常、两个并发显式请求、显式请求与 tick 并发、pending→只读 MERGED、重启后同样路径；无需再发合并命令。
- 在 core.recordMerged 完成后、intent 写成 merged 前中断，重启读回能从持久结果恢复 merge SHA，不能 completed 却永远返回 pending。

只改 src/runtime*.mjs、test/runtime.test.mjs、docs/worker-trials/T005A-result.md；保留原授权、独立 Worker、scope 与恢复功能。先复现再修复，专项及全量检查实际跑。主会话负责提交，不修改 HTTP/UI 或合同，不真实合并 PR。
