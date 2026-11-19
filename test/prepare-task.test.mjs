import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { prepareTask } from '../src/prepare-task.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = path.join(PROJECT_ROOT, 'scripts', 'prepare-task.mjs');
const TEMPLATE_PATH = 'templates/development/1.0.0.md';

function git(repoDir, ...args) {
  return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' });
}

function gitText(repoDir, ...args) {
  return git(repoDir, ...args).replace(/\n$/, '');
}

async function makeRepo(t) {
  const repoDir = await mkdtemp(path.join(tmpdir(), 'prepare-task-'));
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  git(repoDir, 'init', '-q', '-b', 'main');
  git(repoDir, 'config', 'user.name', 'Prepare Task Test');
  git(repoDir, 'config', 'user.email', 'prepare-task@example.invalid');
  git(repoDir, 'config', 'commit.gpgsign', 'false');
  return repoDir;
}

async function writeTemplate(repoDir, text) {
  const templateFile = path.join(repoDir, TEMPLATE_PATH);
  await mkdir(path.dirname(templateFile), { recursive: true });
  await writeFile(templateFile, text, 'utf8');
}

async function commitAll(repoDir, message) {
  git(repoDir, 'add', '-A');
  git(repoDir, 'commit', '-q', '-m', message);
  return gitText(repoDir, 'rev-parse', 'HEAD');
}

function validTask(overrides = {}) {
  return {
    issue_ref: 'ag-jin/auto-ai#123',
    run_id: 'T001-example',
    attempt: 1,
    inputs: {
      goal: '修复订单重复提交',
      acceptance: ['快速连点只产生一笔订单'],
      scope: '订单提交逻辑',
      context: '',
    },
    ...overrides,
  };
}

function expectedRevision(inputs) {
  return `sha256:${createHash('sha256').update(JSON.stringify(inputs), 'utf8').digest('hex')}`;
}

async function makeCommittedTemplateRepo(t) {
  const repoDir = await makeRepo(t);
  const templateText = '# Template v1\n\nUse the fixed version.\n';
  await writeTemplate(repoDir, templateText);
  const commit = await commitAll(repoDir, 'add template');
  return { repoDir, templateText, commit };
}

async function runCli(args, cwd = PROJECT_ROOT) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

test('builds an execution packet with exactly the contract fields', async (t) => {
  const { repoDir, templateText, commit } = await makeCommittedTemplateRepo(t);
  const task = validTask();
  delete task.inputs.scope;
  delete task.inputs.context;
  const taskSnapshot = structuredClone(task);

  const packet = await prepareTask({ repoDir, ref: 'HEAD', templatePath: TEMPLATE_PATH, task });

  assert.deepEqual(task, taskSnapshot);
  assert.deepEqual(Object.keys(packet), [
    'schema_version',
    'issue_ref',
    'run_id',
    'attempt',
    'template_ref',
    'requirements_rev',
    'inputs',
    'template_text',
  ]);
  assert.equal(packet.schema_version, 1);
  assert.equal(packet.issue_ref, 'ag-jin/auto-ai#123');
  assert.equal(packet.run_id, 'T001-example');
  assert.equal(packet.attempt, 1);
  assert.equal(packet.template_ref, `${commit}:${TEMPLATE_PATH}`);
  assert.equal(packet.template_text, templateText);
  assert.deepEqual(Object.keys(packet.inputs), ['goal', 'acceptance', 'scope', 'context']);
  assert.deepEqual(packet.inputs, {
    goal: '修复订单重复提交',
    acceptance: ['快速连点只产生一笔订单'],
    scope: '',
    context: '',
  });
  assert.equal(packet.requirements_rev, expectedRevision(packet.inputs));
});

