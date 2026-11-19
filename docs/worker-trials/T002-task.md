# T002：持久化候选、用户授权与并行调度核心

执行者：Pi，`deepseek-flash / high`。任务稿版本 1。使用当前独立 worktree，先读 AGENTS.md、CONTEXT_CARD 与执行包。交付可独立测试的领域 Module，不实现 HTTP、前端、GitHub 网络访问或实际进程执行。

## 范围与技术

Node.js 22+，内置 `node:sqlite` 已在本机实测可用。允许新增 `src/rules.mjs`、`src/store.mjs`（可选私有持久化）、`src/workflow.mjs`、`test/workflow.test.mjs`、`docs/worker-trials/T002-result.md`。不修改既有文件或 Git 历史。主会话负责提交、集成和推送。

入口为 `src/workflow.mjs` 的 `Workflow` class。使用真实 SQLite 文件持久化规则、候选、任务稿版本、用户决定、执行尝试、验收与事件；测试通过公开 Interface，不依赖表结构。原始日志和工作目录内容不进入数据库。

## 数据合同

Issue 输入：`{repo,number,title,body,state,author,labels,updatedAt,url,isPullRequest}`。repo 为 owner/repo，number 为正整数，state 为 open/closed，author 为 login 字符串，labels 为字符串数组。稳定 ID 为小写 `repo#number`。

Settings：`{repositories: [{repo,localPath,baseRef}], rules: {repositories,labels,authors,keywords,states}, concurrency: {global,perRepo}}`。初始 repositories 为空，rules 各列表为空但 states 默认为 `["open"]`，并发默认 global=2、perRepo=2。空仓库规则不匹配任何 Issue；其余空类别不限制。正整数并发上限。

规则各类别之间 AND，同一类别内 OR；repo、标签、作者、关键词均不区分大小写，关键词查 title/body；PR 排除。每次评估返回 `{matched,reasons}`，reasons 为非空中文解释数组，命中和排除都解释原因。公开导出 `normalizeRules(rules)`、`evaluateIssue(issue,rules)` 于 rules.mjs。

Candidate 对象至少包含：`{id,issue,sourceRev,filter:{matched,reasons},state,draft,decision,activeRunId,createdAt,updatedAt}`。sourceRev 只依据 title/body 内容变化，不因 updatedAt 或无关字段改变。

Draft 输入：`{templateId,goal,scope,acceptance,context,pendingDecisions,writeScopes,dependsOn,priority}`。

- templateId 默认 development。goal 非空字符串；scope/context 默认空串；acceptance 为字符串数组（草稿可空，但不能批准开发）；pendingDecisions 为字符串数组，默认空。
- writeScopes 默认 `["*"]`，或仓库内相对路径数组；路径不得越界。`*` 代表整个仓库。路径相同或一方为另一方的目录前缀即冲突；兄弟路径独立。同仓冲突需排队，不同仓不冲突。
- dependsOn 为完整候选 ID 数组，支持跨仓库。缺失或尚未 completed 的依赖排队；保存草稿时拒绝已知循环依赖。
- priority 为安全整数，默认 0，越大越先安排；同优先级稳定按创建次序。
- 字符串 trim。规范化后生成 `version`（内容变化递增）与 `rev`（完整规范化草稿的 SHA-256）。相同有效草稿不增加版本，不丢失已有决定。
- 另外输出 `requirementsRev`：按 T001 定义对 `{goal,acceptance,scope,context}` 的固定顺序 JSON 计算摘要，便于核对执行包。

Decision：`{action,draftRev,actor,at}`。action 为 develop/defer/ignore。actor 只能为 user；draftRev 必须与当前草稿完全一致。

Run 至少包含：`{id,candidateId,repo,issueRef,draftRev,requirementsRev,draftSnapshot,status,phase,templateRef,branch,worktreePath,result,createdAt,updatedAt}`。ID 唯一。绑定执行信息后保留模板、分支、工作目录和运行标识，不能被其他仓库或任务结果覆盖。

## 公开 Interface

构造：`new Workflow({dbPath})`；支持 `:memory:` 与文件路径，自动创建父目录；`close()`。

