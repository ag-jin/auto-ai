# 当前目标完成审计

日期：2026-11-18。结论：实现、隔离验收和真实自举开发已有证据，**完整目标仍未结项**。用户已明确批准 T007 v1，真实 Issue #2、Runtime 派发、实际 PR 与返修均已发生；最终用户验收和合并仍未发生，测试中的合成确认不能替代终验。

## 按目标核对

| 要求 | 当前证据 | 结论 |
| --- | --- | --- |
| 可配置仓库、标签、作者、关键词、状态、去重与原因 | rules/workflow 测试；独立核心检查 18/18；实际 GitHub PR 观测排除；双仓库界面 6 条观测、5 命中/1 排除 | 已验证 |
| Issue 只含需求也可只读整理，不自动授权 | 真实 Pi draft/worker 角色记录；实际无工具参数；界面未决稿禁用开发；确认前 Run=0 | 已验证 |
| 目标/范围/验收/待决策与稿件版本 | Workflow 规范化/hash/CAS；UI 编辑后先保存新 rev，再启用确认；旧版本批准拒绝测试 | 已验证 |
| 开发/暂缓/忽略以及新用户意图优先 | T006 red→green；决定快照、旧记录兼容；迟到稿 discarded；GUI 延迟完成仍保留两种决定 | 已验证 |
| 确认后自动安排，无第二次派发 | 真实 T007 批准稿按 CAS 保存后由 Runtime 自动领取；真实 Issue #2、Pi 独立 Worker；独立 Pi/Git 隔离闭环 6/6 | 已验证；开发批准与测试合成确认分开留证 |
| 多仓库、同仓独立任务、全局/仓库上限与优先级 | Workflow 的同仓独立/冲突、并发与优先级测试；GUI 双仓库活动 Worker 与容量队列 | 已验证 |
| 显式跨仓依赖、冲突排队、阻塞不拖住其他任务 | 核心依赖检查；GUI 跨仓依赖/同仓写入冲突原因；一个执行失败另一继续；新增全局单槽准备失败不饿死其他仓库的 Runtime 检查 | 已验证 |
| Worker 独立会话、工作树、分支且关联仓库/Issue/版本/Run | PiAdapter 实际子进程恢复/隔离测试；真实 Pi 会话；临时 Git/manifest 串仓拒绝；GUI 两棵不同工作树 | 已验证 |
| 进展、阻塞、证据持久，中断恢复，不重复执行 | SQLite 重开；启动前后/准备两窗口/PR 创建后恢复；unknown 保留占用；合并 intent 并发与重启去重 | 已验证 |
| 固定模型 deepseek-flash/high | 最新真实闭环的 draft/worker 两种 session 与 T006 worker 的 model_change/thinking_level_change 均逐项核对 | 已验证 |
| 模板历史、默认升级与在途固定版本 | catalog、development/research 历史文件；T007 requirements/1.0.0、role 校验、promptRef/文本持久固定与升级恢复测试 | 开发/调研与需求整理模板已实测；T007 尚待最终验收合并 |
| 多仓库 UI、审稿、决定、进展/队列、验收与合并 | 实际 Runtime/HTTP/前端 DOM 事件驱动流程，15 类行为与阶段截图；仓库筛选 2→1→2 | 已验证该驱动路径；原生输入通道未通过 |
| Git 提交、推送、PR 与安全回收 | 真实临时 Git 精确内容和单文件差异；范围包含已提交历史；Runtime 真实创建并读回 PR #3/#4/#5、推送后回收三棵 T007 Worker 树 | 真实 Git/PR 交付已验证；未执行真实 GitHub 合并 |
| 两种实际验收、当前 head、明确合并、不自行合并 | 后端/HTTP 门槛测试；GUI 分角色、必填设计说明、独立确认、pending 禁重发；真实 PR #1 仍未合并 | 软件门槛已验证；真实用户终验/合并待决定 |
| 及时提交、用完工作树回收 | T002–T006 及 T007 三轮 Worker 树均归档；日志集中保存，Git 仅保留主目录和承载工作台的 review 树 | 已验证，当前无活动开发 Run |
| 先闭环，再用完整系统推进真实后续开发 | T007 v1 的真实用户批准 → Issue #2 → 工作台收集/整理 → 精确稿 CAS/develop → Pi → PR → 独立失败回归 → 同授权两次 Runtime retry → 最终 PR #5 | 真实自举与返修已验证；用户终验/合并待决定 |

