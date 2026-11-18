import test from 'node:test';
import assert from 'node:assert/strict';
import { createUiHarness, statePayload } from './helpers/ui-harness.mjs';

const CANDIDATE_ID = 'owner/repo#123';
const DRAFT_REV = 'rev-current-001';
const HEAD_SHA = 'a'.repeat(40);

function autoRepair(overrides = {}) {
  return {
    candidateId: CANDIDATE_ID,
    enabled: false,
    authorized: true,
    limit: 2,
    used: 0,
    remaining: 2,
    reason: '自动返修未开启',
    draftRev: DRAFT_REV,
    requirementsRev: 'sha256:requirements-fixture',
    sourceRev: 'source-fixture-1',
    pendingFromRunId: null,
    pendingHeadSha: null,
    pendingAt: null,
    blockedReason: null,
    blockedAt: null,
    nextAttemptAt: null,
    ...overrides,
  };
}

function candidate(overrides = {}) {
  const base = {
    id: CANDIDATE_ID,
    issue: {
      repo: 'owner/repo',
      number: 123,
      title: '隔离 UI 自动返修测试',
      body: '仅用于自动返修界面行为测试，GitHub 与 Pi 均为显式替身。',
      state: 'open',
      author: 'fixture',
      labels: ['ready'],
      updatedAt: '2026-11-18T00:00:00Z',
      url: 'https://github.com/owner/repo/issues/123',
    },
    filter: { matched: true, reasons: ['label: ready'] },
    state: 'awaiting_acceptance',
    draft: {
      version: 2,
      rev: DRAFT_REV,
      requirementsRev: 'sha256:requirements-fixture',
      templateId: 'development',
      goal: '完成隔离自动返修 UI',
      scope: '仅 public/app.js',
      acceptance: ['自动返修区块渲染与动作行为符合合同'],
      context: '测试替身，无真实模型或网络。',
      pendingDecisions: [],
      writeScopes: ['public/app.js'],
      dependsOn: [],
      priority: 0,
    },
    decision: { action: 'develop', actor: 'user', draftRev: DRAFT_REV, at: '2026-11-18T00:01:00Z' },
    activeRunId: null,
    eligibility: { eligible: false, reasons: [] },
    reviews: {
      user: { verdict: 'changes_requested', headSha: HEAD_SHA, comment: '请修正边界。', at: '2026-11-18T00:03:00Z' },
      design: null,
    },
    latestResult: {
      summary: '隔离执行完成，等待验收。',
      artifacts: ['public/app.js'],
      evidence: [{ command: 'node --test test/ui-auto-repair.test.mjs', status: 'passed', detail: '显式替身数据。' }],
      pr: {
        repo: 'owner/repo',
        number: 42,
        url: 'https://github.com/owner/repo/pull/42',
        headSha: HEAD_SHA,
      },
    },
    mergePending: false,
    createdAt: '2026-11-18T00:00:30Z',
    updatedAt: '2026-11-18T00:05:00Z',
    ...overrides,
  };
  if (!Object.prototype.hasOwnProperty.call(overrides, 'autoRepair')) base.autoRepair = autoRepair();
  return base;
}

function stateFor(item, overrides = {}) {
  return statePayload([item], overrides);
}

function mutationCalls(harness) {
  return harness.fetchCalls.filter((call) => call.url.includes('/auto-repair'));
}

function acceptanceOrMergeCalls(harness) {
  return harness.fetchCalls.filter(
    (call) => call.url.includes('/acceptance') || call.url.includes('/merge'),
  );
}

test('默认关闭：消费服务端 DTO、展示计数与边界，并只在候选/验收详情显式开启', async () => {
  const harness = await createUiHarness();
  const item = candidate();
  harness.applyState(stateFor(item));

  const detail = harness.renderCandidateDetail(item);
  const section = harness.findData(detail, 'auto-repair');
  assert.ok(section, '候选详情应渲染自动返修区块');
  const text = harness.text(section);
  assert.match(text, /自动返修/);
  assert.match(text, /未开启/);
  assert.match(text, /已用\s*0\s*\/\s*上限\s*2/);
  assert.match(text, /剩余\s*2/);
  assert.match(text, /自动返修未开启/);
  assert.match(text, /默认[^。]*关闭/);
  assert.match(text, /最多[^。]*2\s*次/);
  assert.match(text, /不会自动批准/);
  assert.match(text, /不会自动合并|不自动合并/);
  assert.doesNotMatch(text, /完全自动|全自动|无需人工/);

  const enable = harness.findButton(section, '开启自动返修');
  assert.ok(enable, '默认关闭时应提供开启按钮');
  assert.equal(enable.disabled, false);
  assert.equal(harness.findButton(section, '关闭自动返修'), null, '默认关闭时不应显示关闭按钮');
  assert.equal(acceptanceOrMergeCalls(harness).length, 0, '仅渲染不应触发验收或合并请求');

  const acceptanceDetail = harness.renderAcceptanceDetail(item);
  const acceptanceSection = harness.findData(acceptanceDetail, 'auto-repair');
  assert.ok(acceptanceSection, '验收详情应复用自动返修区块');
  assert.match(harness.text(acceptanceSection), /自动返修/);
  assert.ok(harness.findButton(acceptanceSection, '开启自动返修'));
});

