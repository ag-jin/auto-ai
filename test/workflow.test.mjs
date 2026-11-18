import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { evaluateIssue, normalizeRules } from '../src/rules.mjs';
import { Workflow } from '../src/workflow.mjs';

const REPO = 'ag-jin/auto-ai';
const OTHER_REPO = 'dep/repo';

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function requirementsRev({ goal, acceptance, scope, context }) {
  return `sha256:${sha256(JSON.stringify({ goal, acceptance, scope, context }))}`;
}

function makeIssue(number, overrides = {}) {
  return {
    repo: REPO,
    number,
    title: `任务 ${number}`,
    body: `正文 ${number}`,
    state: 'open',
    author: 'alice',
    labels: ['feature'],
    updatedAt: '2026-01-01T00:00:00Z',
    url: `https://github.com/${REPO}/issues/${number}`,
    isPullRequest: false,
    ...overrides,
  };
}

function candidateId(number, repo = REPO) {
  return `${repo.toLowerCase()}#${number}`;
}

async function makeWorkflow(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 't002-workflow-'));
  const dbPath = path.join(dir, 'data', 'workflow.db');
  const wf = new Workflow({ dbPath });
  t.after(async () => {
    wf.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { wf, dbPath, dir };
}

function configure(wf, { rules = {}, concurrency = { global: 4, perRepo: 4 }, repositories = [] } = {}) {
  return wf.saveSettings({
    repositories,
    rules: {
      repositories: [REPO],
      labels: [],
      authors: [],
      keywords: [],
      states: ['open'],
      ...rules,
    },
    concurrency,
  });
}

function makeReady(wf, number, { repo = REPO, draft = {}, action = 'develop', issue = {} } = {}) {
  const id = candidateId(number, repo);
  wf.collect([makeIssue(number, { repo, ...issue })]);
  const saved = wf.saveDraft(id, {
    goal: `目标 ${number}`,
    acceptance: [`验收 ${number}`],
    ...draft,
  });
  if (action) {
    wf.decide(id, { action, draftRev: saved.draft.rev, actor: 'user' });
  }
  return wf.getCandidate(id);
}

function finishWithPr(wf, run, { headSha = 'head-sha-1', number = 1, repo = run.repo, summary = '完成' } = {}) {
  return wf.finishRun(run.id, {
    summary,
    artifacts: [`artifact-${number}`],
    evidence: [`evidence-${number}`],
    pr: {
      repo,
      number,
      url: `https://github.com/${repo}/pull/${number}`,
      headSha,
    },
  });
}

function approveBoth(wf, id, headSha) {
  wf.recordAcceptance(id, { role: 'user', verdict: 'approved', headSha });
  wf.recordAcceptance(id, { role: 'design', verdict: 'approved', headSha });
}

test('规则类别组合、大小写、PR 排除和命中/排除原因', () => {
  const defaults = normalizeRules({});
  assert.deepEqual(defaults, {
    repositories: [],
    labels: [],
    authors: [],
    keywords: [],
    states: ['open'],
  });

  const empty = evaluateIssue(makeIssue(1), defaults);
  assert.equal(empty.matched, false);
  assert.ok(empty.reasons.length > 0);
  assert.match(empty.reasons.join('；'), /仓库规则为空/);

  const rules = normalizeRules({
    repositories: ['AG-JIN/AUTO-AI'],
    labels: ['Feature'],
    authors: ['Octocat'],
    keywords: ['SQLite'],
    states: ['open'],
  });

  const hit = evaluateIssue(
    makeIssue(2, { labels: ['feature'], author: 'octocat', title: 'Add sqlite support' }),
    rules,
  );
  assert.equal(hit.matched, true);
  assert.ok(hit.reasons.length >= 5);
  assert.match(hit.reasons.join('；'), /命中/);

  const bodyHit = evaluateIssue(makeIssue(3, { body: 'uses SQLITE internally' }), {
    ...rules,
    labels: [],
    authors: [],
  });
  assert.equal(bodyHit.matched, true);

  const labelMiss = evaluateIssue(makeIssue(4, { labels: ['bug'] }), rules);
  assert.equal(labelMiss.matched, false);
  assert.match(labelMiss.reasons.join('；'), /标签/);

  const authorMiss = evaluateIssue(makeIssue(5, { author: 'someone' }), rules);
  assert.equal(authorMiss.matched, false);
  assert.match(authorMiss.reasons.join('；'), /作者/);

  const keywordMiss = evaluateIssue(makeIssue(6, { title: 'unrelated', body: 'nothing' }), rules);
  assert.equal(keywordMiss.matched, false);
  assert.match(keywordMiss.reasons.join('；'), /关键词/);

  const closed = evaluateIssue(makeIssue(7, { state: 'closed' }), rules);
  assert.equal(closed.matched, false);
  assert.match(closed.reasons.join('；'), /状态/);

  const pr = evaluateIssue(makeIssue(8, { isPullRequest: true }), rules);
  assert.equal(pr.matched, false);
  assert.match(pr.reasons.join('；'), /Pull Request/);

  const unlimited = evaluateIssue(makeIssue(9, { state: 'closed' }), {
    repositories: [REPO],
    labels: [],
    authors: [],
    keywords: [],
    states: [],
  });
  assert.equal(unlimited.matched, true);

  const repoMiss = evaluateIssue(makeIssue(10, { repo: 'other/repo' }), {
    ...rules,
    labels: [],
    authors: [],
    keywords: [],
  });
  assert.equal(repoMiss.matched, false);
  assert.match(repoMiss.reasons.join('；'), /仓库/);
});

test('设置默认值、校验、保存与重新打开', async (t) => {
  const { wf, dbPath } = await makeWorkflow(t);

  assert.deepEqual(wf.getSettings(), {
    repositories: [],
    rules: {
      repositories: [],
      labels: [],
      authors: [],
      keywords: [],
      states: ['open'],
    },
    concurrency: { global: 2, perRepo: 2 },
  });

  const saved = wf.saveSettings({
    repositories: [{ repo: REPO, localPath: '/tmp/repo', baseRef: 'main' }],
    rules: { repositories: [REPO], labels: ['feature'] },
    concurrency: { global: 1, perRepo: 3 },
  });
  assert.equal(saved.rules.states[0], 'open');
  assert.deepEqual(saved.concurrency, { global: 1, perRepo: 3 });

  const invalidSettings = [
    [{ repositories: [{ repo: 'bad-repo', localPath: '/tmp/x', baseRef: 'main' }] }, /owner\/repo/],
    [
      {
        repositories: [
          { repo: REPO, localPath: '/tmp/a', baseRef: 'main' },
          { repo: REPO.toLowerCase(), localPath: '/tmp/b', baseRef: 'main' },
        ],
      },
      /重复/,
    ],
    [{ repositories: [{ repo: REPO, localPath: '', baseRef: 'main' }] }, /localPath/],
    [{ concurrency: { global: 0, perRepo: 1 } }, /global/],
    [{ concurrency: { global: 2, perRepo: 1.5 } }, /perRepo/],
    [{ rules: { labels: 'feature' } }, /labels/],
    [{ rules: { states: ['merged'] } }, /states/],
  ];
  for (const [settings, expected] of invalidSettings) {
    assert.throws(() => wf.saveSettings(settings), expected);
  }

  assert.deepEqual(wf.getSettings(), saved);

  wf.close();
  const reopened = new Workflow({ dbPath });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.getSettings(), saved);

  const memory = new Workflow({ dbPath: ':memory:' });
  t.after(() => memory.close());
  assert.deepEqual(memory.getSettings().concurrency, { global: 2, perRepo: 2 });
});

test('收集去重、sourceRev 稳定、命中与排除原因', async (t) => {
  const { wf } = await makeWorkflow(t);
  configure(wf, { rules: { labels: ['feature'] } });

  const collected = wf.collect([
    makeIssue(1),
    makeIssue(2, { labels: ['bug'] }),
    makeIssue(3, { isPullRequest: true }),
    makeIssue(4, { state: 'closed' }),
    makeIssue(5, { repo: 'other/repo' }),
  ]);

  assert.equal(collected.length, 5);
  assert.equal(wf.listCandidates().length, 5);
  assert.equal(wf.listCandidates({ includeExcluded: false }).length, 1);
  for (const candidate of collected) {
    assert.ok(candidate.filter.reasons.length > 0);
  }
  assert.equal(collected.find((candidate) => candidate.id === candidateId(1)).filter.matched, true);
  assert.equal(collected.find((candidate) => candidate.id === candidateId(2)).filter.matched, false);
  assert.equal(wf.listCandidates({ repo: REPO }).length, 4);
  assert.equal(wf.getCandidate(candidateId(3)).state, 'candidate');

  const firstSourceRev = wf.getCandidate(candidateId(1)).sourceRev;
  const observedAgain = wf.collect([
    makeIssue(1, { updatedAt: '2030-01-01T00:00:00Z', url: 'https://example.invalid/new' }),
  ]);
  assert.equal(observedAgain.length, 1);
  assert.equal(observedAgain[0].sourceRev, firstSourceRev);
  assert.equal(wf.listCandidates().length, 5);
  assert.equal(wf.getCandidate(candidateId(1)).issue.updatedAt, '2030-01-01T00:00:00Z');

  const changed = wf.collect([makeIssue(1, { body: '新的正文' })]);
  assert.notEqual(changed[0].sourceRev, firstSourceRev);

  const deduped = wf.collect([makeIssue(6), makeIssue(6, { body: 'v2' })]);
  assert.equal(deduped.length, 1);
  assert.equal(wf.getCandidate(candidateId(6)).issue.body, 'v2');

  const upperRepo = wf.collect([makeIssue(7, { repo: REPO.toUpperCase() })]);
  assert.equal(upperRepo[0].id, candidateId(7));

  assert.throws(() => wf.collect([{ ...makeIssue(8), number: 0 }]), /number/);
  assert.equal(wf.listCandidates().some((candidate) => candidate.id === candidateId(8)), false);
});

