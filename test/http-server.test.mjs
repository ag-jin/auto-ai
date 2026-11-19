import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createHttpServer } from '../src/http-server.mjs';

const MAX_BODY = 1024 * 1024;

function baseState() {
  return {
    settings: {
      repositories: [],
      rules: { repositories: [], labels: [], authors: [], keywords: [], states: ['open'] },
      concurrency: { global: 2, perRepo: 2 },
    },
    candidates: [],
    runs: [],
    events: [],
    templates: [],
    runtime: { watching: false, intervalSeconds: 60, lastPollAt: null, activeDrafts: [] },
    capabilities: { githubReady: false, piReady: false },
  };
}

class FakeRuntime {
  constructor() {
    this.calls = [];
    this.failures = new Map();
    this.started = 0;
    this.closed = 0;
    this.state = baseState();
    this.echo = {};
  }

  #record(name, args) {
    this.calls.push({ name, args });
    const failure = this.failures.get(name);
    if (failure) throw failure;
  }

  callsFor(name) {
    return this.calls.filter((call) => call.name === name);
  }

  async start() {
    this.started += 1;
  }

  async close() {
    this.closed += 1;
  }

  async getState() {
    this.#record('getState', []);
    return this.state;
  }

  async saveSettings(settings) {
    this.#record('saveSettings', [settings]);
    return settings;
  }

  async collect() {
    this.#record('collect', []);
    return { started: true };
  }

  async setWatch(input) {
    this.#record('setWatch', [input]);
    return { ...this.state.runtime, ...input };
  }

  async requestDraft(id) {
    this.#record('requestDraft', [id]);
    return { started: true };
  }

  async saveDraft(id, input) {
    this.#record('saveDraft', [id, input]);
    return { id, draft: { ...input, version: 2, requirementsRev: 'sha256:x' } };
  }

  async decide(id, input) {
    this.#record('decide', [id, input]);
    return { id, decision: input };
  }

  async retry(id) {
    this.#record('retry', [id]);
    return { id };
  }

  async cancelRun(id) {
    this.#record('cancelRun', [id]);
    return { runId: id, state: 'cancelled', stopped: true };
  }

  async recordAcceptance(id, input) {
    this.#record('recordAcceptance', [id, input]);
    return { id, reviews: { [input.role]: input } };
  }

  async merge(id, input) {
    this.#record('merge', [id, input]);
    return this.echo.merge || { merged: true, mergeSha: 'a'.repeat(40) };
  }
}

async function makePublicDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 't005b-public-'));
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>工作台</title><div>ok</div>\n');
  await writeFile(path.join(dir, 'app.js'), 'console.log("app");\n');
  await writeFile(path.join(dir, 'styles.css'), 'body { color: #111; }\n');
  await writeFile(path.join(dir, 'data.json'), '{"ok":true}\n');
  await mkdir(path.join(dir, 'nested'));
  await writeFile(path.join(dir, 'nested', 'page.html'), '<p>nested</p>\n');
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function startServer(t, { runtime = new FakeRuntime(), publicDir } = {}) {
  const dir = publicDir || (await makePublicDir(t));
  const handle = await createHttpServer({ runtime, publicDir: dir, port: 0 });
  t.after(async () => {
    await handle.close().catch(() => {});
  });
  return { runtime, ...handle };
}

function request(base, pathname, { method = 'GET', headers = {}, body } = {}) {
  const url = new URL(pathname, base);
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const requestHeaders = { ...headers };
    if (payload !== undefined && requestHeaders['content-length'] === undefined) {
      requestHeaders['content-length'] = String(payload.length);
    }
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: requestHeaders,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const text = buffer.toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json, buffer });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function jsonHeaders(token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers['x-auto-ai-token'] = token;
  return headers;
}

async function stateToken(server) {
  const response = await request(server.url, '/api/state');
  assert.equal(response.status, 200);
  assert.equal(typeof response.json.csrfToken, 'string');
  assert.ok(response.json.csrfToken.length >= 32);
  return response.json.csrfToken;
}

function assertNoLeak(response, markers) {
  for (const marker of markers) {
    assert.equal(response.text.includes(marker), false, `响应泄露了 ${marker}`);
  }
  assert.equal(response.text.includes('未执行操作'), false, '响应不应对 HTTP 层无法证明的副作用作断言');
}

