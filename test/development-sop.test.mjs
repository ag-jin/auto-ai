import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import YAML from 'yaml';
import { Runtime } from '../src/runtime.mjs';
import { WorkspaceAdapter } from '../src/workspace-adapter.mjs';
const execFileAsync = promisify(execFile);
const APP_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'ag-jin/auto-ai';
const CANDIDATE = `${REPO}#1`;
const SOP = 'development-sop@1.0.0';
const HANDOFF = 'development-result@1.0.0';
const REVIEW = 'review-result@1.0.0';
const LANE_A = 'src/subtotal.mjs';
const LANE_B = 'src/fee.mjs';
const CHECK_A = `const mod = await import(new URL('../src/subtotal.mjs', import.meta.url).href);
if (mod.SUBTOTAL_MARKER !== 'reworked') {
  console.error('SOP_CHECK_A: SUBTOTAL_MARKER=' + mod.SUBTOTAL_MARKER);
  process.exitCode = 1;
}`;
const CHECK_B = `const mod = await import(new URL('../src/fee.mjs', import.meta.url).href);
if (!['draft', 'stable'].includes(mod.FEE_MARKER)) {
  console.error('SOP_CHECK_B: FEE_MARKER=' + mod.FEE_MARKER);
  process.exitCode = 1;
}`;

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_TERMINAL_PROMPT = '0';
async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}
async function tempDir(t, prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function initRepo(dir) {
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'auto-ai-test@example.invalid']);
  await git(dir, ['config', 'user.name', 'Auto AI SOP Test']);
}
async function commitAll(dir, message) {
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}
function issue(number = 1) {
  return {
    repo: REPO, number, title: `任务 ${number}`, body: `正文 ${number}`,
    state: 'open', author: 'alice', labels: ['feature'],
    updatedAt: '2026-01-01T00:00:00Z', isPullRequest: false,
    url: `https://github.com/${REPO}/issues/${number}`,
  };
}

class FakePi {
  constructor() {
    this.startCalls = [];
    this.cancelCalls = [];
    this.tasks = new Map();
  }
  async start({ id, cwd, prompt, role }) {
    this.startCalls.push({ id, cwd, prompt, role });
    if (this.tasks.has(id)) throw new Error(`任务 id 已存在: ${id}`);
    this.tasks.set(id, { id, cwd, prompt, role, state: 'running', output: null, error: null });
    return { id, state: 'running', monitorPid: 7000 + this.startCalls.length };
  }
  async status(id) {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`未找到任务: ${id}`);
    return { ...task };
  }
  async cancel(id) {
    this.cancelCalls.push(id);
    const task = this.tasks.get(id);
    if (!task) throw new Error(`未找到任务: ${id}`);
    task.state = 'cancelled';
    return { id, state: 'cancelled' };
  }

  complete(id, output) {
    const task = this.tasks.get(id);
    assert.ok(task, `fake Pi 任务 ${id} 不存在`);
    task.state = 'completed';
    task.output = typeof output === 'string' ? output : JSON.stringify(output);
  }
}