test('已开启：展示 used/limit/remaining、服务端原因与暂停原因；额度耗尽/阻塞时仍能关闭', async () => {
  const harness = await createUiHarness();
  const item = candidate({
    state: 'blocked',
    autoRepair: autoRepair({
      enabled: true,
      authorized: false,
      used: 2,
      remaining: 0,
      reason: '自动返修次数已达上限 2，需要人工处理',
      blockedReason: '上一次自动返修遇到未确认的 Worker 进程',
      blockedAt: '2026-11-18T00:10:00Z',
      nextAttemptAt: '2026-11-18T00:20:00Z',
    }),
  });
  harness.applyState(stateFor(item));

  for (const detail of [harness.renderCandidateDetail(item), harness.renderAcceptanceDetail(item)]) {
    const section = harness.findData(detail, 'auto-repair');
    assert.ok(section);
    const text = harness.text(section);
    assert.match(text, /已开启/);
    assert.match(text, /已用\s*2\s*\/\s*上限\s*2/);
    assert.match(text, /剩余\s*0/);
    assert.match(text, /自动返修次数已达上限 2，需要人工处理/);
    assert.match(text, /上一次自动返修遇到未确认的 Worker 进程/);

    const disable = harness.findButton(section, '关闭自动返修');
    assert.ok(disable, '已开启时应提供关闭按钮');
    assert.equal(disable.disabled, false, '授权失效、额度耗尽或任务阻塞时关闭仍必须可用');
    assert.equal(harness.findButton(section, '开启自动返修'), null);
  }
});

