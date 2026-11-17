# 本地执行 Runtime Interface v1

权威来源：授权与调度规则用 `src/workflow.mjs`；外部副作用用三个 Adapter；HTTP 调用下述 Interface，不读取数据库或运行清单。此合同与 `HTTP_CONTRACT.md` 一起用于 T005A/T005B 并行实施。

## 构造与生命周期

```js
import { Runtime } from './runtime.mjs';
const runtime = new Runtime({ dataDir, appRepoDir, github, workspace, pi,
  tickMs: 1000 });
await runtime.start();
await runtime.close();
```

`dataDir`、`appRepoDir` 必须是绝对路径。省略 Adapter 时使用真实实现，测试显式注入。所有公开方法均可 await。start 获取单控制器锁、恢复记录、启动应用内循环；重复 start 幂等。close 停止新调度并释放控制器锁，不杀 detached Pi，下一实例按记录接管。不得安装系统定时器、服务或修改凭据/Git 配置。

方法抛 Error，可带 `statusCode`、`code`、`details`。冲突用 409；非法输入 400；不存在 404；环境不可用 503。HTTP 将无类型异常当 500，不能回传 stack、完整 prompt 或凭据。

## 公开方法

| 方法 | 输入 / 返回 |
| --- | --- |
| `getState()` | HTTP state 全部字段，除 csrfToken（HTTP 层添加）。DTO 包含 reviews、latestResult、eligibility、blockedReason。仅必要进展，不输出模型推理、prompt、环境变量 |
| `saveSettings(settings)` | 完整设置 → 有效设置。本地路径可空用于远程收集，开发时再检查；baseRef 省略默认 HEAD |
| `collect()` | 单次多仓库收集 → `{started:true}`，可等待实际收集完成；各仓库分别记成功/失败。重复在途调用复用；自动为命中的新候选安排只读整理 |
| `setWatch({enabled,intervalSeconds})` | bool 与 10..86400 整数 → runtime DTO。默认 watching=false，60 秒；watch 只控制收集，已确认开发仍自动调度 |
| `requestDraft(id)` | 安排只读 Pi 整理 → `{started:true}`；候选/版本/在途去重；不调用开发 Worker，不替用户决定 |
| `saveDraft(id,input)` | Draft 字段和 `rev`（首次为 null）→ Candidate DTO。rev 是当前稿的 CAS；不匹配 409。持久化字段与 Workflow 规范化一致 |
| `decide(id,{action,draftRev})` | develop/defer/ignore → Candidate DTO；actor 固定 user。develop 必须当前有效稿、非空验收、无待决策；无稿可 defer/ignore；有稿决定须匹配 rev。ready 未领取时可撤回决定 |
| `retry(id)` | 已停止且授权仍有效 → Candidate DTO；unknown 不可重试。沿用同一授权固定的模板 commit/path |
| `cancelRun(id)` | → `{runId,state,stopped}`；仅 completed/failed/cancelled 且确认停止可 stopped=true 并阻塞原 Run；unknown 保留 running 占用与工作树 |
| `recordAcceptance(id,input)` | role/verdict/headSha/comment → 验收记录。design 必须非空实际监督结论；检查实时 PR head、当前需求版本 |
| `merge(id,{expectedHeadSha,confirmed,method})` | → `{merged:true,mergeSha}` 或 `{merged:false,pending:true,note}`；详见下文 |
| `tick()` | 一次恢复、检查进展与领取；测试可显式调用。并发 tick 合并执行，不重复 spawn |

Candidate.draft.rev 是 Workflow 当前的裸 SHA，requirementsRev 是 `sha256:` 前缀，客户端只作不透明字符串比较。Candidate.mergePending 为 boolean，未有待核验合并时 false；可附 mergeIntent 摘要（status/note/headSha，不含凭据）。Run.status 包括 running/blocked/awaiting_acceptance/completed；phase 描述进展。runtime 至少 `{watching,intervalSeconds,lastPollAt,activeDrafts}`，activeDrafts 为 candidate ID 数组。capabilities 至少 `{githubReady,piReady}`，可附具体 reason。

