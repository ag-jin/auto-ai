import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ROLE_PATTERN = /^(draft|worker)$/;
const FINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'unknown']);
const MONITOR_PATH = fileURLToPath(new URL('./pi-monitor.mjs', import.meta.url));

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error('id 必须是字母、数字、连字符或下划线组成的单段标识');
  }
}

function assertPosix() {
  if (process.platform === 'win32') {
    throw new Error('PiAdapter 仅支持 POSIX 平台（当前平台无法保证进程组语义）');
  }
}

function taskDirFor(runRoot, id) {
  return path.join(runRoot, id);
}

function requestPath(dir) {
  return path.join(dir, 'request.json');
}

function processPath(dir) {
  return path.join(dir, 'process.json');
}

function resultPath(dir) {
  return path.join(dir, 'result.json');
}

function cancelPath(dir) {
  return path.join(dir, 'cancel.json');
}

function progressPath(dir) {
  return path.join(dir, 'progress.json');
}

export function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}

/**
 * Describe a live process well enough to reject a reused PID.
 * Returns null when the process does not exist.
 */
export function describeProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  try {
    const output = execFileSync(
      'ps',
      ['-p', String(pid), '-o', 'pid=', '-o', 'pgid=', '-o', 'lstart='],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 },
    ).trim();
    if (output.length === 0) {
      return null;
    }
    const match = output.match(/^(\d+)\s+(\d+)\s+(.+)$/s);
    if (!match) {
      return null;
    }
    return {
      pid: Number.parseInt(match[1], 10),
      pgid: Number.parseInt(match[2], 10),
      startTime: match[3].trim(),
    };
  } catch {
    return null;
  }
}

export function identityMatches(record) {
  if (!isObject(record) || !Number.isInteger(record.pid) || record.pid <= 0) {
    return false;
  }
  const live = describeProcess(record.pid);
  return Boolean(
    live &&
      live.pid === record.pid &&
      live.pgid === record.pgid &&
      typeof record.startTime === 'string' &&
      live.startTime === record.startTime,
  );
}

export function processGroupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1) {
    return false;
  }
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

function normalizeProgress(value, fallback = []) {
  if (!Array.isArray(value)) {
    return fallback;
  }
  return value
    .filter(
      (item) =>
        isObject(item) &&
        typeof item.at === 'string' &&
        typeof item.phase === 'string' &&
        typeof item.message === 'string',
    )
    .slice(-50)
    .map((item) => ({ at: item.at, phase: item.phase, message: item.message }));
}

function baseStatus(id, dir, request, processInfo) {
  return {
    id,
    state: 'unknown',
    dir,
    monitorPid: processInfo?.monitor?.pid ?? null,
    sessionId: request?.sessionId ?? null,
    startedAt: request?.startedAt ?? null,
    endedAt: null,
    output: null,
    error: null,
    exitCode: null,
    progress: [],
  };
}

function finalStatus(id, dir, result) {
  return {
    id,
    state: result.state,
    dir,
    monitorPid: result.monitorPid ?? null,
    sessionId: result.sessionId ?? null,
    startedAt: result.startedAt ?? null,
    endedAt: result.endedAt ?? null,
    output: typeof result.output === 'string' ? result.output : null,
    error: typeof result.error === 'string' ? result.error : null,
    exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
    progress: normalizeProgress(result.progress),
  };
}

function isValidResult(result, id) {
  return Boolean(
    isObject(result) &&
      result.id === id &&
      FINAL_STATES.has(result.state) &&
      typeof result.endedAt === 'string' &&
      result.endedAt.length > 0 &&
      typeof result.startedAt === 'string' &&
      typeof result.output === 'string' &&
      Array.isArray(result.progress) &&
      (result.error === null || typeof result.error === 'string'),
  );
}

function readResult(id, dir) {
  if (!existsSync(resultPath(dir))) {
    return { exists: false, result: null };
  }
  const result = readJsonFile(resultPath(dir));
  return { exists: true, result: isValidResult(result, id) ? result : null };
}

function readProgress(dir) {
  return normalizeProgress(readJsonFile(progressPath(dir)));
}

