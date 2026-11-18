import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { Workflow } from '../src/workflow.mjs';

const execFileAsync = promisify(execFile);
const REPO = 'ag-jin/auto-ai';
const CANDIDATE = `${REPO}#2`;
const PR_NUMBER = 5;
const PR_URL = `https://github.com/${REPO}/pull/${PR_NUMBER}`;
const SCRIPT = path.resolve(new URL('../scripts/register-pr-head.mjs', import.meta.url).pathname);
const TEMPLATE = {
  commit: 'a'.repeat(40),
  path: 'templates/development/1.2.0.md',
  id: 'development',
  version: '1.2.0',
};
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

const GH_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.STUB_GH_LOG) fs.appendFileSync(process.env.STUB_GH_LOG, JSON.stringify(args) + '\\n');
const fixture = JSON.parse(fs.readFileSync(process.env.STUB_GH_FIXTURE, 'utf8'));
if (fixture.fail) {
  console.error(fixture.fail);
  process.exit(1);
}
if (args[0] === 'pr' && args[1] === 'view') {
  const pr = fixture.prs[String(args[2])];
  if (!pr) { console.error('no such pr: ' + args[2]); process.exit(1); }
  process.stdout.write(JSON.stringify(pr));
  process.exit(0);
}
if (args[0] === 'api') {
  const target = args[args.length - 1];
  const match = /^repos\\/(.+)\\/issues\\/(\\d+)$/.exec(target);
  const issue = match ? fixture.issues[match[1] + '#' + match[2]] : null;
  if (!issue) { console.error('no such issue: ' + target); process.exit(1); }
  process.stdout.write(JSON.stringify(issue));
  process.exit(0);
}
console.error('unsupported gh call: ' + args.join(' '));
process.exit(1);
`;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...GIT_ENV },
  });
  return stdout.trim();
}

async function writeFixtureFile(repoDir, relative, content) {
  const file = path.join(repoDir, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

async function commit(repoDir, files, message) {
  for (const [relative, content] of Object.entries(files)) {
    await writeFixtureFile(repoDir, relative, content);
  }
  await git(repoDir, ['add', '-A']);
  await git(repoDir, ['commit', '-m', message]);
  return git(repoDir, ['rev-parse', 'HEAD']);
}

async function makeEnvironment(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'auto-ai-register-head-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const repoDir = path.join(root, 'repo');
  const remoteDir = path.join(root, 'remotes', 'ag-jin', 'auto-ai.git');
  await mkdir(path.dirname(remoteDir), { recursive: true });
  await git(root, ['init', '--bare', '-q', remoteDir]);
  await git(root, ['init', '-q', '-b', 'main', repoDir]);
  await writeFixtureFile(repoDir, 'README.md', '# fixture\n');
  const baseCommit = await commit(repoDir, {}, 'base');
  await git(repoDir, ['remote', 'add', 'origin', remoteDir]);
  await git(repoDir, ['push', '-q', '-u', 'origin', 'main']);

  const oldHead = await commit(repoDir, { 'src/old.txt': 'old\n' }, 'delivered change');
  await git(repoDir, ['push', '-q', 'origin', 'main']);
  const newHead = await commit(repoDir, { 'src/new.txt': 'new\n' }, 'accepted repair');
  await git(repoDir, ['push', '-q', 'origin', 'main']);

  const dataDir = path.join(root, 'data');
  const stubDir = path.join(root, 'bin');
  await mkdir(stubDir, { recursive: true });
  await writeFile(path.join(stubDir, 'gh'), GH_STUB, 'utf8');
  await chmod(path.join(stubDir, 'gh'), 0o755);

  const context = {
    root,
    repoDir,
    remoteDir,
    baseCommit,
    oldHead,
    newHead,
    dataDir,
    stubDir,
    fixturePath: path.join(root, 'gh-fixture.json'),
    logPath: path.join(root, 'gh-calls.log'),
    evidencePath: path.join(root, 'evidence.json'),
  };
  await setFixture(context, {});
  return context;
}

function ghFixture({ prHead, issueBody = '正文 2', prState = 'open' } = {}) {
  return {
    prs: {
      [String(PR_NUMBER)]: {
        number: PR_NUMBER,
        url: PR_URL,
        headRefOid: prHead,
        state: prState,
        mergeable: 'MERGEABLE',
        statusCheckRollup: [],
        mergeCommit: null,
      },
    },
    issues: {
      [CANDIDATE]: {
        number: 2,
        title: '任务 2',
        body: issueBody,
        state: 'open',
        user: { login: 'alice' },
        labels: [{ name: 'feature' }],
        updated_at: '2026-01-01T00:00:00Z',
        html_url: `https://github.com/${REPO}/issues/2`,
      },
    },
  };
}