test('保存任务稿不授予开发权，默认值与需求摘要符合 T001', async (t) => {
  const { wf } = await makeWorkflow(t);
  configure(wf);
  const id = candidateId(1);
  wf.collect([makeIssue(1)]);

  const saved = wf.saveDraft(id, { goal: '  目标  ', acceptance: [' 验收  '] });
  assert.equal(saved.state, 'awaiting_decision');
  assert.equal(saved.decision, null);
  assert.equal(saved.draft.templateId, 'development');
  assert.equal(saved.draft.goal, '目标');
  assert.equal(saved.draft.scope, '');
  assert.equal(saved.draft.context, '');
  assert.deepEqual(saved.draft.acceptance, ['验收']);
  assert.deepEqual(saved.draft.pendingDecisions, []);
  assert.deepEqual(saved.draft.writeScopes, ['*']);
  assert.deepEqual(saved.draft.dependsOn, []);
  assert.equal(saved.draft.priority, 0);
  assert.equal(saved.draft.version, 1);
  assert.equal(
    saved.draft.requirementsRev,
    requirementsRev({ goal: '目标', acceptance: ['验收'], scope: '', context: '' }),
  );

  const eligibility = wf.eligibility(id);
  assert.equal(eligibility.eligible, false);
  assert.match(eligibility.reasons.join('；'), /开发授权/);
  assert.equal(wf.claimNext(), null);

  assert.throws(
    () => wf.decide(id, { action: 'develop', draftRev: saved.draft.rev, actor: 'design' }),
    /用户/,
  );
  assert.throws(
    () => wf.decide(id, { action: 'develop', draftRev: 'sha256:stale', actor: 'user' }),
    /旧版本|不一致/,
  );
  assert.throws(
    () => wf.decide(id, { action: 'approve', draftRev: saved.draft.rev, actor: 'user' }),
    /action/,
  );
});

test('用户决定、待决策项、空验收与活动 Run 门槛', async (t) => {
  const { wf } = await makeWorkflow(t);
  configure(wf);
  const id = candidateId(1);
  wf.collect([makeIssue(1)]);

  const pending = wf.saveDraft(id, {
    goal: '目标',
    acceptance: ['验收'],
    pendingDecisions: ['选择方案'],
  });
  assert.throws(
    () => wf.decide(id, { action: 'develop', draftRev: pending.draft.rev, actor: 'user' }),
    /待决策项/,
  );
  const deferred = wf.decide(id, {
    action: 'defer',
    draftRev: pending.draft.rev,
    actor: 'user',
  });
  assert.equal(deferred.state, 'deferred');
  assert.equal(deferred.decision.action, 'defer');

  const resolved = wf.saveDraft(id, { goal: '目标', acceptance: ['验收'] });
  assert.equal(resolved.draft.version, 2);
  assert.equal(resolved.decision, null);
  assert.equal(resolved.state, 'awaiting_decision');
  const ready = wf.decide(id, {
    action: 'develop',
    draftRev: resolved.draft.rev,
    actor: 'user',
  });
  assert.equal(ready.state, 'ready');

  const run = wf.claimNext();
  assert.equal(run.candidateId, id);
  assert.throws(
    () => wf.decide(id, { action: 'develop', draftRev: resolved.draft.rev, actor: 'user' }),
    /执行中的 Run/,
  );

  const emptyId = candidateId(2);
  wf.collect([makeIssue(2)]);
  const emptyDraft = wf.saveDraft(emptyId, { goal: '目标 2', acceptance: [] });
  assert.throws(
    () => wf.decide(emptyId, { action: 'develop', draftRev: emptyDraft.draft.rev, actor: 'user' }),
    /验收项为空/,
  );
  const ignored = wf.decide(emptyId, {
    action: 'ignore',
    draftRev: emptyDraft.draft.rev,
    actor: 'user',
  });
  assert.equal(ignored.state, 'ignored');
});

test('相同草稿保持版本与授权，内容变化清除决定与验收', async (t) => {
  const { wf } = await makeWorkflow(t);
  configure(wf);
  const id = candidateId(1);
  wf.collect([makeIssue(1)]);

  const first = wf.saveDraft(id, {
    goal: '目标',
    acceptance: ['验收'],
    writeScopes: ['src/b/', './src/a'],
    dependsOn: [],
  });
  assert.deepEqual(first.draft.writeScopes, ['src/a', 'src/b']);
  const decided = wf.decide(id, { action: 'develop', draftRev: first.draft.rev, actor: 'user' });
  assert.equal(decided.state, 'ready');
  assert.equal(decided.draft.version, 1);

  const same = wf.saveDraft(id, {
    goal: ' 目标 ',
    acceptance: [' 验收 '],
    writeScopes: ['src/a', 'src/b'],
    dependsOn: [],
  });
  assert.equal(same.draft.version, 1);
  assert.equal(same.draft.rev, first.draft.rev);
  assert.equal(same.decision.action, 'develop');
  assert.equal(same.state, 'ready');

  const changed = wf.saveDraft(id, {
    goal: '目标',
    acceptance: ['验收', '新增验收'],
    writeScopes: ['src/a', 'src/b'],
  });
  assert.equal(changed.draft.version, 2);
  assert.notEqual(changed.draft.rev, first.draft.rev);
  assert.equal(changed.decision, null);
  assert.equal(changed.state, 'awaiting_decision');

  assert.throws(
    () => wf.decide(id, { action: 'develop', draftRev: first.draft.rev, actor: 'user' }),
    /旧版本|不一致/,
  );

  const cleared = wf.decide(id, {
    action: 'develop',
    draftRev: changed.draft.rev,
    actor: 'user',
  });
  assert.equal(cleared.state, 'ready');
});

test('同优先级按候选创建次序稳定占用', async (t) => {
  const { wf } = await makeWorkflow(t);
  configure(wf, { concurrency: { global: 3, perRepo: 3 } });

  const first = makeReady(wf, 1, { draft: { priority: 0, writeScopes: ['src/1'] } });
  const second = makeReady(wf, 2, { draft: { priority: 0, writeScopes: ['src/2'] } });
  const third = makeReady(wf, 3, { draft: { priority: 0, writeScopes: ['src/3'] } });

  assert.equal(wf.claimNext().candidateId, first.id);
  assert.equal(wf.claimNext().candidateId, second.id);
  assert.equal(wf.claimNext().candidateId, third.id);
});

test('调度：优先级、写入范围冲突与并发上限', async (t) => {
  const { wf } = await makeWorkflow(t);
  configure(wf, { concurrency: { global: 2, perRepo: 2 } });

  const a = makeReady(wf, 1, { draft: { priority: 10, writeScopes: ['src/a'] } });
  const b = makeReady(wf, 2, { draft: { priority: 5, writeScopes: ['src/b'] } });
  const c = makeReady(wf, 3, { draft: { priority: 1, writeScopes: ['src/a/sub'] } });

  const run1 = wf.claimNext();
  const run2 = wf.claimNext();
  const run3 = wf.claimNext();
  assert.equal(run1.candidateId, a.id);
  assert.equal(run2.candidateId, b.id);
  assert.equal(run3, null);

  const blocked = wf.eligibility(c.id);
  assert.equal(blocked.eligible, false);
  assert.match(blocked.reasons.join('；'), /写入范围冲突/);
  assert.match(blocked.reasons.join('；'), /并发/);

  wf.blockRun(run1.id, '为验证冲突排队主动停止');
  const run4 = wf.claimNext();
  assert.equal(run4.candidateId, c.id);
  assert.equal(wf.getCandidate(c.id).state, 'running');
});

