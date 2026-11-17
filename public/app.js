const POLL_MS = 2500;
const MAX_EVENTS = 80;

const STATE_LABELS = {
  candidate: "候选",
  drafting: "整理中",
  awaiting_decision: "待决定",
  deferred: "已暂缓",
  ignored: "已忽略",
  ready: "已就绪",
  running: "执行中",
  blocked: "已阻塞",
  awaiting_acceptance: "待验收",
  completed: "已完成",
};

const STATE_TONES = {
  candidate: "",
  drafting: "is-accent",
  awaiting_decision: "is-accent",
  deferred: "",
  ignored: "",
  ready: "is-accent",
  running: "is-accent",
  blocked: "is-warn",
  awaiting_acceptance: "is-warn",
  completed: "is-ok",
};

const RUN_STATUS_LABELS = {
  running: "执行中",
  blocked: "已阻塞",
  awaiting_acceptance: "待验收",
  completed: "已完成",
};

const RUN_STATUS_TONES = {
  running: "is-accent",
  blocked: "is-warn",
  awaiting_acceptance: "is-warn",
  completed: "is-ok",
};

const EVENT_KIND_LABELS = {
  collect: "收集",
  filter: "筛选",
  draft: "任务稿",
  decision: "决定",
  dispatch: "派发",
  run: "执行",
  progress: "进展",
  check: "检查",
  pr: "PR",
  acceptance: "验收",
  merge: "合并",
  error: "错误",
  blocked: "阻塞",
  cancel: "取消",
  retry: "重试",
  settings: "设置",
  watch: "监督",
};

const VIEWS = [
  { id: "candidates", label: "需求" },
  { id: "runs", label: "执行" },
  { id: "acceptance", label: "验收" },
  { id: "settings", label: "规则" },
];

const DEVELOP_STATES = new Set([
  "candidate",
  "drafting",
  "awaiting_decision",
  "deferred",
  "blocked",
]);

// 已确认开发进入 ready 后不能再重复确认，但允许用户暂缓或忽略。
const DECIDABLE_STATES = new Set([...DEVELOP_STATES, "ready"]);

const EDITABLE_DRAFT_STATES = DEVELOP_STATES;

const MERGE_METHODS = [
  { value: "merge", label: "创建合并提交（merge）" },
  { value: "squash", label: "压缩合并（squash）" },
  { value: "rebase", label: "变基合并（rebase）" },
];

const ui = {
  data: null,
  token: null,
  loading: true,
  loadError: null,
  lastSyncAt: null,
  refreshPromise: null,
  lastMutationAt: 0,
  view: "candidates",
  repoFilter: "",
  candidateScope: "all",
  selectedId: null,
  drafts: new Map(),
  settings: null,
  acceptance: new Map(),
  pending: new Set(),
  errors: new Map(),
  notice: null,
  open: new Map(),
};

class ApiError extends Error {
  constructor(status, message, detail = null) {
    super(message || `请求失败（HTTP ${status}）`);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.code = detail && typeof detail === "object" ? detail.code : undefined;
  }
}

/* ---------------- DOM 与格式化基础 ---------------- */

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") {
      node.className = String(value);
      continue;
    }
    if (key === "text") {
      node.textContent = String(value);
      continue;
    }
    if (key === "dataset") {
      for (const [dataKey, dataValue] of Object.entries(value)) {
        if (dataValue !== undefined && dataValue !== null) {
          node.dataset[dataKey] = String(dataValue);
        }
      }
      continue;
    }
    if (key === "style") {
      for (const [styleKey, styleValue] of Object.entries(value)) {
        node.style.setProperty(styleKey, styleValue);
      }
      continue;
    }
    if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
      continue;
    }
    if (key === "for") {
      node.htmlFor = String(value);
      continue;
    }
    if (["checked", "disabled", "required", "readOnly", "selected", "open", "hidden", "multiple"].includes(key)) {
      node[key] = Boolean(value);
      continue;
    }
    if (key === "value") {
      node.value = value;
      continue;
    }
    if (["type", "min", "max", "step", "name", "id", "rows", "placeholder", "title", "autocomplete", "spellcheck"].includes(key)) {
      node.setAttribute(key, String(value));
      continue;
    }
    if (key === "href") {
      node.setAttribute("href", String(value));
      continue;
    }
    node.setAttribute(key, value === true ? "" : String(value));
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

function selectControl(options, value, props = {}) {
  const select = h("select", props, ...options.map((option) => h("option", { value: option.value }, option.label)));
  select.value = value;
  return select;
}