async function setFixture(context, options) {
  await writeFile(context.fixturePath, JSON.stringify(ghFixture(options)), 'utf8');
  await writeFile(context.logPath, '', 'utf8');
}

async function readGhCalls(context) {
  const text = await readFile(context.logPath, 'utf8');
  return text.split('\n').filter((line) => line.trim().length > 0);
}

async function writeEvidence(context, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  await writeFile(context.evidencePath, text, 'utf8');
  return { text, sha256: sha256(Buffer.from(text, 'utf8')) };
}

function seed(context, { writeScopes = ['src'], issueBody = '正文 2' } = {}) {
  const wf = new Workflow({ dbPath: path.join(context.dataDir, 'workflow.db') });
  try {
    wf.saveSettings({
      repositories: [{ repo: REPO, localPath: context.repoDir, baseRef: 'main' }],
      rules: { repositories: [REPO], labels: [], authors: [], keywords: [] },
      concurrency: { global: 2, perRepo: 2 },
    });
    wf.collect([
      {
        repo: REPO,
        number: 2,
        title: '任务 2',
        body: issueBody,
        state: 'open',
        author: 'alice',
        labels: ['feature'],
        updatedAt: '2026-01-01T00:00:00Z',
        url: `https://github.com/${REPO}/issues/2`,
        isPullRequest: false,
      },
    ]);
    wf.saveDraft(CANDIDATE, {
      goal: '在旧 head 上追加返修提交',
      acceptance: ['专项测试通过'],
      writeScopes,
    });
    wf.decide(CANDIDATE, {
      action: 'develop',
      actor: 'user',
      draftRev: wf.getCandidate(CANDIDATE).draft.rev,
      template: TEMPLATE,
    });
    const claimed = wf.claimNext();
    wf.bindExecution(claimed.id, {
      templateRef: `${TEMPLATE.commit}:${TEMPLATE.path}`,
      branch: `auto-ai/${claimed.id}`,
      worktreePath: path.join(context.dataDir, 'workspace', 'worktrees', 'fixture'),
    });
    wf.finishRun(claimed.id, {
      summary: '交付原始结果',
      artifacts: ['src/old.txt'],
      evidence: [{ command: 'node --test', status: 'passed', detail: '专项通过' }],
      pr: { repo: REPO, number: PR_NUMBER, url: PR_URL, headSha: context.oldHead },
    });
    wf.recordAcceptance(CANDIDATE, {
      role: 'design',
      verdict: 'approved',
      headSha: context.oldHead,
      comment: '旧 head 设计核验通过',
    });
    return { runId: claimed.id };
  } finally {
    wf.close();
  }
}

async function runCli(context, args, extraEnv = {}) {
  const env = {
    ...process.env,
    ...GIT_ENV,
    ...extraEnv,
    PATH: `${context.stubDir}${path.delimiter}${process.env.PATH ?? ''}`,
    STUB_GH_FIXTURE: context.fixturePath,
    STUB_GH_LOG: context.logPath,
  };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, ...args], {
      env,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function registerArgs(context, { runId, from, to }) {
  return [
    '--data-dir',
    context.dataDir,
    '--run-id',
    runId,
    '--from',
    from,
    '--to',
    to,
    '--evidence',
    context.evidencePath,
    '--confirm',
  ];
}

async function snapshotObjectStore(repoDir) {
  const root = path.join(repoDir, '.git', 'objects');
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    files.push(`${path.relative(root, full)}:${(await stat(full)).size}`);
  }
  return files.sort();
}

