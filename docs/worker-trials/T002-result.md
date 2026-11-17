# T002 执行结果：持久化候选、用户授权与并行调度核心

| 字段 | 内容 |
| --- | --- |
| `run_id` | `T002-20261117T152851Z` |
| `attempt` | `1` |
| `requirements_rev` | `sha256:ac18dce11558af6dc7689954bb35743b51767d39e03b0fd500cf64df9486bff7` |
| `template_ref` | `afc957d591b9890127c82d47c1b48b191443b565:templates/development/1.1.0.md` |
| 执行配置 | `PI_PROVIDER=facaiai-deepseek`、`PI_MODEL=deepseek-flash`、`PI_REASONING_LEVEL=high`、`PI_SESSION_ID=01a1ea20-0f45-7761-a96e-b12d8eba0825` |
| 工作目录 | `/Users/linguojin/.codex/worktrees/t002-core/github-first` |
| Git 状态 | 仅新增文件，未修改既有文件，未提交 |

## summary

实现并实际验证了 T002 的领域 Module：

- `src/rules.mjs`：规则规范化、Issue 规范化、稳定 ID、sourceRev、规则求值与中文命中/排除原因。
- `src/store.mjs`：SQLite 建表、`BEGIN IMMEDIATE` 事务、设置/候选/草稿历史/决定/执行/验收/事件持久化。
- `src/workflow.mjs`：`Workflow` 公开 Interface，覆盖设置、收集、任务稿版本、用户决定、资格判断、原子占用、执行绑定、进展、结束、阻塞、重试、双角色验收、合并门槛与事件。
- `test/workflow.test.mjs`：通过公开 Interface 验证正常路径和关键边界，不依赖表结构。

任务稿要求的功能与失败语义均已实现。`npm test` 通过，T001 的 10 项测试保留并继续通过；`npm run check:trial` 的 35 项独立检查也通过。没有阻塞 T002 范围内的未完成项。

## artifacts

- `src/rules.mjs`
- `src/store.mjs`
- `src/workflow.mjs`
- `test/workflow.test.mjs`
- `docs/worker-trials/T002-result.md`
- 本机证据日志（被 `.gitignore` 忽略的 `.auto-ai/`）：
  - `.auto-ai/trials/T002/npm-test.log`
  - `.auto-ai/trials/T002/check-trial.log`
  - `.auto-ai/trials/T002/packet-match.log`
  - `.auto-ai/trials/T002/claim-race.log`

## evidence

| 检查对象 | 命令/方法 | 结果 | 日志入口 |
| --- | --- | --- | --- |
| 全部测试（含 T001 回归） | `npm test` | **passed**：27 项通过，0 失败（T001 10 项 + T002 17 项） | `.auto-ai/trials/T002/npm-test.log` |
| T001 独立检查 | `npm run check:trial` | **passed**：35/35 | `.auto-ai/trials/T002/check-trial.log` |
| 执行包需求摘要一致性 | 用 packet 的 `inputs` 写入草稿，比较 `requirementsRev` | **passed**：与 `sha256:ac18dc…bff7` 完全一致 | `.auto-ai/trials/T002/packet-match.log` |
| 多进程原子占用 | 8 个独立 Node 进程连接同一 SQLite 文件同时 `claimNext()` | **passed**：1 个 `CLAIMED`、7 个 `NULL`，最终仅 1 个 running Run | `.auto-ai/trials/T002/claim-race.log` |
| 规则类别/AND-OR/大小写/PR 排除/空仓库/原因 | `test/workflow.test.mjs` 第 1 项 | **passed** | 同上 |
| 设置默认值、校验、保存与重开 | 第 2 项 | **passed** | 同上 |
| 收集去重、sourceRev 稳定性、命中/排除 | 第 3 项 | **passed** | 同上 |
| 草稿默认值、T001 requirementsRev、筛选不授权 | 第 4 项 | **passed** | 同上 |
| develop/defer/ignore、待决策项、空验收、活动 Run、非法 actor | 第 5 项 | **passed** | 同上 |
| 同内容草稿保持版本/授权，内容变化清除决定与验收 | 第 6 项 | **passed** | 同上 |
| 同优先级按创建次序稳定占用 | 第 7 项 | **passed** | 同上 |
| 优先级、scope 冲突排队、全局/仓库并发 | 第 8–10 项 | **passed** | 同上 |
| 依赖缺失/未完成/跨仓库/循环，阻塞候选不堵其他候选 | 第 11–12 项 | **passed** | 同上 |
| 两个连接原子占用，close/reopen 持久化 | 第 13 项 | **passed** | 同上 |
| 结束不自动完成/合并，双角色验收与 head 匹配 | 第 14 项 | **passed** | 同上 |
| changes_requested、重试后新验收 | 第 15 项 | **passed** | 同上 |
| 旧草稿/旧源内容结果保留但 blocked，不能结项 | 第 16 项 | **passed** | 同上 |
| 绑定、进展、阻塞、重试、事件过滤 | 第 17 项 | **passed** | 同上 |

