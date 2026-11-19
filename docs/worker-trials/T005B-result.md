# T005B 结果：HTTP 工作台与中文 UI 真实接口适配

## 返修 1（当前结果）

| 项目 | 值 |
| --- | --- |
| run_id | `T005B-r1-20261117T170103Z` |
| attempt | 2 |
| issue_ref | `ag-jin/auto-ai#1`（仅关联集成 PR #1，不代表 Issue 开发授权） |
| requirements_rev | `sha256:b60eea0596b5b9d7ce3bfdc85c7bd3e48a62a1316ed60eaa7b11af3423851232` |
| template_ref | `47cf3bb24210971469e6a397e344fc85cdb36dee:templates/development/1.2.0.md` |
| 模型 | `deepseek-flash` / `high` |
| 工作树 | `/Users/linguojin/.codex/worktrees/t005b-http-ui/github-first` |
| 中央证据 | `/Users/linguojin/Workspace/auto-ai/github-first/.auto-ai/worker-evidence/T005B-r1-20261117T170103Z` |
| 前次执行 | `T005B-20261117T165154Z`（attempt 1，HTTP/UI 初版） |

结论：错误响应边界已按返修包收紧，所有 4xx/5xx 统一经过脱敏层，不再原样回传异常 message/details/code；专项 13/13、完整 `npm test` 76/76。独立复现的 400、嵌套秘密、503、未知 500、409 currentRev 与错误后继续服务均通过，证据见 `independent-r1.green.log`。未自行 commit/push。

本次返修未验证：真实 `src/runtime.mjs` 启动与 GitHub/Pi 联调、浏览器最终交互；仍与 attempt 1 相同，待 Runtime 集成后由主会话执行。

### 返修改动

| 文件 | 改动 |
| --- | --- |
| `src/http-server.mjs` | 新增错误脱敏层：所有 4xx/5xx 校验 message（拒绝换行/控制字符、密钥/令牌/prompt/stack 关键词、超长与凭据样片段）；details 仅允许 `currentRev`、`allowed`、`reasons` 三个字段并按类型/长度/嵌套收紧，逐项拒绝含令牌值；error code 只接受安全格式且不得包含会话令牌；503 固定 `unavailable` 语义并透出经验证安全的环境原因；未知 5xx 固定通用错误与“查看事件或核验状态”提示，不再声称“未执行操作” |
| `test/http-server.test.mjs` | 新增 4 项红绿回归：400 details 与多行异常过滤、允许字段内的嵌套令牌/对象拒绝、409 安全业务原因与 64 位 `currentRev` 保留、503 可处理原因与不安全 503 降级；更新未知 500 断言为通用消息且无 details |
| `docs/worker-trials/T005B-result.md` | 记录返修 run_id、attempt、模板/需求版本、实际检查与未验证项 |

### 返修实际检查

| 检查 | 命令 | 结果 | 日志 |
| --- | --- | --- | --- |
| 红回归（实现前） | `node --test test/http-server.test.mjs` | failed，4 项失败（400/嵌套/503/500），exit 1 | `http-server-test-red.log` |
| HTTP 合同测试 | `node --test test/http-server.test.mjs` | passed，13/13，exit 0 | `http-server-test-green.log` |
| 完整项目测试 | `npm test` | passed，76/76，exit 0 | `npm-test-green.log` |
| 独立错误边界复现 | `node check-errors.mjs` | passed：400/嵌套/503/500 无令牌、密钥、prompt、stack 泄露；409 保留 `currentRev`；错误后 state 200 | `independent-r1.green.log` |
| 语法 | `node --check src/http-server.mjs && node --check test/http-server.test.mjs && node --check public/app.js` | passed，exit 0 | 本次会话输出 |

### 返修后的错误边界