function readState(context, runId) {
  const wf = new Workflow({ dbPath: path.join(context.dataDir, 'workflow.db') });
  try {
    const run = wf.getRun(runId);
    return {
      run,
      candidate: wf.getCandidate(CANDIDATE),
      acceptances: wf.listAcceptances(CANDIDATE),
      events: wf.listEvents({ limit: 1000 }).filter((event) => event.kind === 'run.head_registered'),
    };
  } finally {
    wf.close();
  }
}

async function assertNothingWritten(context, runId, before, { expectGhCalls = false } = {}) {
  const after = readState(context, runId);
  assert.equal(after.run.result.pr.headSha, before.run.result.pr.headSha);
  assert.equal(after.run.result.summary, before.run.result.summary);
  assert.deepEqual(after.run.updatedAt, before.run.updatedAt);
  assert.equal(after.events.length, before.events.length);
  assert.equal(after.acceptances.length, before.acceptances.length);
  if (!expectGhCalls) {
    assert.deepEqual(await readGhCalls(context), []);
  }
}

// ---------------------------------------------------------------------------
// Positive path
// ---------------------------------------------------------------------------

test('登记同 Run 同 PR 的快进新 head，旧验收保留但需按新 head 重新验收', async (t) => {
  const context = await makeEnvironment(t);
  const { runId } = seed(context);
  const before = readState(context, runId);
  const evidence = await writeEvidence(context, {
    headSha: context.newHead,
    summary: '本地 node --test 专项 12/12 通过，原始日志 .auto-ai/validation/RH001/new.log',
  });
  await setFixture(context, { prHead: context.newHead });

  const result = await runCli(context, registerArgs(context, {
    runId,
    from: context.oldHead,
    to: context.newHead,
  }));
  assert.equal(result.code, 0, result.stderr);
  const printed = JSON.parse(result.stdout);
  assert.equal(printed.registered, true);
  assert.equal(printed.pr.headSha, context.newHead);
  assert.equal(printed.evidence.sha256, evidence.sha256);

  const after = readState(context, runId);
  assert.equal(after.run.result.pr.headSha, context.newHead);
  // Other result fields and the original delivery evidence stay untouched.
  assert.equal(after.run.result.summary, '交付原始结果');
  assert.deepEqual(after.run.result.artifacts, ['src/old.txt']);
  assert.deepEqual(after.run.result.evidence, [
    { command: 'node --test', status: 'passed', detail: '专项通过' },
  ]);
  assert.equal(after.run.result.merge, undefined);
  assert.equal(after.run.status, 'awaiting_acceptance');
  assert.equal(after.candidate.state, 'awaiting_acceptance');
  assert.equal(after.candidate.decision.action, 'develop');
  // The old approval is preserved verbatim.
  assert.equal(after.acceptances.length, before.acceptances.length);
  assert.equal(after.acceptances[0].headSha, context.oldHead);
  assert.equal(after.acceptances[0].verdict, 'approved');
  // One audit event with both SHAs and the evidence digest/summary.
  assert.equal(after.events.length, 1);
  assert.equal(after.events[0].runId, runId);
  assert.deepEqual(after.events[0].data, {
    fromHeadSha: context.oldHead,
    toHeadSha: context.newHead,
    pr: { repo: REPO, number: PR_NUMBER, url: PR_URL },
    evidence: { sha256: evidence.sha256, summary: JSON.parse(evidence.text).summary },
  });

  const wf = new Workflow({ dbPath: path.join(context.dataDir, 'workflow.db') });
  try {
    // Old approvals no longer authorize a merge; the new head has to be
    // accepted by both roles first.
    assert.equal(wf.canMerge(CANDIDATE, { headSha: context.newHead }).allowed, false);
    assert.equal(wf.canMerge(CANDIDATE, { headSha: context.oldHead }).allowed, false);
    assert.throws(
      () => wf.recordAcceptance(CANDIDATE, {
        role: 'user',
        verdict: 'approved',
        headSha: context.oldHead,
      }),
      /head/i,
    );
    wf.recordAcceptance(CANDIDATE, {
      role: 'design',
      verdict: 'approved',
      headSha: context.newHead,
      comment: '新 head 设计核验通过',
    });
    assert.equal(wf.canMerge(CANDIDATE, { headSha: context.newHead }).allowed, false);
    wf.recordAcceptance(CANDIDATE, {
      role: 'user',
      verdict: 'approved',
      headSha: context.newHead,
    });
    const merged = wf.canMerge(CANDIDATE, { headSha: context.newHead });
    assert.equal(merged.allowed, true, merged.reasons.join('；'));
    // The historical rows are still there: 1 old design + 2 new-role rows.
    assert.equal(wf.listAcceptances(CANDIDATE).length, 3);
  } finally {
    wf.close();
  }
});

