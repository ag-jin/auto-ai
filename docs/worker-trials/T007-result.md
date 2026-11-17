# T007 结果：需求整理方法纳入版本化模板

> 监督返修已完成（2026-11-18，attempt 2）：首轮真实 Pi 复核复现启动竞态——draft 记录先写 `running`，Pi.start 尚在等待进程身份时 tick 先调 status 得到 unknown；实际 Pi 随后 completed，Runtime 却永久不接管。本轮在既有 Runtime 范围修复：整理记录先写 `starting`，只有 Pi.start 返回后才转 `running` 并接受轮询；中断在 `starting` 的记录在重启时按同一 task id 只读核对 Pi 现场后接管或明确失败，绝不重新调用模型。复现（红）与修复后（绿）、全量回归和真实 Pi 隔离闭环均已实际运行，日志与完整 Pi 记录保存在中央目录 `.auto-ai/validation/T007/`。
>
> 首轮本工作树内的 runtime-live 证据已随回收丢失，不再引用；本文件下方“实际检查”只引用中央目录内可读取的日志。首轮失败现场仍保存在中央 `independent-start-race/`。

- run_id：`run-a5500446-44b8-4b27-9238-6b844132e932`（首轮 `run-01a73750-61af-414e-9407-d286c7b03af4`）
- attempt：2
- template_ref：`d5993e36f42d64ea05e7807820f0bf022abe0b61:templates/development/1.2.0.md`
- requirements_rev：`sha256:a0ef7b417f1dee351d7c06e2fb87cd15ab22417ddfca5eb2c9ea6458fb5acb4d`
- 开工基线：`d5993e3`；任务分支：`auto-ai/run-a5500446-44b8-4b27-9238-6b844132e932`
- 首轮提交：`80b3447`、`b762697`；返修回红：`835e638`；返修提交：见本分支后续 commit
- 任务稿：`docs/worker-trials/T007-task.md` v1（用户已批准，见 `T007-approval.md`）

## 交付内容

1. `src/template-adapter.mjs`
   - 模板 frontmatter 支持 `role`，缺省为 `worker`；只允许 `worker` / `draft`。
   - catalog 条目可选 `role`，出现时必须与模板 frontmatter 一致。
   - `resolveTemplate` 新增 `expectedRole`，按固定 commit 校验 id、role、version、path；`listTemplates` 返回 role 并可按 role 过滤。
2. `templates/requirements/1.0.0.md` 与 `templates/catalog.yml`
   - 迁移原有已实测整理规则、严格 JSON 输出合同和实质待决策定义。
   - requirements 模板固定 `role: draft`；development/research 旧模板无需修改即为 worker。
3. `src/runtime.mjs`
   - `requestDraft` 在调用模型前从固定 commit 解析 requirements 模板，持久记录 `promptRef`、模板 id/version/role/commit/path 和最终 `promptText`。
   - 在途、重启接管和同稿 retry 使用记录中的旧引用/文本；新请求才解析新的默认版本。
   - 模板缺失、非法或 role 不符时不创建 Pi 任务、不调用模型，写入具体 `failed` 记录与 `draft.template_unavailable` 事件；显式 `requestDraft` 可在修复后重试，不自动重试同源失败。
   - 删除 `#draftPrompt` 硬编码方法，无静默回退。
   - `develop` 只接受 `role=worker` 模板，draft 模板返回 400；`state.templates` 只列 worker 模板。
   - 原有 sourceRev、任务稿 CAS、用户决定快照、严格 JSON 和迟到结果保护保持不变；旧整理记录缺少新字段时仍按 taskId 保守接管。
4. 合同与测试
   - `docs/RUNTIME_CONTRACT.md`、`docs/HTTP_CONTRACT.md` 记录模板 role、固定引用/提示文本和入口限制。
   - 新增真实临时 Git 仓库 fixture 的模板 role 与 requirements 测试，不依赖工作区未提交模板。
5. 启动竞态返修（attempt 2）
   - `requestDraft` 先持久化 `state=starting`，`Pi.start` 返回后才写回 `running`；`#advanceDrafts` 只轮询 `running`，`starting` 期间 tick 不再读到假 unknown。
   - 并发的 `requestDraft`、`activeDraftIds` 和重启恢复都按 `starting|running` 视为在途，启动与监督共用同一 task id。
   - 重启时发现 `starting` 记录：按同一 task id 只读 `pi.status`，存在则接管为 `running` 并记 `draft.recovered`；缺失或读取失败则记具体 `failed` 阻塞，不重新调用模型。
   - 回归：`test/runtime-edges.test.mjs` 的启动竞态用例先红后绿；`test/runtime.test.mjs` 新增启动窗口接管/缺失用例。

