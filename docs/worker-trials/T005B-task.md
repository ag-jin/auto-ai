# T005B：HTTP 工作台与中文 UI 真实接口适配

任务稿版本 1。执行者 Pi / deepseek-flash / high。

## 目标与完成条件

实现可由 npm start 启动的本地工作台，HTTP 层依赖固定 Runtime Interface，把已有中文 UI 接到真实后端。完成条件是所有路由、授权令牌、CAS/错误语义可测，UI 正确表现队列、待验收和合并待核验。Runtime 本体由另一 Pi 实现；不要用生产假数据代替它。

## 事实来源

先读 AGENTS.md、docs/CONTEXT_CARD.md，完整读 docs/RUNTIME_CONTRACT.md 和 docs/HTTP_CONTRACT.md，然后读 public/index.html、public/app.js、public/styles.css 与 package.json。需要理解核心字段时读 src/workflow.mjs。

Runtime 尚在另一工作树实施；其所有方法都可 await，构造和返回值按 RUNTIME_CONTRACT.md，不需要等它完成才写 HTTP 测试。

## 范围

允许 src/http-server.mjs、scripts/start.mjs、public/*、test/http-server.test.mjs、package.json scripts、README.md、docs/worker-trials/T005B-result.md。不得修改 runtime/workflow/Adapter、模板、合同和其他测试。不添加 npm 依赖。

导出 `createHttpServer({runtime,host='127.0.0.1',port=0,publicDir})`，可 await，返回 `{server,url,close}`。工厂负责 start Runtime，close 关闭 server 与 Runtime。只允许 loopback。测试 fake Runtime 不访问 GitHub/Pi。scripts/start.mjs 用真实 Runtime；CLI 的 --host/--port/--data-dir/--app-repo-dir 用明确 argv 解析，默认端口 4310、数据 appRepoDir/.auto-ai/app，启动输出准确 URL 与数据位置，SIGINT/SIGTERM 收尾。

## HTTP 与 UI 合同

严格实现 HTTP_CONTRACT.md 路由与参数；PUT draft rev 是必需 CAS（首次 null），actor 只能由服务端 user，不接受 body 提权。未知路由 404、方法 405、无效/大于 1 MiB JSON 400/413，响应 JSON 错误，不能输出 stack/令牌/prompt。只允许 publicDir 内实际静态文件，防编码穿越、符号链接越界；正确 MIME/无缓存。

校验 Host 为实际 loopback 服务的 host:port；浏览器 Origin 存在时须等于本服务允许 Origin，写请求必须正确 JSON Content-Type 与内存 X-Auto-AI-Token。允许无 Origin 的本机 CLI 持令牌调用，但无 token 不能写。跨站/DNS rebinding 不能读取 state 获取 token；不启 CORS。Worker 不获得 token。

UI 改进：Run awaiting_acceptance 有中文状态；ready 可暂缓/忽略；无稿允许暂缓/忽略；本地路径可空用于仅收集需求。collect/draft 异步期间正确显示。merge 只有 merged===true 才成功；pending 使用中文待核验提示并防重复按钮，刷新后也读取服务器持久 pending。候选可附 mergeIntent/mergePending 字段，优先按 mergePending 或 mergeIntent.status==='pending' 识别，Runtime 合同至少 pending 结果和事件。

中文空态须可按步骤添加仓库、收集、审任务稿、确认开发。保留 DOM/textContent 安全渲染和未保存稿不被轮询覆盖；409 保留输入并提示服务端新版本。所有状态展示实际值，不能用未知状态当成功。

README 按当前实现更新安装/运行/测试与依赖，不把 mock 测试称完整线上验收。保留原 main 的 README 原文。

## 验收

测试真实 HTTP server + 注入 fake Runtime：路由全表、正确方法及 body、ID 编码、CAS 409 透传、角色固定、Host/Origin/token、非法 JSON/超大请求/路径穿越/符号链接、仅 loopback、响应脱敏、close。错误不能杀 server。静态页面可加载且 UI 用实际接口。

运行 node --check public/app.js、node --test test/http-server.test.mjs、npm test。若 Runtime 尚无文件导致 npm start 无法联调，明确记录待集成，不在生产写 fallback mock。结果文档列实际证据与未验证；浏览器最终由主会话对真实后端检查。日志写 envelope 的中央证据目录。

代码仅改本工作树；完成不自行 commit/push，主会话独立检查后提交。
