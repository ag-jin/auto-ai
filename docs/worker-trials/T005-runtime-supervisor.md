# Runtime 集成监督核验

2026-11-18 主会话独立核验：

- Pi 首轮 Runtime 尚有 4 项失败，主会话确认停止并保存 `8ff81b7`，没有写成完成。聚焦返修使用同一 `deepseek-flash / high`，修正两处 fixture 与“正文恢复不会恢复旧授权”的错误测试预期。
- Pi r1 后主会话复跑专项 15/15；并发 merge 只发送一次、pending→MERGED 当次返回成功、preparing 重启恢复实际通过。Runtime 已集成至 `d87f93b`。
- 主会话补出三个失败回归后修复：关闭时先持锁等待在途收集/调度/合并与整理收尾；UI 事件窗口读取最新 300 条；构造拒绝相对路径。`test/runtime-edges.test.mjs` 3/3，红绿日志 `.auto-ai/validation/T005A/lifecycle-{red,green}.log`。
- 整合后项目测试 96/96、核心独立检查 18/18、执行包检查 35/35。真实本地 Git + 隔离 GitHub/Pi fixture 的闭环 6/6，包含提交、推送、PR、回收、双角色门槛与合并意图重启去重。临时根目录已回收。

## 真实模型磨合

首轮 `scripts/check-runtime.mjs --live-pi` 实际运行只读整理，开发确认前停止：模型将换行、测试方式和提交职责列为 pendingDecisions。门槛生效，没有创建开发 Worker 或 PR。这是整理提示与输入约定的磨合结果，不能计为完整闭环成功。

主会话收紧 pendingDecisions 的定义：仅保留影响用户可见行为、数据范围、权限与不可逆取舍的真实缺口；明确 Runtime 负责提交/推送/PR，常规实现和测试方式由 Worker 决定。原始记录在 `.auto-ai/validation/runtime-live-first/`（后续复跑前保存）。

同一需求在收紧整理约定后复跑通过 6/6：只读整理没有生成伪待决策，模拟用户确认后真实 Worker 创建 NOTE.md，独立检查 Git 中内容严格为 8 字节 `smoke-ok`（无换行），提交差异仅 NOTE.md；真实本地分支推送成功，工作树实际回收。随后 fixture PR 双角色验收、显式合并 pending、重启只读核验均通过，合并替身调用仅一次。

真实会话的 model_change 和 thinking_level_change 均逐项核对，两种角色都是 `facaiai-deepseek / deepseek-flash / high`。证据 `.auto-ai/validation/runtime-live/{result,state,model-configuration}.json` 与 `pi-evidence/`。临时测试根目录已回收，原始 Pi 记录已集中保存。

## 核验边界

- 真实 GitHub：认证、Issue 列表收集、PR #1 读回。
- 真实 Pi：需求整理、开发 Worker、固定模型档位；真实临时 Git 提交/推送和 worktree 回收。
- 隔离替身：GitHub 创建 PR、验收后的合并命令/状态；没有真实 GitHub 合并。
- 浏览器：实际后端的配置、收集、排除条目、未保存输入保护与布局。完整开发流程由脚本验证，不能将其声称为全部浏览器操作验收。

Next action：启动可审阅工作台、更新草稿 PR #1 和运行说明，等待用户最终验收与明确合并决定。