## 验收对应

| 验收项 | 结果 | 说明 |
| --- | --- | --- |
| 固定 commit 解析并校验 id/role/version/path，兼容旧 worker 模板 | passed | 模板 adapter 测试覆盖 role 缺省、catalog/frontmatter 冲突、期望 role 不符、路径/版本不匹配 |
| 升级后在途及重启沿用旧引用和文本，新请求用新版 | passed | 运行测试截取 v1 promptRef/promptText，升级 v2 并重启后仍以 v1 完成；显式新请求使用 v2 |
| 缺失/非法模板不调用模型、明确阻塞、无硬编码回退 | passed | 缺失与 role 冲突均无 draft spawn、候选有 blockers、事件保留；修复后显式重试成功 |
| 启动竞态：记录 starting 期间不轮询，Pi.start 返回后同一请求正常接管 | passed | 返修前用例确定性失败（`repair-start-race-red.log`），返修后通过（`repair-start-race-green.log`）；启动窗口中断的接管/缺失各有回归 |
| 无工具、严格 JSON、sourceRev/CAS/决定快照与旧数据恢复保持有效 | passed | 既有专项回归 + 旧记录删除 promptRef/template/promptText 后仍保守恢复 |
| 开发入口拒绝 draft 模板，前端只提供 worker 模板 | passed | `decide` 返回 400；`GET /api/state` 的 templates 仅 development:worker |
| 既有回归与真实 Pi 隔离闭环实际通过，GitHub 替身分开报告 | passed | 见下 |

## 实际检查

中央证据目录：`/Users/linguojin/Workspace/auto-ai/github-first/.auto-ai/validation/T007/`。下表命令均在返修后的工作树运行，日志为真实输出。

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `node --test test/runtime-edges.test.mjs`（返修前 `src/runtime.mjs`） | failed | 复现启动竞态：`statusCalls` 为 1，`repair-start-race-red.log` |
| `node --test test/runtime-edges.test.mjs` | passed | 4/4，含启动竞态用例，`repair-start-race-green.log` |
| `npm test` | passed | 108/108；含新增启动窗口接管用例，`repair-npm-test.log` |
| `npm run check:trial` | passed | 35/35，原有执行包独立检查，`repair-check-trial.log` |
| `npm run check:workflow` | passed | 18/18，原有核心调度与合并门槛检查，`repair-check-workflow.log` |
| `npm run check:runtime` | passed | 隔离闭环 6/6；真实本地 Git 提交/推送/工作树回收，GitHub 使用明确替身，`repair-check-runtime.log` |
| `npm run check:runtime:live` | passed | 真实 Pi 隔离闭环 6/6，`repair-runtime-live.log`；结果 `repair-runtime-live-result.json` |

真实 Pi 证据（已从工作树复制到中央 `repair-pi-evidence/`，归档后仍可读取）：

- `repair-runtime-live-result.json`：`livePi:true`，6 项全部 passed，`temporaryRootRemoved:true`。
- `repair-pi-evidence/draft-7fc0338617a78ec0-1/request.json`：role=`draft`，provider=`facaiai-deepseek`。
- `repair-pi-evidence/draft-7fc0338617a78ec0-1/prompt.md`：带 `role: draft` / `version: "1.0.0"` frontmatter，包含“实质待决策”合同与不可信数据边界，说明实际使用 requirements 模板而非旧硬编码提示；对应事件 `draft.started.data.promptRef = 835e638…:templates/requirements/1.0.0.md`（`runtime-live/state.json`）。
- `repair-pi-evidence/run-38b73f76-…`、`run-cbb106b1-…`：role=`worker`，同一次闭环内的真实执行记录。
- 三条 session 逐项核对 `model_change` 与 `thinking_level_change`：provider=`facaiai-deepseek`、modelId=`deepseek-flash`、thinkingLevel=`high`，与固定配置一致。未修改凭据或全局配置。

## GitHub 真实行为与替身边界

- 本轮所有自动化检查中的 GitHub 行为均为隔离替身：不读取真实 Issue、不创建或合并真实 PR。
- 真实 GitHub 侧使用 Issue `ag-jin/auto-ai#2` 派发本次任务；Issue 读取/建稿/决定由控制器完成，不在 Worker 检查内，Worker 也不合并 PR。
- 未执行真实 GitHub 合并；最终用户验收与合并保持独立。

## 阻塞与未验证

- blockers：无。
- 未验证：真实 GitHub 侧的 PR 创建/读回/合并（Worker 不操作真实 Issue，也不合并 PR）；真实模型名与思考级别的逐项核验已在本文件记录，仍以监督者复核为准。