// ---------------------------------------------------------------------------
// Partial clone: verification must only use objects already on disk
// ---------------------------------------------------------------------------

test('部分克隆缺少新 head 时拒绝登记，不惰性取回、不写对象库、不产生审计副作用', async (t) => {
  const context = await makeEnvironment(t);
  const { runId } = seed(context);

  // Clone with blob:none over file:// so the clone is a real promisor remote.
  await git(context.root, [
    '-c', 'safe.bareRepository=all',
    '--git-dir', context.remoteDir,
    'config', 'uploadpack.allowFilter', 'true',
  ]);
  const partialClone = path.join(context.root, 'partial-clone');
  await git(context.root, [
    'clone', '-q', '--filter=blob:none',
    pathToFileURL(context.remoteDir).href,
    partialClone,
  ]);

  // Advance the remote after the clone without fetching into it.
  const repairHead = await commit(
    context.repoDir,
    { 'src/repair.txt': 'repair\n' },
    'repair after partial clone',
  );
  await git(context.repoDir, ['push', '-q', 'origin', 'main']);

  const wf = new Workflow({ dbPath: path.join(context.dataDir, 'workflow.db') });
  try {
    wf.saveSettings({
      repositories: [{ repo: REPO, localPath: partialClone, baseRef: 'main' }],
      rules: { repositories: [REPO], labels: [], authors: [], keywords: [] },
      concurrency: { global: 2, perRepo: 2 },
    });
  } finally {
    wf.close();
  }

  const before = readState(context, runId);
  await writeEvidence(context, { headSha: repairHead, summary: '对部分克隆缺失 head 的独立验收' });
  await setFixture(context, { prHead: repairHead });

  const objectsBefore = await snapshotObjectStore(partialClone);
  const tracePath = path.join(context.root, 'git-trace.log');
  const args = registerArgs(context, { runId, from: context.oldHead, to: repairHead });
  let result = await runCli(context, args, { GIT_TRACE: tracePath });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /不在本地仓库中/);
  assert.match(result.stderr, /拒绝按未获取的提交登记/);

  // The lazy fetch must be denied before any remote transport or object write.
  assert.deepEqual(await snapshotObjectStore(partialClone), objectsBefore);
  const trace = await readFile(tracePath, 'utf8');
  assert.doesNotMatch(trace, /upload-pack|pack-objects|index-pack/);
  await assertNothingWritten(context, runId, before, { expectGhCalls: true });

  // A partial clone that already has the needed commit objects still registers.
  await git(partialClone, ['fetch', '-q', 'origin']);
  result = await runCli(context, args, { GIT_TRACE: path.join(context.root, 'git-trace-ok.log') });
  assert.equal(result.code, 0, result.stderr);
  const printed = JSON.parse(result.stdout);
  assert.equal(printed.registered, true);
  assert.equal(printed.pr.headSha, repairHead);
  assert.equal(readState(context, runId).run.result.pr.headSha, repairHead);
});