function str(value) {
  return value === null || value === undefined ? "" : String(value);
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function unique(list) {
  return [...new Set(list)];
}

function parseLines(text) {
  return str(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function arrayToLines(value) {
  if (Array.isArray(value)) return value.map((item) => str(item)).join("\n");
  return str(value);
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeId(value) {
  return str(value).replace(/[^a-zA-Z0-9_-]/g, "-");
}

function findAllData(name) {
  return Array.from(document.querySelectorAll(`[data-${name}]`));
}

function findByData(name, value) {
  const datasetKey = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  return findAllData(name).find((node) => node.dataset[datasetKey] === String(value)) || null;
}

function eachByData(name, callback) {
  for (const node of findAllData(name)) callback(node);
}

function fmtTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return str(value);
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function fmtFullTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return str(value);
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function shortRev(value) {
  const text = str(value);
  if (!text) return "—";
  return text.length > 24 ? `${text.slice(0, 20)}…${text.slice(-6)}` : text;
}

function truncate(text, limit = 4000) {
  const value = str(text);
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function stateLabel(state) {
  if (STATE_LABELS[state]) return STATE_LABELS[state];
  return state ? `待识别状态：${state}` : "状态未知";
}

function stateTone(state) {
  return STATE_TONES[state] || "";
}

function runStatusLabel(status) {
  return RUN_STATUS_LABELS[status] || (status ? `待识别状态：${status}` : "状态未知");
}

function runStatusTone(status) {
  return RUN_STATUS_TONES[status] || "";
}

function eventKindLabel(kind) {
  return EVENT_KIND_LABELS[kind] || (kind ? String(kind) : "事件");
}

function verdictLabel(verdict) {
  if (verdict === "approved") return "通过";
  if (verdict === "changes_requested") return "要求修改";
  return verdict ? `待识别结论：${verdict}` : "未记录";
}

function verdictTone(verdict) {
  if (verdict === "approved") return "is-ok";
  if (verdict === "changes_requested") return "is-danger";
  return "";
}

function evidenceTone(status) {
  const value = str(status).toLowerCase();
  if (["passed", "pass", "ok", "success", "succeeded"].includes(value)) return "is-ok";
  if (["failed", "fail", "error", "failure"].includes(value)) return "is-danger";
  return "";
}

function evidenceLabel(status) {
  const value = str(status);
  const lower = value.toLowerCase();
  if (lower === "passed" || lower === "pass") return "通过";
  if (lower === "failed" || lower === "fail" || lower === "failure") return "失败";
  if (lower === "not_run" || lower === "skipped") return "未运行";
  if (lower === "ok") return "正常";
  if (lower === "success" || lower === "succeeded") return "成功";
  if (lower === "error") return "错误";
  return value || "状态未记录";
}

function safeHttpUrl(raw) {
  const text = str(raw).trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function externalLink(raw, label) {
  const href = safeHttpUrl(raw);
  if (!href) {
    return h("span", { class: "muted" }, raw ? `链接无效：${str(raw)}` : "未提供链接");
  }
  return h("a", { href, target: "_blank", rel: "noopener noreferrer" }, label || href);
}

function hasToken() {
  return typeof ui.token === "string" && ui.token.length > 0;
}

function ensureToken() {
  if (hasToken()) return true;
  setNotice("danger", "尚未取得本地会话令牌，请等待状态刷新后重试。");
  render();
  return false;
}

function setNotice(tone, text) {
  ui.notice = { tone, text };
}

function describeError(error) {
  if (error instanceof ApiError) {
    let message = error.message || `请求失败（HTTP ${error.status}）`;
    if (error.status === 409) {
      message = `版本或状态已变化，操作未执行。${error.message ? ` ${error.message}` : ""}`;
    }
    return error.code ? `${message}（${error.code}）` : message;
  }
  if (error instanceof TypeError) {
    return `无法连接本地工作台服务：${error.message}`;
  }
  return error && error.message ? String(error.message) : String(error);
}

const SENSITIVE_KEY = /(token|secret|passw|credential|authorization|api[-_]?key|stack|reasoning|prompt)/i;

function redact(value, depth = 0) {
  if (depth > 6) return "[层级过深]";
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = SENSITIVE_KEY.test(key) ? "[已隐藏]" : redact(item, depth + 1);
    }
    return result;
  }
  if (typeof value === "string" && value.length > 4000) return `${value.slice(0, 4000)}…`;
  return value;
}

function pretty(value) {
  try {
    return JSON.stringify(redact(value), null, 2);
  } catch {
    return String(value);
  }
}

function renderValue(value, depth = 0) {
  if (value === null || value === undefined) return h("span", { class: "muted" }, "—");
  if (typeof value === "string") return h("span", { class: "value-text" }, truncate(value));
  if (typeof value === "number" || typeof value === "boolean") return h("span", { class: "mono" }, String(value));
  if (Array.isArray(value)) {
    if (!value.length) return h("span", { class: "muted" }, "（空）");
    if (depth >= 3) return h("pre", { class: "pre" }, pretty(value));
    return h("ul", { class: "value-list" }, ...value.map((item) => h("li", {}, renderValue(item, depth + 1))));
  }
  if (typeof value === "object") {
    if (depth >= 3) return h("pre", { class: "pre" }, pretty(value));
    const entries = Object.entries(value);
    if (!entries.length) return h("span", { class: "muted" }, "（空）");
    return h(
      "dl",
      { class: "value-dl" },
      ...entries.flatMap(([key, item]) => [h("dt", {}, key), h("dd", {}, renderValue(item, depth + 1))]),
    );
  }
  return h("span", {}, String(value));
}

function textBlock(value) {
  if (value === null || value === undefined || value === "") return h("span", { class: "muted" }, "—");
  if (typeof value === "string") return h("div", { class: "text-block" }, truncate(value));
  return renderValue(value);
}

function badge(label, tone = "", mono = false) {
  return h("span", { class: `badge ${tone}${mono ? " is-mono" : ""}`.trim() }, label);
}

function fieldWrap(labelText, control, hintText, options = {}) {
  const id = control.id || options.id;
  return h(
    "div",
    { class: `field ${options.className || ""}`.trim() },
    h("label", { for: id, class: options.labelClass || "" }, labelText),
    hintText ? h("p", { class: "hint" }, hintText) : null,
    control,
  );
}

function actionBtn(label, key, onClick, options = {}) {
  const pending = key ? ui.pending.has(key) : false;
  return h(
    "button",
    {
      type: "button",
      class: ["btn", options.variant ? `btn-${options.variant}` : "", options.size === "small" ? "btn-small" : ""]
        .filter(Boolean)
        .join(" "),
      disabled: Boolean(options.disabled) || pending,
      title: options.title || undefined,
      dataset: options.dataset,
      onclick: pending ? undefined : onClick,
    },
    pending ? options.pendingLabel || "处理中…" : label,
  );
}

function snapshotFocus() {
  const node = document.activeElement;
  if (!node || !(node instanceof HTMLElement) || !node.dataset || !node.dataset.focus) return null;
  let start = null;
  let end = null;
  try {
    if (typeof node.selectionStart === "number") {
      start = node.selectionStart;
      end = node.selectionEnd;
    }
  } catch {
    // select 等控件不支持 selectionStart。
  }
  return { key: node.dataset.focus, start, end, scrollTop: node.scrollTop };
}

function focusByKey(key) {
  if (!key) return null;
  return Array.from(document.querySelectorAll("[data-focus]")).find((node) => node.dataset.focus === key) || null;
}

function restoreFocus(snapshot) {
  if (!snapshot) return;
  const node = focusByKey(snapshot.key);
  if (!node) return;
  node.focus({ preventScroll: true });
  if (snapshot.start !== null && typeof node.setSelectionRange === "function") {
    try {
      node.setSelectionRange(snapshot.start, snapshot.end);
    } catch {
      // 某些 input 类型不支持设置选区。
    }
  }
  if (snapshot.scrollTop) node.scrollTop = snapshot.scrollTop;
}

function detailSection(key, defaultOpen, summary, ...body) {
  return h(
    "details",
    {
      class: "disclosure",
      open: ui.open.has(key) ? Boolean(ui.open.get(key)) : defaultOpen,
      ontoggle: (event) => ui.open.set(key, event.currentTarget.open),
    },
    h("summary", {}, summary),
    ...body,
  );
}

/* ---------------- 数据读取与选择 ---------------- */

function candidatesAll() {
  return Array.isArray(ui.data?.candidates) ? ui.data.candidates : [];
}

function runsAll() {
  return Array.isArray(ui.data?.runs) ? ui.data.runs : [];
}

function eventsAll() {
  return Array.isArray(ui.data?.events) ? ui.data.events : [];
}

function candidateById(id) {
  if (!id) return null;
  return candidatesAll().find((candidate) => candidate.id === id) || null;
}

function runById(id) {
  if (!id) return null;
  return runsAll().find((run) => run.id === id) || null;
}

function issueRepo(candidate) {
  return str(candidate?.issue?.repo);
}

function runRepo(run) {
  if (run?.repo) return str(run.repo);
  const candidate = candidateById(run?.candidateId);
  if (candidate && issueRepo(candidate)) return issueRepo(candidate);
  const ref = str(run?.issueRef);
  return ref.includes("#") ? ref.split("#")[0] : "";
}

function eventRepo(event) {
  if (event?.repo) return str(event.repo);
  const candidate = candidateById(event?.candidateId);
  if (candidate && issueRepo(candidate)) return issueRepo(candidate);
  const run = runById(event?.runId);
  return run ? runRepo(run) : "";
}

function repoOptions() {
  const repos = new Set();
  const configured = Array.isArray(ui.data?.settings?.repositories) ? ui.data.settings.repositories : [];
  for (const repository of configured) {
    if (repository && repository.repo) repos.add(str(repository.repo));
  }
  for (const candidate of candidatesAll()) {
    const repo = issueRepo(candidate);
    if (repo) repos.add(repo);
  }
  for (const run of runsAll()) {
    const repo = runRepo(run);
    if (repo) repos.add(repo);
  }
  return [...repos].sort((a, b) => a.localeCompare(b));
}

function inRepoScope(repo) {
  return !ui.repoFilter || repo === ui.repoFilter;
}

function filterReasons(candidate) {
  return stringList(candidate?.filter?.reasons);
}

function eligibilityReasons(candidate) {
  return unique(stringList(candidate?.eligibility?.reasons));
}

function filteredCandidates() {
  let list = candidatesAll();
  if (ui.repoFilter) list = list.filter((candidate) => issueRepo(candidate) === ui.repoFilter);
  if (ui.candidateScope === "matched") list = list.filter((candidate) => candidate.filter?.matched !== false);
  if (ui.candidateScope === "excluded") list = list.filter((candidate) => candidate.filter?.matched === false);
  return list;
}

function acceptanceCandidates() {
  return candidatesAll().filter((candidate) => {
    if (!inRepoScope(issueRepo(candidate))) return false;
    return Boolean(candidate.latestResult) || ["awaiting_acceptance", "completed"].includes(candidate.state);
  });
}

function filteredAcceptanceCandidates() {
  return acceptanceCandidates().sort((a, b) => {
    const rank = (candidate) => (candidate.state === "awaiting_acceptance" ? 0 : 1);
    return rank(a) - rank(b) || str(b.updatedAt).localeCompare(str(a.updatedAt));
  });
}

function runsForCandidate(id) {
  return runsAll()
    .filter((run) => run.candidateId === id)
    .sort((a, b) => str(b.updatedAt).localeCompare(str(a.updatedAt)));
}

function sortedEvents() {
  return eventsAll()
    .slice()
    .sort((a, b) => {
      const timeA = Date.parse(a?.at) || 0;
      const timeB = Date.parse(b?.at) || 0;
      if (timeA !== timeB) return timeB - timeA;
      return str(b?.id).localeCompare(str(a?.id));
    });
}

function templateOptions(current) {
  const list = Array.isArray(ui.data?.templates) ? ui.data.templates : [];
  const options = [];
  for (const template of list) {
    if (typeof template === "string") {
      options.push({ value: template, label: template });
      continue;
    }
    if (!template || typeof template !== "object") continue;
    const id = template.id ?? template.templateId ?? template.name;
    if (!id) continue;
    const extra = [template.version ? `v${template.version}` : "", template.title ?? template.label ?? ""]
      .filter(Boolean)
      .join(" · ");
    options.push({ value: String(id), label: extra ? `${id} · ${extra}` : String(id) });
  }
  if (current && !options.some((option) => option.value === current)) {
    options.unshift({ value: current, label: `${current}（当前）` });
  }
  return options;
}

function ensureSelection() {
  let list = null;
  if (ui.view === "candidates") list = filteredCandidates();
  if (ui.view === "acceptance") list = filteredAcceptanceCandidates();
  if (!list) return;
  if (!list.some((candidate) => candidate.id === ui.selectedId)) {
    ui.selectedId = list.length ? list[0].id : null;
  }
}

/* ---------------- 状态同步 ---------------- */

function normalizeSettings(settings) {
  const source = settings && typeof settings === "object" ? settings : {};
  const rules = source.rules && typeof source.rules === "object" ? source.rules : {};
  const concurrency = source.concurrency && typeof source.concurrency === "object" ? source.concurrency : {};
  return {
    repositories: Array.isArray(source.repositories)
      ? source.repositories
          .filter((repository) => repository && typeof repository === "object")
          .map((repository) => ({
            repo: str(repository.repo),
            localPath: str(repository.localPath),
            baseRef: str(repository.baseRef) || "HEAD",
          }))
      : [],
    rules: {
      repositories: stringList(rules.repositories),
      labels: stringList(rules.labels),
      authors: stringList(rules.authors),
      keywords: stringList(rules.keywords),
      states: stringList(rules.states),
    },
    concurrency: {
      global: finiteNumber(concurrency.global, 2),
      perRepo: finiteNumber(concurrency.perRepo, 2),
    },
  };
}

function editableSettings(settings) {
  const normalized = normalizeSettings(settings);
  return {
    repositories: normalized.repositories.map((repository) => ({ ...repository })),
    rules: {
      repositories: normalized.rules.repositories.join("\n"),
      labels: normalized.rules.labels.join("\n"),
      authors: normalized.rules.authors.join("\n"),
      keywords: normalized.rules.keywords.join("\n"),
      states: normalized.rules.states.slice(),
    },
    concurrency: {
      global: String(normalized.concurrency.global),
      perRepo: String(normalized.concurrency.perRepo),
    },
  };
}

function initSettings(settings) {
  const values = editableSettings(settings);
  ui.settings = {
    values,
    baseValues: clonePlain(values),
    dirty: false,
    stale: false,
    error: null,
  };
}

function syncSettingsState() {
  const serverValues = editableSettings(ui.data?.settings);
  if (!ui.settings) {
    initSettings(ui.data?.settings);
    return;
  }
  const state = ui.settings;
  const serverChanged = JSON.stringify(serverValues) !== JSON.stringify(state.baseValues);
  if (!state.dirty) {
    if (serverChanged) initSettings(ui.data?.settings);
    return;
  }
  if (serverChanged) state.stale = true;
}

function draftValuesFromServer(draft) {
  return {
    goal: str(draft?.goal),
    scope: str(draft?.scope),
    acceptance: arrayToLines(draft?.acceptance),
    context: str(draft?.context),
    pendingDecisions: arrayToLines(draft?.pendingDecisions),
    templateId: str(draft?.templateId),
    priority: String(draft?.priority ?? 0),
    dependsOn: arrayToLines(draft?.dependsOn),
    writeScopes: arrayToLines(draft?.writeScopes),
  };
}

function initDraftEntry(draft) {
  const values = draftValuesFromServer(draft);
  return {
    values,
    baseValues: clonePlain(values),
    baseRev: draft?.rev || null,
    version: draft?.version ?? null,
    requirementsRev: draft?.requirementsRev || null,
    dirty: false,
    stale: false,
    conflict: false,
    serverGone: false,
    savedPending: false,
    error: null,
  };
}

function syncDraftStates() {
  const known = new Set();
  for (const candidate of candidatesAll()) {
    if (!candidate || !candidate.id) continue;
    known.add(candidate.id);
    const serverDraft = candidate.draft;
    const existing = ui.drafts.get(candidate.id);
    if (!serverDraft) {
      if (existing && existing.dirty) {
        existing.serverGone = true;
        existing.stale = true;
        existing.serverRev = null;
      } else {
        ui.drafts.delete(candidate.id);
      }
      continue;
    }
    const serverValues = draftValuesFromServer(serverDraft);
    if (!existing) {
      ui.drafts.set(candidate.id, initDraftEntry(serverDraft));
      continue;
    }
    const serverChanged =
      existing.baseRev !== (serverDraft.rev || null) ||
      JSON.stringify(existing.baseValues) !== JSON.stringify(serverValues);
    if (!existing.dirty) {
      if (serverChanged) ui.drafts.set(candidate.id, initDraftEntry(serverDraft));
      continue;
    }
    if (existing.savedPending) {
      ui.drafts.set(candidate.id, initDraftEntry(serverDraft));
      continue;
    }
    if (serverChanged) {
      existing.stale = true;
      existing.serverRev = serverDraft.rev || null;
      existing.serverGone = false;
    }
  }
  for (const id of [...ui.drafts.keys()]) {
    if (!known.has(id)) ui.drafts.delete(id);
  }
}

function acceptanceEntry(candidate) {
  let entry = ui.acceptance.get(candidate.id);
  if (!entry) {
    entry = {
      headSha: "",
      prHead: "",
      headTouched: false,
      userComment: "",
      designComment: "",
      method: "merge",
      confirmed: false,
    };
    ui.acceptance.set(candidate.id, entry);
  }
  return entry;
}

function syncAcceptanceInputs() {
  for (const candidate of candidatesAll()) {
    if (!candidate || !candidate.id) continue;
    const entry = acceptanceEntry(candidate);
    const pr = candidate.latestResult?.pr;
    const head = str(pr?.headSha);
    if (entry.prHead !== head) {
      entry.prHead = head;
      entry.confirmed = false;
    }
    if (!entry.headTouched && entry.headSha !== head) {
      entry.headSha = head;
    }
  }
}

function applyState(data) {
  if (!data || typeof data !== "object") throw new ApiError(0, "状态响应不是 JSON 对象");
  ui.data = data;
  if (typeof data.csrfToken === "string" && data.csrfToken) ui.token = data.csrfToken;
  if (ui.repoFilter && !repoOptions().includes(ui.repoFilter)) ui.repoFilter = "";
  ui.loadError = null;
  ui.lastSyncAt = new Date();
  ui.loading = false;
  syncSettingsState();
  syncDraftStates();
  syncAcceptanceInputs();
  ensureSelection();
}

async function api(path, options = {}) {
  if (!hasToken()) throw new ApiError(0, "缺少本地会话令牌，请等待状态刷新。");
  const method = options.method || "POST";
  const response = await fetch(path, {
    method,
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Auto-AI-Token": ui.token,
    },
    body: JSON.stringify(options.body ?? {}),
  });
  let payload = null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    payload = await response.json().catch(() => null);
  }
  if (!response.ok) {
    const detail = payload && typeof payload === "object" ? payload.error : null;
    throw new ApiError(
      response.status,
      detail?.message || `请求失败（HTTP ${response.status}）`,
      detail,
    );
  }
  return payload && typeof payload === "object" ? payload : {};
}

function refreshState(force = false) {
  if (ui.refreshPromise) {
    if (!force) return ui.refreshPromise;
    return ui.refreshPromise.then(() => refreshState(true));
  }
  const startedAt = Date.now();
  const promise = (async () => {
    try {
      const response = await fetch("/api/state", {
        method: "GET",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok) {
        throw new ApiError(
          response.status,
          payload?.error?.message || `无法读取工作台状态（HTTP ${response.status}）`,
          payload?.error,
        );
      }
      if (startedAt < ui.lastMutationAt) return;
      applyState(payload);
    } catch (error) {
      if (startedAt >= ui.lastMutationAt) ui.loadError = describeError(error);
    } finally {
      ui.loading = false;
      ui.refreshPromise = null;
      render();
    }
  })();
  ui.refreshPromise = promise;
  return promise;
}

async function runAction(key, action) {
  if (ui.pending.has(key)) return;
  ui.pending.add(key);
  ui.errors.delete(key);
  render();
  try {
    const result = await action();
    ui.lastMutationAt = Date.now();
    await refreshState(true);
    return result;
  } catch (error) {
    ui.errors.set(key, describeError(error));
    if (error instanceof ApiError && error.status === 409) {
      handleConflict(key);
      await refreshState(true);
    }
    render();
    return null;
  } finally {
    ui.pending.delete(key);
    render();
  }
}

function handleConflict(key) {
  if (key.startsWith("draft-save:")) {
    const id = key.slice("draft-save:".length);
    const entry = ui.drafts.get(id);
    if (entry) {
      entry.conflict = true;
      entry.error = "任务稿版本已被更新，当前未保存内容已保留。请核对后采用服务端 rev 再保存，或放弃本地修改。";
    }
  }
  if (key === "settings-save") {
    const state = ui.settings;
    if (state) {
      state.stale = true;
      state.error = "设置已在其他位置更新，当前未保存内容已保留。请核对后重新保存。";
    }
  }
}

/* ---------------- 渲染入口 ---------------- */

function render() {
  const focus = snapshotFocus();
  renderTopbar();
  renderBanner();
  renderSidebar();
  renderMain();
  restoreFocus(focus);
}

function renderTopbar() {
  const scope = document.querySelector("#scope-line");
  if (scope) {
    if (ui.repoFilter) scope.textContent = `当前仓库：${ui.repoFilter}`;
    else if (ui.data) scope.textContent = `当前范围：全部仓库（${repoOptions().length} 个）`;
    else scope.textContent = "正在连接本地工作台…";
  }
  const top = document.querySelector("#top-controls");
  if (!top) return;
  top.replaceChildren();

  const connected = Boolean(ui.data) && !ui.loadError;
  top.append(
    h(
      "span",
      {
        class: `top-status ${ui.loadError ? "is-bad" : connected ? "is-ok" : ""}`.trim(),
        title: ui.loadError || (ui.lastSyncAt ? `上次同步：${fmtFullTime(ui.lastSyncAt)}` : ""),
      },
      h("span", { class: "status-dot", "aria-hidden": "true" }),
      ui.loadError ? "未连接" : connected ? `已连接 · ${fmtTime(ui.lastSyncAt)}` : "连接中…",
    ),
  );

  if (ui.data) {
    top.append(capabilityChip("GitHub", ui.data.capabilities?.githubReady));
    top.append(capabilityChip("Pi", ui.data.capabilities?.piReady));
  }

  top.append(
    h(
      "button",
      {
        type: "button",
        class: "btn btn-small",
        disabled: Boolean(ui.refreshPromise),
        title: "立即读取最新状态",
        onclick: () => {
          refreshState(true);
          render();
        },
      },
      ui.refreshPromise ? "刷新中…" : "刷新",
    ),
  );

  const githubBlocked = ui.data?.capabilities?.githubReady === false;
  top.append(
    h(
      "button",
      {
        type: "button",
        class: "btn btn-primary btn-small",
        disabled: !hasToken() || githubBlocked || ui.pending.has("collect"),
        title: githubBlocked
          ? "GitHub 未就绪，无法收集 Issue"
          : !hasToken()
            ? "等待本地会话令牌"
            : "启动一次 Issue 收集",
        onclick: collectAction,
      },
      ui.pending.has("collect") ? "收集中…" : "收集 Issue",
    ),
  );

  const runtime = ui.data?.runtime || {};
  top.append(
    h(
      "label",
      { class: "switch" },
      h("input", {
        type: "checkbox",
        role: "switch",
        checked: Boolean(runtime.watching),
        disabled: !hasToken() || ui.pending.has("watch"),
        "aria-label": "自动监督",
        title: runtime.lastPollAt ? `上次收集：${fmtFullTime(runtime.lastPollAt)}` : "尚无收集记录",
        onchange: (event) => watchAction(event.target.checked, readIntervalValue()),
      }),
      h(
        "span",
        { title: runtime.lastPollAt ? `上次收集：${fmtFullTime(runtime.lastPollAt)}` : "尚无收集记录" },
        runtime.watching ? "自动监督：开" : "自动监督：关",
      ),
    ),
  );

  top.append(
    h(
      "label",
      { class: "interval-field" },
      h("span", {}, "间隔"),
      h("input", {
        type: "number",
        min: "1",
        step: "1",
        value: String(runtime.intervalSeconds ?? 60),
        disabled: !hasToken() || ui.pending.has("watch"),
        "aria-label": "监督间隔（秒）",
        dataset: { focus: "watch-interval" },
        onchange: (event) => changeInterval(event.target.value),
      }),
      h("span", {}, "秒"),
    ),
  );

  if (Array.isArray(runtime.activeDrafts) && runtime.activeDrafts.length) {
    top.append(h("span", { class: "chip is-ok", title: "正在整理需求任务稿" }, `整理中 ${runtime.activeDrafts.length}`));
  }
}

function capabilityChip(label, ready) {
  return h(
    "span",
    {
      class: `chip ${ready === true ? "is-ok" : ready === false ? "is-bad" : ""}`.trim(),
      title: ready === false ? `${label} 未就绪，相关操作可能不可用` : `${label} 能力状态`,
    },
    h("span", { class: "dot", "aria-hidden": "true" }),
    `${label} ${ready === true ? "就绪" : ready === false ? "未就绪" : "未知"}`,
  );
}

function readIntervalValue() {
  const input = findByData("focus", "watch-interval");
  return input ? input.value : String(ui.data?.runtime?.intervalSeconds ?? 60);
}

function renderBanner() {
  const region = document.querySelector("#banner-region");
  if (!region) return;
  region.replaceChildren();

  if (ui.loadError) {
    region.append(
      bannerCard(
        "danger",
        "无法连接工作台服务",
        [
          ui.loadError,
          ui.data ? "当前显示的是上次成功读取的数据；写操作请先恢复连接。" : "请确认本地服务已启动，并通过同源地址访问此页面。",
        ],
        [actionBtn("重试连接", null, () => {
          refreshState(true);
          render();
        }, { size: "small" })],
      ),
    );
  } else if (ui.notice) {
    region.append(
      bannerCard(ui.notice.tone || "ok", null, [ui.notice.text], [
        h(
          "button",
          {
            type: "button",
            class: "btn btn-small",
            onclick: () => {
              ui.notice = null;
              render();
            },
          },
          "关闭",
        ),
      ]),
    );
  }

  const actionError = ui.errors.get("collect") || ui.errors.get("watch");
  if (actionError && !ui.loadError) {
    region.append(bannerCard("danger", "操作未完成", [actionError], []));
  }

  if (ui.data && !ui.loadError) {
    const messages = [];
    if (ui.data.capabilities?.githubReady === false) {
      messages.push("GitHub 未就绪：检查本机 GitHub 凭据与仓库访问配置。");
    }
    if (ui.data.capabilities?.piReady === false) {
      messages.push("Pi 未就绪：检查 Pi CLI 与 deepseek-flash 模型配置。");
    }
    if (!repoOptions().length) {
      messages.push("尚未配置仓库：前往“规则”添加至少一个仓库，否则不会收集任何 Issue。");
    }
    if (messages.length) {
      region.append(
        h(
          "div",
          { class: "banner is-warn" },
          h(
            "div",
            { class: "banner-body" },
            h("p", {}, "环境提示"),
            h("ul", {}, ...messages.map((message) => h("li", {}, message))),
          ),
          h(
            "div",
            { class: "banner-actions" },
            !repoOptions().length
              ? actionBtn("前往规则", null, () => switchView("settings"), { variant: "quiet", size: "small" })
              : null,
          ),
        ),
      );
    }
  }
}

function bannerCard(tone, title, lines, actions) {
  return h(
    "div",
    { class: `banner ${tone === "danger" ? "is-danger" : tone === "warn" ? "is-warn" : "is-ok"}` },
    h(
      "div",
      { class: "banner-body" },
      title ? h("p", {}, h("strong", {}, title)) : null,
      ...lines.filter(Boolean).map((line) => h("p", {}, line)),
    ),
    actions && actions.length ? h("div", { class: "banner-actions" }, ...actions) : null,
  );
}

function renderSidebar() {
  const sidebar = document.querySelector("#sidebar");
  if (!sidebar) return;
  sidebar.replaceChildren();

  const activeRuns = runsAll().filter((run) => ["running", "blocked"].includes(run.status));
  const counts = {
    candidates: candidatesAll().length,
    runs: activeRuns.length,
    acceptance: candidatesAll().filter(
      (candidate) =>
        Boolean(candidate.latestResult) || ["awaiting_acceptance", "completed"].includes(candidate.state),
    ).length,
  };

  const navList = h(
    "ul",
    { class: "nav-list" },
    ...VIEWS.map((view) =>
      h(
        "li",
        {},
        h(
          "button",
          {
            type: "button",
            class: "nav-button",
            "aria-current": ui.view === view.id ? "page" : undefined,
            onclick: () => switchView(view.id),
          },
          h("span", {}, view.label),
          typeof counts[view.id] === "number" ? h("span", { class: "nav-count" }, String(counts[view.id])) : null,
        ),
      ),
    ),
  );

  const repoButtons = repoOptions().map((repo) => {
    const count = candidatesAll().filter((candidate) => issueRepo(candidate) === repo).length;
    return h(
      "li",
      {},
      h(
        "button",
        {
          type: "button",
          class: "repo-button",
          "aria-pressed": ui.repoFilter === repo ? "true" : "false",
          title: repo,
          onclick: () => setRepoFilter(repo),
        },
        h("span", { class: "repo-name" }, repo),
        h("span", { class: "repo-count" }, String(count)),
      ),
    );
  });

  sidebar.append(
    h(
      "nav",
      { "aria-label": "主要视图" },
      h(
        "div",
        { class: "nav-group" },
        h("p", { class: "nav-heading" }, h("span", {}, "工作区")),
        navList,
      ),
      h(
        "div",
        { class: "nav-group" },
        h("p", { class: "nav-heading" }, h("span", {}, "仓库筛选")),
        h(
          "ul",
          { class: "nav-list repo-list" },
          h(
            "li",
            {},
            h(
              "button",
              {
                type: "button",
                class: "repo-button",
                "aria-pressed": ui.repoFilter ? "false" : "true",
                onclick: () => setRepoFilter(""),
              },
              h("span", { class: "repo-name" }, "全部仓库"),
              h("span", { class: "repo-count" }, String(candidatesAll().length)),
            ),
          ),
          ...repoButtons,
        ),
        repoOptions().length
          ? h("p", { class: "sidebar-note" }, "筛选作用于需求、执行与验收。")
          : h(
              "p",
              { class: "sidebar-note" },
              "尚未配置仓库。",
              h("br"),
              h(
                "button",
                { type: "button", class: "btn btn-small", onclick: () => switchView("settings") },
                "前往规则",
              ),
            ),
      ),
    ),
  );
}

function renderMain() {
  const main = document.querySelector("#main");
  if (!main) return;
  main.replaceChildren();

  if (ui.loading && !ui.data) {
    main.append(h("div", { class: "loading-state", role: "status" }, "正在读取工作台状态…"));
    return;
  }

  if (!ui.data) {
    main.append(
      h(
        "div",
        { class: "empty-state" },
        h("h3", {}, "无法读取工作台状态"),
        h("p", {}, "前端不会生成假任务。请确认同源的本地工作台服务已启动，然后重试连接。"),
        h(
          "button",
          { type: "button", class: "btn", onclick: () => refreshState(true) },
          "重试连接",
        ),
      ),
    );
    return;
  }

  ensureSelection();
  if (ui.view === "runs") main.append(renderRunsView());
  else if (ui.view === "acceptance") main.append(renderAcceptanceView());
  else if (ui.view === "settings") main.append(renderSettingsView());
  else main.append(renderCandidatesView());
}

function switchView(view) {
  ui.view = view;
  ensureSelection();
  render();
}

function setRepoFilter(repo) {
  ui.repoFilter = repo;
  ensureSelection();
  render();
}

function selectCandidate(id) {
  ui.selectedId = id;
  ui.view = "candidates";
  render();
}

function openAcceptance(id) {
  ui.selectedId = id;
  ui.view = "acceptance";
  render();
}

/* ---------------- 需求视图 ---------------- */

function renderCandidatesView() {
  const section = h("section", { class: "view", "aria-labelledby": "candidates-title" });
  const all = candidatesAll();
  const scoped = all.filter((candidate) => inRepoScope(issueRepo(candidate)));
  const list = filteredCandidates();

  section.append(
    h(
      "div",
      { class: "view-header" },
      h(
        "div",
        {},
        h("h2", { id: "candidates-title" }, "需求审阅"),
        h("p", { class: "view-sub" }, "规则命中只进入候选池；开发确认只针对已保存的任务稿版本，确认后由监督循环自动安排执行。"),
      ),
      h(
        "div",
        { class: "view-actions" },
        actionBtn("刷新状态", null, () => {
          refreshState(true);
          render();
        }, { size: "small" }),
      ),
    ),
  );

  if (!repoOptions().length && !all.length) {
    section.append(
      h(
        "div",
        { class: "empty-state" },
        h("h3", {}, "尚未配置仓库与规则"),
        h("p", {}, "按以下步骤开始；规则命中只会进入候选池，不等于开发授权。"),
        h(
          "ol",
          { class: "step-list" },
          h("li", {}, "在“规则”添加仓库（owner/repo、基准引用；本机路径可暂留空）并设置标签、作者、关键词或状态条件。"),
          h("li", {}, "保存设置后点击顶部“收集 Issue”，从事件中确认各仓库结果。"),
          h("li", {}, "在需求详情请求只读整理任务稿，核对并保存，处理待决策事项。"),
          h("li", {}, "确认开发；监督循环自动领取，执行完成后在“验收”记录用户与设计监督结论。"),
        ),
        h(
          "button",
          { type: "button", class: "btn btn-primary", onclick: () => switchView("settings") },
          "第一步：前往规则配置",
        ),
      ),
    );
    return section;
  }

  const listPane = h(
    "div",
    { class: "pane list-pane" },
    h(
      "div",
      { class: "pane-head" },
      h("h3", {}, "候选需求"),
      h("span", { class: "count" }, `${list.length} / ${scoped.length}`),
      h(
        "div",
        { class: "pane-tools" },
        h(
          "label",
          { for: "candidate-scope" },
          "显示",
        ),
        selectControl(
          [
            { value: "all", label: "全部观测" },
            { value: "matched", label: "仅命中" },
            { value: "excluded", label: "仅排除" },
          ],
          ui.candidateScope,
          {
            id: "candidate-scope",
            onchange: (event) => {
              ui.candidateScope = event.target.value;
              ensureSelection();
              render();
            },
          },
        ),
      ),
    ),
    list.length
      ? h(
          "ul",
          { class: "candidate-list", "aria-label": "候选需求列表" },
          ...list.map((candidate) => renderCandidateItem(candidate)),
        )
      : h(
          "div",
          { class: "empty-state", style: { margin: "12px", border: "1px dashed var(--line)" } },
          h("h3", {}, list.length ? "没有符合筛选的需求" : "暂无候选需求"),
          h(
            "p",
            {},
            all.length
              ? "调整上方显示条件，或切换仓库范围。"
              : "检查规则与连接状态，然后点击顶部“收集 Issue”。",
          ),
        ),
    h(
      "div",
      { class: "list-footer" },
      `命中 ${scoped.filter((candidate) => candidate.filter?.matched !== false).length} · 排除 ${
        scoped.filter((candidate) => candidate.filter?.matched === false).length
      } · 规则命中不等于开发授权`,
    ),
  );

  const selected = list.find((candidate) => candidate.id === ui.selectedId) || null;
  const detailPane = h("div", { class: "pane detail-pane" }, renderCandidateDetail(selected));

  section.append(h("div", { class: "candidates-layout" }, listPane, detailPane));
  return section;
}

function renderCandidateItem(candidate) {
  const matched = candidate.filter?.matched !== false;
  const reasons = filterReasons(candidate);
  const reasonText = matched
    ? reasons[0] || "已命中规则（未提供具体原因）"
    : `排除：${reasons[0] || "后端未提供排除原因"}`;
  const more = reasons.length > 1 ? `（另有 ${reasons.length - 1} 条）` : "";
  return h(
    "li",
    {},
    h(
      "button",
      {
        type: "button",
        class: "candidate-item",
        "aria-current": ui.selectedId === candidate.id ? "true" : "false",
        onclick: () => selectCandidate(candidate.id),
      },
      h(
        "span",
        { class: "candidate-topline" },
        h("span", { class: "repo" }, issueRepo(candidate)),
        badge(stateLabel(candidate.state), stateTone(candidate.state)),
      ),
      h("span", { class: "candidate-title" }, candidate.issue?.title || "（Issue 无标题）"),
      h(
        "span",
        { class: `candidate-reason ${matched ? "" : "is-excluded"}`.trim() },
        `${reasonText}${more}`,
      ),
      h(
        "span",
        { class: "candidate-meta" },
        h("span", {}, candidate.issue?.number !== undefined ? `#${candidate.issue.number}` : "编号未知"),
        h("span", {}, fmtTime(candidate.updatedAt)),
      ),
    ),
  );
}

function renderCandidateDetail(candidate) {
  if (!candidate) {
    return h(
      "div",
      { class: "empty-state" },
      h("h3", {}, "选择一个候选需求"),
      h("p", {}, "左侧列表显示来源仓库、状态与规则命中/排除原因。"),
    );
  }

  const issue = candidate.issue || {};
  const matched = candidate.filter?.matched !== false;
  const reasons = filterReasons(candidate);
  const eligibility = eligibilityReasons(candidate);
  const draft = candidate.draft;
  const draftEntry = ui.drafts.get(candidate.id) || null;
  const editable = matched && EDITABLE_DRAFT_STATES.has(candidate.state);

  const container = h("div", { class: "candidate-detail" });

  container.append(
    h(
      "div",
      { class: "detail-head" },
      h(
        "div",
        {},
        h("p", { class: "eyebrow" }, `${issueRepo(candidate) || "未知仓库"}#${issue.number ?? "—"}`),
        h("h3", {}, issue.title || "（Issue 无标题）"),
        h(
          "p",
          { class: "detail-meta" },
          badge(stateLabel(candidate.state), stateTone(candidate.state)),
          h("span", {}, candidate.id),
          issue.author ? h("span", {}, `作者 ${issue.author}`) : null,
          issue.state ? h("span", {}, `Issue 状态 ${issue.state}`) : null,
          issue.updatedAt ? h("span", {}, `Issue 更新 ${fmtTime(issue.updatedAt)}`) : null,
          safeHttpUrl(issue.url) ? externalLink(issue.url, "在 GitHub 查看") : null,
        ),
      ),
      h(
        "div",
        { class: "detail-actions" },
        actionBtn(
          candidate.state === "drafting" ? "重新请求整理" : "请求整理任务稿",
          `draft-request:${candidate.id}`,
          () => requestDraft(candidate),
          {
            size: "small",
            disabled: !hasToken() || !matched,
            title: matched ? "只读整理需求，不触发开发" : "该条目未命中收集规则",
          },
        ),
      ),
    ),
  );

  if (ui.errors.get(`draft-request:${candidate.id}`)) {
    container.append(h("p", { class: "form-error" }, ui.errors.get(`draft-request:${candidate.id}`)));
  }

  container.append(
    h(
      "div",
      { class: "section" },
      h(
        "div",
        { class: "section-head" },
        h("h4", {}, "收集与筛选"),
        badge(matched ? "规则命中" : "规则排除", matched ? "is-accent" : "is-warn"),
      ),
      reasons.length
        ? h(
            "ul",
            { class: "reason-list" },
            ...reasons.map((reason) =>
              h(
                "li",
                { class: matched ? "" : "is-excluded" },
                h("span", { class: "mark", "aria-hidden": "true" }, matched ? "✓" : "!"),
                h("span", {}, reason),
              ),
            ),
          )
        : h("p", { class: "hint" }, matched ? "后端未提供具体命中原因。" : "后端未提供具体排除原因。"),
      !matched
        ? h(
            "p",
            { class: "form-warn" },
            "该 Issue 未命中当前规则，仅保留为观测记录。规则命中本身也只是候选，不构成开发授权。",
          )
        : null,
      eligibility.length
        ? h(
            "div",
            { class: "eligibility" },
            "服务端当前派发条件：",
            h("ul", {}, ...eligibility.map((reason) => h("li", {}, reason))),
            h("p", { class: "hint" }, "该条件随决定和调度状态变化；开发按钮以前端已保存的任务稿与当前状态为准。"),
          )
        : null,
    ),
  );

  container.append(
    h(
      "div",
      { class: "section" },
      h("div", { class: "section-head" }, h("h4", {}, "Issue 内容")),
      issue.labels && issue.labels.length
        ? h(
            "div",
            { class: "label-row", "aria-label": "Issue 标签" },
            ...issue.labels.map((label) => h("span", { class: "label-chip" }, str(label))),
          )
        : null,
      h("div", { class: "issue-body" }, str(issue.body) || ""),
      !safeHttpUrl(issue.url) ? h("p", { class: "hint" }, "Issue 链接缺失或不是 http/https，未生成外部链接。") : null,
    ),
  );

  container.append(renderDraftSection(candidate, draft, draftEntry, editable));
  container.append(renderDecisionSection(candidate, draft, draftEntry));
  container.append(renderCandidateProgress(candidate));
  return container;
}

function renderDraftSection(candidate, draft, entry, editable) {
  const section = h("div", { class: "section" });
  const activeDrafts = Array.isArray(ui.data?.runtime?.activeDrafts) ? ui.data.runtime.activeDrafts : [];
  const drafting = candidate.state === "drafting" || activeDrafts.includes(candidate.id);
  section.append(
    h(
      "div",
      { class: "section-head" },
      h("h4", {}, "任务稿"),
      draft
        ? h(
            "span",
            { class: "section-note" },
            `版本 ${draft.version ?? "—"} · rev ${shortRev(draft.rev)}`,
          )
        : entry?.dirty
          ? badge("未保存内容", "is-warn")
          : badge("尚未生成"),
      drafting ? badge("整理中", "is-accent") : null,
    ),
  );

  if (drafting) {
    section.append(
      h(
        "p",
        { class: "hint" },
        "后端正在只读整理任务稿：不会触发开发，也不会替用户作出决定。完成后刷新状态再核对保存。",
      ),
    );
  }

  if (!draft && !(entry && entry.dirty)) {
    section.append(
      h(
        "div",
        { class: "empty-state" },
        h("h3", {}, "还没有可审阅的任务稿"),
        h("p", {}, "请求整理只会读取 Issue 并生成任务稿，不会触发开发。任务稿生成后需要再次核对并保存。"),
        h(
          "button",
          {
            type: "button",
            class: "btn btn-primary",
            disabled: !hasToken() || candidate.filter?.matched !== true || ui.pending.has(`draft-request:${candidate.id}`),
            onclick: () => requestDraft(candidate),
          },
          ui.pending.has(`draft-request:${candidate.id}`) ? "请求中…" : "请求整理任务稿",
        ),
      ),
    );
    return section;
  }

  if (!draft) {
    section.append(
      h(
        "p",
        { class: "form-warn" },
        "服务端当前没有任务稿，但本地未保存内容已保留。请核对后保存；后端可能拒绝创建或返回 409。",
      ),
    );
  } else {
    section.append(
      h(
        "p",
        { class: "rev-line" },
        h("span", {}, `rev ${shortRev(draft.rev)}`),
        h("span", { title: str(draft.rev) }, "完整版本号见悬停提示"),
        draft.requirementsRev ? h("span", {}, `需求 rev ${shortRev(draft.requirementsRev)}`) : null,
        draft.updatedAt ? h("span", {}, `更新 ${fmtTime(draft.updatedAt)}`) : null,
      ),
    );
  }

  if (!editable) {
    section.append(
      h(
        "p",
        { class: "form-warn" },
        `当前状态为“${stateLabel(candidate.state)}”，任务稿只读。若需修改需求，需要后端状态允许重新审阅。`,
      ),
    );
    if (draft) section.append(renderDraftSummary(draft));
    return section;
  }

  if (!entry) {
    section.append(h("p", { class: "form-error" }, "前端尚未同步任务稿编辑状态，请刷新后重试。"));
    return section;
  }

  if (entry.stale) {
    section.append(
      h(
        "div",
        { class: "form-warn" },
        `服务端任务稿已更新${entry.serverRev ? `（当前 rev ${shortRev(entry.serverRev)}）` : ""}。你的未保存内容已保留；请核对后重新保存。`,
        h(
          "div",
          { class: "btn-row" },
          entry.serverRev
            ? actionBtn(
                "保留输入并采用服务端 rev",
                null,
                () => {
                  const fresh = candidateById(candidate.id)?.draft;
                  if (!fresh) {
                    entry.error = "服务端当前没有任务稿，无法采用新版本。";
                    render();
                    return;
                  }
                  entry.baseRev = fresh.rev || null;
                  entry.baseValues = draftValuesFromServer(fresh);
                  entry.version = fresh.version ?? null;
                  entry.requirementsRev = fresh.requirementsRev || null;
                  entry.stale = false;
                  entry.conflict = false;
                  entry.serverRev = null;
                  entry.serverGone = false;
                  entry.error = null;
                  entry.dirty = JSON.stringify(entry.values) !== JSON.stringify(entry.baseValues);
                  updateDraftChrome(candidate.id);
                  render();
                },
                { size: "small" },
              )
            : null,
          actionBtn(
            "放弃本地修改并载入服务端版本",
            null,
            () => {
              if (!entry.dirty || window.confirm("放弃本地未保存的任务稿修改，并载入服务端最新版本？")) {
                const fresh = candidateById(candidate.id)?.draft;
                if (fresh) {
                  ui.drafts.set(candidate.id, initDraftEntry(fresh));
                } else {
                  ui.drafts.delete(candidate.id);
                }
                ui.errors.delete(`draft-save:${candidate.id}`);
                render();
              }
            },
            { size: "small" },
          ),
        ),
      ),
    );
  }

  if (entry.conflict) {
    section.append(
      h(
        "p",
        { class: "form-error" },
        "保存返回 409：服务端任务稿已变化，本次未写入。当前输入仍保留；请核对后采用服务端 rev 再保存，或放弃本地修改。",
      ),
    );
  }

  if (entry.error) section.append(h("p", { class: "form-error" }, entry.error));
  const saveError = ui.errors.get(`draft-save:${candidate.id}`);
  if (saveError && saveError !== entry.error) section.append(h("p", { class: "form-error" }, saveError));

  const pendingSave = ui.pending.has(`draft-save:${candidate.id}`);
  const disabled = pendingSave || !hasToken();

  const textarea = (key, label, hintText, rows = 3) => {
    const id = `draft-${safeId(candidate.id)}-${key}`;
    return fieldWrap(
      label,
      h("textarea", {
        id,
        rows: String(rows),
        value: entry.values[key],
        disabled,
        dataset: { focus: id },
        oninput: (event) => {
          entry.values[key] = event.target.value;
          updateDraftEntry(candidate.id);
        },
      }),
      hintText,
    );
  };

  const templateId = `draft-${safeId(candidate.id)}-template`;
  const templates = templateOptions(entry.values.templateId);
  const templateControl = templates.length
    ? selectControl(templates, entry.values.templateId, {
        id: templateId,
        disabled,
        dataset: { focus: templateId },
        onchange: (event) => {
          entry.values.templateId = event.target.value;
          updateDraftEntry(candidate.id);
        },
      })
    : h("input", {
        id: templateId,
        type: "text",
        value: entry.values.templateId,
        placeholder: "development",
        disabled,
        dataset: { focus: templateId },
        oninput: (event) => {
          entry.values.templateId = event.target.value;
          updateDraftEntry(candidate.id);
        },
      });

  const form = h(
    "form",
    {
      class: "draft-form",
      onsubmit: (event) => {
        event.preventDefault();
        saveDraft(candidate);
      },
    },
    textarea("goal", "目标", "整理后本次要达成的具体结果。"),
    textarea("scope", "范围", "允许修改的模块、文件或边界。"),
    textarea("acceptance", "验收要求", "每行一项；至少一项才可确认开发。", 4),
    textarea("context", "上下文", "相关 Issue、文件、讨论与限制。", 4),
    textarea("pendingDecisions", "待决策事项", "每行一项；存在未决项时不能确认开发。"),
    h(
      "div",
      { class: "field-row" },
      fieldWrap(
        "模板 ID",
        templateControl,
        templates.length ? "来自服务端模板列表；提交时固定为当前值。" : "服务端模板列表为空，可直接填写模板 ID。",
      ),
      fieldWrap(
        "优先级",
        h("input", {
          id: `draft-${safeId(candidate.id)}-priority`,
          type: "number",
          step: "1",
          value: entry.values.priority,
          disabled,
          dataset: { focus: `draft-${safeId(candidate.id)}-priority` },
          oninput: (event) => {
            entry.values.priority = event.target.value;
            updateDraftEntry(candidate.id);
          },
        }),
        "数值越高越先安排；相同优先级保持稳定顺序。",
      ),
    ),
    textarea("dependsOn", "依赖", "每行一项，格式 owner/repo#编号；支持跨仓库依赖。", 2),
    textarea("writeScopes", "写入范围", "每行一个相对路径；* 表示全部路径，会与同仓任务冲突。", 2),
    h(
      "div",
      { class: "btn-row" },
      h(
        "button",
        {
          type: "submit",
          class: "btn btn-primary",
          disabled: disabled || !entry.dirty,
          dataset: { draftSave: candidate.id },
        },
        pendingSave ? "保存中…" : "保存任务稿",
      ),
      h(
        "span",
        {
          class: `form-status ${entry.dirty ? "is-dirty" : "is-ok"}`,
          dataset: { draftDirty: candidate.id },
        },
        entry.dirty ? "有未保存修改" : "已保存",
      ),
      h("span", { class: "mono" }, `rev ${shortRev(entry.baseRev)}`),
      entry.dirty
        ? actionBtn(
            "放弃修改",
            null,
            () => {
              entry.values = clonePlain(entry.baseValues);
              entry.dirty = false;
              entry.error = null;
              entry.conflict = false;
              updateDraftEntry(candidate.id);
              render();
            },
            { size: "small", variant: "quiet" },
          )
        : null,
    ),
  );

  section.append(form);
  section.append(
    h(
      "p",
      { class: "hint" },
      "保存后采用服务端返回的 rev；前端不会自行生成授权版本。轮询不会覆盖未保存的输入。",
    ),
  );
  return section;
}

function renderDraftSummary(draft) {
  const rows = [
    ["目标", draft.goal],
    ["范围", draft.scope],
    ["验收", draft.acceptance],
    ["上下文", draft.context],
    ["待决策事项", draft.pendingDecisions],
    ["模板", draft.templateId],
    ["优先级", draft.priority],
    ["依赖", draft.dependsOn],
    ["写入范围", draft.writeScopes],
  ];
  return h(
    "dl",
    { class: "detail-dl" },
    ...rows.flatMap(([label, value]) => [
      h("dt", {}, label),
      h("dd", {}, Array.isArray(value) ? renderValue(value) : textBlock(str(value))),
    ]),
  );
}

function currentDraftEntry(candidate) {
  let entry = ui.drafts.get(candidate.id);
  if (!entry && candidate.draft) {
    entry = initDraftEntry(candidate.draft);
    ui.drafts.set(candidate.id, entry);
  }
  return entry || null;
}

function updateDraftEntry(id) {
  const entry = ui.drafts.get(id);
  if (!entry) return;
  entry.dirty = JSON.stringify(entry.values) !== JSON.stringify(entry.baseValues);
  entry.error = null;
  updateDraftChrome(id);
}

function updateDraftChrome(id) {
  const entry = ui.drafts.get(id);
  if (!entry) return;
  eachByData("draft-save", (node) => {
    if (node.dataset.draftSave === id) {
      node.disabled = !entry.dirty || ui.pending.has(`draft-save:${id}`) || !hasToken();
    }
  });
  const status = findByData("draft-dirty", id);
  if (status) {
    status.textContent = entry.dirty ? "有未保存修改" : "已保存";
    status.className = `form-status ${entry.dirty ? "is-dirty" : "is-ok"}`;
  }
  const candidate = candidateById(id);
  if (candidate) {
    const reasons = developBlockers(candidate, entry);
    eachByData("decision-develop", (node) => {
      if (node.dataset.decisionDevelop === id) {
        node.disabled = reasons.length > 0 || decisionPending(id) || !hasToken();
        node.title = reasons.join("；");
      }
    });
  }
}

function developBlockers(candidate, entry) {
  const reasons = [];
  if (candidate.filter?.matched !== true) reasons.push("该条目未命中收集规则");
  if (candidate.draftStale) reasons.push("Issue 内容已变化，请重新审阅并保存任务稿");
  if (!candidate.draft) reasons.push("尚无可审阅的任务稿");
  else if (!candidate.draft.rev) reasons.push("任务稿缺少版本 rev，不能确认");
  if (candidate.draft && entry?.dirty) reasons.push("有未保存的任务稿修改，请先保存");
  const acceptance = stringList(candidate.draft?.acceptance);
  if (!acceptance.length) reasons.push("验收要求为空");
  const pendingDecisions = stringList(candidate.draft?.pendingDecisions);
  if (pendingDecisions.length) reasons.push(`仍有 ${pendingDecisions.length} 项待决策事项`);
  if (candidate.state === "ready") {
    reasons.push("已确认开发并进入就绪队列，不能重复确认；如需暂停可使用暂缓或忽略");
  } else if (!DEVELOP_STATES.has(candidate.state)) {
    reasons.push(`当前状态“${stateLabel(candidate.state)}”不允许作出开发决定`);
  }
  if (!hasToken()) reasons.push("本地会话令牌不可用");
  return unique(reasons);
}

function decisionCommonBlockers(candidate) {
  const reasons = [];
  if (!DECIDABLE_STATES.has(candidate.state)) {
    reasons.push(`当前状态“${stateLabel(candidate.state)}”不允许作出决定`);
  }
  if (!hasToken()) reasons.push("本地会话令牌不可用");
  return reasons;
}

function decisionPending(id) {
  return ["develop", "defer", "ignore"].some((action) => ui.pending.has(`decision:${id}:${action}`));
}

function renderDecisionSection(candidate, draft, entry) {
  const section = h("div", { class: "section" });
  const developReasons = developBlockers(candidate, entry);
  const commonReasons = decisionCommonBlockers(candidate);

  section.append(
    h(
      "div",
      { class: "decision-box" },
      h("h4", {}, "用户决定"),
      h(
        "p",
        { class: "hint" },
        draft
          ? `决定针对当前已保存的任务稿 rev ${shortRev(draft.rev)}。确认开发后由监督循环自动领取，不需要再次派发。`
          : "尚无任务稿。前端不会替用户生成授权版本；develop 需要先有已保存且满足条件的任务稿。",
      ),
      developReasons.length
        ? h("ul", { class: "gate-list" }, ...developReasons.map((reason) => h("li", {}, reason)))
        : h("p", { class: "hint" }, "开发条件已满足；确认后由后端核对并自动安排。"),
      commonReasons.length
        ? h("p", { class: "hint" }, `暂缓/忽略限制：${commonReasons.join("；")}`)
        : null,
      h(
        "div",
        { class: "decision-actions" },
        h(
          "button",
          {
            type: "button",
            class: "btn btn-primary",
            disabled: developReasons.length > 0 || decisionPending(candidate.id),
            title: developReasons.join("；"),
            dataset: { decisionDevelop: candidate.id },
            onclick: () => decide(candidate, "develop"),
          },
          ui.pending.has(`decision:${candidate.id}:develop`) ? "确认中…" : "确认开发",
        ),
        h(
          "button",
          {
            type: "button",
            class: "btn",
            disabled: commonReasons.length > 0 || decisionPending(candidate.id),
            title: commonReasons.join("；"),
            onclick: () => decide(candidate, "defer"),
          },
          ui.pending.has(`decision:${candidate.id}:defer`) ? "提交中…" : "暂缓",
        ),
        h(
          "button",
          {
            type: "button",
            class: "btn btn-danger",
            disabled: commonReasons.length > 0 || decisionPending(candidate.id),
            title: commonReasons.join("；"),
            onclick: () => decide(candidate, "ignore"),
          },
          ui.pending.has(`decision:${candidate.id}:ignore`) ? "提交中…" : "忽略",
        ),
      ),
      ["develop", "defer", "ignore"].map((action) => {
        const key = `decision:${candidate.id}:${action}`;
        return ui.errors.get(key) ? h("p", { class: "form-error" }, ui.errors.get(key)) : null;
      }),
    ),
  );
  return section;
}

function renderCandidateProgress(candidate) {
  const section = h("div", { class: "section" });
  const runs = runsForCandidate(candidate.id);
  const events = sortedEvents().filter((event) => event.candidateId === candidate.id).slice(0, 5);
  const result = candidate.latestResult;
  const reviews = candidate.reviews || {};

  section.append(
    h(
      "div",
      { class: "section-head" },
      h("h4", {}, "进展、证据与验收"),
      h(
        "div",
        { class: "inline-actions" },
        runs.length || events.length
          ? actionBtn("查看执行总览", null, () => switchView("runs"), { size: "small", variant: "quiet" })
          : null,
        result || ["awaiting_acceptance", "completed"].includes(candidate.state)
          ? actionBtn("前往验收", null, () => openAcceptance(candidate.id), { size: "small", variant: "quiet" })
          : null,
      ),
    ),
  );

  if (!runs.length && !events.length) {
    section.append(h("p", { class: "hint" }, "尚无执行进展。确认开发后，后端会写入 Run 与事件。"));
  }

  if (runs.length) {
    section.append(
      h(
        "div",
        { class: "run-column" },
        ...runs.slice(0, 3).map((run) =>
          h(
            "div",
            { class: "run-card" },
            h(
              "div",
              { class: "run-card-head" },
              h("span", { class: "run-card-title" }, `Run ${str(run.id)}`),
              badge(runStatusLabel(run.status), runStatusTone(run.status)),
            ),
            h(
              "p",
              { class: "run-meta" },
              h("span", {}, `阶段：${run.phase || "未记录"}`),
              run.updatedAt ? h("span", {}, fmtTime(run.updatedAt)) : null,
              run.templateRef ? h("span", { class: "mono" }, run.templateRef) : null,
            ),
          ),
        ),
      ),
    );
  }

  if (result) {
    section.append(
      h(
        "div",
        { class: "acceptance-box" },
        h("h5", {}, "最新结果"),
        textBlock(result.summary),
        result.pr
          ? h(
              "p",
              { class: "run-meta" },
              h(
                "span",
                {},
                "PR ",
                externalLink(
                  result.pr.url,
                  `${result.pr.repo || issueRepo(candidate)}#${result.pr.number ?? "—"}`,
                ),
              ),
              result.pr.headSha ? h("span", { class: "mono" }, shortRev(result.pr.headSha)) : h("span", {}, "未记录 head"),
            )
          : h("p", { class: "hint" }, "结果未提供 PR；不能进行合并。"),
        h(
          "p",
          { class: "run-meta" },
          badge(`用户：${verdictLabel(reviews.user?.verdict)}`, verdictTone(reviews.user?.verdict)),
          badge(`设计监督：${verdictLabel(reviews.design?.verdict)}`, verdictTone(reviews.design?.verdict)),
        ),
        result.evidence !== undefined
          ? h("div", {}, h("p", { class: "field-label" }, "证据"), renderEvidence(result.evidence))
          : null,
      ),
    );
  }

  if (events.length) {
    section.append(
      h("p", { class: "section-sub" }, "最近事件"),
      h("ul", { class: "events-list" }, ...events.map((event) => renderEventItem(event))),
    );
  }

  return section;
}

/* ---------------- 执行总览 ---------------- */

function renderRunsView() {
  const section = h("section", { class: "view", "aria-labelledby": "runs-title" });
  section.append(
    h(
      "div",
      { class: "view-header" },
      h(
        "div",
        {},
        h("h2", { id: "runs-title" }, "执行总览"),
        h("p", { class: "view-sub" }, "按仓库查看活动 Worker、队列、优先级、依赖与阻塞原因；一个任务阻塞不会停止其他就绪任务。"),
      ),
      h(
        "div",
        { class: "view-actions" },
        actionBtn("刷新状态", null, () => {
          refreshState(true);
          render();
        }, { size: "small" }),
      ),
    ),
  );

  const repos = repoOptions().filter((repo) => inRepoScope(repo));
  if (!repos.length) {
    section.append(
      h(
        "div",
        { class: "empty-state" },
        h("h3", {}, "没有可展示的仓库"),
        h("p", {}, repoOptions().length ? "当前仓库筛选没有匹配项。" : "请先在“规则”中配置仓库。"),
        repoOptions().length
          ? h("button", { type: "button", class: "btn", onclick: () => setRepoFilter("") }, "查看全部仓库")
          : h("button", { type: "button", class: "btn btn-primary", onclick: () => switchView("settings") }, "前往规则配置"),
      ),
    );
    return section;
  }

  const scopedRuns = runsAll().filter((run) => inRepoScope(runRepo(run)));
  const runningCount = scopedRuns.filter((run) => run.status === "running").length;
  const blockedCount = scopedRuns.filter((run) => run.status === "blocked").length;
  const queuedCount = candidatesAll().filter(
    (candidate) => inRepoScope(issueRepo(candidate)) && candidate.state === "ready",
  ).length;
  const concurrency = ui.data?.settings?.concurrency || {};
  const runtime = ui.data?.runtime || {};

  section.append(
    h(
      "div",
      { class: "summary-strip" },
      summaryItem(String(runningCount), "活动 Worker"),
      summaryItem(String(queuedCount), "等待队列"),
      summaryItem(String(blockedCount), "阻塞 Run", blockedCount ? "is-warn" : ""),
      summaryItem(
        `${finiteNumber(concurrency.global, 2)} / ${finiteNumber(concurrency.perRepo, 2)}`,
        "并发上限（全局 / 每仓）",
      ),
      summaryItem(runtime.watching ? "开启" : "暂停", "自动监督"),
      summaryItem(String(runtime.intervalSeconds ?? "—"), "监督间隔（秒）"),
      summaryItem(fmtTime(runtime.lastPollAt), "上次收集"),
    ),
  );

  for (const repo of repos) {
    section.append(renderRepoRunGroup(repo));
  }

  section.append(renderGlobalEvents(scopedRuns));
  return section;
}

function summaryItem(value, label, tone = "") {
  return h(
    "div",
    { class: `summary-item ${tone}`.trim() },
    h("strong", {}, value),
    h("span", {}, label),
  );
}

function renderRepoRunGroup(repo) {
  const candidates = candidatesAll().filter((candidate) => issueRepo(candidate) === repo);
  const runs = runsAll().filter((run) => runRepo(run) === repo);
  const runningRuns = runs
    .filter((run) => run.status === "running")
    .sort((a, b) => str(b.updatedAt).localeCompare(str(a.updatedAt)));
  const blockedRuns = runs.filter((run) => run.status === "blocked");
  const completedRuns = runs
    .filter((run) => run.status === "completed")
    .sort((a, b) => str(b.updatedAt).localeCompare(str(a.updatedAt)))
    .slice(0, 3);
  const blockedCandidates = candidates.filter((candidate) => candidate.state === "blocked");
  const queue = candidates
    .filter(
      (candidate) =>
        candidate.state === "ready" &&
        !runningRuns.some((run) => run.candidateId === candidate.id) &&
        !blockedRuns.some((run) => run.candidateId === candidate.id),
    )
    .sort((a, b) => {
      const priorityDiff = finiteNumber(b.draft?.priority) - finiteNumber(a.draft?.priority);
      if (priorityDiff !== 0) return priorityDiff;
      return str(a.createdAt).localeCompare(str(b.createdAt));
    });

  const blockedEntries = new Map();
  for (const candidate of blockedCandidates) {
    blockedEntries.set(candidate.id, {
      candidate,
      run: blockedRuns.find((run) => run.candidateId === candidate.id) || null,
    });
  }
  for (const run of blockedRuns) {
    if (run.candidateId && blockedEntries.has(run.candidateId)) continue;
    const candidate = candidateById(run.candidateId);
    blockedEntries.set(candidate?.id || run.id, { candidate, run });
  }

  const group = h("section", { class: "repo-group", "aria-labelledby": `repo-${safeId(repo)}` });
  group.append(
    h(
      "div",
      { class: "repo-group-head" },
      h("h3", { id: `repo-${safeId(repo)}` }, repo),
      h(
        "span",
        { class: "group-counts" },
        `运行 ${runningRuns.length}`,
        `队列 ${queue.length}`,
        `阻塞 ${blockedEntries.size}`,
        `完成 ${runs.filter((run) => run.status === "completed").length}`,
      ),
    ),
  );

  const columns = h("div", { class: "run-columns" });
  columns.append(
    h(
      "div",
      { class: "run-column" },
      h("h4", {}, `活动 Worker · ${runningRuns.length}`),
      runningRuns.length
        ? h("div", {}, ...runningRuns.map((run) => renderRunCard(run, { blocked: false })))
        : h("p", { class: "small-empty" }, "没有正在执行的 Worker。"),
    ),
    h(
      "div",
      { class: "run-column" },
      h("h4", {}, `等待队列 · ${queue.length}`),
      queue.length
        ? h("div", {}, ...queue.map((candidate, index) => renderQueueCard(candidate, index + 1)))
        : h("p", { class: "small-empty" }, "没有已确认、等待安排的独立任务。"),
    ),
    h(
      "div",
      { class: "run-column" },
      h("h4", {}, `阻塞 · ${blockedEntries.size}`),
      blockedEntries.size
        ? h(
            "div",
            {},
            ...[...blockedEntries.values()].map((entry) =>
              entry.run
                ? renderRunCard(entry.run, { blocked: true, candidate: entry.candidate })
                : renderBlockedCandidateCard(entry.candidate),
            ),
          )
        : h("p", { class: "small-empty" }, "没有阻塞任务。"),
    ),
    h(
      "div",
      { class: "run-column" },
      h("h4", {}, "最近完成"),
      completedRuns.length
        ? h(
            "div",
            {},
            ...completedRuns.map((run) =>
              h(
                "div",
                { class: "run-card" },
                h(
                  "div",
                  { class: "run-card-head" },
                  h("span", { class: "run-card-title" }, runTitle(run)),
                  badge(runStatusLabel(run.status), runStatusTone(run.status)),
                ),
                h(
                  "p",
                  { class: "run-meta" },
                  h("span", { class: "mono" }, str(run.id)),
                  run.updatedAt ? h("span", {}, fmtTime(run.updatedAt)) : null,
                ),
                runDetails(run, `completed-${run.id}`),
              ),
            ),
          )
        : h("p", { class: "small-empty" }, "暂无完成记录。"),
    ),
  );

  group.append(columns);
  return group;
}

function runTitle(run) {
  const candidate = candidateById(run.candidateId);
  return candidate?.issue?.title || run.issueRef || str(run.id) || "未命名 Run";
}

function renderRunCard(run, options = {}) {
  const candidate = options.candidate || candidateById(run.candidateId);
  const blocked = Boolean(options.blocked) || run.status === "blocked";
  const reasons = blocked ? blockReasons(run, candidate) : [];
  const ticket = candidate || null;
  const draft = ticket?.draft;
  const card = h("article", { class: `run-card ${blocked ? "is-blocked" : "is-running"}` });

  card.append(
    h(
      "div",
      { class: "run-card-head" },
      h(
        "span",
        { class: "run-card-title" },
        ticket ? h("button", { type: "button", class: "link-button", onclick: () => selectCandidate(ticket.id) }, ticket.issue?.title || ticket.id) : runTitle(run),
      ),
      badge(runStatusLabel(run.status), runStatusTone(run.status)),
    ),
    h(
      "p",
      { class: "run-meta" },
      h("span", { class: "mono" }, str(run.id)),
      run.issueRef ? h("span", {}, run.issueRef) : null,
      h("span", {}, `阶段：${run.phase || "未记录"}`),
      draft ? h("span", {}, `优先级 ${finiteNumber(draft.priority)}`) : null,
      run.updatedAt ? h("span", {}, fmtTime(run.updatedAt)) : null,
    ),
  );

  if (draft) {
    const dependsOn = stringList(draft.dependsOn);
    const writeScopes = stringList(draft.writeScopes);
    if (dependsOn.length || writeScopes.length) {
      card.append(
        h(
          "p",
          { class: "run-meta" },
          dependsOn.length ? h("span", {}, `依赖：${dependsOn.join("、")}`) : null,
          writeScopes.length ? h("span", {}, `写入：${writeScopes.join("、")}`) : null,
        ),
      );
    }
  }

  if (blocked) {
    if (reasons.length) {
      card.append(
        h("ul", { class: "reason-list" }, ...reasons.map((reason) => h("li", { class: "is-excluded" }, reason))),
      );
    } else {
      card.append(
        h("p", { class: "hint" }, "接口未在 Run 上提供阻塞原因；展开下方事件查看后端记录。"),
      );
    }
  }

  const actions = h("div", { class: "run-actions" });
  if (ticket) {
    actions.append(
      actionBtn("查看候选", null, () => selectCandidate(ticket.id), { size: "small", variant: "quiet" }),
    );
  }
  if (run.status === "running") {
    actions.append(
      actionBtn(
        "取消运行",
        `cancel:${run.id}`,
        () => cancelRun(run),
        { size: "small", variant: "danger", disabled: !hasToken() },
      ),
    );
  }
  if (blocked && ticket && DECIDABLE_STATES.has(ticket.state)) {
    actions.append(
      actionBtn(
        "重试任务",
        `retry:${ticket.id}`,
        () => retryCandidate(ticket),
        { size: "small", disabled: !hasToken() },
      ),
    );
  }
  card.append(actions);

  if (ui.errors.get(`cancel:${run.id}`)) {
    card.append(h("p", { class: "form-error" }, ui.errors.get(`cancel:${run.id}`)));
  }
  if (ticket && ui.errors.get(`retry:${ticket.id}`)) {
    card.append(h("p", { class: "form-error" }, ui.errors.get(`retry:${ticket.id}`)));
  }

  card.append(runDetails(run, `run-${run.id}`));
  return card;
}

function renderBlockedCandidateCard(candidate) {
  const card = h("article", { class: "run-card is-blocked" });
  card.append(
    h(
      "div",
      { class: "run-card-head" },
      h(
        "span",
        { class: "run-card-title" },
        h("button", { type: "button", class: "link-button", onclick: () => selectCandidate(candidate.id) }, candidate.issue?.title || candidate.id),
      ),
      badge(stateLabel(candidate.state), stateTone(candidate.state)),
    ),
    h(
      "p",
      { class: "run-meta" },
      h("span", { class: "mono" }, candidate.id),
      candidate.draft ? h("span", {}, `优先级 ${finiteNumber(candidate.draft.priority)}`) : null,
      candidate.updatedAt ? h("span", {}, fmtTime(candidate.updatedAt)) : null,
    ),
  );
  const reasons = eligibilityReasons(candidate);
  if (reasons.length) {
    card.append(h("ul", { class: "reason-list" }, ...reasons.map((reason) => h("li", { class: "is-excluded" }, reason))));
  }
  card.append(
    h(
      "div",
      { class: "run-actions" },
      actionBtn("查看候选", null, () => selectCandidate(candidate.id), { size: "small", variant: "quiet" }),
      actionBtn(
        "重试任务",
        `retry:${candidate.id}`,
        () => retryCandidate(candidate),
        { size: "small", disabled: !hasToken() },
      ),
    ),
  );
  if (ui.errors.get(`retry:${candidate.id}`)) {
    card.append(h("p", { class: "form-error" }, ui.errors.get(`retry:${candidate.id}`)));
  }
  return card;
}

function renderQueueCard(candidate, order) {
  const draft = candidate.draft;
  const dependsOn = stringList(draft?.dependsOn);
  const writeScopes = stringList(draft?.writeScopes);
  const reasons = eligibilityReasons(candidate);
  return h(
    "article",
    { class: "queue-card" },
    h("span", { class: "queue-order", "aria-label": `队列第 ${order} 位` }, String(order)),
    h(
      "span",
      { class: "queue-title" },
      h("button", { type: "button", class: "link-button", onclick: () => selectCandidate(candidate.id) }, candidate.issue?.title || candidate.id),
    ),
    h(
      "span",
      { class: "queue-meta" },
      badge(`优先级 ${finiteNumber(draft?.priority)}`, "is-accent"),
      h("span", {}, candidate.issue?.repo || issueRepo(candidate)),
      dependsOn.length ? h("span", {}, `依赖 ${dependsOn.join("、")}`) : null,
      writeScopes.length ? h("span", {}, `写入 ${writeScopes.join("、")}`) : null,
    ),
    reasons.length
      ? h("p", { class: "queue-reason" }, `当前条件：${reasons.join("；")}`)
      : h("p", { class: "queue-reason" }, "已就绪：等待并发额度或依赖释放。"),
  );
}

function blockReasons(run, candidate) {
  const reasons = [];
  const add = (value) => {
    if (typeof value === "string" && value.trim()) reasons.push(value.trim());
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string" && item.trim()) reasons.push(item.trim());
    }
  };
  add(run.blockReason);
  add(run.blockedReason);
  add(run.reason);
  add(run.blockers);
  add(run.result?.blockers);
  add(run.result?.blockedReasons);
  add(run.result?.reason);
  if (candidate?.state === "blocked") add(eligibilityReasons(candidate));
  const relatedEvents = sortedEvents().filter(
    (event) =>
      event.runId === run.id &&
      ["blocked", "error", "cancel"].includes(str(event.kind).toLowerCase()),
  );
  for (const event of relatedEvents.slice(0, 2)) add(event.message);
  return unique(reasons);
}

function runDetails(run, keyPrefix) {
  const fields = [
    ["Run", str(run.id)],
    ["候选", str(run.candidateId)],
    ["Issue", str(run.issueRef)],
    ["状态", runStatusLabel(run.status)],
    ["阶段", str(run.phase) || "—"],
    ["模板引用", str(run.templateRef) || "—"],
    ["分支", str(run.branch) || "—"],
    ["工作树", str(run.worktreePath) || "—"],
    ["任务稿 rev", shortRev(run.draftRev)],
    ["需求 rev", shortRev(run.requirementsRev)],
    ["创建", fmtFullTime(run.createdAt)],
    ["更新", fmtFullTime(run.updatedAt)],
  ];
  const events = sortedEvents()
    .filter((event) => event.runId === run.id)
    .slice(0, 8);
  const body = [
    h(
      "dl",
      { class: "detail-dl" },
      ...fields.flatMap(([label, value]) => [
        h("dt", {}, label),
        h("dd", { class: value === "—" ? "muted" : label.includes("rev") || ["Run", "候选", "Issue", "工作树", "分支"].includes(label) ? "mono" : "" }, value),
      ]),
    ),
  ];
  if (run.result) body.push(renderResultCore(run.result, { compact: true }));
  if (events.length) {
    body.push(h("p", { class: "hint" }, "该 Run 最近事件"), h("ul", { class: "events-list" }, ...events.map((event) => renderEventItem(event))));
  }
  return detailSection(`${keyPrefix}-details`, false, "查看来源、模板与 Run 详情", ...body);
}

function renderResultCore(result, options = {}) {
  if (!result || typeof result !== "object") return null;
  const container = h("div", { class: "result-core" });
  if (result.summary) {
    container.append(h("p", { class: "field-label" }, "结果摘要"), textBlock(result.summary));
  }
  if (result.artifacts !== undefined) {
    container.append(h("p", { class: "field-label" }, "产物"), renderValue(redact(result.artifacts)));
  }
  if (result.evidence !== undefined && !options.compact) {
    container.append(h("p", { class: "field-label" }, "实际证据"), renderEvidence(result.evidence));
  }
  if (result.pr) {
    container.append(
      h(
        "p",
        { class: "run-meta" },
        h("span", {}, "PR "),
        h(
          "span",
          {},
          externalLink(result.pr.url, `${result.pr.repo || "仓库"}#${result.pr.number ?? "—"}`),
        ),
        result.pr.headSha ? h("span", { class: "mono" }, `head ${shortRev(result.pr.headSha)}`) : null,
      ),
    );
  }
  return container;
}

function renderGlobalEvents(scopedRuns) {
  const section = h("section", { class: "repo-group", "aria-labelledby": "events-title" });
  const repoSet = new Set(scopedRuns.map((run) => runRepo(run)));
  const events = sortedEvents()
    .filter((event) => {
      if (!ui.repoFilter) return true;
      const repo = eventRepo(event);
      return repo === ui.repoFilter || (repo && repoSet.has(repo));
    })
    .slice(0, MAX_EVENTS);
  section.append(
    h(
      "div",
      { class: "repo-group-head" },
      h("h3", { id: "events-title" }, "事件与证据"),
      h("span", { class: "group-counts" }, `最近 ${events.length} 条`),
    ),
  );
  if (!events.length) {
    section.append(h("p", { class: "small-empty" }, "当前范围没有事件记录。"));
    return section;
  }
  section.append(h("ul", { class: "events-list" }, ...events.map((event) => renderEventItem(event))));
  return section;
}

function renderEventItem(event) {
  const key = `event-data-${str(event.id)}`;
  const meta = [
    eventRepo(event) ? h("span", {}, eventRepo(event)) : null,
    event.candidateId ? h("span", { class: "mono" }, event.candidateId) : null,
    event.runId ? h("span", { class: "mono" }, event.runId) : null,
  ].filter(Boolean);
  return h(
    "li",
    { class: "event-item" },
    h("span", { class: "event-time", title: fmtFullTime(event.at) }, fmtTime(event.at)),
    h("span", { class: `badge is-mono ${["error", "blocked"].includes(str(event.kind)) ? "is-danger" : ""}`.trim() }, eventKindLabel(event.kind)),
    h("span", { class: "event-message" }, event.message || "（事件未提供消息）"),
    meta.length ? h("span", { class: "event-meta" }, ...meta) : null,
    event.data !== undefined && event.data !== null
      ? h(
          "details",
          {
            class: "event-data",
            open: ui.open.has(key) ? Boolean(ui.open.get(key)) : false,
            ontoggle: (toggleEvent) => ui.open.set(key, toggleEvent.currentTarget.open),
          },
          h("summary", {}, "查看事件数据"),
          h("pre", { class: "pre" }, pretty(event.data)),
        )
      : null,
  );
}

/* ---------------- 验收视图 ---------------- */

function renderAcceptanceView() {
  const section = h("section", { class: "view", "aria-labelledby": "acceptance-title" });
  section.append(
    h(
      "div",
      { class: "view-header" },
      h(
        "div",
        {},
        h("h2", { id: "acceptance-title" }, "PR 验收"),
        h("p", { class: "view-sub" }, "用户与设计监督分别记录对指定提交的结论；前端不补齐验收，也不会自动合并。"),
      ),
      h(
        "div",
        { class: "view-actions" },
        actionBtn("刷新状态", null, () => {
          refreshState(true);
          render();
        }, { size: "small" }),
      ),
    ),
  );

  const list = filteredAcceptanceCandidates();
  if (!list.length) {
    section.append(
      h(
        "div",
        { class: "empty-state" },
        h("h3", {}, "暂无待验收交付"),
        h("p", {}, repoOptions().length ? "执行完成并产生结果/PR 后会显示在这里。可先在“执行”总览查看进度。" : "请先配置仓库并推进执行。"),
        h(
          "button",
          { type: "button", class: "btn", onclick: () => switchView("runs") },
          "前往执行总览",
        ),
      ),
    );
    return section;
  }

  const selected = list.find((candidate) => candidate.id === ui.selectedId) || list[0];
  const listPane = h(
    "div",
    { class: "pane list-pane" },
    h(
      "div",
      { class: "pane-head" },
      h("h3", {}, "待验收与已完成"),
      h("span", { class: "count" }, String(list.length)),
    ),
    h(
      "ul",
      { class: "candidate-list acceptance-list", "aria-label": "待验收交付列表" },
      ...list.map((candidate) => {
        const pr = candidate.latestResult?.pr;
        const reviews = candidate.reviews || {};
        return h(
          "li",
          {},
          h(
            "button",
            {
              type: "button",
              class: "candidate-item",
              "aria-current": selected && selected.id === candidate.id ? "true" : "false",
              onclick: () => openAcceptance(candidate.id),
            },
            h(
              "span",
              { class: "candidate-topline" },
              h("span", { class: "repo" }, issueRepo(candidate)),
              badge(stateLabel(candidate.state), stateTone(candidate.state)),
              mergePending(candidate) ? badge("合并待核验", "is-warn") : null,
            ),
            h("span", { class: "candidate-title" }, candidate.issue?.title || "（Issue 无标题）"),
            h(
              "span",
              { class: "candidate-meta" },
              h("span", {}, pr ? `PR #${pr.number ?? "—"}` : "尚无 PR"),
              h("span", {}, `用户 ${verdictLabel(reviews.user?.verdict)} · 设计 ${verdictLabel(reviews.design?.verdict)}`),
            ),
          ),
        );
      }),
    ),
  );

  const detailPane = h("div", { class: "pane detail-pane" }, renderAcceptanceDetail(selected));
  section.append(h("div", { class: "acceptance-layout" }, listPane, detailPane));
  return section;
}

function renderAcceptanceDetail(candidate) {
  if (!candidate) {
    return h("div", { class: "empty-state" }, h("h3", {}, "选择一项交付"), h("p", {}, "左侧显示已有结果或待验收的候选。"));
  }
  const result = candidate.latestResult;
  const reviews = candidate.reviews || {};
  const pr = result?.pr || null;
  const container = h("div", { class: "acceptance-detail" });

  container.append(
    h(
      "div",
      { class: "detail-head" },
      h(
        "div",
        {},
        h("p", { class: "eyebrow" }, `${issueRepo(candidate)}#${candidate.issue?.number ?? "—"}`),
        h("h3", {}, candidate.issue?.title || "（Issue 无标题）"),
        h(
          "p",
          { class: "detail-meta" },
          badge(stateLabel(candidate.state), stateTone(candidate.state)),
          mergePending(candidate) ? badge("合并待核验", "is-warn") : null,
          h("span", { class: "mono" }, candidate.id),
          safeHttpUrl(candidate.issue?.url) ? externalLink(candidate.issue.url, "Issue") : null,
        ),
      ),
      h(
        "div",
        { class: "detail-actions" },
        actionBtn("查看候选详情", null, () => selectCandidate(candidate.id), { size: "small", variant: "quiet" }),
      ),
    ),
  );

  if (!result) {
    container.append(
      h(
        "div",
        { class: "section" },
        h("div", { class: "empty-state" }, h("h3", {}, "尚无执行结果"), h("p", {}, "没有 latestResult 时不能记录 PR 验收或合并。")),
      ),
    );
    return container;
  }

  container.append(
    h(
      "div",
      { class: "section" },
      h("div", { class: "section-head" }, h("h4", {}, "最新结果"), h("span", { class: "muted" }, fmtTime(candidate.updatedAt))),
      textBlock(result.summary),
      h("p", { class: "field-label" }, "产物"),
      renderValue(redact(result.artifacts)),
      h("p", { class: "field-label" }, "实际证据"),
      renderEvidence(result.evidence),
    ),
  );

  const prSection = h("div", { class: "section" });
  prSection.append(h("div", { class: "section-head" }, h("h4", {}, "PR 与当前 head")));
  if (pr) {
    prSection.append(
      h(
        "dl",
        { class: "detail-dl" },
        h("dt", {}, "仓库"),
        h("dd", { class: "mono" }, str(pr.repo) || issueRepo(candidate)),
        h("dt", {}, "PR"),
        h("dd", {}, externalLink(pr.url, `#${pr.number ?? "—"}`)),
        h("dt", {}, "当前 head"),
        h("dd", { class: "mono" }, str(pr.headSha) || "未记录"),
      ),
    );
    if (pr.repo && issueRepo(candidate) && pr.repo !== issueRepo(candidate)) {
      prSection.append(
        h("p", { class: "form-warn" }, `PR 仓库（${pr.repo}）与 Issue 仓库（${issueRepo(candidate)}）不一致。后端会拒绝跨仓库合并，请先核对。`),
      );
    }
    if (!pr.headSha) {
      prSection.append(h("p", { class: "form-warn" }, "PR 未记录 head，无法核对验收结论与合并目标。"));
    }
  } else {
    prSection.append(
      h("p", { class: "form-warn" }, "结果未提供关联 PR；不能记录合并操作。请由执行流程补充实际 PR 后再验收。"),
    );
  }
  container.append(prSection);

  container.append(
    h(
      "div",
      { class: "section" },
      h(
        "div",
        { class: "section-head" },
        h("h4", {}, "验收结论"),
        h("span", { class: "section-note" }, pr?.headSha ? `需针对当前 head ${shortRev(pr.headSha)}` : "尚无当前 head"),
      ),
      h(
        "div",
        { class: "review-grid" },
        renderReviewCard("用户", reviews.user, pr),
        renderReviewCard("设计监督", reviews.design, pr),
      ),
      renderAcceptanceForm(candidate, reviews, pr),
    ),
  );

  container.append(renderMergeBox(candidate, pr, reviews));
  return container;
}

function renderReviewCard(role, review, pr) {
  const card = h("div", { class: "review-card" });
  card.append(
    h(
      "h5",
      {},
      h("span", {}, role),
      badge(verdictLabel(review?.verdict), verdictTone(review?.verdict)),
    ),
  );
  if (!review) {
    card.append(h("p", { class: "hint" }, "尚未记录该角色结论。"));
    return card;
  }
  const current = Boolean(pr?.headSha && review.headSha === pr.headSha);
  card.append(
    h(
      "p",
      { class: "run-meta" },
      h("span", { class: "mono" }, review.headSha ? `head ${shortRev(review.headSha)}` : "未记录 head"),
      badge(current ? "当前 head" : "非当前 head", current ? "is-ok" : "is-warn"),
      review.at ? h("span", {}, fmtTime(review.at)) : null,
    ),
  );
  if (review.comment) card.append(h("p", { class: "review-comment" }, review.comment));
  return card;
}

function renderAcceptanceForm(candidate, reviews, pr) {
  const entry = acceptanceEntry(candidate);
  const idBase = `accept-${safeId(candidate.id)}`;
  const headReady = Boolean(entry.headSha.trim());
  const designReady = Boolean(entry.designComment.trim());
  const userKey = `acceptance:${candidate.id}:user`;
  const designKey = `acceptance:${candidate.id}:design`;

  return h(
    "div",
    { class: "acceptance-box", dataset: { acceptance: candidate.id } },
    h("h5", {}, "记录验收"),
    h(
      "p",
      { class: "hint" },
      "验收针对具体提交，结论按角色分别记录。默认使用 PR 当前 head；如实际验收其他提交，请明确修改。",
    ),
    fieldWrap(
      "验收提交 head",
      h("input", {
        id: `${idBase}-head`,
        type: "text",
        class: "mono",
        value: entry.headSha,
        placeholder: "填写实际验收的 commit SHA",
        dataset: { focus: `${idBase}-head` },
        oninput: (event) => {
          entry.headSha = event.target.value;
          entry.headTouched = true;
          entry.confirmed = false;
          updateAcceptanceChrome(candidate.id);
        },
        onchange: () => updateAcceptanceChrome(candidate.id),
      }),
      pr?.headSha ? `PR 记录的 head：${pr.headSha}` : "结果未提供 PR head。",
    ),
    h(
      "div",
      { class: "field-row" },
      h(
        "div",
        {},
        fieldWrap(
          "用户说明（可选）",
          h("textarea", {
            id: `${idBase}-user-comment`,
            rows: "3",
            value: entry.userComment,
            dataset: { focus: `${idBase}-user-comment` },
            oninput: (event) => {
              entry.userComment = event.target.value;
            },
          }),
          "记录用户自己的验收意见；不代替设计监督结论。",
        ),
        h(
          "div",
          { class: "btn-row" },
          actionBtn(
            "用户通过",
            userKey,
            () => recordAcceptance(candidate, "user", "approved"),
            {
              variant: "primary",
              disabled: !headReady || !hasToken(),
              dataset: { acceptanceAction: "user", candidateId: candidate.id },
            },
          ),
          actionBtn(
            "用户要求修改",
            userKey,
            () => recordAcceptance(candidate, "user", "changes_requested"),
            {
              variant: "danger",
              disabled: !headReady || !hasToken(),
              dataset: { acceptanceAction: "user", candidateId: candidate.id },
            },
          ),
        ),
        ui.errors.get(userKey) ? h("p", { class: "form-error" }, ui.errors.get(userKey)) : null,
      ),
      h(
        "div",
        {},
        fieldWrap(
          "设计监督结论（必填）",
          h("textarea", {
            id: `${idBase}-design-comment`,
            rows: "3",
            value: entry.designComment,
            dataset: { focus: `${idBase}-design-comment` },
            oninput: (event) => {
              entry.designComment = event.target.value;
              updateAcceptanceChrome(candidate.id);
            },
          }),
          "设计验收必须包含监督结论或引用；前端不会代为填写。",
        ),
        h(
          "div",
          { class: "btn-row" },
          h(
            "button",
            {
              type: "button",
              class: "btn btn-primary",
              disabled: !headReady || !designReady || ui.pending.has(designKey) || !hasToken(),
              dataset: { acceptanceAction: "design", candidateId: candidate.id },
              onclick: () => recordAcceptance(candidate, "design", "approved"),
            },
            ui.pending.has(designKey) ? "记录中…" : "设计通过",
          ),
          h(
            "button",
            {
              type: "button",
              class: "btn btn-danger",
              disabled: !headReady || !designReady || ui.pending.has(designKey) || !hasToken(),
              dataset: { acceptanceAction: "design", candidateId: candidate.id },
              onclick: () => recordAcceptance(candidate, "design", "changes_requested"),
            },
            ui.pending.has(designKey) ? "记录中…" : "设计要求修改",
          ),
        ),
        ui.errors.get(designKey) ? h("p", { class: "form-error" }, ui.errors.get(designKey)) : null,
      ),
    ),
    h(
      "p",
      { class: "hint" },
      `已有记录：用户 ${verdictLabel(reviews.user?.verdict)}；设计监督 ${verdictLabel(reviews.design?.verdict)}。新记录只影响对应角色。`,
    ),
  );
}

function renderMergeBox(candidate, pr, reviews) {
  const entry = acceptanceEntry(candidate);
  const state = mergeState(candidate, pr, reviews);
  const box = h("div", { class: "merge-box" });
  box.append(h("h4", {}, "合并 PR"));
  if (mergePending(candidate)) {
    box.append(
      h(
        "div",
        { class: "form-warn" },
        h("p", {}, h("strong", {}, "合并结果待核验")),
        h("p", {}, mergePendingNote(candidate)),
        h(
          "p",
          { class: "hint" },
          "服务端已持久 pending 状态；刷新页面仍会显示此项，后台只读核对，不会重复发送合并命令。",
        ),
      ),
    );
  }
  if (!pr) {
    box.append(h("p", { class: "hint" }, "没有 PR 时不能合并。前端不会创建或补写 PR 记录。"));
    return box;
  }

  box.append(
    h(
      "ul",
      { class: "checklist" },
      ...state.checks.map((check) =>
        h(
          "li",
          { class: check.status === "done" ? "is-done" : check.status === "blocked" ? "is-blocked" : "is-pending" },
          h("span", { class: "mark", "aria-hidden": "true" }, check.status === "done" ? "✓" : check.status === "blocked" ? "×" : "·"),
          h("span", {}, check.label),
        ),
      ),
    ),
  );

  box.append(
    h(
      "p",
      { class: "hint" },
      `PR ${str(pr.repo) || issueRepo(candidate)}#${pr.number ?? "—"} · head ${str(pr.headSha) || "未记录"}。合并始终是独立的用户操作；后端会再次核对两种验收与 GitHub 当前 head。`,
    ),
  );

  const confirmId = `merge-confirm-${safeId(candidate.id)}`;
  const methodId = `merge-method-${safeId(candidate.id)}`;
  box.append(
    h(
      "div",
      { class: "merge-actions" },
      h(
        "label",
        { class: "checkbox merge-confirm", for: confirmId },
        h("input", {
          id: confirmId,
          type: "checkbox",
          checked: entry.confirmed,
          disabled: mergePending(candidate) || ui.pending.has(`merge:${candidate.id}`),
          dataset: { mergeConfirm: candidate.id },
          onchange: (event) => {
            entry.confirmed = event.target.checked;
            updateAcceptanceChrome(candidate.id);
          },
        }),
        h("span", {}, "我已核对 PR、当前 head、用户与设计监督两种结论及合并方式，并确认发起合并。"),
      ),
      h(
        "label",
        { for: methodId, class: "field-label", style: { margin: "0" } },
        "合并方式",
      ),
      selectControl(MERGE_METHODS, entry.method, {
        id: methodId,
        disabled: mergePending(candidate) || ui.pending.has(`merge:${candidate.id}`),
        dataset: { focus: methodId },
        onchange: (event) => {
          entry.method = event.target.value;
          entry.confirmed = false;
          const confirm = findByData("merge-confirm", candidate.id);
          if (confirm) confirm.checked = false;
          updateAcceptanceChrome(candidate.id);
        },
      }),
      h(
        "button",
        {
          type: "button",
          class: "btn btn-primary",
          disabled: !state.ready || !entry.confirmed || ui.pending.has(`merge:${candidate.id}`) || !hasToken(),
          dataset: { mergeButton: candidate.id },
          title: state.ready ? "发送合并请求" : state.reasons.join("；"),
          onclick: () => mergeCandidate(candidate),
        },
        ui.pending.has(`merge:${candidate.id}`)
          ? "合并中…"
          : mergePending(candidate)
            ? "合并待核验"
            : "确认合并",
      ),
    ),
  );

  if (!state.ready) {
    box.append(
      h(
        "p",
        { class: "form-warn" },
        `暂不能合并：${state.reasons.join("；")}。前端不会补齐缺失结论或修改 head。`,
      ),
    );
  }
  const mergeError = ui.errors.get(`merge:${candidate.id}`);
  if (mergeError) box.append(h("p", { class: "form-error" }, mergeError));
  return box;
}

function mergePending(candidate) {
  if (!candidate) return false;
  if (candidate.mergePending === true) return true;
  const intent = candidate.mergeIntent;
  return Boolean(
    intent && typeof intent === "object" && String(intent.status || "").toLowerCase() === "pending",
  );
}

function mergePendingNote(candidate) {
  const intent = candidate && typeof candidate.mergeIntent === "object" ? candidate.mergeIntent : null;
  const note = intent && typeof intent.note === "string" ? intent.note.trim() : "";
  return note || "合并请求已提交，后台只通过只读核验确认结果，不会重复发送合并命令。";
}

function mergeState(candidate, pr, reviews) {
  const checks = [];
  const reasons = [];
  const userReview = reviews?.user || null;
  const designReview = reviews?.design || null;
  const prHead = str(pr?.headSha);

  const add = (status, label, reason) => {
    checks.push({ status, label });
    if (reason) reasons.push(reason);
  };

  if (mergePending(candidate)) {
    add("pending", "合并结果待核验", "合并结果待核验，不重复发送");
  }

  if (pr) add("done", "存在关联 PR");
  else add("blocked", "关联 PR 缺失", "尚无关联 PR");

  if (prHead) add("done", `PR 记录了当前 head ${shortRev(prHead)}`);
  else add("blocked", "PR 未记录 head", "PR 未记录当前 head");

  if (!userReview) {
    add("pending", "用户尚未验收", "用户尚未验收");
  } else if (userReview.verdict !== "approved") {
    add("blocked", "用户结论不是通过", "用户要求修改");
  } else if (!prHead || userReview.headSha !== prHead) {
    add("blocked", "用户验收未针对当前 head", "用户验收未针对当前 head");
  } else {
    add("done", "用户已通过当前 head");
  }

  if (!designReview) {
    add("pending", "设计监督尚未验收", "设计监督尚未验收");
  } else if (designReview.verdict !== "approved") {
    add("blocked", "设计监督结论不是通过", "设计监督要求修改");
  } else if (!prHead || designReview.headSha !== prHead) {
    add("blocked", "设计验收未针对当前 head", "设计验收未针对当前 head");
  } else {
    add("done", "设计监督已通过当前 head");
  }

  return {
    checks,
    ready: reasons.length === 0,
    reasons: unique(reasons),
  };
}

function renderEvidence(evidence) {
  if (evidence === null || evidence === undefined) return h("p", { class: "muted" }, "接口未提供证据。");
  const items = Array.isArray(evidence) ? evidence : [evidence];
  if (!items.length) return h("p", { class: "muted" }, "证据列表为空。");
  return h(
    "ul",
    { class: "evidence-list" },
    ...items.map((item) => {
      if (item === null || item === undefined) return h("li", { class: "evidence-item muted" }, "空记录");
      if (typeof item !== "object") return h("li", { class: "evidence-item" }, str(item));
      const status = item.status ?? item.result ?? item.outcome;
      const title = item.check ?? item.name ?? item.title ?? item.summary ?? "证据记录";
      const rest = {};
      for (const [key, value] of Object.entries(item)) {
        if (["status", "result", "outcome", "check", "name", "title", "summary"].includes(key)) continue;
        rest[key] = value;
      }
      return h(
        "li",
        { class: "evidence-item" },
        h(
          "div",
          { class: "evidence-head" },
          status !== undefined && status !== null
            ? badge(evidenceLabel(status), evidenceTone(status))
            : badge("状态未记录"),
          h("span", {}, str(title)),
        ),
        Object.keys(rest).length ? renderValue(redact(rest)) : null,
      );
    }),
  );
}

/* ---------------- 规则视图 ---------------- */

function renderSettingsView() {
  const section = h("section", { class: "view", "aria-labelledby": "settings-title" });
  section.append(
    h(
      "div",
      { class: "view-header" },
      h(
        "div",
        {},
        h("h2", { id: "settings-title" }, "规则与仓库"),
        h("p", { class: "view-sub" }, "配置收集范围与并发上限。类别之间 AND，同一类别列表内 OR；空仓库不收集。"),
      ),
    ),
  );

  if (!ui.settings) {
    section.append(h("div", { class: "empty-state" }, h("h3", {}, "设置尚未载入"), h("p", {}, "等待状态刷新后重试。")));
    return section;
  }

  const state = ui.settings;
  if (!ui.data?.settings) {
    section.append(h("p", { class: "form-warn" }, "状态响应未提供 settings 字段；以下为前端默认结构，请先核对后端合同后再保存。"));
  }
  if (state.stale) {
    section.append(
      h(
        "div",
        { class: "form-warn" },
        "服务端设置已在其他位置更新。当前未保存内容已保留；保存将以本页内容覆盖，请先核对。",
        h(
          "div",
          { class: "btn-row" },
          actionBtn(
            "放弃修改并载入服务端设置",
            null,
            () => {
              if (!state.dirty || window.confirm("放弃本地未保存的设置修改，并载入服务端当前设置？")) {
                initSettings(ui.data?.settings);
                render();
              }
            },
            { size: "small" },
          ),
        ),
      ),
    );
  }
  if (state.error) section.append(h("p", { class: "form-error" }, state.error));

  const form = h("form", {
    class: "settings-form",
    onsubmit: (event) => {
      event.preventDefault();
      saveSettings();
    },
  });

  const reposSection = h(
    "div",
    { class: "settings-section" },
    h("h3", {}, "仓库"),
    h(
      "p",
      { class: "hint" },
      "每个仓库需要 owner/repo 与基准引用；本机路径可留空用于仅收集需求，开发前需补齐。可添加多个仓库；全部清空时不会收集任何 Issue。",
    ),
  );
  const repoEditor = h("div", { class: "repo-editor" });
  if (!state.values.repositories.length) {
    repoEditor.append(h("p", { class: "small-empty" }, "当前没有仓库。添加至少一个仓库后才会收集 Issue。"));
  }
  state.values.repositories.forEach((repository, index) => {
    repoEditor.append(renderRepoRow(repository, index));
  });
  reposSection.append(
    repoEditor,
    h(
      "div",
      { class: "btn-row" },
      actionBtn(
        "添加仓库",
        null,
        () => {
          state.values.repositories.push({ repo: "", localPath: "", baseRef: "HEAD" });
          markSettingsDirty();
          render();
          const key = `settings-repo-${state.values.repositories.length - 1}-repo`;
          requestAnimationFrame(() => focusByKey(key)?.focus());
        },
        { size: "small" },
      ),
    ),
  );
  form.append(reposSection);

  const rules = state.values.rules;
  const rulesSection = h(
    "div",
    { class: "settings-section" },
    h("h3", {}, "筛选规则"),
    h(
      "p",
      { class: "hint" },
      "标签、作者、关键词和仓库列表内 OR，不同类别之间 AND；仓库范围为空时不会收集。匹配与否只影响候选池，不构成开发授权。",
    ),
    h(
      "div",
      { class: "rule-columns" },
      settingsTextarea("settings-rule-repositories", "仓库范围", rules.repositories, "每行一个 owner/repo；空列表不收集。", (value) => {
        rules.repositories = value;
      }),
      settingsTextarea("settings-rule-labels", "标签", rules.labels, "每行一个标签；同类别内 OR，不区分大小写。", (value) => {
        rules.labels = value;
      }),
      settingsTextarea("settings-rule-authors", "作者", rules.authors, "每行一个 GitHub 用户名；同类别内 OR。", (value) => {
        rules.authors = value;
      }),
      settingsTextarea("settings-rule-keywords", "关键词", rules.keywords, "每行一个关键词，匹配标题/正文；同类别内 OR。", (value) => {
        rules.keywords = value;
      }),
    ),
    h(
      "div",
      { class: "field" },
      h("span", { class: "field-label" }, "Issue 状态"),
      h(
        "div",
        { class: "checkbox-row" },
        ...[
          ["open", "open（打开）"],
          ["closed", "closed（已关闭）"],
        ].map(([value, label]) =>
          h(
            "label",
            { class: "checkbox" },
            h("input", {
              type: "checkbox",
              checked: rules.states.includes(value),
              onchange: (event) => {
                const set = new Set(rules.states);
                if (event.target.checked) set.add(value);
                else set.delete(value);
                rules.states = [...set];
                markSettingsDirty();
              },
            }),
            h("span", {}, label),
          ),
        ),
      ),
      h("p", { class: "hint" }, "未选择状态时，收集打开和已关闭的 Issue。"),
    ),
    h(
      "p",
      { class: "contract-note" },
      "规则字段说明：类别之间 AND；列表内 OR；repo、标签、作者、关键词不区分大小写；去重按 repo#number。收集只进入候选池。",
    ),
  );
  form.append(rulesSection);

  const concurrency = state.values.concurrency;
  const concurrencySection = h(
    "div",
    { class: "settings-section" },
    h("h3", {}, "并发上限"),
    h("p", { class: "hint" }, "全局与单仓上限同时生效；达到上限的任务保持排队，一个任务阻塞不阻塞其他就绪任务。"),
    h(
      "div",
      { class: "concurrency-row" },
      fieldWrap(
        "全局并发",
        h("input", {
          id: "settings-concurrency-global",
          type: "number",
          min: "1",
          step: "1",
          value: concurrency.global,
          dataset: { focus: "settings-concurrency-global" },
          oninput: (event) => {
            concurrency.global = event.target.value;
            markSettingsDirty();
          },
        }),
      ),
      fieldWrap(
        "单仓并发",
        h("input", {
          id: "settings-concurrency-repo",
          type: "number",
          min: "1",
          step: "1",
          value: concurrency.perRepo,
          dataset: { focus: "settings-concurrency-repo" },
          oninput: (event) => {
            concurrency.perRepo = event.target.value;
            markSettingsDirty();
          },
        }),
      ),
      fieldWrap(
        "监督间隔（秒）",
        h("input", {
          id: "settings-watch-interval",
          type: "number",
          min: "1",
          step: "1",
          value: String(ui.data?.runtime?.intervalSeconds ?? 60),
          disabled: true,
          title: "在页面顶部调整监督间隔",
        }),
        "在顶部开关旁调整；此处仅显示当前值。",
      ),
    ),
  );
  form.append(concurrencySection);

  form.append(
    h(
      "div",
      { class: "settings-actions" },
      h(
        "button",
        {
          type: "submit",
          class: "btn btn-primary",
          disabled: !state.dirty || ui.pending.has("settings-save") || !hasToken(),
          dataset: { settingsSave: "true" },
        },
        ui.pending.has("settings-save") ? "保存中…" : "保存设置",
      ),
      h(
        "button",
        {
          type: "button",
          class: "btn",
          disabled: !state.dirty,
          dataset: { settingsReset: "true" },
          onclick: () => resetSettings(),
        },
        "放弃修改",
      ),
      h(
        "span",
        {
          class: `form-status ${state.dirty ? "is-dirty" : "is-ok"}`,
          dataset: { settingsDirty: "true" },
        },
        state.dirty ? "有未保存修改" : "与服务端一致",
      ),
      ui.errors.get("settings-save") ? h("p", { class: "form-error" }, ui.errors.get("settings-save")) : null,
    ),
  );

  section.append(form);
  return section;
}

function renderRepoRow(repository, index) {
  const repoId = `settings-repo-${index}-repo`;
  const pathId = `settings-repo-${index}-path`;
  const refId = `settings-repo-${index}-ref`;
  return h(
    "div",
    { class: "repo-row" },
    h(
      "div",
      { class: "field-row-3" },
      fieldWrap(
        "仓库",
        h("input", {
          id: repoId,
          type: "text",
          value: repository.repo,
          placeholder: "owner/repo",
          dataset: { focus: repoId },
          oninput: (event) => {
            repository.repo = event.target.value;
            markSettingsDirty();
          },
        }),
      ),
      fieldWrap(
        "本地路径（可留空）",
        h("input", {
          id: pathId,
          type: "text",
          value: repository.localPath,
          placeholder: "/path/to/repository（可留空）",
          dataset: { focus: pathId },
          oninput: (event) => {
            repository.localPath = event.target.value;
            markSettingsDirty();
          },
        }),
      ),
      fieldWrap(
        "基准引用",
        h("input", {
          id: refId,
          type: "text",
          value: repository.baseRef,
          placeholder: "HEAD",
          dataset: { focus: refId },
          oninput: (event) => {
            repository.baseRef = event.target.value;
            markSettingsDirty();
          },
        }),
      ),
      h(
        "button",
        {
          type: "button",
          class: "btn btn-small btn-danger",
          "aria-label": `移除仓库 ${index + 1}`,
          onclick: () => {
            ui.settings.values.repositories.splice(index, 1);
            markSettingsDirty();
            render();
          },
        },
        "移除",
      ),
    ),
  );
}

function settingsTextarea(id, label, value, hintText, onChange) {
  return fieldWrap(
    label,
    h("textarea", {
      id,
      rows: "4",
      value,
      dataset: { focus: id },
      oninput: (event) => {
        onChange(event.target.value);
        markSettingsDirty();
      },
    }),
    hintText,
  );
}

function markSettingsDirty() {
  const state = ui.settings;
  if (!state) return;
  state.dirty = JSON.stringify(state.values) !== JSON.stringify(state.baseValues);
  updateSettingsChrome();
}

function updateSettingsChrome() {
  const state = ui.settings;
  if (!state) return;
  eachByData("settings-save", (node) => {
    node.disabled = !state.dirty || ui.pending.has("settings-save") || !hasToken();
  });
  eachByData("settings-reset", (node) => {
    node.disabled = !state.dirty;
  });
  const status = findByData("settings-dirty", "true");
  if (status) {
    status.textContent = state.dirty ? "有未保存修改" : "与服务端一致";
    status.className = `form-status ${state.dirty ? "is-dirty" : "is-ok"}`;
  }
}

function buildSettingsPayload(state) {
  const errors = [];
  const repositories = [];
  const seen = new Set();
  state.values.repositories.forEach((row, index) => {
    const repo = str(row.repo).trim();
    const localPath = str(row.localPath).trim();
    const baseRef = str(row.baseRef).trim() || "HEAD";
    if (!repo && !localPath && !str(row.baseRef).trim()) return;
    if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) errors.push(`第 ${index + 1} 行仓库需为 owner/repo。`);
    // 本地路径允许留空：仅收集 Issue；后续开发时由 Runtime 再检查。
    const key = repo.toLowerCase();
    if (repo && seen.has(key)) errors.push(`仓库重复：${repo}。`);
    if (repo) seen.add(key);
    repositories.push({ repo, localPath, baseRef });
  });

  const global = Number(state.values.concurrency.global);
  const perRepo = Number(state.values.concurrency.perRepo);
  if (!Number.isInteger(global) || global < 1) errors.push("全局并发需为 ≥1 的整数。");
  if (!Number.isInteger(perRepo) || perRepo < 1) errors.push("单仓并发需为 ≥1 的整数。");

  const states = state.values.rules.states.filter((value) => value === "open" || value === "closed");
  const payload = {
    repositories,
    rules: {
      repositories: parseLines(state.values.rules.repositories),
      labels: parseLines(state.values.rules.labels),
      authors: parseLines(state.values.rules.authors),
      keywords: parseLines(state.values.rules.keywords),
      states,
    },
    concurrency: { global, perRepo },
  };
  return { errors, payload };
}

/* ---------------- 操作 ---------------- */

async function collectAction() {
  if (!ensureToken()) return;
  await runAction("collect", async () => {
    const response = await api("/api/collect", { method: "POST", body: {} });
    setNotice(
      "ok",
      response?.started === true
        ? "已启动一次 Issue 收集；各仓库结果会分别写入事件。"
        : "收集请求已提交；请在事件中查看各仓库结果。",
    );
  });
}

async function watchAction(enabled, intervalRaw) {
  if (!ensureToken()) return;
  const interval = Number(intervalRaw);
  if (!Number.isInteger(interval) || interval < 1) {
    setNotice("danger", "监督间隔需为 ≥1 的整数秒。");
    render();
    return;
  }
  await runAction("watch", async () => {
    await api("/api/runtime/watch", {
      method: "POST",
      body: { enabled: Boolean(enabled), intervalSeconds: interval },
    });
  });
}

async function changeInterval(raw) {
  if (!ensureToken()) return;
  const interval = Number(raw);
  if (!Number.isInteger(interval) || interval < 1) {
    setNotice("danger", "监督间隔需为 ≥1 的整数秒。");
    render();
    return;
  }
  await runAction("watch", async () => {
    await api("/api/runtime/watch", {
      method: "POST",
      body: { enabled: Boolean(ui.data?.runtime?.watching), intervalSeconds: interval },
    });
  });
}

async function requestDraft(candidate) {
  if (!ensureToken()) return;
  await runAction(`draft-request:${candidate.id}`, async () => {
    await api(`/api/candidates/${encodeURIComponent(candidate.id)}/draft`, {
      method: "POST",
      body: {},
    });
    setNotice("ok", "已请求只读整理任务稿；完成后请核对并保存。");
  });
}

async function saveDraft(candidate) {
  const entry = currentDraftEntry(candidate);
  if (!entry) return;
  if (!ensureToken()) return;
  const errors = [];
  const acceptance = parseLines(entry.values.acceptance);
  const pendingDecisions = parseLines(entry.values.pendingDecisions);
  const dependsOn = parseLines(entry.values.dependsOn);
  const writeScopes = parseLines(entry.values.writeScopes);
  const priority = Number(entry.values.priority);
  if (!Number.isInteger(priority)) errors.push("优先级需为整数。");
  if (!str(entry.values.templateId).trim()) errors.push("模板 ID 不能为空。");
  for (const dependency of dependsOn) {
    if (!/^[^#\s/]+\/[^#\s]+\s*#\d+$/.test(dependency)) {
      errors.push(`依赖格式应为 owner/repo#编号：${dependency}`);
    }
  }
  if (!writeScopes.length) errors.push("写入范围不能为空；使用 * 表示全部路径。");
  if (errors.length) {
    entry.error = errors.join(" ");
    render();
    return;
  }
  entry.error = null;
  entry.conflict = false;
  const body = {
    goal: str(entry.values.goal).trim(),
    scope: entry.values.scope,
    acceptance,
    context: entry.values.context,
    pendingDecisions,
    templateId: str(entry.values.templateId).trim(),
    priority,
    dependsOn,
    writeScopes,
  };
  const baseRev = entry.baseRev || candidate.draft?.rev;
  if (baseRev) body.rev = baseRev;
  await runAction(`draft-save:${candidate.id}`, async () => {
    const updated = await api(`/api/candidates/${encodeURIComponent(candidate.id)}/draft`, {
      method: "PUT",
      body,
    });
    if (updated?.draft) {
      ui.drafts.set(candidate.id, initDraftEntry(updated.draft));
    } else {
      const current = ui.drafts.get(candidate.id);
      if (current) current.savedPending = true;
    }
    setNotice("ok", "任务稿已保存。开发确认只针对保存后的版本。");
  });
}

async function decide(candidate, action) {
  const entry = currentDraftEntry(candidate);
  const key = `decision:${candidate.id}:${action}`;
  if (!ensureToken()) return;
  const blockers = action === "develop" ? developBlockers(candidate, entry) : decisionCommonBlockers(candidate);
  if (blockers.length) {
    ui.errors.set(key, blockers.join("；"));
    render();
    return;
  }
  const draftRev = candidate.draft?.rev || entry?.baseRev;
  const body = { action };
  if (draftRev) body.draftRev = draftRev;
  await runAction(key, async () => {
    await api(`/api/candidates/${encodeURIComponent(candidate.id)}/decision`, {
      method: "POST",
      body,
    });
    const messages = {
      develop: "已确认开发；监督循环会自动领取，不需要额外派发步骤。",
      defer: "已暂缓该候选需求。",
      ignore: "已忽略该候选需求。",
    };
    setNotice("ok", messages[action] || "决定已提交。");
  });
}

async function retryCandidate(candidate) {
  if (!ensureToken()) return;
  await runAction(`retry:${candidate.id}`, async () => {
    await api(`/api/candidates/${encodeURIComponent(candidate.id)}/retry`, {
      method: "POST",
      body: {},
    });
    setNotice("ok", "已请求重试；后端会核对当前开发授权与原执行状态。");
  });
}

async function cancelRun(run) {
  if (!ensureToken()) return;
  if (!window.confirm(`取消运行 ${run.id}？后端会请求并确认进程停止后记为阻塞，并保留工作目录。`)) return;
  await runAction(`cancel:${run.id}`, async () => {
    await api(`/api/runs/${encodeURIComponent(run.id)}/cancel`, {
      method: "POST",
      body: {},
    });
    setNotice("ok", "已提交取消请求；请在后端确认进程停止并记录阻塞后刷新核对。");
  });
}

async function recordAcceptance(candidate, role, verdict) {
  const entry = acceptanceEntry(candidate);
  const headSha = str(entry.headSha).trim();
  const key = `acceptance:${candidate.id}:${role}`;
  if (!headSha) {
    ui.errors.set(key, "验收提交 head 不能为空。");
    render();
    return;
  }
  const comment = role === "design" ? str(entry.designComment).trim() : str(entry.userComment).trim();
  if (role === "design" && !comment) {
    ui.errors.set(key, "设计验收需要填写监督结论或引用。");
    render();
    return;
  }
  if (!ensureToken()) return;
  await runAction(key, async () => {
    await api(`/api/candidates/${encodeURIComponent(candidate.id)}/acceptance`, {
      method: "POST",
      body: { role, verdict, headSha, comment },
    });
    if (role === "user") entry.userComment = "";
    else entry.designComment = "";
    entry.confirmed = false;
    setNotice("ok", `已记录${role === "user" ? "用户" : "设计监督"}对提交 ${shortRev(headSha)} 的验收结论。`);
  });
}

async function mergeCandidate(candidate) {
  const entry = acceptanceEntry(candidate);
  const pr = candidate.latestResult?.pr;
  const key = `merge:${candidate.id}`;
  if (mergePending(candidate)) {
    ui.errors.set(key, `合并结果待核验：${mergePendingNote(candidate)} 不会重复发送合并命令。`);
    render();
    return;
  }
  if (!pr) {
    ui.errors.set(key, "没有关联 PR，不能合并。");
    render();
    return;
  }
  if (!entry.confirmed) {
    ui.errors.set(key, "请先勾选确认，明确发起合并。");
    render();
    return;
  }
  const state = mergeState(candidate, pr, candidate.reviews || {});
  if (!state.ready) {
    ui.errors.set(key, `暂不能合并：${state.reasons.join("；")}`);
    render();
    return;
  }
  if (!ensureToken()) return;
  await runAction(key, async () => {
    const response = await api(`/api/candidates/${encodeURIComponent(candidate.id)}/merge`, {
      method: "POST",
      body: { expectedHeadSha: pr.headSha, confirmed: true, method: entry.method },
    });
    entry.confirmed = false;
    if (response?.merged === true && response.mergeSha) {
      setNotice("ok", `合并完成，merge commit：${response.mergeSha}`);
      return;
    }
    if (response?.merged === true && !response.mergeSha) {
      setNotice(
        "warn",
        "服务端返回 merged=true 但未提供完整 merge SHA，结果未确认；请核对 PR 实际状态，不会重复发送合并命令。",
      );
      return;
    }
    if (response?.pending === true) {
      setNotice(
        "warn",
        `合并结果待核验：${str(response.note) || "后台只读核对中"} 刷新后仍会显示服务器持久 pending，不会重复发送。`,
      );
      return;
    }
    setNotice(
      "warn",
      `合并未确认：${str(response?.note) || "服务端未返回 merged=true 和 merge SHA"}。请在 PR 核对实际状态，不要重复点击。`,
    );
  });
}

async function saveSettings() {
  const state = ui.settings;
  if (!state) return;
  const { errors, payload } = buildSettingsPayload(state);
  if (errors.length) {
    state.error = errors.join(" ");
    render();
    return;
  }
  if (!ensureToken()) return;
  state.error = null;
  await runAction("settings-save", async () => {
    const response = await api("/api/settings", { method: "PUT", body: payload });
    const effective = response?.settings ?? response;
    if (effective && typeof effective === "object" && Array.isArray(effective.repositories)) {
      initSettings(effective);
    } else {
      state.baseValues = clonePlain(state.values);
      state.dirty = false;
    }
    setNotice("ok", "规则与仓库配置已保存。");
  });
}

function resetSettings() {
  const state = ui.settings;
  if (!state) return;
  if (state.dirty && !window.confirm("放弃本地未保存的设置修改？")) return;
  initSettings(ui.data?.settings);
  ui.errors.delete("settings-save");
  render();
}

function updateAcceptanceChrome(id) {
  const candidate = candidateById(id);
  const entry = ui.acceptance.get(id);
  if (!candidate || !entry) return;
  const headReady = Boolean(str(entry.headSha).trim());
  for (const node of findAllData("acceptance-action")) {
    if (node.dataset.candidateId !== id) continue;
    const role = node.dataset.acceptanceAction;
    const key = `acceptance:${id}:${role}`;
    const commentReady = role !== "design" || Boolean(str(entry.designComment).trim());
    node.disabled = !headReady || !commentReady || ui.pending.has(key) || !hasToken();
  }
  const confirm = findByData("merge-confirm", id);
  if (confirm) confirm.checked = Boolean(entry.confirmed);
  const mergeButton = findByData("merge-button", id);
  if (mergeButton) {
    const state = mergeState(candidate, candidate.latestResult?.pr || null, candidate.reviews || {});
    mergeButton.disabled =
      !state.ready || !entry.confirmed || ui.pending.has(`merge:${id}`) || !hasToken();
    mergeButton.title = state.ready ? "发送合并请求" : state.reasons.join("；");
  }
}

/* ---------------- 启动 ---------------- */

function boot() {
  render();
  refreshState();
  window.setInterval(() => {
    if (document.visibilityState === "hidden") return;
    refreshState();
  }, POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshState();
  });
  window.addEventListener("online", () => refreshState(true));
}

boot();
