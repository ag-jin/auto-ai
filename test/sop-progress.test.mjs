import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { Runtime } from '../src/runtime.mjs';
import { Workflow } from '../src/workflow.mjs';
const MODE = process.argv[2] ?? 'both';
if (!['backend', 'frontend', 'both'].includes(MODE)) { console.error('用法：node test/sop-progress.test.mjs [backend|frontend]'); process.exit(2); }
const APP_REPO = path.resolve(new URL('..', import.meta.url).pathname);
const REPO = 'ag-jin/auto-ai';
const SECRETS = ['SECRET_TASK_CONTEXT', 'SECRET_PROMPT', 'SECRET_WORKTREE', 'SECRET_CREDENTIAL', 'SECRET_RESULT'];
const REWORK = Object.freeze({ step: 'develop-a', stage: 'check', reason: '断言失败后返工' });
const CHECK = Object.freeze({ lane: 'develop-a', command: 'node scripts/check-a.mjs', status: 'failed', detail: '退出码 1：断言失败' });
const EXPECTED_LANES = [
  { id: 'develop-a', path: 'src/a.mjs', status: 'validated', attempt: 3, piStatus: 'completed', feedback: { stage: 'check', reason: '第二次检查仍需修正' } },
  { id: 'develop-b', path: 'src/b.mjs', status: 'running', attempt: 1, piStatus: 'running', feedback: null },
];
async function tempDir(t, prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const issue = (number) => ({
  repo: REPO, number, title: `任务 ${number}`, body: `正文 ${number}`, state: 'open',
  author: 'alice', labels: ['feature'], updatedAt: '2026-01-01T00:00:00Z',
  url: `https://github.com/${REPO}/issues/${number}`, isPullRequest: false,
});

/** Seeds two real workflow Runs without starting Runtime or Pi. */
async function seedRuns(dataDir) {
  const workflow = new Workflow({ dbPath: path.join(dataDir, 'workflow.db') });
  workflow.saveSettings({ repositories: [{ repo: REPO, localPath: '/tmp/unused-source', baseRef: 'main' }], rules: { repositories: [REPO], states: ['open'] }, concurrency: { global: 4, perRepo: 4 } });
  workflow.collect([issue(1), issue(2)]);
  for (const number of [1, 2]) {
    const id = `${REPO.toLowerCase()}#${number}`;
    const candidate = workflow.saveDraft(id, {
      templateId: 'development', goal: `目标 ${number}`, scope: 'src/', acceptance: ['验收通过'],
      context: '上下文', writeScopes: [number === 1 ? 'src/' : 'docs/'], dependsOn: [], priority: 0,
    });
    workflow.decide(id, { action: 'develop', draftRev: candidate.draft.rev, actor: 'user' });
  }
  const sopRun = workflow.claimNext();
  const plainRun = workflow.claimNext();
  assert.ok(sopRun && plainRun, '测试夹具必须成功占用两个 Run');
  const snapshot = { runs: workflow.listRuns(), candidates: workflow.listCandidates() };
  workflow.close();
  return { sopRun, plainRun, snapshot };
}

const lane = (id, path, status, attempt, piStatus, feedback) => ({
  id, path, status, attempt, piStatus, feedback, goal: 'SECRET_TASK_CONTEXT', piId: 'SECRET_PROMPT',
  worktreePath: '/tmp/SECRET_WORKTREE', baseCommit: 'b'.repeat(40), hash: status === 'validated' ? 'c'.repeat(64) : null,
});

function sopControl(runId) {
  return {
    schemaVersion: 1, runId, credential: 'SECRET_CREDENTIAL',
    prepare: { status: 'prepared', template: { commit: 'a'.repeat(40), path: 'templates/development/1.2.0.md' }, worktreePath: '/tmp/SECRET_WORKTREE', promptPath: '/tmp/SECRET_PROMPT.md' },
    hold: { reason: 'SOP 现场未确认', at: '2026-11-19T00:00:00.000Z' },
    retryFeedback: { reason: 'SECRET_PROMPT' },
    sop: {
      status: 'review',
      plan: { handoff: 'development-result@1.0.0', review: 'review-result@1.0.0', max_reworks: 1 },
      task: {
        draftRev: 'rev-1', goal: 'SECRET_TASK_CONTEXT', acceptance: ['验收一', '验收二'],
        context: 'SECRET_TASK_CONTEXT', order: ['develop-a', 'develop-b'],
        checks: [{ lane: 'develop-a', args: ['scripts/check-a.mjs'] }],
      },
      lanes: {
        'develop-a': lane('develop-a', 'src/a.mjs', 'validated', 3, 'completed', { stage: 'check', reason: '第二次检查仍需修正' }),
        'develop-b': lane('develop-b', 'src/b.mjs', 'running', 1, 'running', null),
      },
      reworks: [REWORK],
      checksRun: [CHECK],
      review: { round: 2, piId: 'SECRET_PROMPT', piStatus: 'running' },
      reviewRound: 2, result: null, testedTree: 'tree-1', hold: { reason: 'SOP 现场未确认' },
    },
  };
}

async function writeControl(dataDir, runId, control) {
  const file = path.join(dataDir, 'runs', runId, 'control.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(control, null, 2)}\n`, 'utf8');
  return file;
}

const findSop = (state, runId) => state.runs.find((run) => run.id === runId)?.sop;
if (MODE !== 'frontend') {
  test('getState 只投影 run.sop 白名单，且不触碰 control/workflow/Pi', async (t) => {
    const dataDir = await tempDir(t, 'sop-progress-');
    const { sopRun, plainRun, snapshot } = await seedRuns(dataDir);
    const control = sopControl(sopRun.id);
    const controlFile = await writeControl(dataDir, sopRun.id, control);
    await writeControl(dataDir, plainRun.id, { schemaVersion: 1 });
    const controlBefore = await readFile(controlFile, 'utf8');

    let starts = 0;
    const runtime = new Runtime({ dataDir, appRepoDir: APP_REPO, tickMs: 10, workspace: {}, github: { checkReady: async () => ({ ready: true }) },
      pi: { start() { starts += 1; throw new Error('getState 不得调用 pi.start'); } } });
    let state = await runtime.getState();
    assert.equal(starts, 0, 'getState 不得启动 Pi');
    assert.deepEqual(findSop(state, sopRun.id), {
      status: 'review', lanes: EXPECTED_LANES, reworks: [REWORK], checks: [CHECK],
      review: { round: 2, status: 'running', acceptance: null }, holdReason: 'SOP 现场未确认',
    }, 'run.sop 必须是白名单投影，不能带出 task/context/prompt/worktree/credential');
    assert.equal(findSop(state, plainRun.id), null, '没有 SOP control 的旧 Run 必须是 null');
    const serialized = JSON.stringify(findSop(state, sopRun.id));
    for (const secret of SECRETS) assert.ok(!serialized.includes(secret), `run.sop 不得泄露 ${secret}`);
    assert.equal(await readFile(controlFile, 'utf8'), controlBefore, 'getState 不得改写 control');

    control.sop.status = 'lanes'; control.sop.review = null;
    await writeControl(dataDir, sopRun.id, control);
    state = await runtime.getState();
    assert.equal(findSop(state, sopRun.id).review, null, '未进入评审时 review 必须是 null');

    control.sop.status = 'passed';
    control.sop.review = { round: 2, piStatus: 'completed', acceptance: ['验收一证据', '验收二证据'] };
    control.sop.result = { summary: 'SECRET_RESULT', artifacts: [], evidence: [], blockers: [] };
    await writeControl(dataDir, sopRun.id, control);
    state = await runtime.getState();
    const approved = findSop(state, sopRun.id);
    assert.deepEqual(approved.review, { round: 2, status: 'approved', acceptance: ['验收一证据', '验收二证据'] });
    assert.equal(approved.status, 'passed');
    assert.ok(!JSON.stringify(approved).includes('SECRET_RESULT'), 'run.sop 不得泄露 sop.result 摘要');
    await runtime.close();

    const reopened = new Workflow({ dbPath: path.join(dataDir, 'workflow.db') });
    assert.deepEqual({ runs: reopened.listRuns(), candidates: reopened.listCandidates() }, snapshot, 'getState 不得改变 workflow 事实');
    reopened.close();
  });
}

// Frontend: renderSopProgress(run) in public/app.js
const textNode = (text) => ({ textContent: String(text) });

class FakeElement {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.dataset = {}; this.style = { setProperty() {} }; }
  append(...items) { for (const item of items.flat(Infinity)) if (item != null && item !== false) this.children.push(item); }
  appendChild(item) { this.append(item); return item; }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  setAttribute(name, value) {
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
  }
  addEventListener() {}
  set textContent(value) { this.children = [textNode(value)]; }
  get textContent() { return this.children.map((child) => child.textContent ?? '').join(''); }
  set innerHTML(value) { throw new Error('renderSopProgress 不得使用 innerHTML'); }
}

const textOf = (node) => node?.textContent ?? '';

function tagsOf(node, found = []) {
  if (node?.tagName) found.push(node.tagName);
  for (const child of node?.children ?? []) tagsOf(child, found);
  return found;
}

if (MODE !== 'backend') {
  test('renderSopProgress 以纯文本展示摘要、拒绝 HTML、sop 为空不渲染且不重复 PR', async () => {
    const document = { activeElement: null, visibilityState: 'visible', body: new FakeElement('body'), createElement: (tag) => new FakeElement(tag),
      createTextNode: textNode, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
    const context = vm.createContext({ document, window: { setInterval: () => 0, addEventListener() {}, confirm: () => true },
      Node: FakeElement, HTMLElement: FakeElement, fetch: () => new Promise(() => {}), console, URL, setTimeout, clearTimeout, requestAnimationFrame: () => 0 });
    const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
    vm.runInContext(source, context, { filename: 'public/app.js' });
    const renderSopProgress = context.renderSopProgress;
    assert.equal(typeof renderSopProgress, 'function', 'public/app.js 必须声明顶层 function renderSopProgress(run)');

    assert.equal(renderSopProgress({ sop: null }), null, 'sop 为 null 时不得渲染');
    assert.equal(renderSopProgress({}), null, '旧 Run 没有 sop 时不得渲染');

    const run = {
      sop: {
        status: 'review', lanes: EXPECTED_LANES, reworks: [REWORK], checks: [CHECK],
        review: { round: 2, status: 'running', acceptance: ['验收一证据', '验收二证据'] }, holdReason: null,
      },
      result: { summary: 'SECRET_RESULT', pr: { repo: REPO, number: 777777, url: 'https://example.invalid/PR-MARKER-777777', headSha: 'PR-HEAD-777777' } },
    };
    const text = textOf(renderSopProgress(run));
    const shown = [
      'develop-a', 'src/a.mjs', 'validated', '3', 'completed', '第二次检查仍需修正',
      'develop-b', 'src/b.mjs', 'running', '1', '断言失败后返工',
      'node scripts/check-a.mjs', 'failed', '退出码 1：断言失败', '验收一证据', '验收二证据',
    ];
    for (const value of shown) assert.ok(text.includes(value), `SOP 进展应显示 ${value}`);
    assert.ok(!text.includes('777777'), 'PR 必须复用原 renderResultCore，不在 SOP 进展中重复');
    assert.ok(!text.includes('SECRET_RESULT'), '结果摘要仍由 renderResultCore 负责');

    const hostile = '<img src=x onerror="alert(1)">';
    run.sop.lanes = [{ ...EXPECTED_LANES[0], path: hostile }, { ...EXPECTED_LANES[1], feedback: { stage: 'check', reason: hostile } }];
    run.sop.checks = [{ ...CHECK, detail: hostile }];
    const unsafeNode = renderSopProgress(run);
    assert.ok(textOf(unsafeNode).includes(hostile), '恶意标签必须按纯文本显示');
    assert.ok(!tagsOf(unsafeNode).includes('IMG'), '不得把摘要内容解析成 HTML');
  });
}