1. `getSettings()` / `saveSettings(settings)`：保存并返回有效配置，校验格式与上限。
2. `collect(issues)`：按规则评估并去重，保存所有观测及原因，返回候选数组。`listCandidates({repo,includeExcluded=true}={})` / `getCandidate(id)`。
3. `saveDraft(id,input)`：返回新 Candidate。首次形成草稿后进入 awaiting_decision；内容改变则清除旧决定与验收。有效源内容变化也使旧草稿/决定失效。活动 Run 仍保留，旧结果不得覆盖新需求。
4. `decide(id,{action,draftRev,actor})`：develop 进入 ready，defer 进入 deferred，ignore 进入 ignored。无草稿、空验收、待决策项未空、非用户决定或旧版本批准均拒绝。活动开发未结束时拒绝重新批准。
5. `eligibility(id)` → `{eligible,reasons}`：检查命中、ready、当前有效 develop 决定、依赖、全局/仓库上限和活动 Run 的 writeScopes 冲突。返回中文排队原因。
6. `claimNext()` → Run 或 null：按优先级与稳定次序寻找可执行候选，在同一数据库事务中重新核验并占用，Candidate 进入 running，Run.status=running、phase=claimed。多个 Workflow 实例同时连接时同一任务只能占用一次。一个阻塞候选不妨碍选择其他候选。
7. `bindExecution(runId,{templateRef,branch,worktreePath,pid,sessionId})`：检查当前授权仍有效后绑定实际执行信息。仓库与 Issue 身份取自已占用 Candidate；旧版本绑定拒绝。
8. `recordProgress(runId,{phase,message})`：记录进展与持久事件。`listRuns({repo}={})` / `getRun(id)`。
9. `finishRun(runId,{summary,artifacts,evidence,pr})`：正常结果进入 awaiting_acceptance，不能自行完成。pr 可空，或 `{repo,number,url,headSha}`，repo 必须与 Run 相同；过时结果保留但标记 blocked，不能结项或覆盖新稿。
10. `blockRun(runId,reason)`：保留运行信息与原因，将已停止/未启动的尝试标记 blocked，Candidate blocked。进程是否确实停止由后续 Adapter 负责，本 Module 不操作 OS。
11. `retryCandidate(id)`：只有原 develop 授权仍与当前草稿一致、没有活动 Run 时才能回到 ready；不能绕过新需求的批准。
12. `recordAcceptance(id,{role,verdict,headSha,comment})`：role 为 user/design，verdict 为 approved/changes_requested。结果与当前任务稿、PR head 对应才能接受。保留两种角色的独立记录与事件。
13. `canMerge(id,{headSha})` → `{allowed,reasons}`：仅当前任务结果、有效开发授权、两个角色均 approved 且都对应当前 PR head 时为真；从不执行合并。
14. `recordMerged(id,{headSha,mergeSha})`：再次核验 canMerge，记录已完成的外部合并并进入 completed。调用本方法不操作 GitHub；实际合并由后续 Adapter 在用户明确操作后执行。
15. `listEvents({after=0,limit=200,candidateId,runId,repo}={})`：返回递增 ID 的 `{id,at,kind,message,candidateId,runId,repo,data}` 事件数组，供 UI 展示与恢复。

其他状态包括 candidate、awaiting_decision、deferred、ignored、ready、running、blocked、awaiting_acceptance、completed。对不存在 ID、无效状态操作或无效数据给出可读错误。更新及事件应在同一事务中完成，避免中断后只保存一半。实现可添加私有 helper，公开合同保持一致。

## 必须实际验证

- 规则各类别、组合、大小写、PR 排除、空仓库配置与命中/排除原因；同一 Issue 重复收集不重复建任务。
- 匹配 Issue 和形成草稿均不会得到开发授权；develop/defer/ignore、旧版本批准、待决策项和非法 actor。
- 草稿同内容保存保持版本/授权，变更需求后原授权和结果失效。
- 全局/仓库并发上限、同仓独立 scopes 可并行、相交 scopes 排队、缺失/未完成/跨仓库依赖、循环拒绝、优先级、阻塞候选不堵其他候选。
- 两个连接原子 claim；close/reopen 后草稿、决定、Run、阻塞原因和事件仍在。
- Worker 结束不自动完成/合并；两个角色验收与当前 head 的匹配；旧 head、缺一方或要求返修时禁止合并。
- 运行 `npm test`，保留 T001 测试。写 T002-result，区分实际通过与未验证内容；无需 Git 提交。