test('ignores unrelated fields and input key order but tracks effective requirements', async (t) => {
  const { repoDir } = await makeCommittedTemplateRepo(t);

  const firstTask = validTask({
    issue_ref: '  ag-jin/auto-ai#123  ',
    run_id: '  T001-example  ',
    unrelated: { ignored: true },
  });
  firstTask.inputs = {
    context: '  some context  ',
    acceptance: [' 快速连点只产生一笔订单 '],
    goal: '  修复订单重复提交 ',
    scope: ' 订单提交逻辑 ',
    extra_input: 'ignored',
  };

  const secondTask = validTask();
  secondTask.inputs = {
    goal: '修复订单重复提交',
    acceptance: ['快速连点只产生一笔订单'],
    scope: '订单提交逻辑',
    context: 'some context',
  };

  const first = await prepareTask({
    repoDir,
    templatePath: TEMPLATE_PATH,
    task: firstTask,
  });
  const second = await prepareTask({
    repoDir,
    templatePath: TEMPLATE_PATH,
    task: secondTask,
  });

  assert.equal(first.requirements_rev, second.requirements_rev);
  assert.deepEqual(first.inputs, second.inputs);

  const changedTask = validTask();
  changedTask.inputs.acceptance = ['快速连点只产生一笔订单', '取消后不产生订单'];
  const changed = await prepareTask({ repoDir, templatePath: TEMPLATE_PATH, task: changedTask });
  assert.notEqual(changed.requirements_rev, first.requirements_rev);

  const reorderedTask = validTask();
  reorderedTask.inputs.acceptance = ['另一种验收', '快速连点只产生一笔订单'];
  const reordered = await prepareTask({
    repoDir,
    templatePath: TEMPLATE_PATH,
    task: reorderedTask,
  });
  assert.notEqual(reordered.requirements_rev, first.requirements_rev);

  const extraOnlyTask = validTask();
  extraOnlyTask.inputs.context = 'some context';
  extraOnlyTask.inputs.unrelated = 'ignored';
  const extraOnly = await prepareTask({
    repoDir,
    templatePath: TEMPLATE_PATH,
    task: extraOnlyTask,
  });
  assert.equal(extraOnly.requirements_rev, second.requirements_rev);
});

test('rejects invalid task identifiers, attempts, and inputs', async (t) => {
  const { repoDir } = await makeCommittedTemplateRepo(t);
  const call = (task) => prepareTask({ repoDir, templatePath: TEMPLATE_PATH, task });

  const cases = [
    [null, /task must be an object/],
    [[], /task must be an object/],
    [validTask({ issue_ref: 'ag-jin/auto-ai' }), /issue_ref/],
    [validTask({ issue_ref: 'ag-jin/auto-ai#0' }), /issue_ref/],
    [validTask({ issue_ref: 'ag-jin/auto-ai#-1' }), /issue_ref/],
    [validTask({ issue_ref: 'ag-jin/auto-ai#abc' }), /issue_ref/],
    [validTask({ issue_ref: 'ag-jin#123' }), /issue_ref/],
    [validTask({ issue_ref: 123 }), /issue_ref/],
    [validTask({ run_id: '' }), /run_id/],
    [validTask({ run_id: '   ' }), /run_id/],
    [validTask({ run_id: 7 }), /run_id/],
    [validTask({ attempt: 0 }), /attempt/],
    [validTask({ attempt: -1 }), /attempt/],
    [validTask({ attempt: 1.5 }), /attempt/],
    [validTask({ attempt: '1' }), /attempt/],
    [validTask({ inputs: null }), /inputs/],
    [validTask({ inputs: { acceptance: ['ok'] } }), /goal/],
    [validTask({ inputs: { goal: '', acceptance: ['ok'] } }), /goal/],
    [validTask({ inputs: { goal: '   ', acceptance: ['ok'] } }), /goal/],
    [validTask({ inputs: { goal: 3, acceptance: ['ok'] } }), /goal/],
    [validTask({ inputs: { goal: 'ok' } }), /acceptance/],
    [validTask({ inputs: { goal: 'ok', acceptance: [] } }), /acceptance/],
    [validTask({ inputs: { goal: 'ok', acceptance: [''] } }), /acceptance\[0\]/],
    [validTask({ inputs: { goal: 'ok', acceptance: ['   '] } }), /acceptance\[0\]/],
    [validTask({ inputs: { goal: 'ok', acceptance: [1] } }), /acceptance\[0\]/],
    [validTask({ inputs: { goal: 'ok', acceptance: 'not-an-array' } }), /acceptance/],
    [validTask({ inputs: { goal: 'ok', acceptance: ['ok'], scope: 1 } }), /scope/],
    [validTask({ inputs: { goal: 'ok', acceptance: ['ok'], context: null } }), /context/],
  ];

  for (const [task, expected] of cases) {
    await assert.rejects(() => call(task), expected);
  }
});