class FakeGitHub {
  constructor() {
    this.issues = new Map();
    this.createCalls = [];
    this.mergeCalls = [];
    this.prs = new Map();
  }
  setIssues(repo, list) { this.issues.set(repo, list); }
  async checkReady() { return { ready: true, reason: 'fake github ready' }; }
  async collectIssues(repo) { return this.issues.get(repo) ?? []; }
  async readIssue({ repo, number }) {
    const found = (this.issues.get(repo) ?? []).find((item) => item.number === number);
    if (!found) throw new Error(`fake Issue ${repo}#${number} 不存在`);
    return { ...found };
  }
  async createPullRequest({ repo, worktreePath, body }) {
    this.createCalls.push({ repo, body });
    const number = this.prs.size + 1;
    const pr = {
      repo, number, url: `https://example.invalid/${repo}/pull/${number}`,
      headSha: await git(worktreePath, ['rev-parse', 'HEAD']), state: 'open', mergeSha: null,
    };
    this.prs.set(number, pr);
    return { repo, number, url: pr.url, headSha: pr.headSha };
  }
  async readPullRequest({ number }) { return { ...this.prs.get(number) }; }
  async mergePullRequest(input) {
    this.mergeCalls.push(input);
    return { merged: false, pending: true };
  }
}
async function makeHarness(t) {
  const appRepo = await tempDir(t, 'sop-app-');
  await cp(path.join(APP_REPO, 'templates'), path.join(appRepo, 'templates'), {
    recursive: true,
  });
  await initRepo(appRepo);
  const appCommit = await commitAll(appRepo, 'sop templates');
  const root = await tempDir(t, 'sop-repo-');
  const remoteDir = path.join(root, 'ag-jin', 'auto-ai.git');
  const sourceDir = path.join(root, 'ag-jin', 'auto-ai');
  await mkdir(remoteDir, { recursive: true });
  await git(remoteDir, ['init', '--bare', '-b', 'main']);
  await initRepo(sourceDir);
  await writeFile(path.join(sourceDir, 'README.md'), '# sop\n');
  await mkdir(path.join(sourceDir, 'src'));
  await writeFile(path.join(sourceDir, 'src', 'README.md'), 'base\n');
  await mkdir(path.join(sourceDir, 'tools'));
  await writeFile(path.join(sourceDir, 'tools', 'check-a.mjs'), CHECK_A);
  await writeFile(path.join(sourceDir, 'tools', 'check-b.mjs'), CHECK_B);
  await commitAll(sourceDir, 'init');
  await git(sourceDir, ['remote', 'add', 'origin', remoteDir]);
  await git(sourceDir, ['push', '-u', 'origin', 'main']);
  const dataDir = await tempDir(t, 'sop-data-');
  const github = new FakeGitHub();
  const pi = new FakePi();
  const runtime = new Runtime({
    dataDir, appRepoDir: appRepo, github, pi,
    workspace: new WorkspaceAdapter({ rootDir: path.join(dataDir, 'workspace') }),
    tickMs: 10,
  });
  await runtime.saveSettings({
    repositories: [{ repo: REPO, localPath: sourceDir, baseRef: 'main' }],
    rules: { repositories: [REPO] },
    concurrency: { global: 2, perRepo: 2 },
  });
  await runtime.start();
  return { runtime, github, pi, remoteDir, appCommit };
}
const LANES = [
  { id: 'develop-a', path: LANE_A, goal: '实现 subtotal，按检查证据返工一次' },
  { id: 'develop-b', path: LANE_B, goal: '实现 fee，保持健康' },
];
const CHECKS = [
  { lane: 'develop-a', args: ['tools/check-a.mjs'] },
  { lane: 'develop-b', args: ['tools/check-b.mjs'] },
];
const CONTEXT = YAML.stringify({ sop: SOP, lanes: LANES, checks: CHECKS });
const ACCEPTANCE = ['返工后 src/subtotal.mjs 导出 reworked', 'src/fee.mjs 导出 stable'];
const REVIEW_ACCEPTANCE = [
  '验收项 1：最终 diff 中 src/subtotal.mjs 为 reworked，tools/check-a.mjs 退出码 0',
  '验收项 2：最终 diff 中 src/fee.mjs 为 stable，tools/check-b.mjs 退出码 0',
];
function sopDraft(overrides = {}) {
  return {
    templateId: 'development-sop', goal: '并行实现 subtotal 与 fee', scope: 'src/',
    acceptance: ACCEPTANCE,
    context: CONTEXT, pendingDecisions: [], writeScopes: [LANE_A, LANE_B],
    dependsOn: [], priority: 0, ...overrides,
  };
}
function handoff(step, artifact, draftRev, overrides = {}) {
  return YAML.stringify({ sop: SOP, template: HANDOFF, draft_rev: draftRev, step, artifact, ...overrides });
}
function review(draftRev, { omitAcceptance = false, ...overrides } = {}) {
  const value = { sop: SOP, template: REVIEW, draft_rev: draftRev, ...overrides };
  if (value.outcome === 'approved' && !omitAcceptance && !('acceptance' in value)) {
    value.acceptance = REVIEW_ACCEPTANCE;
  }
  return YAML.stringify(value);
}
function laneCalls(pi, runId, lane) { return pi.startCalls.filter((c) => c.id.startsWith(`${runId}-${lane}-`)); }
function reviewCalls(pi, draftTaskId) {
  return pi.startCalls.filter((call) => call.role === 'draft' && call.id !== draftTaskId);
}
async function ticks(runtime, times = 4) { for (let i = 0; i < times; i += 1) await runtime.tick(); }
async function writeLaneFile(call, file, contents) { await writeFile(path.join(call.cwd, file), contents, 'utf8'); }
async function prepareDraft(harness) {
  const { runtime, github, pi } = harness;
  github.setIssues(REPO, [issue(1)]);
  await runtime.collect();
  const draftCall = pi.startCalls.find((call) => call.role === 'draft');
  assert.ok(draftCall, '命中后应自动只读整理');
  pi.complete(draftCall.id, sopDraft());
  await runtime.tick();
  const candidate = (await runtime.getState()).candidates.find((item) => item.id === CANDIDATE);
  assert.ok(candidate?.draft, '整理结果应成为任务稿');
  return { draftCall, candidate };
}
async function startSop(harness, draft) {
  const { runtime, github, pi } = harness;
  const prepared = await prepareDraft(harness);
  const { draftCall } = prepared;
  const candidate = draft
    ? await runtime.saveDraft(CANDIDATE, { rev: prepared.candidate.draft.rev, ...draft })
    : prepared.candidate;
  // 验收 1：未授权不派——没有 lane、Run 或 PR。
  await ticks(runtime);
  assert.equal(pi.startCalls.filter((call) => call.role === 'worker').length, 0);
  assert.equal(github.createCalls.length, 0);
  assert.equal((await runtime.getState()).runs.length, 0);
  await runtime.decide(CANDIDATE, { action: 'develop', draftRev: candidate.draft.rev });
  await ticks(runtime);
  const state = await runtime.getState();
  const run = state.runs.find((item) => item.candidateId === CANDIDATE);
  assert.ok(run, '批准后应领取 Run');
  assert.equal(run.status, 'running', run.blockedReason ?? '');
  const workers = pi.startCalls.filter((call) => call.role === 'worker');
  assert.ok(workers.length >= 2, `lane 未启动：${workers.map((call) => call.id).join(',') || '无'}`);
  return { draftCall, draftRev: candidate.draft.rev, run };
}