- 400：多行/含 prompt 的异常文本降级为通用请求无效提示；`details` 仅保留 `{currentRev:'safe-rev'}`，`apiKey`、`csrfToken`、`stack`、任意嵌套对象全部丢弃；异常 code 含会话令牌时降级。
- 嵌套秘密：即使放在允许字段 `currentRev`/`reasons` 中的对象或令牌值也会被拒绝，不返回任何令牌片段。
- 409：安全的业务 message、64 位十六进制 `currentRev` 与安全 `reasons` 原样保留，冲突恢复不被脱敏破坏。
- 503：返回 `{code:'unavailable', message:'GitHub 不可用：请先登录 gh'}`；含令牌/换行/stack 的 503 文本降级为“服务暂不可用，请查看事件或稍后重试”。
- 未知 500：固定 `{code:'internal_error', message:'服务器内部错误，请查看事件或核验当前状态'}`，不带 `details`，不泄露异常文本，不断言“未执行操作”。
- 所有错误响应均不声称“未执行操作”；错误处理结束后 server 继续服务，state 仍返回同一会话令牌。

## 初版记录（attempt 1）

## 元数据

| 项目 | 值 |
| --- | --- |
| run_id | `T005B-20261117T165154Z` |
| attempt | 1 |
| issue_ref | `ag-jin/auto-ai#1`（仅关联集成 PR #1，不代表 Issue 开发授权） |
| requirements_rev | `sha256:63dd3a7750653145d1b54f32bcb80f7e269ddc725afae3fc26c52475daeebb3b` |
| template_ref | `24c17d835d0a15a4f31271c7f0ad0f51d64e884d:templates/development/1.2.0.md` |
| 模型 | `deepseek-flash` / `high` |
| 工作树 | `/Users/linguojin/.codex/worktrees/t005b-http-ui/github-first` |
| 中央证据 | `/Users/linguojin/Workspace/auto-ai/github-first/.auto-ai/worker-evidence/T005B-20261117T165154Z` |

## 结论

HTTP 层与中文 UI 适配已实现，全部本地可跑检查通过：`http-server` 测试 9/9、完整 `npm test` 72/72。真实 Runtime 尚未出现在本工作树（`src/runtime.mjs` 不存在），因此没有实际启动真实工作台联调，也没有进行浏览器最终检查；`npm start` 会明确报错退出，不写 fallback mock。未自行 commit/push。

## 改动产物

| 文件 | 内容 |
| --- | --- |
| `src/http-server.mjs` | `createHttpServer({runtime,host,port,publicDir})`：仅 loopback、Runtime start/close、内存令牌、Host/Origin 校验、全路由、CAS 透传、1 MiB JSON 限制、静态文件与 MIME/无缓存、路径与符号链接防护、错误脱敏 |
| `scripts/start.mjs` | 真实 Runtime 启动入口；显式解析 `--host/--port/--data-dir/--app-repo-dir`；默认 4310 与 `<appRepoDir>/.auto-ai/app`；SIGINT/SIGTERM 收尾；Runtime 缺失时明确失败 |
| `test/http-server.test.mjs` | 真实 HTTP server + 注入 fake Runtime 的 9 项测试，覆盖路由/方法/ID 编码/角色固定/CAS/Host/Origin/token/JSON 限制/穿越/符号链接/脱敏/close/pending |
| `public/app.js` | UI 真实接口适配：`awaiting_acceptance` 中文状态、ready 暂缓/忽略、无稿暂缓/忽略、本地路径可空、整理中显示、合并 pending 持久识别与防重复、空态步骤、409 保留输入 |
| `public/styles.css` | 空态步骤列表样式 |
| `package.json` | 新增 `npm start` |
| `README.md` | 追加当前实现的安装、启动、数据目录、测试与依赖说明；保留原 main 文本 |

## 实际检查证据

| 检查 | 命令 | 结果 | 日志 |
| --- | --- | --- | --- |
| 前端语法 | `node --check public/app.js` | passed，exit 0 | `app-check.log` |
| HTTP/启动脚本语法 | `node --check scripts/start.mjs && node --check src/http-server.mjs` | passed，exit 0 | `server-syntax.log` |
| HTTP 合同测试 | `node --test test/http-server.test.mjs` | passed，9/9，exit 0 | `http-server-test-final.log` |
| 完整项目测试 | `npm test` | passed，72/72，exit 0 | `npm-test-final.log` |
| CLI 帮助 | `npm start -- --help` | passed，exit 0，输出用法 | `start-help.log` |
| Runtime 缺失行为 | `npm start -- --port 4310` | not_run（真实启动）；明确报错，exit 1 | `start-missing-runtime.log` |

`npm start` 实际输出：