## 验证的实际范围

- T007 代码提交 `425db49` 的独立项目测试 **111/111**；包含模板接入、启动窗口竞态、未知状态同任务接管与防重复派发的行为断言。最终 PR #5 head `defc996` 仅增加结果文档，代码和测试 blob 已实际核对不变，10 个修改路径全部符合批准范围。
- 自动监督另有实际计时证据：不手动调用 collect/tick，双仓库收集两轮，一仓失败不影响另一仓，同源只整理一次且没有开发 Run；关闭监督后完整间隔内无第三轮。见 `.auto-ai/validation/watch-loop.json`。
- 核心独立检查 18/18、执行包检查 35/35。对应 Workflow/prepareTask 源码 blob 与先前通过检查时相同，已实际核对；没有把无关重复测试当进展。
- 最新主会话独立真实 Pi + 真实临时 Git 6/6：仅两个实际模型调用，draft/worker session 均逐项核对 deepseek-flash/high。该隔离检查的 GitHub PR/合并使用明确替身，没有真实 GitHub 合并。
- 真实 GitHub 已验证认证、Issue #2 创建/收集/源版本读回、Runtime 实际创建和读回 PR #3/#4/#5。真实开发批准、两次 design changes_requested 与最终 design approved 均经当前工作台记录，返修沿用同一任务稿与模板。PR #5 汇集完整改动，PR #3/#4 已关闭取代且均未合并；用户验收为空，GitHub 合并未实测。
- GUI 场景的 GitHub/Pi 是明确替身，Runtime/HTTP/生产 UI 与临时 Git 是真实实现。原生输入通道失败，使用同一 CUA 文档允许的 CDP DOM 激活，不声称原生鼠标/键盘通过。

## 证据入口

- `docs/worker-trials/T005-runtime-supervisor.md`、`T006-supervisor.md`、`T007-supervisor.md`、`UI-full-backend-check.md`。
- 本机 `.auto-ai/validation/T007/attempt3/final-verification.json`、`independent-runtime-live/`、`final-production-state.json`：最新独立检查、唯一一轮实际 Pi 证据及最终生产状态。T007 目录同时保留两次失败复现与前轮证据，不用旧通过日志覆盖新失败。
- 本机 `.auto-ai/validation/T006/`：原始失败、独立绿样例、专项、101 项全量及最新真实模型闭环日志。
- 本机 `.auto-ai/validation/runtime-live/`：最新真实模型 result/state、原始 session 与配置核对；先前成功已移到带时间戳目录，未覆盖历史。
- 本机 `.auto-ai/validation/ui-full-1794940156037/`：各阶段状态、截图、原始差异快照、最终后端状态、Git bundle 与清理记录。

`ui-result.json` 的 `completedRecordVisible:false` 来自最后一次 **差异快照** 不含该字面值的采样，不是页面未完成。原始记录保留；完成可见性由完整 `completed.jpg`（已独立视觉检查）、实际 CUA 完整状态输出以及 final-backend.json 证明。不得把差异采样字段直接当成功或失败结论。

## 尚需用户决定

1. T007 的开发批准已完成，回执见 [T007-approval.md](worker-trials/T007-approval.md)。最终 PR #5 已交付，设计核验通过，尚未记录用户终验；正式基准尚未集成此修改。
2. 真实 PR #1 与最终 T007 PR 的用户验收及合并。执行者不会因上述检查通过自行合并，也不会代用户给出终验通过。

Next action：用户验收 PR #5，并明确决定是否合并；保持实际用户终验和合并门槛。
