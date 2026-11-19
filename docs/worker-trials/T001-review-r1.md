# T001 独立核验反馈 r1

原任务稿保持有效。本轮是原任务返修，模型仍为 `facaiai-deepseek / deepseek-flash / high`。

## 必须修复：稀疏验收数组绕过校验

最小复现，在项目根目录运行：

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

实际：调用成功，序列化得到 `acceptance: [null]`。

预期：拒绝该输入。原合同要求数组中的每项都是非空字符串；空洞不能变成合法验收条件。

修复并补回归，至少覆盖 `Array(1)` 和 `['ok', , 'later']`。修复应保留现有正常输入、顺序、摘要与不修改传入对象的行为。

## 精简验收中的无关工作

原稿“npm test 会在断言失败时返回非零”只是对检查入口的要求，不要求实现一个测试 Node 自身的元测试。移除该元测试；保留业务测试，使用 CLI 的非法输入/参数用例证明错误时非零退出、stdout 为空、输出受保护。

## 回报与范围

修改范围仍沿用原稿。结果记录中将个人工作目录替换为“仓库根目录”，保留可复现的相对路径。更新 T001-result.md，区分最初自测、独立核验发现和本轮修复结果；实际重新运行测试与最小复现后回报。Git 提交由主会话处理。