test('全局与仓库并发上限、跨仓库 scope 相互独立', async (t) => {
  const { wf } = await makeWorkflow(t);
  configure(wf, {
    rules: { repositories: [REPO, OTHER_REPO] },
    concurrency: { global: 3, perRepo: 1 },
  });

  const a = makeReady(wf, 1, { draft: { priority: 2, writeScopes: ['src/a'] } });
  const b = makeReady(wf, 2, { draft: { priority: 1, writeScopes: ['src/b'] } });
  const c = makeReady(wf, 3, {
    repo: OTHER_REPO,
    draft: { priority: 0, writeScopes: ['src/a'] },
  });

  const run1 = wf.claimNext();
  assert.equal(run1.candidateId, a.id);
  const eligibility = wf.eligibility(b.id);
  assert.equal(eligibility.eligible, false);
  assert.match(eligibility.reasons.join('；'), /仓库.*并发/);

  const run2 = wf.claimNext();
  assert.equal(run2.candidateId, c.id);
  assert.equal(wf.claimNext(), null);

  wf.blockRun(run1.id, '释放仓库并发');
  const run3 = wf.claimNext();
  assert.equal(run3.candidateId, b.id);
});

test('全局并发上限会阻止不同仓库继续占用', async (t) => {
  const { wf } = await makeWorkflow(t);
  configure(wf, {
    rules: { repositories: [REPO, OTHER_REPO] },
    concurrency: { global: 1, perRepo: 5 },
  });

  const a = makeReady(wf, 1, { draft: { priority: 1 } });
  const b = makeReady(wf, 2, { repo: OTHER_REPO, draft: { priority: 0 } });

  const run1 = wf.claimNext();
  assert.equal(run1.candidateId, a.id);
  const blocked = wf.eligibility(b.id);
  assert.equal(blocked.eligible, false);
  assert.match(blocked.reasons.join('；'), /全局并发/);
  assert.equal(wf.claimNext(), null);

  wf.blockRun(run1.id, '释放全局并发');
  const run2 = wf.claimNext();
  assert.equal(run2.candidateId, b.id);
});

test('依赖缺失/未完成排队、跨仓库依赖完成、阻塞候选不堵其他候选', async (t) => {
  const { wf } = await makeWorkflow(t);
  configure(wf, {
    rules: { repositories: [REPO, OTHER_REPO] },
    concurrency: { global: 4, perRepo: 3 },
  });

  const dependency = makeReady(wf, 10, {
    repo: OTHER_REPO,
    draft: { priority: 0 },
  });
  const dependent = makeReady(wf, 1, {
    draft: { priority: 10, dependsOn: [dependency.id] },
  });
  const missing = makeReady(wf, 2, {
    draft: { priority: 20, dependsOn: ['other/repo#999'] },
  });

  const dependentBefore = wf.eligibility(dependent.id);
  assert.equal(dependentBefore.eligible, false);
  assert.match(dependentBefore.reasons.join('；'), /尚未完成/);
  const missingBefore = wf.eligibility(missing.id);
  assert.equal(missingBefore.eligible, false);
  assert.match(missingBefore.reasons.join('；'), /不存在/);

  const run1 = wf.claimNext();
  assert.equal(run1.candidateId, dependency.id);
  finishWithPr(wf, run1, { headSha: 'dep-head', number: 10, repo: OTHER_REPO });
  approveBoth(wf, dependency.id, 'dep-head');
  assert.equal(wf.recordMerged(dependency.id, { headSha: 'dep-head', mergeSha: 'dep-merge' }).state, 'completed');

  const run2 = wf.claimNext();
  assert.equal(run2.candidateId, dependent.id);
  assert.equal(wf.getCandidate(missing.id).state, 'ready');
});

test('保存草稿拒绝自依赖与已知循环依赖', async (t) => {
  const { wf } = await makeWorkflow(t);
  configure(wf);
  for (const number of [1, 2, 3]) {
    wf.collect([makeIssue(number)]);
  }

  wf.saveDraft(candidateId(1), {
    goal: '一',
    acceptance: ['一'],
    dependsOn: [candidateId(2)],
  });
  assert.throws(
    () =>
      wf.saveDraft(candidateId(2), {
        goal: '二',
        acceptance: ['二'],
        dependsOn: [candidateId(1)],
      }),
    /循环/,
  );
  assert.equal(wf.getCandidate(candidateId(2)).draft, null);

  assert.throws(
    () =>
      wf.saveDraft(candidateId(3), {
        goal: '三',
        acceptance: ['三'],
        dependsOn: [candidateId(3)],
      }),
    /循环/,
  );

  assert.throws(
    () =>
      wf.saveDraft(candidateId(3), {
        goal: '三',
        acceptance: ['三'],
        writeScopes: ['../outside'],
      }),
    /相对路径|路径段/,
  );
});

test('两个连接原子占用，close/reopen 后状态、阻塞原因与事件仍在', async (t) => {
  const { wf, dbPath } = await makeWorkflow(t);
  configure(wf, { concurrency: { global: 2, perRepo: 2 } });

  const a = makeReady(wf, 1, { draft: { priority: 2, writeScopes: ['src/one'] } });
  const b = makeReady(wf, 2, { draft: { priority: 1, writeScopes: ['src/two'] } });

  const second = new Workflow({ dbPath });
  t.after(() => second.close());

  const run1 = wf.claimNext();
  const run2 = second.claimNext();
  assert.equal(run1.candidateId, a.id);
  assert.equal(run2.candidateId, b.id);
  assert.equal(wf.claimNext(), null);
  assert.equal(second.claimNext(), null);
  assert.equal(wf.listRuns().length, 2);
  assert.equal(second.listRuns().length, 2);

  wf.bindExecution(run1.id, {
    templateRef: 'commit:templates/development/1.1.0.md',
    branch: 'task/t002',
    worktreePath: '/tmp/worktree-t002',
    pid: 1234,
    sessionId: 'session-t002',
  });
  wf.recordProgress(run1.id, { phase: 'testing', message: '正在运行 npm test' });
  wf.blockRun(run1.id, '模拟执行中断');

  wf.close();
  second.close();

  const reopened = new Workflow({ dbPath });
  t.after(() => reopened.close());

  const candidate = reopened.getCandidate(a.id);
  assert.equal(candidate.state, 'blocked');
  assert.equal(candidate.draft.rev, a.draft.rev);
  assert.equal(candidate.decision.action, 'develop');
  const storedRun = reopened.getRun(run1.id);
  assert.equal(storedRun.status, 'blocked');
  assert.equal(storedRun.blockedReason, '模拟执行中断');
  assert.equal(storedRun.branch, 'task/t002');
  assert.equal(storedRun.worktreePath, '/tmp/worktree-t002');
  assert.equal(storedRun.phase, 'testing');

  const events = reopened.listEvents({ candidateId: a.id });
  assert.ok(events.some((event) => event.kind === 'run.progress'));
  assert.ok(events.some((event) => event.kind === 'run.blocked'));

  reopened.retryCandidate(a.id);
  assert.equal(reopened.getCandidate(a.id).state, 'ready');
  const retried = reopened.claimNext();
  assert.equal(retried.candidateId, a.id);
  assert.notEqual(retried.id, run1.id);
});

test('结束不自动完成/合并，双角色验收与当前 head 匹配', async (t) => {
  const { wf } = await makeWorkflow(t);
  configure(wf);
  const candidate = makeReady(wf, 1);
  const run = wf.claimNext();

  assert.throws(
    () => finishWithPr(wf, run, { repo: OTHER_REPO, number: 99 }),
    /仓库一致/,
  );
  assert.equal(wf.getRun(run.id).status, 'running');

  const finished = finishWithPr(wf, run, { headSha: 'head-a', number: 5 });
  assert.equal(finished.status, 'awaiting_acceptance');
  assert.equal(wf.getCandidate(candidate.id).state, 'awaiting_acceptance');
  assert.equal(wf.getCandidate(candidate.id).state === 'completed', false);
  assert.equal(wf.getRun(run.id).result.summary, '完成');
  assert.equal(wf.getRun(run.id).result.pr.headSha, 'head-a');

  const before = wf.canMerge(candidate.id, { headSha: 'head-a' });
  assert.equal(before.allowed, false);
  assert.match(before.reasons.join('；'), /缺少用户验收/);
  assert.match(before.reasons.join('；'), /缺少设计监督验收/);
  assert.ok(!wf.listEvents({ candidateId: candidate.id }).some((event) => event.kind === 'candidate.merged'));

  assert.throws(
    () =>
      wf.recordAcceptance(candidate.id, {
        role: 'user',
        verdict: 'approved',
        headSha: 'old-head',
      }),
    /head/,
  );
  wf.recordAcceptance(candidate.id, {
    role: 'user',
    verdict: 'approved',
    headSha: 'head-a',
    comment: '用户通过',
  });
  assert.equal(wf.canMerge(candidate.id, { headSha: 'head-a' }).allowed, false);

  wf.recordAcceptance(candidate.id, {
    role: 'design',
    verdict: 'approved',
    headSha: 'head-a',
    comment: '设计通过',
  });
  const allowed = wf.canMerge(candidate.id, { headSha: 'head-a' });
  assert.equal(allowed.allowed, true);
  assert.deepEqual(allowed.reasons, []);
  assert.equal(wf.canMerge(candidate.id, { headSha: 'other-head' }).allowed, false);
  assert.throws(
    () => wf.recordMerged(candidate.id, { headSha: 'other-head', mergeSha: 'merge-x' }),
    /不允许记录合并/,
  );

  const completed = wf.recordMerged(candidate.id, { headSha: 'head-a', mergeSha: 'merge-a' });
  assert.equal(completed.state, 'completed');
  assert.equal(wf.getRun(run.id).status, 'completed');
  assert.equal(wf.getRun(run.id).result.merge.mergeSha, 'merge-a');
  assert.equal(wf.canMerge(candidate.id, { headSha: 'head-a' }).allowed, false);
  assert.throws(
    () =>
      wf.decide(candidate.id, {
        action: 'develop',
        draftRev: completed.draft.rev,
        actor: 'user',
      }),
    /已完成/,
  );
  assert.throws(
    () =>
      wf.recordAcceptance(candidate.id, {
        role: 'user',
        verdict: 'approved',
        headSha: 'head-a',
      }),
    /状态/,
  );
});

