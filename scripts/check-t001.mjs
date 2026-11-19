import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = process.cwd();
await mkdir(path.join(root, '.auto-ai/trials/T001'), { recursive: true });
const { prepareTask } = await import(pathToFileURL(path.join(root, 'src/prepare-task.mjs')));
const temp = await mkdtemp(path.join(os.tmpdir(), 'auto-ai-T001-review-'));
const results = [];
const failures = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, result: 'passed' }); console.log('PASS', name); }
  catch (error) { failures.push({ name, message: error.message }); results.push({ name, result: 'failed', message: error.message }); console.log('FAIL', name, error.message); }
}
const git = (...args) => execFileSync('git', args, { cwd: temp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const templatePath = 'templates/development/1.0.0.md';
const oldText = '\n---\nid: development\nversion: "1.0.0"\n---\n旧版模板：中文与尾部空白  \n';
const source = {
  issue_ref: 'ag-jin/auto-ai#123', run_id: 'review-T001', attempt: 1,
  inputs: { goal: ' 修复订单重复提交 ', acceptance: [' 连点只产生一笔订单 ', ' 单测通过 '], scope: ' 订单页 ', context: ' 参考资料 ' },
};
const expectedInputs = { goal: '修复订单重复提交', acceptance: ['连点只产生一笔订单', '单测通过'], scope: '订单页', context: '参考资料' };
const expectedHash = 'sha256:' + createHash('sha256').update(JSON.stringify(expectedInputs), 'utf8').digest('hex');
const clone = (value) => structuredClone(value);
const absent = async (file) => { try { await access(file); return false; } catch (e) { if (e.code === 'ENOENT') return true; throw e; } };
try {
  git('init', '-q');
  await mkdir(path.join(temp, 'templates/development'), { recursive: true });
  await writeFile(path.join(temp, templatePath), oldText);
  git('add', '.');
  git('-c', 'user.name=Auto AI Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'old template');
  const oldCommit = git('rev-parse', 'HEAD');
  await writeFile(path.join(temp, templatePath), 'new committed template\n');
  git('add', '.');
  git('-c', 'user.name=Auto AI Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'new template');
  await writeFile(path.join(temp, templatePath), 'uncommitted template\n');
  const call = (task = source, extra = {}) => prepareTask({ repoDir: temp, ref: oldCommit, templatePath, task, ...extra });
  const packet = await call();
  await check('exact output contract and UTF-8 hash', async () => {
    assert.deepEqual(Object.keys(packet).sort(), ['schema_version','issue_ref','run_id','attempt','template_ref','requirements_rev','inputs','template_text'].sort());
    assert.equal(packet.schema_version, 1); assert.equal(packet.requirements_rev, expectedHash);
    assert.deepEqual(packet.inputs, expectedInputs);
    assert.equal(packet.template_ref, oldCommit + ':' + templatePath);
    assert.equal(packet.template_text, oldText);
  });
  await check('input and acceptance array remain unchanged', async () => {
    const original = clone(source); await call(source); assert.deepEqual(source, original);
  });
  await check('field order and irrelevant data do not change requirements hash', async () => {
    const task = { ...clone(source), ignored: 'metadata', inputs: { context: source.inputs.context, ignored: 12, scope: source.inputs.scope, acceptance: source.inputs.acceptance, goal: source.inputs.goal } };
    assert.equal((await call(task)).requirements_rev, expectedHash);
  });
  await check('changed acceptance changes requirements hash', async () => {
    const task = clone(source); task.inputs.acceptance[0] = '不同的要求'; assert.notEqual((await call(task)).requirements_rev, expectedHash);
  });
  await check('omitted optional inputs become empty strings', async () => {
    const task = clone(source); delete task.inputs.scope; delete task.inputs.context;
    const result = await call(task); assert.equal(result.inputs.scope, ''); assert.equal(result.inputs.context, '');
  });
  const mutations = [
    ['empty goal', (t) => t.inputs.goal = '   '],
    ['missing goal', (t) => delete t.inputs.goal],
    ['empty acceptance', (t) => t.inputs.acceptance = []],
    ['blank acceptance item', (t) => t.inputs.acceptance = ['ok', '   ']],
    ['non-string acceptance item', (t) => t.inputs.acceptance = [1]],
    ['sparse acceptance array', (t) => t.inputs.acceptance = new Array(1)],
    ['mixed sparse acceptance array', (t) => t.inputs.acceptance = ['valid', , 'later']],
    ['inherited sparse acceptance array', (t) => {
      const array = new Array(1);
      const prototype = Object.create(Array.prototype);
      prototype[0] = 'inherited value';
      Object.setPrototypeOf(array, prototype);
      t.inputs.acceptance = array;
    }],
    ['null scope', (t) => t.inputs.scope = null],
    ['numeric context', (t) => t.inputs.context = 9],
    ['malformed issue ref', (t) => t.issue_ref = 'ag-jin/auto-ai#0'],
    ['missing run id', (t) => delete t.run_id],
    ['fractional attempt', (t) => t.attempt = 1.5],
    ['zero attempt', (t) => t.attempt = 0],
  ];
  for (const [name, mutate] of mutations) await check(name + ' is rejected', async () => {
    const task = clone(source); mutate(task); await assert.rejects(() => call(task));
  });
  for (const template of ['/tmp/template.md', '../README.md', 'templates/../README.md', 'templates//development/1.0.0.md', 'templates/./development/1.0.0.md', 'templates\\development\\1.0.0.md', 'README.md']) {
    await check('reject template path ' + template, () => assert.rejects(() => call(source, { templatePath: template })));
  }
  await check('missing template is rejected', () => assert.rejects(() => call(source, { templatePath: 'templates/missing.md' })));
  await check('invalid ref is rejected', () => assert.rejects(() => call(source, { ref: 'does-not-exist' })));
  await check('ref shell text is treated as data', async () => {
    const marker = path.join(temp, 'INJECTED');
    await assert.rejects(() => call(source, { ref: 'HEAD; touch ' + marker }));
    assert.equal(await absent(marker), true);
  });
  const input = path.join(temp, 'task.json'); await writeFile(input, JSON.stringify(source));
  const cliArgs = [path.join(root, 'scripts/prepare-task.mjs'), '--input', input, '--template', templatePath, '--repo', temp, '--ref', oldCommit];
  const cli = (args = cliArgs) => spawnSync(process.execPath, args, { cwd: temp, encoding: 'utf8' });
  await check('CLI stdout is a complete JSON packet', async () => {
    const result = cli(); assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), packet);
  });
  await check('CLI file output preserves existing files', async () => {
    const output = path.join(temp, 'nested', 'packet.json');
    const result = cli([...cliArgs, '--out', output]); assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), packet);
    const before = await readFile(output, 'utf8');
    const second = cli([...cliArgs, '--out', output]); assert.notEqual(second.status, 0); assert.ok(second.stderr.trim()); assert.equal(second.stdout, '');
    assert.equal(await readFile(output, 'utf8'), before);
  });
  await check('invalid JSON creates no output and leaves stdout clean', async () => {
    const bad = path.join(temp, 'invalid.json'); await writeFile(bad, '{');
    const output = path.join(temp, 'no-packet.json');
    const result = cli([path.join(root, 'scripts/prepare-task.mjs'), '--input', bad, '--template', templatePath, '--repo', temp, '--out', output]);
    assert.notEqual(result.status, 0); assert.ok(result.stderr.trim()); assert.equal(result.stdout, ''); assert.equal(await absent(output), true);
  });
  for (const suffix of [['--unknown'], ['--ref'], ['--out']]) await check('CLI rejects invalid arguments ' + suffix.join(' '), async () => {
    const result = cli([...cliArgs, ...suffix]); assert.notEqual(result.status, 0); assert.ok(result.stderr.trim()); assert.equal(result.stdout, '');
  });
} finally {
  await rm(temp, { recursive: true, force: true });
  const report = { checked_at: new Date().toISOString(), total: results.length, passed: results.length - failures.length, failed: failures.length, results };
  await writeFile(path.join(root, '.auto-ai/trials/T001/independent-review.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ total: report.total, passed: report.passed, failed: report.failed }));
}
if (failures.length) process.exitCode = 1;
