# T005A 返修 1：并发合并只发送一次，读回成功的返回值一致

独立脚本：`.auto-ai/validation/T005A/merge-race.mjs`，主会话 2026-11-18 实跑。脚本只通过 Workflow 公开方法准备临时待验收任务，双角色批准，Runtime 注入 GitHub fixture；没有操作真实 GitHub 合并。

## 已复现输入与错误

1. `Promise.all([runtime.merge(id,input), runtime.merge(id,input)])`，input 为同一当前 head、confirmed=true、method=squash。fixture readIssue 等待 20ms，merge 等待 40ms 并返回 pending。实际 `mergePullRequest` 被调用 **2 次**。两个请求在 await 前都读到没有 intent，后面分别覆盖写 intent 并发送；持久意图不是异步互斥。
2. 上述 pending 后，将 fixture 的只读 PR 改为 MERGED、有效完整 SHA、同 head，再 `await runtime.merge(id,input)`。实际 Candidate 已是 completed，返回却是 `{merged:false,pending:true}`。`#reconcileIntent` 返回了 `#recordMergeResult` 的 HTTP 结果对象，调用者又把它当 intent 传给 `#intentResponse`，状态结构混用。

独立结果 `.auto-ai/validation/T005A/merge-race.json`：mutations=2、afterReadback.pending=true、candidateState=completed。

3. 通过公开 Workflow 准备已领取、固定模板的 Run，保存 control.prepare=`{status:'preparing',template,...}` 后关闭实例，模拟准备中断。新 Runtime.start 的实际结果是 workspace.create=0、Pi.start=0，Run 变 blocked，原因是读取 undefined 的 packetPath。代码把已有 preparing 记录误当完整 prepared，未恢复准备步骤。独立脚本 `.auto-ai/validation/T005A/prepare-recovery.mjs`，结果 `prepare-recovery.json`。

## 期望与回归

- 同一候选的并发 merge，在检查 intent、刷新来源、验证验收、写意图、发命令全过程串行或复用同一个在途 Promise。第二个请求只读/复用，不发第二个 merge；不同候选互不阻塞。
- tick 对 pending intent 的核验也要和显式 merge 的状态变更协调，避免旧 pending 写覆盖新 merged。
- `#reconcileIntent` 始终返回一种稳定结构；确认 MERGED 的显式请求本次就返回 `{merged:true,mergeSha}`，并与 getState 一致。
- 覆盖一次发送前后异常、两个并发显式请求、显式请求与 tick 并发、pending→只读 MERGED、重启后同样路径；无需再发合并命令。
- 在 core.recordMerged 完成后、intent 写成 merged 前中断，重启读回能从持久结果恢复 merge SHA，不能 completed 却永远返回 pending。
- preparing 记录重启后继续幂等 workspace.create/准备 packet，准备齐全后才绑定并 spawn；有既存 manifest 时复用同一工作树。至少覆盖创建前和创建后、prepared 记录写入前的中断，不能留下无人关联的工作树或误入 blocked。

## 首轮尚未通过的四项检查

主会话 `node --test test/runtime.test.mjs` 实跑 8/12，完整输出 `.auto-ai/validation/T005A/current-runtime.log`。原任务所有验收继续有效，本轮要完成 T005A，不能只修上面的三处。

- 旧整理覆盖：当前测试只调用 FakeGitHub.overrideIssue（影响 readIssue）但 collectIssues 的列表可能仍旧。让 fixture 对真实观测行为一致，明确用更新后的 collect 列表或交付前只读刷新；sourceRev 改变后旧稿须 discarded，用户手工稿 CAS 也不能被覆盖。
- 并发测试期望三次 draft.start，实际两次：核对 OTHER_REPO 是否在已配置仓库和规则范围，以及 fake 收集条目是否绑定正确仓库。修正确实错误的 fixture，不要放松串仓/规则检查。以真实合同的并发/依赖/冲突行为验收。
- unknown 后确认 failed，Run 已 blocked，retry 却因 control.spawn 仍标 unknown 被拒绝。确认终止后同步持久终态；仍 unknown 时继续保留占用。
- 旧测试把 Issue 改内容、使授权失效后，仅恢复原文就预期能合并。这个预期违反“源内容改变清除开发授权”。保留失效事实，正向合并应使用独立的有效任务或重新授权后的新产物与验收；不得因正文恢复而恢复旧授权/验收。

## 执行范围与回报

允许 src/runtime*.mjs、src/workflow.mjs、src/store.mjs、src/github-adapter.mjs、test/runtime.test.mjs、docs/worker-trials/T005A-result.md；仅在必要时改领域方法，保持既有 API 兼容。已有代码已经存在，按失败函数定位阅读，避免重复改写整个 Runtime。当前主体、原任务稿和合同是事实来源。

原运行由主会话确认取消后保存检查点，再派本返修，不是已完成。先跑已知失败项与独立脚本，再修复。必须专项和全量都实际通过，并说明真实外部未验证项。补最终结果文档。主会话负责提交，不修改 HTTP/UI、WorkspaceAdapter、合同或真实 PR，不真实合并。