test('浅克隆截断历史时拒绝登记，即使被撤销的越界提交被 rev-list 隐去', async (t) => {
  const context = await makeEnvironment(t);
  const { runId } = seed(context, { writeScopes: ['src'] });
  const before = readState(context, runId);

  // The old head is the merge's first parent. The second parent branch adds an
  // out-of-scope file, reverts it, then adds a legal final commit. A depth-2
  // clone has both full SHAs and confirms ancestry, but rev-list stops at the
  // shallow boundary and hides the two commits below the repair tip.
  await git(context.repoDir, ['checkout', '-q', '-b', 'repair', context.oldHead]);
  const outsideCommit = await commit(context.repoDir, { 'outside.txt': 'out\n' }, 'outside scope');
  await git(context.repoDir, ['rm', '-q', 'outside.txt']);
  await git(context.repoDir, ['commit', '-q', '-m', 'revert outside']);
  await commit(context.repoDir, { 'src/repair.txt': 'repair\n' }, 'legal final tree');
  await git(context.repoDir, ['checkout', '-q', '-b', 'merge-flow', context.oldHead]);
  await git(context.repoDir, ['merge', '--no-ff', '-q', '-m', 'merge repair', 'repair']);
  const mergeHead = await git(context.repoDir, ['rev-parse', 'HEAD']);
  await git(context.repoDir, ['push', '-q', 'origin', 'merge-flow']);

  assert.equal(await git(context.repoDir, ['rev-parse', '--is-shallow-repository']), 'false');
  const fullRange = (await git(context.repoDir, ['rev-list', `${context.oldHead}..${mergeHead}`])).split('\n');
  assert.ok(fullRange.includes(outsideCommit));

  const shallowClone = path.join(context.root, 'shallow-clone');
  await git(context.root, [
    'clone', '-q', '--depth=2', '--branch', 'merge-flow',
    pathToFileURL(context.remoteDir).href, shallowClone,
  ]);
  assert.equal(await git(shallowClone, ['rev-parse', '--is-shallow-repository']), 'true');
  // Both SHAs are present and the fast-forward proof passes, so only the
  // shallow guard prevents the truncated range from being accepted.
  await git(shallowClone, ['cat-file', '-e', `${context.oldHead}^{commit}`]);
  await git(shallowClone, ['cat-file', '-e', `${mergeHead}^{commit}`]);
  await git(shallowClone, ['merge-base', '--is-ancestor', context.oldHead, mergeHead]);
  const shallowRange = (await git(shallowClone, ['rev-list', `${context.oldHead}..${mergeHead}`])).split('\n');
  assert.ok(shallowRange.includes(mergeHead));
  assert.equal(shallowRange.includes(outsideCommit), false);

  const wf = new Workflow({ dbPath: path.join(context.dataDir, 'workflow.db') });
  try {
    wf.saveSettings({
      repositories: [{ repo: REPO, localPath: shallowClone, baseRef: 'main' }],
      rules: { repositories: [REPO], labels: [], authors: [], keywords: [] },
      concurrency: { global: 2, perRepo: 2 },
    });
  } finally {
    wf.close();
  }

  await writeEvidence(context, { headSha: mergeHead, summary: '对浅克隆截断历史的独立验收' });
  await setFixture(context, { prHead: mergeHead });
  const objectsBefore = await snapshotObjectStore(shallowClone);
  const result = await runCli(context, registerArgs(context, {
    runId,
    from: context.oldHead,
    to: mergeHead,
  }));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /浅克隆/);
  assert.match(result.stderr, /补齐完整历史/);
  assert.deepEqual(await snapshotObjectStore(shallowClone), objectsBefore);
  await assertNothingWritten(context, runId, before, { expectGhCalls: true });
});

// ---------------------------------------------------------------------------
// Refusals: no write, no audit event, no external side effect
// ---------------------------------------------------------------------------

