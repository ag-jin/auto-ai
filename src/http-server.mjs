import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 0;
const MAX_BODY_BYTES = 1024 * 1024;
const HARD_BODY_LIMIT = MAX_BODY_BYTES * 16;
const DEFAULT_PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

const WRITE_CODE_BY_STATUS = new Map([
  [400, 'invalid_request'],
  [403, 'forbidden'],
  [404, 'not_found'],
  [405, 'method_not_allowed'],
  [409, 'conflict'],
  [413, 'payload_too_large'],
  [503, 'unavailable'],
]);

// 错误输出边界：只允许这些简单业务字段，且每个字段都按类型和长度校验。
const ALLOWED_DETAIL_KEYS = new Set(['currentRev', 'allowed', 'reasons']);
const MAX_ERROR_MESSAGE_CHARS = 200;
const MAX_DETAIL_TEXT_CHARS = 200;
const MAX_DETAIL_ITEMS = 20;
const MAX_ALLOWED_ITEMS = 10;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const ALLOWED_METHOD_PATTERN = /^[A-Z]{3,10}$/;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;
const SECRET_WORD_PATTERN =
  /(?:prompt|stack|trace|apikey|api[_-]?key|csrf|authorization|bearer|password|passwd|secret|private[_-]?key|access[_-]?token|token)/i;
const LONG_SECRET_PATTERN = /[A-Za-z0-9+/_-]{40,}/;

const GENERIC_ERROR_MESSAGE = '服务器内部错误，请查看事件或核验当前状态';
const UNAVAILABLE_MESSAGE = '服务暂不可用，请查看事件或稍后重试';
const FALLBACK_MESSAGES = new Map([
  [400, '请求无效，请检查提交内容'],
  [403, '请求被拒绝'],
  [404, '资源不存在'],
  [405, '方法不允许'],
  [409, '请求与当前状态冲突'],
  [413, '请求体超过上限'],
]);

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = status;
    this.code = code;
    this.details = details;
  }
}

function normalizeListenHost(host) {
  const value = host === undefined || host === null ? DEFAULT_HOST : String(host).trim();
  if (!LOOPBACK_HOSTS.has(value)) {
    throw new Error(`HTTP 服务只允许绑定 loopback 地址，收到 host=${value || '(空)'}`);
  }
  if (value === 'localhost') return '127.0.0.1';
  if (value === '[::1]') return '::1';
  return value;
}

function formatHostForUrl(host) {
  return host.includes(':') ? `[${host}]` : host;
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, 'invalid_path', '路径参数不是有效的 URI 编码');
  }
}

function apiSegments(pathname) {
  return pathname
    .split('/')
    .slice(1)
    .map((segment) => decodeSegment(segment));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function writeJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function safeMessageText(message, token) {
  if (typeof message !== 'string') return null;
  const value = message.trim();
  if (!value || value.length > MAX_ERROR_MESSAGE_CHARS) return null;
  if (CONTROL_CHAR_PATTERN.test(value)) return null;
  if (token && value.includes(token)) return null;
  if (SECRET_WORD_PATTERN.test(value)) return null;
  if (LONG_SECRET_PATTERN.test(value)) return null;
  return value;
}

function sanitizeErrorCode(code, status, token) {
  if (
    typeof code === 'string' &&
    ERROR_CODE_PATTERN.test(code) &&
    !(token && code.includes(token))
  ) {
    return code;
  }
  return WRITE_CODE_BY_STATUS.get(status) || (status >= 500 ? 'internal_error' : 'invalid_request');
}

function sanitizeCurrentRev(value, token) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || text.length > MAX_DETAIL_TEXT_CHARS) return undefined;
  if (CONTROL_CHAR_PATTERN.test(text)) return undefined;
  if (token && text.includes(token)) return undefined;
  if (SECRET_WORD_PATTERN.test(text)) return undefined;
  return text;
}

function sanitizeAllowed(value) {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const allowed = value.slice(0, MAX_ALLOWED_ITEMS);
  if (!allowed.every((item) => typeof item === 'string' && ALLOWED_METHOD_PATTERN.test(item))) {
    return undefined;
  }
  return allowed;
}