test('changes_requested 阻止合并，重试后需要新结果的新验收', async (t) => {
  const { wf } = await makeWorkflow(t);
  configure(wf);
  const candidate = makeReady(wf, 1);
  const firstRun = wf.claimNext();
  finishWithPr(wf, firstRun, { headSha: 'head-r', number: 7 });

  wf.recordAcceptance(candidate.id, {
    role: 'user',
    verdict: 'approved',
    headSha: 'head-r',
  });
  wf.recordAcceptance(candidate.id, {
    role: 'design',
    verdict: 'changes_requested',
    headSha: 'head-r',
    comment: '需要返修',
  });
  const rejected = wf.canMerge(candidate.id, { headSha: 'head-r' });
  assert.equal(rejected.allowed, false);
  assert.match(rejected.reasons.join('；'), /changes_requested/);

  assert.equal(wf.retryCandidate(candidate.id).state, 'ready');
  const secondRun = wf.claimNext();
  assert.notEqual(secondRun.id, firstRun.id);
  finishWithPr(wf, secondRun, { headSha: 'head-r', number: 7 });

  const withoutNewAcceptance = wf.canMerge(candidate.id, { headSha: 'head-r' });
  assert.equal(withoutNewAcceptance.allowed, false);
  assert.match(withoutNewAcceptance.reasons.join('；'), /缺少用户验收/);
  assert.match(withoutNewAcceptance.reasons.join('；'), /缺少设计监督验收/);

  approveBoth(wf, candidate.id, 'head-r');
  assert.equal(wf.canMerge(candidate.id, { headSha: 'head-r' }).allowed, true);
  assert.equal(
    wf.recordMerged(candidate.id, { headSha: 'head-r', mergeSha: 'merge-r' }).state,
    'completed',
  );
});

test('旧草稿与旧源内容的执行结果保留但阻塞，不能结项', async (t) => {
  const { wf } = await makeWorkflow(t);
  configure(wf);
  const id = candidateId(1);
  const candidate = makeReady(wf, 1);
  const run = wf.claimNext();

  const changed = wf.saveDraft(id, {
    goal: '新目标',
    acceptance: ['新验收'],
  });
  assert.equal(changed.draft.version, 2);
  assert.equal(changed.decision, null);
  assert.equal(changed.state, 'running');

  assert.throws(
    () =>
      wf.bindExecution(run.id, {
        templateRef: 'commit:template.md',
        branch: 'old-branch',
        worktreePath: '/tmp/old',
      }),
    /授权/,
  );

  const finished = finishWithPr(wf, run, { headSha: 'old-head' });
  assert.equal(finished.status, 'blocked');
  assert.match(finished.blockedReason, /过时|旧|失效/);
  assert.equal(finished.result.pr.headSha, 'old-head');
  assert.equal(wf.getCandidate(id).state, 'blocked');
  assert.equal(wf.canMerge(id, { headSha: 'old-head' }).allowed, false);

  const acceptedCandidate = makeReady(wf, 2);
  const acceptedRun = wf.claimNext();
  finishWithPr(wf, acceptedRun, { headSha: 'head-2', number: 2 });
  approveBoth(wf, acceptedCandidate.id, 'head-2');
  assert.equal(wf.canMerge(acceptedCandidate.id, { headSha: 'head-2' }).allowed, true);

  const sourceChanged = wf.collect([makeIssue(2, { body: 'Issue 正文已更新' })])[0];
  assert.equal(sourceChanged.draftStale, true);
  assert.equal(sourceChanged.decision, null);
  assert.equal(sourceChanged.state, 'awaiting_decision');
  const staleMerge = wf.canMerge(acceptedCandidate.id, { headSha: 'head-2' });
  assert.equal(staleMerge.allowed, false);
  assert.throws(
    () =>
      wf.recordAcceptance(acceptedCandidate.id, {
        role: 'user',
        verdict: 'approved',
        headSha: 'head-2',
      }),
    /授权/,
  );

  const resaved = wf.saveDraft(acceptedCandidate.id, {
    goal: acceptedCandidate.draft.goal,
    acceptance: acceptedCandidate.draft.acceptance,
  });
  assert.equal(resaved.draftStale, false);
  assert.equal(resaved.state, 'awaiting_decision');
});

test('绑定、进展、阻塞、重试与事件过滤', async (t) => {
  const { wf } = await makeWorkflow(t);
  configure(wf);
  const candidate = makeReady(wf, 1);
  const run = wf.claimNext();
  assert.equal(run.repo, REPO);
  assert.equal(run.issueRef, candidate.id);
  assert.equal(run.status, 'running');
  assert.equal(run.phase, 'claimed');

  const bound = wf.bindExecution(run.id, {
    templateRef: 'abc123:templates/development/1.1.0.md',
    branch: 'task/t002-bind',
    worktreePath: '/tmp/wt-bind',
    pid: 4321,
    sessionId: 'sess-bind',
  });
  assert.equal(bound.branch, 'task/t002-bind');
  assert.equal(bound.worktreePath, '/tmp/wt-bind');
  assert.equal(bound.pid, 4321);
  assert.equal(bound.sessionId, 'sess-bind');
  assert.equal(bound.templateRef, 'abc123:templates/development/1.1.0.md');
  assert.throws(
    () =>
      wf.bindExecution(run.id, {
        templateRef: 'other:template.md',
        branch: 'other',
        worktreePath: '/tmp/other',
      }),
    /已绑定/,
  );

  const progressed = wf.recordProgress(run.id, {
    phase: 'running-tests',
    message: 'npm test',
  });
  assert.equal(progressed.phase, 'running-tests');

  const blocked = wf.blockRun(run.id, '进程未启动');
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blockedReason, '进程未启动');
  assert.equal(wf.getCandidate(candidate.id).state, 'blocked');
  assert.throws(() => wf.recordProgress(run.id, { phase: 'x', message: 'y' }), /状态/);
  assert.throws(() => wf.blockRun(run.id, '重复阻塞'), /状态/);

  const retried = wf.retryCandidate(candidate.id);
  assert.equal(retried.state, 'ready');
  const secondRun = wf.claimNext();
  assert.notEqual(secondRun.id, run.id);
  assert.equal(wf.getRun(run.id).branch, 'task/t002-bind');

  wf.saveDraft(candidate.id, { goal: '新目标', acceptance: ['新验收'] });
  wf.blockRun(secondRun.id, '等待新授权');
  assert.throws(() => wf.retryCandidate(candidate.id), /开发授权/);

  const runEvents = wf.listEvents({ runId: run.id });
  assert.ok(runEvents.some((event) => event.kind === 'run.bound'));
  assert.ok(runEvents.some((event) => event.kind === 'run.progress'));
  assert.ok(runEvents.some((event) => event.kind === 'run.blocked'));

  const candidateEvents = wf.listEvents({ candidateId: candidate.id, repo: REPO });
  assert.ok(candidateEvents.length > 0);
  assert.ok(candidateEvents.every((event) => event.candidateId === candidate.id));
  assert.ok(candidateEvents.every((event) => event.repo === REPO));

  const limited = wf.listEvents({ limit: 2 });
  assert.equal(limited.length, 2);
  const after = wf.listEvents({ after: limited[0].id, limit: 2 });
  assert.ok(after.every((event) => event.id > limited[0].id));

  assert.throws(() => wf.listEvents({ after: -1 }), /after/);
  assert.throws(() => wf.listEvents({ limit: 0 }), /limit/);
  assert.throws(() => wf.getCandidate('missing/repo#1'), /不存在/);
  assert.throws(() => wf.getRun('missing-run'), /不存在/);
});