export class PiAdapter {
  constructor({
    runRoot,
    command = 'pi',
    prefixArgs = [],
    provider = 'facaiai-deepseek',
    stopGraceMs = 2000,
  } = {}) {
    if (typeof runRoot !== 'string' || runRoot.trim().length === 0) {
      throw new Error('runRoot 必须是非空字符串');
    }
    if (typeof command !== 'string' || command.trim().length === 0) {
      throw new Error('command 必须是非空字符串');
    }
    if (!Array.isArray(prefixArgs) || prefixArgs.some((item) => typeof item !== 'string')) {
      throw new Error('prefixArgs 必须是字符串数组');
    }
    if (typeof provider !== 'string' || provider.trim().length === 0) {
      throw new Error('provider 必须是非空字符串');
    }
    if (!Number.isInteger(stopGraceMs) || stopGraceMs < 0 || stopGraceMs > 60000) {
      throw new Error('stopGraceMs 必须是 0 到 60000 之间的整数');
    }

    this.runRoot = path.resolve(runRoot);
    this.command = command;
    this.prefixArgs = [...prefixArgs];
    this.provider = provider;
    this.stopGraceMs = stopGraceMs;
  }

  async start({ id, cwd, prompt, role = 'worker' } = {}) {
    assertPosix();
    assertId(id);

    if (typeof cwd !== 'string' || cwd.trim().length === 0) {
      throw new Error('cwd 必须是非空字符串');
    }
    const resolvedCwd = path.resolve(cwd);
    let cwdStat;
    try {
      cwdStat = statSync(resolvedCwd);
    } catch {
      throw new Error(`cwd 不存在: ${resolvedCwd}`);
    }
    if (!cwdStat.isDirectory()) {
      throw new Error(`cwd 不是目录: ${resolvedCwd}`);
    }

    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new Error('prompt 必须是非空文本');
    }
    if (typeof role !== 'string' || !ROLE_PATTERN.test(role)) {
      throw new Error('role 必须是 draft 或 worker');
    }

    mkdirSync(this.runRoot, { recursive: true });
    const dir = taskDirFor(this.runRoot, id);

