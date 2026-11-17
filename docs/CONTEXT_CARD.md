# 当前执行上下文

## 目标与授权

已实现轻量 GitHub 执行工作台：规则收集 Issue → 只读整理标准任务稿 → 用户选择开发/暂缓/忽略 → Pi Worker → 验证与 PR → 用户和设计监督验收、明确合并。完整目标未结项：真实后续自举开发和用户终验/合并仍待决定，见 `docs/ACCEPTANCE_AUDIT.md`。

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

- 项目 `npm test`：101/101；核心独立检查 18/18；执行包检查 35/35，后两者对应源码 blob 已核对未变。
- 真实 Pi 隔离闭环 6/6：需求整理、模拟用户确认、实际 Worker、真实本地 Git 提交推送、工作树回收、验收门槛、合并意图重启去重。两种角色的实际 session 逐项核对为 deepseek-flash/high。
- 真实 GitHub：认证、Issue 列表收集与 PR #1 读回。PR 创建与合并的闭环验收使用隔离替身，未执行真实 GitHub 合并。
- 真实浏览器已用 DOM 事件驱动补齐双仓库闭环：新稿保存后确认、迟到稿保留决定、并行/冲突依赖队列、失败重试、双角色验收、明确合并、pending 刷新及终态只读。Runtime/HTTP/UI/临时 Git 为真实实现，GitHub/Pi 是明确替身。原生输入通道未通过独立探针，不声称原生鼠标/键盘验收通过。
- 实际运行服务已配置上述仓库并只读收集：1 条 PR 观测被排除、0 条命中需求、0 个开发 Run；跨 Origin 与无效令牌实际请求均 403。
- T006 修复迟到整理清用户决定和同源失败无限自动重试，独立专项 19/19、四类补充样例通过，已集成 `ed0f8cd`。界面修复恢复持久合并方式、合并后只读与匹配的 merge SHA，已集成 `6caffa0`。
- 应用内自动监督另经实际计时验证：双仓库自动收集两轮，一仓失败不影响另一仓；同源仅一次只读整理、开发 Run=0；关闭监督后不再收集。
- 完整记录 `docs/worker-trials/T005-runtime-supervisor.md`、`T006-supervisor.md`，界面记录 `UI-full-backend-check.md`。`scripts/serve-ui-fixture.mjs` 可复跑隔离界面场景，不被生产启动引用；停止时保留 Git bundle、清理干净自建工作树并保留未知现场。

## 工作树与恢复

T002/T003A/T003B/T004/T005A/T005B/T006 Worker 树均已归档移除；当前只保留正在运行验收工作台的 review 树。开发 active.json 已更新为 completed/integrated，恢复仍以实际 Pi result 与进程为准。隔离界面服务和临时 Git/工作树已停止清理，没有待续跑的开发 Worker。

Git 创建 worktree 后、manifest 写入前的崩溃窗口会保留未知目录并阻塞；不能静默删除。未知 Pi 进程保留写入占用，不盲目重试。

## next_action

用户已明确回复“批准 T007 v1，用现有系统执行”，批准回执见 `docs/worker-trials/T007-approval.md`。固定 rev=`10fb0c71586487f4b96ed8ce01f3e1d505962474eef697b9516f7dff130e75c5`；`T007-proposed-draft.json` 保留原提案快照，不改写其中历史 authorized=false。

真实 Issue `ag-jin/auto-ai#2` 已被当前工作台收集；Pi 只读整理完成后，按 CAS 保存批准的精确内容，draft_rev 与 requirements_rev 均匹配，再记录 develop。自动整理稿占持久版本 1，批准内容保存为持久版本 2；批准对应的内容 rev 不变。Runtime 已自动启动 `run-01a73750-61af-414e-9407-d286c7b03af4`，开发模板固定 `d5993e36f42d64ea05e7807820f0bf022abe0b61:templates/development/1.2.0.md`。

首轮实际提交 PR #3 并自动回收 Worker 树。独立全量 106/106 通过，但真实 Pi 复核发现启动竞态：tick 在 Pi.start 返回前误判 unknown，实际已完成结果不再接管。已在 PR #3 记录设计 changes_requested，并提交确定性失败回归 `835e638`；失效的工作树内自测证据引用同时要求修正。

首轮返修 `run-a5500446-44b8-4b27-9238-6b844132e932` 已交付 PR #4（756235e），树已回收。固定提交的独立全量 108/108、真实 Pi 6/6 通过，但新鲜上下文复现另一恢复缺口：starting 重启或身份等待到期的暂时 unknown 会永久停查；显式请求还会重复派发。已记录设计 changes_requested，提交两个确定性失败回归 `2be87c8`。

现有 Runtime 第二次 retry 正在执行 `run-ea8cc45c-7e95-4214-ae27-42bb5e7adb2d`，从 `2be87c8` 继续，仍沿用原批准稿与模板固定引用。要求保留原 taskId/promptRef/promptText、只读复查未知任务并接收后续结果，不在旧任务未确认停止时重复派发，同时修正结果文档两处证据表述。仓库默认基准已恢复 design/github-first-templates。监督该既有返修并独立核验最终 PR，见 `docs/worker-trials/T007-supervisor.md`。恢复先检查 `.auto-ai/T007-active.json`、工作台和 Pi 现场，避免重复派发。本次批准不包括最终用户验收或合并；PR #1 仍待最终验收。
