# T003A 结果：可恢复、可取消的真实 Pi 进程 Adapter

- `run_id`: `T003A-r1-20261117T162027Z`
- `attempt`: `2`
- `requirements_rev`: `sha256:5a071bd27e2518499a72ddd7a24b55930369dba0c77ea67d5e29af34c21625c0`
- `template_ref`: `9b30d4c6d6b84ce93c84b203417ef1bd058e322a:templates/development/1.1.0.md`

## summary

在首轮 Pi 进程 Adapter 基础上完成独立核验返修，范围仍限 T003A 的四个文件。本轮修复两项真实缺陷：取消/退出时对持管道 detached 后代的误报，以及超长记录截断产生的非法 JSONL。

- `src/pi-adapter.mjs`：公开异步 `start/status/cancel/list`，校验参数，持久化请求，启动脱离父进程生命周期的 monitor，读取完成/失败/取消/未知状态，按进程身份取消。本轮将 `unknown` 纳入有效最终结果，使 `status/list/cancel` 一致识别。
- `src/pi-monitor.mjs`：独立进程消费 Pi JSONL，过滤逐字增量与思考块，维护有界进展和大小上限日志，原子写入最终结果。本轮在强制关闭管道时记录 `unknown`；超长记录改为字段级截断后重新序列化。
- `test/pi-adapter.test.mjs`：用临时目录生成的 fake Pi 覆盖启动、模型/工具参数、会话隔离、同 id 拒绝、正常与失败语义、恢复、取消、身份篡改、monitor 消失、后代持管道、日志上限和半写结果；本轮新增两条 detached 持管道回归与一条超长错误 JSONL 回归。
- 未实现 HTTP、GitHub、Git worktree 管理或 UI；未修改任务范围外文件；未提交 Git。

## 首轮结果与独立发现

首轮（`attempt: 1`）交付 7 项 Adapter 测试，`npm test` 34/34 通过，主会话保存为任务分支提交。

主会话独立核验复现两项缺陷：

1. **取消误报成功**：fake Pi 用 `detached: true, stdio: ['ignore','inherit','inherit']` 启动后代并保持父进程运行时，`cancel` 返回 `{"returnedState":"cancelled","escapedDescendantStillAlive":true}`。首轮只确认原进程组消失，无法证明仍持有输出管道的 detached 后代已结束，却仍以 `cancelled/completed` 落盘。
2. **截断产生非法 JSON**：fake Pi 输出 `stopReason:error`、`errorMessage:'x'.repeat(20000)` 与合法 `agent_end` 后，首轮 `events.jsonl` 出现 1 行无法 `JSON.parse`。原因是 `compactJson` 直接截断序列化字符串再拼接。

以上是主会话独立发现，不是首轮 Worker 自报通过的内容。

## artifacts

- `src/pi-adapter.mjs`
- `src/pi-monitor.mjs`
- `test/pi-adapter.test.mjs`
- `docs/worker-trials/T003A-result.md`（本文件）

### 运行目录结构

```text
<runRoot>/<id>/
  request.json        # cwd、role、prompt 文件、session、命令、provider、grace
  prompt.md           # 原始 prompt，通过 @file 传给 Pi
  session/            # 每次请求独立 --session-dir
  process.json        # monitor 与 Pi 的 pid/pgid/ps lstart 身份
  progress.json       # 有界近期进展快照
  events.jsonl        # 过滤后的关键事件，256 KiB 上限
  cancel.json         # 取消请求标记（仅在身份核验后写入）
  result.json         # 原子写入的最终结果
```

Pi 固定参数为：

```text
--provider <provider> --model deepseek-flash --thinking high --print --mode json
--no-extensions --no-mcp --no-skills --no-prompt-templates
--session-dir <任务目录>/session --session-id <uuid>
draft: --no-tools
worker: --tools read,bash,edit,write,grep,find,ls
-- @<任务目录>/prompt.md
```

执行使用 `spawn(command, argv)`，不经过 shell；未读取、复制或输出凭据，未修改用户 Pi 配置。

## evidence

### 真实红绿验证（本轮）

先加入三条回归，在修复前实际运行并确认失败（红）：

```sh
node --test --test-name-pattern='detached|超长错误' test/pi-adapter.test.mjs
```

修复前结果：3 项全部失败，0 通过。

- `取消时 detached 后代仍持管道…`：实际 `cancelled`，期望 `unknown`。
- `超长错误消息截断后…`：第 3 行 `JSON.parse` 报 `Expected ',' or '}' after property value in JSON at position 8001`。
- `Pi 退出后 detached 后代仍持管道…`：实际 `completed`，期望 `unknown`。

修复后同一命令：3/3 通过。随后运行完整 Adapter 测试与项目测试：

```sh
node --test test/pi-adapter.test.mjs   # 9/9
npm test                                # 36/36
```

### passed

1. **语法检查**

   ```sh
   node --check src/pi-adapter.mjs
   node --check src/pi-monitor.mjs
   node --check test/pi-adapter.test.mjs
   ```

   结果：三条命令均退出 0，汇总输出 `SYNTAX_OK`。

