import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const MAX_BUFFER = 16 * 1024 * 1024;
const MAX_CHANGED_PATHS = 2000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
// Verification commands must never reach the remote or write objects: a partial
// clone would otherwise lazily fetch a missing commit and silently change what
// "local objects" means. GIT_ALLOW_PROTOCOL denies every transport (Git 2.39
// still starts the lazy fetch helper, which then refuses at protocol choice),
// while GIT_NO_LAZY_FETCH disables fetching earlier on newer Git versions.
const LOCAL_OBJECTS_ONLY_GIT_ENV = Object.freeze({
  GIT_ALLOW_PROTOCOL: '',
  GIT_NO_LAZY_FETCH: '1',
  GIT_TERMINAL_PROMPT: '0',
});

function localObjectsOnlyRunOptions() {
  return {
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, ...LOCAL_OBJECTS_ONLY_GIT_ENV },
  };
}

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
    .slice(0, 8)
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

function requireRunId(runId) {
  const normalized = requireTrimmedString(runId, 'runId');
  if (
    !RUN_ID_PATTERN.test(normalized) ||
    normalized.includes('..') ||
    normalized.endsWith('.lock')
  ) {
    throw new Error('runId 只能包含安全字符（字母、数字、点、下划线、连字符），且不能包含 ..');
  }
  return normalized;
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

function requireRef(ref) {
  const normalized = requireTrimmedString(ref, 'baseRef');
  if (
    normalized.length > 256 ||
    normalized.startsWith('-') ||
    /[\s\0]/.test(normalized)
  ) {
    throw new Error('baseRef 不是有效的 Git 引用');
  }
  return normalized;
}

function requireAbsolutePath(value, name) {
  const normalized = requireTrimmedString(value, name);
  if (!path.isAbsolute(normalized)) {
    throw new Error(`${name} 必须是绝对路径`);
  }
  return path.resolve(normalized);
}

function requireCommit(value, name) {
  const normalized = requireTrimmedString(value, name);
  if (!COMMIT_PATTERN.test(normalized)) {
    throw new Error(`${name} 必须是完整的 40 或 64 位十六进制提交 SHA`);
  }
  return normalized;
}

function repoFromRemote(url) {
  if (typeof url !== 'string') {
    return null;
  }
  let value = url.trim();
  if (value.length === 0) {
    return null;
  }
  if (value.startsWith('file://')) {
    try {
      value = new URL(value).pathname;
    } catch {
      value = value.slice('file://'.length);
    }
  } else if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    try {
      value = new URL(value).pathname;
    } catch {
      return null;
    }
  } else if (
    !value.startsWith('/') &&
    !value.startsWith('./') &&
    !value.startsWith('../')
  ) {
    const scpLike = /^(?:[^@/]+@)?[^/:]+:(.+)$/.exec(value);
    if (scpLike) {
      value = scpLike[1];
    }
  }
  value = value.replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (value.endsWith('.git')) {
    value = value.slice(0, -4);
  }
  const segments = value.split('/').filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return null;
  }
  const repo = segments.slice(-2).join('/');
  if (!REPO_PATTERN.test(repo)) {
    return null;
  }
  return repo.toLowerCase();
}

function normalizeWriteScopes(writeScopes) {
  if (!Array.isArray(writeScopes) || writeScopes.length === 0) {
    throw new Error('writeScopes 必须是非空字符串数组');
  }
  const scopes = new Set();
  for (let index = 0; index < writeScopes.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(writeScopes, index)) {
      throw new Error(`writeScopes[${index}] 必须是字符串`);
    }
    const raw = requireTrimmedString(writeScopes[index], `writeScopes[${index}]`);
    if (raw === '*') {
      scopes.add('*');
      continue;
    }
    if (raw.includes('\\') || raw.includes('\0')) {
      throw new Error(`writeScopes[${index}] 必须使用规范正斜杠相对路径`);
    }
    if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) {
      throw new Error(`writeScopes[${index}] 必须是仓库内相对路径`);
    }
    const segments = raw.split('/').filter((segment) => segment !== '' && segment !== '.');
    if (segments.length === 0 || segments.includes('..')) {
      throw new Error(`writeScopes[${index}] 不能是仓库根路径或越界路径`);
    }
    scopes.add(segments.join('/'));
  }
  if (scopes.has('*')) {
    return ['*'];
  }
  return [...scopes].sort();
}

function pathMatchesScopes(filePath, scopes) {
  if (scopes.includes('*')) {
    return true;
  }
  return scopes.some(
    (scope) => filePath === scope || filePath.startsWith(`${scope}/`),
  );
}

