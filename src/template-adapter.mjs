import { execFile } from 'node:child_process';
import path from 'node:path';

import { parse } from 'yaml';

const CATALOG_PATH = 'templates/catalog.yml';
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const ROLES = new Set(['worker', 'draft']);
// IDs with a fixed meaning may never be relabelled by repository metadata.
// `requirements` is the read-only method Runtime itself starts, so declaring it
// as a worker template (in catalog, frontmatter or both) is invalid content, not
// a feature toggle.
const RESERVED_ROLES = new Map([['requirements', 'draft']]);
const MAX_BUFFER = 16 * 1024 * 1024;
// A catalog entry that declares something invalid is an entry-level mistake:
// tolerant callers may isolate it. A blob or commit that Git cannot read is a
// source fault and must never be turned into "this entry is absent". Only the
// explicit validation points below raise the "invalid" code; anything else
// (unknown failures, Git read faults) keeps its own identity.
const ENTRY_INVALID = 'template_entry_invalid';
const BLOB_UNREADABLE = 'template_blob_unreadable';
const GIT_UNREADABLE = 'template_git_unreadable';
const KNOWN_FAILURE_CODES = new Set([ENTRY_INVALID, BLOB_UNREADABLE, GIT_UNREADABLE]);

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Explicitly invalid template content (id, path, metadata, role, YAML text).
 * Raised only where the adapter itself validates a declared value, so callers
 * can tell it apart from a Git read fault or an unexpected failure.
 */
class TemplateConfigError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'TemplateConfigError';
    this.code = ENTRY_INVALID;
  }
}

function configError(message) {
  return new TemplateConfigError(message);
}

/** Known template-source failures that a caller may report as a list error. */
export function isTemplateSourceError(error) {
  return KNOWN_FAILURE_CODES.has(error?.code);
}

function gitSourceError(message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = GIT_UNREADABLE;
  return error;
}

function errorDetail(error) {
  return String(error?.stderr || error?.message || '')
    .trim()
    .split('\n')
    .slice(0, 4)
    .join('\n');
}

/**
 * Templates written before roles existed are worker templates. `draft` is only
 * valid for the read-only requirements method and never grants tools.
 */
function normalizeRole(value, label) {
  if (value === undefined || value === null) {
    return 'worker';
  }
  if (typeof value !== 'string') {
    throw configError(`${label} role 必须是字符串`);
  }
  const role = value.trim();
  if (!ROLES.has(role)) {
    throw configError(`${label} role 必须是 worker 或 draft`);
  }
  return role;
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

function requireRef(ref) {
  const normalized = requireTrimmedString(ref, 'ref');
  if (
    normalized.length > 256 ||
    normalized.startsWith('-') ||
    /[\s\0]/.test(normalized)
  ) {
    throw new Error('ref 不是有效的 Git 引用');
  }
  return normalized;
}

// A hand-written catalog key is explicit input: an invalid id is a known
// entry-level mistake, not an unknown failure. The message stays identical to
// the generic string validation so the strict interface still reports why.
function requireId(id) {
  if (typeof id !== 'string') {
    throw configError('id 必须是字符串');
  }
  const normalized = id.trim();
  if (normalized.length === 0) {
    throw configError('id 不能为空');
  }
  if (!ID_PATTERN.test(normalized)) {
    throw configError('id 只能包含字母、数字、点、下划线或连字符');
  }
  return normalized;
}

function validateTemplatePath(templatePath, label) {
  if (typeof templatePath !== 'string' || templatePath.length === 0) {
    throw configError(`${label} 必须是非空字符串`);
  }
  if (templatePath.length > 300) {
    throw configError(`${label} 过长`);
  }
  if (templatePath.includes('\\')) {
    throw configError(`${label} 必须使用正斜杠`);
  }
  if (templatePath.includes('\0')) {
    throw configError(`${label} 不能包含 NUL`);
  }
  if (templatePath.startsWith('/') || /^[A-Za-z]:\//.test(templatePath)) {
    throw configError(`${label} 必须是仓库内相对路径`);
  }
  const segments = templatePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw configError(`${label} 不能包含空、. 或 .. 路径段`);
  }
  if (segments[0] !== 'templates') {
    throw configError(`${label} 必须位于 templates/ 下`);
  }
  if (!templatePath.endsWith('.md')) {
    throw configError(`${label} 必须指向 .md 文件`);
  }
  return templatePath;
}