```text
启动失败：未找到 src/runtime.mjs：真实 Runtime 尚未集成，不能启动工作台。请先完成 T005A Runtime；不会用 mock 或假数据替代生产后端。
exit=1
```

## 已覆盖的 HTTP 行为

- 路由全表：`GET /api/state`、`PUT /api/settings`、`POST /api/collect`、`POST /api/runtime/watch`、`POST|PUT /api/candidates/:id/draft`、`POST /api/candidates/:id/decision`、`POST /api/candidates/:id/retry`、`POST /api/runs/:id/cancel`、`POST /api/candidates/:id/acceptance`、`POST /api/candidates/:id/merge`。
- ID 使用 `encodeURIComponent` 传输，服务端正确解码 `owner/repo#7`、含空格 Run ID。
- `PUT draft` 必须显式提供 `rev`（首次 `null`）；缺少返回 400；Runtime 409 原样透传 `error.code/details`。
- `decision.actor` 由服务端固定为 `user`，body 中 `actor:'admin'` 被丢弃；`develop` 缺 `draftRev` 返回 400。
- Host 必须是实际 loopback `host:port`；Origin 存在时必须同源；无 Origin 的本机 CLI 持令牌可写；跨站写与 DNS rebinding Host 被拒绝；响应不设置 CORS 头。
- 写请求要求 `Content-Type: application/json` 与 `X-Auto-AI-Token`；无效 JSON 400、非对象 400、超过 1 MiB 413；错误 JSON 结构与状态码一致，错误后 server 继续服务。
- 静态资源仅服务 `publicDir` 内真实文件，拒绝编码穿越、`..`、反斜杠、非法 URI 编码与符号链接越界；MIME 正确、`Cache-Control: no-store`。
- Runtime 500 统一返回通用 `internal_error`，不输出 stack、令牌或 prompt；Runtime close 与 HTTP close 幂等。
- 静态页面实际加载 `public/index.html`、`public/app.js`，测试校验 UI 使用 `/api/state`、`/api/settings`、`/api/collect`、`/api/runtime/watch`、候选/Run 路由与 `X-Auto-AI-Token`。

## UI 适配说明

- Run 状态新增 `awaiting_acceptance` → “待验收”。
- `ready` 状态允许暂缓/忽略，但不允许重复确认开发。
- 无任务稿时仍可暂缓/忽略；`develop` 仍要求已保存、无待决策、验收非空的任务稿。
- 仓库本地路径可留空（用于仅收集需求），开发前由 Runtime 再检查。
- 整理期间显示“整理中”并说明只读、不触发开发；collect/draft 按钮保持处理中状态。
- 合并结果只有 `merged === true` 且提供 `mergeSha` 才提示成功；`pending`、`merged:false` 或缺少 SHA 均提示“待核验/未确认”，不冒充完成。
- 刷新后通过 `candidate.mergePending` 或 `candidate.mergeIntent.status === 'pending'` 持续显示待核验并禁用重复合并。
- 409 保留本地输入并提示服务端新版本；轮询不覆盖未保存稿与设置。
- 空态按步骤引导：添加仓库 → 收集 Issue → 整理/审阅任务稿 → 确认开发。
- 未知状态显示“待识别状态”，不使用成功色。

## 未验证项

- **not_run**：真实 `src/runtime.mjs` 启动、真实 GitHub/Pi Adapter 联调、实际 `/api/state` 数据、SIGINT/SIGTERM 对真实运行时进程的收尾。
- **not_run**：浏览器对真实后端的最终交互检查（队列、待验收、合并 pending、409 表单保留）。按任务约定由主会话在 Runtime 集成后执行。
- **待集成确认**：Runtime `saveSettings` 需按合同接受空 `localPath`；当前旧版 `src/workflow.mjs` 仍要求非空，UI/HTTP 已按 Runtime 合同放开，最终以 T005A 实现为准。
- HTTP 测试使用注入 fake Runtime，不能称为完整线上验收。

## 复跑方式

```sh
node --check public/app.js
node --test test/http-server.test.mjs
npm test
```

## 阻塞

- `src/runtime.mjs` 尚未集成，无法在本工作树启动真实工作台并进行 HTTP/UI 联调；按合同不使用生产 fallback mock。
