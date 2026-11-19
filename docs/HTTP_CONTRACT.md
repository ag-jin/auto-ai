# 本地工作台 HTTP 合同 v1

此合同用于并行实施后端和前端。目标是当前已确认的系统建设，接口不能绕过用户的开发确认和最终验收。服务仅绑定 loopback，JSON 写操作校验同源与本地会话令牌；Worker 不获得工作台的操作令牌。

## 状态响应

`GET /api/state` 返回：

```js
{
  settings: {
    repositories: [{ repo: 'owner/repo', localPath: '/local/path', baseRef: 'HEAD' }],
    rules: { repositories: [], labels: [], authors: [], keywords: [], states: ['open'] },
    concurrency: { global: 2, perRepo: 2 }
  },
  candidates: [], runs: [], events: [], templates: [], templateListError: null,
  runtime: { watching: false, intervalSeconds: 60, lastPollAt: null, activeDrafts: [] },
  capabilities: { githubReady: false, piReady: false },
  csrfToken: '<local-session-token>'
}
```

`templates` 只包含可执行的 worker 模板，每项为 `{id,version,role:'worker',description,path,templateRef,commit}`。draft 角色的 requirements 整理模板不提供给前端选择，develop 入口也会拒绝 draft 模板。

`templateListError` 为 null 表示模板列表已完整枚举，包括正常的空列表；固定 commit 的 catalog 无法解析（错误信息含 catalog/YAML）或模板对象读取失败（信息含模板相对路径与读取原因）时为原因字符串，此时 `templates` 为 `[]` 且其余状态字段照常可读。只有明确的条目级配置错误（非法路径、非法元数据或角色、固定 commit 树中确认不存在的路径）会被单独跳过，不设置 `templateListError`；Git 读取失败或未知异常不被当作条目错误。

Candidate DTO：

```js
{
  id: 'owner/repo#123',
  issue: { repo, number, title, body, state, author, labels, updatedAt, url },
  filter: { matched: true, reasons: ['...'] },
  state: 'awaiting_decision',
  draft: {
    version: 1, rev: '<opaque-current-revision>', requirementsRev: 'sha256:...',
    templateId: 'development', goal: '...', scope: '...', acceptance: ['...'],
    context: '...', pendingDecisions: [], writeScopes: ['*'], dependsOn: [], priority: 0
  },
  decision: null, activeRunId: null,
  eligibility: { eligible: false, reasons: ['尚未确认开发'] },
  reviews: { user: null, design: null },
  latestResult: null, mergePending: false,
  createdAt, updatedAt
}
```

draft 可为 null。review 非空时包含 `{verdict,headSha,comment,at}`。latestResult 为 `{summary,artifacts,evidence,pr}`，pr 可空或 `{repo,number,url,headSha}`。

Run DTO 至少包含 `{id,candidateId,repo,issueRef,draftRev,requirementsRev,status,phase,templateRef,branch,worktreePath,result,blockedReason,createdAt,updatedAt}`。状态 running/blocked/awaiting_acceptance/completed；phase 表示准备、执行、检查、提交 PR 等当前阶段。

Candidate 状态：candidate、drafting、awaiting_decision、deferred、ignored、ready、running、blocked、awaiting_acceptance、completed。前端按中文含义展示，未知状态原样作为待识别状态展示，不能默认为成功。

Event 为 `{id,at,kind,message,candidateId,runId,repo,data}`。只展示必要的进展与证据，不注入完整模型推理或凭据。

## 读写约定

写请求使用 `Content-Type: application/json` 与 `X-Auto-AI-Token: csrfToken`；令牌来自同源 state 响应，前端只保存在内存。成功返回 JSON 对象；失败返回相应 HTTP 状态及 `{error:{code,message,details}}`，409 表示版本/状态冲突。

所有 ID 路径参数使用 `encodeURIComponent`。前端在写成功后刷新 state；轮询不能覆盖未保存的表单。后端根据持久化版本和决定判断，不能相信前端按钮的禁用状态。

| 路径 | 请求与结果 |
| --- | --- |
| `PUT /api/settings` | 完整 settings，返回有效 settings |
| `POST /api/collect` | `{}`，启动一次收集，返回 `{started:true}`；各仓库失败分别留事件，不使其他仓库失去处理机会 |
| `POST /api/runtime/watch` | `{enabled,intervalSeconds}`，仅应用内监督循环；返回 runtime |
| `POST /api/candidates/:id/draft` | `{}`，安排只读需求整理；不触发开发 |
| `PUT /api/candidates/:id/draft` | 完整 Draft 输入字段及当前 `rev`（首次 null），CAS 冲突返回 409，成功返回新 Candidate |
| `POST /api/candidates/:id/decision` | `{action:'develop'|'defer'|'ignore',draftRev}`；actor 由服务端固定为 user。无稿时可暂缓/忽略并省略 draftRev；develop 严格匹配当前稿 |
| `POST /api/candidates/:id/retry` | `{}`，仅在当前开发授权仍有效且原执行已终止时重新入队 |
| `POST /api/runs/:id/cancel` | `{}`，请求并确认进程停止后记入阻塞，保留工作目录 |
| `POST /api/candidates/:id/acceptance` | `{role:'user'|'design',verdict:'approved'|'changes_requested',headSha,comment}`，记录对应角色对指定提交的验收；设计验收 comment 需给出监督结论或引用 |
| `POST /api/candidates/:id/merge` | `{expectedHeadSha,confirmed:true,method:'merge'|'squash'|'rebase'}`；核对两种验收与 GitHub 当前 head 后才执行。实际 MERGED + 完整 SHA 返回 `{merged:true,mergeSha}`；未确认结果返回 `{merged:false,pending:true,note}`，后台只读核对，不重复发送。state 中 Candidate.mergePending=true |

develop 成功后由监督循环自动领取，不要求用户再次点击派发。需求版本变化清除旧授权；有待决策项或空验收的任务稿不能批准。合并始终是独立的用户操作，不因检查通过、两种验收存在或后台循环运行而自动发生。

## 多仓库与调度

规则可以覆盖已配置的多个仓库。标签、作者与关键词列表内 OR，不同类别 AND；状态 open/closed；repo/标签/作者/关键词不区分大小写。去重按 repo#number。展示所有观测，包括被排除项的原因。

优先级越高越先安排；相同优先级保持稳定顺序。依赖以完整 repo#number 显式记录，跨仓库同样适用。writeScopes 为相对路径列表；`*` 与任何同仓任务冲突，父子路径冲突。同仓不同路径可在全局与仓库并发上限内运行。

每个开发 Run 建立独立 Pi 会话、worktree 和任务分支。产物与 PR 仓库必须等于 Run 仓库。完成后先保存改动与证据并推送 PR，再回收可安全移除的工作树；未提交、未知或失败现场保留，给出具体原因。

## 初始与错误状态

生产 UI 不生成假任务和假完成数据。初始无配置时指引添加仓库、设置规则；GitHub/Pi 不可用时展示具体阻塞。数据源需要通过 Adapter 注入，测试用替身不得自动替代生产失败。

验收按钮记录对应角色的明确结论。此版本是单人本地工作台，不宣称已实现多用户身份认证；最终验收仍需由用户和指定设计监督给出实际结论。
