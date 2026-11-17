# T007 真实系统执行监督

状态：首轮 PR #3 真实交付后，独立验收发现竞态，已经现有 Runtime 派发返修。尚未最终验收。记录日期 2026-11-18（Asia/Shanghai）。

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

## 独立检查与返修

- 首轮 head：`b7626971d2b345a1c838b7fe8ff7201163b6d5d4`；真实 PR #3，基准 design/github-first-templates。Runtime 已确认干净、推送后回收树。
- 独立 `npm test`：106/106 通过，日志 `.auto-ai/validation/T007/independent-npm-test.log`。
- 独立真实 Pi 闭环失败：draft 记录于 23:07:52.604Z 先写 running，Pi.start 尚在等待身份；tick 于 .798Z 调 status，误记 unknown。process.json 于 .807Z 才写入，实际 Pi 于 23:07:59.035Z completed，但 Runtime 不再接管。保留完整现场到 `independent-start-race/`，确认 Pi 终止后停止并移除该隔离测试现场；没有停止生产工作台。
- 加入确定性回归 `test/runtime-edges.test.mjs`，实际失败为 `statusCalls: 1 !== 0`。提交 `835e638` 明确标记复现及返修要求，不称为完成。
- 已经真实工作台记录 design changes_requested，再以原授权 retry；新 Run `run-a5500446-44b8-4b27-9238-6b844132e932`，baseCommit=`835e6387991b50174ea207100046dac319c46fb3`，模板和批准稿不变。仅准备该树时选择前轮任务分支为 baseRef，准备完成后恢复原仓库基准。
- 返修要求：修复启动竞态、保留保守恢复与权限门槛、实际通过回归/全量/真实 Pi；修正已随树回收丢失的证据路径，将新检查原始记录集中保存。

## Standards

全新上下文只读审查发现 1 项证据留存问题：首轮 T007-result 引用的工作树内 runtime-live 文件已随回收丢失，需改指中央保留证据。未发现新增代码规范违规或有实质影响的气味。既有检查脚本存放策略不在此次实现 diff 内。

## Spec

全新上下文只读审查未确认额外 Spec 缺陷。显式重新整理后使用新版符合“新请求用新版”；先 defer 再显式请求整理属于更晚用户操作，和整理启动后用户决定被迟到稿覆盖不同，未无依据改写既有语义。

当前结论：Standards 1 项证据问题待返修；Spec 无新增确认问题。主会话实际运行另发现上述启动竞态，必须修复后再验收。

Next action：监督已启动的返修 Run，独立复跑并核对新的 PR；用户最终验收与合并仍未授权。
