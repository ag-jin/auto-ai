# 当前目标完成审计

日期：2026-11-18。结论：实现与隔离验收已有证据，**完整目标仍未结项**。真实后续任务的版本确认、真实用户验收和合并没有发生，不能用测试中的合成确认替代。

## 按目标核对

| 要求 | 当前证据 | 结论 |
| --- | --- | --- |
| 可配置仓库、标签、作者、关键词、状态、去重与原因 | rules/workflow 测试；独立核心检查 18/18；实际 GitHub PR 观测排除；双仓库界面 6 条观测、5 命中/1 排除 | 已验证 |
| Issue 只含需求也可只读整理，不自动授权 | 真实 Pi draft/worker 角色记录；实际无工具参数；界面未决稿禁用开发；确认前 Run=0 | 已验证 |
| 目标/范围/验收/待决策与稿件版本 | Workflow 规范化/hash/CAS；UI 编辑后先保存新 rev，再启用确认；旧版本批准拒绝测试 | 已验证 |
| 开发/暂缓/忽略以及新用户意图优先 | T006 red→green；决定快照、旧记录兼容；迟到稿 discarded；GUI 延迟完成仍保留两种决定 | 已验证 |
| 确认后自动安排，无第二次派发 | 最新真实 Pi/Git 闭环 6/6；GUI 确认后实际创建工作树并进入执行 | 已验证（隔离源/替身边界见下） |
| 多仓库、同仓独立任务、全局/仓库上限与优先级 | Workflow 的同仓独立/冲突、并发与优先级测试；GUI 双仓库活动 Worker 与容量队列 | 已验证 |
| 显式跨仓依赖、冲突排队、阻塞不拖住其他任务 | 核心依赖检查；GUI 跨仓依赖/同仓写入冲突原因；一个执行失败另一继续；新增全局单槽准备失败不饿死其他仓库的 Runtime 检查 | 已验证 |
| Worker 独立会话、工作树、分支且关联仓库/Issue/版本/Run | PiAdapter 实际子进程恢复/隔离测试；真实 Pi 会话；临时 Git/manifest 串仓拒绝；GUI 两棵不同工作树 | 已验证 |
| 进展、阻塞、证据持久，中断恢复，不重复执行 | SQLite 重开；启动前后/准备两窗口/PR 创建后恢复；unknown 保留占用；合并 intent 并发与重启去重 | 已验证 |
| 固定模型 deepseek-flash/high | 最新真实闭环的 draft/worker 两种 session 与 T006 worker 的 model_change/thinking_level_change 均逐项核对 | 已验证 |
| 模板历史、默认升级与在途固定版本 | catalog、development/research 历史文件；固定 commit 读取、默认升级后重试保留引用测试 | 开发/调研模板已验证；需求整理独立模板仍待 T007 |
| 多仓库 UI、审稿、决定、进展/队列、验收与合并 | 实际 Runtime/HTTP/前端 DOM 事件驱动流程，15 类行为与阶段截图；仓库筛选 2→1→2 | 已验证该驱动路径；原生输入通道未通过 |
| Git 提交、推送、PR 与安全回收 | 真实临时 Git 精确内容和单文件差异；已推送干净树回收；范围包含已提交历史；失败/未知保留；实际开发代码已推送 PR #1 | Git/本地交付已验证；Runtime 的 GitHub PR 创建仍为替身验收 |
| 两种实际验收、当前 head、明确合并、不自行合并 | 后端/HTTP 门槛测试；GUI 分角色、必填设计说明、独立确认、pending 禁重发；真实 PR #1 仍未合并 | 软件门槛已验证；真实用户终验/合并待决定 |
| 及时提交、用完工作树回收 | T002–T006 Worker 树均归档，Git worktree 仅主目录与运行中的 review 树；fixture 停止后保存 bundle 并清理，未知标记保护单独实测 | 已验证 |
| 先闭环，再用完整系统推进真实后续开发 | 自身 prepareTask/PiAdapter 已用于 T001–T006；完整 Runtime 已跑真实 Pi/临时 Git；尚没有用户确认的真实后续 Issue 开发收据 | **尚未完成，T007 v1 待用户决定** |

## 验证的实际范围

- 最新项目测试 **101/101**，其中新增准备失败隔离用例有行为断言，不依赖测试标题推断覆盖。
- 自动监督另有实际计时证据：不手动调用 collect/tick，双仓库收集两轮，一仓失败不影响另一仓，同源只整理一次且没有开发 Run；关闭监督后完整间隔内无第三轮。见 `.auto-ai/validation/watch-loop.json`。
- 核心独立检查 18/18、执行包检查 35/35。对应 Workflow/prepareTask 源码 blob 与先前通过检查时相同，已实际核对；没有把无关重复测试当进展。
- 最新真实 Pi + 真实临时 Git 6/6：GitHub 创建 PR/合并使用明确替身，没有真实 GitHub 合并。
- 真实 GitHub 已验证认证、Issue 列表收集与 PR #1 读回。不能据此声称 Runtime 的实际线上创建/合并已验收。
- GUI 场景的 GitHub/Pi 是明确替身，Runtime/HTTP/生产 UI 与临时 Git 是真实实现。原生输入通道失败，使用同一 CUA 文档允许的 CDP DOM 激活，不声称原生鼠标/键盘通过。

## 证据入口

- `docs/worker-trials/T005-runtime-supervisor.md`、`T006-supervisor.md`、`UI-full-backend-check.md`。
- 本机 `.auto-ai/validation/T006/`：原始失败、独立绿样例、专项、101 项全量及最新真实模型闭环日志。
- 本机 `.auto-ai/validation/runtime-live/`：最新真实模型 result/state、原始 session 与配置核对；先前成功已移到带时间戳目录，未覆盖历史。
- 本机 `.auto-ai/validation/ui-full-1794940156037/`：各阶段状态、截图、原始差异快照、最终后端状态、Git bundle 与清理记录。

`ui-result.json` 的 `completedRecordVisible:false` 来自最后一次 **差异快照** 不含该字面值的采样，不是页面未完成。原始记录保留；完成可见性由完整 `completed.jpg`（已独立视觉检查）、实际 CUA 完整状态输出以及 final-backend.json 证明。不得把差异采样字段直接当成功或失败结论。

## 尚需用户决定

1. [T007 任务稿](worker-trials/T007-task.md) v1 与 [精确输入](worker-trials/T007-proposed-draft.json) 已固定，rev 为 `10fb0c71586487f4b96ed8ce01f3e1d505962474eef697b9516f7dff130e75c5`。未获批准、未创建 Issue、未启动开发。
2. 真实 PR #1 的最终用户验收与合并。执行者不会因上述检查通过自行合并，也不会代用户给出终验通过。

Next action：等待用户确认 T007 当前版本后，以真实 GitHub Issue 和完整工作台推进后续开发；保留真实终验/合并门槛。
