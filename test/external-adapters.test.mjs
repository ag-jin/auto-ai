import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { GitHubAdapter } from '../src/github-adapter.mjs';
import { listTemplates, resolveTemplate } from '../src/template-adapter.mjs';
import { WorkspaceAdapter } from '../src/workspace-adapter.mjs';

const execFileAsync = promisify(execFile);
const REPO = 'ag-jin/auto-ai';
const OTHER_REPO = 'ag-jin/other';

// Isolate Git from the user's global/system configuration without writing to it.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_TERMINAL_PROMPT = '0';

async function git(cwd, args, { allowFailure = false } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (error) {
    if (allowFailure) {
      return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', failed: true };
    }
    throw error;
  }
}

async function gitOut(cwd, args) {
  return (await git(cwd, args)).stdout.trim();
}

async function makeTempRoot(t, prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function initRepo(dir) {
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'auto-ai-test@example.invalid']);
  await git(dir, ['config', 'user.name', 'Auto AI Test']);
}

async function commitAll(repo, message) {
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-m', message]);
  return gitOut(repo, ['rev-parse', 'HEAD']);
}

async function writeRepoFile(repo, relativePath, content) {
  const absolutePath = path.join(repo, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, 'utf8');
  return absolutePath;
}

function makeGhRun(handler) {
  const calls = [];
  const run = async (command, args, options) => {
    const call = { command, args: [...args], options };
    calls.push(call);
    return handler(call, calls);
  };
  return { run, calls };
}

