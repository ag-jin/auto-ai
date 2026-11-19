# SOP 工作台 v1 验证记录

## 批准范围

用户批准工作台固定任务稿、SOP 与 YAML 模板版本，使用现有 Pi/worktree 两路并行；失败只退回对应一路；重新测试、独立代码验收后交付一个 PR，不自动合并。不实现通用编排器或流程编辑器。

## 实现与验证

最终执行代码 `9e92325e5199c8a6e0edfba9591db3ec50e8c8cf`，真实验收后不再改生产代码；后续仅更新本文。

- 主会话最终 `npm test`：141/141 通过。
- `npm run check:workflow`：18/18；`npm run check:runtime`：6/6，均使用明确替身，不代表真实 GitHub。
- Standards / Spec 两轴独立审查及复审：无阻塞问题。按审查修复两路交接齐全后才汇总、逐项验收证据、清理 lane 前核 manifest 归属，以及测试、评审、提交 Git tree 一致性。
- 真实 Pi 隔离验收：10/10。Runtime、PiAdapter、临时 Git/bare remote 与实际 Node 检查均为真实实现，GitHub 为显式 fixture；任务稿通过测试驱动保存并模拟批准，不能视为另一份真实 Issue 已获用户批准。

Run：`run-fee70bd9-0f7f-49f4-8970-f1bd29d1b390`。应用模板固定为 `cc881da3077d0de9d7012bc1a798e5b3114de9f7:templates/development-sop/1.0.0.md`。

- A1：08:27:28.441Z–08:27:35.622Z；B1：08:27:28.712Z–08:27:37.794Z；重叠 6.910 秒。独立 session/worktree/branch。
- A1 按试验稿交付 `initial`，实际 Node 检查失败；仅 A2 接到失败证据并修正 `reworked`。B 始终一次执行，保持 `stable`。
- A2：08:27:38.748Z–08:27:47.100Z；review：08:27:48.277Z–08:28:47.788Z，独立无工具 session 输出 approved 与两条逐项证据。
- provider 均为 `facaiai-deepseek`，模型/思考由 Pi monitor 固定 `deepseek-flash/high`，原始 events 与 request/result 留存。
- 本地 bare 交付 head：`4c5909b883dc5196fbbc2652ec1dff45b483938c`。恰一个 fixture PR，无合并；两路工作树回收；成功试验临时 Git 已清理。

中央原始证据：`.auto-ai/sop-runtime.lJFy9H/evidence/sop-acceptance/2026-11-19T08-27-27-400Z/`，包含 summary、control、state、review YAML、Pi request/result/events。此目录的历史 summary 字段 `realNetwork: false` 应读作“没有真实 GitHub 请求”；真实 Pi 确实调用配置的远端模型，不应声称完全离线。

第一次真实试验留在 `2026-11-19T08-26-01-402Z/`：A 返工交接多了未知 `summary` 键，被严格拒绝，未发 PR。之后明确五键 YAML 示例，未放宽 schema，第二次通过。失败临时现场保留，不清除未知或未交付产物。

## 真实 GitHub 终验（通过）

2026-11-19 用户明确授权「继续安排验证.设置长期推进目标」，主会话据此限定并发布最小验收稿 [Issue #15](https://github.com/ag-jin/auto-ai/issues/15)。验收驱动将该范围保存为固定稿并记录 develop 决定，不代表用户曾在 UI 点击批准；普通 requirements 整理被显式跳过，其余 Runtime、Pi、Git、检查和 GitHubAdapter 均为真实实现。

- 成功 Run：`run-c9a8ac9e-e7f9-46e1-8a7d-199650472540`。
- draftRev：`19a03017221fd83094ecb26e6d20ee4456c25871f5c31ff94ce39d3a93bfb219`。
- 应用与 SOP 固定 commit：`9e92325e5199c8a6e0edfba9591db3ec50e8c8cf`。
- 专用基线 `test/sop-runtime-github-v1`，commit `d1d538e3df6bf38a7a2da5852fa225f92a580c35`；两个 Node 检查脚本预先固定在基线，Worker 不能改它们。
- A1：09:35:56.942Z–09:36:10.564Z；B1：09:35:57.284Z–09:36:06.995Z，重叠 9.711 秒。原始 request 中会话和工作树独立，B 仅一次。
- 实际 `node examples/sop-runtime/check-a.mjs` 退出码 1：`AssertionError: SOP_CHECK_A: SUBTOTAL_MARKER=initial`。控制器仅向 A2 回传失败证据；`control.sop.reworks` 恰一条 `step=develop-a, stage=check`。A2 修为 reworked，最终两个 Node 检查均退出 0。
- 独立 reviewer 使用无工具 draft 角色，原始结果 approved，按两条原稿验收项输出证据。`testedTree=0ddf68359a2021a5cb98f932a59e61b5c8c56582` 与最终推送提交的 tree 完全相同，主会话与独立复审均已核对。
- 工作台自动创建并读回 [PR #17](https://github.com/ag-jin/auto-ai/pull/17)，head `37b092277cf958373c088be0ba1e6ff2127ace05`。远端分支、Run 结果、control 与 `gh pr view` 一致；同 head/base 分支恰一个 PR；仅两份批准产物，正文有原稿 rev、SOP 引用与逐项证据。没有人工调用 `gh pr create` 代替此交付。
- 验收驱动 8/8；主会话最终 `npm test` 141/141；额外执行包 `check:trial` 35/35；独立最终代码与原始证据复核无阻塞。两路 lane 和父集成工作树均由 Runtime 回收，磁盘与 Git worktree list 已核对。

中央证据：`.auto-ai/sop-runtime.lJFy9H/real-data-v2/evidence/real-github-sop/2026-11-19T09-35-51-491Z/`，包含 summary、control、state、固定稿、批准回执、PR 与原始 `gh-pr-view.json`；完整原始 Pi session/request/events/result 在同级运行目录 `real-data-v2/pi/`（另有证据副本）。

### 不计为合格终验的首轮

Run `run-68c23495-d646-428f-bef6-026c7a44ba5b` 曾自动交付 [PR #16](https://github.com/ag-jin/auto-ai/pull/16)，但 A 因 YAML 外说明导致 handoff 返工，不是实际检查失败触发，故驱动明确报失败，未算通过。随后只加强提示「禁止围栏、前后说明」，没有放宽 schema；使用同稿和新隔离运行目录得到上述 PR #17。首轮证据保留于 `real-data/evidence/real-github-sop/2026-11-19T09-33-45-727Z/`。每个 Run 各交付一个 PR；整个验证过程实际创建了两个，不能说全程只创建一个。

两个验收 PR 均为专用测试分支上的样例，不应合入产品。功能交付仍是 PR #14。本轮不自动合并或关闭任何 PR，不重启正式服务，不动正式数据，不改主仓库已有未提交文档。
