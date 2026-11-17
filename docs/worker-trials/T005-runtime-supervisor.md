# Runtime 集成监督核验

2026-11-18 主会话独立核验：

- Pi 首轮 Runtime 尚有 4 项失败，主会话确认停止并保存 `8ff81b7`，没有写成完成。聚焦返修使用同一 `deepseek-flash / high`，修正两处 fixture 与“正文恢复不会恢复旧授权”的错误测试预期。
- Pi r1 后主会话复跑专项 15/15；并发 merge 只发送一次、pending→MERGED 当次返回成功、preparing 重启恢复实际通过。Runtime 已集成至 `d87f93b`。
- 主会话补出三个失败回归后修复：关闭时先持锁等待在途收集/调度/合并与整理收尾；UI 事件窗口读取最新 300 条；构造拒绝相对路径。`test/runtime-edges.test.mjs` 3/3，红绿日志 `.auto-ai/validation/T005A/lifecycle-{red,green}.log`。
- 整合后项目测试 96/96、核心独立检查 18/18、执行包检查 35/35。真实本地 Git + 隔离 GitHub/Pi fixture 的闭环 6/6，包含提交、推送、PR、回收、双角色门槛与合并意图重启去重。临时根目录已回收。

## 真实模型磨合

首轮 `scripts/check-runtime.mjs --live-pi` 实际运行只读整理，开发确认前停止：模型将换行、测试方式和提交职责列为 pendingDecisions。门槛生效，没有创建开发 Worker 或 PR。这是整理提示与输入约定的磨合结果，不能计为完整闭环成功。

主会话收紧 pendingDecisions 的定义：仅保留影响用户可见行为、数据范围、权限与不可逆取舍的真实缺口；明确 Runtime 负责提交/推送/PR，常规实现和测试方式由 Worker 决定。原始记录在 `.auto-ai/validation/runtime-live-first/`（后续复跑前保存）。

Next action：真实 Pi 复跑隔离闭环，保存原始模型记录与实际 Git 证据；不操作真实 GitHub 合并。
