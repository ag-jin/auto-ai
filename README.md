# auto-ai
auto-ai

用可迭代的标准模板安排事情，由一个主会话接收信息、监督 GitHub Issue，并调度 Worker 执行。

首版以 GitHub 作为任务入口与结果记录，先跑通一个任务的完整闭环。

```mermaid
flowchart LR
    A[消息或 GitHub Issue] --> C[规则筛选与候选池]
    C --> M[主会话整理任务稿]
    T[版本化执行模板] --> M
    M --> U[用户选择开发 / 暂缓 / 忽略]
    U -->|确认开发| W[Worker 执行]
    W --> E[产物与验证证据]
    E --> R[用户和设计监督验收]
    R -->|明确合并| G[更新 Issue / 关联 PR]
    G -->|新要求或检查结果| M
```

## 四个核心概念

| 概念 | 负责什么 |
| --- | --- |
| Issue | 一件具体的事：目标、范围、验收要求、补充信息与结果 |
| 执行模板 | 一类事情的标准处理方法，可独立迭代升级 |
| 主会话 | 选择模板、补齐参数、安排 Worker、监督进展、核验结果 |
| Worker | 按任务与模板执行，返回产物、证据或具体阻塞 |

用户不需要管理底层 Session 或手动拆出完整步骤树。

规则命中只表示进入候选池；对应任务稿经用户确认开发后才能安排 Worker。执行者准备 PR，最终合并由用户和设计监督验收后明确发起。

## 模板与版本

- [默认模板目录](templates/catalog.yml)：主会话从这里找到当前采用的版本。
- [开发交付 v1.2.0](templates/development/1.2.0.md)：确认、并行执行、核验、交付；保留 v1.0.0/v1.1.0 固定引用。
- [调研交付 v1.0.0](templates/research/1.0.0.md)：收敛问题、核对来源、比较与结论。
- [GitHub 任务表单](.github/ISSUE_TEMPLATE/task.yml)：只收集输入，执行方法由主会话选择。

每次开工固定模板的路径、版本和 Git commit。模板升级只影响后续新任务；在途任务沿用原版本，除非主会话明确安排迁移。

模板改进的闭环：实际任务暴露问题 → 修改模板并验证案例 → 发布新版本 → 更新默认指针。

## 当前状态

已用 Pi 的 `deepseek-flash / high` 完成首个开发任务与返修，提供可运行的执行包生成器。任务稿格式见 [WORKER_BRIEF.md](docs/WORKER_BRIEF.md)，实际记录见 [T001](docs/worker-trials/T001-task.md) 与其结果文档。

Node.js 22+ 与 Git 环境下，无需安装依赖：

```sh
npm test
npm run check:trial
node scripts/prepare-task.mjs --input examples/task.json --template templates/development/1.2.0.md --ref HEAD
```

另已实现 SQLite 授权/调度核心与前端初版。CLI 当前显式接受模板路径；catalog 自动选择和 HTTP 联调仍在实施。**尚未实现完整的 Issue 监听和自动 Worker 调度。创建 Issue 不会自动开始执行。**

运行设计、状态与恢复约定见 [DESIGN.md](docs/DESIGN.md)。下一步实施范围见 [EXECUTION_ROUTE.md](docs/EXECUTION_ROUTE.md)。

## 本地 HTTP 工作台

后端与接口约定见 [RUNTIME_CONTRACT.md](docs/RUNTIME_CONTRACT.md) 与 [HTTP_CONTRACT.md](docs/HTTP_CONTRACT.md)。HTTP 层只调用 Runtime Interface，不直接读数据库或运行清单。

安装依赖（当前仅 `yaml@2.9.1`；Node.js 22+）：

```sh
npm install
```

启动工作台（需要已集成 `src/runtime.mjs`；未集成时会明确报错，不会用 mock 替代生产后端）：

```sh
npm start -- --host 127.0.0.1 --port 4310 --app-repo-dir /path/to/auto-ai
```

- `--host` 仅允许 loopback，默认 `127.0.0.1`。
- `--port` 默认 `4310`。
- `--data-dir` 默认 `<app-repo-dir>/.auto-ai/app`。
- `--app-repo-dir` 默认当前目录。
- 启动会输出实际地址、数据目录与应用仓库；`SIGINT`/`SIGTERM` 会关闭 HTTP 与 Runtime。

服务只绑定 loopback，写请求需要同源来源与内存中的 `X-Auto-AI-Token`；令牌来自同源 `GET /api/state`，不通过 CORS 暴露，Worker 不获得工作台令牌。

检查与测试：

```sh
node --check public/app.js
node --test test/http-server.test.mjs
npm test
```

`test/http-server.test.mjs` 使用注入的 fake Runtime 验证路由、授权、CAS 409、Host/Origin/令牌、非法 JSON、超大请求、路径穿越、符号链接越界、响应脱敏与关闭流程。它覆盖 HTTP 层合同，不等于连接真实 GitHub/Pi 的完整线上验收；真实后端联调与浏览器最终检查需在 Runtime 集成后由主会话完成。