/**
 * Catalog defaults in this repository are written relative to templates/
 * (e.g. development/1.2.0.md). A repo-root path that already starts with
 * templates/ is accepted too, then normalized to one canonical repo path.
 */
function catalogDefaultToRepoPath(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw configError(`${label} 必须是非空字符串`);
  }
  const raw = value.trim();
  if (raw.includes('\\') || raw.includes('\0')) {
    throw configError(`${label} 必须使用规范正斜杠相对路径`);
  }
  if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) {
    throw configError(`${label} 必须是仓库内相对路径`);
  }
  const segments = raw.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw configError(`${label} 不能包含空、. 或 .. 路径段`);
  }
  const repoPath = segments[0] === 'templates' ? raw : `templates/${raw}`;
  return validateTemplatePath(repoPath, label);
}

function parseYaml(text, label) {
  try {
    return parse(text, { uniqueKeys: true });
  } catch (error) {
    const message = String(error?.message ?? error)
      .split('\n')
      .slice(0, 4)
      .join('\n');
    throw configError(`${label} YAML 非法：${message}`);
  }
}

function splitFrontMatter(text, label) {
  if (typeof text !== 'string') {
    throw configError(`${label} 必须是文本`);
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) {
    throw configError(`${label} 缺少 YAML frontmatter`);
  }
  const meta = parseYaml(match[1], `${label} frontmatter`);
  if (!isObject(meta)) {
    throw configError(`${label} frontmatter 必须是 YAML 对象`);
  }
  return meta;
}

function requireCatalog(catalog, label) {
  if (!isObject(catalog)) {
    throw configError(`${label} 必须是 YAML 对象`);
  }
  if (catalog.schema_version !== 1) {
    throw configError(`${label} schema_version 必须为 1`);
  }
  if (!isObject(catalog.templates)) {
    throw configError(`${label} 缺少 templates 对象`);
  }
  return catalog;
}

function requireTemplateMeta(meta, { id, templatePath, label }) {
  if (meta.schema_version !== 1) {
    throw configError(`${label} schema_version 必须为 1`);
  }
  if (typeof meta.id !== 'string' || meta.id.trim().length === 0) {
    throw configError(`${label} 缺少模板 id`);
  }
  if (meta.id !== id) {
    throw configError(`${label} 的 id 为 ${meta.id}，与 catalog 的 ${id} 不一致`);
  }
  if (typeof meta.version !== 'string' || meta.version.trim().length === 0) {
    throw configError(`${label} 缺少模板版本`);
  }
  if (!VERSION_PATTERN.test(meta.version)) {
    throw configError(`${label} 的版本格式无效：${meta.version}`);
  }
  const role = normalizeRole(meta.role, label);
  const expectedPath = `templates/${id}/${meta.version}.md`;
  if (templatePath !== expectedPath) {
    throw configError(
      `${label} 路径 ${templatePath} 与 id/版本不一致，应为 ${expectedPath}`,
    );
  }
  return { id: meta.id, version: meta.version, role };
}

async function resolveCommit({ repoDir, ref, run }) {
  const normalizedRef = requireRef(ref);
  let result;
  try {
    result = await run(
      'git',
      ['-C', repoDir, 'rev-parse', '--verify', `${normalizedRef}^{commit}`],
      { maxBuffer: MAX_BUFFER },
    );
  } catch (error) {
    throw gitSourceError(
      `解析 ref ${normalizedRef} 失败：${errorDetail(error) || '未知错误'}`,
      error,
    );
  }
  const commit = result.stdout.trim();
  if (!COMMIT_PATTERN.test(commit)) {
    throw gitSourceError(`ref ${normalizedRef} 没有解析到完整提交 SHA`);
  }
  return commit;
}

