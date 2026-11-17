# T001：生成可追溯的 Worker 执行包

版本：1。类型：开发任务。执行者：Pi，`facaiai-deepseek / deepseek-flash / high`。

## 目标与完成条件

实现一个本地执行包生成器：将任务 JSON 与 Git 中固定版本的模板组装成可独立交给 Worker 的 JSON。实际运行测试并交付代码与结果记录后完成；本次不开发整个调度系统。

## 执行位置与事实来源

在当前 Git 仓库根目录工作。先读取 `templates/development/1.0.0.md`，按需查阅 `docs/DESIGN.md` 第 5 节。实现以本任务稿的接口与验收为准；发现实质冲突先返回具体问题。

技术选择：Node.js 22+，ES module，使用 Node 内置模块和系统 Git。当前仓库尚无 package.json。添加最小 package.json，提供 `npm test`，无需下载依赖。

允许新增/修改：`package.json`、`src/prepare-task.mjs`、`scripts/prepare-task.mjs`、`test/prepare-task.test.mjs`、`examples/task.json`、`docs/worker-trials/T001-result.md`。运行产物放 `.auto-ai/` 或系统临时目录。保留现有设计、模板、任务稿与 Git 状态；提交与推送由主会话处理。

## 输入与输出合同

导出异步函数：

```js
prepareTask({ repoDir, ref = 'HEAD', templatePath, task })
```

`task` 示例：

```json
{
  "issue_ref": "ag-jin/auto-ai#123",
  "run_id": "T001-example",
  "attempt": 1,
  "inputs": {
    "goal": "修复订单重复提交",
    "acceptance": ["快速连点只产生一笔订单"],
    "scope": "订单提交逻辑",
    "context": ""
  }
}
```

返回对象恰好包含：`schema_version: 1`、`issue_ref`、`run_id`、`attempt`、`template_ref`、`requirements_rev`、`inputs`、`template_text`。

- `issue_ref` 为 `owner/repo#正整数`；`run_id` 为非空字符串；`attempt` 为正整数。
- `inputs.goal` 为非空字符串，`inputs.acceptance` 为至少含一项的非空字符串数组。`scope`、`context` 缺失时补空串，提供时必须是字符串。所有字符串去除首尾空白，数组保留顺序。
- `inputs` 输出键顺序固定为 `goal, acceptance, scope, context`。忽略额外字段。
- `requirements_rev` 是 `sha256:` 加上 `JSON.stringify(规范化后的 inputs)` 的 UTF-8 SHA-256 十六进制摘要。相同有效输入产生相同摘要，验收要求改变后摘要改变。
- `template_ref` 为 Git 解析得到的完整 commit SHA 加 `:` 和模板路径。`template_text` 必须读取这个 commit 下的文本，保留原文；不能读取工作区里的未提交模板。
- `templatePath` 是仓库内 `templates/` 下的相对 `.md` 路径。绝对路径、反斜杠、空路径段、`.`、`..` 路径段应拒绝。路径和 ref 都作为数据传递给 Git，不经 shell 拼接。
- 无效输入、无效 ref 或缺失模板必须报错；库函数不写文件。

首版显式传入模板路径，不做 catalog 选择、YAML 元数据解析或模板迁移。

## CLI 合同

```sh
node scripts/prepare-task.mjs --input examples/task.json --template templates/development/1.0.0.md --ref HEAD
node scripts/prepare-task.mjs --input examples/task.json --template templates/development/1.0.0.md --ref HEAD --out .auto-ai/T001-packet.json
```

`--input`、`--template` 必填；`--ref` 默认 HEAD，`--repo` 默认当前目录。没有 `--out` 时将 JSON 写入 stdout；有 `--out` 时保存 JSON，允许创建父目录，但已有文件保持原样并报错。输入非法时不产生输出文件。错误退出码非零，说明写入 stderr，stdout 不夹带进度消息。未知参数和缺少参数值应报错。

## 验收样例

1. 示例输入能生成字段齐全的执行包，模板内容与固定 commit 一致。
2. 改变无关字段和输入键顺序不改变摘要；改变有效验收要求会改变摘要。
3. 缺少目标、空验收数组、含空项/非字符串的验收数组、不合法的标识或 attempt 被拒绝。
4. 路径越界、无效 ref、缺失模板均被拒绝。
5. 测试在临时 Git 仓库创建旧模板 commit，随后提交新版，并留下未提交改动；指定旧 commit 时仍返回旧文本与旧 SHA。测试不修改项目仓库的 Git 配置或历史。
6. CLI 的 stdout、文件输出与错误退出可实际运行；已有输出文件在失败后内容不变。
7. 失败用例不会产生看似成功的执行包，`npm test` 会在断言失败时返回非零。

## 执行与回报

先检查相关文件，形成短计划，然后实现并运行 `npm test` 与上述 CLI 示例。遇到失败先定位，在范围内修复。缺少影响接口的关键事实时，明确指出需要什么决定，不自行扩大任务。

将实际命令、结果、未验证内容与任务稿中不清楚的地方写入 `docs/worker-trials/T001-result.md`。最后用中文简要回报：`summary`、`artifacts`、`evidence`、`blockers`。无需提交 Git。
