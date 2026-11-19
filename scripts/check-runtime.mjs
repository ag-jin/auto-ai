// Independent acceptance: real local Git/worktrees, isolated GitHub fixture.
// --live-pi additionally uses the real configured deepseek-flash/high model.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, access, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Runtime } from '../src/runtime.mjs';
import { WorkspaceAdapter } from '../src/workspace-adapter.mjs';
import { PiAdapter } from '../src/pi-adapter.mjs';

const appRepoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const livePi = process.argv.includes('--live-pi');
const exec = promisify(execFile);
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const git = async (cwd, args) => (await exec('git', ['-C', cwd, ...args], { env: gitEnv })).stdout.trim();
const repo = 'fixture-owner/fixture-repo';
const candidateId = `${repo}#701`;
const issue = { repo, number: 701, title: '新增 NOTE.md', body: '仅新增 NOTE.md，UTF-8 文本严格为 smoke-ok。writeScopes 仅 NOTE.md。测试验证读回内容。', state: 'open', author: 'fixture', labels: ['test'], updatedAt: '2026-11-17T00:00:00Z', url: `https://github.com/${repo}/issues/701`, isPullRequest: false };
const root = await mkdtemp(path.join(tmpdir(), 'auto-ai-runtime-check-'));
const source = path.join(root, 'source');
const remote = path.join(root, 'remotes', 'fixture-owner', 'fixture-repo.git');
const dataDir = path.join(root, 'data');
const evidenceDir = path.join(appRepoDir, '.auto-ai', 'validation', livePi ? 'runtime-live' : 'runtime-fixture');
await mkdir(evidenceDir, { recursive: true });
const checks = [];
let runtime;
let mergeCalls = 0;
let createPrCalls = 0;
let spawnCalls = 0;
let pr = null;
let mergedReadback = false;
const mark = (name) => { checks.push({ name, status: 'passed' }); console.log(`PASS ${name}`); };

const github = {
  async checkReady() { return { ready: true, reason: 'isolated GitHub fixture' }; },
  async collectIssues(target) { assert.equal(target, repo); return [structuredClone(issue)]; },
  async readIssue(target) { assert.equal(target.repo, repo); return structuredClone(issue); },
  async createPullRequest(input) {
    assert.equal(input.repo, repo);
    createPrCalls++;
    const headSha = (await git(source, ['ls-remote', '--heads', 'origin', `refs/heads/${input.branch}`])).split(/\s+/)[0];
    assert.match(headSha, /^[0-9a-f]{40}$/);
    pr = { repo, number: 702, url: `https://github.com/${repo}/pull/702`, headSha };
    return { ...pr };
  },
  async readPullRequest() {
    assert.ok(pr, 'fixture PR must exist before read');
    return { ...pr, state: mergedReadback ? 'merged' : 'open', mergeSha: mergedReadback ? 'a'.repeat(40) : null, mergeable: 'MERGEABLE', checks: [] };
  },
  async mergePullRequest(input) {
    assert.equal(input.confirmed, true);
    assert.equal(input.expectedHeadSha, pr.headSha);
    mergeCalls++;
    return { merged: false, pending: true, note: 'fixture delays readback' };
  },
};

const fakeRuns = new Map();
const pi = livePi ? new PiAdapter({ runRoot: path.join(dataDir, 'pi-evidence') }) : {
  async start(input) {
    const result = input.role === 'draft' ? {
      templateId: 'development', goal: '新增 NOTE.md，内容严格为 smoke-ok', scope: '仅 NOTE.md',
      acceptance: ['读取 NOTE.md，内容严格等于 smoke-ok'], context: '隔离端到端验收 fixture',
      pendingDecisions: [], writeScopes: ['NOTE.md'], dependsOn: [], priority: 0,
    } : { summary: '新增 NOTE.md 并实际读回验证', artifacts: ['NOTE.md'], evidence: [], blockers: [] };
    if (input.role === 'worker') {
      await writeFile(path.join(input.cwd, 'NOTE.md'), 'smoke-ok');
      const command = ['--input-type=module', '-e', "import fs from 'node:fs'; if(fs.readFileSync('NOTE.md','utf8')!=='smoke-ok')process.exit(1)"];
      await exec(process.execPath, command, { cwd: input.cwd });
      result.evidence.push({ command: 'node check NOTE.md exact content', status: 'passed', detail: 'real node process exited 0' });
    }
    const dir = path.join(dataDir, 'fake-pi', input.id);
    await mkdir(dir, { recursive: true });
    const status = { id: input.id, state: 'completed', dir, sessionId: `fixture-${input.id}`, monitorPid: null, output: JSON.stringify(result), error: null, exitCode: 0, progress: [] };
    fakeRuns.set(input.id, status);
    return { ...status };
  },
  async status(id) { assert.ok(fakeRuns.has(id), `unknown Pi fixture ${id}`); return { ...fakeRuns.get(id) }; },
  async list() { return [...fakeRuns.values()]; },
  async cancel(id) { return { ...fakeRuns.get(id), state: 'cancelled' }; },
};
const originalStart = pi.start.bind(pi);
pi.start = async (input) => { spawnCalls++; return originalStart(input); };
const workspace = new WorkspaceAdapter({ rootDir: path.join(dataDir, 'workspace'),
  run: (command, args, options = {}) => exec(command, args, { ...options, env: gitEnv }),
});
const open = async () => {
  runtime = new Runtime({ dataDir, appRepoDir, github, workspace, pi, tickMs: 200 });
  await runtime.start();
};
const waitFor = async (predicate, label, timeoutMs = livePi ? 600000 : 30000) => {
  const deadline = Date.now() + timeoutMs;
  let state;
  let lastReport = 0;
  while (Date.now() < deadline) {
    await runtime.tick();
    state = await runtime.getState();
    if (predicate(state)) return state;
    const blocked = state.candidates.find(c => c.id === candidateId && c.state === 'blocked');
    if (blocked) throw new Error(`${label}: ${JSON.stringify(blocked)}; runs=${JSON.stringify(state.runs)}`);
    if (Date.now() - lastReport > 30000) { console.log(`WAIT ${label}: ${state.candidates.map(c => c.state).join(',')}`); lastReport = Date.now(); }
    await delay(500);
  }
  throw new Error(`timeout ${label}: ${JSON.stringify(state)}`);
};

