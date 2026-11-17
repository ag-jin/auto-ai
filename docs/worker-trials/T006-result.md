# T006 结果：异步整理保留用户决定，失败稿不自动重复调用

- run_id：`T006-20261117T182149Z`，attempt 1
- requirements_rev：`sha256:ff35a87498d4e691931a9c2c41f821339731b0d57064308671ca5e597975bc0a`
- template_ref：`be5465530a06e86271705bfc284eec7a7285c20a:templates/development/1.2.0.md`
- 执行者：Pi / `deepseek-flash` / `high`；本任务为已授权系统建设的缺陷返修，未新增功能或放宽授权门槛。
- issue_ref 仅关联集成 PR `ag-jin/auto-ai#1`。未访问真实 GitHub，未 commit/push。

## 复现

主会话独立样例 `.auto-ai/validation/T006/decision-race.mjs`（传本 worktree 路径）：

- 修复前（主会话红日志 `.auto-ai/validation/T006/red.log`）：defer/ignore 后迟到整理把候选改回 `awaiting_decision`、`decision=null`；同源失败整理在 2 次 collect + tick 后共启动模型 3 次。
- 修复后本 worktree 复跑：`defer→deferred`、`ignore→ignored`，失败稿启动次数 1；日志 `decision-race-green.log`，数据 `decision-race-green.json`（中央 evidence 目录）。
- 样例原本写入主会话 validation 路径；本次运行前备份、运行后已还原 `.auto-ai/validation/T006/decision-race.json`，主会话现场未被改写。

## 改动

`src/runtime.mjs`：

- `requestDraft` 在整理记录中持久保存 `decisionSnapshot`（action/draftRev/actor/at 指纹）。
- `#applyDraftResult` 在 sourceRev 与任务稿 CAS 检查之后核对用户决定：任何整理开始后的决定变化都丢弃迟到结果（记录 `state=discarded`，`discarded.result` 留存原始解析结果作证据），不清除 deferred/ignored 或已批准的 develop/固定模板。缺少 `decisionSnapshot` 的旧记录在存在用户决定时保守丢弃。
- `#doCollect` 自动整理跳过：已有任务稿/活动 Run/用户决定、`deferred/ignored/ready/running/awaiting_acceptance/completed`，以及同源版本已 `failed/unknown` 的整理记录。显式 `requestDraft` 仍可重试；新源版本最多自动整理一次；不同候选互不阻塞。
- 提取 `#discardDraftResult` 统一 sourceRev/CAS/决定冲突的丢弃写盘与事件。

`test/runtime.test.mjs`：

- 原有“无稿 defer/ignore 后仍接受迟到稿”的测试预期按新合同修正：无稿决定改用候选 2/3，候选 1 的整理流程保持原覆盖。
- 新增 3 个产品行为回归（文件内序号 16-19）。

`docs/worker-trials/T006-result.md`：本文件。未改动 `src/workflow.mjs`、模板、HTTP、凭据或 Git 配置，未新增依赖。

## 实际验证

| 对象 | 命令 | 结果 |
| --- | --- | --- |
| 独立复现样例（修复后） | `node .auto-ai/validation/T006/decision-race.mjs <worktree>` | passed，3/3 场景，`starts=1` |
| 专项回归 | `node --test test/runtime.test.mjs` | passed，19/19 |
| 项目测试 | `npm test` | passed，100/100 |

回归断言覆盖：

- 无稿 defer/ignore 在迟到成功、重复 tick/collect、关闭重开 Runtime 后仍保持；无 Worker/PR 副作用。
- 整理开始后批准已有稿（已领取 running 与未领取 ready 两种），迟到整理被丢弃，决定、固定模板和任务稿 rev 不变。
- 同源 failed 整理重复 collect/tick 与重开 Runtime 都不新增模型调用；显式 `requestDraft` 恰好 +1；再次失败不自动重试；新源版本自动整理恰好一次并可正常保存。
- 旧格式（无 `decisionSnapshot`）running 记录重开后保守恢复，保留当前用户决定，丢弃结果写入记录作证据。
- 原有 sourceRev/CAS 丢弃回归继续通过。

日志：`/Users/linguojin/Workspace/auto-ai/github-first/.auto-ai/worker-evidence/T006-20261117T182149Z/`（`decision-race-green.log`、`decision-race-green.json`、`runtime-test.log`、`npm-test.log`）。

## 未验证

- 未运行真实 Pi、真实 GitHub 或浏览器验收；本次仅使用注入的 FakePi/FakeGitHub 与临时目录。
- 未提交、未推送、未合并；集成与归档由主会话独立核验后处理。

blockers：[]
