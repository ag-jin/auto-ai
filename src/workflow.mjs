import { createHash, randomUUID } from 'node:crypto';

import {
  evaluateIssue,
  issueId,
  normalizeIssue,
  normalizeRules,
  sourceRevision,
} from './rules.mjs';
import { Store } from './store.mjs';

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/;
const DECISION_ACTIONS = new Set(['develop', 'defer', 'ignore']);
const ACCEPTANCE_ROLES = new Set(['user', 'design']);
const ACCEPTANCE_VERDICTS = new Set(['approved', 'changes_requested']);
const ACTIVE_RUN_STATUS = 'running';
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const TEMPLATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TEMPLATE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
// Only this template runs the versioned two-lane SOP. It is the single place a
// parent Run reserves a second concurrency slot and pins the SOP YAML.
const SOP_TEMPLATE_ID = 'development-sop';
const SOP_TEMPLATE_SLOTS = 2;

const STATE_REASONS = {
  candidate: '候选尚未形成任务稿',
  awaiting_decision: '任务稿尚未获得用户开发授权',
  deferred: '用户已暂缓该任务',
  ignored: '用户已忽略该任务',
  running: '任务正在执行',
  blocked: '任务处于阻塞状态，需要先重试',
  awaiting_acceptance: '任务结果正在验收，尚未完成',
  completed: '任务已完成',
};

const DECISION_STATES = {
  develop: 'ready',
  defer: 'deferred',
  ignore: 'ignored',
};

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function now() {
  return new Date().toISOString();
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
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

function normalizeTextArray(value, name) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${name} 必须是字符串数组`);
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new Error(`${name}[${index}] 必须是字符串`);
    }
    const item = requireTrimmedString(value[index], `${name}[${index}]`, { allowEmpty: true });
    if (item.length > 0) {
      result.push(item);
    }
  }
  return result;
}

function normalizeWriteScope(value, index) {
  const scope = requireTrimmedString(value, `draft.writeScopes[${index}]`);
  if (scope === '*') {
    return '*';
  }
  if (scope.includes('\\')) {
    throw new Error(`draft.writeScopes[${index}] 必须使用正斜杠`);
  }
  if (scope.includes('\0')) {
    throw new Error(`draft.writeScopes[${index}] 不能包含 NUL`);
  }
  if (scope.startsWith('/') || /^[A-Za-z]:\//.test(scope)) {
    throw new Error(`draft.writeScopes[${index}] 必须是仓库内相对路径`);
  }
  const segments = scope.split('/');
  if (segments.includes('..')) {
    throw new Error(`draft.writeScopes[${index}] 不能包含 .. 路径段`);
  }
  const normalized = segments.filter((segment) => segment !== '' && segment !== '.');
  if (normalized.length === 0) {
    throw new Error(`draft.writeScopes[${index}] 不能是仓库根路径或空路径`);
  }
  return normalized.join('/');
}

function normalizeWriteScopes(value) {
  if (value === undefined) {
    return ['*'];
  }
  if (!Array.isArray(value)) {
    throw new Error('draft.writeScopes 必须是字符串数组');
  }
  const scopes = new Set();
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new Error(`draft.writeScopes[${index}] 必须是字符串`);
    }
    scopes.add(normalizeWriteScope(value[index], index));
  }
  if (scopes.has('*')) {
    return ['*'];
  }
  return [...scopes].sort();
}

function normalizeDependsOn(value) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('draft.dependsOn 必须是候选 ID 数组');
  }
  const dependencies = new Set();
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new Error(`draft.dependsOn[${index}] 必须是字符串`);
    }
    const dependency = requireTrimmedString(value[index], `draft.dependsOn[${index}]`).toLowerCase();
    if (!CANDIDATE_ID_PATTERN.test(dependency)) {
      throw new Error(`draft.dependsOn[${index}] 必须是完整的候选 ID（owner/repo#number）`);
    }
    dependencies.add(dependency);
  }
  return [...dependencies].sort();
}

function normalizeDraftInput(input) {
  if (!isObject(input)) {
    throw new Error('draft 必须是对象');
  }

  const templateId =
    input.templateId === undefined
      ? 'development'
      : requireTrimmedString(input.templateId, 'draft.templateId');
  const goal = requireTrimmedString(input.goal, 'draft.goal');
  const scope = input.scope === undefined ? '' : requireTrimmedString(input.scope, 'draft.scope', { allowEmpty: true });
  const context =
    input.context === undefined
      ? ''
      : requireTrimmedString(input.context, 'draft.context', { allowEmpty: true });
  const acceptance = normalizeTextArray(input.acceptance, 'draft.acceptance');
  const pendingDecisions = normalizeTextArray(input.pendingDecisions, 'draft.pendingDecisions');
  const writeScopes = normalizeWriteScopes(input.writeScopes);
  const dependsOn = normalizeDependsOn(input.dependsOn);

  let priority = 0;
  if (input.priority !== undefined) {
    if (!Number.isSafeInteger(input.priority)) {
      throw new Error('draft.priority 必须是安全整数');
    }
    priority = input.priority;
  }

  const canonical = {
    templateId,
    goal,
    scope,
    acceptance,
    context,
    pendingDecisions,
    writeScopes,
    dependsOn,
    priority,
  };
  const rev = sha256(JSON.stringify(canonical));
  const requirements = { goal, acceptance, scope, context };
  const requirementsRev = `sha256:${sha256(JSON.stringify(requirements))}`;

  return {
    draft: { ...canonical, rev, requirementsRev },
    rev,
    requirementsRev,
  };
}

function normalizePr(pr, runRepo) {
  if (pr === undefined || pr === null) {
    return null;
  }
  if (!isObject(pr)) {
    throw new Error('result.pr 必须是对象或 null');
  }
  const repo = requireTrimmedString(pr.repo, 'result.pr.repo');
  if (repo.toLowerCase() !== runRepo.toLowerCase()) {
    throw new Error('result.pr.repo 必须与 Run 的仓库一致');
  }
  if (!Number.isSafeInteger(pr.number) || pr.number < 1) {
    throw new Error('result.pr.number 必须是正整数');
  }
  const url = requireTrimmedString(pr.url, 'result.pr.url');
  const headSha = requireTrimmedString(pr.headSha, 'result.pr.headSha');
  return { repo, number: pr.number, url, headSha };
}

function normalizePinnedTemplate(value) {
  if (!isObject(value)) {
    throw new Error('decision.template 必须是对象');
  }
  const commit = requireTrimmedString(value.commit, 'decision.template.commit');
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error('decision.template.commit 必须是完整的 40 或 64 位十六进制提交 SHA');
  }
  const templatePath = requireTrimmedString(value.path, 'decision.template.path');
  if (templatePath.includes('\\') || templatePath.includes('\0')) {
    throw new Error('decision.template.path 必须使用规范正斜杠相对路径');
  }
  const segments = templatePath.split('/');
  if (
    segments.length < 3 ||
    segments[0] !== 'templates' ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    !templatePath.endsWith('.md')
  ) {
    throw new Error('decision.template.path 必须是 templates/ 下的 .md 文件');
  }
  const id = requireTrimmedString(value.id, 'decision.template.id');
  if (!TEMPLATE_ID_PATTERN.test(id)) {
    throw new Error('decision.template.id 格式无效');
  }
  const version = requireTrimmedString(value.version, 'decision.template.version');
  if (!TEMPLATE_VERSION_PATTERN.test(version)) {
    throw new Error('decision.template.version 格式无效');
  }
  const expectedPath = `templates/${id}/${version}.md`;
  if (templatePath !== expectedPath) {
    throw new Error(`decision.template.path 与 id/版本不一致，应为 ${expectedPath}`);
  }
  const templateRef = `${commit}:${templatePath}`;
  const pin = { commit, path: templatePath, id, version, templateRef };
  const hasSopRef = value.sopRef !== undefined && value.sopRef !== null;
  if (id !== SOP_TEMPLATE_ID) {
    if (hasSopRef) {
      throw new Error(`decision.template.sopRef 只能用于 ${SOP_TEMPLATE_ID} 模板`);
    }
    return pin;
  }
  // The SOP method is defined by the YAML next to the pinned Markdown at the
  // same commit. A missing or mismatched YAML reference would leave the Run
  // without its only flow definition, so it is rejected instead of defaulted.
  const expectedSopPath = `templates/${id}/${version}.yaml`;
  if (!hasSopRef) {
    throw new Error(
      `decision.template.sopRef 必须固定同 commit 的 ${expectedSopPath}`,
    );
  }
  const sopRef = requireTrimmedString(value.sopRef, 'decision.template.sopRef');
  const expectedSopRef = `${commit}:${expectedSopPath}`;
  if (sopRef !== expectedSopRef) {
    throw new Error(
      `decision.template.sopRef 必须是同 commit 的 ${expectedSopPath}，应为 ${expectedSopRef}`,
    );
  }
  pin.sopRef = sopRef;
  return pin;
}