test('旧 Run 不是候选最新执行时拒绝登记', async (t) => {
  const context = await makeEnvironment(t);
  const { runId } = seed(context);
  const before = readState(context, runId);
  await writeEvidence(context, { headSha: context.newHead, summary: '已独立验收' });
  await setFixture(context, { prHead: context.newHead });

  // A later retry replaces the current Run while the candidate is still in
  // awaiting_acceptance, so the old Run must not be re-pointed.
  const wf = new Workflow({ dbPath: path.join(context.dataDir, 'workflow.db') });
  try {
    wf.retryCandidate(CANDIDATE);
    const second = wf.claimNext();
    wf.bindExecution(second.id, {
      templateRef: `${TEMPLATE.commit}:${TEMPLATE.path}`,
      branch: `auto-ai/${second.id}`,
      worktreePath: path.join(context.dataDir, 'workspace', 'worktrees', 'second'),
    });
    wf.finishRun(second.id, {
      summary: '第二次执行',
      artifacts: [],
      evidence: [{ command: 'node --test', status: 'passed', detail: '专项通过' }],
      pr: { repo: REPO, number: PR_NUMBER, url: PR_URL, headSha: context.oldHead },
    });
  } finally {
    wf.close();
  }

  const result = await runCli(context, registerArgs(context, {
    runId,
    from: context.oldHead,
    to: context.newHead,
  }));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /最新执行/);
  await assertNothingWritten(context, runId, before, { expectGhCalls: true });
});

test('缺少 --confirm 或必要参数时先拒绝，不读取 PR/Issue', async (t) => {
  const context = await makeEnvironment(t);
  const { runId } = seed(context);
  const before = readState(context, runId);
  await writeEvidence(context, { headSha: context.newHead, summary: '已独立验收' });
  await setFixture(context, { prHead: context.newHead });

  const args = registerArgs(context, { runId, from: context.oldHead, to: context.newHead });
  const withoutConfirm = args.filter((value) => value !== '--confirm');
  let result = await runCli(context, withoutConfirm);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /--confirm/);
  await assertNothingWritten(context, runId, before);

  const withoutRunId = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--run-id') {
      index += 1;
      continue;
    }
    withoutRunId.push(args[index]);
  }
  result = await runCli(context, withoutRunId);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /--run-id/);
  await assertNothingWritten(context, runId, before);
});

test('实时 PR head 不是 --to 或 PR 非 open 时拒绝且不写', async (t) => {
  const context = await makeEnvironment(t);
  const { runId } = seed(context);
  const before = readState(context, runId);
  const other = await commit(context.repoDir, { 'src/other.txt': 'other\n' }, 'unrelated head');
  await git(context.repoDir, ['push', '-q', 'origin', 'main']);
  await writeEvidence(context, { headSha: context.newHead, summary: '已独立验收' });

  await setFixture(context, { prHead: other });
  let result = await runCli(context, registerArgs(context, {
    runId,
    from: context.oldHead,
    to: context.newHead,
  }));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /实时 head/);
  await assertNothingWritten(context, runId, before, { expectGhCalls: true });

  await setFixture(context, { prHead: context.newHead, prState: 'merged' });
  result = await runCli(context, registerArgs(context, {
    runId,
    from: context.oldHead,
    to: context.newHead,
  }));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /只有开放 PR/);
  await assertNothingWritten(context, runId, before, { expectGhCalls: true });
});

test('Issue 源版本漂移时拒绝登记', async (t) => {
  const context = await makeEnvironment(t);
  const { runId } = seed(context);
  const before = readState(context, runId);
  await writeEvidence(context, { headSha: context.newHead, summary: '已独立验收' });
  await setFixture(context, { prHead: context.newHead, issueBody: '正文已经变化' });

  const result = await runCli(context, registerArgs(context, {
    runId,
    from: context.oldHead,
    to: context.newHead,
  }));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /源版本已变化/);
  await assertNothingWritten(context, runId, before, { expectGhCalls: true });
});