// 验收 2：真实 Node 检查失败只退 A；B 不重跑；返工后独立验收通过，恰一个 PR。
test('development-sop 检查失败只退 A，返工后独立验收并只交一个 PR', async (t) => {
  const h = await makeHarness(t);
  const { runtime, github, pi, remoteDir, appCommit } = h;
  try {
    const { draftCall, draftRev, run } = await startSop(h);
    assert.equal(run.templateRef, `${appCommit}:templates/development-sop/1.0.0.md`);
    const [a1] = laneCalls(pi, run.id, 'develop-a');
    const [b1] = laneCalls(pi, run.id, 'develop-b');
    assert.equal(a1.id, `${run.id}-develop-a-1`);
    assert.equal(b1.id, `${run.id}-develop-b-1`);
    assert.notEqual(a1.cwd, b1.cwd);
    await writeLaneFile(a1, LANE_A, "export const SUBTOTAL_MARKER = 'initial';\n");
    await writeLaneFile(b1, LANE_B, "export const FEE_MARKER = 'stable';\n");
    pi.complete(a1.id, handoff('develop-a', LANE_A, draftRev));
    await ticks(runtime);
    assert.equal(existsSync(path.join(run.worktreePath, LANE_A)), false, '单 lane 完成不得写入父树');
    assert.equal(existsSync(path.join(run.worktreePath, LANE_B)), false, '单 lane 完成不得写入父树');
    pi.complete(b1.id, handoff('develop-b', LANE_B, draftRev));
    await ticks(runtime);
    const aCalls = laneCalls(pi, run.id, 'develop-a');
    assert.equal(aCalls.length, 2, '检查失败必须只给 A 一次定向返工');
    assert.equal(laneCalls(pi, run.id, 'develop-b').length, 1, 'B 不得重跑');
    assert.equal(reviewCalls(pi, draftCall.id).length, 0);
    assert.equal(github.createCalls.length, 0);
    assert.ok(aCalls[1].prompt.includes('SOP_CHECK_A'), aCalls[1].prompt);
    await writeLaneFile(aCalls[1], LANE_A, "export const SUBTOTAL_MARKER = 'reworked';\n");
    pi.complete(aCalls[1].id, handoff('develop-a', LANE_A, draftRev));
    await ticks(runtime);
    const reviews = reviewCalls(pi, draftCall.id);
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].role, 'draft');
    assert.ok(reviews[0].prompt.includes('返工后 src/subtotal.mjs 导出 reworked'));
    assert.ok(reviews[0].prompt.includes('reworked'));
    assert.equal(github.createCalls.length, 0);
    pi.complete(reviews[0].id, review(draftRev, {
      outcome: 'approved', reason: '两路产物符合批准稿，检查与证据一致',
    }));
    await ticks(runtime);
    const finished = (await runtime.getState()).runs[0];
    assert.equal(finished.status, 'awaiting_acceptance');
    assert.equal(github.createCalls.length, 1, '一个 SOP Run 只交一个 PR');
    assert.equal(github.mergeCalls.length, 0);
    assert.equal(finished.draftRev, draftRev);
    assert.equal(finished.templateRef, run.templateRef);
    const body = github.createCalls[0].body;
    assert.match(body, /## SOP/);
    assert.ok(body.includes(`- 计划：${appCommit}:templates/development-sop/1.0.0.yaml`), body);
    for (const item of ACCEPTANCE) assert.ok(body.includes(item), body);
    assert.ok(finished.result.evidence.some(
      (item) => item.command === 'development-sop acceptance 1' &&
        item.detail.includes(ACCEPTANCE[0]) && item.detail.includes(REVIEW_ACCEPTANCE[0]),
    ));
    const head = finished.result.pr.headSha;
    const paths = (await git(remoteDir, ['diff', '--name-only', `main...${head}`]))
      .split('\n').filter(Boolean).sort();
    assert.deepEqual(paths, [LANE_A, LANE_B].sort());
    assert.match(await git(remoteDir, ['show', `${head}:${LANE_A}`]), /reworked/);
    assert.match(await git(remoteDir, ['show', `${head}:${LANE_B}`]), /stable/);
    assert.equal(existsSync(a1.cwd), false, 'A lane worktree 应回收');
    assert.equal(existsSync(b1.cwd), false, 'B lane worktree 应回收');
  } finally {
    await runtime.close();
  }
});