// -----------------------------------------------------------------------
// Bounded auto repair (domain layer)
// -----------------------------------------------------------------------

const AUTO_TEMPLATE = {
  commit: 'a'.repeat(40),
  path: 'templates/development/1.1.0.md',
  id: 'development',
  version: '1.1.0',
};

function pinTemplate(wf, id, template = AUTO_TEMPLATE) {
  const candidate = wf.getCandidate(id);
  return wf.decide(id, {
    action: 'develop',
    draftRev: candidate.draft.rev,
    actor: 'user',
    template,
  });
}

function requestChanges(wf, id, headSha, role = 'design') {
  return wf.recordAcceptance(id, { role, verdict: 'changes_requested', headSha, comment: '需要返修' });
}

function enableAutoRepair(wf, id) {
  return wf.setAutoRepair(id, { enabled: true, draftRev: wf.getCandidate(id).draft.rev });
}

function deliver(wf, id, headSha, number = 1) {
  const run = wf.claimNext();
  assert.equal(run.candidateId, id);
  finishWithPr(wf, run, { headSha, number });
  return run;
}

test('自动返修默认关闭，最多两次且首个来源 Run 不计入预算', async (t) => {
  const { wf } = await makeWorkflow(t);
  configure(wf);
  const candidate = makeReady(wf, 1);
  pinTemplate(wf, candidate.id);

  const defaults = wf.getAutoRepair(candidate.id);
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.limit, 2);
  assert.equal(defaults.used, 0);
  assert.equal(defaults.remaining, 2);
  assert.match(defaults.reason, /未开启/);
  assert.equal(defaults.draftRev, candidate.draft.rev);
  assert.equal(defaults.requirementsRev, candidate.draft.requirementsRev);
  assert.equal(defaults.sourceRev, candidate.sourceRev);

  const run1 = wf.claimNext();
  finishWithPr(wf, run1, { headSha: 'head-1', number: 1 });
  requestChanges(wf, candidate.id, 'head-1', 'user');

  const disabledSkip = wf.queueAutoRepair(candidate.id, {
    expectedRunId: run1.id,
    expectedHeadSha: 'head-1',
  });
  assert.equal(disabledSkip.queued, false);
  assert.match(disabledSkip.reason, /未开启/);
  assert.equal(wf.getAutoRepair(candidate.id).used, 0);
  assert.equal(wf.getCandidate(candidate.id).state, 'awaiting_acceptance');

  const enabled = enableAutoRepair(wf, candidate.id);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.used, 0);
  // Enabling alone never dispatches a run.
  assert.equal(wf.listRuns().length, 1);
  assert.equal(wf.getCandidate(candidate.id).state, 'awaiting_acceptance');

  const first = wf.queueAutoRepair(candidate.id, {
    expectedRunId: run1.id,
    expectedHeadSha: 'head-1',
  });
  assert.equal(first.queued, true);
  assert.equal(first.used, 1);
  assert.equal(first.remaining, 1);
  assert.equal(wf.getCandidate(candidate.id).state, 'ready');
  let state = wf.getAutoRepair(candidate.id);
  assert.equal(state.used, 1);
  assert.equal(state.pendingFromRunId, run1.id);

  // Re-queueing the same source Run only counts once.
  assert.equal(
    wf.queueAutoRepair(candidate.id, { expectedRunId: run1.id, expectedHeadSha: 'head-1' }).queued,
    false,
  );
  assert.equal(wf.getAutoRepair(candidate.id).used, 1);

  const run2 = wf.claimNext();
  assert.notEqual(run2.id, run1.id);
  assert.equal(run2.candidateId, candidate.id);
  // Source Run still cannot be consumed again while the new Run is active.
  assert.equal(
    wf.queueAutoRepair(candidate.id, { expectedRunId: run1.id, expectedHeadSha: 'head-1' }).queued,
    false,
  );
  assert.equal(wf.getAutoRepair(candidate.id).used, 1);

  finishWithPr(wf, run2, { headSha: 'head-2', number: 1 });
  requestChanges(wf, candidate.id, 'head-2');
  const second = wf.queueAutoRepair(candidate.id, {
    expectedRunId: run2.id,
    expectedHeadSha: 'head-2',
  });
  assert.equal(second.queued, true);
  assert.equal(second.used, 2);
  assert.equal(second.remaining, 0);

  const run3 = wf.claimNext();
  assert.notEqual(run3.id, run2.id);
  finishWithPr(wf, run3, { headSha: 'head-3', number: 1 });
  requestChanges(wf, candidate.id, 'head-3');

  const third = wf.queueAutoRepair(candidate.id, {
    expectedRunId: run3.id,
    expectedHeadSha: 'head-3',
  });
  assert.equal(third.queued, false);
  assert.match(third.reason, /上限/);
  assert.equal(third.used, 2);
  const exhausted = wf.getAutoRepair(candidate.id);
  assert.equal(exhausted.used, 2);
  assert.equal(exhausted.remaining, 0);
  assert.match(exhausted.reason, /上限/);
  assert.equal(wf.getCandidate(candidate.id).state, 'awaiting_acceptance');
  assert.equal(wf.listRuns().length, 3);

  // No automatic approval or merge: the explicit gate still denies.
  const merge = wf.canMerge(candidate.id, { headSha: 'head-3' });
  assert.equal(merge.allowed, false);

  // Disable + re-enable the same version must not reset the counter.
  wf.setAutoRepair(candidate.id, { enabled: false });
  enableAutoRepair(wf, candidate.id);
  assert.equal(wf.getAutoRepair(candidate.id).used, 2);
});

test('自动返修同一 Run 只消费一次，重开数据库与关闭再开启保留计数', async (t) => {
  const { wf, dbPath } = await makeWorkflow(t);
  configure(wf);
  const candidate = makeReady(wf, 1);
  pinTemplate(wf, candidate.id);
  const run1 = wf.claimNext();
  finishWithPr(wf, run1, { headSha: 'head-1', number: 1 });
  requestChanges(wf, candidate.id, 'head-1');
  enableAutoRepair(wf, candidate.id);

  const other = new Workflow({ dbPath });
  try {
    const racing = [
      wf.queueAutoRepair(candidate.id, { expectedRunId: run1.id, expectedHeadSha: 'head-1' }),
      other.queueAutoRepair(candidate.id, { expectedRunId: run1.id, expectedHeadSha: 'head-1' }),
    ];
    assert.equal(racing.filter((entry) => entry.queued).length, 1);
  } finally {
    other.close();
  }
  assert.equal(wf.getAutoRepair(candidate.id).used, 1);
  assert.equal(
    wf.queueAutoRepair(candidate.id, { expectedRunId: run1.id, expectedHeadSha: 'head-1' }).queued,
    false,
  );
  assert.equal(wf.getAutoRepair(candidate.id).used, 1);

  const run2 = wf.claimNext();
  finishWithPr(wf, run2, { headSha: 'head-2', number: 1 });
  requestChanges(wf, candidate.id, 'head-2');
  wf.setAutoRepair(candidate.id, { enabled: false });
  enableAutoRepair(wf, candidate.id);
  assert.equal(wf.getAutoRepair(candidate.id).used, 1);

  wf.close();
  const reopened = new Workflow({ dbPath });
  try {
    const state = reopened.getAutoRepair(candidate.id);
    assert.equal(state.enabled, true);
    assert.equal(state.used, 1);
    assert.equal(state.remaining, 1);
    const queued = reopened.queueAutoRepair(candidate.id, {
      expectedRunId: run2.id,
      expectedHeadSha: 'head-2',
    });
    assert.equal(queued.queued, true);
    assert.equal(reopened.getAutoRepair(candidate.id).used, 2);
  } finally {
    reopened.close();
  }
});

