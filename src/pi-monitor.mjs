import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  describeProcess,
  processGroupAlive,
  readJsonFile,
  writeJsonAtomic,
} from './pi-adapter.mjs';

const LOG_MAX_BYTES = 256 * 1024;
const MAX_PROGRESS = 20;
const MAX_TEXT_CHARS = 4000;
const MAX_RECORD_CHARS = 8000;
const MAX_RECORD_FIELD_CHARS = 1000;
const MAX_RECORD_ARRAY_ITEMS = 20;
const MAX_RECORD_OBJECT_KEYS = 30;
const MAX_RECORD_DEPTH = 4;
const FINALIZE_SETTLE_MS = 250;
const TOOL_ALLOWLIST = 'read,bash,edit,write,grep,find,ls';

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function extractAssistantText(message) {
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) {
    return '';
  }
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function safeStringify(value) {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/**
 * Shrink a record at the value level so the final JSON is always serializable.
 * Cutting the serialized string would leave unterminated strings/escapes.
 */
function shrinkRecordValue(value, depth = 0) {
  if (typeof value === 'string') {
    if (value.length <= MAX_RECORD_FIELD_CHARS) {
      return value;
    }
    return `${value.slice(0, MAX_RECORD_FIELD_CHARS)}…[truncated ${
      value.length - MAX_RECORD_FIELD_CHARS
    } chars]`;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (depth >= MAX_RECORD_DEPTH) {
    return '[depth-limit]';
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_RECORD_ARRAY_ITEMS)
      .map((item) => shrinkRecordValue(item, depth + 1));
    if (value.length > MAX_RECORD_ARRAY_ITEMS) {
      items.push(`[+${value.length - MAX_RECORD_ARRAY_ITEMS} more]`);
    }
    return items;
  }
  if (isObject(value)) {
    const out = {};
    const keys = Object.keys(value);
    for (const key of keys.slice(0, MAX_RECORD_OBJECT_KEYS)) {
      out[key] = shrinkRecordValue(value[key], depth + 1);
    }
    if (keys.length > MAX_RECORD_OBJECT_KEYS) {
      out.__truncatedKeys = keys.length - MAX_RECORD_OBJECT_KEYS;
    }
    return out;
  }
  // bigint/function/symbol cannot be serialized; replace with a marker.
  return '[unserializable]';
}

function compactJson(value) {
  const direct = safeStringify(value);
  if (direct !== null && direct.length <= MAX_RECORD_CHARS) {
    return direct;
  }
  const shortened = safeStringify(shrinkRecordValue(value));
  if (shortened !== null && shortened.length <= MAX_RECORD_CHARS) {
    return shortened;
  }
  const summary = safeStringify({
    type: isObject(value) && typeof value.type === 'string' ? value.type : 'record',
    truncated: true,
    originalChars: direct === null ? null : direct.length,
  });
  return summary ?? '{"type":"record_truncated"}';
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRequest(dir) {
  const request = readJsonFile(path.join(dir, 'request.json'));
  if (!request || typeof request.id !== 'string') {
    return null;
  }
  return request;
}

class Monitor {
  constructor({ dir, request }) {
    this.dir = dir;
    this.request = request;
    this.eventsPath = path.join(dir, 'events.jsonl');
    this.logBytes = 0;
    this.logCapped = false;
    this.progress = [];
    this.progressTimer = null;
    this.progressDirty = false;
    this.parseErrors = 0;
    this.trailing = '';
    this.sawAgentEnd = false;
    this.agentEndWillRetry = false;
    this.settledAborted = false;
    this.lastAssistant = null;
    this.lastOutput = '';
    this.spawnError = null;
    this.exitInfo = null;
    this.finished = false;
    this.finishTimer = null;
    this.child = null;
    this.childClosed = false;
    this.pipeHoldUnconfirmed = false;
  }

  writeEvent(record) {
    if (this.logCapped) {
      return;
    }
    const line = `${compactJson(record)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (this.logBytes + bytes > LOG_MAX_BYTES) {
      this.logCapped = true;
      const note = `${JSON.stringify({ type: 'log_capped', maxBytes: LOG_MAX_BYTES })}\n`;
      const noteBytes = Buffer.byteLength(note, 'utf8');
      if (this.logBytes + noteBytes <= LOG_MAX_BYTES) {
        appendFileSync(this.eventsPath, note);
        this.logBytes += noteBytes;
      }
      return;
    }
    appendFileSync(this.eventsPath, line);
    this.logBytes += bytes;
  }

  addProgress(phase, message) {
    this.progress.push({
      at: new Date().toISOString(),
      phase,
      message: String(message).slice(0, 500),
    });
    if (this.progress.length > MAX_PROGRESS) {
      this.progress = this.progress.slice(-MAX_PROGRESS);
    }
    this.#scheduleProgressWrite();
  }

  #scheduleProgressWrite() {
    this.progressDirty = true;
    if (this.progressTimer) {
      return;
    }
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null;
      if (!this.progressDirty || this.finished) {
        return;
      }
      this.progressDirty = false;
      try {
        writeJsonAtomic(path.join(this.dir, 'progress.json'), this.progress);
      } catch {
        // Progress is advisory; the final result is still written.
      }
    }, 25);
    this.progressTimer.unref?.();
  }

  handleLine(line) {
    if (line.length === 0) {
      return;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      this.parseErrors += 1;
      this.writeEvent({ type: 'parse_error' });
      return;
    }
    if (!event || typeof event.type !== 'string') {
      this.parseErrors += 1;
      this.writeEvent({ type: 'parse_error' });
      return;
    }

    switch (event.type) {
      case 'session':
        this.writeEvent({ type: 'session', id: event.id ?? null });
        break;
      case 'agent_start':
        this.addProgress('agent', '模型开始运行');
        this.writeEvent({ type: 'agent_start' });
        break;
      case 'message_update':
        // Deltas are intentionally dropped: they duplicate text per character and
        // may contain thinking content.
        break;
      case 'message_end': {
        const message = event.message;
        if (!message || message.role !== 'assistant') {
          break;
        }
        const text = extractAssistantText(message);
        this.lastAssistant = {
          text,
          stopReason: typeof message.stopReason === 'string' ? message.stopReason : null,
          errorMessage:
            typeof message.errorMessage === 'string' ? message.errorMessage : null,
        };
        this.lastOutput = text;
        this.writeEvent({
          type: 'message_end',
          role: 'assistant',
          stopReason: this.lastAssistant.stopReason,
          errorMessage: this.lastAssistant.errorMessage,
          text: text.slice(0, MAX_TEXT_CHARS),
        });
        this.addProgress('assistant', '助手响应完成');
        break;
      }
      case 'tool_execution_start':
        this.writeEvent({
          type: 'tool_execution_start',
          toolCallId: event.toolCallId ?? null,
          toolName: event.toolName ?? null,
        });
        this.addProgress('tool', `开始工具 ${String(event.toolName ?? 'unknown')}`);
        break;
      case 'tool_execution_end':
        this.writeEvent({
          type: 'tool_execution_end',
          toolCallId: event.toolCallId ?? null,
          toolName: event.toolName ?? null,
          isError: event.isError === true,
          durationMs: Number.isFinite(event.durationMs) ? event.durationMs : null,
        });
        this.addProgress(
          'tool',
          `完成工具 ${String(event.toolName ?? 'unknown')}${event.isError === true ? '（失败）' : ''}`,
        );
        break;
      case 'turn_end':
        this.writeEvent({
          type: 'turn_end',
          toolResults: Array.isArray(event.toolResults) ? event.toolResults.length : 0,
        });
        break;
      case 'agent_end':
        if (Array.isArray(event.messages)) {
          this.sawAgentEnd = true;
          this.agentEndWillRetry = event.willRetry === true;
          this.writeEvent({
            type: 'agent_end',
            messageCount: event.messages.length,
            willRetry: this.agentEndWillRetry,
          });
          this.addProgress('agent', 'agent_end 已收到');
        } else {
          this.parseErrors += 1;
          this.writeEvent({ type: 'invalid_agent_end' });
        }
        break;
      case 'agent_settled':
        this.settledAborted = event.aborted === true;
        this.writeEvent({ type: 'agent_settled', aborted: this.settledAborted });
        break;
      default:
        break;
    }
  }

  handleChunk(chunk) {
    this.trailing += chunk;
    let newline = this.trailing.indexOf('\n');
    while (newline !== -1) {
      let line = this.trailing.slice(0, newline);
      this.trailing = this.trailing.slice(newline + 1);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      this.handleLine(line);
      newline = this.trailing.indexOf('\n');
    }
    if (this.trailing.length > 4 * 1024 * 1024) {
      this.parseErrors += 1;
      this.trailing = '';
      this.writeEvent({ type: 'parse_error', reason: 'line_too_large' });
    }
  }

  async recordIdentity(child) {
    const deadline = Date.now() + 600;
    let pi = describeProcess(child.pid);
    while (!pi && Date.now() < deadline) {
      await sleep(20);
      pi = describeProcess(child.pid);
    }
    writeJsonAtomic(path.join(this.dir, 'process.json'), {
      monitor: describeProcess(process.pid),
      pi: pi ?? {
        pid: child.pid,
        pgid: child.pid,
        startTime: null,
      },
      recordedAt: new Date().toISOString(),
    });
  }

  buildArgv() {
    const { request } = this;
    const argv = [
      ...request.prefixArgs,
      '--provider',
      request.provider,
      '--model',
      'deepseek-flash',
      '--thinking',
      'high',
      '--print',
      '--mode',
      'json',
      '--no-extensions',
      '--no-mcp',
      '--no-skills',
      '--no-prompt-templates',
      '--session-dir',
      request.sessionDir,
      '--session-id',
      request.sessionId,
    ];
    if (request.role === 'draft') {
      argv.push('--no-tools');
    } else {
      argv.push('--tools', TOOL_ALLOWLIST);
    }
    argv.push('--', `@${request.promptFile}`);
    return argv;
  }

  finalize() {
    if (this.finished) {
      return;
    }
    this.finished = true;
    if (this.finishTimer) {
      clearTimeout(this.finishTimer);
      this.finishTimer = null;
    }

    if (this.trailing.trim().length > 0) {
      this.parseErrors += 1;
      this.writeEvent({ type: 'parse_error', reason: 'truncated_jsonl' });
    }

    const cancelRequested = existsSync(path.join(this.dir, 'cancel.json'));
    let state;
    let error = null;

    if (this.spawnError) {
      state = 'failed';
      error = `启动 Pi 失败: ${this.spawnError.message}`;
    } else if (this.pipeHoldUnconfirmed) {
      // The Pi process group is gone, but a descendant we cannot verify still
      // holds the output pipe. Do not claim a confirmed stop.
      state = 'unknown';
      error =
        'Pi 进程已退出，但仍有无法核验身份的 detached 后代持有输出管道，' +
        '无法确认输出进程已全部停止；已清理自有进程组，未追杀身份不明的进程';
    } else if (cancelRequested) {
      state = 'cancelled';
      error = '任务已取消';
    } else if (this.settledAborted) {
      state = 'failed';
      error = '模型运行被中止';
    } else if (!this.sawAgentEnd) {
      state = 'failed';
      error = '未收到有效的 agent_end 事件';
    } else if (this.agentEndWillRetry) {
      state = 'failed';
      error = 'agent_end 表示仍将自动重试，任务未正常结束';
    } else if (!this.lastAssistant) {
      state = 'failed';
      error = '缺少已完成的助手消息';
    } else if (
      this.lastAssistant.stopReason === 'error' ||
      this.lastAssistant.stopReason === 'aborted'
    ) {
      state = 'failed';
      error = `模型结束状态为 ${this.lastAssistant.stopReason}${
        this.lastAssistant.errorMessage ? `: ${this.lastAssistant.errorMessage}` : ''
      }`;
    } else if (this.lastAssistant.errorMessage) {
      state = 'failed';
      error = `模型返回错误: ${this.lastAssistant.errorMessage}`;
    } else if (this.lastAssistant.stopReason !== 'stop') {
      state = 'failed';
      error = `模型未正常完成，结束状态为 ${String(this.lastAssistant.stopReason)}`;
    } else if (this.parseErrors > 0) {
      state = 'failed';
      error = 'Pi JSONL 输出包含无法解析或被截断的记录';
    } else if (this.lastOutput.trim().length === 0) {
      state = 'failed';
      error = '缺少最终助手输出';
    } else if (!this.exitInfo || this.exitInfo.code !== 0) {
      state = 'failed';
      error = this.exitInfo
        ? this.exitInfo.signal
          ? `Pi 进程收到信号 ${this.exitInfo.signal}`
          : `Pi 进程退出码 ${String(this.exitInfo.code)}`
        : 'Pi 进程未正常退出';
    } else {
      state = 'completed';
    }

    this.addProgress('result', state === 'completed' ? '任务完成' : `任务结束: ${state}`);
    if (this.progressTimer) {
      clearTimeout(this.progressTimer);
      this.progressTimer = null;
    }
    this.progressDirty = false;

    const result = {
      schemaVersion: 1,
      id: this.request.id,
      state,
      dir: this.dir,
      role: this.request.role,
      monitorPid: process.pid,
      sessionId: this.request.sessionId,
      startedAt: this.request.startedAt,
      endedAt: new Date().toISOString(),
      output: this.lastOutput,
      error,
      exitCode: this.exitInfo && Number.isInteger(this.exitInfo.code) ? this.exitInfo.code : null,
      signal: this.exitInfo?.signal ?? null,
      progress: this.progress.slice(-MAX_PROGRESS),
      logCapped: this.logCapped,
    };

    try {
      writeJsonAtomic(path.join(this.dir, 'progress.json'), result.progress);
    } catch {
      // Best effort; result.json is authoritative.
    }
    writeJsonAtomic(path.join(this.dir, 'result.json'), result);
  }

  async #settleAfterExit() {
    await this.#cleanupDescendants();
    // Our own process group is gone. If the streams still have not reached EOF,
    // an unverifiable descendant (for example a detached process) holds the
    // output pipe. Wait briefly before forcing the monitor to finish.
    const deadline = Date.now() + Math.max(200, Math.min(this.request.stopGraceMs, 1500));
    while (!this.childClosed && Date.now() < deadline) {
      await sleep(25);
    }
    if (!this.childClosed) {
      // Destroying the pipes keeps finalization bounded, but it also means we
      // cannot prove every output producer stopped.
      this.pipeHoldUnconfirmed = true;
      this.destroyPipes();
    }
    this.finalize();
  }

  async #cleanupDescendants() {
    const pgid = this.child?.pid;
    if (!Number.isInteger(pgid) || !processGroupAlive(pgid)) {
      return;
    }
    try {
      process.kill(-pgid, 'SIGTERM');
    } catch {
      return;
    }
    const deadline = Date.now() + Math.min(this.request.stopGraceMs, 500);
    while (Date.now() < deadline && processGroupAlive(pgid)) {
      await sleep(25);
    }
    if (processGroupAlive(pgid)) {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }

  destroyPipes() {
    try {
      this.child?.stdout?.destroy();
    } catch {
      // Ignore cleanup failures.
    }
    try {
      this.child?.stderr?.destroy();
    } catch {
      // Ignore cleanup failures.
    }
  }

  async run() {
    const resultFile = path.join(this.dir, 'result.json');
    if (existsSync(resultFile)) {
      return;
    }

    const argv = this.buildArgv();
    let child;
    try {
      child = spawn(this.request.command, argv, {
        cwd: this.request.cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (error) {
      this.spawnError = error;
      this.finalize();
      return;
    }
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (!this.finished) {
        this.handleChunk(chunk);
      }
    });
    // Drain stderr without persisting it: it can contain provider details.
    child.stderr.on('data', () => {});

    child.on('error', (error) => {
      this.spawnError = error;
      this.finalize();
    });

    child.on('exit', (code, signal) => {
      this.exitInfo = { code: Number.isInteger(code) ? code : null, signal: signal ?? null };
      this.addProgress(
        'process',
        signal ? `Pi 进程收到信号 ${signal}` : `Pi 进程退出码 ${String(code)}`,
      );
      // A descendant may keep stdout open after Pi exits. Finalize within a
      // bounded window instead of waiting for EOF forever.
      const settle = Math.max(this.request.stopGraceMs, FINALIZE_SETTLE_MS);
      this.finishTimer = setTimeout(() => {
        this.finishTimer = null;
        void this.#settleAfterExit();
      }, settle);
    });

    child.on('close', () => {
      this.childClosed = true;
      this.finalize();
    });

    // Record identity after the stream listeners are attached so a very short
    // lived process still has its stdout/exit consumed.
    await this.recordIdentity(child);
    if (!this.finished) {
      this.addProgress('start', 'Pi 进程已启动');
    }
  }
}

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    process.stderr.write('usage: pi-monitor.mjs <task-dir>\n');
    process.exitCode = 2;
    return;
  }
  const request = readRequest(dir);
  if (!request) {
    process.stderr.write(`invalid request in ${dir}\n`);
    process.exitCode = 2;
    return;
  }
  mkdirSync(path.join(dir, 'session'), { recursive: true });
  const monitor = new Monitor({ dir, request });
  await monitor.run();
}

function handleFatal(error) {
  const dir = process.argv[2];
  try {
    if (dir) {
      const request = readRequest(dir);
      if (request) {
        writeJsonAtomic(path.join(dir, 'result.json'), {
          schemaVersion: 1,
          id: request.id,
          state: 'failed',
          dir,
          role: request.role,
          monitorPid: process.pid,
          sessionId: request.sessionId,
          startedAt: request.startedAt,
          endedAt: new Date().toISOString(),
          output: '',
          error: `monitor 异常: ${error instanceof Error ? error.message : String(error)}`,
          exitCode: null,
          signal: null,
          progress: [],
          logCapped: false,
        });
      }
    }
  } catch {
    // Nothing else can be persisted.
  }
  process.stderr.write(
    `pi-monitor failed: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
}

const isMain =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(handleFatal);
}

export { LOG_MAX_BYTES, TOOL_ALLOWLIST };
