# T003A 独立核验返修 r1

范围仍限 T003A 的 Adapter、monitor、测试和结果文档。固定 Pi deepseek-flash / high。初版已由主会话保存为任务分支提交，34 项测试通过；下面两项是主会话真实复现的缺陷。

## 1. 取消不能在后代仍持有管道时宣称成功

用 fake Pi 创建 `spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], {detached:true,stdio:['ignore','inherit','inherit']})`，将 child.pid 写入任务目录，父 fake Pi 自身保持运行。Adapter 正常 start 后调用 cancel。

主会话实际结果：

```json
{"returnedState":"cancelled","escapedDescendantStillAlive":true,"error":"任务已取消"}
```

原因：只确认原进程组消失，无法证明仍持有输出管道的 detached 后代已结束；monitor 强制关闭管道后仍以 cancelled/completed 落盘。

要求：可安全核对身份的自有进程继续清理；若无法确认清理且输出管道仍被持有，在有界时间记录明确的 unknown（含原因），不能返回 cancelled/completed。不要凭不确定身份追杀其他进程。status/list/cancel 要一致识别该有效未知结果；它不是“JSON 损坏”。正常清理成功的场景仍返回原有完成/取消状态。

补回归覆盖“父 Pi 退出后 detached 后代持管道”及“取消时 detached 后代持管道”。测试自行保留 PID 并在 finally 清理自有后代，不能留下孤儿。原测试把后一类不完整清理当 completed 的断言应改为符合上述语义。

## 2. 超长记录截断后仍应是合法 JSONL

fake Pi 输出 assistant `stopReason:error`、`errorMessage:'x'.repeat(20000)` 与合法 agent_end，退出码为 0。主会话解析保存的 events.jsonl，实际得到：

```json
{"state":"failed","totalStoredEventLines":2,"invalidStoredEventLines":1}
```

`compactJson` 对序列化后的字符串直接截断再拼接，产生非法 JSON。改为在对象/字段层截断后重新 JSON.stringify，或生成合法的简短替代对象。所有保存行都能 JSON.parse，日志总上限与最终结果保存保持有效。

## 验收与回报

先加入确实在修复前失败的回归，再修复并运行 npm test。保留全部既有测试和模型参数约定。更新结果文档区分首轮结果、独立发现、真实红绿验证、剩余局限；最终未知状态不能被描述成已停止。

主会话负责集成/推送/回收，不提交 Git，不合并 PR。