// 验收 2b：运行中改写批准稿会清空 pin；不得启单 Worker/新 lane/PR，已启动两路须确认停止。
test('development-sop 运行中改稿清空 pin 后不启单 Worker', async (t) => {
  const h = await makeHarness(t);
  const { runtime, github, pi } = h;
  try {
    const { draftRev, run } = await startSop(h);
    const [a1] = laneCalls(pi, run.id, 'develop-a');
    const [b1] = laneCalls(pi, run.id, 'develop-b');
    const changed = await runtime.saveDraft(CANDIDATE, {
      rev: draftRev, ...sopDraft({ goal: '运行中改写批准稿' }),
    });
    assert.deepEqual([changed.decision, changed.pinnedTemplate], [null, null]);
    await ticks(runtime);
    assert.equal(pi.startCalls.filter((call) => call.id === run.id).length, 0, '不得启动单 Worker');
    assert.equal(laneCalls(pi, run.id, 'develop-a').length, 1, '不得启动新 A lane');
    assert.equal(laneCalls(pi, run.id, 'develop-b').length, 1, '不得启动新 B lane');
    assert.equal(github.createCalls.length, 0, '不得交 PR');
    assert.deepEqual(pi.cancelCalls.sort(), [a1.id, b1.id].sort(), '两路进程须确认停止');
  } finally {
    await runtime.close();
  }
});

