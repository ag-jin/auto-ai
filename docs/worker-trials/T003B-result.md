# T003B 执行结果：GitHub、版本模板与隔离工作树 Adapter

| 字段 | 内容 |
| --- | --- |
| `run_id` | `T003B-r1-20261117T163304Z` |
| `attempt` | `2` |
| `requirements_rev` | `sha256:9639c7c866b1c6935052678f738c4a9891f3e8b8b97e934cf46cf21339ad45f7` |
| `template_ref` | `c43147fe63b534319789dd86dd8fe39e5e04f557:templates/development/1.2.0.md` |
| 执行配置 | `PI_PROVIDER=facaiai-deepseek`、`PI_MODEL=deepseek-flash`、`PI_REASONING_LEVEL=high`、`PI_SESSION_ID=01a1ea5a-d9be-75cc-856d-d2fd70fb8823` |
| 工作目录 | `/Users/linguojin/.codex/worktrees/t003b-external-adapters/github-first` |
| Git 状态 | r1 仅修改 `src/github-adapter.mjs`、`test/external-adapters.test.mjs`、本结果文件；未提交；未操作真实 PR |

## r1 返修：以实际状态确认合并

主会话用注入 runner 实际复现：`gh pr merge` 返回成功，但随后 `gh pr view --json mergeCommit,state` 返回 `{"state":"OPEN","mergeCommit":null}`，旧实现返回 `{merged:true, mergeSha:null}`，会让上层误记完成。

先加失败回归再修实现，覆盖：

| 场景 | 期望 | 红（修前） | 绿（修后） |
| --- | --- | --- | --- |
| `readPullRequest` 返回 `mergeSha`，缺失/非法为 `null` | 有 SHA 时透出，否则 `null` | failed（未返回该字段） | passed |
| merge 命令成功但读回 `OPEN` | `merged:false, pending:true` | failed（返回 `merged:true`） | passed |
| merge 后读回命令失败 | `merged:false, pending:true`，note 含原因 | failed（返回 `merged:true`） | passed |
| 读回 `MERGED` 但 mergeCommit 缺失/空/非完整 SHA | `merged:false, pending:true, state:'merged'` | failed（返回 `merged:true`） | passed |
| 已合并同 head 且 SHA 有效 | `{merged:true, mergeSha, alreadyMerged:true}` 幂等读回，不调用 merge | failed（报状态拒绝） | passed |
| 已合并但 head 不同 | 拒绝，不调用 merge | failed（报状态拒绝但未区分） | passed |
| 已合并同 head 但 SHA 未知 | `pending:true`，不调用 merge | failed（报状态拒绝） | passed |

修后行为：

| 合并后读回 | 返回 |
| --- | --- |
| `state=MERGED` 且有完整 40/64 位十六进制 merge SHA | `{merged:true, mergeSha}` |
| `state=MERGED` 但 SHA 缺失或格式无效 | `{merged:false, pending:true, state:'merged', mergeSha:null, note}` |
| `OPEN`/`CLOSED`/未知状态 | `{merged:false, pending:true, state, mergeSha:null, note}` |
| 读回命令失败或 JSON 非法 | `{merged:false, pending:true, state:'unknown', mergeSha:null, note}` |

- 读回未确认时不自动重发 merge，也不把状态写成完成；调用方可用 `readPullRequest` 的 `mergeSha` 做重启后的只读核对。
- 原有边界保留：未确认拒绝、method 仅 `merge|squash|rebase`、head 不一致拒绝、`--match-head-commit`、不 `--admin`、不 `--delete-branch`、closed 未合并拒绝。
- 范围只动 `src/github-adapter.mjs`、`test/external-adapters.test.mjs` 和本文件；Workspace/模板 Adapter、包版本与其余测试未改。

## summary

实现并实际验证了三个外部接缝：

- `src/github-adapter.mjs`：`checkReady`、分页收集与 Issue 归一化、现有 PR 去重创建、PR 读回与检查摘要、显式确认且 head 匹配后才合并。r1 起只有在合并后实际读回 `state=MERGED` 且 merge SHA 完整时才报成功；读回 OPEN、无 SHA 或失败均返回 `pending`。所有 `gh` 调用使用 `execFile`/argv，测试通过注入 runner 仿真，未访问真实 GitHub。
- `src/workspace-adapter.mjs`：真实 Git worktree 创建与 manifest、源仓库 fetch/push 身份核对、detached HEAD 的 baseBranch 门槛、变更检查与 writeScopes、非 force add/commit/push、重入与归档。真实临时仓库测试使用隔离的全局 Git 配置，不修改用户配置。
- `src/template-adapter.mjs`：固定 commit 读取 catalog 与模板，校验 YAML、schema_version、id/version/路径，工作区未提交内容不参与读取。
- `test/external-adapters.test.mjs`：新增 21 项业务测试；r1 再增 6 项合并确认回归，共 27 项。`npm test` 连同既有检查共 54 项全部通过。

