# T005A：把领域核心与真实 Adapter 接成可恢复 Runtime

任务稿版本 1。执行者 Pi / deepseek-flash / high。

## 目标与完成条件

实现 `docs/RUNTIME_CONTRACT.md` 的 Runtime，让规则收集、只读整理、用户确认、自动开发调度、PR 与回收可以由同一持久控制器运行。完成条件是公开 Interface 可用、关键授权/恢复/取消/合并边界有实际测试；不能以模块骨架或只做 fake 演示交付。

## 执行位置与事实来源

当前工作目录为你的独立 worktree。先读 AGENTS.md、docs/CONTEXT_CARD.md，再完整读 docs/RUNTIME_CONTRACT.md、docs/HTTP_CONTRACT.md 和 src/{workflow,store,prepare-task,pi-adapter,workspace-adapter,github-adapter,template-adapter}.mjs。只在需要理解模板结果时读 templates/development/1.2.0.md；以合同和代码实际 Interface 为准。

主会话已明确授权系统建设。测试不得合并真实 PR、创建真实 Issue、安装系统服务或改凭据。HTTP/前端由 T005B 在另一树负责，本任务不改这些文件。

## 范围

允许 src/runtime.mjs、src/workflow.mjs、src/store.mjs、src/github-adapter.mjs、必要的 src/runtime-*.mjs，test/runtime.test.mjs、必要的 test/fixtures 非自动测试文件，以及 docs/worker-trials/T005A-result.md。不改 package.json/public/scripts、模板、既有合同或其他测试。现有 API 保持兼容，领域扩展通过 Workflow 公开方法，保持一个权威状态源。

外部依赖沿用已有 yaml，无新增 npm 包。持久附加控制状态可用原子 JSON，避免为一个功能再做通用框架。writeScopes=['*'] 的默认值必须保守。资源用完回收，模型空闲时不调用。

## 输入输出与执行合同

完整 Interface 见 RUNTIME_CONTRACT.md。所有方法可 await，HTTP T005B 会严格按其调用。getState 返回真实 settings/candidates/runs/events/templates/runtime/capabilities，不返回 csrfToken（HTTP 加）。测试依赖注入，生产默认真实 Adapter。

模板在确认开发时固定，同一稿 retry 不追随 HEAD；requirements hash 与批准稿相等。中央 evidence/result 路径在 envelope，保留 approved inputs。unknown 取消或进程状态不能调用 blockRun 释放占用。开发执行依据 Workflow 的 claimNext；claim 后单运行错误只阻塞自己。

新增只读 readIssue 并在交付/验收/合并前刷新 sourceRev。合并持久化意图，任何未知结果只读核验一次次推进；不能重发 merge。close 后 Pi detached 可继续，start 能接管。

## 验收样例

1. 多仓库收集：一个失败，另一个候选正常入库；命中自动整理但从不自动批准开发，空闲无额外模型请求。
2. draft role 无工具；严格 JSON、非法输出阻塞；Issue 中恶意文字只能作为数据；sourceRev/CAS 改变时旧整理不覆盖。
3. 无稿 defer/ignore 可用；develop 精确 rev + 非空验收 + 无待决策；ready 可撤销；保存内容改变清授权；CAS 冲突 409。
4. 并发/依赖/路径检查沿用核心；多个 tick 不重复 start，每个 run 独立目录、分支、session；一个准备失败仍安排其他 eligible 任务。
5. Worker 有效结果 → scope 检查 → 提交推送 → PR → awaiting_acceptance → 已推送干净工作树回收；所有 run 关联正确仓库。
6. 进程 unknown 或取消 unknown 保持运行占用，不能 retry；已停止失败保留工作树并允许仍有效的授权重试。
7. 在准备/启动/完成/推送/PR/归档各阶段中断，重开后核对记录，不能重复启动；至少对 start 前后和 PR 创建后做真实持久恢复测试。
8. 旧模板 commit 下开工，中途默认升级，再 retry 仍用旧模板；packet.requirements_rev 与 approved draft.requirementsRev 相同。
9. 未确认、缺少任一验收、head 或 Issue 内容改变都不调用 merge；design 空评论拒绝；用户明确 merge 才发。
10. merge 返回 pending/抛错后重启/重复请求，只读核对不重复 merge；实际 MERGED + SHA 才 completed。
11. 控制器锁拒绝第二活实例，失效锁核对 PID 身份可恢复；close 释放锁且不杀 Pi。
12. 生产依赖不可用有具体原因，不注入 mock 冒充成功。

## 验证与回报

运行专项 node --test test/runtime.test.mjs 和全量 npm test，保留实际输出。测试只对临时 Git/注入 Adapter，不操作真实 GitHub 合并。中央证据目录由启动 envelope 指定；不要在 worktree 留复制的依赖/缓存。结果记录 summary/artifacts/evidence/blockers、实际测试数、已知限制和真实外部未验证项。每条证据区分 fake 外部与真实本地进程/Git。

可以读取主会话指定的中央日志与任务包；所有代码编辑仅限本 worktree。完成后不自行 git commit/push，主会话独立检查后及时提交集成。