async function readBlob({ repoDir, commit, blobPath, run, label }) {
  try {
    const result = await run('git', ['-C', repoDir, 'cat-file', 'blob', `${commit}:${blobPath}`], {
      maxBuffer: MAX_BUFFER,
    });
    return result.stdout;
  } catch (error) {
    // Keep the original Git failure as `cause` so the `cat-file` reason is never
    // masked, and let tolerant callers probe the tree only when they must.
    const readError = new Error(
      `${label} 在提交 ${commit} 中读取失败（路径不存在或对象不可读）：${errorDetail(error) || '未知错误'}`,
      { cause: error },
    );
    readError.code = BLOB_UNREADABLE;
    readError.blobPath = blobPath;
    throw readError;
  }
}

/**
 * `git cat-file` cannot tell "the catalog points at a path that never existed"
 * from "Git cannot read an object it still lists". Only the fixed commit tree
 * can, so a failed read is followed by exactly one `ls-tree` probe: absence is
 * an entry-level mistake, a listed path or a failing probe is a source fault.
 */
async function templatePathInTree({ repoDir, commit, blobPath, run, label }) {
  try {
    const result = await run(
      'git',
      ['-C', repoDir, 'ls-tree', '--name-only', commit, '--', blobPath],
      { maxBuffer: MAX_BUFFER },
    );
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .includes(blobPath);
  } catch (error) {
    const treeError = new Error(
      `${label} 在提交 ${commit} 中读取失败，且 git ls-tree 无法确认该路径是否存在：${errorDetail(error) || '未知错误'}`,
      { cause: error },
    );
    treeError.code = BLOB_UNREADABLE;
    throw treeError;
  }
}

async function loadCatalog({ repoDir, commit, run }) {
  const text = await readBlob({
    repoDir,
    commit,
    blobPath: CATALOG_PATH,
    run,
    label: '模板 catalog',
  });
  return requireCatalog(parseYaml(text, `模板 catalog ${commit}`), `模板 catalog ${commit}`);
}

async function loadTemplate({ repoDir, commit, id, templatePath, run }) {
  const text = await readBlob({
    repoDir,
    commit,
    blobPath: templatePath,
    run,
    label: `模板 ${templatePath}`,
  });
  // Validation errors already carry the explicit config code; no wrapping catch
  // may relabel an unexpected failure as a skippable entry.
  const meta = splitFrontMatter(text, `模板 ${templatePath}`);
  const validated = requireTemplateMeta(meta, {
    id,
    templatePath,
    label: `模板 ${templatePath}`,
  });
  return { text, version: validated.version, role: validated.role };
}

/**
 * Resolves one catalog entry and validates its declared role. The catalog role
 * is optional (old catalogs only had description/default), but when present it
 * must agree with the template frontmatter.
 */
async function resolveCatalogEntry({ repoDir, commit, id, entry, run, expectedRole }) {
  const templatePath = catalogDefaultToRepoPath(
    entry.default,
    `模板 ${id} 的 catalog default`,
  );
  const catalogRole =
    entry.role === undefined
      ? null
      : normalizeRole(entry.role, `模板 ${id} 的 catalog`);
  const template = await loadTemplate({
    repoDir,
    commit,
    id,
    templatePath,
    run,
  });
  if (catalogRole !== null && catalogRole !== template.role) {
    throw configError(
      `模板 ${id} 的 catalog role ${catalogRole} 与模板 role ${template.role} 不一致`,
    );
  }
  const reservedRole = RESERVED_ROLES.get(id);
  if (reservedRole !== undefined && template.role !== reservedRole) {
    throw configError(
      `模板 ${id} 的 role 为 ${template.role}，保留 ID 的 role 必须为 ${reservedRole}`,
    );
  }
  if (expectedRole !== null && template.role !== expectedRole) {
    throw configError(
      `模板 ${id} 的 role 为 ${template.role}，不能作为 ${expectedRole} 模板`,
    );
  }
  return { ...template, path: templatePath };
}


/**
 * Resolves the current catalog default for a template id at exactly one commit.
 * Catalog and template text are both read from that commit, never the working tree.
 */