T003B 范围内没有未完成项或需要用户决定的阻塞。

## artifacts

- `src/github-adapter.mjs`
- `src/workspace-adapter.mjs`
- `src/template-adapter.mjs`
- `test/external-adapters.test.mjs`
- `package.json`（仅新增运行时依赖 `yaml@2.9.1`）
- `package-lock.json`（新增，锁定 `yaml@2.9.1`）
- `docs/worker-trials/T003B-result.md`
- 本机证据日志（被 `.gitignore` 忽略的 `.auto-ai/`）：
  - `.auto-ai/trials/T003B/npm-test.log`
  - `.auto-ai/trials/T003B/external-adapters.log`
  - `.auto-ai/trials/T003B/check-trial.log`
  - `.auto-ai/trials/T003B/red-r1.log`（修前 21 pass / 6 fail）
  - `.auto-ai/trials/T003B/green-r1.log`（修后 27/27）
  - `.auto-ai/trials/T003B/npm-test-r1.log`（54/54）
  - `.auto-ai/trials/T003B/check-trial-r1.log`（35/35）

没有提交 Git，也没有创建、更新、合并真实 PR。

## evidence

| 检查对象 | 命令/方法 | 结果 | 日志入口 |
| --- | --- | --- | --- |
| 全部测试（新增 + 既有） | `npm test` | **passed**：48 项通过，0 失败 | `.auto-ai/trials/T003B/npm-test.log` |
| T003B 专项测试 | `node --test test/external-adapters.test.mjs` | **passed**：21 项通过，0 失败 | `.auto-ai/trials/T003B/external-adapters.log` |
| r1 先红后绿 | 先加 6 项失败回归，再修 `mergePullRequest`/`readPullRequest` | **passed**：修前 21 pass / 6 fail，修后 27/27 | `.auto-ai/trials/T003B/red-r1.log`、`green-r1.log` |
| r1 全量回归 | `npm test` | **passed**：54 项通过，0 失败 | `.auto-ai/trials/T003B/npm-test-r1.log` |
| r1 既有独立检查 | `npm run check:trial` | **passed**：35/35 | `.auto-ai/trials/T003B/check-trial-r1.log` |
| T001 既有独立检查 | `npm run check:trial` | **passed**：35/35 | `.auto-ai/trials/T003B/check-trial.log` |
| 依赖元数据 | `npm view yaml@2.9.1 version engines`；读取 `package-lock.json` | **passed**：`2.9.1`，`node >= 14.6`，锁定 integrity | `package-lock.json` |

### GitHubAdapter（runner 仿真）

| 对象 | 覆盖内容 | 结果 |
| --- | --- | --- |
| `collectIssues` | 严格 `owner/repo`、`state` 校验、`--paginate --slurp`、多页拍平、字段归一化、`labels/user` 转换、`isPullRequest` 保留 | passed |
| 收集失败 | runner 非零、空 stdout、非法 JSON 均明确 reject，不返回空数组冒充成功 | passed |
| `checkReady` | 成功返回 ready；失败返回原因，测试确认 `ghp_...` 凭据不会出现在结果中 | passed |
| `createPullRequest` | 同 repo/branch/base 的 open PR 去重；新建时使用临时 `--body-file`，读回 number/url/headSha；无 merge 调用 | passed |
| `readPullRequest` | state 归一化、`mergeable` 缺失保留 `UNKNOWN`、检查结论/状态原样摘要，未知状态保留 `unknown` | passed |
| `mergePullRequest` | 未确认、非法 method、head 改变、已关闭 PR 均不调用 merge；head 一致时带 `--match-head-commit` 调用 `gh pr merge` 并读回 merge SHA | passed |

### WorkspaceAdapter（真实临时 Git 仓库）

| 对象 | 覆盖内容 | 结果 |
| --- | --- | --- |
| `create` 隔离 | 源仓库未提交改动保持；worktree 从固定 commit 创建；分支与目录含 runId；manifest 持久化；同 runId 一致重入返回原工作树 | passed |
| 身份与冲突 | 请求仓库与 origin fetch/push 不一致拒绝；detached HEAD 无 `baseBranch` 拒绝，显式 `baseBranch` 成功；已有任务分支、已有目录、manifest/实际分支不一致均拒绝 | passed |
| `inspect` | tracked 修改与全部 untracked 文件；路径含空格；`dirty` 与 `headSha` | passed |
| writeScopes | 超范围拒绝且不 add、保留现场；父路径涵盖子文件；合法后真实 add/commit/push，远端 head 与本地一致 | passed |
| shell 元字符 | 文件名含 `;`、`$()`、空格时按数据处理，不执行 shell，文件内容与提交正常 | passed |
| origin 变化 | 创建后源仓库 fetch/push 身份变化时拒绝提交，HEAD 与暂存区保持不变 | passed |
| 无变更/重入 | 干净工作树明确返回既有提交且不建空提交；已提交未推送的重入会推送既有提交，不重复提交 | passed |
| `archive` | head 不匹配、脏目录、未推送、无 manifest 均保留并给原因；已确认干净且远端包含 head 后非 force 移除，分支引用保留 | passed |

