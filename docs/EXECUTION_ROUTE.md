# Execution Route

| 项目 | 当前路线 |
| --- | --- |
| 目标 | 可版本化模板驱动的 GitHub/Pi 本地工作台，保留用户开发确认与最终合并门槛 |
| 技能 | writing-for-agents 维护任务稿；codebase-design 固定 Interface；frontend-design 检查界面；pr 维护审阅说明 |
| 事实来源 | AGENTS.md、CONTEXT_CARD.md、Runtime/HTTP 合同、实际 Git/Pi/HTTP 结果 |
| 交付 | 集成分支 design/github-first-templates、草稿 PR #1、本地 4310 工作台 |
| next_action | 等待用户确认 T007 v1，随后用真实 Issue 与完整 Runtime 推进自身后续开发；保留终验/合并门槛 |

## 已完成的验证

- 项目测试 101/101、独立核心检查 18/18、执行包检查 35/35。
- 隔离闭环脚本 6/6；真实 Pi + 真实临时 Git 复跑同样 6/6。
- GitHub 真实只读收集/PR 读回，实际 HTTP/Runtime 配置与收集，Origin/令牌拒绝验证。
- 实际 Runtime/HTTP/UI 的双仓库 DOM 事件驱动界面闭环已补证：版本门槛、决定、并行/队列、失败重试、验收、pending、完成与筛选。GitHub/Pi 为明确替身；原生输入通道失败单独保留，不混称原生验收。
- Worker 代码和必要证据已保存并集成，全部已完成 Worker worktree 已归档；review 树仍用于当前可审阅工作台。

运行 `npm start` 启动；其他验收入口见 README。进程与数据位置从 CONTEXT_CARD 和 `.auto-ai/workbench-server.json` 恢复，不依赖聊天摘要。

## 权限与后续

没有自动合并真实 PR；没有安装系统定时器、改凭据或全局 Git 设置。规则命中只进候选池，未确认当前稿不能开发。一个主会话可监督多个仓库，原任务、授权、模板、依赖和产物均持久化。

新功能先收集并整理任务稿，等用户选择开发/暂缓/忽略；确认后自动调度，无需再次派发按钮。最终合并需要当前 head 的两种实际验收与明确操作；pending 结果只读核验。

T007 是待确认候选：将需求整理方法纳入版本化模板，固定稿件 v1 的规范化 rev 已保存，尚未授权。用户批准前不创建 Issue、不发开发；此后必须使用完整 Runtime 而不再只调用 PiAdapter。完整目标的剩余项和证据范围见 `docs/ACCEPTANCE_AUDIT.md`，不能将现有隔离闭环当作已完成真实后续自举开发。
