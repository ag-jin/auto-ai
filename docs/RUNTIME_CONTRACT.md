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
| `setAutoRepair(id,{enabled,draftRev})` | → autoRepair 摘要（policy/已用/剩余/原因/待领取绑定）。开启必须先只读刷新 Issue 来源且要求当前有效开发授权与当前 `draftRev`；来源变化或读取失败时拒绝。关闭总能停止，不要求授权。设置本身不派发 Run |
| `cancelRun(id)` | → `{runId,state,stopped}`；仅 completed/failed/cancelled 且确认停止可 stopped=true 并阻塞原 Run；unknown 保留 running 占用与工作树 |
| `recordAcceptance(id,input)` | role/verdict/headSha/comment → 验收记录。design 必须非空实际监督结论；检查实时 PR head、当前需求版本 |
| `merge(id,{expectedHeadSha,confirmed,method})` | → `{merged:true,mergeSha}` 或 `{merged:false,pending:true,note}`；详见下文 |
| `tick()` | 一次恢复、检查进展与领取；测试可显式调用。并发 tick 合并执行，不重复 spawn |

Candidate.draft.rev 是 Workflow 当前的裸 SHA，requirementsRev 是 `sha256:` 前缀，客户端只作不透明字符串比较。Candidate.mergePending 为 boolean，未有待核验合并时 false；可附 mergeIntent 摘要（status/note/headSha，不含凭据）。Run.status 包括 running/blocked/awaiting_acceptance/completed；phase 描述进展。runtime 至少 `{watching,intervalSeconds,lastPollAt,activeDrafts}`，activeDrafts 为 candidate ID 数组。capabilities 至少 `{githubReady,piReady}`，可附具体 reason。

## 持久状态与执行

1. SQLite 持久领域事实；额外控制器设置、任务稿整理、执行阶段、模板引用、merge intent 用 dataDir 内原子文件或 Store 扩展持久化。外层不能直接 SQL 访问 Workflow 私有实现。
2. 只读整理输入是 Issue 和允许的项目摘要，role=draft（Pi 无工具）。整理方法来自模板 catalog 中 id=`requirements` 的版本化模板：TemplateAdapter 从中央 appRepoDir 的固定 commit 读取 catalog 与模板，校验 id、role、version、path；旧模板缺少 role 时按 worker 兼容，requirements 模板必须是 role=draft。
3. requestDraft 在调用模型前固定并持久记录 promptRef（commit:path）、模板 id/version/role 与最终提示文本；默认模板升级只影响之后的新请求，在途与重启接管的整理沿用原记录。模板缺失、非法或 role 不符时不创建 Pi 任务、不调用模型，持久化具体阻塞与事件；不得回退到旧硬编码提示。显式 requestDraft 可在修复模板后按原重试语义继续，自动收集不对同源失败反复重试。整理记录先写 `starting`，只有 Pi.start 返回后才转 `running`；`starting` 期间 tick 不轮询 status（此时还没有 monitor 身份，读回只会是假 unknown），因此启动与监督共用同一 task id 且不重复调用模型。已有 Pi 请求但 monitor 身份或结果暂不可读时，记录转 `unconfirmed`：保留原 taskId/promptRef/promptText 与只读核对，能接收其后的 running/completed，不新建模型任务；确认恢复 running 时回到 `running`。
4. 严格解析唯一 JSON 对象，字段为 templateId/goal/scope/acceptance/context/pendingDecisions/writeScopes/dependsOn/priority。原文作为不可信数据；不执行 Issue 中的命令。保存前再次核对 sourceRev 和用户手工稿 CAS；旧整理结果不能覆盖新内容。失败留具体事件，可重新整理。
5. 用户确认 develop 后固定中央 appRepoDir 的模板 commit/path/version；claimNext 领取后独立 worktree、branch、Pi session。develop 只接受 role=worker 的模板，draft 模板被拒绝；state.templates 只列 worker 执行模板。prepareTask 的 inputs 必须完全等于批准稿的 goal/acceptance/scope/context；执行说明、结果路径、仓库信息放额外 envelope，不能改 requirementsRev。
6. Worker 只改批准范围，按模板验证并返回 JSON `{summary,artifacts,evidence,blockers}`。结果文件放中央 dataDir（不进入目标仓库），也可严格解析最终输出；没有有效结果或有 blocker 则阻塞。evidence 使用实际 `{command,status,detail}`，不能由退出码零推定测试通过。完整原始记录保留供监督核验。

   返修重试时，控制器在创建 worktree 前只取紧邻前一个 Run（同候选，且 draftRev/requirementsRev/sourceRev 与当前完全一致并已有 `result.pr`）的验收：acceptance 的 runId 和 headSha 必须匹配该 Run 与其 PR；每个 role 取最新结论，再只保留 `changes_requested`，后来的 `approved` 覆盖同角色旧意见。快照冻结在该 Run 的 control 字段 `retryFeedback`（结构含 `previousRunId`/`pr`/`feedback`，`null` 也视为已冻结），准备重入与重启沿用原快照，不重新采样，也不跨过中间失败 Run 去取更老意见。快照仅作为 Worker 提示的额外“返修参考”，不改变 prepareTask、执行包 inputs/hash 或模板；意见只能在原 writeScopes 内落实，不授予合并或扩权，前轮 PR 仅作引用。已有 prepared 或已绑定提示的历史 Run 不改写输入，新 Run 只启动一次。