test('开启：唯一 PUT 携带当前保存 rev 与 CSRF，不含客户端预算/身份字段，成功后刷新 state', async () => {
  const harness = await createUiHarness();
  const item = candidate();
  harness.applyState(stateFor(item));

  const detail = harness.renderCandidateDetail(item);
  const enable = harness.findButton(detail, '开启自动返修');
  assert.ok(enable);
  const results = harness.click(enable);
  assert.ok(results.length >= 1, '点击应调用真实 onclick 处理器');
  await Promise.all(results);
  await harness.flush();

  const mutations = mutationCalls(harness);
  assert.equal(mutations.length, 1);
  const call = mutations[0];
  assert.equal(call.url, `/api/candidates/${encodeURIComponent(CANDIDATE_ID)}/auto-repair`);
  assert.equal(call.method, 'PUT');
  assert.deepEqual(call.body, { enabled: true, draftRev: DRAFT_REV });
  assert.equal(Object.prototype.hasOwnProperty.call(call.body, 'actor'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(call.body, 'limit'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(call.body, 'used'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(call.body, 'remaining'), false);
  assert.equal(call.headers['X-Auto-AI-Token'], 'csrf-test');
  assert.equal(call.headers['Content-Type'], 'application/json');
  assert.ok(
    harness.fetchCalls.some((entry) => entry.method === 'GET' && entry.url === '/api/state'),
    '成功响应后必须重新刷新 state',
  );
  assert.equal(acceptanceOrMergeCalls(harness).length, 0, '开启不得触发验收或合并');
});

test('关闭：授权失效、任务稿失效、额度耗尽或阻塞时仍可点击，仅发送 enabled=false', async () => {
  const harness = await createUiHarness();
  const item = candidate({
    state: 'blocked',
    draftStale: true,
    autoRepair: autoRepair({
      enabled: true,
      authorized: false,
      used: 2,
      remaining: 0,
      reason: '没有与当前任务稿一致的用户开发授权，自动返修不可用',
      blockedReason: '存在未知 Worker 现场',
    }),
  });
  harness.applyState(stateFor(item));

  const detail = harness.renderCandidateDetail(item);
  const disable = harness.findButton(detail, '关闭自动返修');
  assert.ok(disable);
  assert.equal(disable.disabled, false, '关闭不能被授权/任务稿/额度/阻塞状态禁用');
  const results = harness.click(disable);
  assert.ok(results.length >= 1);
  await Promise.all(results);
  await harness.flush();

  const mutations = mutationCalls(harness);
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].url, `/api/candidates/${encodeURIComponent(CANDIDATE_ID)}/auto-repair`);
  assert.equal(mutations[0].method, 'PUT');
  assert.deepEqual(mutations[0].body, { enabled: false });
  assert.deepEqual(Object.keys(mutations[0].body), ['enabled'], '关闭请求不得夹带 draftRev 或客户端预算字段');
  assert.equal(mutations[0].headers['X-Auto-AI-Token'], 'csrf-test');
  assert.ok(harness.fetchCalls.some((entry) => entry.method === 'GET' && entry.url === '/api/state'));
  assert.equal(acceptanceOrMergeCalls(harness).length, 0, '关闭不得触发验收或合并');
});

test('缺失 autoRepair DTO：显示不可用，不猜测开关状态也不提供动作', async () => {
  const harness = await createUiHarness();
  const item = candidate();
  delete item.autoRepair;
  harness.applyState(stateFor(item));

  for (const detail of [harness.renderCandidateDetail(item), harness.renderAcceptanceDetail(item)]) {
    const section = harness.findData(detail, 'auto-repair');
    assert.ok(section, '缺失 DTO 时仍应说明不可用，而不是凭空显示开关');
    const text = harness.text(section);
    assert.match(text, /自动返修/);
    assert.match(text, /不可用|未提供/);
    assert.equal(harness.findButton(section, '开启自动返修'), null);
    assert.equal(harness.findButton(section, '关闭自动返修'), null);
  }
  assert.equal(mutationCalls(harness).length, 0);
});

test('开启被阻断：有未保存任务稿修改时禁用按钮且点击不发送请求', async () => {
  const harness = await createUiHarness();
  const item = candidate({ state: 'awaiting_decision' });
  harness.applyState(stateFor(item));

  const entry = harness.currentDraftEntry(item);
  assert.ok(entry);
  entry.values.goal = '本地未保存的修改';
  harness.updateDraftEntry(CANDIDATE_ID);

  const detail = harness.renderCandidateDetail(item);
  const enable = harness.findButton(detail, '开启自动返修');
  assert.ok(enable);
  assert.equal(enable.disabled, true, '有未保存任务稿修改时不能开启');
  assert.match(enable.getAttribute('title') || '', /未保存/);

  await Promise.all(harness.click(enable));
  assert.equal(mutationCalls(harness).length, 0, '被阻断的开启不得发送变更请求');
});

test('开启被阻断：任务稿失效（draftStale）时禁用按钮且点击不发送请求', async () => {
  const harness = await createUiHarness();
  const item = candidate({ state: 'awaiting_decision', draftStale: true });
  harness.applyState(stateFor(item));

  const detail = harness.renderCandidateDetail(item);
  const enable = harness.findButton(detail, '开启自动返修');
  assert.ok(enable);
  assert.equal(enable.disabled, true, '任务稿失效时不能开启');
  assert.match(enable.getAttribute('title') || '', /变化|失效/);

  await Promise.all(harness.click(enable));
  assert.equal(mutationCalls(harness).length, 0);
});

for (const [status, code, message] of [
  [409, 'source_changed', 'Issue 内容已变化，原开发授权失效，不能开启自动返修'],
  [503, 'runtime_unavailable', '自动返修核验暂时不可用，请稍后重试'],
]) {
  test(`开启失败 HTTP ${status}：显示服务端错误，无乐观成功且不自动重试变更`, async () => {
    const item = candidate();
    const harness = await createUiHarness({
      state: stateFor(item),
      handler: (call, { baseState, jsonResponse }) => {
        if (call.method === 'PUT' && call.url.includes('/auto-repair')) {
          return jsonResponse(status, { error: { code, message } });
        }
        if (call.method === 'GET' && call.url === '/api/state') {
          return jsonResponse(200, baseState);
        }
        return undefined;
      },
    });
    harness.applyState(stateFor(item));

    const detail = harness.renderCandidateDetail(item);
    const enable = harness.findButton(detail, '开启自动返修');
    assert.ok(enable);
    await Promise.all(harness.click(enable));
    await harness.flush();

    const mutations = mutationCalls(harness);
    assert.equal(mutations.length, 1, '失败后不得自动重试变更请求');
    assert.equal(mutations[0].body.enabled, true);

    const mainText = harness.text(harness.document.querySelector('#main'));
    assert.match(mainText, new RegExp(String(status)));
    assert.match(mainText, new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(mainText, new RegExp(code));

    const bannerText = harness.text(harness.document.querySelector('#banner-region'));
    assert.doesNotMatch(bannerText, /已请求开启|自动返修已开启/);
    assert.equal(acceptanceOrMergeCalls(harness).length, 0);
  });
}

test('不从 develop 决定或 labels 推断 opt-in；enabled 只来自 autoRepair DTO', async () => {
  const harness = await createUiHarness();
  const item = candidate({
    decision: { action: 'develop', actor: 'user', draftRev: DRAFT_REV, at: '2026-11-18T00:01:00Z' },
    issue: {
      ...candidate().issue,
      labels: ['ready', 'auto-repair'],
    },
    autoRepair: autoRepair({ enabled: false, reason: '自动返修未开启' }),
  });
  harness.applyState(stateFor(item));

  const detail = harness.renderCandidateDetail(item);
  const section = harness.findData(detail, 'auto-repair');
  const text = harness.text(section);
  assert.match(text, /未开启/);
  assert.doesNotMatch(text, /已开启/);
  assert.ok(harness.findButton(section, '开启自动返修'));
  assert.equal(harness.findButton(section, '关闭自动返修'), null);
});