/**
 * Concurrency slots a Run needs for its whole lifetime. Only the explicit
 * `development-sop` template runs two lanes in parallel, so its parent Run
 * reserves two slots; every other template keeps the historical single slot.
 */
function draftSlots(draft) {
  return draft && draft.templateId === SOP_TEMPLATE_ID ? SOP_TEMPLATE_SLOTS : 1;
}

function scopesConflict(left, right) {
  if (left.includes('*') || right.includes('*')) {
    return true;
  }
  for (const a of left) {
    for (const b of right) {
      if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
        return true;
      }
    }
  }
  return false;
}

function draftedRevForRow(decidedRev) {
  return decidedRev === null ? '' : decidedRev;
}

function hasValidDevelopDecision(candidate) {
  if (!candidate.draft || candidate.draftStale || !candidate.decision) {
    return false;
  }
  return (
    candidate.decision.action === 'develop' &&
    candidate.decision.actor === 'user' &&
    candidate.decision.draftRev === candidate.draft.rev
  );
}

function assertNoDependencyCycle(rows, proposed) {
  const graph = new Map();
  for (const row of rows) {
    if (row.id === proposed.id) {
      continue;
    }
    const draft = row.draft ? JSON.parse(row.draft) : null;
    graph.set(row.id, draft ? draft.dependsOn : []);
  }
  graph.set(proposed.id, proposed.draft.dependsOn);

  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  const visit = (id) => {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(start), id].join(' -> ');
      throw new Error(`草稿依赖存在循环：${cycle}`);
    }
    if (visited.has(id)) {
      return;
    }
    visiting.add(id);
    stack.push(id);
    for (const dependency of graph.get(id) ?? []) {
      if (graph.has(dependency)) {
        visit(dependency);
      }
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };

  for (const id of graph.keys()) {
    visit(id);
  }
}