function sanitizeReasons(value, token) {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const reasons = [];
  for (const item of value.slice(0, MAX_DETAIL_ITEMS)) {
    if (typeof item !== 'string') return undefined;
    const text = item.trim();
    if (!text || text.length > MAX_DETAIL_TEXT_CHARS) return undefined;
    if (CONTROL_CHAR_PATTERN.test(text)) return undefined;
    if (token && text.includes(token)) return undefined;
    if (SECRET_WORD_PATTERN.test(text)) return undefined;
    if (LONG_SECRET_PATTERN.test(text)) return undefined;
    reasons.push(text);
  }
  return reasons;
}

function sanitizeDetails(details, token) {
  if (!isPlainObject(details)) return undefined;
  const safe = {};
  for (const key of Object.keys(details)) {
    if (!ALLOWED_DETAIL_KEYS.has(key)) continue;
    if (key === 'currentRev') {
      const currentRev = sanitizeCurrentRev(details[key], token);
      if (currentRev !== undefined) safe.currentRev = currentRev;
    } else if (key === 'allowed') {
      const allowed = sanitizeAllowed(details[key]);
      if (allowed !== undefined) safe.allowed = allowed;
    } else if (key === 'reasons') {
      const reasons = sanitizeReasons(details[key], token);
      if (reasons !== undefined) safe.reasons = reasons;
    }
  }
  return Object.keys(safe).length ? safe : undefined;
}

function writeError(res, error, { token = '', headers = {} } = {}) {
  const status =
    Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
      ? error.statusCode
      : 500;
  const responseHeaders = { ...headers };

  if (status >= 500) {
    // 未知 5xx 不输出异常文本；503 只保留经验证安全的环境原因。
    if (status === 503) {
      const message = safeMessageText(error?.message, token) || UNAVAILABLE_MESSAGE;
      writeJson(res, status, { error: { code: 'unavailable', message } }, responseHeaders);
    } else {
      writeJson(
        res,
        status,
        { error: { code: 'internal_error', message: GENERIC_ERROR_MESSAGE } },
        responseHeaders,
      );
    }
    return status;
  }

  const message =
    safeMessageText(error?.message, token) || FALLBACK_MESSAGES.get(status) || '请求失败';
  const code = sanitizeErrorCode(error?.code, status, token);
  const payload = { error: { code, message } };
  const details = sanitizeDetails(error?.details, token);
  if (details) {
    payload.error.details = details;
    if (code === 'method_not_allowed' && Array.isArray(details.allowed)) {
      responseHeaders.Allow = details.allowed.join(', ');
    }
  }
  writeJson(res, status, payload, responseHeaders);
  return status;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let tooLarge = false;
    let settled = false;

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (!tooLarge && size > MAX_BODY_BYTES) tooLarge = true;
      if (tooLarge) {
        if (size > HARD_BODY_LIMIT) {
          req.pause();
          const error = new HttpError(413, 'payload_too_large', '请求体超过 1 MiB 上限');
          error.destroyRequest = true;
          settle(reject, error);
        }
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (tooLarge) {
        settle(reject, new HttpError(413, 'payload_too_large', '请求体超过 1 MiB 上限'));
        return;
      }
      settle(resolve, Buffer.concat(chunks));
    };
    const onError = (error) => settle(reject, error);
    const onAborted = () =>
      settle(reject, new HttpError(400, 'request_aborted', '请求在读取完成前中止'));

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

async function readJsonBody(req) {
  const rawType = req.headers['content-type'];
  const contentType = Array.isArray(rawType) ? rawType[0] : rawType || '';
  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (mime !== 'application/json') {
    throw new HttpError(
      400,
      'invalid_content_type',
      '写请求必须使用 Content-Type: application/json',
    );
  }
  const buffer = await readRequestBody(req);
  if (!buffer.length) return {};
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', '请求体不是有效的 JSON');
  }
  if (!isPlainObject(parsed)) {
    throw new HttpError(400, 'invalid_body', '请求体必须是 JSON 对象');
  }
  return parsed;
}

function requireString(body, key, { nullable = false, allowEmpty = false } = {}) {
  if (!hasOwn(body, key)) {
    throw new HttpError(400, 'invalid_body', `缺少字段 ${key}`);
  }
  const value = body[key];
  if (nullable && value === null) return null;
  if (typeof value !== 'string') {
    throw new HttpError(400, 'invalid_body', `字段 ${key} 必须是字符串`);
  }
  if (!allowEmpty && value.trim() === '') {
    throw new HttpError(400, 'invalid_body', `字段 ${key} 不能为空`);
  }
  return value;
}

