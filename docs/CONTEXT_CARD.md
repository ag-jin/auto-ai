# 当前执行上下文

## 目标与授权

已实现轻量 GitHub 执行工作台：规则收集 Issue → 只读整理标准任务稿 → 用户选择开发/暂缓/忽略 → Pi Worker → 验证与 PR → 用户和设计监督验收、明确合并。T007 已经真实用户批准并经完整系统自举、返修及 PR 交付；完整目标仍待用户终验/合并，见 `docs/ACCEPTANCE_AUDIT.md`。

- 模型固定 `facaiai-deepseek / deepseek-flash / high`，凭据沿用本机配置；生产不以 mock 替代外部失败。
- 规则命中不构成开发授权；必须确认当前任务稿版本。需求或源内容改变清除旧授权，正文恢复也不恢复旧决定。
- 模板固定 commit/path/version，在途和同稿 retry 不跟随默认模板升级。
- 每个开发 Worker 独立会话、worktree、分支；按全局/仓库并发、优先级、显式跨仓库依赖和写入冲突调度。
- 用户未配置额外监督线程，由主会话处理设计核验；执行者准备 PR，不自行合并。PR #1 仍待用户最终验收。
- 可验收小步及时提交推送；已交付且保存证据的 Worker 工作树及时归档。失败或未知现场说明原因并保留。

## 事实来源与目录

- 主集成目录：`/Users/linguojin/Workspace/auto-ai/github-first`，分支 `design/github-first-templates`；远端 `ag-jin/auto-ai`，草稿 PR #1。
- 验收运行目录：`/Users/linguojin/.codex/worktrees/workbench-review/github-first`，分支 `review/workbench`；从集成分支快进，供当前工作台运行。
- 运行数据与中央证据：主集成目录的 `.auto-ai/`。正式工作台数据 `.auto-ai/app/`；开发 Worker 原始记录 `.auto-ai/controller-trials/`、`.auto-ai/worker-evidence/`；测试证据 `.auto-ai/validation/`。
- 活动服务：`http://127.0.0.1:4310/`，具体 PID/会话/目录见 `.auto-ai/workbench-server.json`；重启前先核对进程身份，避免重复启动。
- 当前已配置 ag-jin/auto-ai，基准为尚未合并的 `design/github-first-templates`，自动收集关闭。PR #1 合并后，后续开发可将基准改为 main。
- 实现合同：`docs/RUNTIME_CONTRACT.md`、`docs/HTTP_CONTRACT.md`；任务稿格式 `docs/WORKER_BRIEF.md`。

## 实际证据

- T007 最终 PR #5 head=`defc996b6e63a901254a8701756401c6371c1ccf`。代码 `425db49` 的主会话独立 `npm test` 111/111、真实 Pi 隔离闭环 6/6；最终 head 仅更新结果文档，代码/测试 blob 不变。draft/worker 共两个真实 session 均已核对 flash/high，证据 `.auto-ai/validation/T007/attempt3/final-verification.json`。既有核心独立检查 18/18、执行包 35/35。
- 真实 Pi 隔离闭环 6/6：需求整理、模拟用户确认、实际 Worker、真实本地 Git 提交推送、工作树回收、验收门槛、合并意图重启去重。两种角色的实际 session 逐项核对为 deepseek-flash/high。
- 真实 GitHub：Issue #2 创建/收集/源版本读回；完整 Runtime 实际派发 T007 并创建、读回 PR #3/#4/#5，两次 design changes_requested/retry 有真实记录。PR #5 汇集完整改动、主会话设计核验已通过；旧 PR #3/#4 已关闭取代，均未合并。尚未执行真实 GitHub 合并；隔离检查的合并仍为明确替身。
- 真实浏览器已用 DOM 事件驱动补齐双仓库闭环：新稿保存后确认、迟到稿保留决定、并行/冲突依赖队列、失败重试、双角色验收、明确合并、pending 刷新及终态只读。Runtime/HTTP/UI/临时 Git 为真实实现，GitHub/Pi 是明确替身。原生输入通道未通过独立探针，不声称原生鼠标/键盘验收通过。
- 首次正式收集时 1 条 PR 观测被排除、0 条命中需求、0 个开发 Run；后来 T007 真实 Issue 已经批准执行。跨 Origin 与无效令牌实际请求均 403。
- T006 修复迟到整理清用户决定和同源失败无限自动重试，独立专项 19/19、四类补充样例通过，已集成 `ed0f8cd`。界面修复恢复持久合并方式、合并后只读与匹配的 merge SHA，已集成 `6caffa0`。
- 应用内自动监督另经实际计时验证：双仓库自动收集两轮，一仓失败不影响另一仓；同源仅一次只读整理、开发 Run=0；关闭监督后不再收集。
- 完整记录 `docs/worker-trials/T005-runtime-supervisor.md`、`T006-supervisor.md`，界面记录 `UI-full-backend-check.md`。`scripts/serve-ui-fixture.mjs` 可复跑隔离界面场景，不被生产启动引用；停止时保留 Git bundle、清理干净自建工作树并保留未知现场。

## 工作树与恢复

T002/T003A/T003B/T004/T005A/T005B/T006 及 T007 三轮 Worker 树均已归档移除，日志集中保存。当前保留主目录与承载正式工作台的 review 树；review 检查后回到 review/workbench 并快进主集成分支的状态文档。恢复以 `.auto-ai/T007-active.json`、实际 Pi result 与进程为准。没有活动开发 Run；隔离界面服务和已完成测试的临时 Git/工作树均已清理。

Git 创建 worktree 后、manifest 写入前的崩溃窗口会保留未知目录并阻塞；不能静默删除。未知 Pi 进程保留写入占用，不盲目重试。

## next_action

用户已明确回复“批准 T007 v1，用现有系统执行”，批准回执见 `docs/worker-trials/T007-approval.md`。固定 rev=`10fb0c71586487f4b96ed8ce01f3e1d505962474eef697b9516f7dff130e75c5`；`T007-proposed-draft.json` 保留原提案快照，不改写其中历史 authorized=false。

真实 Issue `ag-jin/auto-ai#2` 经工作台收集、只读整理后，按 CAS 保存批准的精确稿；自动稿占持久版本 1，批准内容为持久版本 2，内容 rev 不变。三个开发 Run 均经 Runtime 派发，沿用同一批准稿和固定开发模板 `d5993e36f42d64ea05e7807820f0bf022abe0b61:templates/development/1.2.0.md`。独立发现的启动竞态、unknown 后永久停查与重复派发已转成回归并修复；历史详见 `docs/worker-trials/T007-supervisor.md`。

最终 Run=`run-ea8cc45c-7e95-4214-ae27-42bb5e7adb2d`，交付 PR #5，base=design/github-first-templates，head=`defc996b6e63a901254a8701756401c6371c1ccf`；完整 10 个修改路径均在批准范围。工作台状态 awaiting_acceptance，design=approved、user=null，未合并；正式基准尚未集成 T007 代码。仓库设置已恢复原基准，自动收集仍关闭。用户对 PR #5 最终验收并明确决定合并；PR #1 整体工作台终验仍待用户决定。恢复先检查 `.auto-ai/T007-active.json` 和实际工作台状态，不重复派发。