function candidateFromRow(row) {
  return {
    id: row.id,
    issue: JSON.parse(row.issue),
    sourceRev: row.source_rev,
    filter: {
      matched: Boolean(row.matched),
      reasons: JSON.parse(row.reasons),
    },
    state: row.state,
    draft: row.draft ? JSON.parse(row.draft) : null,
    draftStale: Boolean(row.draft_stale),
    decision: row.decision ? JSON.parse(row.decision) : null,
    pinnedTemplate: row.pinned_template ? JSON.parse(row.pinned_template) : null,
    activeRunId: row.active_run_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function runFromRow(row) {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    repo: row.repo,
    issueRef: row.issue_ref,
    draftRev: row.draft_rev,
    requirementsRev: row.requirements_rev,
    draftSnapshot: JSON.parse(row.draft_snapshot),
    sourceRev: row.source_rev,
    status: row.status,
    phase: row.phase,
    templateRef: row.template_ref ?? null,
    branch: row.branch ?? null,
    worktreePath: row.worktree_path ?? null,
    pid: row.pid ?? null,
    sessionId: row.session_id ?? null,
    result: row.result ? JSON.parse(row.result) : null,
    blockedReason: row.blocked_reason ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function acceptanceFromRow(row) {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    runId: row.run_id,
    role: row.role,
    verdict: row.verdict,
    headSha: row.head_sha,
    comment: row.comment,
    at: row.at,
  };
}

function eventFromRow(row) {
  return {
    id: row.id,
    at: row.at,
    kind: row.kind,
    message: row.message,
    candidateId: row.candidate_id ?? null,
    runId: row.run_id ?? null,
    repo: row.repo ?? null,
    data: row.data ? JSON.parse(row.data) : null,
  };
}

function defaultSettings() {
  return {
    repositories: [],
    rules: normalizeRules({}),
    concurrency: { global: 2, perRepo: 2 },
  };
}

export class Workflow {
  #store;

  constructor({ dbPath } = {}) {
    this.#store = new Store(dbPath);
  }

  close() {
    this.#store.close();
  }

  // ---------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------

  getSettings() {
    const row = this.#store.get('SELECT value FROM settings WHERE id = 1');
    if (!row) {
      return defaultSettings();
    }
    return JSON.parse(row.value);
  }

  saveSettings(settings, { allowEmptyLocalPath = false } = {}) {
    if (!isObject(settings)) {
      throw new Error('settings 必须是对象');
    }

    const repositories = [];
    const rawRepositories = settings.repositories === undefined ? [] : settings.repositories;
    if (!Array.isArray(rawRepositories)) {
      throw new Error('settings.repositories 必须是数组');
    }
    const seenRepositories = new Set();
    for (let index = 0; index < rawRepositories.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(rawRepositories, index)) {
        throw new Error(`settings.repositories[${index}] 必须是对象`);
      }
      const entry = rawRepositories[index];
      if (!isObject(entry)) {
        throw new Error(`settings.repositories[${index}] 必须是对象`);
      }
      const repo = requireTrimmedString(entry.repo, `settings.repositories[${index}].repo`);
      if (!REPO_PATTERN.test(repo)) {
        throw new Error(`settings.repositories[${index}].repo 必须使用 owner/repo 格式`);
      }
      const key = repo.toLowerCase();
      if (seenRepositories.has(key)) {
        throw new Error(`settings.repositories 存在重复仓库：${repo}`);
      }
      seenRepositories.add(key);
      repositories.push({
        repo,
        localPath: requireTrimmedString(
          entry.localPath,
          `settings.repositories[${index}].localPath`,
          { allowEmpty: allowEmptyLocalPath },
        ),
        baseRef: requireTrimmedString(entry.baseRef, `settings.repositories[${index}].baseRef`),
      });
    }

    const rules = normalizeRules(settings.rules);

    const concurrencyInput = settings.concurrency === undefined ? {} : settings.concurrency;
    if (!isObject(concurrencyInput)) {
      throw new Error('settings.concurrency 必须是对象');
    }
    const global =
      concurrencyInput.global === undefined ? 2 : concurrencyInput.global;
    const perRepo =
      concurrencyInput.perRepo === undefined ? 2 : concurrencyInput.perRepo;
    if (!Number.isSafeInteger(global) || global < 1) {
      throw new Error('settings.concurrency.global 必须是正整数');
    }
    if (!Number.isSafeInteger(perRepo) || perRepo < 1) {
      throw new Error('settings.concurrency.perRepo 必须是正整数');
    }

    const effective = { repositories, rules, concurrency: { global, perRepo } };
    const at = now();

    return this.#store.transaction(() => {
      this.#store.run(
        `INSERT INTO settings (id, value, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        JSON.stringify(effective),
        at,
      );
      this.#store.appendEvent({
        at,
        kind: 'settings.saved',
        message: `已保存设置：${repositories.length} 个仓库，并发上限全局 ${global}、每仓库 ${perRepo}`,
        data: effective,
      });
      return JSON.parse(JSON.stringify(effective));
    });
  }

  // ---------------------------------------------------------------------
  // Collection
  // ---------------------------------------------------------------------

  collect(issues) {
    if (!Array.isArray(issues)) {
      throw new Error('issues 必须是数组');
    }

    return this.#store.transaction(() => {
      const settings = this.getSettings();
      const uniqueIssues = new Map();
      for (const rawIssue of issues) {
        const issue = normalizeIssue(rawIssue);
        uniqueIssues.set(issueId(issue), issue);
      }

      const collected = [];
      for (const [id, issue] of uniqueIssues) {
        const filter = evaluateIssue(issue, settings.rules);
        const sourceRev = sourceRevision(issue);
        const at = now();
        const existing = this.#store.get('SELECT * FROM candidates WHERE id = ?', id);

        if (!existing) {
          this.#store.run(
            `INSERT INTO candidates
               (id, repo, issue, source_rev, matched, reasons, state, draft, decision,
                active_run_id, priority, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'candidate', NULL, NULL, NULL, 0, ?, ?)`,
            id,
            issue.repo,
            JSON.stringify(issue),
            sourceRev,
            filter.matched ? 1 : 0,
            JSON.stringify(filter.reasons),
            at,
            at,
          );
          this.#store.run(
            `INSERT INTO observations (candidate_id, source_rev, matched, reasons, observed_at)
             VALUES (?, ?, ?, ?, ?)`,
            id,
            sourceRev,
            filter.matched ? 1 : 0,
            JSON.stringify(filter.reasons),
            at,
          );
          this.#store.appendEvent({
            at,
            kind: 'candidate.created',
            message: filter.matched
              ? `收集到命中候选 ${id}`
              : `收集到候选 ${id}，但未命中收集规则`,
            candidateId: id,
            repo: issue.repo,
            data: { matched: filter.matched, reasons: filter.reasons, sourceRev },
          });
        } else {
          const sourceChanged = existing.source_rev !== sourceRev;
          const matchedChanged = Boolean(existing.matched) !== filter.matched;
          let state = existing.state;
          let draft = existing.draft;
          let draftStale = existing.draft_stale;
          let decision = existing.decision;

          if (sourceChanged) {
            draftStale = existing.draft ? 1 : 0;
            decision = null;
            if (existing.state !== ACTIVE_RUN_STATUS) {
              state = existing.draft ? 'awaiting_decision' : 'candidate';
            }
            this.#store.run('DELETE FROM acceptances WHERE candidate_id = ?', id);
            this.#store.run('UPDATE candidates SET pinned_template = NULL WHERE id = ?', id);
          }

          this.#store.run(
            `UPDATE candidates
               SET repo = ?, issue = ?, source_rev = ?, matched = ?, reasons = ?,
                   state = ?, draft = ?, draft_stale = ?, decision = ?, updated_at = ?
             WHERE id = ?`,
            issue.repo,
            JSON.stringify(issue),
            sourceRev,
            filter.matched ? 1 : 0,
            JSON.stringify(filter.reasons),
            state,
            draft,
            draftStale,
            decision,
            at,
            id,
          );
          this.#store.run(
            `INSERT INTO observations (candidate_id, source_rev, matched, reasons, observed_at)
             VALUES (?, ?, ?, ?, ?)`,
            id,
            sourceRev,
            filter.matched ? 1 : 0,
            JSON.stringify(filter.reasons),
            at,
          );

          if (sourceChanged) {
            this.#store.appendEvent({
              at,
              kind: 'candidate.source_changed',
              message: `候选 ${id} 的 Issue 标题或正文发生变化，旧任务稿与决定失效`,
              candidateId: id,
              repo: issue.repo,
              data: { previousSourceRev: existing.source_rev, sourceRev },
            });
          }
          if (matchedChanged) {
            this.#store.appendEvent({
              at,
              kind: 'candidate.filter_changed',
              message: filter.matched
                ? `候选 ${id} 重新命中收集规则`
                : `候选 ${id} 不再命中收集规则`,
              candidateId: id,
              repo: issue.repo,
              data: { matched: filter.matched, reasons: filter.reasons },
            });
          }
        }

        collected.push(candidateFromRow(this.#store.get('SELECT * FROM candidates WHERE id = ?', id)));
      }

      return collected;
    });
  }

  listCandidates({ repo, includeExcluded = true } = {}) {
    if (typeof includeExcluded !== 'boolean') {
      throw new Error('includeExcluded 必须是布尔值');
    }
    const conditions = [];
    const params = [];
    if (repo !== undefined) {
      conditions.push('lower(repo) = lower(?)');
      params.push(requireTrimmedString(repo, 'repo'));
    }
    if (!includeExcluded) {
      conditions.push('matched = 1');
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.#store.all(
      `SELECT * FROM candidates${where} ORDER BY rowid ASC`,
      ...params,
    );
    return rows.map(candidateFromRow);
  }

  getCandidate(id) {
    return candidateFromRow(this.#requireCandidateRow(id));
  }

  // ---------------------------------------------------------------------
  // Drafts and decisions
  // ---------------------------------------------------------------------

  saveDraft(id, input) {
    const normalized = normalizeDraftInput(input);

    return this.#store.transaction(() => {
      const row = this.#requireCandidateRow(id);
      const candidate = candidateFromRow(row);
      if (!candidate.filter.matched) {
        throw new Error(`候选 ${id} 未命中收集规则，不能保存任务稿`);
      }

      const existing = candidate.draft;
      const sameRevision = existing !== null && existing.rev === normalized.rev;
      if (sameRevision && !candidate.draftStale) {
        return candidate;
      }

      const otherRows = this.#store.all('SELECT * FROM candidates WHERE id != ?', id);
      assertNoDependencyCycle(otherRows, { id, draft: normalized.draft });

      const version = existing
        ? sameRevision
          ? existing.version
          : existing.version + 1
        : 1;
      const draft = { ...normalized.draft, version };
      const at = now();
      const activeRow = candidate.activeRunId
        ? this.#store.get('SELECT status FROM runs WHERE id = ?', candidate.activeRunId)
        : undefined;
      const state =
        activeRow && activeRow.status === ACTIVE_RUN_STATUS ? 'running' : 'awaiting_decision';

      this.#store.run('DELETE FROM acceptances WHERE candidate_id = ?', id);
      this.#store.run(
        `UPDATE candidates
           SET draft = ?, draft_rev = ?, draft_version = ?, draft_stale = 0,
               decision = NULL, pinned_template = NULL, state = ?, priority = ?, updated_at = ?
         WHERE id = ?`,
        JSON.stringify(draft),
        draft.rev,
        version,
        state,
        draft.priority,
        at,
        id,
      );
      this.#store.run(
        `INSERT OR REPLACE INTO draft_history
           (candidate_id, version, rev, requirements_rev, draft, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        version,
        draft.rev,
        draft.requirementsRev,
        JSON.stringify(draft),
        at,
      );
      this.#store.appendEvent({
        at,
        kind: 'draft.saved',
        message: `候选 ${id} 保存任务稿版本 ${version}`,
        candidateId: id,
        repo: candidate.issue.repo,
        data: {
          version,
          rev: draft.rev,
          requirementsRev: draft.requirementsRev,
          templateId: draft.templateId,
        },
      });

      return candidateFromRow(this.#store.get('SELECT * FROM candidates WHERE id = ?', id));
    });
  }

  decide(id, input) {
    if (!isObject(input)) {
      throw new Error('决定必须是对象');
    }

    return this.#store.transaction(() => {
      const candidate = candidateFromRow(this.#requireCandidateRow(id));
      const action = input.action;
      if (typeof action !== 'string' || !DECISION_ACTIONS.has(action)) {
        throw new Error('decision.action 只能是 develop、defer 或 ignore');
      }
      let draftRev = '';
      if (input.draftRev !== undefined && input.draftRev !== null) {
        draftRev = requireTrimmedString(input.draftRev, 'decision.draftRev');
      }
      const actor = requireTrimmedString(input.actor, 'decision.actor');
      if (actor !== 'user') {
        throw new Error('只有用户（actor=user）可以做出开发决定');
      }
      if (!candidate.filter.matched) {
        throw new Error(`候选 ${id} 未命中收集规则，不能获得开发授权`);
      }
      if (candidate.state === 'completed') {
        throw new Error(`候选 ${id} 已完成；需要新的任务稿或源内容变化后才能重新决定`);
      }

      const running = this.#store.get(
        "SELECT id FROM runs WHERE candidate_id = ? AND status = 'running' LIMIT 1",
        id,
      );
      if (candidate.activeRunId || running) {
        throw new Error(`候选 ${id} 仍有执行中的 Run，活动开发结束前不能重新批准`);
      }

      if (!candidate.draft) {
        if (action === 'develop') {
          throw new Error(`候选 ${id} 还没有任务稿，不能做出开发决定`);
        }
      } else {
        if (candidate.draftStale) {
          throw new Error(`候选 ${id} 的任务稿已因 Issue 源内容变化失效，请重新保存`);
        }
        if (draftRev !== candidate.draft.rev) {
          throw new Error('决定的 draftRev 与当前任务稿版本不一致，拒绝旧版本批准');
        }
        if (action === 'develop') {
          if (candidate.draft.acceptance.length === 0) {
            throw new Error('任务稿验收项为空，不能批准开发');
          }
          if (candidate.draft.pendingDecisions.length > 0) {
            throw new Error('任务稿仍有待决策项，不能批准开发');
          }
        }
      }

      const decidedRev = candidate.draft ? candidate.draft.rev : null;
      if (
        action === 'develop' &&
        candidate.draft.templateId === SOP_TEMPLATE_ID &&
        input.template === undefined
      ) {
        throw new Error(
          `候选 ${id} 的 ${SOP_TEMPLATE_ID} 任务稿必须在批准时固定模板与同 commit 的 SOP YAML`,
        );
      }
      const pinnedTemplate =
        action === 'develop' && input.template !== undefined && decidedRev !== null
          ? { ...normalizePinnedTemplate(input.template), draftRev: decidedRev }
          : null;

      const at = now();
      const decision = { action, draftRev: decidedRev, actor: 'user', at };
      const state = DECISION_STATES[action];
      this.#store.run(
        `UPDATE candidates
           SET decision = ?, pinned_template = ?, state = ?, updated_at = ?
         WHERE id = ?`,
        JSON.stringify(decision),
        pinnedTemplate === null ? null : JSON.stringify(pinnedTemplate),
        state,
        at,
        id,
      );
      this.#store.run(
        `INSERT INTO decisions (candidate_id, action, draft_rev, actor, at)
         VALUES (?, ?, ?, ?, ?)`,
        id,
        action,
        draftedRevForRow(decidedRev),
        'user',
        at,
      );
      this.#store.appendEvent({
        at,
        kind: 'decision.recorded',
        message: `用户对候选 ${id} 做出 ${action} 决定`,
        candidateId: id,
        repo: candidate.issue.repo,
        data: decision,
      });
      if (pinnedTemplate) {
        this.#store.appendEvent({
          at,
          kind: 'template.pinned',
          message: `候选 ${id} 固定模板 ${pinnedTemplate.templateRef}`,
          candidateId: id,
          repo: candidate.issue.repo,
          data: pinnedTemplate,
        });
      }
      return candidateFromRow(this.#store.get('SELECT * FROM candidates WHERE id = ?', id));
    });
  }

  // ---------------------------------------------------------------------
  // Scheduling
  // ---------------------------------------------------------------------

  eligibility(id) {
    return this.#evaluateEligibility(this.#requireCandidateRow(id));
  }

  claimNext() {
    return this.#store.transaction(() => {
      const rows = this.#store.all(
        "SELECT * FROM candidates WHERE state = 'ready' ORDER BY priority DESC, rowid ASC",
      );
      for (const row of rows) {
        const evaluation = this.#evaluateEligibility(row);
        if (!evaluation.eligible) {
          continue;
        }
        const candidate = candidateFromRow(row);
        const draft = candidate.draft;
        const at = now();
        const runId = `run-${randomUUID()}`;

        this.#store.run(
          `INSERT INTO runs
             (id, candidate_id, repo, issue_ref, draft_rev, requirements_rev,
              draft_snapshot, source_rev, status, phase, result, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', 'claimed', NULL, ?, ?)`,
          runId,
          candidate.id,
          candidate.issue.repo,
          candidate.id,
          draft.rev,
          draft.requirementsRev,
          JSON.stringify(draft),
          candidate.sourceRev,
          at,
          at,
        );
        this.#store.run(
          "UPDATE candidates SET state = 'running', active_run_id = ?, updated_at = ? WHERE id = ?",
          runId,
          at,
          candidate.id,
        );
        this.#store.appendEvent({
          at,
          kind: 'run.claimed',
          message: `已占用候选 ${candidate.id} 执行，Run ${runId}`,
          candidateId: candidate.id,
          runId,
          repo: candidate.issue.repo,
          data: {
            draftRev: draft.rev,
            requirementsRev: draft.requirementsRev,
            priority: draft.priority,
          },
        });
        return runFromRow(this.#store.get('SELECT * FROM runs WHERE id = ?', runId));
      }
      return null;
    });
  }

  bindExecution(runId, input) {
    if (!isObject(input)) {
      throw new Error('执行绑定信息必须是对象');
    }
    const templateRef = requireTrimmedString(input.templateRef, 'templateRef');
    const branch = requireTrimmedString(input.branch, 'branch');
    const worktreePath = requireTrimmedString(input.worktreePath, 'worktreePath');

    let pid = null;
    if (input.pid !== undefined && input.pid !== null) {
      if (!Number.isSafeInteger(input.pid) || input.pid < 1) {
        throw new Error('pid 必须是正整数');
      }
      pid = input.pid;
    }
    let sessionId = null;
    if (input.sessionId !== undefined && input.sessionId !== null) {
      sessionId = requireTrimmedString(input.sessionId, 'sessionId');
    }

    return this.#store.transaction(() => {
      const run = this.#requireRunRow(runId);
      if (run.status !== ACTIVE_RUN_STATUS) {
        throw new Error(`Run ${runId} 当前状态为 ${run.status}，不能绑定执行信息`);
      }
      if (run.template_ref || run.branch || run.worktree_path) {
        throw new Error(`Run ${runId} 已绑定执行信息，不能覆盖`);
      }

      const candidate = candidateFromRow(this.#requireCandidateRow(run.candidate_id));
      if (candidate.activeRunId !== run.id) {
        throw new Error(`Run ${runId} 不是候选当前占用的执行，不能绑定`);
      }
      if (!hasValidDevelopDecision(candidate)) {
        throw new Error(`Run ${runId} 对应的开发授权已失效，不能绑定执行信息`);
      }
      if (
        run.draft_rev !== candidate.draft.rev ||
        run.requirements_rev !== candidate.draft.requirementsRev ||
        run.source_rev !== candidate.sourceRev
      ) {
        throw new Error(`Run ${runId} 对应旧版本任务稿或旧源内容，拒绝绑定`);
      }

      const at = now();
      this.#store.run(
        `UPDATE runs
           SET template_ref = ?, branch = ?, worktree_path = ?, pid = ?,
               session_id = ?, phase = 'bound', updated_at = ?
         WHERE id = ?`,
        templateRef,
        branch,
        worktreePath,
        pid,
        sessionId,
        at,
        runId,
      );
      this.#store.appendEvent({
        at,
        kind: 'run.bound',
        message: `Run ${runId} 已绑定模板、分支与工作目录`,
        candidateId: run.candidate_id,
        runId,
        repo: run.repo,
        data: { templateRef, branch, worktreePath, pid, sessionId },
      });
      return runFromRow(this.#store.get('SELECT * FROM runs WHERE id = ?', runId));
    });
  }

  /**
   * Records the real Pi process identity after the adapter has spawned it.
   * Kept separate from bindExecution because the process exists only after the
   * template, branch and worktree have been persisted.
   */
  attachRunProcess(runId, input) {
    if (!isObject(input)) {
      throw new Error('进程信息必须是对象');
    }
    let pid = null;
    if (input.pid !== undefined && input.pid !== null) {
      if (!Number.isSafeInteger(input.pid) || input.pid < 1) {
        throw new Error('pid 必须是正整数');
      }
      pid = input.pid;
    }
    let sessionId = null;
    if (input.sessionId !== undefined && input.sessionId !== null) {
      sessionId = requireTrimmedString(input.sessionId, 'sessionId');
    }

    return this.#store.transaction(() => {
      const run = this.#requireRunRow(runId);
      if (run.status !== ACTIVE_RUN_STATUS) {
        throw new Error(`Run ${runId} 当前状态为 ${run.status}，不能绑定进程信息`);
      }
      if (!run.template_ref || !run.branch || !run.worktree_path) {
        throw new Error(`Run ${runId} 尚未绑定模板与工作目录，不能绑定进程信息`);
      }
      const at = now();
      this.#store.run(
        `UPDATE runs SET pid = ?, session_id = ?, phase = 'started', updated_at = ?
         WHERE id = ?`,
        pid,
        sessionId,
        at,
        runId,
      );
      this.#store.appendEvent({
        at,
        kind: 'run.started',
        message: `Run ${runId} 的 Pi 进程已记录`,
        candidateId: run.candidate_id,
        runId,
        repo: run.repo,
        data: { pid, sessionId },
      });
      return runFromRow(this.#store.get('SELECT * FROM runs WHERE id = ?', runId));
    });
  }

  listAcceptances(candidateId) {
    const rows = this.#store.all(
      'SELECT * FROM acceptances WHERE candidate_id = ? ORDER BY id ASC',
      requireTrimmedString(candidateId, 'candidateId'),
    );
    return rows.map(acceptanceFromRow);
  }

  /**
   * Latest acceptance per role, used by the state DTO. `null` means the role
   * has not recorded a verdict for the current candidate.
   */
  latestAcceptances(candidateId) {
    const latest = { user: null, design: null };
    for (const acceptance of this.listAcceptances(candidateId)) {
      latest[acceptance.role] = acceptance;
    }
    return latest;
  }

  recordEvent(input) {
    if (!isObject(input)) {
      throw new Error('事件必须是对象');
    }
    const kind = requireTrimmedString(input.kind, 'kind');
    const message = requireTrimmedString(input.message, 'message');
    const at = now();
    this.#store.appendEvent({
      at,
      kind,
      message,
      candidateId: input.candidateId ?? null,
      runId: input.runId ?? null,
      repo: input.repo ?? null,
      data: input.data ?? null,
    });
    return at;
  }

  recordProgress(runId, input) {
    if (!isObject(input)) {
      throw new Error('进展信息必须是对象');
    }
    const phase = requireTrimmedString(input.phase, 'phase');
    if (typeof input.message !== 'string') {
      throw new Error('message 必须是字符串');
    }
    const message = input.message.trim();

    return this.#store.transaction(() => {
      const run = this.#requireRunRow(runId);
      if (run.status !== ACTIVE_RUN_STATUS) {
        throw new Error(`Run ${runId} 当前状态为 ${run.status}，不能记录进展`);
      }
      const at = now();
      this.#store.run(
        'UPDATE runs SET phase = ?, updated_at = ? WHERE id = ?',
        phase,
        at,
        runId,
      );
      this.#store.appendEvent({
        at,
        kind: 'run.progress',
        message: message.length > 0 ? `[${phase}] ${message}` : `[${phase}]`,
        candidateId: run.candidate_id,
        runId,
        repo: run.repo,
        data: { phase, message },
      });
      return runFromRow(this.#store.get('SELECT * FROM runs WHERE id = ?', runId));
    });
  }

  listRuns({ repo } = {}) {
    const rows =
      repo === undefined
        ? this.#store.all('SELECT * FROM runs ORDER BY rowid ASC')
        : this.#store.all(
            'SELECT * FROM runs WHERE lower(repo) = lower(?) ORDER BY rowid ASC',
            requireTrimmedString(repo, 'repo'),
          );
    return rows.map(runFromRow);
  }

  getRun(id) {
    return runFromRow(this.#requireRunRow(id));
  }

  latestRun(candidateId) {
    const row = this.#currentRunRow(requireTrimmedString(candidateId, 'candidateId'));
    return row ? runFromRow(row) : null;
  }

  // ---------------------------------------------------------------------
  // Results, acceptance and merge
  // ---------------------------------------------------------------------

  finishRun(runId, input) {
    if (!isObject(input)) {
      throw new Error('结果必须是对象');
    }
    const summary = requireTrimmedString(input.summary, 'summary');
    const artifacts = input.artifacts === undefined ? [] : input.artifacts;
    const evidence = input.evidence === undefined ? [] : input.evidence;

    return this.#store.transaction(() => {
      const run = this.#requireRunRow(runId);
      if (run.status !== ACTIVE_RUN_STATUS) {
        throw new Error(`Run ${runId} 当前状态为 ${run.status}，不能结束执行`);
      }
      const candidate = candidateFromRow(this.#requireCandidateRow(run.candidate_id));
      const pr = normalizePr(input.pr, run.repo);
      const at = now();
      const staleReason = this.#staleRunReason(run, candidate);
      const result = { summary, artifacts, evidence, pr, finishedAt: at };

      if (staleReason) {
        result.blockedReason = staleReason;
        this.#store.run(
          `UPDATE runs
             SET result = ?, status = 'blocked', blocked_reason = ?, phase = 'finished',
                 updated_at = ?
           WHERE id = ?`,
          JSON.stringify(result),
          staleReason,
          at,
          runId,
        );
        this.#store.run(
          "UPDATE candidates SET state = 'blocked', active_run_id = NULL, updated_at = ? WHERE id = ?",
          at,
          candidate.id,
        );
        this.#store.appendEvent({
          at,
          kind: 'run.stale',
          message: `Run ${runId} 的结果已过时，保留结果但标记阻塞：${staleReason}`,
          candidateId: candidate.id,
          runId,
          repo: run.repo,
          data: { reason: staleReason, pr },
        });
        return runFromRow(this.#store.get('SELECT * FROM runs WHERE id = ?', runId));
      }

      this.#store.run(
        `UPDATE runs
           SET result = ?, status = 'awaiting_acceptance', phase = 'finished', updated_at = ?
         WHERE id = ?`,
        JSON.stringify(result),
        at,
        runId,
      );
      this.#store.run(
        `UPDATE candidates
           SET state = 'awaiting_acceptance', active_run_id = NULL, updated_at = ?
         WHERE id = ?`,
        at,
        candidate.id,
      );
      this.#store.appendEvent({
        at,
        kind: 'run.finished',
        message: `Run ${runId} 结束，结果进入验收`,
        candidateId: candidate.id,
        runId,
        repo: run.repo,
        data: { pr },
      });
      return runFromRow(this.#store.get('SELECT * FROM runs WHERE id = ?', runId));
    });
  }

  blockRun(runId, reason) {
    const normalizedReason = requireTrimmedString(reason, 'reason');

    return this.#store.transaction(() => {
      const run = this.#requireRunRow(runId);
      if (run.status !== ACTIVE_RUN_STATUS) {
        throw new Error(`Run ${runId} 当前状态为 ${run.status}，只能阻塞执行中的 Run`);
      }
      const at = now();
      this.#store.run(
        `UPDATE runs SET status = 'blocked', blocked_reason = ?, updated_at = ? WHERE id = ?`,
        normalizedReason,
        at,
        runId,
      );
      this.#store.run(
        "UPDATE candidates SET state = 'blocked', active_run_id = NULL, updated_at = ? WHERE id = ?",
        at,
        run.candidate_id,
      );
      this.#store.appendEvent({
        at,
        kind: 'run.blocked',
        message: `Run ${runId} 已阻塞：${normalizedReason}`,
        candidateId: run.candidate_id,
        runId,
        repo: run.repo,
        data: { reason: normalizedReason },
      });
      return runFromRow(this.#store.get('SELECT * FROM runs WHERE id = ?', runId));
    });
  }

  retryCandidate(id) {
    return this.#store.transaction(() => {
      const candidate = candidateFromRow(this.#requireCandidateRow(id));
      if (candidate.activeRunId) {
        throw new Error(`候选 ${id} 仍有活动 Run，不能重试`);
      }
      const running = this.#store.get(
        "SELECT id FROM runs WHERE candidate_id = ? AND status = 'running' LIMIT 1",
        id,
      );
      if (running) {
        throw new Error(`候选 ${id} 仍有执行中的 Run，不能重试`);
      }
      if (!hasValidDevelopDecision(candidate)) {
        throw new Error(`候选 ${id} 没有与当前任务稿一致的用户开发授权，不能重试`);
      }
      if (
        candidate.pinnedTemplate &&
        candidate.pinnedTemplate.draftRev !== candidate.draft.rev
      ) {
        throw new Error(`候选 ${id} 的固定模板不属于当前任务稿版本，不能重试`);
      }
      if (candidate.state === 'ready') {
        return candidate;
      }
      if (!['blocked', 'awaiting_acceptance'].includes(candidate.state)) {
        throw new Error(`候选 ${id} 当前状态为 ${candidate.state}，不能重试`);
      }

      const at = now();
      this.#store.run(
        "UPDATE candidates SET state = 'ready', updated_at = ? WHERE id = ?",
        at,
        id,
      );
      this.#store.appendEvent({
        at,
        kind: 'candidate.retried',
        message: `候选 ${id} 已回到就绪队列`,
        candidateId: id,
        repo: candidate.issue.repo,
      });
      return candidateFromRow(this.#store.get('SELECT * FROM candidates WHERE id = ?', id));
    });
  }

  recordAcceptance(id, input) {
    if (!isObject(input)) {
      throw new Error('验收信息必须是对象');
    }
    const role = requireTrimmedString(input.role, 'role');
    if (!ACCEPTANCE_ROLES.has(role)) {
      throw new Error('role 只能是 user 或 design');
    }
    const verdict = requireTrimmedString(input.verdict, 'verdict');
    if (!ACCEPTANCE_VERDICTS.has(verdict)) {
      throw new Error('verdict 只能是 approved 或 changes_requested');
    }
    const headSha = requireTrimmedString(input.headSha, 'headSha');
    const comment =
      input.comment === undefined ? '' : requireTrimmedString(input.comment, 'comment', { allowEmpty: true });

    return this.#store.transaction(() => {
      const candidate = candidateFromRow(this.#requireCandidateRow(id));
      if (!hasValidDevelopDecision(candidate)) {
        throw new Error(`候选 ${id} 的开发授权已失效，不能记录验收`);
      }
      if (candidate.state !== 'awaiting_acceptance') {
        throw new Error(`候选 ${id} 当前状态为 ${candidate.state}，没有待验收结果`);
      }

      const run = this.#currentRunRow(candidate.id);
      if (!run || run.status !== 'awaiting_acceptance') {
        throw new Error(`候选 ${id} 没有待验收的执行结果`);
      }
      if (
        run.draft_rev !== candidate.draft.rev ||
        run.requirements_rev !== candidate.draft.requirementsRev ||
        run.source_rev !== candidate.sourceRev
      ) {
        throw new Error(`候选 ${id} 的当前结果与任务稿或源内容不一致，不能验收`);
      }
      const result = run.result ? JSON.parse(run.result) : null;
      const pr = result?.pr ?? null;
      if (!pr) {
        throw new Error(`候选 ${id} 的当前结果没有 PR，不能记录验收`);
      }
      if (pr.headSha.toLowerCase() !== headSha.toLowerCase()) {
        throw new Error('验收的 headSha 与当前结果 PR head 不一致');
      }

      const at = now();
      this.#store.run(
        `INSERT INTO acceptances
           (candidate_id, run_id, role, verdict, head_sha, comment, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        candidate.id,
        run.id,
        role,
        verdict,
        headSha,
        comment,
        at,
      );
      this.#store.appendEvent({
        at,
        kind: 'acceptance.recorded',
        message: `${role === 'user' ? '用户' : '设计监督'}对候选 ${id} 给出 ${verdict} 验收`,
        candidateId: candidate.id,
        runId: run.id,
        repo: candidate.issue.repo,
        data: { role, verdict, headSha, comment },
      });
      return { candidateId: candidate.id, runId: run.id, role, verdict, headSha, comment, at };
    });
  }

  /**
   * Binds the still-pending acceptance of one Run/PR to a newer, externally
   * verified head. The caller must already have checked the real PR head, the
   * Issue source revision, the fast-forward ancestry and the committed write
   * scopes. Only `result.pr.headSha` changes; earlier acceptances, the
   * development decision, the candidate and the other result fields stay as
   * they are, so the old approval is kept but no longer satisfies canMerge.
   */
  registerDeliveryHead(runId, input) {
    if (!isObject(input)) {
      throw new Error('登记信息必须是对象');
    }
    const fromHeadSha = requireTrimmedString(input.fromHeadSha, 'fromHeadSha');
    const toHeadSha = requireTrimmedString(input.toHeadSha, 'toHeadSha');
    for (const [name, value] of [['fromHeadSha', fromHeadSha], ['toHeadSha', toHeadSha]]) {
      if (!COMMIT_PATTERN.test(value)) {
        throw new Error(`${name} 必须是完整的 40 或 64 位十六进制提交 SHA`);
      }
    }
    if (fromHeadSha.toLowerCase() === toHeadSha.toLowerCase()) {
      throw new Error('新 head 必须与已登记 head 不同');
    }
    const evidence = input.evidence;
    if (!isObject(evidence)) {
      throw new Error('evidence 必须是对象');
    }
    const evidenceSha256 = requireTrimmedString(evidence.sha256, 'evidence.sha256').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(evidenceSha256)) {
      throw new Error('evidence.sha256 必须是 64 位十六进制摘要');
    }
    const evidenceSummary = requireTrimmedString(evidence.summary, 'evidence.summary');
    const prInput = input.pr;
    if (!isObject(prInput)) {
      throw new Error('pr 必须是对象');
    }
    const prRepo = requireTrimmedString(prInput.repo, 'pr.repo');
    if (!Number.isSafeInteger(prInput.number) || prInput.number < 1) {
      throw new Error('pr.number 必须是正整数');
    }
    const prUrl = requireTrimmedString(prInput.url, 'pr.url');

    return this.#store.transaction(() => {
      const run = this.#requireRunRow(runId);
      const candidate = candidateFromRow(this.#requireCandidateRow(run.candidate_id));
      if (prRepo.toLowerCase() !== run.repo.toLowerCase()) {
        throw new Error('pr.repo 必须与 Run 的仓库一致');
      }
      if (!hasValidDevelopDecision(candidate)) {
        throw new Error(`Run ${runId} 的开发授权已失效，不能登记新 head`);
      }
      if (candidate.state !== 'awaiting_acceptance' || run.status !== 'awaiting_acceptance') {
        throw new Error(
          `Run ${runId} 当前不在待验收状态（候选 ${candidate.state}、Run ${run.status}），不能登记新 head`,
        );
      }
      const current = this.#currentRunRow(candidate.id);
      if (!current || current.id !== run.id) {
        throw new Error(`Run ${runId} 不是候选 ${candidate.id} 的最新执行，不能登记新 head`);
      }
      if (candidate.activeRunId) {
        throw new Error(`候选 ${candidate.id} 仍有活动执行 ${candidate.activeRunId}，不能登记新 head`);
      }
      const running = this.#store.get(
        "SELECT id FROM runs WHERE candidate_id = ? AND status = 'running' LIMIT 1",
        candidate.id,
      );
      if (running) {
        throw new Error(`候选 ${candidate.id} 仍有执行中的 Run ${running.id}，不能登记新 head`);
      }
      if (
        !candidate.draft ||
        run.draft_rev !== candidate.draft.rev ||
        run.requirements_rev !== candidate.draft.requirementsRev ||
        run.source_rev !== candidate.sourceRev
      ) {
        throw new Error(`Run ${runId} 对应旧版本任务稿或旧源内容，不能登记新 head`);
      }
      const result = run.result ? JSON.parse(run.result) : null;
      const pr = result?.pr ?? null;
      if (!isObject(pr)) {
        throw new Error(`Run ${runId} 的结果没有 PR，不能登记新 head`);
      }
      if (
        pr.repo.toLowerCase() !== prRepo.toLowerCase() ||
        pr.number !== prInput.number ||
        pr.url !== prUrl
      ) {
        throw new Error('待登记的 PR 仓库、编号或地址与 Run 结果不一致，拒绝换 PR 登记');
      }
      if (pr.headSha.toLowerCase() !== fromHeadSha.toLowerCase()) {
        throw new Error(
          `Run ${runId} 已登记的 PR head 为 ${pr.headSha}，与 fromHeadSha ${fromHeadSha} 不一致，拒绝登记`,
        );
      }

      const at = now();
      const updatedResult = { ...result, pr: { ...pr, headSha: toHeadSha } };
      this.#store.run(
        'UPDATE runs SET result = ?, updated_at = ? WHERE id = ?',
        JSON.stringify(updatedResult),
        at,
        runId,
      );
      this.#store.appendEvent({
        at,
        kind: 'run.head_registered',
        message:
          `Run ${runId} 的 PR #${pr.number} 已从 ${pr.headSha.slice(0, 12)} 登记到新 head ` +
          `${toHeadSha.slice(0, 12)}；需按新 head 重新验收，旧验收保留但不再生效`,
        candidateId: candidate.id,
        runId,
        repo: run.repo,
        data: {
          fromHeadSha: pr.headSha,
          toHeadSha,
          pr: { repo: pr.repo, number: pr.number, url: pr.url },
          evidence: { sha256: evidenceSha256, summary: evidenceSummary },
        },
      });
      return {
        runId,
        candidateId: candidate.id,
        pr: updatedResult.pr,
        fromHeadSha: pr.headSha,
        toHeadSha,
        evidence: { sha256: evidenceSha256, summary: evidenceSummary },
        at,
      };
    });
  }

  canMerge(id, { headSha } = {}) {
    const candidate = candidateFromRow(this.#requireCandidateRow(id));
    const reasons = [];
    let allowed = true;
    const deny = (reason) => {
      allowed = false;
      reasons.push(reason);
    };

    if (typeof headSha !== 'string' || headSha.trim().length === 0) {
      deny('缺少待核对的 PR head SHA');
    }
    if (!candidate.filter.matched) {
      deny('候选未命中收集规则');
    }
    if (!hasValidDevelopDecision(candidate)) {
      deny('没有与当前任务稿一致的用户开发授权');
    }
    if (candidate.state !== 'awaiting_acceptance') {
      deny(`候选当前状态为 ${candidate.state}，不在验收阶段`);
    }

    let run = null;
    if (candidate.state === 'awaiting_acceptance') {
      run = this.#currentRunRow(candidate.id);
      if (!run || run.status !== 'awaiting_acceptance') {
        deny('没有待验收的当前结果');
      } else {
        if (!candidate.draft || run.draft_rev !== candidate.draft.rev) {
          deny('当前结果不是当前任务稿的产物');
        }
        if (!candidate.draft || run.requirements_rev !== candidate.draft.requirementsRev) {
          deny('当前结果的需求版本与当前任务稿不一致');
        }
        if (run.source_rev !== candidate.sourceRev) {
          deny('当前结果对应旧的 Issue 源内容');
        }
      }
    }

    if (run) {
      const result = run.result ? JSON.parse(run.result) : null;
      const pr = result?.pr ?? null;
      if (!pr) {
        deny('当前结果没有 PR，不能合并');
      } else {
        if (typeof headSha === 'string' && headSha.trim().length > 0) {
          if (pr.headSha.toLowerCase() !== headSha.trim().toLowerCase()) {
            deny('待合并的 head SHA 不是当前 PR head');
          }
        }
        const acceptances = this.#store.all(
          'SELECT * FROM acceptances WHERE candidate_id = ? AND run_id = ? ORDER BY id ASC',
          candidate.id,
          run.id,
        );
        const latestByRole = new Map();
        for (const acceptance of acceptances) {
          latestByRole.set(acceptance.role, acceptance);
        }
        for (const role of ['user', 'design']) {
          const acceptance = latestByRole.get(role);
          if (!acceptance) {
            deny(`缺少${role === 'user' ? '用户' : '设计监督'}验收`);
            continue;
          }
          if (acceptance.verdict !== 'approved') {
            deny(`${role === 'user' ? '用户' : '设计监督'}验收为 ${acceptance.verdict}，禁止合并`);
          }
          if (acceptance.head_sha.toLowerCase() !== pr.headSha.toLowerCase()) {
            deny(`${role === 'user' ? '用户' : '设计监督'}验收对应的 head 不是当前 PR head`);
          }
        }
      }
    }

    return { allowed, reasons };
  }

  recordMerged(id, input) {
    if (!isObject(input)) {
      throw new Error('合并信息必须是对象');
    }
    const headSha = requireTrimmedString(input.headSha, 'headSha');
    const mergeSha = requireTrimmedString(input.mergeSha, 'mergeSha');

    return this.#store.transaction(() => {
      const merge = this.canMerge(id, { headSha });
      if (!merge.allowed) {
        throw new Error(`不允许记录合并：${merge.reasons.join('；')}`);
      }
      const candidate = candidateFromRow(this.#requireCandidateRow(id));
      const run = this.#currentRunRow(candidate.id);
      const at = now();
      const result = run.result ? JSON.parse(run.result) : {};
      result.merge = { headSha, mergeSha, mergedAt: at };
      this.#store.run(
        `UPDATE runs SET result = ?, status = 'completed', phase = 'completed', updated_at = ?
         WHERE id = ?`,
        JSON.stringify(result),
        at,
        run.id,
      );
      this.#store.run(
        "UPDATE candidates SET state = 'completed', active_run_id = NULL, updated_at = ? WHERE id = ?",
        at,
        candidate.id,
      );
      this.#store.appendEvent({
        at,
        kind: 'candidate.merged',
        message: `候选 ${id} 已记录外部合并，进入 completed`,
        candidateId: candidate.id,
        runId: run.id,
        repo: candidate.issue.repo,
        data: { headSha, mergeSha },
      });
      return candidateFromRow(this.#store.get('SELECT * FROM candidates WHERE id = ?', id));
    });
  }

  // ---------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------

  listEvents({ after = 0, limit = 200, candidateId, runId, repo, order = 'asc' } = {}) {
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new Error('after 必须是非负整数');
    }
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('limit 必须是正整数');
    }
    if (order !== 'asc' && order !== 'desc') throw new Error('order 只能是 asc 或 desc');
    const conditions = ['id > ?'];
    const params = [after];
    if (candidateId !== undefined) {
      conditions.push('candidate_id = ?');
      params.push(requireTrimmedString(candidateId, 'candidateId'));
    }
    if (runId !== undefined) {
      conditions.push('run_id = ?');
      params.push(requireTrimmedString(runId, 'runId'));
    }
    if (repo !== undefined) {
      conditions.push('lower(repo) = lower(?)');
      params.push(requireTrimmedString(repo, 'repo'));
    }
    params.push(limit);
    const rows = this.#store.all(
      `SELECT * FROM events WHERE ${conditions.join(' AND ')} ORDER BY id ${order.toUpperCase()} LIMIT ?`,
      ...params,
    );
    return rows.map(eventFromRow);
  }

  // ---------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------

  #requireCandidateRow(id) {
    const normalized = requireTrimmedString(id, 'candidateId');
    const row = this.#store.get('SELECT * FROM candidates WHERE id = ?', normalized);
    if (!row) {
      throw new Error(`候选 ${normalized} 不存在`);
    }
    return row;
  }

  #requireRunRow(id) {
    const normalized = requireTrimmedString(id, 'runId');
    const row = this.#store.get('SELECT * FROM runs WHERE id = ?', normalized);
    if (!row) {
      throw new Error(`Run ${normalized} 不存在`);
    }
    return row;
  }

  #currentRunRow(candidateId) {
    return this.#store.get(
      'SELECT * FROM runs WHERE candidate_id = ? ORDER BY rowid DESC LIMIT 1',
      candidateId,
    );
  }

  #staleRunReason(run, candidate) {
    if (!candidate.draft) {
      return '任务稿已不存在';
    }
    if (candidate.draftStale) {
      return '任务稿已因 Issue 源内容变化失效';
    }
    if (run.draft_rev !== candidate.draft.rev) {
      return 'Run 对应旧版本任务稿';
    }
    if (run.requirements_rev !== candidate.draft.requirementsRev) {
      return 'Run 对应旧需求版本';
    }
    if (run.source_rev !== candidate.sourceRev) {
      return 'Run 对应旧的 Issue 源内容';
    }
    if (!hasValidDevelopDecision(candidate)) {
      return '当前用户开发授权已失效';
    }
    if (candidate.activeRunId !== run.id) {
      return 'Run 已被其他执行占用或替换';
    }
    return null;
  }

  #evaluateEligibility(row) {
    const candidate = candidateFromRow(row);
    const settings = this.getSettings();
    const reasons = [];
    let blocked = false;
    const deny = (reason) => {
      blocked = true;
      reasons.push(reason);
    };

    if (!candidate.filter.matched) {
      deny(`Issue 未命中收集规则：${candidate.filter.reasons.join('；')}`);
    }

    if (candidate.activeRunId) {
      deny(`候选仍有执行中的 Run ${candidate.activeRunId}`);
    } else if (candidate.state !== 'ready') {
      deny(STATE_REASONS[candidate.state] ?? `候选状态 ${candidate.state} 不可派发`);
    }

    const draft = candidate.draft;
    if (!draft) {
      deny('候选尚未形成任务稿');
    } else {
      if (candidate.draftStale) {
        deny('任务稿已因 Issue 源内容变化失效，需要重新保存');
      }
      if (!candidate.decision) {
        deny('任务稿尚未获得用户开发授权');
      } else if (candidate.decision.action !== 'develop') {
        deny(`用户决定为 ${candidate.decision.action}，尚未批准开发`);
      } else if (candidate.decision.actor !== 'user') {
        deny('开发授权不是用户决定');
      } else if (candidate.decision.draftRev !== draft.rev) {
        deny('开发授权对应旧任务稿版本');
      } else if (
        candidate.pinnedTemplate &&
        candidate.pinnedTemplate.draftRev !== draft.rev
      ) {
        deny('固定模板对应旧任务稿版本');
      }
    }

    if (draft && candidate.filter.matched) {
      const missing = [];
      const incomplete = [];
      for (const dependency of draft.dependsOn) {
        const dependencyRow = this.#store.get(
          'SELECT id, state FROM candidates WHERE id = ?',
          dependency,
        );
        if (!dependencyRow) {
          missing.push(dependency);
        } else if (dependencyRow.state !== 'completed') {
          incomplete.push(`${dependency}（${dependencyRow.state}）`);
        }
      }
      if (missing.length > 0) {
        deny(`依赖候选不存在：${missing.join('、')}`);
      }
      if (incomplete.length > 0) {
        deny(`依赖候选尚未完成：${incomplete.join('、')}`);
      }
    }

    // Every running Run reserves slots for its whole lifetime: two for an
    // explicit development-sop parent Run (read from its task snapshot), one
    // otherwise. Admitting a candidate therefore compares used + needed slots
    // against both limits instead of assuming one slot per Run.
    const activeRuns = this.#store.all(
      "SELECT id, candidate_id, repo, draft_snapshot FROM runs WHERE status = 'running'",
    );
    const neededSlots = draftSlots(draft);
    let usedGlobalSlots = 0;
    let usedRepoSlots = 0;
    for (const activeRun of activeRuns) {
      const slots = draftSlots(JSON.parse(activeRun.draft_snapshot));
      usedGlobalSlots += slots;
      if (activeRun.repo.toLowerCase() === candidate.issue.repo.toLowerCase()) {
        usedRepoSlots += slots;
      }
    }
    if (usedGlobalSlots + neededSlots > settings.concurrency.global) {
      deny(
        `全局并发已达到上限 ${settings.concurrency.global}` +
          `（已占用 ${usedGlobalSlots} 槽，需要 ${neededSlots} 槽）`,
      );
    }
    if (usedRepoSlots + neededSlots > settings.concurrency.perRepo) {
      deny(
        `仓库 ${candidate.issue.repo} 并发已达到上限 ${settings.concurrency.perRepo}` +
          `（已占用 ${usedRepoSlots} 槽，需要 ${neededSlots} 槽）`,
      );
    }

    if (draft) {
      const conflicts = [];
      for (const activeRun of activeRuns) {
        if (
          activeRun.candidate_id === candidate.id ||
          activeRun.repo.toLowerCase() !== candidate.issue.repo.toLowerCase()
        ) {
          continue;
        }
        const activeDraft = JSON.parse(activeRun.draft_snapshot);
        const activeScopes = activeDraft.writeScopes ?? ['*'];
        if (scopesConflict(draft.writeScopes, activeScopes)) {
          conflicts.push(`${activeRun.candidate_id}（Run ${activeRun.id}）`);
        }
      }
      if (conflicts.length > 0) {
        deny(`与执行中的任务写入范围冲突：${conflicts.join('、')}`);
      }
    }

    return { eligible: !blocked, reasons };
  }
}