### 模板读取

| 对象 | 覆盖内容 | 结果 |
| --- | --- | --- |
| commit 固定 | 一次解析 commit 后读取 catalog 与模板；工作区未提交的新 catalog/模板不影响 HEAD 读取；旧 commit 的默认模板不随新版变化 | passed |
| catalog/list | 当前 catalog 的模板信息数组；旧 commit 与 HEAD 分别返回对应版本 | passed |
| 拒绝条件 | YAML 非法、重复键、缺版本、模板 id 与 catalog 不一致、路径越界、catalog 路径与 id/版本不一致、未知 id | passed |

### 实际产品行为

- GitHub 收集只返回成功解析的数据；分页与字段转换在 runner 层可观察。所有失败路径均抛错，不伪造空成功。
- PR 创建先查重；只有 `confirmed=true`、method 合法、远端仍 open 且 head 与 `expectedHeadSha` 一致时才执行合并。
- 工作树创建不触碰源仓库工作区；任务分支从固定基线 commit 建立。所有 Git 外部命令走 argv，不经过 shell。
- `commitAndPush` 在 add 之前检查全部变更路径与 `writeScopes`；超范围直接拒绝，HEAD 和暂存区保持不变。
- 归档只移除 manifest 所属、head 匹配、远端已包含且工作树干净的工作树；不使用 `--force`，分支引用保留。
- 模板与 catalog 均从同一 commit 的 Git blob 读取，文本不做重写。

## 实现限制

- 真实 GitHub 网络、`gh` 认证权限、实际分页响应结构和 PR 合并均未执行；测试使用注入 runner 仿真。合并结果只在实际读回 `MERGED` + 完整 merge SHA 时记为成功；读回 OPEN、SHA 缺失或读回失败均返回 `pending`。rebase 等场景 GitHub 可能不返回 `mergeCommit`，此时同样为 `pending`，不编造 SHA。
- `gh pr merge` 本身报错（非读回失败）仍直接抛错，不自动读回确认；也未实现自动重试、轮询或事后补发。合并命令已发出但读回 `OPEN`/失败时，只由调用方后续用 `readPullRequest` 只读核对，不重复发送 merge。
- 本地临时仓库的 origin 身份解析支持 ssh/scp/https/file 和本地路径；本地路径按最后两段 `owner/repo` 比对，属于测试与本地镜像场景的约定，不等同于远端账号鉴权。
- 工作树测试通过 `GIT_CONFIG_GLOBAL=/dev/null`、`GIT_CONFIG_NOSYSTEM=1` 隔离全局配置，并在临时仓库写入本地身份；Adapter 自身不写 Git 配置。真实用户身份与凭据由现有环境提供，未在测试中探测。
- `commitAndPush` 对异常大变更的限制为 2000 个路径、单文件 50 MiB；未做总字节数或仓库缓存规则的可配置化。
- `create` 在 manifest 已存在时以 manifest 固定基线为准；若调用方再次传入移动后的 `baseRef`，不会改写原基线。显式传入不同 `baseBranch` 会报冲突。
- `archive` 在远端已有更新提交但本地缺少对应对象时无法证明祖先关系，会保守保留现场。
- 未实现 HTTP Interface、调度循环、Pi 进程、UI 联调；这些不属于 T003B 范围。
- 未测试 Windows 路径语义、并发创建同一 runId 的竞争、真实 GitHub 限流与重试。

## 未验证内容

以下内容**不能**根据本次结果推定已完成：

- 真实 GitHub Issue 收集、PR 创建/更新/合并和网络故障恢复。
- 真实 push 到 GitHub 的认证、保护分支、required checks 与权限行为。
- 生产配置中的 Git 身份、凭据和远端仓库实际状态。
- HTTP、自动 Worker 调度、Pi 启动/取消/恢复与 UI 联调。
- Windows、非 ASCII 路径极值、超长路径与超大仓库性能。

## blockers

无。T003B 范围内没有需要用户决定或外部条件才能继续的阻塞。

## 状态汇总

- `passed`：`npm test` 54/54；T003B 专项 27/27；`npm run check:trial` 35/35；r1 回归真实由 6 项失败转为全部通过。
- `failed`：无。
- `not_run`：真实 GitHub 网络与 PR 合并、真实生产 push 凭据、HTTP/调度/Pi/UI 集成。

## Next action

主会话独立复跑 `npm test` 与 `npm run check:trial`，核对 red-r1/green-r1 日志与当前代码版本；确认后由主会话提交并集成，执行线程不自行合并 PR。