test('自动返修拒绝错误 Run/head、旧版本、approved 覆盖、无固定模板、无授权与活动 Run', async (t) => {
  const { wf } = await makeWorkflow(t);
  configure(wf);

  const candidate = makeReady(wf, 1);
  pinTemplate(wf, candidate.id);
  const run1 = wf.claimNext();
  finishWithPr(wf, run1, { headSha: 'head-1', number: 1 });
  requestChanges(wf, candidate.id, 'head-1');
  enableAutoRepair(wf, candidate.id);

  const wrongRun = wf.queueAutoRepair(candidate.id, {
    expectedRunId: 'run-missing',
    expectedHeadSha: 'head-1',
  });
  assert.equal(wrongRun.queued, false);
  assert.match(wrongRun.reason, /最新 Run/);

  const wrongHead = wf.queueAutoRepair(candidate.id, {
    expectedRunId: run1.id,
    expectedHeadSha: 'other-head',
  });
  assert.equal(wrongHead.queued, false);
  assert.match(wrongHead.reason, /head/);
  assert.equal(wf.getAutoRepair(candidate.id).used, 0);

  // A later approved verdict replaces the earlier changes_requested.
  wf.recordAcceptance(candidate.id, { role: 'design', verdict: 'approved', headSha: 'head-1' });
  const overridden = wf.queueAutoRepair(candidate.id, {
    expectedRunId: run1.id,
    expectedHeadSha: 'head-1',
  });
  assert.equal(overridden.queued, false);
  assert.match(overridden.reason, /changes_requested/);
  assert.equal(wf.getAutoRepair(candidate.id).used, 0);

  // No pinned template on the decision.
  const noTemplate = makeReady(wf, 2);
  const run2 = wf.claimNext();
  finishWithPr(wf, run2, { headSha: 'head-2', number: 2 });
  requestChanges(wf, noTemplate.id, 'head-2');
  enableAutoRepair(wf, noTemplate.id);
  const missingTemplate = wf.queueAutoRepair(noTemplate.id, {
    expectedRunId: run2.id,
    expectedHeadSha: 'head-2',
  });
  assert.equal(missingTemplate.queued, false);
  assert.match(missingTemplate.reason, /固定模板/);

  // A revoked develop decision invalidates and persistently revokes the policy.
  const revoked = makeReady(wf, 3);
  pinTemplate(wf, revoked.id);
  const run3 = wf.claimNext();
  finishWithPr(wf, run3, { headSha: 'head-3', number: 3 });
  requestChanges(wf, revoked.id, 'head-3');
  enableAutoRepair(wf, revoked.id);
  wf.decide(revoked.id, { action: 'defer', draftRev: revoked.draft.rev, actor: 'user' });
  assert.equal(wf.getAutoRepair(revoked.id).enabled, false);
  const noDecision = wf.queueAutoRepair(revoked.id, {
    expectedRunId: run3.id,
    expectedHeadSha: 'head-3',
  });
  assert.equal(noDecision.queued, false);
  assert.match(noDecision.reason, /未开启|授权|develop/);

  // A newer draft revision starts disabled and cannot reuse the old budget.
  const versioned = makeReady(wf, 4);
  pinTemplate(wf, versioned.id);
  const run4 = wf.claimNext();
  finishWithPr(wf, run4, { headSha: 'head-4', number: 4 });
  requestChanges(wf, versioned.id, 'head-4');
  enableAutoRepair(wf, versioned.id);
  const changedDraft = wf.saveDraft(versioned.id, {
    goal: `目标 4`,
    acceptance: ['验收 4', '新增验收'],
  });
  wf.decide(versioned.id, {
    action: 'develop',
    draftRev: changedDraft.draft.rev,
    actor: 'user',
    template: AUTO_TEMPLATE,
  });
  const newVersion = wf.getAutoRepair(versioned.id);
  assert.equal(newVersion.enabled, false);
  assert.equal(newVersion.used, 0);
  assert.equal(newVersion.draftRev, changedDraft.draft.rev);
  const oldVersionQueue = wf.queueAutoRepair(versioned.id, {
    expectedRunId: run4.id,
    expectedHeadSha: 'head-4',
  });
  assert.equal(oldVersionQueue.queued, false);
  assert.match(oldVersionQueue.reason, /未开启/);

  // An active Run blocks queueing for the previous delivery.
  {
    const { wf: activeWf } = await makeWorkflow(t);
    configure(activeWf);
    const active = makeReady(activeWf, 5);
    pinTemplate(activeWf, active.id);
    const run5 = activeWf.claimNext();
    finishWithPr(activeWf, run5, { headSha: 'head-5', number: 5 });
    requestChanges(activeWf, active.id, 'head-5');
    enableAutoRepair(activeWf, active.id);
    activeWf.retryCandidate(active.id);
    const run5b = activeWf.claimNext();
    assert.equal(run5b.candidateId, active.id);
    const activeSkip = activeWf.queueAutoRepair(active.id, {
      expectedRunId: run5.id,
      expectedHeadSha: 'head-5',
    });
    assert.equal(activeSkip.queued, false);
    assert.match(activeSkip.reason, /状态为 running|活动 Run|执行中的 Run/);
    assert.equal(activeWf.getAutoRepair(active.id).used, 0);
  }

  // A changed Issue source revision starts a disabled policy identity.
  {
    const { wf: sourceWf } = await makeWorkflow(t);
    configure(sourceWf);
    const sourceCandidate = makeReady(sourceWf, 6);
    pinTemplate(sourceWf, sourceCandidate.id);
    const sourceRun = sourceWf.claimNext();
    finishWithPr(sourceWf, sourceRun, { headSha: 'head-6', number: 6 });
    requestChanges(sourceWf, sourceCandidate.id, 'head-6');
    enableAutoRepair(sourceWf, sourceCandidate.id);
    sourceWf.collect([makeIssue(6, { body: '源内容已变化' })]);
    const changedSource = sourceWf.getAutoRepair(sourceCandidate.id);
    assert.notEqual(changedSource.sourceRev, sourceCandidate.sourceRev);
    assert.equal(changedSource.enabled, false);
    assert.equal(changedSource.used, 0);
    const oldSourceQueue = sourceWf.queueAutoRepair(sourceCandidate.id, {
      expectedRunId: sourceRun.id,
      expectedHeadSha: 'head-6',
    });
    assert.equal(oldSourceQueue.queued, false);
    assert.match(oldSourceQueue.reason, /未开启/);
  }
});

test('自动排队在 claimNext 前关闭、撤销或改判 approved 时不启动', async (t) => {
  // (a) Disabling the policy cancels the unclaimed auto queue.
  {
    const { wf } = await makeWorkflow(t);
    configure(wf);
    const candidate = makeReady(wf, 1);
    pinTemplate(wf, candidate.id);
    const run = wf.claimNext();
    finishWithPr(wf, run, { headSha: 'head-1', number: 1 });
    requestChanges(wf, candidate.id, 'head-1');
    enableAutoRepair(wf, candidate.id);
    assert.equal(
      wf.queueAutoRepair(candidate.id, { expectedRunId: run.id, expectedHeadSha: 'head-1' }).queued,
      true,
    );
    wf.setAutoRepair(candidate.id, { enabled: false });
    assert.equal(wf.getCandidate(candidate.id).state, 'awaiting_acceptance');
    assert.equal(wf.claimNext(), null);
    assert.equal(wf.listRuns().length, 1);

    // A real manual retry is still claimable after the auto queue was cancelled.
    wf.retryCandidate(candidate.id);
    const manual = wf.claimNext();
    assert.equal(manual.candidateId, candidate.id);
    assert.notEqual(manual.id, run.id);
  }

  // (b) Revoking the develop decision cancels the unclaimed auto queue.
  {
    const { wf } = await makeWorkflow(t);
    configure(wf);
    const candidate = makeReady(wf, 1);
    pinTemplate(wf, candidate.id);
    const run = wf.claimNext();
    finishWithPr(wf, run, { headSha: 'head-1', number: 1 });
    requestChanges(wf, candidate.id, 'head-1');
    enableAutoRepair(wf, candidate.id);
    assert.equal(
      wf.queueAutoRepair(candidate.id, { expectedRunId: run.id, expectedHeadSha: 'head-1' }).queued,
      true,
    );
    wf.decide(candidate.id, { action: 'defer', draftRev: candidate.draft.rev, actor: 'user' });
    assert.equal(wf.claimNext(), null);
    assert.equal(wf.listRuns().length, 1);
  }

  // (c) A later approved verdict cancels the unclaimed auto queue at claim time.
  {
    const { wf } = await makeWorkflow(t);
    configure(wf);
    const candidate = makeReady(wf, 1);
    pinTemplate(wf, candidate.id);
    const run = wf.claimNext();
    finishWithPr(wf, run, { headSha: 'head-1', number: 1 });
    requestChanges(wf, candidate.id, 'head-1');
    enableAutoRepair(wf, candidate.id);
    assert.equal(
      wf.queueAutoRepair(candidate.id, { expectedRunId: run.id, expectedHeadSha: 'head-1' }).queued,
      true,
    );
    wf.recordAcceptance(candidate.id, { role: 'design', verdict: 'approved', headSha: 'head-1' });
    assert.equal(wf.claimNext(), null);
    assert.equal(wf.listRuns().length, 1);
    assert.equal(wf.getCandidate(candidate.id).state, 'awaiting_acceptance');
    assert.equal(wf.getAutoRepair(candidate.id).enabled, true);

    // Manual retry remains explicit and does not re-consume the old Run.
    wf.retryCandidate(candidate.id);
    const manual = wf.claimNext();
    assert.equal(manual.candidateId, candidate.id);
    finishWithPr(wf, manual, { headSha: 'head-1', number: 1 });
    requestChanges(wf, candidate.id, 'head-1');
    const oldRun = wf.queueAutoRepair(candidate.id, {
      expectedRunId: run.id,
      expectedHeadSha: 'head-1',
    });
    assert.equal(oldRun.queued, false);
    assert.match(oldRun.reason, /已消费/);
  }
});