    try {
      mkdirSync(dir);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error(`任务 id 已存在，拒绝重复启动: ${id}`);
      }
      throw error;
    }

    try {
      const sessionId = randomUUID();
      const sessionDir = path.join(dir, 'session');
      mkdirSync(sessionDir, { recursive: true });

      const promptFile = path.join(dir, 'prompt.md');
      writeFileSync(promptFile, prompt, 'utf8');

      const startedAt = new Date().toISOString();
      const request = {
        schemaVersion: 1,
        id,
        cwd: resolvedCwd,
        role,
        promptFile,
        sessionId,
        sessionDir,
        provider: this.provider,
        command: this.command,
        prefixArgs: this.prefixArgs,
        stopGraceMs: this.stopGraceMs,
        startedAt,
      };
      writeJsonAtomic(requestPath(dir), request);

      const monitor = spawn(process.execPath, [MONITOR_PATH, dir], {
        cwd: dir,
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });

      if (!Number.isInteger(monitor.pid)) {
        throw new Error('无法启动 Pi monitor 进程');
      }
      monitor.unref();

      // Give the monitor a short, bounded window to record the child identity.
      // This never waits for the model itself.
      const identityDeadline = Date.now() + 800;
      while (Date.now() < identityDeadline) {
        if (existsSync(processPath(dir)) || existsSync(resultPath(dir))) {
          break;
        }
        await sleep(20);
      }

      return {
        id,
        state: 'running',
        dir,
        monitorPid: monitor.pid,
        sessionId,
      };
    } catch (error) {
      // Keep the directory for inspection; only the pre-record failure is surfaced.
      throw error;
    }
  }

  async status(id) {
    assertId(id);
    const dir = taskDirFor(this.runRoot, id);
    if (!existsSync(requestPath(dir))) {
      throw new Error(`未找到任务: ${id}`);
    }

    const request = readJsonFile(requestPath(dir));
    const processInfo = readJsonFile(processPath(dir));
    const { exists, result } = readResult(id, dir);

    if (exists) {
      if (result) {
        return finalStatus(id, dir, result);
      }
      const status = baseStatus(id, dir, request, processInfo);
      status.error = '结果文件无法解析或未完成写入，状态不明';
      return status;
    }

    if (processInfo && identityMatches(processInfo.monitor)) {
      const status = baseStatus(id, dir, request, processInfo);
      status.state = 'running';
      status.progress = readProgress(dir);
      return status;
    }

    // The monitor may have just exited after writing the result.
    const late = readResult(id, dir);
    if (late.result) {
      return finalStatus(id, dir, late.result);
    }

    const status = baseStatus(id, dir, request, processInfo);
    status.progress = readProgress(dir);
    status.error = 'monitor 已退出且没有可用的最终结果，状态不明';
    return status;
  }

  async list() {
    if (!existsSync(this.runRoot)) {
      return [];
    }
    const entries = readdirSync(this.runRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    const statuses = [];
    for (const entry of entries) {
      if (!existsSync(requestPath(path.join(this.runRoot, entry.name)))) {
        continue;
      }
      try {
        statuses.push(await this.status(entry.name));
      } catch (error) {
        statuses.push({
          id: entry.name,
          state: 'unknown',
          dir: path.join(this.runRoot, entry.name),
          monitorPid: null,
          sessionId: null,
          startedAt: null,
          endedAt: null,
          output: null,
          error: error instanceof Error ? error.message : String(error),
          exitCode: null,
          progress: [],
        });
      }
    }
    return statuses;
  }

  async cancel(id) {
    assertPosix();
    assertId(id);
    const dir = taskDirFor(this.runRoot, id);
    if (!existsSync(requestPath(dir))) {
      throw new Error(`未找到任务: ${id}`);
    }

    const existing = readResult(id, dir);
    if (existing.result) {
      return finalStatus(id, dir, existing.result);
    }
    if (existing.exists) {
      throw new Error('结果文件损坏，状态不明，拒绝取消');
    }

    const request = readJsonFile(requestPath(dir));
    if (!request) {
      throw new Error('请求记录损坏，拒绝取消');
    }
    const processInfo = readJsonFile(processPath(dir));
    if (!isObject(processInfo) || !isObject(processInfo.pi)) {
      throw new Error('尚未记录子进程身份，拒绝发送信号');
    }

    if (!identityMatches(processInfo.monitor)) {
      throw new Error('monitor 进程身份核验失败，拒绝发送信号');
    }

    const pi = processInfo.pi;
    const piLive = describeProcess(pi.pid);
    if (piLive !== null && !identityMatches(pi)) {
      throw new Error('子进程身份核验失败（PID 可能已被复用），拒绝发送信号');
    }
    if (piLive !== null && (!Number.isInteger(pi.pgid) || pi.pgid !== pi.pid)) {
      throw new Error('子进程进程组身份不匹配，拒绝发送信号');
    }

    if (piLive === null) {
      // Pi already exited; the monitor is still finalizing. Do not mark cancelled
      // without a confirmed stop and a result written by the monitor.
      const final = await this.#waitForResult(id, dir, this.stopGraceMs + 3000);
      if (final) {
        return finalStatus(id, dir, final);
      }
      throw new Error('子进程已退出，但未能确认最终结果');
    }

    writeJsonAtomic(cancelPath(dir), {
      requestedAt: new Date().toISOString(),
      requester: 'PiAdapter.cancel',
    });

    signalGroup(pi.pgid, 'SIGTERM');

    const termDeadline = Date.now() + this.stopGraceMs;
    while (Date.now() < termDeadline && processGroupAlive(pi.pgid)) {
      await sleep(25);
    }

    if (processGroupAlive(pi.pgid)) {
      // Re-check identity before escalating to KILL.
      if (!identityMatches(pi)) {
        const final = await this.#waitForResult(id, dir, this.stopGraceMs + 3000);
        if (final) {
          return finalStatus(id, dir, final);
        }
        throw new Error('无法再次确认子进程身份，拒绝发送 KILL');
      }
      signalGroup(pi.pgid, 'SIGKILL');
    }

    const final = await this.#waitForResult(
      id,
      dir,
      this.stopGraceMs + 5000,
      () => !processGroupAlive(pi.pgid),
    );
    if (final) {
      return finalStatus(id, dir, final);
    }
    throw new Error('已发送终止信号，但未能确认最终结果，未标记为 cancelled');
  }

  async #waitForResult(id, dir, timeoutMs, stopped = () => true) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = readResult(id, dir);
      if (current.result) {
        return current.result;
      }
      if (!existsSync(processPath(dir))) {
        await sleep(50);
        continue;
      }
      if (stopped()) {
        const late = readResult(id, dir);
        if (late.result) {
          return late.result;
        }
      }
      await sleep(50);
    }
    return null;
  }
}