function parseStatusPaths(stdout) {
  const paths = new Set();
  const fields = stdout.split('\0');
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (!record) {
      continue;
    }
    const status = record.slice(0, 2);
    const filePath = record.slice(3);
    if (filePath.length > 0) {
      paths.add(filePath);
    }
    if (status.includes('R') || status.includes('C')) {
      const originalPath = fields[index + 1];
      if (originalPath) {
        paths.add(originalPath);
        index += 1;
      }
    }
  }
  return [...paths].sort();
}

function parseLsRemote(stdout) {
  const line = String(stdout ?? '')
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  if (!line) {
    return null;
  }
  const [sha] = line.split(/\s+/);
  return COMMIT_PATTERN.test(sha) ? sha : null;
}

export class WorkspaceAdapter {
  #rootDir;
  #run;

  constructor({ rootDir, run } = {}) {
    this.#rootDir = requireAbsolutePath(rootDir, 'rootDir');
    if (run !== undefined && typeof run !== 'function') {
      throw new Error('run 必须是函数');
    }
    this.#run = run ?? defaultRun;
  }

  get #manifestsDir() {
    return path.join(this.#rootDir, 'manifests');
  }

  get #worktreesDir() {
    return path.join(this.#rootDir, 'worktrees');
  }

  async #git(repoPath, args, action, { localOnly = false } = {}) {
    try {
      const options = localOnly ? localObjectsOnlyRunOptions() : { maxBuffer: MAX_BUFFER };
      return await this.#run('git', ['-C', repoPath, ...args], options);
    } catch (error) {
      throw new Error(describeFailure(action, error));
    }
  }

  async #tryGit(repoPath, args) {
    try {
      return await this.#run('git', ['-C', repoPath, ...args], { maxBuffer: MAX_BUFFER });
    } catch {
      return null;
    }
  }

  /**
   * Runs a read-only Git command with lazy fetching disabled and returns its
   * exit status instead of throwing on a non-zero one. Only a missing process
   * exit status is treated as an unexpected error.
   */
  async #localGitStatus(repoPath, args, action) {
    try {
      const result = await this.#run('git', ['-C', repoPath, ...args], localObjectsOnlyRunOptions());
      return { status: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      if (!Number.isInteger(error?.code)) {
        throw new Error(describeFailure(action, error));
      }
      return { status: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
  }

  async #safeRealpath(value) {
    try {
      return await realpath(value);
    } catch {
      return path.resolve(value);
    }
  }

  async #assertSourceIdentity(repo, localPath) {
    const localReal = await this.#safeRealpath(localPath);
    const topResult = await this.#git(
      localReal,
      ['rev-parse', '--show-toplevel'],
      `读取 ${localPath} 的 Git 根目录`,
    );
    const topReal = await this.#safeRealpath(topResult.stdout.trim());
    if (topReal !== localReal) {
      throw new Error(`localPath 必须是 Git 仓库根目录：${localPath}`);
    }

    const urls = [
      {
        label: 'fetch',
        args: ['remote', 'get-url', 'origin'],
      },
      {
        label: 'push',
        args: ['remote', 'get-url', '--push', 'origin'],
      },
    ];
    for (const { label, args } of urls) {
      const result = await this.#git(
        localReal,
        args,
        `读取 ${localPath} 的 origin ${label} 地址`,
      );
      const remoteRepo = repoFromRemote(result.stdout.trim());
      if (!remoteRepo) {
        throw new Error(
          `无法从 origin ${label} 地址识别仓库身份，拒绝在身份不明时创建工作树`,
        );
      }
      if (remoteRepo !== repo.toLowerCase()) {
        throw new Error(
          `origin ${label} 地址指向 ${remoteRepo}，与请求的 ${repo} 不一致，拒绝串仓`,
        );
      }
    }
    return localReal;
  }

  async #resolveBase({ localPath, baseRef, baseBranch }) {
    const ref = requireRef(baseRef);
    const result = await this.#git(
      localPath,
      ['rev-parse', '--verify', `${ref}^{commit}`],
      `解析 baseRef ${ref}`,
    );
    const baseCommit = requireCommit(result.stdout.trim(), 'baseCommit');

    let branch;
    if (baseBranch !== undefined) {
      branch = requireBranch(baseBranch, 'baseBranch');
    } else {
      branch = await this.#deriveBaseBranch(localPath, ref);
    }

    const localBranch = await this.#tryGit(localPath, [
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ]);
    const remoteBranch = localBranch
      ? localBranch
      : await this.#tryGit(localPath, [
          'show-ref',
          '--verify',
          '--quiet',
          `refs/remotes/origin/${branch}`,
        ]);
    if (!localBranch && !remoteBranch) {
      throw new Error(`baseBranch ${branch} 在本地和 origin 上都不存在，拒绝猜测 PR 基线`);
    }

    return { baseCommit, baseBranch: branch };
  }

  async #deriveBaseBranch(localPath, ref) {
    let candidate = null;
    if (ref.startsWith('refs/heads/')) {
      candidate = ref.slice('refs/heads/'.length);
    } else if (ref.startsWith('refs/remotes/')) {
      const rest = ref.slice('refs/remotes/'.length);
      const splitAt = rest.indexOf('/');
      if (splitAt > 0) {
        candidate = rest.slice(splitAt + 1);
      }
    } else if (ref.startsWith('origin/')) {
      candidate = ref.slice('origin/'.length);
    } else if (ref === 'HEAD' || ref === '@') {
      const symbolic = await this.#tryGit(localPath, [
        'symbolic-ref',
        '--quiet',
        '--short',
        'HEAD',
      ]);
      if (!symbolic || symbolic.stdout.trim().length === 0) {
        throw new Error('源仓库当前为 detached HEAD，必须显式提供可用于 PR 的 baseBranch');
      }
      candidate = symbolic.stdout.trim();
    }

    if (candidate !== null) {
      return requireBranch(candidate, 'baseBranch');
    }

    const localBranch = await this.#tryGit(localPath, [
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${ref}`,
    ]);
    if (localBranch) {
      return requireBranch(ref, 'baseBranch');
    }
    const remoteBranch = await this.#tryGit(localPath, [
      'show-ref',
      '--verify',
      '--quiet',
      `refs/remotes/origin/${ref}`,
    ]);
    if (remoteBranch) {
      return requireBranch(ref, 'baseBranch');
    }
    throw new Error('无法从 baseRef 确定可用于 PR 的 baseBranch，请显式提供 baseBranch');
  }

  async #manifestFile(runId) {
    return path.join(this.#manifestsDir, `${runId}.json`);
  }

  async #readManifestByRunId(runId) {
    const file = await this.#manifestFile(runId);
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw new Error(`读取 worktree manifest 失败：${redact(error.message)}`);
    }
    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch (error) {
      throw new Error(`worktree manifest 无法解析（${runId}）：${redact(error.message)}`);
    }
    if (!isObject(manifest) || manifest.schema_version !== 1) {
      throw new Error(`worktree manifest 结构无效（${runId}）`);
    }
    return { manifest, file };
  }

  async #listManifests() {
    let entries;
    try {
      entries = await readdir(this.#manifestsDir);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw new Error(`读取 manifest 目录失败：${redact(error.message)}`);
    }
    const manifests = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) {
        continue;
      }
      const runId = entry.slice(0, -'.json'.length);
      const loaded = await this.#readManifestByRunId(runId);
      if (loaded) {
        manifests.push(loaded);
      }
    }
    return manifests;
  }

  async #findManifestByWorktree(worktreePath) {
    const requestedReal = await this.#safeRealpath(worktreePath);
    const matches = [];
    for (const loaded of await this.#listManifests()) {
      const storedReal = await this.#safeRealpath(loaded.manifest.worktreePath);
      if (storedReal === requestedReal) {
        matches.push(loaded);
      }
    }
    if (matches.length > 1) {
      throw new Error('多个 worktree manifest 指向同一路径，拒绝继续');
    }
    return matches[0] ?? null;
  }

  async #writeManifest(file, manifest) {
    await mkdir(this.#manifestsDir, { recursive: true });
    const tempFile = `${file}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tempFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await rename(tempFile, file);
  }

  async #resumeManifest(loaded, { repo, localPath, baseBranch }) {
    const { manifest } = loaded;
    if (manifest.repo.toLowerCase() !== repo.toLowerCase()) {
      throw new Error(`runId ${manifest.runId} 已绑定仓库 ${manifest.repo}，与 ${repo} 冲突`);
    }
    const localReal = await this.#safeRealpath(localPath);
    const manifestLocalReal = await this.#safeRealpath(manifest.localPath);
    if (localReal !== manifestLocalReal) {
      throw new Error(`runId ${manifest.runId} 已绑定源仓库 ${manifest.localPath}，路径冲突`);
    }
    if (baseBranch !== undefined) {
      const requested = requireBranch(baseBranch, 'baseBranch');
      if (requested !== manifest.baseBranch) {
        throw new Error(
          `runId ${manifest.runId} 的基线分支为 ${manifest.baseBranch}，与请求的 ${requested} 冲突`,
        );
      }
    }

    if (typeof manifest.worktreePath !== 'string' || manifest.worktreePath.length === 0) {
      throw new Error(`runId ${manifest.runId} 的 manifest 缺少 worktreePath`);
    }
    const topResult = await this.#tryGit(manifest.worktreePath, [
      'rev-parse',
      '--show-toplevel',
    ]);
    if (!topResult) {
      throw new Error(`runId ${manifest.runId} 的工作树不存在，保留 manifest，拒绝重新创建`);
    }
    const actualTop = await this.#safeRealpath(topResult.stdout.trim());
    const manifestTop = await this.#safeRealpath(manifest.worktreePath);
    if (actualTop !== manifestTop) {
      throw new Error(`runId ${manifest.runId} 的工作树路径与 manifest 不一致`);
    }

    const branchResult = await this.#tryGit(manifest.worktreePath, [
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD',
    ]);
    if (!branchResult || branchResult.stdout.trim() !== manifest.branch) {
      throw new Error(
        `runId ${manifest.runId} 的工作树分支不是 ${manifest.branch}，保留现场并拒绝复用`,
      );
    }

    const headResult = await this.#tryGit(manifest.worktreePath, ['rev-parse', 'HEAD']);
    if (!headResult || !COMMIT_PATTERN.test(headResult.stdout.trim())) {
      throw new Error(`runId ${manifest.runId} 的工作树没有有效 HEAD`);
    }
    const headSha = headResult.stdout.trim();
    if (headSha.toLowerCase() !== manifest.baseCommit.toLowerCase()) {
      const ancestor = await this.#tryGit(manifest.worktreePath, [
        'merge-base',
        '--is-ancestor',
        manifest.baseCommit,
        headSha,
      ]);
      if (!ancestor) {
        throw new Error(
          `runId ${manifest.runId} 的工作树 HEAD 不是基线 ${manifest.baseCommit} 的后代`,
        );
      }
    }

    return {
      repo: manifest.repo,
      runId: manifest.runId,
      branch: manifest.branch,
      worktreePath: manifestTop,
      baseCommit: manifest.baseCommit,
      baseBranch: manifest.baseBranch,
    };
  }

  async create({ repo, localPath, baseRef = 'HEAD', runId, baseBranch } = {}) {
    const targetRepo = requireRepo(repo);
    const sourcePath = requireAbsolutePath(localPath, 'localPath');
    const normalizedRunId = requireRunId(runId);
    const requestedBaseBranch =
      baseBranch === undefined ? undefined : requireBranch(baseBranch, 'baseBranch');

    const existing = await this.#readManifestByRunId(normalizedRunId);
    if (existing) {
      return this.#resumeManifest(existing, {
        repo: targetRepo,
        localPath: sourcePath,
        baseBranch: requestedBaseBranch,
      });
    }

    const branch = `auto-ai/${normalizedRunId}`;
    const worktreePath = path.join(
      this.#worktreesDir,
      `${targetRepo.replace('/', '-')}-${normalizedRunId}`,
    );

    const localReal = await this.#assertSourceIdentity(targetRepo, sourcePath);
    const { baseCommit, baseBranch: resolvedBaseBranch } = await this.#resolveBase({
      localPath: localReal,
      baseRef,
      baseBranch: requestedBaseBranch,
    });

    const branchExists = await this.#tryGit(localReal, [
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ]);
    if (branchExists) {
      throw new Error(`任务分支 ${branch} 已存在，拒绝覆盖`);
    }
    try {
      await lstat(worktreePath);
      throw new Error(`工作树目录已存在，拒绝覆盖：${worktreePath}`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    try {
      await lstat(await this.#manifestFile(normalizedRunId));
      throw new Error(`runId ${normalizedRunId} 的 manifest 已存在`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    await mkdir(this.#worktreesDir, { recursive: true });
    await mkdir(this.#manifestsDir, { recursive: true });

    await this.#git(
      localReal,
      ['worktree', 'add', '-b', branch, worktreePath, baseCommit],
      `为 runId ${normalizedRunId} 创建工作树`,
    );

    const actualWorktree = await this.#safeRealpath(worktreePath);
    const manifest = {
      schema_version: 1,
      repo: targetRepo,
      runId: normalizedRunId,
      localPath: localReal,
      worktreePath: actualWorktree,
      branch,
      baseCommit,
      baseBranch: resolvedBaseBranch,
      createdAt: new Date().toISOString(),
    };
    await this.#writeManifest(await this.#manifestFile(normalizedRunId), manifest);

    return {
      repo: targetRepo,
      runId: normalizedRunId,
      branch,
      worktreePath: actualWorktree,
      baseCommit,
      baseBranch: resolvedBaseBranch,
    };
  }

  async inspect({ worktreePath } = {}) {
    const targetPath = requireAbsolutePath(worktreePath, 'worktreePath');
    const rootResult = await this.#git(
      targetPath,
      ['rev-parse', '--show-toplevel'],
      `读取 ${worktreePath} 的 Git 根目录`,
    );
    const rootReal = await this.#safeRealpath(rootResult.stdout.trim());
    const targetReal = await this.#safeRealpath(targetPath);
    if (rootReal !== targetReal) {
      throw new Error('worktreePath 必须是工作树根目录');
    }

    const statusResult = await this.#git(
      targetPath,
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      `检查 ${worktreePath} 的变更`,
    );
    const headResult = await this.#git(
      targetPath,
      ['rev-parse', 'HEAD'],
      `读取 ${worktreePath} 的 HEAD`,
    );
    const headSha = headResult.stdout.trim();
    if (!COMMIT_PATTERN.test(headSha)) {
      throw new Error('工作树 HEAD 不是有效提交 SHA');
    }
    const paths = parseStatusPaths(statusResult.stdout);
    return { paths, dirty: paths.length > 0, headSha };
  }

  async #assertDeliveryContext({ repo, worktreePath, branch, baseCommit }) {
    const targetPath = requireAbsolutePath(worktreePath, 'worktreePath');
    const targetBranch = requireBranch(branch);
    const targetBase = requireCommit(baseCommit, 'baseCommit');

    const loaded = await this.#findManifestByWorktree(targetPath);
    if (!loaded) {
      throw new Error('worktreePath 没有对应的 manifest，拒绝提交或推送');
    }
    const { manifest } = loaded;
    if (manifest.repo.toLowerCase() !== repo.toLowerCase()) {
      throw new Error(`工作树属于 ${manifest.repo}，与请求的 ${repo} 不一致，拒绝串仓`);
    }
    if (manifest.branch !== targetBranch) {
      throw new Error(`工作树分支为 ${manifest.branch}，与请求的 ${targetBranch} 不一致`);
    }
    if (manifest.baseCommit.toLowerCase() !== targetBase.toLowerCase()) {
      throw new Error(`工作树基线为 ${manifest.baseCommit}，与请求的 ${baseCommit} 不一致`);
    }
    await this.#assertSourceIdentity(repo, manifest.localPath);

    const actualBranch = await this.#git(
      targetPath,
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      `读取 ${worktreePath} 的当前分支`,
    );
    if (actualBranch.stdout.trim() !== targetBranch) {
      throw new Error(`工作树当前分支不是 ${targetBranch}，拒绝提交`);
    }

    const headResult = await this.#git(
      targetPath,
      ['rev-parse', 'HEAD'],
      `读取 ${worktreePath} 的 HEAD`,
    );
    const headSha = headResult.stdout.trim();
    const ancestor = await this.#tryGit(targetPath, [
      'merge-base',
      '--is-ancestor',
      targetBase,
      headSha,
    ]);
    if (!ancestor) {
      throw new Error(`工作树 HEAD 不是基线 ${targetBase} 的后代，拒绝提交`);
    }
    return { targetPath, targetBranch, targetBase, manifest };
  }

  async #remoteBranchSha(repoPath, branch) {
    const result = await this.#git(
      repoPath,
      ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
      `读取 origin 分支 ${branch}`,
    );
    return parseLsRemote(result.stdout);
  }

  /**
   * Collects every path touched by commits in `baseCommit..headSha`. The union
   * includes paths that a later commit reverts, because publishing the branch
   * still carries those commits. Read-only: no fetch, checkout, worktree or
   * manifest is required, so it also serves the head-registration check.
   */
  async #committedPaths(repoPath, baseCommit, headSha, { localOnly = false } = {}) {
    const git = (args, action) => this.#git(repoPath, args, action, { localOnly });
    const history = await git(
      ['rev-list', '--max-count=2001', `${baseCommit}..${headSha}`],
      '检查待发布的任务提交',
    );
    const commits = history.stdout.trim().split('\n').filter(Boolean);
    const paths = new Set();
    if (commits.length > 2000) {
      return { commits, paths, tooManyCommits: true };
    }
    for (const commit of commits) {
      const changed = await git(
        ['diff-tree', '-m', '--root', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', commit],
        '检查已提交的写入范围',
      );
      for (const file of changed.stdout.split('\0').filter(Boolean)) paths.add(file);
      if (paths.size > MAX_CHANGED_PATHS) break;
    }
    return { commits, paths, tooManyCommits: false };
  }

  async #assertDeliveryScopes(context, scopes, snapshot) {
    // A Worker may have committed before handing control back. Validate every
    // commit that would be published, including paths later reverted.
    const { paths: committed, tooManyCommits } = await this.#committedPaths(
      context.targetPath,
      context.targetBase,
      snapshot.headSha,
    );
    if (tooManyCommits) throw new Error('任务提交数超过 2000，保留现场并拒绝推送');
    const paths = new Set(snapshot.paths);
    for (const file of committed) paths.add(file);
    if (paths.size > MAX_CHANGED_PATHS) {
      throw new Error(`变更文件数超过上限 ${MAX_CHANGED_PATHS}，拒绝提交异常大变更`);
    }
    const outside = [...paths].filter(file => !pathMatchesScopes(file, scopes));
    if (outside.length) {
      throw new Error(`变更超出 writeScopes（${scopes.join('、')}）：${outside.slice(0, 20).join('、')}`);
    }
    for (const file of paths) {
      let stats;
      try { stats = await lstat(path.join(context.targetPath, file)); } catch { continue; }
      if (stats.isFile() && stats.size > MAX_FILE_BYTES) {
        throw new Error(`文件 ${file} 大小 ${stats.size} 字节超过单文件上限 ${MAX_FILE_BYTES}，拒绝提交`);
      }
    }
  }

  async commitAndPush({
    repo,
    worktreePath,
    branch,
    baseCommit,
    writeScopes,
    summary,
  } = {}) {
    const targetRepo = requireRepo(repo);
    const commitSummary = requireTrimmedString(summary, 'summary');
    if (commitSummary.length > 4000) {
      throw new Error('summary 过长，拒绝异常提交信息');
    }
    const scopes = normalizeWriteScopes(writeScopes);
    const context = await this.#assertDeliveryContext({
      repo: targetRepo,
      worktreePath,
      branch,
      baseCommit,
    });

    const before = await this.inspect({ worktreePath: context.targetPath });
    await this.#assertDeliveryScopes(context, scopes, before);
    if (!before.dirty) {
      const remoteSha = await this.#remoteBranchSha(context.targetPath, context.targetBranch);
      if (remoteSha === before.headSha) {
        return {
          headSha: before.headSha,
          paths: [],
          pushed: true,
          noChanges: true,
        };
      }
      if (before.headSha.toLowerCase() !== context.targetBase.toLowerCase()) {
        // A previous attempt may have committed but failed before pushing. Reuse
        // that commit with a normal (non-force) push instead of creating a new one.
        await this.#git(
          context.targetPath,
          ['push', 'origin', `refs/heads/${context.targetBranch}:refs/heads/${context.targetBranch}`],
          `推送 ${context.targetBranch}`,
        );
        const pushedSha = await this.#remoteBranchSha(
          context.targetPath,
          context.targetBranch,
        );
        if (pushedSha !== before.headSha) {
          throw new Error(
            `推送后 origin/${context.targetBranch} 为 ${pushedSha ?? '缺失'}，与本地 ${before.headSha} 不一致`,
          );
        }
        return {
          headSha: before.headSha,
          paths: [],
          pushed: true,
          noChanges: true,
          reason: '工作树无新变更；已推送既有提交',
        };
      }
      return {
        headSha: before.headSha,
        paths: [],
        pushed: false,
        noChanges: true,
        reason: '工作树没有变更，分支尚未以当前提交推送；未创建空提交',
      };
    }

    await this.#git(
      context.targetPath,
      ['add', '-A', '--', ...before.paths],
      `暂存 ${worktreePath} 的变更`,
    );
    const staged = await this.#git(
      context.targetPath,
      ['diff', '--cached', '--name-only', '-z'],
      `检查 ${worktreePath} 的暂存内容`,
    );
    if (staged.stdout.length === 0) {
      const headResult = await this.#git(
        context.targetPath,
        ['rev-parse', 'HEAD'],
        `读取 ${worktreePath} 的 HEAD`,
      );
      const headSha = headResult.stdout.trim();
      const remoteSha = await this.#remoteBranchSha(context.targetPath, context.targetBranch);
      return {
        headSha,
        paths: [],
        pushed: remoteSha === headSha,
        noChanges: true,
        reason: '暂存后没有可提交的差异；未创建空提交',
      };
    }

    await this.#git(
      context.targetPath,
      ['commit', '-m', commitSummary],
      `提交 ${worktreePath} 的变更`,
    );
    const headResult = await this.#git(
      context.targetPath,
      ['rev-parse', 'HEAD'],
      `读取 ${worktreePath} 提交后的 HEAD`,
    );
    const headSha = headResult.stdout.trim();
    if (!COMMIT_PATTERN.test(headSha)) {
      throw new Error('提交后的 HEAD 不是有效提交 SHA');
    }

    const afterCommit = await this.inspect({ worktreePath: context.targetPath });
    await this.#assertDeliveryScopes(context, scopes, afterCommit);
    if (afterCommit.dirty || afterCommit.headSha !== headSha) {
      throw new Error('提交后工作树仍有变更或 HEAD 改变，保留现场并拒绝推送');
    }

    const remoteBefore = await this.#remoteBranchSha(
      context.targetPath,
      context.targetBranch,
    );
    if (remoteBefore !== headSha) {
      await this.#git(
        context.targetPath,
        ['push', 'origin', `refs/heads/${context.targetBranch}:refs/heads/${context.targetBranch}`],
        `推送 ${context.targetBranch}`,
      );
    }
    const remoteAfter = await this.#remoteBranchSha(
      context.targetPath,
      context.targetBranch,
    );
    if (remoteAfter !== headSha) {
      throw new Error(
        `推送后 origin/${context.targetBranch} 为 ${remoteAfter ?? '缺失'}，与本地 ${headSha} 不一致`,
      );
    }

    return {
      headSha,
      paths: before.paths,
      pushed: true,
      noChanges: false,
    };
  }

  /**
   * Read-only proof that `headSha` is a fast-forward of `baseCommit` inside the
   * local clone of `repo`, and that every committed path stays inside
   * `writeScopes`. Used to bind an already-delivered PR to a newer head without
   * fetching, checking out or touching the remote.
   */
  async verifyCommittedRange({ repo, localPath, baseCommit, headSha, writeScopes } = {}) {
    const targetRepo = requireRepo(repo);
    const sourcePath = requireAbsolutePath(localPath, 'localPath');
    const base = requireCommit(baseCommit, 'baseCommit');
    const head = requireCommit(headSha, 'headSha');
    const scopes = normalizeWriteScopes(writeScopes);
    if (base.toLowerCase() === head.toLowerCase()) {
      throw new Error('baseCommit 与 headSha 必须是两个不同的完整提交 SHA');
    }

    const localReal = await this.#assertSourceIdentity(targetRepo, sourcePath);
    // A shallow clone cannot prove that `base..head` contains every published
    // commit: rev-list silently stops at the shallow boundary and can miss an
    // out-of-scope path that a later commit reverted. Refuse before reading
    // objects instead of treating truncated history as evidence. No automatic
    // fetch: an operator must prepare a full history first.
    const shallow = await this.#git(
      localReal,
      ['rev-parse', '--is-shallow-repository'],
      '检查本地仓库是否为浅克隆',
      { localOnly: true },
    );
    if (shallow.stdout.trim() === 'true') {
      throw new Error(
        `本地仓库 ${localReal} 是浅克隆，提交历史被截断，无法核对 ${base}..${head} 的完整范围；`
        + '请先由操作员补齐完整历史（本命令不会自动 fetch），拒绝登记',
      );
    }
    for (const [label, sha] of [['baseCommit', base], ['headSha', head]]) {
      const probe = await this.#localGitStatus(
        localReal,
        ['cat-file', '-e', `${sha}^{commit}`],
        `核对 ${label} ${sha} 是否已在本地仓库`,
      );
      if (probe.status === 0) continue;
      // Never guess a missing object from Git's English wording: any failure
      // here fails closed, and the actual Git error is kept for the operator.
      const detail = String(probe.stderr ?? '').trim();
      throw new Error(
        `${label} ${sha} 不在本地仓库中或无法读取（git cat-file 退出码 ${probe.status}），`
        + `拒绝按未获取的提交登记${detail ? `：${detail}` : ''}`,
      );
    }
    const ancestor = await this.#localGitStatus(
      localReal,
      ['merge-base', '--is-ancestor', base, head],
      '核对 baseCommit 是否为 headSha 的祖先',
    );
    if (ancestor.status === 1) {
      throw new Error(`baseCommit ${base} 不是 headSha ${head} 的祖先，拒绝登记非快进变更`);
    }
    if (ancestor.status !== 0) {
      throw new Error(
        describeFailure('核对 baseCommit 是否为 headSha 的祖先', {
          stderr: ancestor.stderr,
          message: `git merge-base 退出码 ${ancestor.status}`,
        }),
      );
    }

    const { commits, paths: committed, tooManyCommits } = await this.#committedPaths(
      localReal,
      base,
      head,
      { localOnly: true },
    );
    if (tooManyCommits || committed.size > MAX_CHANGED_PATHS) {
      throw new Error(`提交或变更文件数超过上限（${commits.length} 个提交、${committed.size} 个路径），拒绝登记`);
    }
    const outside = [...committed].filter((file) => !pathMatchesScopes(file, scopes));
    if (outside.length > 0) {
      throw new Error(
        `变更超出 writeScopes（${scopes.join('、')}）：${outside.slice(0, 20).join('、')}`,
      );
    }

    return {
      repo: targetRepo,
      localPath: localReal,
      baseCommit: base,
      headSha: head,
      commits: commits.length,
      paths: [...committed].sort(),
    };
  }

  async archive({ repo, localPath, worktreePath, branch, headSha } = {}) {
    const targetRepo = requireRepo(repo);
    const sourcePath = requireAbsolutePath(localPath, 'localPath');
    const targetPath = requireAbsolutePath(worktreePath, 'worktreePath');
    const targetBranch = requireBranch(branch);
    const targetHead = requireCommit(headSha, 'headSha');

    const loaded = await this.#findManifestByWorktree(targetPath);
    if (!loaded) {
      return {
        removed: false,
        reason: '没有找到与该工作树对应的 manifest，保留现场',
      };
    }
    const { manifest, file } = loaded;
    if (manifest.repo.toLowerCase() !== targetRepo.toLowerCase()) {
      return {
        removed: false,
        reason: `manifest 属于 ${manifest.repo}，与 ${targetRepo} 不一致，保留现场`,
      };
    }
    if (manifest.branch !== targetBranch) {
      return {
        removed: false,
        reason: `manifest 分支为 ${manifest.branch}，与 ${targetBranch} 不一致，保留现场`,
      };
    }
    const sourceReal = await this.#safeRealpath(sourcePath);
    const manifestLocalReal = await this.#safeRealpath(manifest.localPath);
    if (sourceReal !== manifestLocalReal) {
      return {
        removed: false,
        reason: `manifest 绑定的源仓库为 ${manifest.localPath}，与 ${localPath} 不一致，保留现场`,
      };
    }
    try {
      await this.#assertSourceIdentity(targetRepo, sourceReal);
    } catch (error) {
      return { removed: false, reason: redact(error.message) };
    }

    const actualTop = await this.#tryGit(targetPath, ['rev-parse', '--show-toplevel']);
    if (!actualTop) {
      return { removed: false, reason: '工作树不存在或不是 Git 工作树，保留 manifest' };
    }
    if ((await this.#safeRealpath(actualTop.stdout.trim())) !== (await this.#safeRealpath(targetPath))) {
      return { removed: false, reason: 'worktreePath 不是工作树根目录，保留现场' };
    }

    const actualHead = await this.#tryGit(targetPath, ['rev-parse', 'HEAD']);
    if (!actualHead || actualHead.stdout.trim().toLowerCase() !== targetHead.toLowerCase()) {
      return {
        removed: false,
        reason: '工作树 HEAD 与传入 headSha 不一致（可能已有新提交），保留现场',
      };
    }
    const actualBranch = await this.#tryGit(targetPath, [
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD',
    ]);
    if (!actualBranch || actualBranch.stdout.trim() !== targetBranch) {
      return {
        removed: false,
        reason: `工作树当前分支不是 ${targetBranch}，保留现场`,
      };
    }

    let inspected;
    try {
      inspected = await this.inspect({ worktreePath: targetPath });
    } catch (error) {
      return { removed: false, reason: redact(error.message) };
    }
    if (inspected.dirty) {
      return {
        removed: false,
        reason: `工作树存在未提交或未跟踪修改（${inspected.paths.length} 个路径），保留现场`,
      };
    }

    let remoteSha;
    try {
      remoteSha = await this.#remoteBranchSha(targetPath, targetBranch);
    } catch (error) {
      return { removed: false, reason: redact(error.message) };
    }
    if (!remoteSha) {
      return {
        removed: false,
        reason: `origin/${targetBranch} 不存在，无法确认已推送，保留现场`,
      };
    }
    if (remoteSha.toLowerCase() !== targetHead.toLowerCase()) {
      const hasObject = await this.#tryGit(targetPath, ['cat-file', '-e', remoteSha]);
      const remoteContainsHead = hasObject
        ? await this.#tryGit(targetPath, ['merge-base', '--is-ancestor', targetHead, remoteSha])
        : null;
      if (!remoteContainsHead) {
        return {
          removed: false,
          reason: `origin/${targetBranch} 的 head ${remoteSha} 不包含传入 head ${targetHead}，保留现场`,
        };
      }
    }

    try {
      await this.#git(
        sourceReal,
        ['worktree', 'remove', '--', targetPath],
        `移除工作树 ${targetPath}`,
      );
    } catch (error) {
      return { removed: false, reason: redact(error.message) };
    }

    let note;
    try {
      await rm(file, { force: false });
    } catch (error) {
      note = `工作树已移除，但 manifest 删除失败：${redact(error.message)}`;
    }

    return {
      removed: true,
      reason: note ?? '工作树已确认干净且推送后移除，任务分支引用保留',
    };
  }
}

export { defaultRun as defaultWorkspaceRunner };
