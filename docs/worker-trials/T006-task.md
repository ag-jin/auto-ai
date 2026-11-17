# T006：异步整理保留用户决定，收集不无限重试失败稿

版本 1。执行者 Pi / deepseek-flash / high。本任务是已授权系统建设中的缺陷返修，不新增功能需求或修改授权门槛。

## 目标与完成条件

修复已复现的迟到整理结果覆盖用户选择、自动收集重复调用失败整理的问题。用户对当前需求作出的决定优先于此前开始的异步整理；同一源版本的失败/未知结果只有明确重试才能再调用模型。不得减少现有授权、模板固定、恢复和并发检查。

## 事实来源

先读 AGENTS.md、docs/CONTEXT_CARD.md。按需读 docs/RUNTIME_CONTRACT.md 的整理/决定/恢复约定，再定位 src/runtime.mjs 的 #doCollect、requestDraft、#applyDraftResult 和 #recoverDrafts。领域决定语义在 src/workflow.mjs；已有 fake/真实本地 Git 测试在 test/runtime.test.mjs。

主会话的独立复现：`/Users/linguojin/Workspace/auto-ai/github-first/.auto-ai/validation/T006/decision-race.mjs`，可传你的 worktree 路径作为 moduleDir。原始失败已保存于该目录 red.log / decision-race.json，不操作真实 GitHub。

## 范围

仅允许 src/runtime.mjs、test/runtime.test.mjs 或新的 test/runtime-draft-decisions.test.mjs，以及 docs/worker-trials/T006-result.md。仅在确实需要领域原子操作时增补 src/workflow.mjs，但保持已有 Interface 兼容。没有新增依赖、HTTP/UI/模板/凭据/Git 配置改动。

## 复现与期望合同

1. FakePi.start(draft) 返回 running，候选没有 draft；用户 decide(defer) 或 decide(ignore) 成功；FakePi 状态变 completed，输出有效任务稿；runtime.tick()。现状两个候选都变 awaiting_decision 且 decision=null。期望保留 deferred/defer 或 ignored/ignore，旧整理结果 discarded，不能清除用户决定。
2. 同源版本第一次整理失败，随后连续两次 collect + tick。现状模型共启动 3 次。期望总共 1 次；用户显式 requestDraft 可启动第 2 次。关闭重开后也不能忘记这个限制。

整理开始时持久保存所依据的决定快照或等价的意图版本。应用结果时核对 sourceRev、任务稿 CAS 和用户决定，任何后来决定都优先，旧结果保留证据但不应用。已有磁盘记录没有新字段时要保守恢复，不能覆盖当前用户决定。

自动收集跳过 deferred/ignored、已授权 ready/running/awaiting_acceptance/completed，以及同一源版本已经失败/未知的整理尝试。只有源内容形成新有效版本时才允许自动整理一次；同版本的故障恢复由显式 requestDraft 发起。不同候选不互相阻塞。先前用户明确请求过的重新整理可继续，但不能让之后作出的决定失效。

## 验收

- 两种无稿决定在迟到成功、重复 tick、收集、重启之后仍保持；没有 Worker 和 PR 副作用。
- 整理启动后用户批准已有稿，迟到输出不能清除其有效授权；是否已领取不改变这个结论。
- 同源失败/unknown 重复 collect 或重开 Runtime 不额外调用模型；显式 requestDraft 恰好新增一次；新源版本最多自动整理一次。
- 原有 sourceRev/CAS 保护继续有效；显式重新请求与默认新候选整理正常工作。
- 旧格式整理记录能安全恢复，用户选择优先。

## 验证与回报

先复跑主会话独立样例确认失败，再添加有产品行为断言的回归。运行专项与 npm test，日志写启动包给出的中央 evidence 目录。测试使用明确注入的替身/临时目录，不访问真实 GitHub、不启动真实开发任务。

最终结果 docs/worker-trials/T006-result.md 记录实际命令/数量、范围、未验证项。不要自行 commit/push，主会话独立核验后及时提交集成并归档此 worktree。
