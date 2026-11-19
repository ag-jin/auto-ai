# SOP 工作台 v1 验证记录

## 批准范围

用户批准工作台固定任务稿、SOP 与 YAML 模板版本，使用现有 Pi/worktree 两路并行；失败只退回对应一路；重新测试、独立代码验收后交付一个 PR，不自动合并。不实现通用编排器或流程编辑器。

## 实现与验证

代码提交 `cc881da3077d0de9d7012bc1a798e5b3114de9f7`（后续仅补本文与取消返回值说明）。

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

## 未完成的验收

尚未由该 SOP Runtime 对真实 GitHub Issue 自动创建并读回真实 PR；本次功能 PR 的人工提交不能替代这个证明。仍需选定并确认一份精确真实验收稿，再由隔离 Runtime + 真实 GitHubAdapter 执行到 PR。不能把本地 fixture PR、历史样例 PR #13 或本功能 PR 当作该验收结果。

不重启正式服务，不动正式数据，不改主仓库已有未提交文档，不自动合并。
