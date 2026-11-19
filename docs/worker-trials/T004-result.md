# T004 结果：中文多仓库需求与执行工作台前端

- `run_id`: `T004-20261117T153300Z`
- `attempt`: `1`
- `requirements_rev`: `sha256:b1438c8a6cafd1cff8a378d79a39fcb31aad475c8c04818ba25f63def406aec8`
- `template_ref`: `f9babb313277835954ff946c78ef8052fd7b7eca:templates/development/1.1.0.md`

## summary

已按 `docs/HTTP_CONTRACT.md` 与 `docs/UI_PLAN.md` 实现原生 HTML/CSS/ES module 中文前端，覆盖规则与仓库配置、候选池、任务稿审阅与版本化保存、开发/暂缓/忽略、按仓库执行总览、队列/优先级/依赖/阻塞、事件与证据、PR 双角色验收和用户显式确认后的合并。

- 所有测试数据来自临时 mock HTTP 服务，未写入仓库；生产界面不包含假任务、假完成状态或虚构统计。
- 所有动态文本通过 `textContent`/统一 DOM 构造写入；外部链接仅接受 `http/https`。
- 写操作使用同源 `/api/...`、内存中的 `csrfToken` 和 `X-Auto-AI-Token`；写成功后刷新 state，409 保留输入并提供重新核对入口。
- 2.5 秒轮询且同一时刻只发起一轮刷新；编辑中的任务稿与设置不会被轮询覆盖。
- 未实现后端、未修改任务范围外源码、未提交 Git。

## artifacts

- `public/index.html`
- `public/styles.css`
- `public/app.js`
- `docs/worker-trials/T004-result.md`（本文件）

## evidence

### passed

1. **JS 语法检查**：`node --check public/app.js` → 通过（退出码 0）。
2. **接口路径核对**：临时 Node 脚本逐项匹配 `HTTP_CONTRACT.md` 中的 11 个接口路径，11/11 存在；写方法分别使用 `PUT`/`POST`，路径参数均经 `encodeURIComponent`。
3. **安全静态扫描**：未发现 `innerHTML`、`insertAdjacentHTML`、`localStorage`/`sessionStorage`、`eval(`；未发现 CDN、网络字体或外部图标资源引用。
4. **无头浏览器 + 临时 mock HTTP 服务**：Chrome headless（CDP 驱动）实际加载页面并执行交互，35/35 项检查通过，页面无脚本异常。驱动命令为 `node /tmp/t004-test/cdp.mjs`，汇总日志为 `/tmp/t004-test/cdp.out`。覆盖：
   - 初始候选列表、命中/排除原因、任务稿版本、顶部连接与监督状态；
   - 收集 Issue 回执、自动监督开关；
   - 执行总览、活动 Worker、阻塞原因、Run/模板/来源详情、事件摘要、事件数据敏感字段隐藏；
   - 取消运行、阻塞任务重试；
   - PR 验收页结果/证据、双角色结论、缺设计通过时合并禁用、设计说明必填；
   - 记录设计验收、合并前确认、用户确认后合并、合并后状态刷新；
   - 规则页仓库行、AND/OR 说明、完整 settings 保存；
   - 任务稿字段、未修改时保存禁用、外部更新 rev 后保存返回 409、输入保留、采用服务端 rev 后重新保存、确认开发自动进入调度；
   - 无任务稿候选的忽略操作；
   - 390px 窄屏无横向溢出，导航/列表/详情按顺序收敛。

   测试现场位于 `/tmp/t004-test`（临时 mock 服务、CDP 脚本与日志），未纳入仓库。该证据验证的是前端在真实浏览器中的行为，不等同于与真实后端联调。

### failed

无。

### not_run

- 真实 `GET /api/state` 后端服务联调：开工时没有运行中的 HTTP 服务；mock 只覆盖合同形状。
- 真实 GitHub 收集、Pi Worker、run 取消后的进程停止确认、真实 PR 合并。
- 真实用户与设计监督的身份/权限流程；当前合同声明为单人本地工作台。
- 人工浏览器视觉复核、屏幕阅读器/键盘全流程审计、跨浏览器测试；仅完成 Chrome headless 与 390px 布局检查。
- 自动监督循环持续运行、服务重启恢复、真实 409 竞争与后端并发上限验证。
- 真实后端对 `PUT /api/settings` 返回有效 settings 的归一化行为。

## blockers

- 前端已完成并有上述证据；集成验收仍依赖主会话启动真实 HTTP 服务后做浏览器联调。

## 接口疑问与范围说明

1. **PUT 任务稿的并发字段**：为支持 409 版本冲突，前端在 `PUT /api/candidates/:id/draft` 请求体中附带当前 `rev`（来自服务端），不自行生成版本。若后端通过其他方式核对版本，需要调整。
2. **无任务稿时的暂缓/忽略**：合同请求体列出 `draftRev`，但候选可能没有任务稿。前端允许暂缓/忽略并省略 `draftRev`，由后端判定；若后端要求必须先有草稿，需要在合同或错误响应中明确。
3. **阻塞/冲突原因字段**：Run DTO 的最小字段没有阻塞原因。前端读取可选的 `blockReason`、`blockedReason`、`reason`、`blockers`、`result.blockers`，并回退展示相关事件。建议后端固定字段名，避免只能从事件推断。
4. **空状态列表语义**：`rules.states` 为空时合同未定义“匹配全部”还是“不匹配”；前端允许提交空数组并在界面提示由后端决定。
5. **templates / runtime.activeDrafts 形状**：合同只给出数组。前端兼容字符串模板和 `{id|templateId|name, version, title}` 对象；`activeDrafts` 仅显示数量。
6. **latestResult.evidence 形状**：合同未细化。前端兼容字符串与对象；对象状态只读取 `status/result/outcome`，缺失时明确显示“状态未记录”，不会推断为通过。
7. **合并防重复**：前端在请求期间禁用合并按钮，并要求每次勾选确认；后端仍必须按合同核对两种验收、当前 head 和 `confirmed:true`。
8. **范围偏差**：无。仅新增 `public/` 下三个文件和本结果文档，未修改其他任务源码，未提交 Git。