### 已验证的产品行为

- 规则命中只进入候选池；`saveDraft` 和 `collect` 都不会产生开发授权，只有 `actor=user` 且绑定当前 `draftRev` 的 `develop` 决定能进入 `ready`。
- 草稿内容未变化时重复保存不增加版本、不丢失已有决定；内容变化会递增版本、清除当前决定与验收记录。
- Issue 的 `title/body` 变化会更新 `sourceRev`，使旧草稿失效并清除决定；活动 Run 保留，结束时结果以 `blocked` 保留，不能进入验收或覆盖新草稿。
- 全局/仓库并发上限、同仓独立 scope 并行、同仓相交 scope 排队、跨仓同 scope 独立、缺失/未完成/跨仓依赖、循环依赖拒绝、优先级和稳定次序均按合同工作。
- 同一 SQLite 文件的多连接/多进程占用只会成功一次；`close()` 后重新打开，草稿、决定、Run、阻塞原因和事件仍可恢复。
- Worker 结束只进入 `awaiting_acceptance`；用户与设计监督都显式 `approved` 且 head 与当前 PR head 一致时 `canMerge` 才为真，`recordMerged` 才允许记录外部合并并进入 `completed`。
- 旧 head、缺一方验收、`changes_requested`、已过时结果均无法合并。

### 实现取舍（供主会话复核）

- 草稿 `rev` 使用 64 位十六进制 SHA-256；`requirementsRev` 按 T001 使用 `sha256:<hex>` 前缀，两者用途不同。
- `changes_requested` 保持候选在 `awaiting_acceptance`，但 `canMerge` 立即为假；`retryCandidate` 可从 `blocked` 或该验收返修状态回到 `ready`，重试后的新 Run 必须重新收集双角色验收。
- `writeScopes` 会规范化尾部斜杠、`./` 和重复斜杠；绝对路径、盘符、反斜杠、`..` 越界路径拒绝。
- `finishRun` 的 `artifacts/evidence` 按调用方提供的 JSON 值保存（默认空数组），不把原始日志或工作目录内容写入数据库。
- 更新与事件均在同一 SQLite 事务内提交；索引和表结构属于私有实现，测试只通过公开 Interface 观察。

## blockers

无。T002 范围内没有需要用户决定或外部条件才能继续的阻塞。

## 未验证内容

以下属于后续任务或本次明确排除的范围，**不能**根据本次结果推定已完成：

- GitHub 网络访问、Issue/PR 实际读写、HTTP Interface 和中文前端 UI。
- 真实 Pi Worker 进程启动、停止、进程存活核对和 OS 级阻塞处理。
- 真实 GitHub 合并操作；`recordMerged` 只记录外部已完成的合并。
- 生产级长期运行、SQLite schema 迁移/向后兼容、网络文件系统上的 WAL 行为。
- Windows 路径语义与其他操作系统。
- 真实执行器并发下的 GitHub 限流、重试、凭据与权限检查。

## Next action

主会话按当前提交版本独立复跑 `npm test` 与 `npm run check:trial`，核对 T002 结果后推进 T003：GitHub/Pi Adapter、HTTP Interface、持久进展与恢复；本 Module 不自行合并 PR。
