import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';

import { describeProcess, identityMatches } from './pi-adapter.mjs';

export function httpError(statusCode, code, message, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

export function readJsonFile(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw httpError(500, 'state_corrupt', `运行状态文件无法解析：${path.basename(file)}`, {
      file,
      reason: error.message,
    });
  }
}

export function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(temp, 'w');
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`, null, 'utf8');
    closeSync(fd);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // Keep the original error.
    }
    rmSync(temp, { force: true });
    throw error;
  }
  // rename replaces the target atomically on POSIX filesystems.
  renameSync(temp, file);
}

/**
 * Controller lock backed by a small identity record. A lock whose PID identity
 * no longer matches is stale and can be recovered; a live match always wins.
 */
/**
 * A lock owner is live when its PID identity matches. When the identity could not
 * be captured (no ps output at acquire time), fall back to a signal-0 probe so a
 * live controller is never displaced.
 */
function lockIsLive(record) {
  if (identityMatches(record)) {
    return true;
  }
  if (!Number.isInteger(record?.pid) || record.pid <= 0) {
    return false;
  }
  if (typeof record.startTime === 'string' && record.startTime.length > 0) {
    return false;
  }
  try {
    process.kill(record.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class ControllerLock {
  #file;
  #record;

  constructor(file, record) {
    this.#file = file;
    this.#record = record;
  }

  static acquire(file) {
    mkdirSync(path.dirname(file), { recursive: true });
    const self = describeProcess(process.pid);
    const record = {
      schemaVersion: 1,
      pid: process.pid,
      pgid: self?.pgid ?? null,
      startTime: self?.startTime ?? null,
      createdAt: new Date().toISOString(),
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const fd = openSync(file, 'wx');
        try {
          writeSync(fd, `${JSON.stringify(record, null, 2)}\n`, null, 'utf8');
        } finally {
          closeSync(fd);
        }
        return new ControllerLock(file, record);
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          throw error;
        }
      }

      const existing = readJsonFile(file);
      if (existing && lockIsLive(existing)) {
        throw httpError(
          409,
          'runtime_locked',
          `已有 Runtime 控制器持有锁（PID ${existing.pid}，启动于 ${existing.startTime ?? '未知'}）`,
          { pid: existing.pid, startTime: existing.startTime ?? null },
        );
      }
      rmSync(file, { force: true });
    }

    throw httpError(409, 'runtime_locked', '无法获取控制器锁：锁文件状态持续冲突', { file });
  }

  release() {
    const existing = readJsonFile(this.#file);
    if (!existing) {
      return;
    }
    const sameOwner =
      existing.pid === this.#record.pid &&
      (existing.startTime ?? null) === (this.#record.startTime ?? null);
    if (!sameOwner) {
      return;
    }
    rmSync(this.#file, { force: true });
  }

  get owned() {
    return existsSync(this.#file);
  }
}
