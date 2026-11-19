import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { normalizeIssue } from './rules.mjs';

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ISSUE_STATES = new Set(['open', 'closed', 'all']);
const MERGE_METHODS = new Set(['merge', 'squash', 'rebase']);
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const MAX_BUFFER = 16 * 1024 * 1024;

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defaultRun(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: 'utf8', maxBuffer: MAX_BUFFER, ...options },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function redact(value) {
  return String(value ?? '')
    .replace(/https?:\/\/[^/\s@]+@/gi, 'https://<redacted>@')
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]+/g, '<redacted-token>')
    .replace(/\b(token|authorization|password)\s*[:=]\s*\S+/gi, '$1=<redacted>');
}

function describeFailure(action, error) {
  const detail = redact(error?.stderr || error?.message || '未知错误')
    .trim()
    .split('\n')
    .slice(0, 6)
    .join('\n');
  return `${action} 失败${detail.length > 0 ? `：${detail}` : ''}`;
}

function requireTrimmedString(value, name, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') {
    throw new Error(`${name} 必须是字符串`);
  }
  const normalized = value.trim();
  if (!allowEmpty && normalized.length === 0) {
    throw new Error(`${name} 不能为空`);
  }
  return normalized;
}

function requireRepo(repo) {
  const normalized = requireTrimmedString(repo, 'repo');
  if (!REPO_PATTERN.test(normalized)) {
    throw new Error('repo 必须使用 owner/repo 格式');
  }
  return normalized;
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} 必须是正整数`);
  }
  return value;
}

function requireBranch(branch, name = 'branch') {
  const normalized = requireTrimmedString(branch, name);
  if (
    normalized.startsWith('-') ||
    normalized.startsWith('/') ||
    normalized.endsWith('/') ||
    normalized.endsWith('.') ||
    normalized.endsWith('.lock') ||
    normalized.includes('..') ||
    normalized.includes('//') ||
    normalized.includes('@{') ||
    normalized.includes('\\') ||
    !/^[A-Za-z0-9._/-]+$/.test(normalized)
  ) {
    throw new Error(`${name} 不是有效的 Git 分支名`);
  }
  return normalized;
}

function parseJson(text, action) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error(`${action} 未返回 JSON`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${action} 返回的 JSON 无法解析：${redact(error.message)}`);
  }
}

function normalizeCheckRollup(rollup) {
  if (!Array.isArray(rollup)) {
    return [];
  }
  return rollup.map((entry) => {
    if (!isObject(entry)) {
      return { name: 'unknown', state: 'unknown' };
    }
    let name = 'unknown';
    if (typeof entry.name === 'string' && entry.name.length > 0) {
      name = entry.name;
    } else if (typeof entry.context === 'string' && entry.context.length > 0) {
      name = entry.context;
    }
    let state = entry.conclusion;
    if (state === undefined || state === null || state === '') {
      state = entry.state;
    }
    if (state === undefined || state === null || state === '') {
      state = entry.status;
    }
    if (typeof state !== 'string' || state.length === 0) {
      state = 'unknown';
    }
    return { name, state };
  });
}

function normalizeMergeSha(mergeCommit) {
  if (!isObject(mergeCommit) || typeof mergeCommit.oid !== 'string') {
    return null;
  }
  const oid = mergeCommit.oid.trim();
  return COMMIT_PATTERN.test(oid) ? oid : null;
}

