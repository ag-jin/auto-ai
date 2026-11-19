# T006 独立核验

日期：2026-11-18。Pi 实际会话已核对为 `facaiai-deepseek / deepseek-flash / high`。

主会话先通过公开 Runtime Interface 复现：无稿 defer/ignore 后迟到稿将两个状态都变为 awaiting_decision、decision=null；同源失败后两次收集让整理启动数变成 3。原始 red.log 保留，未将首轮失败计为通过。

Pi 修复并经主会话独立复核：

- 决定快照持久化，结果应用同时核对 sourceRev、稿件 CAS 和用户决定；后来的用户决定优先，丢弃稿仍保存为证据。
- 同源 failed/unknown 整理不因重复收集或重启而再调用模型；显式重试和新源版本保持可用。
- 旧磁盘记录缺少快照时保守恢复；已授权、已领取及未领取任务都不会被迟到稿清授权。
- Runtime 专项 19/19；全量 100/100；补充独立样例的 defer/ignore/failed/unknown 四种情况通过。

集成提交 `ed0f8cd`。Worker 工作树已实际归档移除，日志集中保存在 `.auto-ai/worker-evidence/T006-20261117T182149Z/` 和 `.auto-ai/validation/T006/`。

最新 Runtime/界面修复后的真实 Pi 隔离闭环重新运行 6/6：只读整理和开发 Worker 均实际使用 deepseek-flash/high，真实临时 Git 提交、推送与工作树回收完成。GitHub PR/合并仍使用明确注入的替身；没有实际 GitHub 合并。

界面事件驱动流程见 [UI-full-backend-check.md](UI-full-backend-check.md)。
