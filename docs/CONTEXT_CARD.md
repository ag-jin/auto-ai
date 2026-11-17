# 当前执行上下文

## 目标与授权

已实现轻量 GitHub 执行工作台：规则收集 Issue → 只读整理标准任务稿 → 用户选择开发/暂缓/忽略 → Pi Worker → 验证与 PR → 用户和设计监督验收、明确合并。

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

- 项目 `npm test`：96/96；核心独立检查 18/18；执行包检查 35/35。
- 真实 Pi 隔离闭环 6/6：需求整理、模拟用户确认、实际 Worker、真实本地 Git 提交推送、工作树回收、验收门槛、合并意图重启去重。两种角色的实际 session 逐项核对为 deepseek-flash/high。
- 真实 GitHub：认证、Issue 列表收集与 PR #1 读回。PR 创建与合并的闭环验收使用隔离替身，未执行真实 GitHub 合并。
- 真实浏览器：实际后端的启动、配置保存、收集、排除原因与未保存输入保护。不是完整浏览器开发/合并流程验收，不能与脚本闭环混称。
- 实际运行服务已配置上述仓库并只读收集：1 条 PR 观测被排除、0 条命中需求、0 个开发 Run；跨 Origin 与无效令牌实际请求均 403。
- 完整记录 `docs/worker-trials/T005-runtime-supervisor.md`，界面记录 `docs/worker-trials/UI-actual-backend-check.md`。

## 工作树与恢复

T002/T003A/T003B/T004/T005A/T005B Worker 树均已归档移除；当前只保留正在运行验收工作台的 review 树。开发 active.json 已更新为 completed/integrated，恢复仍以实际 Pi result 与进程为准。没有待续跑的开发 Worker，不要重复派发。

Git 创建 worktree 后、manifest 写入前的崩溃窗口会保留未知目录并阻塞；不能静默删除。未知 Pi 进程保留写入占用，不盲目重试。

## next_action

保持工作台供用户验收，核对并提交草稿 PR #1 的最终证据。用户明确确认前不合并，也不自行批准新的功能 Issue；后续需求先形成任务稿并等当前版本的开发决定。