## 持久状态与执行

1. SQLite 持久领域事实；额外控制器设置、任务稿整理、执行阶段、模板引用、merge intent 用 dataDir 内原子文件或 Store 扩展持久化。外层不能直接 SQL 访问 Workflow 私有实现。
2. 只读整理输入是 Issue 和允许的项目摘要，role=draft（Pi 无工具）。整理方法来自模板 catalog 中 id=`requirements` 的版本化模板：TemplateAdapter 从中央 appRepoDir 的固定 commit 读取 catalog 与模板，校验 id、role、version、path；旧模板缺少 role 时按 worker 兼容，requirements 模板必须是 role=draft。
3. requestDraft 在调用模型前固定并持久记录 promptRef（commit:path）、模板 id/version/role 与最终提示文本；默认模板升级只影响之后的新请求，在途与重启接管的整理沿用原记录。模板缺失、非法或 role 不符时不创建 Pi 任务、不调用模型，持久化具体阻塞与事件；不得回退到旧硬编码提示。显式 requestDraft 可在修复模板后按原重试语义继续，自动收集不对同源失败反复重试。
4. 严格解析唯一 JSON 对象，字段为 templateId/goal/scope/acceptance/context/pendingDecisions/writeScopes/dependsOn/priority。原文作为不可信数据；不执行 Issue 中的命令。保存前再次核对 sourceRev 和用户手工稿 CAS；旧整理结果不能覆盖新内容。失败留具体事件，可重新整理。
5. 用户确认 develop 后固定中央 appRepoDir 的模板 commit/path/version；claimNext 领取后独立 worktree、branch、Pi session。develop 只接受 role=worker 的模板，draft 模板被拒绝；state.templates 只列 worker 执行模板。prepareTask 的 inputs 必须完全等于批准稿的 goal/acceptance/scope/context；执行说明、结果路径、仓库信息放额外 envelope，不能改 requirementsRev。
6. Worker 只改批准范围，按模板验证并返回 JSON `{summary,artifacts,evidence,blockers}`。结果文件放中央 dataDir（不进入目标仓库），也可严格解析最终输出；没有有效结果或有 blocker 则阻塞。evidence 使用实际 `{command,status,detail}`，不能由退出码零推定测试通过。完整原始记录保留供监督核验。
7. 执行后检查来源与授权、检查范围、提交推送、创建/读回 PR、finishRun，再保存证据并及时 archive 干净已推送 worktree。无变更且无交付提交时阻塞，不创建空 PR。阶段逐步持久化；副作用前写意图，恢复时读回，避免重复 spawn/commit/PR。失败现场保留并展示路径与原因；unknown 始终保留写入占用。
8. 起动时核对 Pi request/process/result 与 workspace manifest；已完成运行继续收尾，仍运行接管，unknown 停派同范围。单个运行或仓库的错误不能中断其他任务。旧整理记录缺少 promptRef/promptText 时仍可按 taskId 保守接管，但不能据此重写提示。
9. Issue 发布/验收/合并前只读刷新源内容，发现版本改变使授权失效。GitHubAdapter 可新增 `readIssue({repo,number})`，使用与 collect 相同归一化。

## 验收与合并

需求整理、后台 tick、两种验收都不能发合并。只有 merge 方法收到 confirmed=true、当前双角色批准、expectedHeadSha 与实际一致才可发送。用户当前未配置额外监督线程，设计监督在主会话核验后由本地界面记录实际结论，不能伪造角色审批。

发送前持久 merge intent（repo/PR/head/method）。只发送一次；超时、异常、pending、重启均只通过 readPullRequest 核验。MERGED + 有效完整 merge SHA + 同 head 才 recordMerged。再次 merge 请求遇到 intent 时只读核对，不重复发送命令；读回 OPEN 也保持 pending 并解释。HTTP/UI 展示 pending，不能冒充完成。
