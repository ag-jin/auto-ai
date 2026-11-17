# T007 真实系统执行监督

状态：开发运行中，尚未验证实现或创建 PR。记录日期 2026-11-18（Asia/Shanghai）。

## 授权与链路

- 用户批准：`T007-approval.md`；原提案 v1 保留，批准内容 rev=`10fb0c71586487f4b96ed8ce01f3e1d505962474eef697b9516f7dff130e75c5`。
- 真实 GitHub Issue：`ag-jin/auto-ai#2`，标题“需求整理方法纳入版本化模板”。首次收集未见刚创建条目，再次收集成功；没有通过本地插入候选绕过收集。
- 正式工作台 `127.0.0.1:4310`，正式数据 `.auto-ai/app/`。服务和 Pi 进程身份已核对。
- 只读整理：`draft-570595338d19203a-1`，会话 `c3f5405d-6afb-4388-84a7-ac20eb4fc6d4`，实际输出唯一 JSON，pendingDecisions=[]。模型产生的稿件不是批准对象；随后以 CAS 保存用户已批准 JSON 的精确字段。
- 保存后持久版本为 2（自动稿为 1），内容 rev 与批准的 v1 完全相同，requirements_rev=`sha256:a0ef7b417f1dee351d7c06e2fb87cd15ab22417ddfca5eb2c9ea6458fb5acb4d`。以此记录真实用户 develop 决定。
- Runtime 自动领取 Run：`run-01a73750-61af-414e-9407-d286c7b03af4`。没有直接调用 PiAdapter 代替生产派发。
- 独立分支：`auto-ai/run-01a73750-61af-414e-9407-d286c7b03af4`；基准 `d5993e36f42d64ea05e7807820f0bf022abe0b61`。
- 固定模板：`d5993e36f42d64ea05e7807820f0bf022abe0b61:templates/development/1.2.0.md`。
- 开发会话：`8f28cd73-d70e-4a4c-8daf-ed9adffc7ef1`；独立工作树由 Runtime 建立，不作为主会话工作目录。

## 实际模型证据

两个真实 session 的 model_change 均为 `facaiai-deepseek / deepseek-flash`，thinking_level_change 均为 `high`。Pi monitor 固定参数并对 draft 使用 `--no-tools`；没有给 Worker 工作台令牌。

## 中央证据与恢复

`.auto-ai/validation/T007/` 保存 approval、Issue 读回、原模型稿、批准候选、develop 决定、run-start 和 model-proof；完整 Pi 日志在 `.auto-ai/app/pi/`，执行包与控制记录在 `.auto-ai/app/runs/<run-id>/`。`.auto-ai/T007-active.json` 为本次监督恢复指针。

Next action：监督既有 Run 到实际 PR，独立验证后保存结论；用户最终验收与合并仍未授权。