2. **Adapter 测试**

   ```sh
   node --test test/pi-adapter.test.mjs
   ```

   结果：9/9 通过（连续多次复跑均通过）。覆盖首轮 7 项与本轮新增 2 项：

   - `start` 在 fake Pi 延迟 1.5 秒的情况下仍立即返回 `running`；
   - fake Pi 实际收到固定 provider/model/thinking/print/json、禁用 discovery 参数、`--session-dir`、`--session-id`；worker 使用七个工具，draft 使用 `--no-tools` 且无 `--tools`；prompt 通过 `@file` 传入；
   - 不同 id 的 session 目录与 session id 不同；同 id 再次启动被拒绝；
   - 正常 JSONL 的工具事件与最终 assistant 文本进入结果；`thinking_delta`、`text_delta`、工具 partial 不进入 output/progress/events；
   - 退出码 0 但 assistant `stopReason=error`、异常退出、JSONL 截断、缺少最终 assistant、缺少 `agent_end` 均为 `failed`；
   - 新建 `PiAdapter` 恢复已完成结果和运行中记录，不重新启动任务；`list` 返回两个任务；
   - 运行中取消返回 `cancelled`，Pi 与同进程组后代均停止；忽略 TERM 时在宽限后升级 KILL 并确认停止；
   - 篡改 `process.json` 将 Pi PID 指向当前测试进程时，`cancel` 拒绝发送信号，测试进程仍存活；
   - monitor 被杀死且没有结果时，`status` 为 `unknown` 且保留任务目录；
   - Pi 退出后 detached 后代仍持有 stdout 时，monitor 在 5 秒内以有效 `unknown` 结束并写入原因，不误报 `completed`；
   - 取消时 detached 后代仍持有 stdout 时，`cancel/status/list` 一致返回有效 `unknown`，不误报 `cancelled`；
   - 20000 字符错误消息截断后，`events.jsonl` 每行均为合法 JSON；
   - 4000 条工具事件达到日志上限后，`events.jsonl` 不超过 `256 KiB`，结果仍为 `completed`，并记录 `logCapped: true`；
   - 损坏/半写，以及 JSON 合法但缺少 `startedAt/output/progress` 的 `result.json` 均返回 `unknown`，`cancel` 拒绝。

3. **完整项目测试**

   ```sh
   npm test
   ```

   结果：36/36 通过，0 失败。既有 27 项测试全部保留并通过；Adapter 测试由首轮 7 项增至 9 项。

4. **本轮缺陷回归（红→绿）**

   - **Pi 退出后 detached 后代持管道**：父 fake Pi 正常结束并退出，detached 后代继承 stdout/stderr 持续存活。monitor 在清理自有进程组后等待有界时间仍无 EOF，记录 `state: unknown` 并保留原因；测试同时确认后代仍存活，未被凭不确定身份追杀，随后在 `finally`/`t.after` 中回收自有 PID。
   - **取消时 detached 后代持管道**：取消返回、`status`、`list` 三处一致为有效 `unknown`，错误信息提到无法确认管道持有者，不再出现“无法解析/损坏”；后代同样保持存活并在测试结束回收。
   - **超长错误消息**：20000 字符 `errorMessage` 经字段级截断后重新 `JSON.stringify`；`events.jsonl` 每行均可 `JSON.parse`，日志仍受 256 KiB 上限约束，`result.json` 仍写出 `failed` 结果并保留退出码 0。
   - 正常清理成功路径仍返回原有 `completed/cancelled`：既有正常、失败、取消、忽略 TERM、日志上限等测试全部通过。

5. **参数与平台行为**

   - fake Pi 和 CLI `pi --help` 用于核对实际参数名；本机 `pi --version` 为 `1.5.2`。
   - `win32` 上 `start/cancel` 明确报错；`cancel` 在 macOS/POSIX 使用 `ps` 的 pid/pgid/lstart 身份，再向负 pgid 发送 TERM/KILL。
   - 日志上限常量为 `256 * 1024` 字节；最终结果使用同目录临时文件加 rename 原子写入。

### not_run

- **真实 Pi 模型调用未由本 Worker 执行。** 任务稿明确要求真实模型由主会话另外验证；上述“固定参数”“通过测试”均来自 fake Pi，不代表真实 provider/凭据/模型调用已验证。
- **Linux 及其他 POSIX 平台未实测。** 实现只依赖 `ps`、负 PID 进程组信号和 `/bin` 环境；macOS 已测试，其他 POSIX 平台仍需验证。
- **HTTP、GitHub、Git worktree、服务进程重启下的 Adapter 重建以外的调度集成未实现**，不在本任务范围。

### 实现局限

- monitor 只清理 Pi 自身进程组内的后代；如果后代主动 `setsid`/脱离进程组并继续持有输出管道，monitor 会在有界时间以 `unknown` 结束（含原因），但不会凭不确定身份追杀该脱离进程。此时 `unknown` 表示“无法确认已停止”，不表示已停止；残留后代需由上层或测试按自有 PID 回收。
- 若脱离进程已关闭 stdout/stderr，管道可正常 EOF，此时按原有 `completed/cancelled` 语义落盘。
- 取消时若 monitor 已消失且没有最终结果，Adapter 按 `unknown` 处理并拒绝发送信号，保留现场，不自动重跑。
- 进程身份依赖 `ps -o lstart=` 文本；macOS 已覆盖，跨平台文本差异未验证。
- `cancel` 在已存在最终结果时直接返回该结果；只有身份核验通过且进程确实停止后才写 `cancelled`。
- 真实 Pi 若输出额外非 JSON 诊断到 stdout，会被视为 JSONL 解析错误并以 `failed` 结束；标准约定是 stdout 仅 JSONL、诊断走 stderr。

## blockers

无。真实 Pi 调用验证与合并决策由主会话按项目授权执行。