test('非快进或越界提交、被撤销的追加路径都不登记', async (t) => {
  const context = await makeEnvironment(t);
  const { runId } = seed(context, { writeScopes: ['src'] });
  const before = readState(context, runId);
  await writeEvidence(context, { headSha: context.newHead, summary: '已独立验收' });

  // Not a fast-forward: the side commit branches off the base commit.
  await git(context.repoDir, ['checkout', '-q', '-b', 'side', context.baseCommit]);
  const sideHead = await commit(context.repoDir, { 'src/side.txt': 'side\n' }, 'side branch');
  await git(context.repoDir, ['checkout', '-q', 'main']);
  await setFixture(context, { prHead: sideHead });
  await writeEvidence(context, { headSha: sideHead, summary: '对 side head 的独立验收' });
  let result = await runCli(context, registerArgs(context, {
    runId,
    from: context.oldHead,
    to: sideHead,
  }));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /祖先/);
  await assertNothingWritten(context, runId, before, { expectGhCalls: true });

  // Out of scope: a repair commit that touches docs/ outside writeScopes.
  const outsideHead = await commit(context.repoDir, { 'docs/out.md': 'out\n' }, 'out of scope');
  await git(context.repoDir, ['push', '-q', 'origin', 'main']);
  await setFixture(context, { prHead: outsideHead });
  await writeEvidence(context, { headSha: outsideHead, summary: '对越界 head 的独立验收' });
  result = await runCli(context, registerArgs(context, {
    runId,
    from: context.oldHead,
    to: outsideHead,
  }));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /writeScopes/);
  await assertNothingWritten(context, runId, before, { expectGhCalls: true });

  // Add-then-revert: the final head does not contain the file, but the commit
  // is part of the delivered range, so the scope check still fails.
  await git(context.repoDir, ['checkout', '-q', '-b', 'revert-flow', context.newHead]);
  const added = await commit(context.repoDir, { 'tmp/scratch.md': 'scratch\n' }, 'add scratch');
  await git(context.repoDir, ['rm', '-q', 'tmp/scratch.md']);
  await git(context.repoDir, ['commit', '-q', '-m', 'revert scratch']);
  const revertedHead = await git(context.repoDir, ['rev-parse', 'HEAD']);
  assert.notEqual(added, revertedHead);
  await git(context.repoDir, ['checkout', '-q', 'main']);
  await setFixture(context, { prHead: revertedHead });
  await writeEvidence(context, { headSha: revertedHead, summary: '对撤销 head 的独立验收' });
  result = await runCli(context, registerArgs(context, {
    runId,
    from: context.oldHead,
    to: revertedHead,
  }));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /writeScopes/);
  await assertNothingWritten(context, runId, before, { expectGhCalls: true });
});

test('证据文件不匹配或缺少时拒绝且不读外部', async (t) => {
  const context = await makeEnvironment(t);
  const { runId } = seed(context);
  const before = readState(context, runId);
  await setFixture(context, { prHead: context.newHead });

  await writeEvidence(context, { headSha: context.oldHead, summary: '指向旧 head' });
  let result = await runCli(context, registerArgs(context, {
    runId,
    from: context.oldHead,
    to: context.newHead,
  }));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /headSha/);
  await assertNothingWritten(context, runId, before);

  await writeFile(context.evidencePath, JSON.stringify({ headSha: context.newHead }), 'utf8');
  result = await runCli(context, registerArgs(context, {
    runId,
    from: context.oldHead,
    to: context.newHead,
  }));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /summary/);
  await assertNothingWritten(context, runId, before);

  await rm(context.evidencePath, { force: true });
  result = await runCli(context, registerArgs(context, {
    runId,
    from: context.oldHead,
    to: context.newHead,
  }));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /证据文件/);
  await assertNothingWritten(context, runId, before);
});