7. 执行后检查来源与授权、检查范围、提交推送、创建/读回 PR、finishRun，再保存证据并及时 archive 干净已推送 worktree。无变更且无交付提交时阻塞，不创建空 PR。阶段逐步持久化；副作用前写意图，恢复时读回，避免重复 spawn/commit/PR。失败现场保留并展示路径与原因；unknown 始终保留写入占用。
8. 起动时核对 Pi request/process/result 与 workspace manifest；已完成运行继续收尾，仍运行接管，unknown 停派同范围。单个运行或仓库的错误不能中断其他任务。旧整理记录缺少 promptRef/promptText 时仍可按 taskId 保守接管，但不能据此重写提示。中断在 `starting` 的整理记录按同一 task id 只读核对 Pi 现场：请求存在则接管（running，或 monitor 身份未确认时 `unconfirmed`），不存在或读取失败则记为具体 `failed` 阻塞，不重新调用模型。`unconfirmed` 期间（含显式 requestDraft）不得为同一候选启动新的 taskId；待原任务给出最终结果后按正常迟到结果保护应用或丢弃。
9. Issue 发布/验收/合并前只读刷新源内容，发现版本改变使授权失效。GitHubAdapter 可新增 `readIssue({repo,number})`，使用与 collect 相同归一化。

## 有界自动返修

自动返修是任务级显式开关，绑定 `candidate + draftRev + requirementsRev + sourceRev`；默认关闭，上限 2 次，关闭/撤销/漂移都不退已用次数。每次 tick 在领取前只对“显式开启且最新交付在当前 Run/head 有明确 `changes_requested`”的候选做外部核验；默认关闭、无当前意见或预算耗尽时不做任何远程读取。