test('rejects unsafe template paths, invalid refs, and missing templates', async (t) => {
  const { repoDir } = await makeCommittedTemplateRepo(t);
  const task = validTask();

  const invalidPaths = [
    '/templates/development/1.0.0.md',
    'C:/templates/development/1.0.0.md',
    'templates\\development\\1.0.0.md',
    'templates//development/1.0.0.md',
    'templates/./development/1.0.0.md',
    'templates/development/../development/1.0.0.md',
    'templates/../templates/development/1.0.0.md',
    '../templates/development/1.0.0.md',
    'templates/',
    'templates',
    'docs/development/1.0.0.md',
    'templates/development/1.0.0.txt',
    '',
  ];

  for (const templatePath of invalidPaths) {
    await assert.rejects(
      () => prepareTask({ repoDir, templatePath, task }),
      /templatePath/,
      `expected rejection for ${JSON.stringify(templatePath)}`,
    );
  }

  await assert.rejects(
    () => prepareTask({ repoDir, ref: 'does-not-exist', templatePath: TEMPLATE_PATH, task }),
    /Invalid Git ref/,
  );
  await assert.rejects(
    () => prepareTask({ repoDir, ref: '', templatePath: TEMPLATE_PATH, task }),
    /ref/,
  );
  await assert.rejects(
    () =>
      prepareTask({
        repoDir,
        templatePath: 'templates/development/missing.md',
        task,
      }),
    /Template not found/,
  );
});

test('reads the selected commit even when the worktree and HEAD have newer text', async (t) => {
  const repoDir = await makeRepo(t);
  const oldText = '# Old template\n\nOld instructions only.\n';
  await writeTemplate(repoDir, oldText);
  const oldCommit = await commitAll(repoDir, 'old template');

  const newText = '# New template\n\nNew instructions.\n';
  await writeTemplate(repoDir, newText);
  const newCommit = await commitAll(repoDir, 'new template');

  const uncommittedText = '# Uncommitted template\n\nMust not be used.\n';
  await writeTemplate(repoDir, uncommittedText);

  const task = validTask();
  const oldPacket = await prepareTask({
    repoDir,
    ref: oldCommit,
    templatePath: TEMPLATE_PATH,
    task,
  });
  assert.equal(oldPacket.template_text, oldText);
  assert.equal(oldPacket.template_ref, `${oldCommit}:${TEMPLATE_PATH}`);

  const headPacket = await prepareTask({
    repoDir,
    ref: 'HEAD',
    templatePath: TEMPLATE_PATH,
    task,
  });
  assert.equal(headPacket.template_text, newText);
  assert.equal(headPacket.template_ref, `${newCommit}:${TEMPLATE_PATH}`);
});

