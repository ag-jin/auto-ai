# Execution Route

| 项目 | 当前路线 |
| --- | --- |
| 目标 | 可版本化模板驱动的 GitHub/Pi 本地工作台，保留用户开发确认与最终合并门槛 |
| 技能 | writing-for-agents 维护任务稿；codebase-design 固定 Interface；frontend-design 检查界面；pr 维护审阅说明 |
| 事实来源 | AGENTS.md、CONTEXT_CARD.md、Runtime/HTTP 合同、实际 Git/Pi/HTTP 结果 |
| 交付 | 集成分支 design/github-first-templates、草稿 PR #1、本地 4310 工作台 |
| next_action | 用户验收当前结果并决定合并；新需求按当前稿版本另行确认开发 |

## 已完成的验证

- 项目测试 96/96、独立核心检查 18/18、执行包检查 35/35。
- 隔离闭环脚本 6/6；真实 Pi + 真实临时 Git 复跑同样 6/6。
- GitHub 真实只读收集/PR 读回，实际 HTTP/Runtime 配置与收集，Origin/令牌拒绝验证。
- 浏览器已核对实际后端配置、收集和排除状态；完整开发流程的验证来自脚本，不冒充浏览器全流程。
- Worker 代码和必要证据已保存并集成，全部已完成 Worker worktree 已归档；review 树仍用于当前可审阅工作台。

运行 `npm start` 启动；其他验收入口见 README。进程与数据位置从 CONTEXT_CARD 和 `.auto-ai/workbench-server.json` 恢复，不依赖聊天摘要。

## 权限与后续

没有自动合并真实 PR；没有安装系统定时器、改凭据或全局 Git 设置。规则命中只进候选池，未确认当前稿不能开发。一个主会话可监督多个仓库，原任务、授权、模板、依赖和产物均持久化。

新功能先收集并整理任务稿，等用户选择开发/暂缓/忽略；确认后自动调度，无需再次派发按钮。最终合并需要当前 head 的两种实际验收与明确操作；pending 结果只读核验。
