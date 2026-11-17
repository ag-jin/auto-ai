# T001 结果：可追溯的 Worker 执行包

执行者：Pi，`facaiai-deepseek / deepseek-flash / high`。执行位置：仓库根目录。基础提交：`c6facf452e7a1179e915f4a0df3999d9ddf912f5`。

## summary

已实现 `prepareTask` 库函数与 `scripts/prepare-task.mjs` CLI，按任务稿生成固定 commit 模板、规范化输入和 `requirements_rev` 的执行包。新增最小 `package.json`，`npm test` 使用 Node 内置测试运行器，不下载依赖。任务稿中的两条 CLI 示例均已实际运行成功。

独立核验 r1 发现稀疏验收数组可绕过校验。返修已将验收校验改为逐索引检查，并补充 `Array(1)` 与 `['ok', , 'later']` 回归。本轮复核时工作区已包含该基础修复；在此之上又加固为“先确认索引是否为数组自身属性”，并新增“原型可读出值的纯空洞”回归，避免空洞因原型链取值而被当成合法验收项。返修后 `npm test` 10/10 通过；最小复现、混合空洞和新增空洞用例均被拒绝。未提交 Git。

## artifacts

- `package.json`：ES module，`npm test` 执行 `node --test`。
- `src/prepare-task.mjs`：导出异步 `prepareTask({ repoDir, ref = 'HEAD', templatePath, task })`，只读 Git，不写文件。
- `scripts/prepare-task.mjs`：CLI 参数解析、stdout/文件输出、错误退出。
- `test/prepare-task.test.mjs`：10 个业务测试，覆盖字段、摘要、输入校验、稀疏数组（含原型可读空洞）、路径/ref/模板错误、固定旧 commit、CLI 输出与失败保护。
- `examples/task.json`：任务稿示例输入。
- `.auto-ai/T001-packet.json`：实际运行生成的执行包（被 `.gitignore` 忽略）。
- 本文件：`docs/worker-trials/T001-result.md`。

## evidence

### 环境

```text
node v22.23.1
npm 10.9.8
git version 2.39.2 (Apple Git-143)
```

### 首轮自测（首轮实现）

命令：

```sh
npm test
```

最初自测最终 10/10 通过。开发过程中首次运行出现过 2 个测试失败，均为测试代码问题：一处测试夹具上下文不一致；一处嵌套 `node --test` 继承 `NODE_TEST_CONTEXT` 后跳过子测试。修正后通过，实现代码未因此改变。该轮还包含一个验证 Node 测试运行器失败退出的元测试。

最初自测覆盖的关键断言：

- 返回对象键恰好为 `schema_version, issue_ref, run_id, attempt, template_ref, requirements_rev, inputs, template_text`；`inputs` 键顺序为 `goal, acceptance, scope, context`。
- 额外字段、输入键顺序、首尾空白不改变摘要；验收内容或顺序改变会改变摘要。
- 缺少目标、空验收、空项、非字符串项、非法 `issue_ref`、非法 `attempt`、非法 `run_id`、非字符串 `scope/context` 均被拒绝。
- 绝对路径、反斜杠、空路径段、`.`、`..`、非 `templates/`、非 `.md`、空路径被拒绝；无效 ref、缺失模板被拒绝。
- 临时 Git 仓库先提交旧模板，再提交新版并留下未提交改动；指定旧 commit 时返回旧文本和旧完整 SHA，`HEAD` 返回新版文本。
- CLI stdout 只含 JSON；`--out` 创建父目录；已有输出文件时失败且内容不变；非法输入不创建输出文件；未知参数、缺值、缺必填参数均非零退出且 stdout 为空。

### 独立核验发现（r1）

核验使用如下最小复现：

```sh
node --input-type=module - <<'JS'
import { prepareTask } from './src/prepare-task.mjs';
const task = {
  issue_ref: 'ag-jin/auto-ai#123',
  run_id: 'review-sparse',
  attempt: 1,
  inputs: { goal: 'test', acceptance: Array(1) }
};
try {
  const packet = await prepareTask({
    repoDir: process.cwd(),
    templatePath: 'templates/development/1.0.0.md',
    task
  });
  console.log(JSON.stringify(packet.inputs));
  process.exitCode = 1;
} catch (error) {
  console.log('rejected:', error.message);
}
JS
```

返修前实际结果：调用成功，序列化为 `acceptance: [null]`。原因是 `Array.prototype.map` 跳过稀疏数组空洞，未对每个索引执行字符串校验。原合同要求每项都是非空字符串，因此该输入应被拒绝。

### 本轮返修结果（fix-1）

首轮实现使用 `acceptance.map(...)` 构造规范化数组；`Array.prototype.map` 会跳过稀疏数组空洞，因此 `Array(1)` 可成功返回 `acceptance: [null]`。独立核验 r1 已实际复现该行为。

进入本轮时，工作区已经包含上一轮针对该问题的显式索引循环修复，以及 `Array(1)`、`['ok', , 'later']` 两个回归；因此直接重跑原始最小复现时，当前工作区已拒绝输入。为避免把既有修复误报为本轮新修复，本轮在原有基础上继续加固并做红绿验证：

- 新增“原型可读出值的纯空洞”用例：`new Array(1)` 自身没有索引 `0`，但其原型提供 `'inherited acceptance'`。仅按索引读取会把该值当成合法字符串，因此这是一个仍能绕过原索引循环的真实稀疏数组边界。
- 修复方式：先对每个索引执行 `Object.prototype.hasOwnProperty.call(...)` 检查，再检查字符串类型与非空；自身缺失的索引统一以 `acceptance[index] must be a string` 拒绝。
- 合法非空字符串数组仍正常 trim、保持顺序并生成摘要；失败与成功路径都不修改传入任务对象。