test('自动返修不改任务范围与模板，显式合并门槛仍生效，其他任务不被预算耗尽阻塞', async (t) => {
  const { wf } = await makeWorkflow(t);
  configure(wf);
  const candidate = makeReady(wf, 1, { draft: { writeScopes: ['src/a'] } });
  pinTemplate(wf, candidate.id);
  const pinned = wf.getCandidate(candidate.id).pinnedTemplate;

  const run1 = wf.claimNext();
  finishWithPr(wf, run1, { headSha: 'head-1', number: 1 });
  requestChanges(wf, candidate.id, 'head-1');
  enableAutoRepair(wf, candidate.id);
  assert.equal(
    wf.queueAutoRepair(candidate.id, { expectedRunId: run1.id, expectedHeadSha: 'head-1' }).queued,
    true,
  );
  const run2 = wf.claimNext();
  // Same draft revision, requirements, source, scopes and fixed template.
  assert.equal(run2.draftRev, candidate.draft.rev);
  assert.equal(run2.requirementsRev, candidate.draft.requirementsRev);
  assert.equal(run2.sourceRev, candidate.sourceRev);
  assert.deepEqual(run2.draftSnapshot.writeScopes, ['src/a']);
  assert.equal(pinned.templateRef, `${AUTO_TEMPLATE.commit}:${AUTO_TEMPLATE.path}`);
  assert.equal(wf.getCandidate(candidate.id).pinnedTemplate.draftRev, candidate.draft.rev);
  assert.equal(wf.getCandidate(candidate.id).draft.rev, candidate.draft.rev);

  finishWithPr(wf, run2, { headSha: 'head-2', number: 1 });
  requestChanges(wf, candidate.id, 'head-2');
  assert.equal(
    wf.queueAutoRepair(candidate.id, { expectedRunId: run2.id, expectedHeadSha: 'head-2' }).queued,
    true,
  );
  const run3 = wf.claimNext();
  finishWithPr(wf, run3, { headSha: 'head-3', number: 1 });
  requestChanges(wf, candidate.id, 'head-3');
  assert.equal(wf.queueAutoRepair(candidate.id, { expectedRunId: run3.id, expectedHeadSha: 'head-3' }).queued, false);

  // Exhaustion keeps the explicit gate and never auto-merges.
  const merge = wf.canMerge(candidate.id, { headSha: 'head-3' });
  assert.equal(merge.allowed, false);
  assert.ok(!wf.listEvents({ candidateId: candidate.id }).some((event) => event.kind === 'candidate.merged'));

  // Manual retry keeps the automatic count and cannot re-consume the old Run.
  wf.retryCandidate(candidate.id);
  const manual = wf.claimNext();
  assert.equal(manual.candidateId, candidate.id);
  finishWithPr(wf, manual, { headSha: 'head-4', number: 1 });
  requestChanges(wf, candidate.id, 'head-4');
  const afterManual = wf.queueAutoRepair(candidate.id, {
    expectedRunId: manual.id,
    expectedHeadSha: 'head-4',
  });
  assert.equal(afterManual.queued, false);
  assert.match(afterManual.reason, /上限/);
  assert.equal(wf.getAutoRepair(candidate.id).used, 2);

  // Another task keeps its own budget and is not blocked by the exhausted one.
  const other = makeReady(wf, 2, { draft: { writeScopes: ['src/b'] } });
  pinTemplate(wf, other.id);
  const otherRun1 = wf.claimNext();
  assert.equal(otherRun1.candidateId, other.id);
  finishWithPr(wf, otherRun1, { headSha: 'other-1', number: 2 });
  requestChanges(wf, other.id, 'other-1');
  enableAutoRepair(wf, other.id);
  const otherQueued = wf.queueAutoRepair(other.id, {
    expectedRunId: otherRun1.id,
    expectedHeadSha: 'other-1',
  });
  assert.equal(otherQueued.queued, true);
  assert.equal(otherQueued.used, 1);
  const otherRun2 = wf.claimNext();
  assert.equal(otherRun2.candidateId, other.id);
  assert.equal(wf.getAutoRepair(other.id).remaining, 1);
});

test('Issue 源内容 A→B→A 不复活旧自动返修，重新显式开启仍保留已用次数', async (t) => {
  const { wf } = await makeWorkflow(t);
  configure(wf);
  const candidate = makeReady(wf, 1);
  pinTemplate(wf, candidate.id);
  const run1 = wf.claimNext();
  finishWithPr(wf, run1, { headSha: 'head-1', number: 1 });
  requestChanges(wf, candidate.id, 'head-1');
  enableAutoRepair(wf, candidate.id);
  assert.equal(
    wf.queueAutoRepair(candidate.id, { expectedRunId: run1.id, expectedHeadSha: 'head-1' }).queued,
    true,
  );
  const run2 = wf.claimNext();
  assert.equal(run2.candidateId, candidate.id);
  finishWithPr(wf, run2, { headSha: 'head-2', number: 1 });
  requestChanges(wf, candidate.id, 'head-2');

  const original = wf.getCandidate(candidate.id);
  assert.equal(wf.getAutoRepair(candidate.id).used, 1);

  // Source A -> B revokes the persisted opt-in immediately.
  wf.collect([makeIssue(1, { body: '正文 1 已变更' })]);
  const changed = wf.getAutoRepair(candidate.id);
  assert.notEqual(changed.sourceRev, original.sourceRev);
  assert.equal(changed.enabled, false);
  assert.equal(changed.pendingFromRunId, null);

  // Source back to A must not revive the old opt-in, and must keep the ledger.
  wf.collect([makeIssue(1)]);
  assert.equal(wf.getCandidate(candidate.id).sourceRev, original.sourceRev);
  const restored = wf.getAutoRepair(candidate.id);
  assert.equal(restored.enabled, false);
  assert.equal(restored.used, 1);
  assert.equal(restored.remaining, 1);
  assert.equal(restored.pendingFromRunId, null);
  assert.ok(
    wf.listEvents({ candidateId: candidate.id }).some((event) => event.kind === 'auto_repair.revoked'),
  );

  // No fresh opt-in: an auto queue must be rejected, not silently revived.
  const noOptIn = wf.queueAutoRepair(candidate.id, {
    expectedRunId: run2.id,
    expectedHeadSha: 'head-2',
  });
  assert.equal(noOptIn.queued, false);
  assert.match(noOptIn.reason, /未开启/);
  assert.equal(wf.getCandidate(candidate.id).state, 'awaiting_decision');

  // Re-saving the original content and re-developing is not a new opt-in.
  const resaved = wf.saveDraft(candidate.id, {
    goal: original.draft.goal,
    acceptance: original.draft.acceptance,
  });
  assert.equal(resaved.draft.rev, original.draft.rev);
  wf.decide(candidate.id, {
    action: 'develop',
    draftRev: resaved.draft.rev,
    actor: 'user',
    template: AUTO_TEMPLATE,
  });
  assert.equal(wf.getAutoRepair(candidate.id).enabled, false);
  const stillDisabled = wf.queueAutoRepair(candidate.id, {
    expectedRunId: run2.id,
    expectedHeadSha: 'head-2',
  });
  assert.equal(stillDisabled.queued, false);
  assert.match(stillDisabled.reason, /未开启/);

  // A new explicit opt-in keeps the already consumed count (1 used, 1 left).
  const manualRun = wf.claimNext();
  assert.equal(manualRun.candidateId, candidate.id);
  finishWithPr(wf, manualRun, { headSha: 'head-3', number: 1 });
  requestChanges(wf, candidate.id, 'head-3');
  assert.equal(wf.getAutoRepair(candidate.id).enabled, false);
  const reenabled = enableAutoRepair(wf, candidate.id);
  assert.equal(reenabled.enabled, true);
  assert.equal(reenabled.used, 1);
  assert.equal(reenabled.remaining, 1);
  const queued = wf.queueAutoRepair(candidate.id, {
    expectedRunId: manualRun.id,
    expectedHeadSha: 'head-3',
  });
  assert.equal(queued.queued, true);
  assert.equal(queued.used, 2);
  assert.equal(queued.remaining, 0);
});

