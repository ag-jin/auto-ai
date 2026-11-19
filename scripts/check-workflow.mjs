import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';

const root = process.cwd();
const modulePath = process.argv[2] || path.join(root, 'src/workflow.mjs');
const { Workflow } = await import(pathToFileURL(path.resolve(modulePath)));
const { normalizeRules, evaluateIssue } = await import(pathToFileURL(path.join(path.dirname(path.resolve(modulePath)), 'rules.mjs')));
const folder = await mkdtemp(path.join(os.tmpdir(), 'auto-ai-workflow-review-'));
const report = [];
let sequence = 0;
const baseSettings = (limits = {}) => ({
  repositories: [{ repo: 'org/one', localPath: folder, baseRef: 'HEAD' }, { repo: 'org/two', localPath: folder, baseRef: 'HEAD' }],
  rules: { repositories: ['org/one', 'org/two'], labels: [], authors: [], keywords: [], states: ['open'] },
  concurrency: { global: 2, perRepo: 2, ...limits },
});
const issue = (number, extra = {}) => ({ repo: 'org/one', number, title: `需求 ${number}`, body: '目标正文', state: 'open', author: 'alice', labels: ['feature'], updatedAt: '2026-11-17T00:00:00Z', url: `https://github.com/org/one/issues/${number}`, isPullRequest: false, ...extra });
const draft = (extra = {}) => ({ templateId: 'development', goal: '明确目标', scope: '只改约定文件', acceptance: ['实际验收通过'], context: '', pendingDecisions: [], writeScopes: ['*'], dependsOn: [], priority: 0, ...extra });
async function check(name, fn) {
  try { await fn(); report.push({ name, result: 'passed' }); console.log('PASS', name); }
  catch (error) { report.push({ name, result: 'failed', message: error.message }); console.log('FAIL', name, error.message); }
}
async function withWorkflow(fn, limits = {}) {
  const dbPath = path.join(folder, `case-${++sequence}`, 'state.sqlite');
  const workflow = new Workflow({ dbPath });
  try { await workflow.saveSettings(baseSettings(limits)); await fn(workflow, dbPath); }
  finally { await workflow.close(); }
}
async function seed(workflow, rows) { await workflow.collect(rows); }
async function approve(workflow, id, extra = {}) {
  const candidate = await workflow.saveDraft(id, draft(extra));
  return workflow.decide(id, { action: 'develop', draftRev: candidate.draft.rev, actor: 'user' });
}
async function bind(workflow, run) {
  await workflow.bindExecution(run.id, { templateRef: 'a'.repeat(40) + ':templates/development/1.1.0.md', branch: 'worker/review-' + sequence, worktreePath: path.join(folder, 'worktree-' + sequence), sessionId: 'fixture-' + run.id });
}
async function finish(workflow, run, head = 'b'.repeat(40)) {
  await bind(workflow, run);
  await workflow.finishRun(run.id, { summary: '隔离测试结果', artifacts: ['fixture.txt'], evidence: [{ method: 'fixture', result: 'passed' }], pr: { repo: run.repo, number: 10, url: `https://github.com/${run.repo}/pull/10`, headSha: head } });
}
try {
  await check('rules combine categories and ignore case', async () => {
    const rules = normalizeRules({ repositories: ['ORG/ONE'], labels: ['FEATURE'], authors: ['ALICE'], keywords: ['目标'], states: ['open'] });
    const hit = evaluateIssue(issue(1), rules); assert.equal(hit.matched, true); assert.ok(hit.reasons.length);
    for (const change of [{ repo: 'other/repo' }, { labels: ['bug'] }, { author: 'bob' }, { title: 'x', body: 'x' }, { state: 'closed' }, { isPullRequest: true }]) {
      const result = evaluateIssue(issue(1, change), rules); assert.equal(result.matched, false); assert.ok(result.reasons.length);
    }
    assert.equal(evaluateIssue(issue(1), normalizeRules({ repositories: [] })).matched, false);
  });
  await check('collection deduplicates but never authorizes development', () => withWorkflow(async (w) => {
    await seed(w, [issue(1), issue(1)]); assert.equal((await w.listCandidates()).length, 1); assert.equal(await w.claimNext(), null);
    const c = await w.saveDraft('org/one#1', draft()); assert.equal(c.state, 'awaiting_decision'); assert.equal(await w.claimNext(), null);
  }));
  await check('actor, stale revision and pending decisions cannot approve', () => withWorkflow(async (w) => {
    await seed(w, [issue(1)]); let c = await w.saveDraft('org/one#1', draft());
    await assert.rejects(async () => w.decide(c.id, { action: 'develop', draftRev: c.draft.rev, actor: 'worker' }));
    await assert.rejects(async () => w.decide(c.id, { action: 'develop', draftRev: 'stale', actor: 'user' }));
    c = await w.saveDraft(c.id, draft({ pendingDecisions: ['需要用户决定范围'] }));
    await assert.rejects(async () => w.decide(c.id, { action: 'develop', draftRev: c.draft.rev, actor: 'user' }));
    assert.equal(await w.claimNext(), null);
  }));
  await check('deferred and ignored drafts do not enter the execution queue', () => withWorkflow(async (w) => {
    await seed(w, [issue(1), issue(2)]);
    for (const [id, action] of [['org/one#1', 'defer'], ['org/one#2', 'ignore']]) {
      const c = await w.saveDraft(id, draft()); await w.decide(id, { action, draftRev: c.draft.rev, actor: 'user' });
    }
    assert.equal(await w.claimNext(), null);
  }));
  await check('identical drafts retain revision and approval', () => withWorkflow(async (w) => {
    await seed(w, [issue(1)]); const approved = await approve(w, 'org/one#1');
    const same = await w.saveDraft('org/one#1', draft()); assert.equal(same.draft.version, approved.draft.version); assert.equal(same.draft.rev, approved.draft.rev); assert.equal(same.decision.action, 'develop');
    assert.ok(await w.claimNext());
  }));
  await check('effective draft changes invalidate approval', () => withWorkflow(async (w) => {
    await seed(w, [issue(1)]); const first = await approve(w, 'org/one#1');
    const changed = await w.saveDraft('org/one#1', draft({ acceptance: ['新的验收要求'] }));
    assert.notEqual(changed.draft.rev, first.draft.rev); assert.equal(changed.decision, null); assert.equal(await w.claimNext(), null);
  }));
  await check('source metadata preserves approval, source content invalidates it', () => withWorkflow(async (w) => {
    await seed(w, [issue(1)]); const c = await approve(w, 'org/one#1');
    await seed(w, [issue(1, { updatedAt: '2026-11-17T01:00:00Z' })]); assert.equal((await w.getCandidate(c.id)).draft.rev, c.draft.rev);
    await seed(w, [issue(1, { body: '全新需求内容' })]); assert.equal(await w.claimNext(), null); assert.equal((await w.getCandidate(c.id)).decision, null);
  }));
  await check('same-repository independent scopes can execute in parallel', () => withWorkflow(async (w) => {
    await seed(w, [issue(1), issue(2)]); await approve(w, 'org/one#1', { writeScopes: ['src/one.mjs'] }); await approve(w, 'org/one#2', { writeScopes: ['src/two.mjs'] });
    const a = await w.claimNext(); const b = await w.claimNext(); assert.ok(a); assert.ok(b); assert.notEqual(a.id, b.id); assert.equal(a.repo, b.repo);
  }));
  await check('parent-child write scopes are queued', () => withWorkflow(async (w) => {
    await seed(w, [issue(1), issue(2)]); await approve(w, 'org/one#1', { writeScopes: ['src'], priority: 1 }); await approve(w, 'org/one#2', { writeScopes: ['src/two.mjs'] });
    assert.ok(await w.claimNext()); assert.equal(await w.claimNext(), null); assert.ok((await w.eligibility('org/one#2')).reasons.length);
  }));
  await check('global and repository limits are enforced', async () => {
    await withWorkflow(async (w) => {
      await seed(w, [issue(1), issue(2, { repo: 'org/two' })]); await approve(w, 'org/one#1'); await approve(w, 'org/two#2');
      assert.ok(await w.claimNext()); assert.equal(await w.claimNext(), null);
    }, { global: 1, perRepo: 2 });
    await withWorkflow(async (w) => {
      await seed(w, [issue(1), issue(2)]); await approve(w, 'org/one#1', { writeScopes: ['a'] }); await approve(w, 'org/one#2', { writeScopes: ['b'] });
      assert.ok(await w.claimNext()); assert.equal(await w.claimNext(), null);
    }, { global: 4, perRepo: 1 });
  });
  await check('priority and blocked dependencies do not starve eligible tasks', () => withWorkflow(async (w) => {
    await seed(w, [issue(1), issue(2), issue(3)]);
    await approve(w, 'org/one#1', { priority: 100, dependsOn: ['org/two#999'] });
    await approve(w, 'org/one#2', { priority: 1 }); await approve(w, 'org/one#3', { priority: 20 });
    const run = await w.claimNext(); assert.equal(run.candidateId, 'org/one#3');
  }));
  await check('cross-repository dependency waits until accepted completion', () => withWorkflow(async (w) => {
    await seed(w, [issue(1), issue(2, { repo: 'org/two' })]); await approve(w, 'org/one#1'); await approve(w, 'org/two#2', { dependsOn: ['org/one#1'] });
    const run = await w.claimNext(); assert.equal(run.candidateId, 'org/one#1'); assert.equal(await w.claimNext(), null);
    const head = 'b'.repeat(40); await finish(w, run, head);
    assert.equal(await w.claimNext(), null);
    for (const role of ['user', 'design']) await w.recordAcceptance(run.candidateId, { role, verdict: 'approved', headSha: head, comment: '隔离测试验收' });
    await w.recordMerged(run.candidateId, { headSha: head, mergeSha: 'c'.repeat(40) });
    assert.equal((await w.claimNext()).candidateId, 'org/two#2');
  }));
  await check('dependency cycles are rejected', () => withWorkflow(async (w) => {
    await seed(w, [issue(1), issue(2)]); await w.saveDraft('org/one#1', draft({ dependsOn: ['org/one#2'] }));
    await assert.rejects(async () => w.saveDraft('org/one#2', draft({ dependsOn: ['org/one#1'] })));
  }));
  await check('two connections cannot claim the same candidate twice', () => withWorkflow(async (w, dbPath) => {
    await seed(w, [issue(1)]); await approve(w, 'org/one#1'); const second = new Workflow({ dbPath });
    try { const first = await w.claimNext(); assert.ok(first); assert.equal(await second.claimNext(), null); assert.equal((await second.listRuns()).length, 1); }
    finally { await second.close(); }
  }));
  await check('four OS processes atomically claim one candidate once', () => withWorkflow(async (w, dbPath) => {
    await seed(w, [issue(1)]); await approve(w, 'org/one#1');
    const code = `import { Workflow } from ${JSON.stringify(pathToFileURL(path.resolve(modulePath)).href)}; const w=new Workflow({dbPath:${JSON.stringify(dbPath)}});try{const r=w.claimNext();console.log(JSON.stringify({id:r?.id??null}));}finally{w.close();}`;
    const outputs = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
      execFile(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10000 }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout)));
    })));
    assert.equal(outputs.filter((value) => value.id !== null).length, 1);
    assert.equal((await w.listRuns()).length, 1);
  }));
  await check('state and events survive close and reopen', async () => {
    const dbPath = path.join(folder, `persistence-${++sequence}.sqlite`); let w = new Workflow({ dbPath });
    await w.saveSettings(baseSettings()); await seed(w, [issue(1)]); const c = await approve(w, 'org/one#1'); const run = await w.claimNext(); await w.recordProgress(run.id, { phase: 'implementation', message: '真实进展证据入口' }); await w.blockRun(run.id, 'fixture stopped'); await w.close();
    w = new Workflow({ dbPath });
    try { assert.equal((await w.getCandidate(c.id)).draft.rev, c.draft.rev); assert.equal((await w.getRun(run.id)).status, 'blocked'); assert.ok((await w.listEvents()).some((e) => e.message.includes('fixture stopped'))); }
    finally { await w.close(); }
  });
  await check('stale results cannot complete changed requirements', () => withWorkflow(async (w) => {
    await seed(w, [issue(1)]); await approve(w, 'org/one#1'); const run = await w.claimNext(); await bind(w, run);
    await seed(w, [issue(1, { body: '需求已经改变' })]);
    await w.finishRun(run.id, { summary: '旧版结果', artifacts: [], evidence: [], pr: null });
    assert.notEqual((await w.getCandidate(run.candidateId)).state, 'completed'); assert.equal((await w.getCandidate(run.candidateId)).decision, null);
  }));
  await check('merge requires both role approvals for the current PR head', () => withWorkflow(async (w) => {
    await seed(w, [issue(1)]); await approve(w, 'org/one#1'); const run = await w.claimNext(); const head = 'b'.repeat(40); await finish(w, run, head);
    assert.equal((await w.getCandidate(run.candidateId)).state, 'awaiting_acceptance'); assert.equal((await w.canMerge(run.candidateId, { headSha: head })).allowed, false);
    await w.recordAcceptance(run.candidateId, { role: 'user', verdict: 'approved', headSha: head, comment: 'fixture' }); assert.equal((await w.canMerge(run.candidateId, { headSha: head })).allowed, false);
    await w.recordAcceptance(run.candidateId, { role: 'design', verdict: 'approved', headSha: head, comment: 'fixture' }); assert.equal((await w.canMerge(run.candidateId, { headSha: head })).allowed, true);
    assert.equal((await w.canMerge(run.candidateId, { headSha: 'd'.repeat(40) })).allowed, false);
  }));
} finally {
  await rm(folder, { recursive: true, force: true });
  const target = path.join(root, '.auto-ai/review-workflow.json'); await mkdir(path.dirname(target), { recursive: true });
  const summary = { total: report.length, passed: report.filter((r) => r.result === 'passed').length, failed: report.filter((r) => r.result === 'failed').length, results: report };
  await writeFile(target, JSON.stringify(summary, null, 2)); console.log(JSON.stringify({ total: summary.total, passed: summary.passed, failed: summary.failed }));
  if (summary.failed) process.exitCode = 1;
}
