# SP001 v1：SOP 执行进度只读展示

用户于 2026-11-19 批准自主推进上一条建议范围。仅展示已有 SOP 控制记录，不新增调度、自动审批、返工策略、消息总线或流程编辑器，不自动合并功能 PR。

## 两路开发

- develop-a：只改 `src/runtime.mjs`。在 `getState().runs[]` 增加 `sop`，无 SOP 为 null；按白名单返回 `{status,lanes:[{id,path,status,attempt,piStatus,feedback}],reworks:[{step,stage,reason}],checks:[{lane,command,status,detail}],review:null|{round,status,acceptance},holdReason}`。review.status 来自 piStatus，已生成 sop.result 时为 approved。feedback 仅 stage/reason；不得把 prompt、task.context、内部 worktree 或整个 control 直接发送前端，不新增 mutation，不改变执行行为。读取不得写 control 或 workflow。
- develop-b：只改 `public/app.js`。新增 `renderSopProgress(run)`，无 sop 返回 null；复用 h、badge、现有 class，显示两路 id/文件/状态/第几次尝试、返工阶段与原始原因、健康一路保持完成、逐项实际检查状态/命令/详情、独立代码评审状态/逐项证据、holdReason。必须在候选详情 `renderCandidateProgress` 和执行卡 `renderRunCard` 接入；最终 PR 链接沿用已有安全 externalLink/renderResultCore。中文标签，所有记录为文本节点，禁止 innerHTML；不新增操作按钮或改CSS/HTML。

两路开发者使用同一 interface，不依赖另一 lane 工作树。全部由 Runtime 与真实 Pi 创建独立会话/分支/worktree。

## 验收

1. getState 对旧单Worker、开发中、返工、检查、评审与交付后的 Run 正确投影；只读、无 prompt/context 泄露。
2. 两处页面显示两路进度、准确返工原因、测试/评审结果和最终 PR 链接；缺少 SOP 的旧 Run 不出现空面板；恶意HTML仅当文本显示。
3. 基线固定 `test/sop-progress.test.mjs`，两路分别运行 `node test/sop-progress.test.mjs backend` / `frontend`；汇总后运行项目全量测试并做独立代码验收。同一产物提交真实功能 PR。
4. 浏览器验证使用真实 Runtime 与真实 SOP 历史记录，核对页面文字与原始 control；不把夹具状态冒称真实任务。测试与最终证据写入中央目录，不写入 lane 文件。

## 现有限制与交付形态

SOP v1 每路仅一个文件，checks 只能引用预先存在于基线的Node脚本。本任务不扩展这些限制：主会话先提交检查与本稿为功能准备基线，再由工作台提交两路实现 PR 到该准备分支；最终将准备基线和实现提交汇为面向集成分支的功能交付，明确区分 Runtime 自动PR与最终集成PR，不声称现有引擎已能任意多文件任务或自动拆解。新增测试在现有测试体系内，不加依赖。