1. 核验是只读的：先刷新 Issue 来源（来源变化即撤销策略与授权），再读 PR，要求 `state=open` 且 head 与登记交付一致。存在该候选的任何 merge intent、unknown/未确认进程、整理记录 `starting/running/unconfirmed/unknown`、活动/执行中的 Run、失效授权、缺固定模板、异常读取时跳过，并留下可读阻塞原因（`auto_repair.blocked` 事件 + Candidate.autoRepair.blockedReason）。安全读取必须区分“文件缺失”和“文件存在但不可解析”：merge intent 或 Run control 损坏时失败关闭并给出原因，不能当作不存在；展示层可保持原有缺省行为。
2. 通过核验后由领域 `queueAutoRepair` 原子预留一次预算并入队，再由既有 `claimNext`/prepare/spawn 推进；Runtime 不直接调用 Pi.start。返修 Run 沿用原批准稿、固定模板与执行包，并继续使用 RF001 冻结的原 `changes_requested` 反馈；只有明确记录的验收意见会被消费，控制器不生成设计意见，也不自动合并。
3. 已入队的自动返修可能因并发上限跨 tick 或跨重启等待。每次最终领取前都会重新核验外部 PR/来源/merge intent/unknown 条件；远程读取返回后以及每个同步 `claimNext` 之前，还必须重新执行一次本地安全检查（整理记录、control、merge intent、活动 Run、授权与模板），不能沿用异步等待前的核验结果。`claimNext({autoRepairAllowlist})` 只允许领取当轮仍通过本地检查的自动队列，未核验或漂移的 pending 保持或按原因取消（`cancelAutoRepair`，预算保留、原因与事件可审阅），通用路径不能绕过。缺省调用保持纯领域语义，手动 ready/retry 不受影响。
4. 去抖/背压：外部读取失败或 PR 漂移按 `候选+版本+head` 进入有限指数退避，窗口内不重复请求也不重复写同类事件；已入队但连续读取失败 3 次时取消本次排队（预算不回退），交回人工处理。

## 验收与合并

需求整理、后台 tick、两种验收都不能发合并。只有 merge 方法收到 confirmed=true、当前双角色批准、expectedHeadSha 与实际一致才可发送。用户当前未配置额外监督线程，设计监督在主会话核验后由本地界面记录实际结论，不能伪造角色审批。

发送前持久 merge intent（repo/PR/head/method）。只发送一次；超时、异常、pending、重启均只通过 readPullRequest 核验。MERGED + 有效完整 merge SHA + 同 head 才 recordMerged。再次 merge 请求遇到 intent 时只读核对，不重复发送命令；读回 OPEN 也保持 pending 并解释。HTTP/UI 展示 pending，不能冒充完成。

当合法返修已追加到原 PR、当前结果仍记录旧 head 时，`recordAcceptance`/`merge` 按已登记 head 对比远端而拒绝新 head，这是预期的保护，不放宽。需要维护时使用显式本地命令（不新增 HTTP/UI 入口）：

```bash
node scripts/register-pr-head.mjs --data-dir <已有数据目录> --run-id <id> \
  --from <旧完整SHA> --to <新完整SHA> --evidence <JSON文件> --confirm
# 证据 JSON：{"headSha":"<新完整SHA>","summary":"<独立验收结果及原始证据引用>"}
```

- 只读核对后，把等待验收的同一 Run 的同一 PR 绑定到新 head：校验实时 PR 同 repo/number/open 且 head 正好是 `--to`、Issue 源版本等于 Run sourceRev、`--from` 是 `--to` 的祖先、追加提交（含后来撤销的路径）不超出 Run 固定任务稿的 writeScopes。旧 SHA 不是已登记 head、证据 headSha 不匹配、范围越界、存在合并意图或控制器锁被占用时一律拒绝，不写任何记录。
- Git 核对子进程禁用惰性取回（`GIT_ALLOW_PROTOCOL=''`、`GIT_NO_LAZY_FETCH=1`），只使用本地已有对象：partial clone 缺少 `--to` 等对象时直接拒绝，不接触远程、不写 pack/promisor；已有全部所需对象时仍正常登记。本地仓库必须是完整历史（`rev-parse --is-shallow-repository` 为 false）；浅克隆会被拒绝，操作员需先自行补齐完整历史，命令不自动 fetch。
- 单事务只改 `result.pr.headSha` 与 `updated_at`，并追加一条 `run.head_registered` 审计事件（旧/新 SHA、Run/PR、证据字节 sha256 与摘要）。Worker 原始证据、历史 acceptances、开发授权与候选状态不变。
- 命令不启动 Runtime/调度器，不调用模型，不 fetch/checkout/推送、不建 PR、不合并，也不自动判定验收；新 head 必须按现有验收接口重新双角色验收后才能 `canMerge`，旧批准保留但不再生效。重复用旧 SHA 调用会被拒绝且不重复追加事件。