function normalizeRawIssue(raw, repo) {
  if (!isObject(raw)) {
    throw new Error('GitHub Issue 条目不是对象');
  }
  if (!Number.isSafeInteger(raw.number) || raw.number < 1) {
    throw new Error('GitHub Issue 缺少有效 number');
  }
  if (typeof raw.title !== 'string') {
    throw new Error(`GitHub Issue #${raw.number} 缺少 title`);
  }
  const author =
    isObject(raw.user) && typeof raw.user.login === 'string' && raw.user.login.length > 0
      ? raw.user.login
      : 'ghost';
  const labels = Array.isArray(raw.labels)
    ? raw.labels
        .map((label) => {
          if (typeof label === 'string') {
            return label;
          }
          if (isObject(label) && typeof label.name === 'string') {
            return label.name;
          }
          return '';
        })
        .filter((label) => label.length > 0)
    : [];

  return normalizeIssue({
    repo,
    number: raw.number,
    title: raw.title,
    body: typeof raw.body === 'string' ? raw.body : '',
    state: typeof raw.state === 'string' ? raw.state : '',
    author,
    labels,
    updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : '',
    url: typeof raw.html_url === 'string' ? raw.html_url : '',
    isPullRequest: isObject(raw.pull_request),
  });
}

export class GitHubAdapter {
  #command;
  #run;

  constructor({ command = 'gh', run } = {}) {
    if (typeof command !== 'string' || command.trim().length === 0) {
      throw new Error('command 必须是非空字符串');
    }
    if (run !== undefined && typeof run !== 'function') {
      throw new Error('run 必须是函数');
    }
    this.#command = command.trim();
    this.#run = run ?? defaultRun;
  }