test('重复登记、存在合并意图时拒绝', async (t) => {
  const context = await makeEnvironment(t);
  const { runId } = seed(context);
  await writeEvidence(context, { headSha: context.newHead, summary: '已独立验收' });
  await setFixture(context, { prHead: context.newHead });

  const args = registerArgs(context, { runId, from: context.oldHead, to: context.newHead });
  const first = await runCli(context, args);
  assert.equal(first.code, 0, first.stderr);
  await writeFile(context.logPath, '', 'utf8');

  const afterFirst = readState(context, runId);
  const repeat = await runCli(context, args);
  assert.notEqual(repeat.code, 0);
  assert.match(repeat.stderr, /与 --from/);
  await assertNothingWritten(context, runId, afterFirst, { expectGhCalls: false });

  // Merge intent files use the Runtime naming convention.
  const intentDir = path.join(context.dataDir, 'merge-intents');
  await mkdir(intentDir, { recursive: true });
  const intentKey = sha256(Buffer.from(CANDIDATE, 'utf8')).slice(0, 16);
  await writeFile(
    path.join(intentDir, `${intentKey}.json`),
    JSON.stringify({ schemaVersion: 1, candidateId: CANDIDATE, status: 'pending' }),
    'utf8',
  );
  const third = await commit(context.repoDir, { 'src/third.txt': 'third\n' }, 'third head');
  await git(context.repoDir, ['push', '-q', 'origin', 'main']);
  await setFixture(context, { prHead: third });
  await writeEvidence(context, { headSha: third, summary: '第三次独立验收' });
  const withIntent = await runCli(context, registerArgs(context, {
    runId,
    from: context.newHead,
    to: third,
  }));
  assert.notEqual(withIntent.code, 0);
  assert.match(withIntent.stderr, /合并意图/);
  await assertNothingWritten(context, runId, afterFirst);
});

test('控制器锁被占用时拒绝且不抢锁', async (t) => {
  const context = await makeEnvironment(t);
  const { runId } = seed(context);
  const before = readState(context, runId);
  await writeEvidence(context, { headSha: context.newHead, summary: '已独立验收' });
  await setFixture(context, { prHead: context.newHead });

  // A live owner without a captured start time: the lock probe falls back to a
  // signal check, so the CLI must refuse instead of stealing the lock.
  const lockFile = path.join(context.dataDir, 'controller.lock');
  const lockOwner = {
    schemaVersion: 1,
    pid: process.pid,
    pgid: null,
    startTime: null,
    createdAt: new Date().toISOString(),
  };
  await writeFile(lockFile, JSON.stringify(lockOwner), 'utf8');

  const result = await runCli(context, registerArgs(context, {
    runId,
    from: context.oldHead,
    to: context.newHead,
  }));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /控制器/);
  assert.equal(existsSync(lockFile), true);
  assert.deepEqual(JSON.parse(await readFile(lockFile, 'utf8')), lockOwner);
  await assertNothingWritten(context, runId, before);
});

test('数据目录或仓库本地路径缺失时拒绝猜测', async (t) => {
  const context = await makeEnvironment(t);
  const { runId } = seed(context);
  const before = readState(context, runId);
  await writeEvidence(context, { headSha: context.newHead, summary: '已独立验收' });
  await setFixture(context, { prHead: context.newHead });

  const missingData = await runCli(context, registerArgs(context, {
    runId,
    from: context.oldHead,
    to: context.newHead,
  }).map((value) => (value === context.dataDir ? path.join(context.root, 'absent') : value)));
  assert.notEqual(missingData.code, 0);
  assert.match(missingData.stderr, /workflow\.db|不存在/);

  const wf = new Workflow({ dbPath: path.join(context.dataDir, 'workflow.db') });
  try {
    wf.saveSettings(
      {
        repositories: [{ repo: REPO, localPath: '', baseRef: 'main' }],
        rules: { repositories: [REPO], labels: [], authors: [], keywords: [] },
        concurrency: { global: 2, perRepo: 2 },
      },
      { allowEmptyLocalPath: true },
    );
  } finally {
    wf.close();
  }
  const noPath = await runCli(context, registerArgs(context, {
    runId,
    from: context.oldHead,
    to: context.newHead,
  }));
  assert.notEqual(noPath.code, 0);
  assert.match(noPath.stderr, /没有本地路径/);
  await assertNothingWritten(context, runId, before);
});