function requireEnum(body, key, allowed) {
  const value = requireString(body, key);
  if (!allowed.includes(value)) {
    throw new HttpError(400, 'invalid_body', `字段 ${key} 只能是 ${allowed.join('、')}`);
  }
  return value;
}

function tokenMatches(expected, received) {
  if (typeof received !== 'string' || received.length === 0) return false;
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(received, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function staticMimeType(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
}

function resolveStaticTarget(publicReal, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'invalid_path', '静态路径不是有效的 URI 编码');
  }
  if (decoded.includes('\0')) throw new HttpError(400, 'invalid_path', '静态路径包含非法字符');
  if (decoded.includes('\\')) throw new HttpError(400, 'invalid_path', '静态路径包含非法分隔符');
  const segments = decoded.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new HttpError(400, 'invalid_path', '静态路径不允许包含 ..');
  }
  let relative = decoded;
  if (relative.endsWith('/')) relative += 'index.html';
  if (relative === '') relative = 'index.html';
  if (!relative.startsWith('/')) relative = `/${relative}`;
  const target = path.resolve(publicReal, `.${relative}`);
  if (target !== publicReal && !target.startsWith(`${publicReal}${path.sep}`)) {
    throw new HttpError(400, 'invalid_path', '静态路径越出允许目录');
  }
  return target;
}

async function serveStatic(req, res, publicReal, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    writeJson(
      res,
      405,
      { error: { code: 'method_not_allowed', message: '静态资源只支持 GET/HEAD' } },
      { Allow: 'GET, HEAD' },
    );
    return;
  }

  const target = resolveStaticTarget(publicReal, pathname);
  let realTarget;
  try {
    realTarget = await realpath(target);
  } catch {
    throw new HttpError(404, 'not_found', '静态资源不存在');
  }
  if (realTarget !== publicReal && !realTarget.startsWith(`${publicReal}${path.sep}`)) {
    throw new HttpError(404, 'not_found', '静态资源不存在');
  }
  const info = await stat(realTarget);
  if (!info.isFile()) throw new HttpError(404, 'not_found', '静态资源不存在');

  res.writeHead(200, {
    'Content-Type': staticMimeType(realTarget),
    'Content-Length': info.size,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const stream = createReadStream(realTarget);
    stream.on('error', reject);
    stream.on('end', resolve);
    stream.pipe(res);
  });
}

function mergePayload(body) {
  const expectedHeadSha = requireString(body, 'expectedHeadSha');
  if (body.confirmed !== true) {
    throw new HttpError(400, 'invalid_body', 'merge 需要 confirmed=true');
  }
  const method = requireEnum(body, 'method', ['merge', 'squash', 'rebase']);
  return { expectedHeadSha, confirmed: true, method };
}