  async #gh(args, action) {
    try {
      return await this.#run(this.#command, args, { maxBuffer: MAX_BUFFER });
    } catch (error) {
      throw new Error(describeFailure(action, error));
    }
  }

  async checkReady() {
    try {
      await this.#gh(['auth', 'status'], 'gh 认证检查');
      return { ready: true, reason: 'gh 已通过认证检查' };
    } catch (error) {
      return {
        ready: false,
        reason: redact(error.message || 'gh 认证检查失败'),
      };
    }
  }

  async collectIssues(repo, { state = 'all' } = {}) {
    const targetRepo = requireRepo(repo);
    if (typeof state !== 'string' || !ISSUE_STATES.has(state)) {
      throw new Error('state 只能是 open、closed 或 all');
    }

    const { stdout } = await this.#gh(
      [
        'api',
        '--paginate',
        '--slurp',
        '-H',
        'Accept: application/vnd.github+json',
        `repos/${targetRepo}/issues?state=${state}&per_page=100`,
      ],
      `收集 ${targetRepo} 的 Issue`,
    );

    const parsed = parseJson(stdout, `收集 ${targetRepo} 的 Issue`);
    if (!Array.isArray(parsed)) {
      throw new Error(`收集 ${targetRepo} 的 Issue 返回结构不是数组`);
    }
    const rawIssues = parsed.every((page) => Array.isArray(page))
      ? parsed.flat()
      : parsed;

    return rawIssues.map((raw) => normalizeRawIssue(raw, targetRepo));
  }

  async readIssue({ repo, number } = {}) {
    const targetRepo = requireRepo(repo);
    const issueNumber = requirePositiveInteger(number, 'number');

    const { stdout } = await this.#gh(
      [
        'api',
        '-H',
        'Accept: application/vnd.github+json',
        `repos/${targetRepo}/issues/${issueNumber}`,
      ],
      `读取 ${targetRepo} 的 Issue #${issueNumber}`,
    );
    const raw = parseJson(stdout, `读取 ${targetRepo} 的 Issue #${issueNumber}`);
    return normalizeRawIssue(raw, targetRepo);
  }

  async #listOpenPullRequests(repo, branch, baseBranch) {
    const { stdout } = await this.#gh(
      [
        'pr',
        'list',
        '--repo',
        repo,
        '--head',
        branch,
        '--base',
        baseBranch,
        '--state',
        'open',
        '--limit',
        '100',
        '--json',
        'number,url,headRefOid,headRefName,isCrossRepository',
      ],
      `查询 ${repo} 的现有 Pull Request`,
    );
    const parsed = parseJson(stdout, `查询 ${repo} 的现有 Pull Request`);
    if (!Array.isArray(parsed)) {
      throw new Error('gh pr list 返回结构不是数组');
    }
    return parsed.filter(
      (entry) =>
        isObject(entry) &&
        entry.isCrossRepository !== true &&
        (entry.headRefName === undefined || entry.headRefName === branch),
    );
  }

  async createPullRequest({ repo, branch, baseBranch, title, body, worktreePath } = {}) {
    const targetRepo = requireRepo(repo);
    const headBranch = requireBranch(branch);
    const targetBase = requireBranch(baseBranch, 'baseBranch');
    const normalizedTitle = requireTrimmedString(title, 'title');
    if (body !== undefined && typeof body !== 'string') {
      throw new Error('body 必须是字符串');
    }
    if (worktreePath !== undefined && typeof worktreePath !== 'string') {
      throw new Error('worktreePath 必须是字符串');
    }

    const existing = await this.#listOpenPullRequests(targetRepo, headBranch, targetBase);
    if (existing.length > 0) {
      const found = existing[0];
      requirePositiveInteger(found.number, '已有 Pull Request number');
      return {
        repo: targetRepo,
        number: found.number,
        url: requireTrimmedString(found.url, '已有 Pull Request url'),
        headSha: requireTrimmedString(found.headRefOid, '已有 Pull Request headSha'),
      };
    }

    let tempDir;
    try {
      tempDir = await mkdtemp(path.join(tmpdir(), 'auto-ai-pr-'));
      const bodyFile = path.join(tempDir, 'body.md');
      await writeFile(bodyFile, body ?? '', 'utf8');

      try {
        await this.#gh(
          [
            'pr',
            'create',
            '--repo',
            targetRepo,
            '--head',
            headBranch,
            '--base',
            targetBase,
            '--title',
            normalizedTitle,
            '--body-file',
            bodyFile,
          ],
          `为 ${targetRepo} 创建 Pull Request`,
        );
      } catch (error) {
        const raced = await this.#listOpenPullRequests(targetRepo, headBranch, targetBase).catch(
          () => [],
        );
        if (raced.length > 0) {
          const found = raced[0];
          return {
            repo: targetRepo,
            number: requirePositiveInteger(found.number, '已有 Pull Request number'),
            url: requireTrimmedString(found.url, '已有 Pull Request url'),
            headSha: requireTrimmedString(found.headRefOid, '已有 Pull Request headSha'),
          };
        }
        throw error;
      }

      const { stdout } = await this.#gh(
        [
          'pr',
          'view',
          headBranch,
          '--repo',
          targetRepo,
          '--json',
          'number,url,headRefOid',
        ],
        `读取 ${targetRepo} 新建的 Pull Request`,
      );
      const created = parseJson(stdout, `读取 ${targetRepo} 新建的 Pull Request`);
      if (!isObject(created)) {
        throw new Error('新建 Pull Request 的读回结构不是对象');
      }
      return {
        repo: targetRepo,
        number: requirePositiveInteger(created.number, 'Pull Request number'),
        url: requireTrimmedString(created.url, 'Pull Request url'),
        headSha: requireTrimmedString(created.headRefOid, 'Pull Request headSha'),
      };
    } finally {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  }

  async readPullRequest({ repo, number } = {}) {
    const targetRepo = requireRepo(repo);
    const prNumber = requirePositiveInteger(number, 'number');

    const { stdout } = await this.#gh(
      [
        'pr',
        'view',
        String(prNumber),
        '--repo',
        targetRepo,
        '--json',
        'number,url,headRefOid,state,mergeable,statusCheckRollup,mergeCommit',
      ],
      `读取 ${targetRepo} 的 Pull Request #${prNumber}`,
    );
    const raw = parseJson(stdout, `读取 ${targetRepo} 的 Pull Request #${prNumber}`);
    if (!isObject(raw)) {
      throw new Error('Pull Request 读回结构不是对象');
    }

    return {
      repo: targetRepo,
      number: requirePositiveInteger(raw.number ?? prNumber, 'Pull Request number'),
      url: requireTrimmedString(raw.url, 'Pull Request url'),
      headSha: requireTrimmedString(raw.headRefOid, 'Pull Request headSha'),
      state: typeof raw.state === 'string' ? raw.state.toLowerCase() : 'unknown',
      mergeable:
        typeof raw.mergeable === 'string' && raw.mergeable.length > 0 ? raw.mergeable : 'UNKNOWN',
      checks: normalizeCheckRollup(raw.statusCheckRollup),
      mergeSha: normalizeMergeSha(raw.mergeCommit),
    };
  }

  async mergePullRequest({
    repo,
    number,
    expectedHeadSha,
    method,
    confirmed,
  } = {}) {
    const targetRepo = requireRepo(repo);
    const prNumber = requirePositiveInteger(number, 'number');
    const headSha = requireTrimmedString(expectedHeadSha, 'expectedHeadSha');
    if (!COMMIT_PATTERN.test(headSha)) {
      throw new Error('expectedHeadSha 必须是完整的 40 或 64 位十六进制提交 SHA');
    }
    if (confirmed !== true) {
      throw new Error('合并必须由调用方显式确认（confirmed=true）');
    }
    if (typeof method !== 'string' || !MERGE_METHODS.has(method)) {
      throw new Error('method 只能是 merge、squash 或 rebase');
    }

    const current = await this.readPullRequest({ repo: targetRepo, number: prNumber });
    if (current.state === 'merged') {
      if (current.headSha.toLowerCase() !== headSha.toLowerCase()) {
        throw new Error('Pull Request 已合并，但 head 与 expectedHeadSha 不一致，拒绝操作');
      }
      if (current.mergeSha === null) {
        return {
          merged: false,
          pending: true,
          state: 'merged',
          mergeSha: null,
          note: `Pull Request #${prNumber} 已为 MERGED，但未读回有效的 merge commit SHA，需只读核对`,
        };
      }
      return { merged: true, mergeSha: current.mergeSha, alreadyMerged: true };
    }
    if (current.state !== 'open') {
      throw new Error(`Pull Request #${prNumber} 当前状态为 ${current.state}，不能合并`);
    }
    if (current.headSha.toLowerCase() !== headSha.toLowerCase()) {
      throw new Error('Pull Request 当前 head 与 expectedHeadSha 不一致，拒绝合并');
    }

    await this.#gh(
      [
        'pr',
        'merge',
        String(prNumber),
        '--repo',
        targetRepo,
        `--${method}`,
        '--match-head-commit',
        headSha,
      ],
      `合并 ${targetRepo} 的 Pull Request #${prNumber}`,
    );

    const readbackAction = `读回 ${targetRepo} 的 Pull Request #${prNumber} 合并结果`;
    let raw;
    try {
      const { stdout } = await this.#gh(
        [
          'pr',
          'view',
          String(prNumber),
          '--repo',
          targetRepo,
          '--json',
          'mergeCommit,state',
        ],
        readbackAction,
      );
      raw = parseJson(stdout, readbackAction);
    } catch (error) {
      return {
        merged: false,
        pending: true,
        state: 'unknown',
        mergeSha: null,
        note: `合并命令已发出，但未能读回实际合并状态，需只读核对：${redact(error.message)}`,
      };
    }

    const state = isObject(raw) && typeof raw.state === 'string' ? raw.state.toLowerCase() : 'unknown';
    const mergeSha = normalizeMergeSha(isObject(raw) ? raw.mergeCommit : null);
    if (state === 'merged' && mergeSha !== null) {
      return { merged: true, mergeSha };
    }
    return {
      merged: false,
      pending: true,
      state,
      mergeSha: null,
      note:
        state === 'merged'
          ? `合并命令已发出且状态为 MERGED，但未读回有效的 merge commit SHA，需只读核对`
          : `合并命令已发出，但读回状态为 ${state}（未确认 MERGED），未记为合并完成，需只读核对`,
    };
  }
}

export { defaultRun as defaultGitHubRunner };