// 验收 3：reviewer changes_requested 只退指定 lane，复审通过后一个 PR。
test('development-sop 评审定向退回指定 lane 并可复审通过', async (t) => {
  const h = await makeHarness(t);
  const { runtime, github, pi, remoteDir } = h;
  try {
    const { draftCall, draftRev, run } = await startSop(h);
    const [a1] = laneCalls(pi, run.id, 'develop-a');
    const [b1] = laneCalls(pi, run.id, 'develop-b');
    await writeLaneFile(a1, LANE_A, "export const SUBTOTAL_MARKER = 'reworked';\n");
    await writeLaneFile(b1, LANE_B, "export const FEE_MARKER = 'draft';\n");
    pi.complete(a1.id, handoff('develop-a', LANE_A, draftRev));
    pi.complete(b1.id, handoff('develop-b', LANE_B, draftRev));
    await ticks(runtime);
    const first = reviewCalls(pi, draftCall.id);
    assert.equal(first.length, 1);
    pi.complete(first[0].id, review(draftRev, {
      outcome: 'changes_requested', step: 'develop-b',
      reason: 'SOP_REVIEW_B: FEE_MARKER 必须稳定为 stable',
    }));
    await ticks(runtime);
    const bCalls = laneCalls(pi, run.id, 'develop-b');
    assert.equal(bCalls.length, 2, 'reviewer 指定的 lane 必须定向返工');
    assert.equal(laneCalls(pi, run.id, 'develop-a').length, 1, '未指定的 A 不得重跑');
    assert.equal(reviewCalls(pi, draftCall.id).length, 1);
    assert.equal(github.createCalls.length, 0);
    assert.ok(bCalls[1].prompt.includes('SOP_REVIEW_B'));
    await writeLaneFile(bCalls[1], LANE_B, "export const FEE_MARKER = 'stable';\n");
    pi.complete(bCalls[1].id, handoff('develop-b', LANE_B, draftRev));
    await ticks(runtime);
    const second = reviewCalls(pi, draftCall.id);
    assert.equal(second.length, 2, '返工后必须重新独立评审');
    assert.ok(second[1].prompt.includes('stable'));
    pi.complete(second[1].id, review(draftRev, {
      outcome: 'approved', reason: '指定 lane 已按要求修正',
    }));
    await ticks(runtime);
    const finished = (await runtime.getState()).runs[0];
    assert.equal(finished.status, 'awaiting_acceptance');
    assert.equal(github.createCalls.length, 1);
    assert.match(
      await git(remoteDir, ['show', `${finished.result.pr.headSha}:${LANE_B}`]),
      /stable/,
    );
  } finally {
    await runtime.close();
  }
});

// 验收 4：坏交接不能推进——不被接受、不交 PR；返工用尽后明确阻塞。
test('development-sop 坏交接不能推进', async (t) => {
  const h = await makeHarness(t);
  const { runtime, github, pi } = h;
  try {
    const { draftCall, draftRev, run } = await startSop(h);
    const [a1] = laneCalls(pi, run.id, 'develop-a');
    const [b1] = laneCalls(pi, run.id, 'develop-b');
    await writeLaneFile(a1, LANE_A, "export const SUBTOTAL_MARKER = 'reworked';\n");
    await writeLaneFile(b1, LANE_B, "export const FEE_MARKER = 'stable';\n");
    pi.complete(a1.id, handoff('develop-a', LANE_A, draftRev, {
      template: 'development-result@0.9.0',
    }));
    pi.complete(b1.id, handoff('develop-b', LANE_B, draftRev));
    await ticks(runtime);
    const aCalls = laneCalls(pi, run.id, 'develop-a');
    assert.equal(aCalls.length, 2, '坏交接只能触发一次显式返工');
    assert.ok(aCalls[1].prompt.includes('development-result@0.9.0'));
    assert.equal(laneCalls(pi, run.id, 'develop-b').length, 1);
    assert.equal(reviewCalls(pi, draftCall.id).length, 0);
    assert.equal(github.createCalls.length, 0);
    pi.complete(aCalls[1].id, handoff('develop-a', LANE_A, draftRev, {
      sop: 'development-sop@9.9.9',
    }));
    await ticks(runtime);
    const blocked = (await runtime.getState()).runs[0];
    assert.equal(blocked.status, 'blocked');
    assert.ok(blocked.blockedReason);
    assert.equal(github.createCalls.length, 0);
    assert.equal(reviewCalls(pi, draftCall.id).length, 0);
  } finally {
    await runtime.close();
  }
});

