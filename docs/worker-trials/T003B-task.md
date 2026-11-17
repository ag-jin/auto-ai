# T003B：GitHub、版本模板与隔离工作树 Adapter

Pi，deepseek-flash / high，在独立 worktree 开发。先读 AGENTS/CONTEXT_CARD。目标是后端的外部接缝，不实现 HTTP、调度循环、Pi 进程或 UI。

## 允许范围

新增 `src/github-adapter.mjs`、`src/workspace-adapter.mjs`、`src/template-adapter.mjs`、`test/external-adapters.test.mjs`、`docs/worker-trials/T003B-result.md`。允许 package.json/package-lock.json 加入唯一运行时依赖 `yaml@2.9.1`（已查官方 npm 元数据，Node >=14.6），用于标准 YAML，不自造 YAML 解析器。生产 Git 配置、凭据与既有源码保持不变；主会话提交和集成。

所有外部命令使用 execFile/argv，不经 shell。默认 runner 返回 Promise `{stdout,stderr}`，非零 reject；各 Adapter 构造参数允许注入 `run(command,args,options)`，测试替身可拦截网络/push。真实 Git 临时仓库测试不能修改用户全局配置。

## GitHubAdapter

`new GitHubAdapter({command='gh',run})`，公开 async 方法：

- `checkReady()` → `{ready,reason}`，不输出凭据。
- `collectIssues(repo,{state='all'}={})` → 归一化 Issue 数组，字段与 T002/HTTP_CONTRACT 一致。支持分页，保留 isPullRequest 标识供规则排除，labels/user 从 GitHub 原始结构转换。repo 严格校验 owner/repo。异常明确失败，不用空数据冒充成功。
- `createPullRequest({repo,branch,baseBranch,title,body,worktreePath})` → `{repo,number,url,headSha}`。先查同 repo/branch/base 的现有 open PR，已存在则返回；否则通过 body 临时文件创建。方法只创建 PR，不合并。
- `readPullRequest({repo,number})` → `{repo,number,url,headSha,state,mergeable,checks}`。checks 可保留实际检查摘要，未知状态明确保留，不编造成功。
- `mergePullRequest({repo,number,expectedHeadSha,method,confirmed})` → `{merged,mergeSha}`。confirmed 必须 true，method 仅 merge/squash/rebase；先读取远端 head，与 expected 完全一致且仍 open 才调用 `gh pr merge`，带 match-head-commit。两种验收由核心/HTTP 调用方检查。本任务测试不得执行真实合并。

## WorkspaceAdapter

`new WorkspaceAdapter({rootDir,run})`，公开 async 方法：

- `create({repo,localPath,baseRef='HEAD',runId})` → `{repo,runId,branch,worktreePath,baseCommit,baseBranch}`。
- `inspect({worktreePath})` → `{paths,dirty,headSha}`，包含 tracked 与全部 untracked 文件，正确处理含空格的路径。
- `commitAndPush({repo,worktreePath,branch,baseCommit,writeScopes,summary})` → `{headSha,paths}`。
- `archive({repo,localPath,worktreePath,branch,headSha})` → `{removed,reason}`。

要求：

1. create 核对源仓库和 origin 的 fetch/push 仓库身份均对应 repo；不能串仓。source 本地修改保持原样，baseRef 固定为 commit，独立任务分支与 worktree 名包含安全 runId；不能覆盖已有分支或目录。HEAD 来源为 detached 时应要求明确的可用于 PR 的 baseBranch，而不是猜测。
2. 为 worktree 持久保存 manifest（rootDir 下），绑定 repo、runId、路径、分支、基线。相同 runId 重入仅在 manifest/实际状态全部一致时返回原工作树，其他冲突报错。
3. commitAndPush 先核对 repo/branch/manifest，检查全部变更均处于 writeScopes（`*` 或规范相对路径，父路径涵盖子文件）。超范围拒绝，保留现场；不能先 add 再检查。shell 元字符当数据处理。不存在有效变更时清楚返回既有提交或报“无变更”，不能空造实现。
4. 实际 add/commit/push 使用现有 Git 身份与认证；不改用户 Git 配置，不 reset/rebase/clean 或 force-push。重入已经提交/推送的同一次交付应安全，不重复创建空提交。限制异常大变更并给出可检查原因，避免误提交缓存。
5. archive 只删除 manifest 所属且已确认推送、无未提交/未跟踪修改的 worktree。先确认分支 head 与参数匹配且远端已包含该 head；不能 force remove。未知、未推送、脏目录保留并说明原因。代码与证据保存后及时回收，分支引用可保留。

## 模板读取

模板来自 auto-ai 应用仓库，不要求每个目标仓库安装模板。

导出 `resolveTemplate({repoDir,ref='HEAD',id})` → `{commit,path,id,version,text,templateRef}`，以及 `listTemplates({repoDir,ref='HEAD'})` → 当前 catalog 的模板信息数组。

一次解析固定 commit，再从该 commit 读取 catalog 和模板；校验 schema_version、id/version/路径与内容一致。仅接受 templates/ 下规范相对 md 路径；YAML 非法、重复键、缺失 id/版本或 catalog 指向不匹配均报错。文本原样保留，工作区未提交改动不参与读取。旧 ref 的默认模板不随新版 catalog 改变。

## 验收

实际运行 `npm test`，保留所有既有检查。至少覆盖：GitHub 参数/分页/归一化/失败、已有 PR 去重、未确认合并与 head 改变不调用 merge；真实临时 Git 仓库的隔离、路径含空格、未提交源改动保持、scope 拒绝、同 run 恢复、串仓/同分支目录冲突、推送后干净工作树回收和脏目录保留；旧 commit 模板/catalog 固定、工作区变更隔离、非法 YAML/路径/元数据拒绝。

外部 push/gh 网络可以通过注入 runner 仿真，但要说明与真实网络验证的差别，不测试或合并真实 PR。结果使用仓库相对路径；记录实现限制和未验证项，不复制个人配置或密钥。无需提交 Git。