test('createHttpServer 只允许 loopback 并管理 Runtime 生命周期', async (t) => {
  const runtime = new FakeRuntime();
  const publicDir = await makePublicDir(t);
  await assert.rejects(
    createHttpServer({ runtime, host: '0.0.0.0', port: 0, publicDir }),
    /loopback/,
  );
  assert.equal(runtime.started, 0);

  const handle = await createHttpServer({ runtime, host: '127.0.0.1', port: 0, publicDir });
  assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(runtime.started, 1);
  assert.equal(handle.server.listening, true);

  const response = await request(handle.url, '/api/state');
  assert.equal(response.status, 200);
  assert.equal(response.json.capabilities.githubReady, false);
  assert.equal(response.headers['access-control-allow-origin'], undefined);

  await handle.close();
  assert.equal(runtime.closed, 1);
  await assert.rejects(request(handle.url, '/api/state'), /ECONN(REFUSED|RESET)/);
  await handle.close();
  assert.equal(runtime.closed, 1);
});

test('静态资源只服务 publicDir 内真实文件，阻止穿越与符号链接越界', async (t) => {
  const publicDir = await makePublicDir(t);
  const outsideDir = await mkdtemp(path.join(tmpdir(), 't005b-outside-'));
  const outsideFile = path.join(outsideDir, 'secret.txt');
  await writeFile(outsideFile, 'TOP SECRET\n');
  await symlink(outsideFile, path.join(publicDir, 'leak.txt'));
  t.after(() => rm(outsideDir, { recursive: true, force: true }));

  const server = await startServer(t, { publicDir });

  const index = await request(server.url, '/');
  assert.equal(index.status, 200);
  assert.match(index.headers['content-type'], /^text\/html/);
  assert.equal(index.headers['cache-control'], 'no-store');
  assert.match(index.text, /工作台/);

  const script = await request(server.url, '/app.js');
  assert.equal(script.status, 200);
  assert.match(script.headers['content-type'], /^text\/javascript/);
  assert.equal(script.text.trim(), 'console.log("app");');

  const css = await request(server.url, '/styles.css');
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /^text\/css/);

  const data = await request(server.url, '/data.json');
  assert.equal(data.status, 200);
  assert.match(data.headers['content-type'], /^application\/json/);

  const nested = await request(server.url, '/nested/page.html');
  assert.equal(nested.status, 200);
  assert.match(nested.text, /nested/);

  const head = await request(server.url, '/index.html', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assert.ok(Number(head.headers['content-length']) > 0);

  const missing = await request(server.url, '/missing.html');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'not_found');

  const postStatic = await request(server.url, '/', { method: 'POST', body: '' });
  assert.equal(postStatic.status, 405);
  assert.match(postStatic.headers.allow, /GET/);

  for (const target of [
    '/%2e%2e/secret.txt',
    '/..%2fsecret.txt',
    '/nested/%2e%2e/%2e%2e/secret.txt',
  ]) {
    const response = await request(server.url, target);
    assert.ok([400, 404].includes(response.status), `${target} 返回 ${response.status}`);
    assert.equal(response.json.error.code !== undefined, true);
  }

  const leak = await request(server.url, '/leak.txt');
  assert.equal(leak.status, 404);

  const badEncoding = await request(server.url, '/%E0%A4%A');
  assert.equal(badEncoding.status, 400);
  assert.equal(badEncoding.json.error.code, 'invalid_path');
});

