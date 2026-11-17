# T003 Adapter 集成核验

主会话核验日期：2026-11-18，Asia/Shanghai。

- A 初版发现 detached 后代持管道仍返回 cancelled，以及长日志截断损坏 JSON。真实 Pi r1 修复，主会话独立检查三项通过（unknown 取消、合法 JSONL、分片中文 UTF-8）；新 Adapter 调用真实 deepseek-flash/high 只读整理完成。中央记录 `.auto-ai/validation/T003A/independent.json` 与 `.auto-ai/live-adapter-smoke/live_draft_1794933263532/verified.json`。
- B 初版发现 merge 命令成功但读回 OPEN 仍声称合并。真实 Pi r1 先复现六项失败再修复；主会话复跑 Adapter 27/27，覆盖 pending、无效 SHA、失败读回、同 head 已合并幂等。
- 两者集成后的主会话 `npm test`：63/63；`node scripts/check-workflow.mjs`：18/18。完整输出在 `.auto-ai/integrated-test.log`，不能等同 HTTP/UI 闭环验收。
- 没有执行真实 GitHub 合并。PR #1 保持 OPEN。

集成提交：A `22b1a88`，B `0ce5f3d`。执行 session/原始日志与模板引用保存在中央 `.auto-ai/`；工作树内返修测试日志回收前复制到中央 trial evidence。

Next action：T005A/T005B 接上 Runtime 与 HTTP/UI，实际验证授权到交付的闭环。
