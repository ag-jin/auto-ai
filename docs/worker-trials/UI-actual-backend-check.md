# 真实后端界面接入检查

2026-11-18 主会话使用实际 Runtime 工作树代码 + 已集成 HTTP/UI，在独立空数据目录启动；不是生产 mock。Runtime 此时仍待返修，本记录不代表完整执行闭环通过。

实际通过：

- 默认自动监督关闭，无假任务；GitHub/Pi 状态可读取。
- 本地路径留空的 ag-jin/auto-ai 设置保存成功；只收集远程需求，不触发开发。
- 在真实浏览器点击收集，真实 GitHub 返回 PR #1，界面保留观测并明确显示排除原因；没有开发 Issue、没有启动模型或 Worker。
- 刷新完成后，关键词的未保存输入 `unsaved-browser-check` 仍保留。
- 根据现场检查，禁用规则排除条目的两个整理按钮与开发入口，合并重复派发原因，明确“未选择状态则收集打开和已关闭的 Issue”。修改后浏览器实际读回两个整理按钮 disabled=true。

截图在中央 `.auto-ai/validation/ui-preview/actual-github-observation{,-fixed}.jpg`。浏览器随后发生 CDP 超时，后续关闭页面操作也未确认成功；未把失败写成通过。临时预览服务由主会话单独停止，未开启自动监督。最终 Runtime 集成后仍需完整闭环验收。
