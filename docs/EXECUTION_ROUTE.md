# Execution Route

## 当前状态

已集成 T001 执行包、T002 SQLite 领域核心、T003 Pi/GitHub/模板/worktree Adapter、T004 中文界面与 T005B HTTP 操作入口。集成后的主会话测试实跑 78/78，核心独立检查 18/18；Runtime T005A 仍在实施，不能将已有模块测试视为完整闭环。

## 执行路线

| 项目 | 约定 |
| --- | --- |
| 目标 | Issue → 候选与任务稿 → 用户确认开发 → Worker → 验证/PR → 验收与明确合并 |
| 本轮技能 | `writing-for-agents` 收敛任务稿；`codebase-design` 收敛职责；`web-access` 核对官方资料 |
| 事实来源 | 用户决定、当前仓库文件、实际执行日志与 GitHub 读回结果 |
| 现有规格 | `docs/DESIGN.md`、`docs/RUNTIME_CONTRACT.md`、`docs/HTTP_CONTRACT.md` |
| 模板来源 | `templates/catalog.yml` 指向的版本，并固定 Git commit |
| next_action | 核对 `.auto-ai/T005A-active.json` 与 Pi monitor；验收 Runtime，接上 HTTP，运行独立闭环与真实浏览器检查 |

任务板、锁和调度状态后续若进入托管技能体系，应先核对当时可用的 `task-board` 所有权，保持单一事实来源。本轮没有部署运行时或修改托管技能系统。

## 实施顺序

1. **Runtime 集成**：核验 T005A 的授权、独立执行、去重、未知进程保留占用和恢复。
2. **独立闭环**：`scripts/check-runtime.mjs`（准备中，尚未通过）使用真实临时 Git/worktree 与隔离 GitHub fixture；`--live-pi` 追加真实模型。模拟合并必须明确标注，不操作真实 PR 合并。
3. **真实界面检查**：启动真实 HTTP/Runtime，检查多仓库配置、收集、任务稿、队列与验收；保存实际截图与操作证据。
4. **可审查交付**：及时提交推送、更新草稿 PR #1 和证据，回收已用完 worktree。用户未配置其他监督线程，设计核验由主会话处理，最终合并仍等用户明确操作。

GitHub Issue 和运行日志应保留可恢复记录，长任务从项目文件与实际状态继续。

## 第一项验收样例

在隔离测试仓库提出新增 NOTE.md 的需求，规则命中只读整理任务稿，模拟用户确认当前版本后自动调度，真实本地提交推送并生成 fixture PR，再核对验收/合并门槛和重启恢复。真实 Pi 与模拟依赖分别记录。

首版尚需验证的能力不能由静态 YAML 检查替代。

## 任务稿磨合入口

- [六段任务稿格式](WORKER_BRIEF.md)
- [T001 原始任务稿](worker-trials/T001-task.md)
- [独立核验反馈](worker-trials/T001-review-r1.md)
- [补充返修任务稿](worker-trials/T001-fix-1.md)
- [Worker 实际交付记录](worker-trials/T001-result.md)