test('Host、Origin 与令牌校验，且不启用 CORS', async (t) => {
  const server = await startServer(t);
  const token = await stateToken(server);
  const port = new URL(server.url).port;
  const origin = `http://127.0.0.1:${port}`;

  const rebinding = await request(server.url, '/api/state', { headers: { host: 'evil.example' } });
  assert.equal(rebinding.status, 403);
  assert.equal(rebinding.json.error.code, 'invalid_host');

  const wrongPort = await request(server.url, '/api/state', {
    headers: { host: `127.0.0.1:${Number(port) + 1}` },
  });
  assert.equal(wrongPort.status, 403);

  const crossSite = await request(server.url, '/api/state', {
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.json.error.code, 'invalid_origin');
  assert.equal(crossSite.headers['access-control-allow-origin'], undefined);

  const sameOrigin = await request(server.url, '/api/state', { headers: { origin } });
  assert.equal(sameOrigin.status, 200);
  assert.equal(typeof sameOrigin.json.csrfToken, 'string');
  assert.equal(sameOrigin.headers['access-control-allow-origin'], undefined);

  const stateBody = { repositories: [], rules: {}, concurrency: { global: 2, perRepo: 2 } };
  const noToken = await request(server.url, '/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(stateBody),
  });
  assert.equal(noToken.status, 403);
  assert.equal(noToken.json.error.code, 'invalid_token');

  const wrongToken = await request(server.url, '/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-auto-ai-token': 'x'.repeat(token.length) },
    body: JSON.stringify(stateBody),
  });
  assert.equal(wrongToken.status, 403);

  const crossSiteWrite = await request(server.url, '/api/settings', {
    method: 'PUT',
    headers: { ...jsonHeaders(token), origin: 'https://evil.example' },
    body: JSON.stringify(stateBody),
  });
  assert.equal(crossSiteWrite.status, 403);
  assert.equal(crossSiteWrite.json.error.code, 'invalid_origin');
  assert.equal(server.runtime.callsFor('saveSettings').length, 0);

  const cliWrite = await request(server.url, '/api/settings', {
    method: 'PUT',
    headers: jsonHeaders(token),
    body: JSON.stringify(stateBody),
  });
  assert.equal(cliWrite.status, 200);
  assert.deepEqual(cliWrite.json.settings, stateBody);
  assert.equal(server.runtime.callsFor('saveSettings').length, 1);

  const browserWrite = await request(server.url, '/api/settings', {
    method: 'PUT',
    headers: { ...jsonHeaders(token), origin },
    body: JSON.stringify(stateBody),
  });
  assert.equal(browserWrite.status, 200);
});

test('写请求校验 JSON 类型、解析、1 MiB 上限，错误不杀 server', async (t) => {
  const server = await startServer(t);
  const token = await stateToken(server);
  const body = JSON.stringify({ repositories: [] });

  const missingType = await request(server.url, '/api/settings', {
    method: 'PUT',
    headers: { 'x-auto-ai-token': token },
    body,
  });
  assert.equal(missingType.status, 400);
  assert.equal(missingType.json.error.code, 'invalid_content_type');

  const wrongType = await request(server.url, '/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'text/plain', 'x-auto-ai-token': token },
    body,
  });
  assert.equal(wrongType.status, 400);

  const invalidJson = await request(server.url, '/api/settings', {
    method: 'PUT',
    headers: jsonHeaders(token),
    body: '{"repositories": [}',
  });
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.json.error.code, 'invalid_json');

  const arrayBody = await request(server.url, '/api/settings', {
    method: 'PUT',
    headers: jsonHeaders(token),
    body: '[]',
  });
  assert.equal(arrayBody.status, 400);
  assert.equal(arrayBody.json.error.code, 'invalid_body');

  const huge = await request(server.url, '/api/settings', {
    method: 'PUT',
    headers: jsonHeaders(token),
    body: Buffer.alloc(MAX_BODY + 1, 0x61),
  });
  assert.equal(huge.status, 413);
  assert.equal(huge.json.error.code, 'payload_too_large');

  const first = await request(server.url, '/api/settings', {
    method: 'PUT',
    headers: jsonHeaders(token),
    body: JSON.stringify({ repositories: [] }),
  });
  assert.equal(first.status, 200);

  const state = await request(server.url, '/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.json.csrfToken, token);
});