function ghResult(value) {
  return { stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' };
}

function hasArgPair(call, flag, value) {
  const index = call.args.indexOf(flag);
  return index >= 0 && call.args[index + 1] === value;
}

function isCall(call, ...prefix) {
  return prefix.every((value, index) => call.args[index] === value);
}

// ---------------------------------------------------------------------------
// GitHubAdapter
// ---------------------------------------------------------------------------

test('GitHub collectIssues 归一化分页结果、保留 isPullRequest 并严格校验 repo', async () => {
  const pageOne = [
    {
      number: 1,
      title: '功能 A',
      body: '正文 A',
      state: 'open',
      user: { login: 'alice' },
      labels: [{ name: 'feature' }, { name: 'ui' }],
      updated_at: '2026-01-01T00:00:00Z',
      html_url: `https://github.com/${REPO}/issues/1`,
    },
  ];
  const pageTwo = [
    {
      number: 2,
      title: 'PR B',
      body: null,
      state: 'open',
      user: null,
      labels: [],
      updated_at: '2026-01-02T00:00:00Z',
      html_url: `https://github.com/${REPO}/pull/2`,
      pull_request: { url: 'x' },
    },
  ];
  const { run, calls } = makeGhRun(() => ghResult([pageOne, pageTwo]));
  const adapter = new GitHubAdapter({ run });

  const issues = await adapter.collectIssues(REPO, { state: 'open' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'gh');
  assert.ok(calls[0].args.includes('--paginate'));
  assert.ok(calls[0].args.includes('--slurp'));
  assert.ok(
    calls[0].args.includes(`repos/${REPO}/issues?state=open&per_page=100`),
  );
  assert.deepEqual(
    issues.map((issue) => issue.number),
    [1, 2],
  );
  assert.deepEqual(issues[0], {
    repo: REPO,
    number: 1,
    title: '功能 A',
    body: '正文 A',
    state: 'open',
    author: 'alice',
    labels: ['feature', 'ui'],
    updatedAt: '2026-01-01T00:00:00Z',
    url: `https://github.com/${REPO}/issues/1`,
    isPullRequest: false,
  });
  assert.equal(issues[1].author, 'ghost');
  assert.equal(issues[1].body, '');
  assert.equal(issues[1].isPullRequest, true);

  const noCalls = makeGhRun(() => ghResult([]));
  const strict = new GitHubAdapter({ run: noCalls.run });
  await assert.rejects(() => strict.collectIssues('not-a-repo'), /owner\/repo/);
  await assert.rejects(() => strict.collectIssues(REPO, { state: 'merged' }), /state/);
  assert.equal(noCalls.calls.length, 0);
});

test('GitHub collectIssues 对命令失败与非法 JSON 明确报错，不返回空数组冒充成功', async () => {
  const failing = new GitHubAdapter({
    run: async () => {
      const error = new Error('boom');
      error.stderr = 'HTTP 403 forbidden';
      throw error;
    },
  });
  await assert.rejects(() => failing.collectIssues(REPO), /收集 .* 失败：HTTP 403/);

  const invalidJson = new GitHubAdapter({
    run: async () => ghResult('{not json'),
  });
  await assert.rejects(() => invalidJson.collectIssues(REPO), /JSON 无法解析/);

  const emptyStdout = new GitHubAdapter({
    run: async () => ghResult(''),
  });
  await assert.rejects(() => emptyStdout.collectIssues(REPO), /未返回 JSON/);
});

test('GitHub checkReady 成功/失败均可用且不输出凭据', async () => {
  const ready = new GitHubAdapter({ run: async () => ({ stdout: 'ok', stderr: '' }) });
  assert.deepEqual(await ready.checkReady(), {
    ready: true,
    reason: 'gh 已通过认证检查',
  });

  const notReady = new GitHubAdapter({
    run: async () => {
      const error = new Error('failed with token ghp_super_secret');
      error.stderr = 'auth failed: token=ghp_super_secret';
      throw error;
    },
  });
  const result = await notReady.checkReady();
  assert.equal(result.ready, false);
  assert.match(result.reason, /认证检查.*失败/);
  assert.equal(result.reason.includes('ghp_super_secret'), false);
});

test('GitHub createPullRequest 复用同分支同基线的 open PR，不重复创建', async () => {
  const existing = [
    {
      number: 17,
      url: `https://github.com/${REPO}/pull/17`,
      headRefOid: 'a'.repeat(40),
      headRefName: 'auto-ai/run-1',
      isCrossRepository: false,
    },
  ];
  const { run, calls } = makeGhRun(() => ghResult(existing));
  const adapter = new GitHubAdapter({ run });

  const created = await adapter.createPullRequest({
    repo: REPO,
    branch: 'auto-ai/run-1',
    baseBranch: 'main',
    title: '任务',
    body: '正文',
    worktreePath: '/tmp/example',
  });

  assert.deepEqual(created, {
    repo: REPO,
    number: 17,
    url: `https://github.com/${REPO}/pull/17`,
    headSha: 'a'.repeat(40),
  });
  assert.equal(calls.length, 1);
  assert.ok(isCall(calls[0], 'pr', 'list'));
  assert.equal(calls.some((call) => call.args.includes('create')), false);
  assert.equal(calls.some((call) => call.args.includes('merge')), false);
});

test('GitHub createPullRequest 通过临时 body 文件创建，并读回 number/url/headSha', async () => {
  const headSha = 'b'.repeat(40);
  let bodySeen = null;
  const { run, calls } = makeGhRun(async (call) => {
    if (isCall(call, 'pr', 'list')) {
      return ghResult([]);
    }
    if (isCall(call, 'pr', 'create')) {
      const bodyFile = call.args[call.args.indexOf('--body-file') + 1];
      bodySeen = await readFile(bodyFile, 'utf8');
      return ghResult(`https://github.com/${REPO}/pull/18`);
    }
    if (isCall(call, 'pr', 'view')) {
      return ghResult({
        number: 18,
        url: `https://github.com/${REPO}/pull/18`,
        headRefOid: headSha,
      });
    }
    throw new Error(`unexpected call: ${call.args.join(' ')}`);
  });
  const adapter = new GitHubAdapter({ run });

  const created = await adapter.createPullRequest({
    repo: REPO,
    branch: 'auto-ai/run-2',
    baseBranch: 'main',
    title: '任务标题',
    body: '第一行\n第二行\n',
    worktreePath: '/tmp/example',
  });

  assert.deepEqual(created, {
    repo: REPO,
    number: 18,
    url: `https://github.com/${REPO}/pull/18`,
    headSha,
  });
  assert.equal(bodySeen, '第一行\n第二行\n');
  assert.equal(calls.length, 3);
  assert.ok(calls[1].args.includes('--body-file'));
  assert.equal(calls.some((call) => call.args.includes('merge')), false);
});

test('GitHub readPullRequest 保留实际检查摘要，未知状态不改成成功', async () => {
  const headSha = 'c'.repeat(40);
  const adapter = new GitHubAdapter({
    run: async () =>
      ghResult({
        number: 9,
        url: `https://github.com/${REPO}/pull/9`,
        headRefOid: headSha,
        state: 'OPEN',
        mergeable: undefined,
        statusCheckRollup: [
          { name: 'build', conclusion: null, status: 'QUEUED' },
          { context: 'legacy-ci', state: 'PENDING' },
          { name: 'unknown-check' },
          { name: 'passed', conclusion: 'SUCCESS' },
        ],
      }),
  });

  const pr = await adapter.readPullRequest({ repo: REPO, number: 9 });
  assert.equal(pr.repo, REPO);
  assert.equal(pr.number, 9);
  assert.equal(pr.headSha, headSha);
  assert.equal(pr.state, 'open');
  assert.equal(pr.mergeable, 'UNKNOWN');
  assert.deepEqual(pr.checks, [
    { name: 'build', state: 'QUEUED' },
    { name: 'legacy-ci', state: 'PENDING' },
    { name: 'unknown-check', state: 'unknown' },
    { name: 'passed', state: 'SUCCESS' },
  ]);
});

test('GitHub mergePullRequest 拒绝未确认、非法方法、head 改变和已关闭 PR', async () => {
  const headSha = 'd'.repeat(40);
  let calls = 0;
  const adapter = new GitHubAdapter({
    run: async () => {
      calls += 1;
      return ghResult({
        number: 3,
        url: `https://github.com/${REPO}/pull/3`,
        headRefOid: 'e'.repeat(40),
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [],
      });
    },
  });

  await assert.rejects(
    () =>
      adapter.mergePullRequest({
        repo: REPO,
        number: 3,
        expectedHeadSha: headSha,
        method: 'merge',
        confirmed: false,
      }),
    /显式确认/,
  );
  await assert.rejects(
    () =>
      adapter.mergePullRequest({
        repo: REPO,
        number: 3,
        expectedHeadSha: headSha,
        method: 'merge',
        confirmed: true,
      }),
    /head 与 expectedHeadSha 不一致/,
  );
  assert.equal(calls, 1);
  assert.equal(
    (await adapter.readPullRequest({ repo: REPO, number: 3 })).headSha,
    'e'.repeat(40),
  );

  const noCalls = makeGhRun(() => {
    throw new Error('runner should not be called');
  });
  const unconfirmed = new GitHubAdapter({ run: noCalls.run });
  await assert.rejects(
    () =>
      unconfirmed.mergePullRequest({
        repo: REPO,
        number: 3,
        expectedHeadSha: `${headSha.slice(0, 39)}z`,
        method: 'merge',
        confirmed: true,
      }),
    /expectedHeadSha/,
  );
  await assert.rejects(
    () =>
      unconfirmed.mergePullRequest({
        repo: REPO,
        number: 3,
        expectedHeadSha: headSha,
        method: 'fast-forward',
        confirmed: true,
      }),
    /method/,
  );
  assert.equal(noCalls.calls.length, 0);

  const closed = new GitHubAdapter({
    run: async () =>
      ghResult({
        number: 3,
        url: `https://github.com/${REPO}/pull/3`,
        headRefOid: headSha,
        state: 'CLOSED',
        mergeable: 'UNKNOWN',
        statusCheckRollup: [],
      }),
  });
  await assert.rejects(
    () =>
      closed.mergePullRequest({
        repo: REPO,
        number: 3,
        expectedHeadSha: headSha,
        method: 'merge',
        confirmed: true,
      }),
    /状态为 closed/,
  );
});

test('GitHub mergePullRequest 在 head 一致时带 match-head-commit 调用 gh pr merge', async () => {
  const headSha = 'f'.repeat(40);
  const mergeSha = '1'.repeat(40);
  const { run, calls } = makeGhRun((call) => {
    if (isCall(call, 'pr', 'view')) {
      if (call.args.some((arg) => arg.includes('statusCheckRollup'))) {
        return ghResult({
          number: 5,
          url: `https://github.com/${REPO}/pull/5`,
          headRefOid: headSha,
          state: 'OPEN',
          mergeable: 'MERGEABLE',
          statusCheckRollup: [],
        });
      }
      return ghResult({ state: 'MERGED', mergeCommit: { oid: mergeSha } });
    }
    if (isCall(call, 'pr', 'merge')) {
      return ghResult('');
    }
    throw new Error(`unexpected call: ${call.args.join(' ')}`);
  });
  const adapter = new GitHubAdapter({ run });

  const result = await adapter.mergePullRequest({
    repo: REPO,
    number: 5,
    expectedHeadSha: headSha,
    method: 'squash',
    confirmed: true,
  });

  assert.deepEqual(result, { merged: true, mergeSha });
  const mergeCall = calls.find((call) => isCall(call, 'pr', 'merge'));
  assert.ok(mergeCall);
  assert.ok(mergeCall.args.includes('--squash'));
  assert.ok(hasArgPair(mergeCall, '--match-head-commit', headSha));
  assert.equal(mergeCall.args.includes('--admin'), false);
  assert.equal(mergeCall.args.includes('--delete-branch'), false);
});

function pullRequestPayload({ number = 7, headSha, state = 'OPEN', mergeSha = null } = {}) {
  return {
    number,
    url: `https://github.com/${REPO}/pull/${number}`,
    headRefOid: headSha,
    state,
    mergeable: state === 'OPEN' ? 'MERGEABLE' : 'UNKNOWN',
    statusCheckRollup: [],
    mergeCommit: mergeSha === null ? null : { oid: mergeSha },
  };
}

function mergeScenario({
  number = 7,
  headSha,
  currentState = 'OPEN',
  currentMergeSha = null,
  readback = {},
  readbackError = null,
} = {}) {
  const { run, calls } = makeGhRun((call) => {
    if (isCall(call, 'pr', 'view')) {
      const isStateRead = call.args.some((arg) => arg.includes('statusCheckRollup'));
      if (isStateRead) {
        return ghResult(
          pullRequestPayload({ number, headSha, state: currentState, mergeSha: currentMergeSha }),
        );
      }
      if (readbackError !== null) {
        throw Object.assign(new Error(readbackError), { stderr: readbackError });
      }
      const state = readback.state ?? 'MERGED';
      const mergeSha = readback.mergeSha ?? null;
      return ghResult({
        state,
        mergeCommit: typeof mergeSha === 'string' ? { oid: mergeSha } : mergeSha,
      });
    }
    if (isCall(call, 'pr', 'merge')) {
      return ghResult('');
    }
    throw new Error(`unexpected call: ${call.args.join(' ')}`);
  });
  return { run, calls, adapter: new GitHubAdapter({ run }) };
}

function countMergeCalls(calls) {
  return calls.filter((call) => isCall(call, 'pr', 'merge')).length;
}

test('GitHub readPullRequest 额外返回实际 merge SHA，未知时为 null', async () => {
  const headSha = '2'.repeat(40);
  const mergeSha = '3'.repeat(40);
  const payloads = [
    pullRequestPayload({ number: 6, headSha, state: 'MERGED', mergeSha }),
    pullRequestPayload({ number: 6, headSha, state: 'OPEN' }),
    { ...pullRequestPayload({ number: 6, headSha, state: 'MERGED' }), mergeCommit: { oid: 'abc123' } },
  ];
  const adapter = new GitHubAdapter({ run: async () => ghResult(payloads.shift()) });

  const merged = await adapter.readPullRequest({ repo: REPO, number: 6 });
  assert.equal(merged.state, 'merged');
  assert.equal(merged.mergeSha, mergeSha);

  const open = await adapter.readPullRequest({ repo: REPO, number: 6 });
  assert.equal(open.state, 'open');
  assert.equal(open.mergeSha, null);

  const incomplete = await adapter.readPullRequest({ repo: REPO, number: 6 });
  assert.equal(incomplete.state, 'merged');
  assert.equal(incomplete.mergeSha, null);
});

test('GitHub mergePullRequest 命令成功但读回 OPEN 时返回 pending，不伪称合并', async () => {
  const headSha = '4'.repeat(40);
  const { calls, adapter } = mergeScenario({
    headSha,
    readback: { state: 'OPEN', mergeSha: null },
  });

  const result = await adapter.mergePullRequest({
    repo: REPO,
    number: 7,
    expectedHeadSha: headSha,
    method: 'merge',
    confirmed: true,
  });

  assert.equal(result.merged, false);
  assert.equal(result.pending, true);
  assert.equal(result.state, 'open');
  assert.equal(result.mergeSha, null);
  assert.match(result.note, /合并命令已发出/);
  assert.equal(countMergeCalls(calls), 1);
});

test('GitHub mergePullRequest 合并后读回失败返回 pending，不重发 merge', async () => {
  const headSha = '5'.repeat(40);
  const { calls, adapter } = mergeScenario({
    headSha,
    readbackError: 'gh: HTTP 502 from api.github.com',
  });

  const result = await adapter.mergePullRequest({
    repo: REPO,
    number: 7,
    expectedHeadSha: headSha,
    method: 'squash',
    confirmed: true,
  });

  assert.equal(result.merged, false);
  assert.equal(result.pending, true);
  assert.equal(result.mergeSha, null);
  assert.match(result.note, /合并命令已发出/);
  assert.match(result.note, /502/);
  assert.equal(countMergeCalls(calls), 1);
});

test('GitHub mergePullRequest 读回 MERGED 但无有效 merge SHA 时仍为 pending', async () => {
  const headSha = '6'.repeat(40);
  for (const readback of [
    { state: 'MERGED', mergeSha: null },
    { state: 'MERGED', mergeSha: { oid: '' } },
    { state: 'MERGED', mergeSha: { oid: 'abc123' } },
  ]) {
    const { calls, adapter } = mergeScenario({ headSha, readback });
    const result = await adapter.mergePullRequest({
      repo: REPO,
      number: 7,
      expectedHeadSha: headSha,
      method: 'rebase',
      confirmed: true,
    });

    assert.equal(result.merged, false);
    assert.equal(result.pending, true);
    assert.equal(result.state, 'merged');
    assert.equal(result.mergeSha, null);
    assert.match(result.note, /merge commit SHA/);
    assert.equal(countMergeCalls(calls), 1);
  }
});

test('GitHub mergePullRequest 对已合并同 head 幂等读回，不重复 merge', async () => {
  const headSha = '7'.repeat(40);
  const mergeSha = '8'.repeat(40);
  const { calls, adapter } = mergeScenario({
    headSha,
    currentState: 'MERGED',
    currentMergeSha: mergeSha,
  });

  const result = await adapter.mergePullRequest({
    repo: REPO,
    number: 7,
    expectedHeadSha: headSha,
    method: 'merge',
    confirmed: true,
  });

  assert.equal(result.merged, true);
  assert.equal(result.mergeSha, mergeSha);
  assert.equal(countMergeCalls(calls), 0);
});

test('GitHub mergePullRequest 已合并但 head 不同或无 SHA 时仍拒绝或 pending', async () => {
  const expectedHeadSha = '9'.repeat(40);
  const actualHeadSha = 'a'.repeat(40);

  const staleHead = mergeScenario({
    headSha: actualHeadSha,
    currentState: 'MERGED',
    currentMergeSha: 'b'.repeat(40),
  });
  await assert.rejects(
    () =>
      staleHead.adapter.mergePullRequest({
        repo: REPO,
        number: 7,
        expectedHeadSha,
        method: 'merge',
        confirmed: true,
      }),
    /head/,
  );
  assert.equal(countMergeCalls(staleHead.calls), 0);

  const mergedWithoutSha = mergeScenario({
    headSha: expectedHeadSha,
    currentState: 'MERGED',
    currentMergeSha: null,
  });
  const pending = await mergedWithoutSha.adapter.mergePullRequest({
    repo: REPO,
    number: 7,
    expectedHeadSha,
    method: 'merge',
    confirmed: true,
  });
  assert.equal(pending.merged, false);
  assert.equal(pending.pending, true);
  assert.equal(pending.state, 'merged');
  assert.equal(pending.mergeSha, null);
  assert.equal(countMergeCalls(mergedWithoutSha.calls), 0);
});

// ---------------------------------------------------------------------------
// WorkspaceAdapter: real temporary Git repositories
// ---------------------------------------------------------------------------

async function setupWorkspace(t, { runId = 'T003B-run-1', owner = 'ag-jin', name = 'auto-ai' } = {}) {
  const root = await makeTempRoot(t, 't003b-ws-');
  const remote = path.join(root, 'remotes', owner, `${name}.git`);
  await mkdir(path.dirname(remote), { recursive: true });
  await git(root, ['init', '--bare', remote]);

  const source = path.join(root, 'source');
  await initRepo(source);
  await git(source, ['remote', 'add', 'origin', remote]);
  await writeRepoFile(source, 'README.md', 'base\n');
  const baseCommit = await commitAll(source, 'base');
  await git(source, ['push', '-u', 'origin', 'main']);

  const adapter = new WorkspaceAdapter({ rootDir: path.join(root, 'runtime') });
  return { root, remote, source, baseCommit, adapter, runId };
}

test('Workspace create 隔离工作树、固定基线并保持源仓库未提交改动', async (t) => {
  const { source, baseCommit, adapter, runId, root } = await setupWorkspace(t);
  await writeFile(path.join(source, 'README.md'), 'local dirty\n', 'utf8');

  const created = await adapter.create({
    repo: REPO,
    localPath: source,
    runId,
  });

  assert.equal(created.repo, REPO);
  assert.equal(created.runId, runId);
  assert.equal(created.baseCommit, baseCommit);
  assert.equal(created.baseBranch, 'main');
  assert.match(created.branch, new RegExp(runId));
  assert.match(created.worktreePath, new RegExp(runId));
  assert.match(created.branch, /^auto-ai\//);
  assert.equal((await gitOut(source, ['rev-parse', 'HEAD'])), baseCommit);
  assert.match(await gitOut(source, ['status', '--porcelain']), /README\.md/);
  assert.equal(await readFile(path.join(created.worktreePath, 'README.md'), 'utf8'), 'base\n');

  const manifests = await readdir(path.join(root, 'runtime', 'manifests'));
  assert.deepEqual(manifests, [`${runId}.json`]);
  const manifest = JSON.parse(
    await readFile(path.join(root, 'runtime', 'manifests', `${runId}.json`), 'utf8'),
  );
  assert.equal(manifest.repo, REPO);
  assert.equal(manifest.branch, created.branch);
  assert.equal(manifest.baseCommit, baseCommit);

  const resumed = await adapter.create({ repo: REPO, localPath: source, runId });
  assert.deepEqual(resumed, created);

  await assert.rejects(
    () => adapter.create({ repo: REPO, localPath: source, runId, baseBranch: 'other' }),
    /基线分支/,
  );
});

test('Workspace create 拒绝串仓、origin push 身份不符、detached HEAD 猜测和已有分支/目录', async (t) => {
  const { source, adapter, baseCommit, root } = await setupWorkspace(t);

  await assert.rejects(
    () => adapter.create({ repo: OTHER_REPO, localPath: source, runId: 'run-a' }),
    /与请求的 .*不一致，拒绝串仓/,
  );

  const oldPush = await gitOut(source, ['remote', 'get-url', '--push', 'origin']);
  await git(source, ['remote', 'set-url', '--push', 'origin', path.join(path.dirname(oldPush), 'other.git')]);
  await assert.rejects(
    () => adapter.create({ repo: REPO, localPath: source, runId: 'run-b' }),
    /origin push 地址指向/,
  );
  await git(source, ['remote', 'set-url', '--push', 'origin', oldPush]);

  await git(source, ['checkout', '--detach', baseCommit]);
  await assert.rejects(
    () => adapter.create({ repo: REPO, localPath: source, runId: 'run-c' }),
    /detached HEAD/,
  );
  const detachedOk = await adapter.create({
    repo: REPO,
    localPath: source,
    runId: 'run-c',
    baseBranch: 'main',
  });
  assert.equal(detachedOk.baseBranch, 'main');
  assert.equal(detachedOk.baseCommit, baseCommit);

  await git(source, ['checkout', 'main']);
  await git(source, ['branch', 'auto-ai/run-d', baseCommit]);
  await assert.rejects(
    () => adapter.create({ repo: REPO, localPath: source, runId: 'run-d' }),
    /任务分支 .* 已存在/,
  );

  const runId = 'run-e';
  const occupiedPath = path.join(
    root,
    'runtime',
    'worktrees',
    `ag-jin-auto-ai-${runId}`,
  );
  await mkdir(occupiedPath, { recursive: true });
  await assert.rejects(
    () => adapter.create({ repo: REPO, localPath: source, runId }),
    /工作树目录已存在/,
  );
});

test('Workspace create 同一 runId 在 manifest 与实际分支不一致时拒绝复用', async (t) => {
  const { source, adapter, runId } = await setupWorkspace(t);
  const created = await adapter.create({ repo: REPO, localPath: source, runId });
  await git(created.worktreePath, ['checkout', '-b', 'manual-other']);
  await assert.rejects(
    () => adapter.create({ repo: REPO, localPath: source, runId }),
    /分支不是/,
  );
});

test('Workspace inspect 包含 tracked 与全部 untracked 文件，正确处理含空格路径', async (t) => {
  const { source, adapter, baseCommit, runId } = await setupWorkspace(t);
  const created = await adapter.create({ repo: REPO, localPath: source, runId });
  await writeFile(path.join(created.worktreePath, 'README.md'), 'changed\n', 'utf8');
  await writeRepoFile(created.worktreePath, 'dir with space/file name.txt', 'a\n');
  await writeRepoFile(created.worktreePath, 'nested/deep/another file.js', 'b\n');

  const inspected = await adapter.inspect({ worktreePath: created.worktreePath });

  assert.equal(inspected.headSha, baseCommit);
  assert.equal(inspected.dirty, true);
  assert.deepEqual(inspected.paths, [
    'README.md',
    'dir with space/file name.txt',
    'nested/deep/another file.js',
  ]);
});

test('Workspace commitAndPush 先检查 writeScopes，超范围拒绝且不 add；合法后提交推送', async (t) => {
  const { source, adapter, baseCommit, runId, remote } = await setupWorkspace(t);
  const created = await adapter.create({ repo: REPO, localPath: source, runId });
  await writeRepoFile(created.worktreePath, 'src/ok.mjs', 'export const ok = true;\n');
  await writeRepoFile(created.worktreePath, 'secret.txt', 'not allowed\n');

  await assert.rejects(
    () =>
      adapter.commitAndPush({
        repo: REPO,
        worktreePath: created.worktreePath,
        branch: created.branch,
        baseCommit,
        writeScopes: ['src'],
        summary: 'should reject',
      }),
    /超出 writeScopes/,
  );
  assert.equal(await gitOut(created.worktreePath, ['rev-parse', 'HEAD']), baseCommit);
  assert.equal(await gitOut(created.worktreePath, ['diff', '--cached', '--name-only']), '');
  assert.match(await gitOut(created.worktreePath, ['status', '--porcelain']), /secret\.txt/);

  const pushed = await adapter.commitAndPush({
    repo: REPO,
    worktreePath: created.worktreePath,
    branch: created.branch,
    baseCommit,
    writeScopes: ['src', 'secret.txt'],
    summary: '任务 T003B 提交',
  });

  assert.notEqual(pushed.headSha, baseCommit);
  assert.equal(pushed.pushed, true);
  assert.equal(pushed.noChanges, false);
  assert.deepEqual(pushed.paths, ['secret.txt', 'src/ok.mjs']);
  assert.equal(await gitOut(created.worktreePath, ['rev-parse', 'HEAD']), pushed.headSha);
  const remoteSha = (
    await gitOut(source, ['ls-remote', '--heads', 'origin', `refs/heads/${created.branch}`])
  ).split(/\s+/)[0];
  assert.equal(remoteSha, pushed.headSha);
  assert.equal(
    await gitOut(created.worktreePath, ['rev-list', '--count', `${baseCommit}..${pushed.headSha}`]),
    '1',
  );
  assert.equal(await readFile(path.join(created.worktreePath, 'secret.txt'), 'utf8'), 'not allowed\n');

  const reentered = await adapter.commitAndPush({
    repo: REPO,
    worktreePath: created.worktreePath,
    branch: created.branch,
    baseCommit,
    writeScopes: ['*'],
    summary: '任务 T003B 提交',
  });
  assert.deepEqual(reentered, {
    headSha: pushed.headSha,
    paths: [],
    pushed: true,
    noChanges: true,
  });
  assert.equal(
    await gitOut(created.worktreePath, ['rev-list', '--count', `${baseCommit}..${pushed.headSha}`]),
    '1',
  );

  await assert.rejects(
    () =>
      adapter.commitAndPush({
        repo: OTHER_REPO,
        worktreePath: created.worktreePath,
        branch: created.branch,
        baseCommit,
        writeScopes: ['*'],
        summary: 'wrong repo',
      }),
    /拒绝串仓|不一致/,
  );
  assert.equal(
    (await gitOut(remote, ['rev-parse', 'refs/heads/' + created.branch])).trim(),
    pushed.headSha,
  );
});

test('Workspace commitAndPush 将 shell 元字符路径当数据处理', async (t) => {
  const { source, adapter, baseCommit, runId } = await setupWorkspace(t);
  const created = await adapter.create({ repo: REPO, localPath: source, runId });
  const trickyPath = 'src/a;touch shell-hacked.txt $(echo nope).mjs';
  await writeRepoFile(created.worktreePath, trickyPath, 'safe\n');

  const pushed = await adapter.commitAndPush({
    repo: REPO,
    worktreePath: created.worktreePath,
    branch: created.branch,
    baseCommit,
    writeScopes: ['src'],
    summary: 'shell metacharacter path',
  });

  assert.deepEqual(pushed.paths, [trickyPath]);
  assert.equal(await readFile(path.join(created.worktreePath, trickyPath), 'utf8'), 'safe\n');
  await assert.rejects(() => access(path.join(created.worktreePath, 'shell-hacked.txt')));
  assert.equal(await gitOut(created.worktreePath, ['status', '--porcelain']), '');
});

test('Workspace commitAndPush 在源仓库 origin 身份变化后拒绝提交', async (t) => {
  const { source, adapter, baseCommit, runId } = await setupWorkspace(t);
  const created = await adapter.create({ repo: REPO, localPath: source, runId });
  await writeRepoFile(created.worktreePath, 'src/change.mjs', 'changed\n');
  const originalPush = await gitOut(source, ['remote', 'get-url', '--push', 'origin']);
  await git(source, ['remote', 'set-url', '--push', 'origin', path.join(path.dirname(originalPush), 'other.git')]);

  await assert.rejects(
    () =>
      adapter.commitAndPush({
        repo: REPO,
        worktreePath: created.worktreePath,
        branch: created.branch,
        baseCommit,
        writeScopes: ['*'],
        summary: 'origin changed',
      }),
    /origin push 地址指向/,
  );
  assert.equal(await gitOut(created.worktreePath, ['rev-parse', 'HEAD']), baseCommit);
  assert.equal(await gitOut(created.worktreePath, ['diff', '--cached', '--name-only']), '');
});

test('Workspace commitAndPush 对无有效变更明确返回既有提交，不创建空提交', async (t) => {
  const { source, adapter, baseCommit, runId } = await setupWorkspace(t);
  const created = await adapter.create({ repo: REPO, localPath: source, runId });

  const result = await adapter.commitAndPush({
    repo: REPO,
    worktreePath: created.worktreePath,
    branch: created.branch,
    baseCommit,
    writeScopes: ['*'],
    summary: 'no changes',
  });

  assert.equal(result.headSha, baseCommit);
  assert.deepEqual(result.paths, []);
  assert.equal(result.pushed, false);
  assert.equal(result.noChanges, true);
  assert.match(result.reason, /没有变更/);
  assert.equal(await gitOut(created.worktreePath, ['rev-parse', 'HEAD']), baseCommit);
});

test('Workspace commitAndPush 重入已提交但未推送的交付时推送既有提交，不重复提交', async (t) => {
  const { source, adapter, baseCommit, runId } = await setupWorkspace(t);
  const created = await adapter.create({ repo: REPO, localPath: source, runId });
  await writeRepoFile(created.worktreePath, 'recovered.txt', 'recovered\n');
  await git(created.worktreePath, ['add', '-A']);
  await git(created.worktreePath, ['commit', '-m', 'previous attempt']);
  const existingHead = await gitOut(created.worktreePath, ['rev-parse', 'HEAD']);
  assert.notEqual(existingHead, baseCommit);

  const result = await adapter.commitAndPush({
    repo: REPO,
    worktreePath: created.worktreePath,
    branch: created.branch,
    baseCommit,
    writeScopes: ['*'],
    summary: 'retry push',
  });

  assert.equal(result.headSha, existingHead);
  assert.equal(result.pushed, true);
  assert.equal(result.noChanges, true);
  assert.deepEqual(result.paths, []);
  assert.match(result.reason, /已推送既有提交/);
  assert.equal(await gitOut(created.worktreePath, ['rev-parse', 'HEAD']), existingHead);
  assert.equal(
    await gitOut(created.worktreePath, ['rev-list', '--count', `${baseCommit}..${existingHead}`]),
    '1',
  );
  const remoteSha = (
    await gitOut(source, ['ls-remote', '--heads', 'origin', `refs/heads/${created.branch}`])
  ).split(/\s+/)[0];
  assert.equal(remoteSha, existingHead);
});

test('Workspace archive 只回收已推送且干净的 manifest 工作树，脏目录和未知现场保留', async (t) => {
  const { source, adapter, baseCommit, runId } = await setupWorkspace(t);
  const created = await adapter.create({ repo: REPO, localPath: source, runId });
  await writeRepoFile(created.worktreePath, 'archive-me.txt', 'pushed\n');
  const pushed = await adapter.commitAndPush({
    repo: REPO,
    worktreePath: created.worktreePath,
    branch: created.branch,
    baseCommit,
    writeScopes: ['*'],
    summary: 'archive test',
  });
  assert.notEqual(pushed.headSha, baseCommit);

  const wrongHead = await adapter.archive({
    repo: REPO,
    localPath: source,
    worktreePath: created.worktreePath,
    branch: created.branch,
    headSha: baseCommit,
  });
  assert.equal(wrongHead.removed, false);
  assert.match(wrongHead.reason, /HEAD 与传入 headSha 不一致/);

  await writeRepoFile(created.worktreePath, 'dirty file.txt', 'dirty\n');
  const dirty = await adapter.archive({
    repo: REPO,
    localPath: source,
    worktreePath: created.worktreePath,
    branch: created.branch,
    headSha: pushed.headSha,
  });
  assert.equal(dirty.removed, false);
  assert.match(dirty.reason, /未提交或未跟踪修改/);
  await access(created.worktreePath);

  await rm(path.join(created.worktreePath, 'dirty file.txt'));
  const removed = await adapter.archive({
    repo: REPO,
    localPath: source,
    worktreePath: created.worktreePath,
    branch: created.branch,
    headSha: pushed.headSha,
  });
  assert.equal(removed.removed, true);
  await assert.rejects(() => access(created.worktreePath));
  await git(source, ['show-ref', '--verify', `refs/heads/${created.branch}`]);
  const remoteSha = (
    await gitOut(source, ['ls-remote', '--heads', 'origin', `refs/heads/${created.branch}`])
  ).split(/\s+/)[0];
  assert.equal(remoteSha, pushed.headSha);

  const unknown = await adapter.archive({
    repo: REPO,
    localPath: source,
    worktreePath: path.join(source, 'not-a-worktree'),
    branch: created.branch,
    headSha: pushed.headSha,
  });
  assert.equal(unknown.removed, false);
  assert.match(unknown.reason, /没有找到/);
});

test('Workspace archive 对未推送工作树保留现场', async (t) => {
  const { source, adapter, baseCommit, runId } = await setupWorkspace(t);
  const created = await adapter.create({ repo: REPO, localPath: source, runId });

  const result = await adapter.archive({
    repo: REPO,
    localPath: source,
    worktreePath: created.worktreePath,
    branch: created.branch,
    headSha: baseCommit,
  });
  assert.equal(result.removed, false);
  assert.match(result.reason, /origin\/.* 不存在|无法确认已推送/);
  await access(created.worktreePath);
});

// ---------------------------------------------------------------------------
// Template adapter
// ---------------------------------------------------------------------------

function templateText(id, version, body) {
  return `---\nschema_version: 1\nid: ${id}\nversion: "${version}"\n---\n\n${body}\n`;
}

const VALID_CATALOG = `schema_version: 1
templates:
  development:
    description: 开发与修复
    default: development/1.0.0.md
  research:
    description: 调研
    default: research/1.0.0.md
`;

async function makeTemplateRepo(t, { catalog = VALID_CATALOG, files } = {}) {
  const root = await makeTempRoot(t, 't003b-tpl-');
  const repo = path.join(root, 'template-repo');
  await initRepo(repo);
  await writeRepoFile(repo, 'templates/catalog.yml', catalog);
  const defaultFiles = {
    'templates/development/1.0.0.md': templateText('development', '1.0.0', '# 开发 v1\n正文'),
    'templates/research/1.0.0.md': templateText('research', '1.0.0', '# 调研 v1'),
  };
  for (const [relativePath, content] of Object.entries(files ?? defaultFiles)) {
    await writeRepoFile(repo, relativePath, content);
  }
  const commit = await commitAll(repo, 'templates');
  return { root, repo, commit };
}

test('模板按固定 commit 读取，工作区未提交改动不参与，旧 ref 默认模板保持不变', async (t) => {
  const { repo, commit } = await makeTemplateRepo(t);
  const v1 = await resolveTemplate({ repoDir: repo, ref: 'HEAD', id: 'development' });
  assert.equal(v1.commit, commit);
  assert.equal(v1.id, 'development');
  assert.equal(v1.version, '1.0.0');
  assert.equal(v1.path, 'templates/development/1.0.0.md');
  assert.equal(v1.templateRef, `${commit}:templates/development/1.0.0.md`);
  assert.equal(v1.text, templateText('development', '1.0.0', '# 开发 v1\n正文'));

  const v2Text = templateText('development', '2.0.0', '# 开发 v2');
  await writeRepoFile(repo, 'templates/development/2.0.0.md', v2Text);
  const catalogV2 = VALID_CATALOG.replace(
    'development/1.0.0.md',
    'development/2.0.0.md',
  );
  await writeRepoFile(repo, 'templates/catalog.yml', catalogV2);

  const stillV1 = await resolveTemplate({ repoDir: repo, ref: 'HEAD', id: 'development' });
  assert.equal(stillV1.version, '1.0.0');
  assert.equal(stillV1.commit, commit);

  const newCommit = await commitAll(repo, 'catalog v2');
  const v2 = await resolveTemplate({ repoDir: repo, ref: 'HEAD', id: 'development' });
  assert.equal(v2.commit, newCommit);
  assert.equal(v2.version, '2.0.0');
  assert.equal(v2.text, v2Text);

  const oldDefault = await resolveTemplate({ repoDir: repo, ref: commit, id: 'development' });
  assert.equal(oldDefault.commit, commit);
  assert.equal(oldDefault.version, '1.0.0');

  const oldList = await listTemplates({ repoDir: repo, ref: commit });
  assert.deepEqual(
    oldList.map((item) => `${item.id}@${item.version}`),
    ['development@1.0.0', 'research@1.0.0'],
  );
  const newList = await listTemplates({ repoDir: repo, ref: 'HEAD' });
  assert.deepEqual(
    newList.map((item) => `${item.id}@${item.version}`),
    ['development@2.0.0', 'research@1.0.0'],
  );
  assert.equal(newList[0].templateRef, `${newCommit}:templates/development/2.0.0.md`);
  assert.equal(newList[0].description, '开发与修复');
});

test('模板读取拒绝非法 YAML、重复键、路径越界、元数据缺失与 catalog 不匹配', async (t) => {
  const badYaml = await makeTemplateRepo(t, {
    catalog: 'schema_version: 1\ntemplates: [\n',
  });
  await assert.rejects(
    () => resolveTemplate({ repoDir: badYaml.repo, id: 'development' }),
    /YAML 非法/,
  );

  const duplicateKeys = await makeTemplateRepo(t, {
    catalog: `schema_version: 1
templates:
  development:
    description: one
    default: development/1.0.0.md
  development:
    description: two
    default: development/1.0.0.md
`,
  });
  await assert.rejects(
    () => listTemplates({ repoDir: duplicateKeys.repo }),
    /YAML 非法/,
  );

  const missingVersion = await makeTemplateRepo(t, {
    files: {
      'templates/development/1.0.0.md': '---\nschema_version: 1\nid: development\n---\n\n# no version\n',
      'templates/research/1.0.0.md': templateText('research', '1.0.0', '# 调研'),
    },
  });
  await assert.rejects(
    () => resolveTemplate({ repoDir: missingVersion.repo, id: 'development' }),
    /缺少模板版本/,
  );

  const mismatchedCatalog = await makeTemplateRepo(t, {
    files: {
      'templates/development/1.0.0.md': templateText('development', '1.0.1', '# mismatch'),
      'templates/research/1.0.0.md': templateText('research', '1.0.0', '# 调研'),
    },
  });
  await assert.rejects(
    () => resolveTemplate({ repoDir: mismatchedCatalog.repo, id: 'development' }),
    /路径 .* 与 id\/版本不一致/,
  );

  const badPath = await makeTemplateRepo(t, {
    catalog: `schema_version: 1
templates:
  development:
    description: bad path
    default: ../evil.md
`,
  });
  await assert.rejects(
    () => resolveTemplate({ repoDir: badPath.repo, id: 'development' }),
    /不能包含空、\. 或 \.\. 路径段/,
  );

  const outsideTemplates = await makeTemplateRepo(t, {
    catalog: `schema_version: 1
templates:
  development:
    description: outside
    default: templates/evil.md
`,
    files: {
      'templates/evil.md': templateText('development', '1.0.0', '# outside'),
    },
  });
  await assert.rejects(
    () => resolveTemplate({ repoDir: outsideTemplates.repo, id: 'development' }),
    /路径 .* 与 id\/版本不一致/,
  );

  const unknownId = await makeTemplateRepo(t);
  await assert.rejects(
    () => resolveTemplate({ repoDir: unknownId.repo, id: 'missing' }),
    /没有 id missing/,
  );

  const wrongTemplateId = await makeTemplateRepo(t, {
    files: {
      'templates/development/1.0.0.md': templateText('research', '1.0.0', '# wrong id'),
      'templates/research/1.0.0.md': templateText('research', '1.0.0', '# 调研'),
    },
  });
  await assert.rejects(
    () => resolveTemplate({ repoDir: wrongTemplateId.repo, id: 'development' }),
    /与 catalog 的 development 不一致/,
  );
});