async function dispatchApi(req, res, runtime, token, segments, url) {
  const method = req.method || 'GET';
  const notFound = () => {
    throw new HttpError(404, 'not_found', '未知接口');
  };
  const methodNotAllowed = (allowed) => {
    throw new HttpError(405, 'method_not_allowed', `该接口只允许 ${allowed.join('、')}`, {
      allowed,
    });
  };
  const ensureMethod = (allowed) => {
    if (!allowed.includes(method)) methodNotAllowed(allowed);
  };
  const isWrite = method === 'PUT' || method === 'POST' || method === 'PATCH' || method === 'DELETE';

  const [root, ...rest] = segments;
  if (root !== 'api') return false;

  // 路由表：先确定路径是否存在，再核对方法，避免未知路由被当成 405。
  let route = null;
  if (rest.length === 1 && rest[0] === 'state') {
    route = { allowed: ['GET'], handle: async () => ({ ...(await runtime.getState()), csrfToken: token }) };
  } else if (rest.length === 1 && rest[0] === 'settings') {
    route = {
      allowed: ['PUT'],
      handle: async () => {
        const body = await readJsonBody(req);
        return { settings: await runtime.saveSettings(body) };
      },
    };
  } else if (rest.length === 1 && rest[0] === 'collect') {
    route = {
      allowed: ['POST'],
      handle: async () => {
        await readJsonBody(req);
        return runtime.collect();
      },
    };
  } else if (rest.length === 2 && rest[0] === 'runtime' && rest[1] === 'watch') {
    route = {
      allowed: ['POST'],
      handle: async () => {
        const body = await readJsonBody(req);
        if (typeof body.enabled !== 'boolean') {
          throw new HttpError(400, 'invalid_body', '字段 enabled 必须是布尔值');
        }
        const intervalSeconds = body.intervalSeconds;
        return runtime.setWatch({ enabled: body.enabled, intervalSeconds });
      },
    };
  } else if (
    rest.length === 3 &&
    rest[0] === 'candidates' &&
    rest[2] === 'draft'
  ) {
    const id = rest[1];
    route = {
      allowed: ['POST', 'PUT'],
      handle: async () => {
        if (method === 'POST') {
          await readJsonBody(req);
          return runtime.requestDraft(id);
        }
        const body = await readJsonBody(req);
        // rev 是必需 CAS 字段，首次必须是显式 null；不接受缺省。
        if (!hasOwn(body, 'rev')) {
          throw new HttpError(400, 'invalid_body', '保存任务稿需要显式传入 rev（首次为 null）');
        }
        const rev = requireString(body, 'rev', { nullable: true });
        const input = { ...body, rev };
        delete input.actor;
        return runtime.saveDraft(id, input);
      },
    };
  } else if (rest.length === 3 && rest[0] === 'candidates' && rest[2] === 'decision') {
    const id = rest[1];
    route = {
      allowed: ['POST'],
      handle: async () => {
        const body = await readJsonBody(req);
        const action = requireEnum(body, 'action', ['develop', 'defer', 'ignore']);
        const input = { action, actor: 'user' };
        if (hasOwn(body, 'draftRev') && body.draftRev !== null && body.draftRev !== undefined) {
          input.draftRev = requireString(body, 'draftRev');
        }
        if (action === 'develop' && !input.draftRev) {
          throw new HttpError(400, 'invalid_body', 'develop 决定需要 draftRev（当前已保存任务稿版本）');
        }
        // 角色只能由服务端固定，忽略任何 body 提权字段。
        return runtime.decide(id, input);
      },
    };
  } else if (rest.length === 3 && rest[0] === 'candidates' && rest[2] === 'auto-repair') {
    const id = rest[1];
    route = {
      allowed: ['PUT'],
      handle: async () => {
        const body = await readJsonBody(req);
        if (!isPlainObject(body)) {
          throw new HttpError(400, 'invalid_body', '自动返修设置必须是 JSON 对象');
        }
        if (typeof body.enabled !== 'boolean') {
          throw new HttpError(400, 'invalid_body', '字段 enabled 必须是布尔值');
        }
        // 只接受用户可控的开关和当前稿版本；actor/limit/used/pending 等预算与
        // 审计字段只由服务端持久化维护，客户端传入的值一律忽略。
        const input = { enabled: body.enabled };
        if (body.enabled) {
          input.draftRev = requireString(body, 'draftRev');
        }
        const autoRepair = await runtime.setAutoRepair(id, input);
        return { candidateId: id, autoRepair };
      },
    };
  } else if (rest.length === 3 && rest[0] === 'candidates' && rest[2] === 'retry') {
    const id = rest[1];
    route = {
      allowed: ['POST'],
      handle: async () => {
        await readJsonBody(req);
        return runtime.retry(id);
      },
    };
  } else if (rest.length === 3 && rest[0] === 'runs' && rest[2] === 'cancel') {
    const id = rest[1];
    route = {
      allowed: ['POST'],
      handle: async () => {
        await readJsonBody(req);
        return runtime.cancelRun(id);
      },
    };
  } else if (rest.length === 3 && rest[0] === 'candidates' && rest[2] === 'acceptance') {
    const id = rest[1];
    route = {
      allowed: ['POST'],
      handle: async () => {
        const body = await readJsonBody(req);
        const role = requireEnum(body, 'role', ['user', 'design']);
        const verdict = requireEnum(body, 'verdict', ['approved', 'changes_requested']);
        const headSha = requireString(body, 'headSha');
        const comment = hasOwn(body, 'comment')
          ? requireString(body, 'comment', { allowEmpty: role === 'user' })
          : '';
        return runtime.recordAcceptance(id, { role, verdict, headSha, comment });
      },
    };
  } else if (rest.length === 3 && rest[0] === 'candidates' && rest[2] === 'merge') {
    const id = rest[1];
    route = {
      allowed: ['POST'],
      handle: async () => {
        const body = await readJsonBody(req);
        return runtime.merge(id, mergePayload(body));
      },
    };
  }

  if (!route) notFound();
  ensureMethod(route.allowed);

  if (isWrite) {
    const received = req.headers['x-auto-ai-token'];
    const headerValue = Array.isArray(received) ? received[0] : received;
    if (!tokenMatches(token, headerValue)) {
      throw new HttpError(403, 'invalid_token', '写请求缺少或携带了无效的本地会话令牌');
    }
  }

  const payload = await route.handle();
  writeJson(res, 200, payload === undefined ? {} : payload);
  return true;
}