export async function resolveTemplate({ repoDir, ref = 'HEAD', id, run, expectedRole } = {}) {
  const normalizedRepoDir = path.resolve(requireTrimmedString(repoDir, 'repoDir'));
  const templateId = requireId(id);
  const role =
    expectedRole === undefined || expectedRole === null
      ? null
      : normalizeRole(expectedRole, 'expectedRole');
  const runner = run ?? defaultRun;
  const commit = await resolveCommit({ repoDir: normalizedRepoDir, ref, run: runner });
  const catalog = await loadCatalog({ repoDir: normalizedRepoDir, commit, run: runner });

  const entry = catalog.templates[templateId];
  if (!isObject(entry)) {
    throw new Error(`模板 catalog 中没有 id ${templateId}`);
  }
  const template = await resolveCatalogEntry({
    repoDir: normalizedRepoDir,
    commit,
    id: templateId,
    entry,
    run: runner,
    expectedRole: role,
  });

  return {
    commit,
    path: template.path,
    id: templateId,
    version: template.version,
    role: template.role,
    text: template.text,
    templateRef: `${commit}:${template.path}`,
  };
}

/**
 * Lists template defaults at exactly one commit, optionally filtered by role so
 * the development UI only offers worker execution templates.
 *
 * The default contract stays strict and backward compatible: a broken entry
 * (bad default path, missing file, invalid or conflicting role, invalid
 * metadata) fails the whole call, exactly like `resolveTemplate`. Callers that
 * render an overview may pass `skipInvalidEntries: true` to isolate such an
 * entry and keep the remaining valid ones. Only explicit entry-level mistakes
 * are isolated (bad path or metadata, conflicting role, or a path the fixed
 * commit tree proves absent). A repository whose catalog itself cannot be read,
 * or a blob Git cannot read even though the tree still lists it, fails the
 * whole call in both modes: a half-read list is never reported as success.
 */
export async function listTemplates({
  repoDir,
  ref = 'HEAD',
  run,
  role,
  skipInvalidEntries = false,
} = {}) {
  const normalizedRepoDir = path.resolve(requireTrimmedString(repoDir, 'repoDir'));
  const expectedRole =
    role === undefined || role === null ? null : normalizeRole(role, 'role');
  const runner = run ?? defaultRun;
  const commit = await resolveCommit({ repoDir: normalizedRepoDir, ref, run: runner });
  const catalog = await loadCatalog({ repoDir: normalizedRepoDir, commit, run: runner });

  const templates = [];
  for (const id of Object.keys(catalog.templates).sort()) {
    const entry = catalog.templates[id];
    let template;
    let templateId;
    try {
      templateId = requireId(id);
      if (!isObject(entry)) {
        throw configError(`模板 catalog 中 ${templateId} 的条目不是对象`);
      }
      if (entry.description !== undefined && typeof entry.description !== 'string') {
        throw configError(`模板 catalog 中 ${templateId} 的 description 必须是字符串`);
      }
      template = await resolveCatalogEntry({
        repoDir: normalizedRepoDir,
        commit,
        id: templateId,
        entry,
        run: runner,
        expectedRole: null,
      });
    } catch (error) {
      if (!skipInvalidEntries) {
        // Strict default: an invalid entry is reported, not silently dropped.
        throw error;
      }
      if (error?.code === BLOB_UNREADABLE) {
        const inTree = await templatePathInTree({
          repoDir: normalizedRepoDir,
          commit,
          blobPath: error.blobPath,
          run: runner,
          label: `模板 ${error.blobPath}`,
        });
        if (inTree) {
          // The tree lists the path, so this is a Git read fault, not an absent
          // entry. The error already carries the `cat-file` reason and cause;
          // wrapping it again would only hide that.
          throw error;
        }
        // The fixed commit tree proves the path is absent: entry-level mistake.
        continue;
      }
      if (error?.code !== ENTRY_INVALID) {
        // Unknown failures are not entry-level mistakes and must not be hidden.
        throw error;
      }
      // Opt-in per-entry isolation: one invalid template never clears the others.
      continue;
    }
    if (expectedRole !== null && template.role !== expectedRole) {
      continue;
    }
    templates.push({
      id: templateId,
      version: template.version,
      role: template.role,
      description: entry.description ?? '',
      path: template.path,
      templateRef: `${commit}:${template.path}`,
      commit,
    });
  }
  return templates;
}

export { defaultRun as defaultTemplateRunner };
