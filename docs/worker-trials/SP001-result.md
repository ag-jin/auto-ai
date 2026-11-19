# SP001 验证记录

用户授权：2026-11-19「设置目标推进」。范围见 SP001-task.md 与真实 Issue #18。不得自动合并。

## 升级

正式运行树 review/workbench 已从 58773e0 快进到合并提交 3ed4b2517e9890d167c423ed91c317ac428bb68a，原服务进程已不存在，无需强停。升级前使用 node:sqlite backup 保存一致性数据库与 runtime/server 配置至 `.auto-ai/sop-progress/evidence/`。自动收集暂关，4310 启动并经真实浏览器只读冒烟；候选12条、历史Run6条保持，活动开发Run为0。主仓库已有未提交文档未改。

## 真实工作台执行

固定测试基线 2d26ae7723eaed0bb6b1eac3cab4a2ba041899dc，任务稿 rev 8719d4281253c61bcc934763bddaede97f03731799955bd47bc71c630b4fa51b，应用/SOP固定合并版本3ed4b25。Runtime 使用真实Pi、GitHubAdapter、WorkspaceAdapter，派发独立两路：A只改src/runtime.mjs，B只改public/app.js。稿定后端/前端测试与独立无工具review通过，Runtime自动提交、推送、创建并读回PR #19（head fa9c759d3eff42589718a854cea2df43f58a616f，base feat/sop-progress-base）。本轮没有声称引擎已自动拆解任意需求：拆分由主会话固定在获批范围稿内，SOP仍只支持每路一个文件。普通requirements整理被显式跳过，不冒称UI点击批准。

原始Pi调用、固定稿、decision、state在 `.auto-ai/sop-progress/evidence/`；完整control/Pi session在`.auto-ai/sop-progress/data/`。两路与父集成工作树由Runtime按交付证据自动回收。

## 浏览器发现与修复

交付fa9c759全量测试143/143。随后在4311使用上一轮真实GitHub验收数据库和control副本（PR #17、Run run-c9a8ac9e-e7f9-46e1-8a7d-199650472540）启动新Runtime与新页面；不修改原历史、不开自动收集。真实浏览器候选详情显示：A第2次、B第1次、check返工原因、两项检查passed、独立评审approved及PR #17链接，与control一致。

浏览器发现reworks.reason堆栈带本机绝对工作树路径；补回归后在62ccfd8修复，只读摘要把已知工作树/中央本run前缀替为<worktree>/<run>，保留相对脚本、原始断言与node:internal，绝不改原control。真实浏览器复查已显示file://<worktree>/examples/sop-runtime/check-a.mjs。全量144/144通过，旧Run null与HTML纯文本回归通过。

此修复由主会话安排完成，不冒称包含在Runtime原交付fa9c759的独立评审里。最终修复另行独立复审与浏览器验收。旧详情区和事件中原有路径展示不在本次sop摘要脱敏范围，不声称整个应用所有路径均已隐藏。

## 交付结构

准备基线含先行测试，自动实现PR #19指向该准备分支。最终集成功能PR将准备测试、Runtime自动实现提交与浏览器修复一并面向design/github-first-templates交付，明确区分自动PR与主会话集成PR。任何PR均不自动合并。

## 最终复核与页面覆盖

62ccfd8 最终全量 npm test 144/144通过；独立只读复审结论无阻塞，确认白名单只读、两处UI接入、安全文本与脱敏；无新增调度行为。当前review.status以sop.result存在推导approved，依赖既有核心仅通过独立评审后才写result的约定。

真实浏览器候选详情在4311读取完整历史副本，核对真实控制记录及PR #17；文字快照 `text-bc383cc9-dbea-48d4-9b3c-0bb49bfec901`。执行卡另在4312做明确回放：只在getState响应将已交付Run.status改为running以覆盖活动卡，SQLite与control未变，不声称出现真实活动Run；快照 `text-b1104352-1fbe-497d-af92-adee7c117f17`。两处均显示A第2次/B第1次、check返工、两项通过、review approved与两条验收证据、原有PR #17入口。HTML注入防护由VM真实渲染函数测试覆盖，不将其冒称浏览器攻击实测。

非阻塞现有限制：非活动/非blocked/非completed的待验收Run不会出现在执行总览活动卡，仍可在候选详情查看；旧Run详情/事件原有绝对路径不属于新增SOP摘要。本次不修改该既有结构。瞬时hold后的旧control.hold可能继续显示为原因，保留事实但不是调度门槛，不额外扩展状态模型。