try {
  await mkdir(source, { recursive: true });
  await mkdir(path.dirname(remote), { recursive: true });
  await git(root, ['init', '--bare', remote]);
  await git(source, ['init', '-b', 'main']);
  await git(source, ['config', 'user.email', 'fixture@example.invalid']);
  await git(source, ['config', 'user.name', 'Auto AI Runtime Fixture']);
  await writeFile(path.join(source, 'README.md'), 'isolated acceptance fixture\n');
  await git(source, ['add', 'README.md']);
  await git(source, ['commit', '-m', 'fixture baseline']);
  await git(source, ['remote', 'add', 'origin', remote]);
  await git(source, ['push', '-u', 'origin', 'main']);
  await open();
  await runtime.saveSettings({ repositories: [{ repo, localPath: source, baseRef: 'HEAD' }], rules: { repositories: [repo], labels: [], authors: [], keywords: [], states: ['open'] }, concurrency: { global: 2, perRepo: 2 } });
  await runtime.collect();
  const drafted = await waitFor(s => s.candidates.some(c => c.id === candidateId && c.draft), 'read-only draft');
  let candidate = drafted.candidates.find(c => c.id === candidateId);
  assert.equal(drafted.runs.length, 0);
  assert.notEqual(candidate.decision?.action, 'develop');
  mark('collection and draft never authorize development');
  assert.deepEqual(candidate.draft.pendingDecisions, []);
  // Synthetic confirmation belongs solely to this isolated test fixture.
  await runtime.decide(candidateId, { action: 'develop', draftRev: candidate.draft.rev });
  const delivered = await waitFor(s => s.candidates.some(c => c.id === candidateId && c.state === 'awaiting_acceptance'), 'worker delivery');
  candidate = delivered.candidates.find(c => c.id === candidateId);
  const run = delivered.runs.find(r => r.candidateId === candidateId);
  assert.equal(run.requirementsRev, candidate.draft.requirementsRev);
  assert.match(run.templateRef, /^[0-9a-f]{40}:templates\/development\//);
  const note = (await exec('git', ['-C', remote, 'show', `${pr.headSha}:NOTE.md`], { env: gitEnv })).stdout;
  assert.equal(note, 'smoke-ok');
  assert.equal(await git(remote, ['diff', '--name-only', 'main', pr.headSha]), 'NOTE.md');
  assert.equal(createPrCalls, 1);
  assert.equal(mergeCalls, 0);
  mark('approved draft creates real isolated Git delivery and one fixture PR');
  await waitFor(asyncState => asyncState.runs.some(r => r.id === run.id), 'delivery saved');
  await assert.rejects(access(run.worktreePath));
  mark('delivered clean pushed worktree is reclaimed');
  await assert.rejects(runtime.merge(candidateId, { expectedHeadSha: pr.headSha, confirmed: true, method: 'squash' }));
  assert.equal(mergeCalls, 0);
  for (const role of ['user', 'design']) await runtime.recordAcceptance(candidateId, { role, verdict: 'approved', headSha: pr.headSha, comment: 'isolated fixture assertion: actual NOTE content and delivery checked' });
  assert.equal(mergeCalls, 0);
  mark('review alone does not merge; missing approval blocks merge');
  const result = await runtime.merge(candidateId, { expectedHeadSha: pr.headSha, confirmed: true, method: 'squash' });
  assert.equal(result.merged, false);
  assert.equal(result.pending, true);
  assert.equal(mergeCalls, 1);
  const beforeRestart = spawnCalls;
  await runtime.close();
  await open();
  const pendingAgain = await runtime.merge(candidateId, { expectedHeadSha: pr.headSha, confirmed: true, method: 'squash' });
  assert.equal(pendingAgain.pending, true);
  assert.equal(mergeCalls, 1);
  assert.equal(spawnCalls, beforeRestart);
  mark('restart preserves pending merge and never resends mutation');
  mergedReadback = true;
  const final = await waitFor(s => s.candidates.some(c => c.id === candidateId && c.state === 'completed'), 'fixture merged readback');
  assert.equal(mergeCalls, 1);
  assert.equal(spawnCalls, beforeRestart);
  assert.equal(await git(source, ['show', 'HEAD:README.md']), 'isolated acceptance fixture');
  mark('only explicit fixture MERGED readback completes the task');
  await writeFile(path.join(evidenceDir, 'state.json'), JSON.stringify(final, null, 2));
} catch (error) {
  checks.push({ name: 'runtime acceptance', status: 'failed', message: error.message });
  console.error(error);
  process.exitCode = 1;
} finally {
  if (runtime) await runtime.close().catch(error => console.error(error));
  const summary = { checkedAt: new Date().toISOString(), livePi, github: 'fixture only; no real PR mutation', git: 'real temporary local repositories', root, spawnCalls, createPrCalls, mergeCalls, checks };
  if (checks.length && checks.every(check => check.status === 'passed')) {
    if (livePi) await cp(path.join(dataDir, 'pi-evidence'), path.join(evidenceDir, 'pi-evidence'), { recursive: true });
    await rm(root, { recursive: true, force: true });
    summary.temporaryRootRemoved = true;
  }
  await writeFile(path.join(evidenceDir, 'result.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
}