test('development-sop approved 缺少 acceptance 不交 PR', async (t) => {
  const h = await makeHarness(t);
  const { runtime, github, pi } = h;
  try {
    const { draftCall, draftRev, run } = await startSop(h);
    const [a1] = laneCalls(pi, run.id, 'develop-a');
    const [b1] = laneCalls(pi, run.id, 'develop-b');
    await writeLaneFile(a1, LANE_A, "export const SUBTOTAL_MARKER = 'reworked';\n");
    await writeLaneFile(b1, LANE_B, "export const FEE_MARKER = 'stable';\n");
    pi.complete(a1.id, handoff('develop-a', LANE_A, draftRev));
    pi.complete(b1.id, handoff('develop-b', LANE_B, draftRev));
    await ticks(runtime);
    const [reviewer] = reviewCalls(pi, draftCall.id);
    pi.complete(reviewer.id, review(draftRev, {
      outcome: 'approved', reason: '两项均满足', omitAcceptance: true,
    }));
    await ticks(runtime);
    const blocked = (await runtime.getState()).runs[0];
    assert.equal(blocked.status, 'blocked');
    assert.match(blocked.blockedReason, /acceptance/);
    assert.equal(reviewCalls(pi, draftCall.id).length, 1, '坏评审结果不得自动重试');
    assert.equal(github.createCalls.length, 0);
  } finally {
    await runtime.close();
  }
});

test('development-sop approved acceptance 条数不符不交 PR', async (t) => {
  const h = await makeHarness(t);
  const { runtime, github, pi } = h;
  try {
    const { draftCall, draftRev, run } = await startSop(h);
    const [a1] = laneCalls(pi, run.id, 'develop-a');
    const [b1] = laneCalls(pi, run.id, 'develop-b');
    await writeLaneFile(a1, LANE_A, "export const SUBTOTAL_MARKER = 'reworked';\n");
    await writeLaneFile(b1, LANE_B, "export const FEE_MARKER = 'stable';\n");
    pi.complete(a1.id, handoff('develop-a', LANE_A, draftRev));
    pi.complete(b1.id, handoff('develop-b', LANE_B, draftRev));
    await ticks(runtime);
    const [reviewer] = reviewCalls(pi, draftCall.id);
    pi.complete(reviewer.id, review(draftRev, {
      outcome: 'approved', reason: '两项均满足', acceptance: ['只覆盖第一项'],
    }));
    await ticks(runtime);
    const blocked = (await runtime.getState()).runs[0];
    assert.equal(blocked.status, 'blocked');
    assert.match(blocked.blockedReason, /acceptance/);
    assert.equal(github.createCalls.length, 0);
  } finally {
    await runtime.close();
  }
});

test('development-sop 不交付独立评审没看到的范围内变更', async (t) => {
  const h = await makeHarness(t);
  const { runtime, github, pi, remoteDir } = h;
  try {
    const { draftCall, draftRev, run } = await startSop(h, sopDraft({ writeScopes: ['src'] }));
    const [a1] = laneCalls(pi, run.id, 'develop-a');
    const [b1] = laneCalls(pi, run.id, 'develop-b');
    await writeLaneFile(a1, LANE_A, "export const SUBTOTAL_MARKER = 'reworked';\n");
    await writeLaneFile(b1, LANE_B, "export const FEE_MARKER = 'stable';\n");
    pi.complete(a1.id, handoff('develop-a', LANE_A, draftRev));
    pi.complete(b1.id, handoff('develop-b', LANE_B, draftRev));
    await ticks(runtime);
    const [reviewer] = reviewCalls(pi, draftCall.id);
    assert.ok(reviewer);
    await writeLaneFile(reviewer, 'src/not-reviewed.mjs', 'export const extra = true;\n');
    pi.complete(reviewer.id, review(draftRev, { outcome: 'approved', reason: '两条 lane 通过' }));
    await ticks(runtime);
    assert.equal(github.createCalls.length, 0);
    assert.equal(await git(remoteDir, ['for-each-ref', '--format=%(refname)', 'refs/heads/auto-ai/']), '');
  } finally {
    await runtime.close();
  }
});
