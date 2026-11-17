import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PiAdapter,
  identityMatches,
  readJsonFile,
} from '../src/pi-adapter.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeoutMs = 6000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) {
      return last;
    }
    await sleep(intervalMs);
  }
  throw new Error('等待条件超时');
}

async function waitForState(adapter, id, states, timeoutMs = 8000) {
  const expected = new Set(Array.isArray(states) ? states : [states]);
  return waitFor(async () => {
    try {
      const status = await adapter.status(id);
      return expected.has(status.state) ? status : null;
    } catch {
      return null;
    }
  }, { timeoutMs });
}

function safeKill(pid, signal = 'SIGKILL') {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
    return;
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

function safeKillGroup(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid) {
    return;
  }
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

const FAKE_PI = String.raw`import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
};
const sessionDir = arg('--session-dir');
const taskDir = path.dirname(sessionDir);
const promptArg = argv[argv.length - 1];
const promptPath = promptArg && promptArg.startsWith('@') ? promptArg.slice(1) : null;
const prompt = promptPath ? readFileSync(promptPath, 'utf8') : '';
let config = {};
try {
  config = JSON.parse(prompt);
} catch {
  config = {};
}
const scenario = config.scenario || 'normal';
const observationPath = path.join(taskDir, 'fake-observation.json');
const observation = {
  argv,
  cwd: process.cwd(),
  sessionDir,
  sessionId: arg('--session-id'),
  prompt,
  descendantPid: null,
  descendantDetached: false,
  startedAt: new Date().toISOString(),
  scenario,
};
const save = () => writeFileSync(observationPath, JSON.stringify(observation));
save();

const line = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const sessionId = arg('--session-id');
const assistant = (text, stopReason, extra = {}) => ({
  type: 'message_end',
  message: {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'secret-thought' },
      { type: 'text', text },
    ],
    stopReason,
    timestamp: Date.now(),
    ...extra,
  },
});
const head = () => {
  line({ type: 'session', version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() });
  line({ type: 'agent_start' });
  line({ type: 'turn_start' });
  line({ type: 'message_start', message: { role: 'assistant', content: [] } });
  line({ type: 'message_update', usage: {}, assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'secret-thought-delta' } });
  line({ type: 'message_update', usage: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'secret-text-delta' } });
};
const tool = () => {
  line({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'ls' } });
  line({ type: 'tool_execution_update', toolCallId: 'call-1', toolName: 'bash', partialResult: { text: 'secret-tool-partial' } });
  line({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'bash', result: { text: 'ok' }, isError: false, durationMs: 3 });
  line({ type: 'turn_end', message: { role: 'assistant' }, toolResults: [] });
};
const finish = () => {
  line(assistant('中间输出不应成为最终结果', 'toolUse'));
  line(assistant('最终结果：完成', 'stop'));
  line({ type: 'agent_end', messages: [{ role: 'assistant' }], willRetry: false });
  line({ type: 'agent_settled', aborted: false });
};

if (scenario === 'slow') {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  head();
  tool();
  finish();
} else if (scenario === 'hang') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: ['ignore', 'inherit', 'ignore'],
  });
  observation.descendantPid = child.pid;
  observation.descendantDetached = false;
  save();
  line({ type: 'agent_start' });
  setInterval(() => {}, 1000);
} else if (scenario === 'ignore-term') {
  process.on('SIGTERM', () => {});
  const child = spawn(process.execPath, [
    '-e',
    'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)',
  ], {
    stdio: ['ignore', 'inherit', 'ignore'],
  });
  observation.descendantPid = child.pid;
  observation.descendantDetached = false;
  save();
  line({ type: 'agent_start' });
  setInterval(() => {}, 1000);
} else if (scenario === 'orphan-pipe') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.unref();
  observation.descendantPid = child.pid;
  observation.descendantDetached = true;
  save();
  head();
  tool();
  finish();
  process.exitCode = 0;
} else if (scenario === 'cancel-orphan-pipe') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.unref();
  observation.descendantPid = child.pid;
  observation.descendantDetached = true;
  save();
  line({ type: 'agent_start' });
  setInterval(() => {}, 1000);
} else if (scenario === 'long-error') {
  head();
  line(assistant('错误输出', 'error', { errorMessage: 'x'.repeat(20000) }));
  line({ type: 'agent_end', messages: [{ role: 'assistant' }], willRetry: false });
  line({ type: 'agent_settled', aborted: false });
} else if (scenario === 'error-stop') {
  head();
  line(assistant('错误输出', 'error', { errorMessage: '模拟错误' }));
  line({ type: 'agent_end', messages: [{ role: 'assistant' }], willRetry: false });
  line({ type: 'agent_settled', aborted: false });
} else if (scenario === 'crash') {
  line({ type: 'agent_start' });
  process.exit(3);
} else if (scenario === 'truncated') {
  head();
  tool();
  finish();
  process.stdout.write('{"type":"message_end"', () => process.exit(0));
} else if (scenario === 'missing-final') {
  line({ type: 'session', version: 3, id: sessionId });
  line({ type: 'agent_start' });
  line({ type: 'agent_end', messages: [], willRetry: false });
  line({ type: 'agent_settled', aborted: false });
} else if (scenario === 'missing-agent-end') {
  head();
  line(assistant('最终结果：完成', 'stop'));
} else if (scenario === 'log-cap') {
  head();
  for (let index = 0; index < 4000; index += 1) {
    line({
      type: 'tool_execution_end',
      toolCallId: 'call-' + index,
      toolName: 'x'.repeat(200),
      isError: false,
      durationMs: index,
    });
  }
  finish();
} else {
  head();
  tool();
  finish();
}
`;

async function makeHarness(t) {
  const root = await mkdtemp(path.join(tmpdir(), 't003a-pi-adapter-'));
  const runRoot = path.join(root, 'runs');
  const cwd = path.join(root, 'cwd');
  await mkdir(runRoot, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const fakePi = path.join(root, 'fake-pi.mjs');
  await writeFile(fakePi, FAKE_PI, 'utf8');

  const adapter = new PiAdapter({
    runRoot,
    command: process.execPath,
    prefixArgs: [fakePi],
    provider: 'test-provider',
    stopGraceMs: 300,
  });

  t.after(async () => {
    for (const id of (await readRunIds(runRoot))) {
      const dir = path.join(runRoot, id);
      const processInfo = readJsonFile(path.join(dir, 'process.json'));
      const observation = readJsonFile(path.join(dir, 'fake-observation.json'));
      if (processInfo?.pi && identityMatches(processInfo.pi)) {
        safeKillGroup(processInfo.pi.pgid);
      }
      if (processInfo?.monitor && identityMatches(processInfo.monitor)) {
        safeKill(processInfo.monitor.pid);
      }
      if (Number.isInteger(observation?.descendantPid)) {
        safeKill(observation.descendantPid);
      }
    }
    await rm(root, { recursive: true, force: true });
  });

  return { root, runRoot, cwd, fakePi, adapter };
}

async function readRunIds(runRoot) {
  try {
    const fs = await import('node:fs/promises');
    const entries = await fs.readdir(runRoot, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function readObservation(runRoot, id) {
  const file = path.join(runRoot, id, 'fake-observation.json');
  return waitFor(async () => {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {
      return null;
    }
  });
}

function promptFor(scenario) {
  return JSON.stringify({ scenario, note: 'T003A fake prompt' });
}

test('启动立即返回、固定模型参数、角色工具与会话隔离，同 id 拒绝', async (t) => {
  const { adapter, cwd, runRoot } = await makeHarness(t);

  const startedAt = Date.now();
  const first = await adapter.start({
    id: 'worker_1',
    cwd,
    prompt: promptFor('slow'),
    role: 'worker',
  });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 1200, `start 不应等待模型，实际 ${elapsed}ms`);
  assert.equal(first.state, 'running');
  assert.equal(first.id, 'worker_1');
  assert.equal(typeof first.monitorPid, 'number');
  assert.equal(typeof first.sessionId, 'string');
  assert.equal(first.dir, path.join(runRoot, 'worker_1'));

  const observation = await readObservation(runRoot, 'worker_1');
  assert.equal(observation.cwd, await realpath(cwd));
  assert.equal(observation.prompt, promptFor('slow'));
  assert.equal(observation.argv.at(-1), `@${path.join(first.dir, 'prompt.md')}`);

  const pairs = new Map();
  for (let index = 0; index < observation.argv.length; index += 1) {
    const token = observation.argv[index];
    if (token.startsWith('--') && observation.argv[index + 1] && !observation.argv[index + 1].startsWith('--')) {
      pairs.set(token, observation.argv[index + 1]);
    } else {
      pairs.set(token, true);
    }
  }
  assert.equal(pairs.get('--provider'), 'test-provider');
  assert.equal(pairs.get('--model'), 'deepseek-flash');
  assert.equal(pairs.get('--thinking'), 'high');
  assert.equal(pairs.get('--print'), true);
  assert.equal(pairs.get('--mode'), 'json');
  assert.equal(pairs.get('--no-extensions'), true);
  assert.equal(pairs.get('--no-mcp'), true);
  assert.equal(pairs.get('--no-skills'), true);
  assert.equal(pairs.get('--no-prompt-templates'), true);
  assert.equal(pairs.get('--tools'), 'read,bash,edit,write,grep,find,ls');
  assert.equal(pairs.has('--no-tools'), false);

  const draft = await adapter.start({
    id: 'draft_1',
    cwd,
    prompt: promptFor('normal'),
    role: 'draft',
  });
  const draftObservation = await readObservation(runRoot, 'draft_1');
  const draftPairs = draftObservation.argv;
  assert.ok(draftPairs.includes('--no-tools'));
  assert.equal(draftPairs.includes('--tools'), false);
  assert.notEqual(draft.sessionId, first.sessionId);
  assert.notEqual(draftObservation.sessionDir, observation.sessionDir);

  await assert.rejects(
    adapter.start({ id: 'worker_1', cwd, prompt: promptFor('normal') }),
    /已存在/,
  );

  const draftStatus = await waitForState(adapter, 'draft_1', 'completed');
  assert.equal(draftStatus.output, '最终结果：完成');
  await adapter.cancel('worker_1');
});

test('正常输出、工具进展与失败语义区分', async (t) => {
  const { adapter, cwd, runRoot } = await makeHarness(t);

  await adapter.start({ id: 'normal', cwd, prompt: promptFor('normal') });
  const normal = await waitForState(adapter, 'normal', 'completed');
  assert.equal(normal.output, '最终结果：完成');
  assert.ok(normal.progress.some((item) => item.phase === 'tool'));
  assert.ok(normal.progress.some((item) => item.phase === 'assistant'));
  assert.ok(!normal.progress.some((item) => item.message.includes('secret')));
  assert.equal(normal.exitCode, 0);
  assert.equal(normal.error, null);

  const events = await readFile(path.join(runRoot, 'normal', 'events.jsonl'), 'utf8');
  assert.ok(!events.includes('secret-thought'));
  assert.ok(!events.includes('secret-text-delta'));
  assert.ok(!events.includes('secret-tool-partial'));
  assert.ok(events.includes('tool_execution_end'));
  assert.ok(events.includes('agent_end'));

  await adapter.start({ id: 'error-stop', cwd, prompt: promptFor('error-stop') });
  const errorStop = await waitForState(adapter, 'error-stop', 'failed');
  assert.match(errorStop.error, /模拟错误|error/);
  assert.equal(errorStop.exitCode, 0);

  await adapter.start({ id: 'crash', cwd, prompt: promptFor('crash') });
  const crash = await waitForState(adapter, 'crash', 'failed');
  assert.equal(crash.exitCode, 3);

  await adapter.start({ id: 'truncated', cwd, prompt: promptFor('truncated') });
  const truncated = await waitForState(adapter, 'truncated', 'failed');
  assert.match(truncated.error, /截断|无法解析/);

  await adapter.start({ id: 'missing-final', cwd, prompt: promptFor('missing-final') });
  const missingFinal = await waitForState(adapter, 'missing-final', 'failed');
  assert.match(missingFinal.error, /助手|最终输出/);

  await adapter.start({ id: 'missing-agent-end', cwd, prompt: promptFor('missing-agent-end') });
  const missingEnd = await waitForState(adapter, 'missing-agent-end', 'failed');
  assert.match(missingEnd.error, /agent_end/);
});

test('新 PiAdapter 恢复已完成与运行中记录，不重复启动', async (t) => {
  const { adapter, cwd, runRoot } = await makeHarness(t);

  await adapter.start({ id: 'done', cwd, prompt: promptFor('normal') });
  await waitForState(adapter, 'done', 'completed');

  const restored = new PiAdapter({
    runRoot,
    command: process.execPath,
    prefixArgs: [path.join(runRoot, '..', 'fake-pi.mjs')],
    stopGraceMs: 300,
  });
  const done = await restored.status('done');
  assert.equal(done.state, 'completed');
  assert.equal(done.output, '最终结果：完成');
  await assert.rejects(
    restored.start({ id: 'done', cwd, prompt: promptFor('normal') }),
    /已存在/,
  );

  await adapter.start({ id: 'running', cwd, prompt: promptFor('hang') });
  const before = await waitForState(adapter, 'running', 'running');
  const running = await restored.status('running');
  assert.equal(running.state, 'running');
  assert.equal(running.monitorPid, before.monitorPid);
  assert.equal(running.sessionId, before.sessionId);
  const observation = await readObservation(runRoot, 'running');
  await sleep(200);
  const observationAgain = await readObservation(runRoot, 'running');
  assert.equal(observationAgain.startedAt, observation.startedAt);

  const listed = await restored.list();
  assert.deepEqual(
    listed.map((item) => item.id).sort(),
    ['done', 'running'],
  );

  const cancelled = await restored.cancel('running');
  assert.equal(cancelled.state, 'cancelled');
  assert.equal((await restored.status('running')).state, 'cancelled');
});

test('取消核对进程身份、处理后代持管道，monitor 消失时报 unknown', async (t) => {
  const { adapter, cwd, runRoot } = await makeHarness(t);

  await adapter.start({ id: 'cancel-me', cwd, prompt: promptFor('hang') });
  await waitForState(adapter, 'cancel-me', 'running');
  const descendantPid = await waitFor(async () => {
    const observation = await readObservation(runRoot, 'cancel-me');
    return Number.isInteger(observation.descendantPid) ? observation.descendantPid : null;
  });
  const processInfo = readJsonFile(path.join(runRoot, 'cancel-me', 'process.json'));
  assert.ok(processInfo?.pi);
  const piPid = processInfo.pi.pid;

  const cancelled = await adapter.cancel('cancel-me');
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.error, '任务已取消');
  await waitFor(() => {
    try {
      process.kill(piPid, 0);
      return false;
    } catch {
      return true;
    }
  });
  await waitFor(() => {
    try {
      process.kill(descendantPid, 0);
      return false;
    } catch {
      return true;
    }
  });

  await adapter.start({ id: 'tamper', cwd, prompt: promptFor('hang') });
  await waitForState(adapter, 'tamper', 'running');
  const tamperDir = path.join(runRoot, 'tamper');
  const original = readJsonFile(path.join(tamperDir, 'process.json'));
  const tampered = JSON.parse(JSON.stringify(original));
  tampered.pi.pid = process.pid;
  tampered.pi.pgid = process.pid;
  await writeFile(path.join(tamperDir, 'process.json'), JSON.stringify(tampered), 'utf8');
  await assert.rejects(adapter.cancel('tamper'), /身份核验失败/);
  assert.doesNotThrow(() => process.kill(process.pid, 0));
  await writeFile(path.join(tamperDir, 'process.json'), JSON.stringify(original), 'utf8');
  assert.equal((await adapter.cancel('tamper')).state, 'cancelled');

  await adapter.start({ id: 'lost-monitor', cwd, prompt: promptFor('hang') });
  await waitForState(adapter, 'lost-monitor', 'running');
  const lostInfo = readJsonFile(path.join(runRoot, 'lost-monitor', 'process.json'));
  safeKill(lostInfo.monitor.pid);
  await waitFor(async () => {
    const status = await adapter.status('lost-monitor');
    return status.state === 'unknown' && status.error ? status : null;
  });
  const lost = await adapter.status('lost-monitor');
  assert.equal(lost.state, 'unknown');
  assert.match(lost.error, /monitor/);
  assert.ok(existsSync(path.join(runRoot, 'lost-monitor', 'request.json')));
  safeKillGroup(lostInfo.pi.pgid);

  await assert.rejects(adapter.status('does-not-exist'), /未找到任务/);
  await assert.rejects(adapter.cancel('does-not-exist'), /未找到任务/);

  await adapter.start({ id: 'stubborn', cwd, prompt: promptFor('ignore-term') });
  await waitForState(adapter, 'stubborn', 'running');
  const stubbornPid = await waitFor(async () => {
    const observation = await readObservation(runRoot, 'stubborn');
    return Number.isInteger(observation.descendantPid) ? observation.descendantPid : null;
  });
  const stubbornInfo = readJsonFile(path.join(runRoot, 'stubborn', 'process.json'));
  const cancelStartedAt = Date.now();
  assert.equal((await adapter.cancel('stubborn')).state, 'cancelled');
  assert.ok(Date.now() - cancelStartedAt >= 250, '应等待 TERM 宽限后再升级');
  await waitFor(() => {
    try {
      process.kill(stubbornInfo.pi.pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  await waitFor(() => {
    try {
      process.kill(stubbornPid, 0);
      return false;
    } catch {
      return true;
    }
  });

  await assert.rejects(adapter.start({ id: '../escape', cwd, prompt: 'x' }), /id/);
  await assert.rejects(adapter.start({ id: 'x', cwd: path.join(cwd, 'nope'), prompt: 'x' }), /cwd/);
  await assert.rejects(adapter.start({ id: 'x', cwd, prompt: '   ' }), /prompt/);
  await assert.rejects(adapter.start({ id: 'x', cwd, prompt: 'x', role: 'admin' }), /role/);
  assert.throws(() => new PiAdapter({ runRoot: '' }), /runRoot/);
  assert.throws(
    () => new PiAdapter({ runRoot, prefixArgs: [1] }),
    /prefixArgs/,
  );
});

test('Pi 退出后 detached 后代仍持管道时返回有效 unknown，不误报 completed', async (t) => {
  const { adapter, cwd, runRoot } = await makeHarness(t);

  const startedAt = Date.now();
  await adapter.start({ id: 'orphan-pipe', cwd, prompt: promptFor('orphan-pipe') });
  const status = await waitForState(adapter, 'orphan-pipe', ['unknown', 'completed', 'failed'], 5000);
  const elapsed = Date.now() - startedAt;
  assert.equal(status.state, 'unknown');
  assert.match(status.error, /管道|detached|无法确认/);
  assert.ok(elapsed < 5000, `应在有界时间内返回，实际 ${elapsed}ms`);

  const descendantPid = await waitFor(async () => {
    const observation = await readObservation(runRoot, 'orphan-pipe');
    return Number.isInteger(observation.descendantPid) ? observation.descendantPid : null;
  });
  // 无法核验身份的 detached 后代不应被追杀。
  assert.doesNotThrow(() => process.kill(descendantPid, 0));
  safeKill(descendantPid);
});

test('取消时 detached 后代仍持管道返回有效 unknown，status/list/cancel 一致', async (t) => {
  const { adapter, cwd, runRoot } = await makeHarness(t);

  await adapter.start({ id: 'cancel-orphan', cwd, prompt: promptFor('cancel-orphan-pipe') });
  await waitForState(adapter, 'cancel-orphan', 'running');
  const descendantPid = await waitFor(async () => {
    const observation = await readObservation(runRoot, 'cancel-orphan');
    return Number.isInteger(observation.descendantPid) ? observation.descendantPid : null;
  });

  const cancelStartedAt = Date.now();
  const cancelled = await adapter.cancel('cancel-orphan');
  assert.ok(Date.now() - cancelStartedAt < 8000, '取消应在有界时间内返回');
  assert.equal(cancelled.state, 'unknown');
  assert.match(cancelled.error, /管道|detached|无法确认/);
  assert.doesNotMatch(cancelled.error, /无法解析|损坏/);

  // 有效 unknown 结果不是“JSON 损坏”，status/list 需一致识别。
  const status = await adapter.status('cancel-orphan');
  assert.equal(status.state, 'unknown');
  assert.match(status.error, /管道|detached|无法确认/);
  const listed = await adapter.list();
  assert.equal(listed.find((item) => item.id === 'cancel-orphan')?.state, 'unknown');

  // 未核验身份的 detached 后代不应被追杀；测试自行回收自有后代。
  assert.doesNotThrow(() => process.kill(descendantPid, 0));
  safeKill(descendantPid);
});

test('超长错误消息截断后日志每行是合法 JSON，最终结果仍保存', async (t) => {
  const { adapter, cwd, runRoot } = await makeHarness(t);

  await adapter.start({ id: 'long-error', cwd, prompt: promptFor('long-error') });
  const status = await waitForState(adapter, 'long-error', 'failed');
  assert.equal(status.exitCode, 0);
  assert.match(status.error, /error|错误/);

  const events = await readFile(path.join(runRoot, 'long-error', 'events.jsonl'), 'utf8');
  const lines = events.trim().split('\n').filter((line) => line.length > 0);
  assert.ok(lines.length >= 3, `应保存多条事件，实际 ${lines.length}`);
  for (const [index, line] of lines.entries()) {
    assert.doesNotThrow(() => JSON.parse(line), `第 ${index + 1} 行应为合法 JSON`);
  }
  assert.ok(
    lines.some((line) => JSON.parse(line).type === 'message_end'),
    '应保留 message_end 记录',
  );
  assert.ok(events.includes('truncated'), '超长字段应带截断标记');

  const logStat = await stat(path.join(runRoot, 'long-error', 'events.jsonl'));
  assert.ok(logStat.size <= 256 * 1024, `日志应为有界大小，实际 ${logStat.size}`);

  const result = JSON.parse(await readFile(path.join(runRoot, 'long-error', 'result.json'), 'utf8'));
  assert.equal(result.state, 'failed');
});

test('日志达到上限时停止增长，并仍保存最终结果', async (t) => {
  const { adapter, cwd, runRoot } = await makeHarness(t);

  await adapter.start({ id: 'log-cap', cwd, prompt: promptFor('log-cap') });
  const status = await waitForState(adapter, 'log-cap', 'completed', 12000);
  assert.equal(status.output, '最终结果：完成');

  const logStat = await stat(path.join(runRoot, 'log-cap', 'events.jsonl'));
  assert.ok(logStat.size <= 256 * 1024, `日志应为有界大小，实际 ${logStat.size}`);
  const events = await readFile(path.join(runRoot, 'log-cap', 'events.jsonl'), 'utf8');
  assert.ok(events.includes('log_capped'));

  const result = JSON.parse(await readFile(path.join(runRoot, 'log-cap', 'result.json'), 'utf8'));
  assert.equal(result.state, 'completed');
  assert.equal(result.logCapped, true);
});

test('半写或损坏的结果文件不会被当成成功', async (t) => {
  const { adapter, cwd, runRoot } = await makeHarness(t);

  await adapter.start({ id: 'half', cwd, prompt: promptFor('normal') });
  await waitForState(adapter, 'half', 'completed');
  const resultFile = path.join(runRoot, 'half', 'result.json');
  await writeFile(resultFile, '{"id":"half","state":"completed"', 'utf8');
  const status = await adapter.status('half');
  assert.equal(status.state, 'unknown');
  assert.match(status.error, /无法解析/);
  await assert.rejects(adapter.cancel('half'), /损坏/);

  // 合法 JSON 但缺少结果字段，同样不能被当成 completed。
  await writeFile(
    resultFile,
    JSON.stringify({ id: 'half', state: 'completed', endedAt: new Date().toISOString() }),
    'utf8',
  );
  const incomplete = await adapter.status('half');
  assert.equal(incomplete.state, 'unknown');
  assert.match(incomplete.error, /无法解析/);
});