export async function createHttpServer({
  runtime,
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  publicDir,
} = {}) {
  if (!runtime || typeof runtime !== 'object') {
    throw new Error('createHttpServer 需要注入 runtime');
  }
  const listenHost = normalizeListenHost(host);
  const publicReal = await realpath(publicDir ? path.resolve(publicDir) : DEFAULT_PUBLIC_DIR);
  const publicInfo = await stat(publicReal);
  if (!publicInfo.isDirectory()) {
    throw new Error(`publicDir 不是目录：${publicReal}`);
  }

  await runtime.start();
  const token = randomBytes(32).toString('hex');

  let actualHost = formatHostForUrl(listenHost);
  let actualPort = Number(port) || DEFAULT_PORT;
  let allowedHosts = new Set();
  let allowedOrigins = new Set();

  const computeAllowed = () => {
    const hosts = new Set([
      `${actualHost}:${actualPort}`,
      `127.0.0.1:${actualPort}`,
      `localhost:${actualPort}`,
      `[::1]:${actualPort}`,
    ]);
    allowedHosts = new Set([...hosts].map((value) => value.toLowerCase()));
    allowedOrigins = new Set([...allowedHosts].map((value) => `http://${value}`));
  };
  computeAllowed();

  const handler = async (req, res) => {
    try {
      const hostHeader = req.headers.host;
      const hostValue = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
      if (!hostValue || !allowedHosts.has(hostValue.toLowerCase())) {
        throw new HttpError(403, 'invalid_host', 'Host 不是本工作台的 loopback 地址');
      }
      const originHeader = req.headers.origin;
      const originValue = Array.isArray(originHeader) ? originHeader[0] : originHeader;
      if (originValue !== undefined && !allowedOrigins.has(originValue.toLowerCase())) {
        throw new HttpError(403, 'invalid_origin', 'Origin 与本工作台不一致');
      }

      let url;
      try {
        url = new URL(req.url || '/', `http://${actualHost}:${actualPort}`);
      } catch {
        throw new HttpError(400, 'invalid_path', '请求 URL 无效');
      }
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        const handled = await dispatchApi(req, res, runtime, token, apiSegments(url.pathname), url);
        if (!handled) throw new HttpError(404, 'not_found', '未知接口');
        return;
      }
      await serveStatic(req, res, publicReal, url.pathname);
    } catch (error) {
      writeError(res, error, { token });
      if (error?.destroyRequest) {
        res.once('finish', () => req.destroy());
      }
    }
  };

  const server = http.createServer((req, res) => {
    handler(req, res).catch((error) => {
      if (!res.headersSent) writeError(res, error, { token });
      else res.destroy();
    });
  });

  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(Number(port) || DEFAULT_PORT, listenHost);
    });
  } catch (error) {
    await runtime.close().catch(() => {});
    throw error;
  }

  const address = server.address();
  if (address && typeof address === 'object') {
    actualHost = formatHostForUrl(address.address);
    actualPort = address.port;
    computeAllowed();
  }
  const url = `http://${actualHost}:${actualPort}/`;

  let closing = null;
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      server.closeIdleConnections?.();
      await new Promise((resolve) => {
        const timer = setTimeout(() => server.closeAllConnections?.(), 2000);
        timer.unref?.();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      await runtime.close();
    })();
    return closing;
  };

  return { server, url, close };
}

export { DEFAULT_HOST, DEFAULT_PORT, MAX_BODY_BYTES };