test('路由全表、方法、ID 编码与服务端固定角色', async (t) => {
  const server = await startServer(t);
  const token = await stateToken(server);
  const candidateId = 'owner/repo#7';
  const encoded = encodeURIComponent(candidateId);

  const settingsBody = {
    repositories: [{ repo: 'owner/repo', localPath: '', baseRef: 'HEAD' }],
    rules: { repositories: ['owner/repo'], labels: [], authors: [], keywords: [], states: ['open'] },
    concurrency: { global: 1, perRepo: 1 },
  };
  const settings = await request(server.url, '/api/settings', {
    method: 'PUT',
    headers: jsonHeaders(token),
    body: JSON.stringify(settingsBody),
  });
  assert.equal(settings.status, 200);
  assert.deepEqual(settings.json.settings, settingsBody);
  assert.deepEqual(server.runtime.callsFor('saveSettings')[0].args[0], settingsBody);

  const collect = await request(server.url, '/api/collect', {
    method: 'POST',
    headers: jsonHeaders(token),
    body: '{}',
  });
  assert.equal(collect.status, 200);
  assert.deepEqual(collect.json, { started: true });

  const watch = await request(server.url, '/api/runtime/watch', {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ enabled: true, intervalSeconds: 30 }),
  });
  assert.equal(watch.status, 200);
  assert.deepEqual(server.runtime.callsFor('setWatch')[0].args[0], {
    enabled: true,
    intervalSeconds: 30,
  });

  const watchInvalid = await request(server.url, '/api/runtime/watch', {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ enabled: 'yes', intervalSeconds: 30 }),
  });
  assert.equal(watchInvalid.status, 400);

  const requestDraft = await request(server.url, `/api/candidates/${encoded}/draft`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: '{}',
  });
  assert.equal(requestDraft.status, 200);
  assert.deepEqual(requestDraft.json, { started: true });
  assert.equal(server.runtime.callsFor('requestDraft')[0].args[0], candidateId);

  const missingRev = await request(server.url, `/api/candidates/${encoded}/draft`, {
    method: 'PUT',
    headers: jsonHeaders(token),
    body: JSON.stringify({ goal: 'g', acceptance: ['a'] }),
  });
  assert.equal(missingRev.status, 400);
  assert.match(missingRev.json.error.message, /rev/);

  const draftBody = {
    rev: null,
    actor: 'admin',
    templateId: 'development',
    goal: '目标',
    scope: '范围',
    acceptance: ['验收'],
    context: '上下文',
    pendingDecisions: [],
    writeScopes: ['*'],
    dependsOn: [],
    priority: 0,
  };
  const savedDraft = await request(server.url, `/api/candidates/${encoded}/draft`, {
    method: 'PUT',
    headers: jsonHeaders(token),
    body: JSON.stringify(draftBody),
  });
  assert.equal(savedDraft.status, 200);
  const [savedId, savedInput] = server.runtime.callsFor('saveDraft')[0].args;
  const { actor: _ignoredActor, ...expectedDraft } = draftBody;
  assert.equal(savedId, candidateId);
  assert.equal(savedInput.rev, null);
  assert.deepEqual(savedInput, { ...expectedDraft, rev: null });
  assert.equal(Object.prototype.hasOwnProperty.call(savedInput, 'actor'), false);
  assert.equal(savedDraft.json.draft.version, 2);

  const decision = await request(server.url, `/api/candidates/${encoded}/decision`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ action: 'develop', draftRev: 'abc', actor: 'admin' }),
  });
  assert.equal(decision.status, 200);
  const [decisionId, decisionInput] = server.runtime.callsFor('decide')[0].args;
  assert.equal(decisionId, candidateId);
  assert.equal(decisionInput.actor, 'user');
  assert.equal(decisionInput.action, 'develop');
  assert.equal(decisionInput.draftRev, 'abc');

  const deferNoDraft = await request(server.url, `/api/candidates/${encoded}/decision`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ action: 'defer' }),
  });
  assert.equal(deferNoDraft.status, 200);
  const [, deferInput] = server.runtime.callsFor('decide')[1].args;
  assert.equal(deferInput.actor, 'user');
  assert.equal(Object.prototype.hasOwnProperty.call(deferInput, 'draftRev'), false);

  const badAction = await request(server.url, `/api/candidates/${encoded}/decision`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ action: 'approve' }),
  });
  assert.equal(badAction.status, 400);

  const developWithoutRev = await request(server.url, `/api/candidates/${encoded}/decision`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ action: 'develop' }),
  });
  assert.equal(developWithoutRev.status, 400);
  assert.match(developWithoutRev.json.error.message, /draftRev/);

  const retry = await request(server.url, `/api/candidates/${encoded}/retry`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: '{}',
  });
  assert.equal(retry.status, 200);
  assert.equal(server.runtime.callsFor('retry')[0].args[0], candidateId);

  const runId = 'run/with space';
  const cancel = await request(server.url, `/api/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: '{}',
  });
  assert.equal(cancel.status, 200);
  assert.equal(server.runtime.callsFor('cancelRun')[0].args[0], runId);

  const acceptance = await request(server.url, `/api/candidates/${encoded}/acceptance`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({
      role: 'design',
      verdict: 'approved',
      headSha: 'b'.repeat(40),
      comment: '主会话核验通过，引用证据 T005B。',
    }),
  });
  assert.equal(acceptance.status, 200);
  const [acceptanceId, acceptanceInput] = server.runtime.callsFor('recordAcceptance')[0].args;
  assert.equal(acceptanceId, candidateId);
  assert.equal(acceptanceInput.role, 'design');
  assert.equal(acceptanceInput.verdict, 'approved');

  const badRole = await request(server.url, `/api/candidates/${encoded}/acceptance`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ role: 'admin', verdict: 'approved', headSha: 'b'.repeat(40), comment: 'x' }),
  });
  assert.equal(badRole.status, 400);

  const designNoComment = await request(server.url, `/api/candidates/${encoded}/acceptance`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ role: 'design', verdict: 'approved', headSha: 'b'.repeat(40), comment: '' }),
  });
  assert.equal(designNoComment.status, 400);

  const userNoComment = await request(server.url, `/api/candidates/${encoded}/acceptance`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ role: 'user', verdict: 'changes_requested', headSha: 'c'.repeat(40) }),
  });
  assert.equal(userNoComment.status, 200);

  const merge = await request(server.url, `/api/candidates/${encoded}/merge`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ expectedHeadSha: 'd'.repeat(40), confirmed: true, method: 'squash' }),
  });
  assert.equal(merge.status, 200);
  assert.deepEqual(merge.json, { merged: true, mergeSha: 'a'.repeat(40) });
  const [mergeId, mergeInput] = server.runtime.callsFor('merge')[0].args;
  assert.equal(mergeId, candidateId);
  assert.deepEqual(mergeInput, { expectedHeadSha: 'd'.repeat(40), confirmed: true, method: 'squash' });

  const mergeUnconfirmed = await request(server.url, `/api/candidates/${encoded}/merge`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ expectedHeadSha: 'd'.repeat(40), confirmed: false, method: 'merge' }),
  });
  assert.equal(mergeUnconfirmed.status, 400);

  const badMethod = await request(server.url, `/api/candidates/${encoded}/merge`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ expectedHeadSha: 'd'.repeat(40), confirmed: true, method: 'fast-forward' }),
  });
  assert.equal(badMethod.status, 400);
});

test('未知路由 404、方法 405，且 JSON 错误结构一致', async (t) => {
  const server = await startServer(t);
  const token = await stateToken(server);

  const unknown = await request(server.url, '/api/unknown');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, 'not_found');

  const statePost = await request(server.url, '/api/state', { method: 'POST', body: '{}' });
  assert.equal(statePost.status, 405);
  assert.equal(statePost.json.error.code, 'method_not_allowed');
  assert.match(statePost.headers.allow, /GET/);

  const collectGet = await request(server.url, '/api/collect');
  assert.equal(collectGet.status, 405);
  assert.match(collectGet.headers.allow, /POST/);

  const draftGet = await request(server.url, '/api/candidates/x/draft');
  assert.equal(draftGet.status, 405);
  assert.match(draftGet.headers.allow, /POST/);
  assert.match(draftGet.headers.allow, /PUT/);

  const missingSegment = await request(server.url, '/api/candidates/x');
  assert.equal(missingSegment.status, 404);

  const trailing = await request(server.url, '/api/state/');
  assert.equal(trailing.status, 404);

  const writeWithoutAuth = await request(server.url, '/api/collect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(writeWithoutAuth.status, 403);
  assert.equal(server.runtime.callsFor('collect').length, 0);

  const okAfterErrors = await request(server.url, '/api/state', {
    headers: { 'x-auto-ai-token': token },
  });
  assert.equal(okAfterErrors.status, 200);
});

test('Runtime 冲突与异常映射为脱敏 JSON，错误后 server 继续服务', async (t) => {
  const server = await startServer(t);
  const token = await stateToken(server);

  const conflict = Object.assign(new Error('rev 已变化，拒绝旧版本'), {
    statusCode: 409,
    code: 'revision_conflict',
    details: { currentRev: 'new-rev' },
  });
  server.runtime.failures.set('saveDraft', conflict);
  const conflicted = await request(server.url, '/api/candidates/x/draft', {
    method: 'PUT',
    headers: jsonHeaders(token),
    body: JSON.stringify({ rev: 'old-rev', goal: 'g' }),
  });
  assert.equal(conflicted.status, 409);
  assert.equal(conflicted.json.error.code, 'revision_conflict');
  assert.deepEqual(conflicted.json.error.details, { currentRev: 'new-rev' });
  server.runtime.failures.delete('saveDraft');

  const notFound = Object.assign(new Error('候选不存在'), { statusCode: 404 });
  server.runtime.failures.set('requestDraft', notFound);
  const missing = await request(server.url, '/api/candidates/missing/draft', {
    method: 'POST',
    headers: jsonHeaders(token),
    body: '{}',
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.message, '候选不存在');
  server.runtime.failures.delete('requestDraft');

  const raw = Object.assign(
    new Error(`boom ${token}\n    at secret stack\nprompt: hidden instructions`),
    { details: { currentRev: 'safe-rev', apiKey: 'fixture-private-key' } },
  );
  server.runtime.failures.set('getState', raw);
  const internal = await request(server.url, '/api/state');
  assert.equal(internal.status, 500);
  assert.equal(internal.json.error.code, 'internal_error');
  assert.equal(internal.json.error.message, '服务器内部错误，请查看事件或核验当前状态');
  for (const leak of [token, 'secret stack', 'prompt:', 'at secret', 'boom', 'fixture-private-key']) {
    assert.equal(internal.text.includes(leak), false, `响应泄露了 ${leak}`);
  }
  assert.equal(internal.text.includes('未执行操作'), false);
  assert.equal(internal.json.error.details, undefined);
  server.runtime.failures.delete('getState');

  const recovered = await request(server.url, '/api/state');
  assert.equal(recovered.status, 200);
  assert.equal(recovered.json.csrfToken, token);
});

test('4xx 400 过滤 details 与多行异常文本，保留安全业务提示与 currentRev', async (t) => {
  const server = await startServer(t);
  const token = await stateToken(server);

  // 安全的本地校验信息不应被过度脱敏。
  const missingRev = await request(server.url, '/api/candidates/x/draft', {
    method: 'PUT',
    headers: jsonHeaders(token),
    body: JSON.stringify({ goal: 'g' }),
  });
  assert.equal(missingRev.status, 400);
  assert.equal(missingRev.json.error.code, 'invalid_body');
  assert.equal(missingRev.json.error.message, '保存任务稿需要显式传入 rev（首次为 null）');

  const failure = Object.assign(new Error('validation failed\nprompt: private task instructions'), {
    statusCode: 400,
    code: `validation_${token}`,
    details: {
      currentRev: 'safe-rev',
      apiKey: 'fixture-private-key',
      csrfToken: token,
      stack: 'fixture internal stack',
      nested: { apiKey: 'fixture-private-key', csrfToken: token },
    },
  });
  server.runtime.failures.set('saveSettings', failure);
  const response = await request(server.url, '/api/settings', {
    method: 'PUT',
    headers: jsonHeaders(token),
    body: JSON.stringify({ repositories: [] }),
  });
  assert.equal(response.status, 400);
  assertNoLeak(response, [
    token,
    'fixture-private-key',
    'private task instructions',
    'fixture internal stack',
    'prompt:',
    'apiKey',
    'csrfToken',
  ]);
  assert.deepEqual(response.json.error.details, { currentRev: 'safe-rev' });
  assert.match(response.json.error.code, /^[a-z][a-z0-9_]*$/);
  assert.equal(response.json.error.code.includes(token), false);
  server.runtime.failures.delete('saveSettings');

  const recovered = await request(server.url, '/api/state');
  assert.equal(recovered.status, 200);
  assert.equal(recovered.json.csrfToken, token);
});

test('错误 details 的允许字段同样拒绝嵌套对象、令牌与不安全内容', async (t) => {
  const server = await startServer(t);
  const token = await stateToken(server);
  const failure = Object.assign(new Error('版本冲突'), {
    statusCode: 409,
    code: 'revision_conflict',
    details: {
      currentRev: { value: token },
      allowed: [token],
      reasons: ['安全原因', token],
    },
  });
  server.runtime.failures.set('requestDraft', failure);
  const response = await request(server.url, '/api/candidates/x/draft', {
    method: 'POST',
    headers: jsonHeaders(token),
    body: '{}',
  });
  assert.equal(response.status, 409);
  assert.equal(response.json.error.code, 'revision_conflict');
  assert.equal(response.json.error.details, undefined);
  assertNoLeak(response, [token]);
  server.runtime.failures.delete('requestDraft');
});

test('409 冲突保留安全业务原因与 currentRev，便于前端恢复', async (t) => {
  const server = await startServer(t);
  const token = await stateToken(server);
  const currentRev = 'c'.repeat(64);
  const failure = Object.assign(new Error('任务稿已被更新，请基于新版本重新保存'), {
    statusCode: 409,
    code: 'revision_conflict',
    details: { currentRev, reasons: ['任务稿已被更新'] },
  });
  server.runtime.failures.set('saveDraft', failure);
  const response = await request(server.url, '/api/candidates/x/draft', {
    method: 'PUT',
    headers: jsonHeaders(token),
    body: JSON.stringify({ rev: 'old-rev', goal: 'g' }),
  });
  assert.equal(response.status, 409);
  assert.equal(response.json.error.code, 'revision_conflict');
  assert.equal(response.json.error.message, '任务稿已被更新，请基于新版本重新保存');
  assert.deepEqual(response.json.error.details, {
    currentRev,
    reasons: ['任务稿已被更新'],
  });
  server.runtime.failures.delete('saveDraft');
});

test('503 使用 unavailable 语义并保留安全的具体环境原因', async (t) => {
  const server = await startServer(t);
  const token = await stateToken(server);

  server.runtime.failures.set(
    'collect',
    Object.assign(new Error('GitHub 不可用：请先登录 gh'), { statusCode: 503 }),
  );
  const unavailable = await request(server.url, '/api/collect', {
    method: 'POST',
    headers: jsonHeaders(token),
    body: '{}',
  });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.json.error.code, 'unavailable');
  assert.match(unavailable.json.error.message, /GitHub 不可用/);
  assert.match(unavailable.json.error.message, /gh/);
  assert.equal(unavailable.json.error.details, undefined);
  assertNoLeak(unavailable, []);

  server.runtime.failures.set(
    'collect',
    Object.assign(new Error(`GitHub 不可用 ${token}\n    at secret stack`), { statusCode: 503 }),
  );
  const unsafe = await request(server.url, '/api/collect', {
    method: 'POST',
    headers: jsonHeaders(token),
    body: '{}',
  });
  assert.equal(unsafe.status, 503);
  assert.equal(unsafe.json.error.code, 'unavailable');
  assert.match(unsafe.json.error.message, /暂不可用/);
  assertNoLeak(unsafe, [token, 'secret stack', 'prompt:', 'at secret']);
  server.runtime.failures.delete('collect');

  const recovered = await request(server.url, '/api/state');
  assert.equal(recovered.status, 200);
  assert.equal(recovered.json.csrfToken, token);
});

test('merge pending 结果原样返回，由 UI 判定为待核验', async (t) => {
  const server = await startServer(t);
  const token = await stateToken(server);
  server.runtime.echo.merge = {
    merged: false,
    pending: true,
    note: 'GitHub 返回 pending，后台只读核对',
  };
  const encoded = encodeURIComponent('owner/repo#9');
  const response = await request(server.url, `/api/candidates/${encoded}/merge`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ expectedHeadSha: 'e'.repeat(40), confirmed: true, method: 'merge' }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.merged, false);
  assert.equal(response.json.pending, true);
  assert.equal(response.json.mergeSha, undefined);
  assert.match(response.json.note, /pending/);
});

test('静态页面可加载，UI 使用实际 HTTP 接口与真实状态字段', async (t) => {
  const server = await startServer(t, {
    publicDir: fileURLToPath(new URL('../public', import.meta.url)),
  });
  const page = await request(server.url, '/');
  assert.equal(page.status, 200);
  assert.match(page.text, /<script type="module" src="\/app\.js"><\/script>/);
  assert.match(page.text, /<link rel="stylesheet" href="\/styles\.css">/);

  const app = await request(server.url, '/app.js');
  assert.equal(app.status, 200);
  for (const marker of [
    '"/api/state"',
    '"/api/settings"',
    '"/api/collect"',
    '"/api/runtime/watch"',
    '`/api/candidates/',
    '`/api/runs/',
    'X-Auto-AI-Token',
    'awaiting_acceptance',
    'mergePending',
  ]) {
    assert.ok(app.text.includes(marker), `app.js 缺少实际接口或状态标记：${marker}`);
  }

  const state = await request(server.url, '/api/state');
  assert.equal(state.status, 200);
  for (const key of [
    'settings',
    'candidates',
    'runs',
    'events',
    'templates',
    'runtime',
    'capabilities',
    'csrfToken',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(state.json, key), `state 缺少字段 ${key}`);
  }
});