test('任务稿 A→B→A 不复活旧自动返修，同稿保存不误撤销', async (t) => {
  const { wf } = await makeWorkflow(t);
  configure(wf);
  const candidate = makeReady(wf, 1);
  pinTemplate(wf, candidate.id);
  const run1 = wf.claimNext();
  finishWithPr(wf, run1, { headSha: 'head-1', number: 1 });
  requestChanges(wf, candidate.id, 'head-1');
  enableAutoRepair(wf, candidate.id);
  assert.equal(
    wf.queueAutoRepair(candidate.id, { expectedRunId: run1.id, expectedHeadSha: 'head-1' }).queued,
    true,
  );

  // Re-saving identical content is not a version change: keep opt-in and queue.
  wf.saveDraft(candidate.id, { goal: '目标 1', acceptance: ['验收 1'] });
  const unchanged = wf.getAutoRepair(candidate.id);
  assert.equal(unchanged.enabled, true);
  assert.equal(unchanged.pendingFromRunId, run1.id);
  assert.equal(wf.getCandidate(candidate.id).state, 'ready');

  const original = wf.getCandidate(candidate.id);
  assert.equal(wf.getAutoRepair(candidate.id).used, 1);

  // A changed draft revision revokes the old opt-in and clears the pending queue.
  const draftB = wf.saveDraft(candidate.id, { goal: '目标 1 已修改', acceptance: ['验收 1'] });
  assert.notEqual(draftB.draft.rev, original.draft.rev);
  const afterB = wf.getAutoRepair(candidate.id);
  assert.equal(afterB.enabled, false);
  assert.equal(afterB.pendingFromRunId, null);
  assert.equal(afterB.used, 0);
  assert.equal(wf.getCandidate(candidate.id).state, 'awaiting_decision');

  // Returning to the original content must not revive the old row.
  const backToA = wf.saveDraft(candidate.id, {
    goal: original.draft.goal,
    acceptance: original.draft.acceptance,
  });
  assert.equal(backToA.draft.rev, original.draft.rev);
  wf.decide(candidate.id, {
    action: 'develop',
    draftRev: backToA.draft.rev,
    actor: 'user',
    template: AUTO_TEMPLATE,
  });
  const revived = wf.getAutoRepair(candidate.id);
  assert.equal(revived.enabled, false);
  assert.equal(revived.used, 1);
  assert.equal(revived.remaining, 1);
  assert.equal(revived.pendingFromRunId, null);

  // A fresh opt-in preserves the old version's used count.
  const manualRun = wf.claimNext();
  assert.equal(manualRun.candidateId, candidate.id);
  finishWithPr(wf, manualRun, { headSha: 'head-2', number: 1 });
  requestChanges(wf, candidate.id, 'head-2');
  const blocked = wf.queueAutoRepair(candidate.id, {
    expectedRunId: manualRun.id,
    expectedHeadSha: 'head-2',
  });
  assert.equal(blocked.queued, false);
  assert.match(blocked.reason, /未开启/);
  const reenabled = enableAutoRepair(wf, candidate.id);
  assert.equal(reenabled.used, 1);
  assert.equal(reenabled.remaining, 1);
  const queued = wf.queueAutoRepair(candidate.id, {
    expectedRunId: manualRun.id,
    expectedHeadSha: 'head-2',
  });
  assert.equal(queued.queued, true);
  assert.equal(queued.used, 2);
});

test('defer 撤销自动排队与 opt-in，重新 develop 不恢复，手动 ready 不受影响', async (t) => {
  const { wf } = await makeWorkflow(t);
  configure(wf);
  const candidate = makeReady(wf, 1);
  pinTemplate(wf, candidate.id);
  const run1 = wf.claimNext();
  finishWithPr(wf, run1, { headSha: 'head-1', number: 1 });
  requestChanges(wf, candidate.id, 'head-1');
  enableAutoRepair(wf, candidate.id);
  assert.equal(
    wf.queueAutoRepair(candidate.id, { expectedRunId: run1.id, expectedHeadSha: 'head-1' }).queued,
    true,
  );
  assert.equal(wf.getCandidate(candidate.id).state, 'ready');

  wf.decide(candidate.id, { action: 'defer', draftRev: candidate.draft.rev, actor: 'user' });
  assert.equal(wf.getCandidate(candidate.id).state, 'deferred');
  const deferred = wf.getAutoRepair(candidate.id);
  assert.equal(deferred.enabled, false);
  assert.equal(deferred.pendingFromRunId, null);
  assert.equal(deferred.used, 1);
  assert.equal(wf.claimNext(), null);
  assert.equal(wf.listRuns().length, 1);

  // Re-developing the same draft is not a new auto-repair opt-in.
  wf.decide(candidate.id, {
    action: 'develop',
    draftRev: candidate.draft.rev,
    actor: 'user',
    template: AUTO_TEMPLATE,
  });
  assert.equal(wf.getAutoRepair(candidate.id).enabled, false);

  // A genuine manual ready still claims; the cancelled auto queue does not interfere.
  const manualRun = wf.claimNext();
  assert.equal(manualRun.candidateId, candidate.id);
  finishWithPr(wf, manualRun, { headSha: 'head-2', number: 1 });
  requestChanges(wf, candidate.id, 'head-2');
  const blocked = wf.queueAutoRepair(candidate.id, {
    expectedRunId: manualRun.id,
    expectedHeadSha: 'head-2',
  });
  assert.equal(blocked.queued, false);
  assert.match(blocked.reason, /未开启/);

  const reenabled = enableAutoRepair(wf, candidate.id);
  assert.equal(reenabled.enabled, true);
  assert.equal(reenabled.used, 1);
  assert.equal(reenabled.remaining, 1);
  const queued = wf.queueAutoRepair(candidate.id, {
    expectedRunId: manualRun.id,
    expectedHeadSha: 'head-2',
  });
  assert.equal(queued.queued, true);
  assert.equal(queued.used, 2);
});

test('claimNext 自动候选 allowlist：未列入的 pending 保留且不屏蔽手动任务，缺省保持领域语义', async (t) => {
  const { wf } = await makeWorkflow(t);
  configure(wf);

  // Candidate 1: a queued automatic repair awaiting claim.
  const auto = makeReady(wf, 1, { draft: { writeScopes: ['src/auto.mjs'] } });
  pinTemplate(wf, auto.id);
  const run1 = wf.claimNext();
  finishWithPr(wf, run1, { headSha: 'head-1', number: 1 });
  requestChanges(wf, auto.id, 'head-1');
  enableAutoRepair(wf, auto.id);
  assert.equal(
    wf.queueAutoRepair(auto.id, { expectedRunId: run1.id, expectedHeadSha: 'head-1' }).queued,
    true,
  );
  assert.equal(wf.getCandidate(auto.id).state, 'ready');

  // Candidate 2: a plain manual ready task without any pending auto marker.
  const manual = makeReady(wf, 2, { draft: { writeScopes: ['src/manual.mjs'] } });
  pinTemplate(wf, manual.id);
  assert.equal(wf.getCandidate(manual.id).state, 'ready');

  // An empty allowlist defers the automatic queue without cancelling it and
  // still claims the unrelated manual task.
  const claimed = wf.claimNext({ autoRepairAllowlist: [] });
  assert.equal(claimed.candidateId, manual.id);
  const deferred = wf.getAutoRepair(auto.id);
  assert.equal(deferred.pendingFromRunId, run1.id, '未核验的 pending 必须保留');
  assert.equal(deferred.used, 1);
  assert.equal(wf.getCandidate(auto.id).state, 'ready');
  assert.equal(wf.listRuns().filter((run) => run.candidateId === auto.id).length, 1);
  assert.equal(
    wf
      .listEvents({ candidateId: auto.id })
      .some((event) => event.kind === 'auto_repair.cancelled'),
    false,
  );

  // The default call keeps the pure domain semantics: the queued repair is
  // re-verified locally and claimed.
  const autoRun = wf.claimNext();
  assert.equal(autoRun.candidateId, auto.id);
  assert.equal(wf.getAutoRepair(auto.id).pendingFromRunId, null);
  assert.ok(
    wf
      .listEvents({ candidateId: auto.id, runId: autoRun.id })
      .some((event) => event.kind === 'auto_repair.claimed'),
  );

  // cancelAutoRepair cancels an unclaimed queue, keeps the reserved budget and
  // writes a readable audit reason; a repeat cancel is a safe no-op.
  finishWithPr(wf, autoRun, { headSha: 'head-2', number: 1 });
  requestChanges(wf, auto.id, 'head-2');
  assert.equal(
    wf
      .queueAutoRepair(auto.id, { expectedRunId: autoRun.id, expectedHeadSha: 'head-2' })
      .queued,
    true,
  );
  assert.throws(() => wf.cancelAutoRepair(auto.id, 'x'), /对象/);
  const cancelled = wf.cancelAutoRepair(auto.id, { reason: '外部核验发现 PR head 漂移' });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.used, 2, '取消保留已预留次数');
  assert.equal(wf.getCandidate(auto.id).state, 'awaiting_acceptance');
  const afterCancel = wf.getAutoRepair(auto.id);
  assert.equal(afterCancel.pendingFromRunId, null);
  assert.equal(afterCancel.used, 2);
  assert.match(afterCancel.reason, /上限/);
  const cancelledEvent = wf
    .listEvents({ candidateId: auto.id })
    .find((event) => event.kind === 'auto_repair.cancelled');
  assert.ok(cancelledEvent);
  assert.match(cancelledEvent.message, /PR head 漂移/);
  assert.equal(wf.cancelAutoRepair(auto.id, { reason: '重复' }).cancelled, false);
});
