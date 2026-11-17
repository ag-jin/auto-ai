# T003A：可恢复、可取消的 Pi 执行器

执行者 Pi，`deepseek-flash / high`；在独立 worktree 实施。先读 AGENTS、CONTEXT_CARD。本任务只实现一个真实进程 Adapter，不做 HTTP、GitHub、Git 工作树管理或 UI。

## 范围与 Interface

Node.js 22+ 内置模块。允许新增 `src/pi-adapter.mjs`、`src/pi-monitor.mjs`、`test/pi-adapter.test.mjs`、`docs/worker-trials/T003A-result.md`。测试替身在临时目录生成，不修改其他文件，不提交 Git。

导出 `PiAdapter` class：

```js
new PiAdapter({ runRoot, command = 'pi', prefixArgs = [], provider = 'facaiai-deepseek', stopGraceMs = 2000 })
await adapter.start({ id, cwd, prompt, role = 'worker' })
await adapter.status(id)
await adapter.cancel(id)
await adapter.list()
```

所有公开方法 async。id 为安全的单段标识（字母、数字、连字符、下划线），cwd 为存在的目录，prompt 为非空文本，role 为 draft/worker。runRoot 保存每次请求、进程身份、会话、必要事件与结果。command/prefixArgs 用于注入测试替身，执行使用 argv，不经过 shell。

## 启动与模型

- 固定 `--provider <provider> --model deepseek-flash --thinking high --print --mode json`，禁用 extensions/MCP/skills/prompt-template discovery；每次独立 session-dir 与会话标识。
- draft 角色使用 `--no-tools`；worker 使用 `read,bash,edit,write,grep,find,ls`。凭据由 Pi 已有环境提供，不读取、复制或输出凭据，不修改用户配置。
- prompt 写入任务目录的文件，并由 Pi 的 @file 方式输入，避免 shell 注入和超长 argv。
- start 持久保存请求并启动独立 monitor，快速返回 `{id,state:'running',dir,monitorPid,sessionId}`，不能等待模型完成。同 id 已存在时拒绝，保留现场，避免重复执行。
- monitor 脱离服务进程生命周期；服务重建 PiAdapter 后仍可读取状态与结果，不重启同一任务。

## 事件与结果

status/list 返回至少 `{id,state,dir,monitorPid,sessionId,startedAt,endedAt,output,error,exitCode,progress}`。state 为 running/completed/failed/cancelled/unknown。output 为最后一条已完成 assistant 的文本；error 为可读原因；progress 是有界的近期 `{at,phase,message}` 数组。

- 消费 Pi JSONL，保留关键完成/工具事件与最终结果；丢弃逐字 message_update，避免日志随字符重复膨胀。模型思考块不进入 progress/output。
- 必须见到有效 agent_end 和正常 assistant 完成。exitCode=0 但模型 stopReason=error/aborted、errorMessage、缺少最终结果或 JSONL 截断不能标为 completed。
- monitor 原子写入最终结果文件，保留 id、退出结果与时间；读取半写数据不能伪装成功。日志有明确大小上限，达到上限仍能保存最终结果。
- 错误与无效参数返回清晰错误。没有记录或结果不明进入 unknown/报错，不能自动重跑。

## 取消与恢复

- start 保存足够核对 monitor/子进程身份的信息。cancel 先核对身份再发信号，不能只凭可能复用的 PID 杀进程。
- 给自有 Pi 进程组发送 TERM，超时后必要时 KILL；处理子进程/后代持有 stdout 的情况。未确认停止时不得标成 cancelled。
- 即使 Pi 已退出但后代还持有输出管道，monitor 也必须在有界时间完成清理与结果落盘。
- monitor 消失且没有最终记录时为 unknown，保留目录。篡改 PID 指向当前测试进程时 cancel 必须拒绝信号，不能伤及不相关进程。
- 目标为本机 macOS/POSIX；其他平台若无法保证进程组语义，应明确失败或标记未验证。

## 必须实际测试

使用临时 fake Pi 可执行脚本（Node + prefixArgs），输出 Pi JSONL 并可拉起后代。至少覆盖：

1. 启动立即返回、固定模型/high/角色工具参数、不同 id 会话隔离、同 id 拒绝。
2. 正常完整输出与工具进展，思考/逐字增量不进入用户输出；进程退出 0 但 error stopReason 失败，异常退出/截断失败。
3. 创建新 PiAdapter 后恢复已完成/运行中的记录，不重复启动。
4. 运行取消，后代输出持管道，不匹配 PID 身份拒绝，不存在 id 与无效参数。
5. 日志上限与最终结果并存。

运行 `npm test`，保留全部既有测试。文档写实际命令、通过/未验证事项与实现局限；真实模型由主会话另外验证，不使用测试替身结果宣称真实 Pi 调用通过。