加固前，定向运行稀疏数组回归实际失败：

```text
not ok 1 - rejects sparse acceptance arrays without mutating the task
Missing expected rejection.
# pass 0
# fail 1
```

加固后，同一回归通过。完整测试结果：

```sh
npm test
```

```text
# tests 10
# pass 10
# fail 0
```

本轮实际最小复现与合法输入核对：

```text
pure (Array(1))          -> rejected: task.inputs.acceptance[0] must be a string
mixed ['ok', , 'later']  -> rejected: task.inputs.acceptance[1] must be a string
inherited hole           -> rejected: task.inputs.acceptance[0] must be a string
valid ['  valid one  ', 'valid two'] -> SUCCESS ["valid one","valid two"]
```

回归测试 `rejects sparse acceptance arrays without mutating the task` 现覆盖：

- `Array(1)`：以 `acceptance[0] must be a string` 拒绝。
- `['ok', , 'later']`：以 `acceptance[1] must be a string` 拒绝。
- 原型可读出值的纯空洞：仍以 `acceptance[0] must be a string` 拒绝，且空洞保持为自身缺失。
- 前置用例在失败调用后，原任务对象与调用前深比较一致；正常成功路径也有同样核对。

已移除“测试 Node 自身失败退出”的元测试。CLI 非法输入/参数用例继续证明：错误时非零退出、stdout 为空、已有输出文件受保护。

### CLI 示例 1：stdout

命令：

```sh
node scripts/prepare-task.mjs --input examples/task.json --template templates/development/1.0.0.md --ref HEAD > /tmp/T001-stdout.json
```

结果：退出码 0；stdout 为单个 JSON，可被 `JSON.parse` 解析；未混入进度消息。关键字段：

```json
{
  "schema_version": 1,
  "issue_ref": "ag-jin/auto-ai#123",
  "run_id": "T001-example",
  "attempt": 1,
  "template_ref": "c6facf452e7a1179e915f4a0df3999d9ddf912f5:templates/development/1.0.0.md",
  "requirements_rev": "sha256:0135c43ca6bbdedf8bce925a70bc1aeafc6cf6c492a3892cd7af1dda38eb3258"
}
```

### CLI 示例 2：文件输出

命令：

```sh
rm -f .auto-ai/T001-packet.json
node scripts/prepare-task.mjs --input examples/task.json --template templates/development/1.0.0.md --ref HEAD --out .auto-ai/T001-packet.json
```

结果：退出码 0；stdout 为空；文件生成成功。`cmp` 比较文件输出与示例 1 的 stdout，完全一致。

模板固定性核对：

```text
git cat-file blob c6facf452e7a1179e915f4a0df3999d9ddf912f5:templates/development/1.0.0.md
  -> sha256 37474b2d13e42a9f33a2030a3e39b26c96b8ccef8204d7ca9e8bbe8bc0f2cd58
执行包内 template_text 重新计算
  -> sha256 37474b2d13e42a9f33a2030a3e39b26c96b8ccef8204d7ca9e8bbe8bc0f2cd58
```

说明：当前工作区模板与 `c6facf4` 的模板内容一致，因此另由临时仓库测试覆盖“工作区未提交改动不得被读取”的情况。

### 失败保护

已有输出文件：

```sh
node scripts/prepare-task.mjs --input examples/task.json --template templates/development/1.0.0.md --ref HEAD --out .auto-ai/T001-packet.json
```

结果：退出码 1；stdout 0 字节；stderr 包含 `Output file already exists`；输出文件哈希前后一致。

非法输入：

```sh
node scripts/prepare-task.mjs --input <bad.json> --template templates/development/1.0.0.md --out <tmp>/packet.json
```

其中 `attempt` 为 0。结果：退出码 1；stdout 0 字节；stderr 首行 `prepare-task: task.attempt must be a positive integer`；输出文件未创建。

## blockers

无。

## 未验证内容

- 仅在 Node v22.23.1、Git 2.39.2、macOS 上运行；未在 Windows、Linux 或其他 Git 版本验证。
- 代码接受 40 或 64 位十六进制完整 commit SHA，但未在 SHA-256 Git 仓库中实际测试。
- 未实现任务稿明确排除的 catalog 选择、YAML 元数据解析、模板迁移和调度系统。
- 未测试并发写同一输出文件；当前使用 `open(..., 'wx')` 保证不覆盖已有文件，但未做并发压力测试。
- 稀疏数组只覆盖 `Array(1)`、`['ok', , 'later']` 与“原型可读出值”的纯空洞；未穷举所有 JavaScript 数组形态、可继承索引或原型污染组合，不宣称覆盖所有可能输入。

## 任务稿中不明确之处与本实现的选择

- `issue_ref` 与 `run_id` 是否应去除首尾空白未明确；本实现对二者 trim 后校验。`inputs` 内字符串按任务稿要求 trim。
- “正整数”是否允许前导零未明确；本实现要求首位为 `1-9`，因此 `#0`、`#01` 被拒绝。
- CLI 重复参数未规定；本实现后者覆盖前者（`--input`、`--template` 的必填判断不受影响）。
- 文件输出末尾是否应加换行未规定；本实现输出格式化 JSON 后追加一个换行。库函数返回的 `template_text` 保持 Git blob 原文，不做换行归一化。
- 错误消息文本未规定；本实现只保证非零退出、stderr 可读、stdout 为空。
