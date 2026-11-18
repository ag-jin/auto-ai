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

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    throw new Error(`${label} role 必须是字符串`);
  }
  const role = value.trim();
  if (!ROLES.has(role)) {
    throw new Error(`${label} role 必须是 worker 或 draft`);
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

function requireId(id) {
  const normalized = requireTrimmedString(id, 'id');
  if (!ID_PATTERN.test(normalized)) {
    throw new Error('id 只能包含字母、数字、点、下划线或连字符');
  }
  return normalized;
}

function validateTemplatePath(templatePath, label) {
  if (typeof templatePath !== 'string' || templatePath.length === 0) {
    throw new Error(`${label} 必须是非空字符串`);
  }
  if (templatePath.length > 300) {
    throw new Error(`${label} 过长`);
  }
  if (templatePath.includes('\\')) {
    throw new Error(`${label} 必须使用正斜杠`);
  }
  if (templatePath.includes('\0')) {
    throw new Error(`${label} 不能包含 NUL`);
  }
  if (templatePath.startsWith('/') || /^[A-Za-z]:\//.test(templatePath)) {
    throw new Error(`${label} 必须是仓库内相对路径`);
  }
  const segments = templatePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${label} 不能包含空、. 或 .. 路径段`);
  }
  if (segments[0] !== 'templates') {
    throw new Error(`${label} 必须位于 templates/ 下`);
  }
  if (!templatePath.endsWith('.md')) {
    throw new Error(`${label} 必须指向 .md 文件`);
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
    throw new Error(`${label} 必须是非空字符串`);
  }
  const raw = value.trim();
  if (raw.includes('\\') || raw.includes('\0')) {
    throw new Error(`${label} 必须使用规范正斜杠相对路径`);
  }
  if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) {
    throw new Error(`${label} 必须是仓库内相对路径`);
  }
  const segments = raw.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${label} 不能包含空、. 或 .. 路径段`);
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
    throw new Error(`${label} YAML 非法：${message}`);
  }
}

function splitFrontMatter(text, label) {
  if (typeof text !== 'string') {
    throw new Error(`${label} 必须是文本`);
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) {
    throw new Error(`${label} 缺少 YAML frontmatter`);
  }
  const meta = parseYaml(match[1], `${label} frontmatter`);
  if (!isObject(meta)) {
    throw new Error(`${label} frontmatter 必须是 YAML 对象`);
  }
  return meta;
}

function requireCatalog(catalog, label) {
  if (!isObject(catalog)) {
    throw new Error(`${label} 必须是 YAML 对象`);
  }
  if (catalog.schema_version !== 1) {
    throw new Error(`${label} schema_version 必须为 1`);
  }
  if (!isObject(catalog.templates)) {
    throw new Error(`${label} 缺少 templates 对象`);
  }
  return catalog;
}

function requireTemplateMeta(meta, { id, templatePath, label }) {
  if (meta.schema_version !== 1) {
    throw new Error(`${label} schema_version 必须为 1`);
  }
  if (typeof meta.id !== 'string' || meta.id.trim().length === 0) {
    throw new Error(`${label} 缺少模板 id`);
  }
  if (meta.id !== id) {
    throw new Error(`${label} 的 id 为 ${meta.id}，与 catalog 的 ${id} 不一致`);
  }
  if (typeof meta.version !== 'string' || meta.version.trim().length === 0) {
    throw new Error(`${label} 缺少模板版本`);
  }
  if (!VERSION_PATTERN.test(meta.version)) {
    throw new Error(`${label} 的版本格式无效：${meta.version}`);
  }
  const role = normalizeRole(meta.role, label);
  const expectedPath = `templates/${id}/${meta.version}.md`;
  if (templatePath !== expectedPath) {
    throw new Error(
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
    const detail = String(error?.stderr || error?.message || '')
      .trim()
      .split('\n')
      .slice(0, 4)
      .join('\n');
    throw new Error(`解析 ref ${normalizedRef} 失败：${detail || '未知错误'}`);
  }
  const commit = result.stdout.trim();
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error(`ref ${normalizedRef} 没有解析到完整提交 SHA`);
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
    const detail = String(error?.stderr || error?.message || '')
      .trim()
      .split('\n')
      .slice(0, 4)
      .join('\n');
    throw new Error(`${label} 在提交 ${commit} 中不存在或无法读取：${detail || '未知错误'}`);
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
    throw new Error(
      `模板 ${id} 的 catalog role ${catalogRole} 与模板 role ${template.role} 不一致`,
    );
  }
  const reservedRole = RESERVED_ROLES.get(id);
  if (reservedRole !== undefined && template.role !== reservedRole) {
    throw new Error(
      `模板 ${id} 的 role 为 ${template.role}，保留 ID 的 role 必须为 ${reservedRole}`,
    );
  }
  if (expectedRole !== null && template.role !== expectedRole) {
    throw new Error(`模板 ${id} 的 role 为 ${template.role}，不能作为 ${expectedRole} 模板`);
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
 * entry and keep the remaining valid ones. A repository whose catalog itself
 * cannot be read still fails the whole call in both modes.
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
        throw new Error(`模板 catalog 中 ${templateId} 的条目不是对象`);
      }
      if (entry.description !== undefined && typeof entry.description !== 'string') {
        throw new Error(`模板 catalog 中 ${templateId} 的 description 必须是字符串`);
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