test('CLI writes JSON to stdout without progress output', async (t) => {
  const { repoDir, templateText, commit } = await makeCommittedTemplateRepo(t);
  const inputPath = path.join(repoDir, 'task.json');
  await writeFile(inputPath, JSON.stringify(validTask()), 'utf8');

  const result = await runCli([
    '--input',
    inputPath,
    '--template',
    TEMPLATE_PATH,
    '--repo',
    repoDir,
    '--ref',
    'HEAD',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const packet = JSON.parse(result.stdout);
  assert.equal(packet.template_ref, `${commit}:${TEMPLATE_PATH}`);
  assert.equal(packet.template_text, templateText);
});

test('CLI writes a new output file and refuses to overwrite an existing one', async (t) => {
  const { repoDir } = await makeCommittedTemplateRepo(t);
  const inputPath = path.join(repoDir, 'task.json');
  await writeFile(inputPath, JSON.stringify(validTask()), 'utf8');
  const outputPath = path.join(repoDir, 'nested', 'packets', 'packet.json');

  const first = await runCli([
    '--input',
    inputPath,
    '--template',
    TEMPLATE_PATH,
    '--repo',
    repoDir,
    '--out',
    outputPath,
  ]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, '');
  const written = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.equal(written.run_id, 'T001-example');

  const sentinel = 'do not overwrite\n';
  await writeFile(outputPath, sentinel, 'utf8');
  const second = await runCli([
    '--input',
    inputPath,
    '--template',
    TEMPLATE_PATH,
    '--repo',
    repoDir,
    '--out',
    outputPath,
  ]);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /already exists/);
  assert.equal(second.stdout, '');
  assert.equal(await readFile(outputPath, 'utf8'), sentinel);
});

test('CLI failures do not create or modify output files', async (t) => {
  const { repoDir } = await makeCommittedTemplateRepo(t);
  const invalidInputPath = path.join(repoDir, 'invalid-task.json');
  await writeFile(invalidInputPath, JSON.stringify(validTask({ attempt: 0 })), 'utf8');

  const missingOutputPath = path.join(repoDir, 'missing-packet.json');
  const failed = await runCli([
    '--input',
    invalidInputPath,
    '--template',
    TEMPLATE_PATH,
    '--repo',
    repoDir,
    '--out',
    missingOutputPath,
  ]);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /attempt/);
  assert.equal(failed.stdout, '');
  await assert.rejects(() => stat(missingOutputPath), { code: 'ENOENT' });

  const protectedOutputPath = path.join(repoDir, 'protected-packet.json');
  const sentinel = 'keep this content\n';
  await writeFile(protectedOutputPath, sentinel, 'utf8');
  const stillFailed = await runCli([
    '--input',
    invalidInputPath,
    '--template',
    TEMPLATE_PATH,
    '--repo',
    repoDir,
    '--out',
    protectedOutputPath,
  ]);
  assert.notEqual(stillFailed.status, 0);
  assert.equal(await readFile(protectedOutputPath, 'utf8'), sentinel);
});

test('CLI rejects unknown options, missing values, and missing required options', async () => {
  const cases = [
    [['--bogus', 'x'], /Unknown option/],
    [['--input'], /Missing value for --input/],
    [['--input', 'task.json', '--template'], /Missing value for --template/],
    [['--template', TEMPLATE_PATH], /Missing required option: --input/],
    [['--input', 'task.json'], /Missing required option: --template/],
    [['positional'], /Unknown argument/],
  ];

  for (const [args, expected] of cases) {
    const result = await runCli(args);
    assert.notEqual(result.status, 0, `expected failure for ${args.join(' ')}`);
    assert.match(result.stderr, expected);
    assert.equal(result.stdout, '');
  }
});

test('rejects sparse acceptance arrays without mutating the task', async (t) => {
  const { repoDir } = await makeCommittedTemplateRepo(t);
  const call = (task) => prepareTask({ repoDir, templatePath: TEMPLATE_PATH, task });

  const sparseOnly = validTask();
  sparseOnly.inputs.acceptance = Array(1);
  const sparseOnlySnapshot = structuredClone(sparseOnly);
  await assert.rejects(() => call(sparseOnly), /acceptance\[0\] must be a string/);
  assert.deepEqual(sparseOnly, sparseOnlySnapshot);
  assert.equal(0 in sparseOnly.inputs.acceptance, false);

  const sparseMiddle = validTask();
  sparseMiddle.inputs.acceptance = ['ok', , 'later'];
  const sparseMiddleSnapshot = structuredClone(sparseMiddle);
  await assert.rejects(() => call(sparseMiddle), /acceptance\[1\] must be a string/);
  assert.deepEqual(sparseMiddle, sparseMiddleSnapshot);
  assert.equal(1 in sparseMiddle.inputs.acceptance, false);

  const inheritedSparse = new Array(1);
  const inheritedValues = { 0: 'inherited acceptance' };
  Object.setPrototypeOf(inheritedValues, Array.prototype);
  Object.setPrototypeOf(inheritedSparse, inheritedValues);
  const inheritedTask = validTask();
  inheritedTask.inputs.acceptance = inheritedSparse;
  await assert.rejects(() => call(inheritedTask), /acceptance\[0\] must be a string/);
  assert.equal(inheritedTask.inputs.acceptance, inheritedSparse);
  assert.equal(Object.hasOwn(inheritedSparse, 0), false);
  assert.equal(inheritedSparse[0], 'inherited acceptance');
});
