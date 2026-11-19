# T007 v1 开发批准回执

- 记录日期：2026-11-18（Asia/Shanghai）。
- 用户直接回复：**“批准 T007 v1，用现有系统执行”**。
- 对应任务稿：`T007-task.md` v1；精确输入：`T007-proposed-draft.json` 的 draft 字段。
- draft_rev：`10fb0c71586487f4b96ed8ce01f3e1d505962474eef697b9516f7dff130e75c5`。
- requirements_rev：`sha256:a0ef7b417f1dee351d7c06e2fb87cd15ab22417ddfca5eb2c9ea6458fb5acb4d`。

批准范围：创建/复用真实 GitHub Issue，经现有工作台保存上述精确稿并记录 develop 决定，由 Runtime 安排独立 Pi Worker（deepseek-flash / high）、实际验证和提交 PR。原提案快照中的“待批准”字段是历史记录，保留不改。

最终用户验收与合并仍待用户明确操作，本回执不授予自动合并权限。主会话负责独立技术与设计核验，不增加额外监督线程。

Execution Route：现有工作台 HTTP → Runtime → 真实 Issue 候选 → 固定稿/CAS/用户决定 → 独立 Pi 工作树 → 实际 GitHub PR → 独立核验与必要返修。运行标识和中央证据保存在 `.auto-ai/T007-active.json`、`.auto-ai/app/` 与任务结果记录。
