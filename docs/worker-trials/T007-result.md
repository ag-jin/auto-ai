# T007 结果：需求整理方法纳入版本化模板

> 监督返修（2026-11-18）：下方是首轮 Worker 自测记录，尚未最终验收。独立 `npm test` 106/106 通过，但真实 Pi 检查复现启动竞态：draft 记录先写 running，Pi.start 尚在等待进程身份时，tick 先调 status 得到 unknown；实际 Pi 随后 completed，Runtime 却永久不接管。已在 `test/runtime-edges.test.mjs` 加入确定性回归，当前应失败。请在既有 Runtime 范围修复，并实际复跑该测试、全量与真实 Pi 隔离闭环。
>
> 首轮本工作树内的 runtime-live 证据已随回收丢失，不能再作为可读取证据引用。返修使用中央目录 `/Users/linguojin/Workspace/auto-ai/github-first/.auto-ai/validation/T007/` 保存检查日志与完整 Pi 记录；可将脚本默认生成的证据复制到中央，不改范围外的检查脚本。请将本文下方状态与路径更新为最终真实结果，区分失败复现和修复后通过。首轮失败现场已保存在中央 `independent-start-race/`。

- run_id：`run-01a73750-61af-414e-9407-d286c7b03af4`
- attempt：1
- template_ref：`d5993e36f42d64ea05e7807820f0bf022abe0b61:templates/development/1.2.0.md`
- requirements_rev：`sha256:a0ef7b417f1dee351d7c06e2fb87cd15ab22417ddfca5eb2c9ea6458fb5acb4d`
- 开工基线：`d5993e3`；任务分支：`auto-ai/run-01a73750-61af-414e-9407-d286c7b03af4`
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

## 验收对应

| 验收项 | 结果 | 说明 |
| --- | --- | --- |
| 固定 commit 解析并校验 id/role/version/path，兼容旧 worker 模板 | passed | 模板 adapter 测试覆盖 role 缺省、catalog/frontmatter 冲突、期望 role 不符、路径/版本不匹配 |
| 升级后在途及重启沿用旧引用和文本，新请求用新版 | passed | 运行测试截取 v1 promptRef/promptText，升级 v2 并重启后仍以 v1 完成；显式新请求使用 v2 |
| 缺失/非法模板不调用模型、明确阻塞、无硬编码回退 | passed | 缺失与 role 冲突均无 draft spawn、候选有 blockers、事件保留；修复后显式重试成功 |
| 无工具、严格 JSON、sourceRev/CAS/决定快照与旧数据恢复保持有效 | passed | 既有专项回归 + 旧记录删除 promptRef/template/promptText 后仍保守恢复 |
| 开发入口拒绝 draft 模板，前端只提供 worker 模板 | passed | `decide` 返回 400；`GET /api/state` 的 templates 仅 development:worker |
| 既有回归与真实 Pi 隔离闭环实际通过，GitHub 替身分开报告 | passed | 见下 |

## 实际检查

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `npm test` | passed | 106/106；新增 2 个模板 role 测试与 3 个 requirements Runtime 测试 |
| `npm run check:trial` | passed | 35/35，原有执行包独立检查 |
| `npm run check:workflow` | passed | 18/18，原有核心调度与合并门槛检查 |
| `npm run check:runtime` | passed | 隔离闭环 6/6；真实本地 Git 提交/推送/工作树回收，GitHub 使用明确替身，未执行真实 PR 变更 |
| `npm run check:runtime:live` | passed | 真实 Pi 隔离闭环 6/6；需求整理与 Worker 均实际调用 Pi，GitHub 仍是替身 |

真实 Pi 证据（本工作树内，归档前保留）：

- `.auto-ai/validation/runtime-live/result.json`：`livePi:true`，6 项全部 passed，`temporaryRootRemoved:true`。
- `.auto-ai/validation/runtime-live/pi-evidence/draft-7fc0338617a78ec0-1/request.json`：role=`draft`，provider=`facaiai-deepseek`。
- `.auto-ai/validation/runtime-live/pi-evidence/draft-7fc0338617a78ec0-1/prompt.md`：包含 requirements 模板的“实质待决策”合同，说明实际使用新模板而非旧硬编码提示。
- `.auto-ai/validation/runtime-live/pi-evidence/run-08b6192c-02f0-42df-bb04-caf16cb327b4/request.json`：role=`worker`，provider=`facaiai-deepseek`。

模型与思考级别沿用本机固定配置 `deepseek-flash` / `high`；检查脚本按项目既有 PiAdapter 默认 provider 启动，未修改凭据或全局配置。

## GitHub 真实行为与替身边界

- 本轮所有自动化检查中的 GitHub 行为均为隔离替身：不读取真实 Issue、不创建或合并真实 PR。
- 真实 GitHub Issue 建立、任务稿保存和 PR 提交属于主会话/控制器操作，不在本次 Worker 的检查内；本次只交付代码与 PR 候选。
- 未执行真实 GitHub 合并；最终用户验收与合并保持独立。

## 阻塞与未验证

- blockers：无。
- 未验证：真实 GitHub 侧的 PR 创建/读回/合并（Worker 不操作真实 Issue，也不合并 PR）；真实模型名与思考级别的逐项核验由监督者按既有配置完成。
