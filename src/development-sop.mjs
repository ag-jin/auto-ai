import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';

export const DEVELOPMENT_SOP_ID = 'development-sop@1.0.0';
export const DEVELOPMENT_RESULT_TEMPLATE = 'development-result@1.0.0';
export const REVIEW_RESULT_TEMPLATE = 'review-result@1.0.0';

const LANE_IDS = ['develop-a', 'develop-b'];
const LANE_KEYS = ['sop', 'template', 'draft_rev', 'step', 'artifact'];
const REVIEW_KEYS = ['sop', 'template', 'draft_rev', 'outcome', 'step', 'reason', 'acceptance'];
const ACTIVE = ['starting', 'started', 'running', 'unknown'];
const TERMINAL = ['completed', 'failed', 'cancelled'];
const CHECK_TIMEOUT_MS = 300_000;
const MAX_DETAIL = 1_200;
const MAX_DIFF = 60_000;
const exec = promisify(execFile);

export function parseSopPlan(text, version) {
  const plan = yamlMap(text, 'SOP 计划');
  if (plan.sop !== DEVELOPMENT_SOP_ID || plan.sop !== `development-sop@${version}` ||
      plan.handoff !== DEVELOPMENT_RESULT_TEMPLATE || plan.review !== REVIEW_RESULT_TEMPLATE || plan.max_reworks !== 1) {
    throw new Error(`未实现的 SOP、交接模板或返工规则：${plan.sop ?? '缺少 sop'}`);
  }
  return plan;
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const now = () => new Date().toISOString();
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const msg = (error) => String(error instanceof Error ? error.message : error).replace(/\bgh[pousr]_[A-Za-z0-9_]+/g, '<redacted>');
const clip = (value, limit = MAX_DETAIL) => {
  const text = String(value ?? '');
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…（已截断）`;
};
// Keep the beginning: assertion messages sit there, not in the tail.
const head = (value) => clip(String(value ?? '').split('\n').map((line) => line.trimEnd()).filter((line) => line.trim()).slice(0, 12).join('\n'));

function relative(value, name) {
  const text = String(value ?? '').trim();
  const bad = text.split('/').some((segment) => !segment || segment === '.' || segment === '..');
  if (!text || text.startsWith('/') || text.includes('\\') || bad) throw new Error(`${name} 必须是仓库内相对路径`);
  return text;
}

function yamlMap(text, label) {
  if (typeof text !== 'string' || !text.trim()) throw new Error(`${label} 为空`);
  const fence = /^```(?:ya?ml)?\s*\n([\s\S]*?)\n```$/i.exec(text.trim());
  let value;
  try {
    value = parseYaml(fence ? fence[1] : text.trim());
  } catch (error) {
    throw new Error(`${label} 不是合法 YAML：${msg(error)}`);
  }
  if (!isObject(value)) throw new Error(`${label} 必须是 YAML 映射`);
  return value;
}

export function parseSopTask(source) {
  if (!isObject(source) || typeof source.context !== 'string' || !source.context.trim()) {
    throw new Error('draft.context 必须是已批准的 SOP YAML');
  }
  const draftRev = String(source.rev ?? '').trim();
  if (!draftRev) throw new Error('draft.rev 缺失');
  const context = yamlMap(source.context, 'draft.context');
  if (context.sop !== undefined && context.sop !== DEVELOPMENT_SOP_ID) throw new Error(`draft.context.sop 必须是 ${DEVELOPMENT_SOP_ID}`);
  const lanes = (Array.isArray(context.lanes) ? context.lanes : []).map((lane, index) => {
    if (!isObject(lane) || !LANE_IDS.includes(lane.id)) throw new Error(`lanes[${index}].id 只能是 ${LANE_IDS.join(' / ')}`);
    return { id: lane.id, path: relative(lane.path, `lanes[${index}].path`), goal: String(lane.goal ?? '').trim() };
  });
  if (lanes.length !== 2 || new Set(lanes.map((lane) => lane.id)).size !== 2) throw new Error('draft.context.lanes 必须正好两路且 id 不重复');
  if (new Set(lanes.map((lane) => lane.path)).size !== 2) throw new Error('lane 路径必须互不相同');
  for (const lane of lanes) {
    if (!source.writeScopes.some((scope) => scope === '*' || scope === lane.path || lane.path.startsWith(`${scope}/`))) {
      throw new Error(`lane ${lane.id} 的路径不在 writeScopes 内：${lane.path}`);
    }
  }
  lanes.sort((left, right) => LANE_IDS.indexOf(left.id) - LANE_IDS.indexOf(right.id));
  const checks = (Array.isArray(context.checks) ? context.checks : []).map((check, index) => {
    if (!isObject(check) || !lanes.some((lane) => lane.id === check.lane) || !Array.isArray(check.args) || !check.args.length) {
      throw new Error(`checks[${index}] 必须是 {lane, args} 且 lane 已声明`);
    }
    const args = check.args.map((arg, position) => {
      if (typeof arg !== 'string' || !arg) throw new Error(`checks[${index}].args[${position}] 必须是非空字符串`);
      return arg;
    });
    const script = relative(args[0], `checks[${index}].args[0]`);
    if (!/\.(?:mjs|cjs|js)$/i.test(script)) throw new Error(`检查脚本必须是 .mjs/.cjs/.js：${script}`);
    if (lanes.some((lane) => script === lane.path || script.startsWith(`${lane.path}/`))) throw new Error(`检查脚本不得位于 lane 写入范围：${script}`);
    return { lane: check.lane, args: [script, ...args.slice(1)] };
  });
  if (!checks.length) throw new Error('draft.context.checks 必须是非空数组');
  const acceptance = (Array.isArray(source.acceptance) ? source.acceptance : [source.acceptance]).map((item) => String(item ?? '')).filter((item) => item.trim());
  if (!acceptance.length) throw new Error('draft.acceptance 不能为空');
  return {
    sop: DEVELOPMENT_SOP_ID, draftRev, acceptance, context: source.context.trim(), lanes, checks,
    goal: String(source.goal ?? '').trim(), scope: String(source.scope ?? '').trim(),
  };
}

class DevelopmentSop {
  #run; #control; #repoEntry; #workspace; #pi; #persist; #valid; #closing; #worktree;
  constructor({ run, control, repoEntry, workspace, pi, persist, valid, closing }) {
    if (!isObject(run) || typeof run.id !== 'string' || !run.id) throw new Error('run.id 缺失');
    if (!isObject(control) || !isObject(control.prepare)) throw new Error('SOP 执行缺少 control.prepare');
    for (const key of ['worktreePath', 'baseCommit', 'baseBranch', 'resultPath']) {
      if (typeof control.prepare[key] !== 'string' || !control.prepare[key]) throw new Error(`SOP 执行缺少 control.prepare.${key}`);
    }
    if (!isObject(repoEntry) || typeof repoEntry.localPath !== 'string' || !repoEntry.localPath) throw new Error('SOP 执行缺少仓库本地路径');
    if (!workspace || !pi || typeof persist !== 'function') throw new Error('SOP 执行依赖缺失');
    this.#run = run;
    this.#control = control;
    this.#repoEntry = repoEntry;
    this.#workspace = workspace;
    this.#pi = pi;
    this.#persist = persist;
    this.#valid = typeof valid === 'function' ? valid : null;
    this.#closing = closing;
    this.#worktree = control.prepare.worktreePath;
  }
  get #state() { return this.#control.sop; }
  get #base() { return this.#control.prepare.baseCommit; }
  #closingNow() { return typeof this.#closing === 'function' ? this.#closing() : this.#closing; }
  #save() { return this.#persist(this.#control); }

  async advance(plan) {
    if (!isObject(this.#state)) {
      this.#init(plan);
      await this.#save();
    }
    const state = this.#state;
    if (state.cancelRequested) return { state: 'pending' };
    if (state.result) return { state: 'completed', result: state.result };
    if (state.stopPending) return await this.#block(state.blockReason ?? '存在未确认停止的 Pi');
    if (!(await this.#authorized())) return await this.#block('开发授权已失效，停止执行并确认已启动的 Pi 停止');
    for (let step = 0; step < 6; step += 1) {
      if (this.#closingNow()) return { state: 'pending' };
      const stage = { lanes: this.#lanes, checks: this.#checks, review: this.#review }[state.status];
      if (!stage) return await this.#hold(`未知 SOP 阶段：${state.status}`);
      const outcome = await stage.call(this);
      if (outcome !== 'next') return outcome;
    }
    return { state: 'pending' };
  }
  #init(plan) {
    if (!isObject(this.#run.draftSnapshot)) throw new Error('SOP 执行缺少 run.draftSnapshot');
    const task = parseSopTask(this.#run.draftSnapshot);
    const lanes = {};
    for (const lane of task.lanes) {
      lanes[lane.id] = {
        ...lane, status: 'pending', attempt: 1, piId: null, piStatus: null,
        worktreePath: null, baseCommit: null, hash: null, feedback: null,
      };
    }
    this.#control.sop = {
      plan: { handoff: plan?.handoff, review: plan?.review, max_reworks: Number.isInteger(plan?.max_reworks) ? plan.max_reworks : 0 },
      task: {
        draftRev: task.draftRev, goal: task.goal, acceptance: task.acceptance, context: task.context,
        order: task.lanes.map((lane) => lane.id), checks: task.checks,
      },
      lanes, status: 'lanes', reworks: [], checksRun: [], review: null,
      reviewRound: 0, result: null, testedTree: null, hold: null,
    };
  }
  async #lanes() {
    let pending = false;
    for (const id of this.#state.task.order) {
      const lane = this.#state.lanes[id];
      if (lane.status === 'validated') continue;
      const outcome = await this.#lane(lane);
      if (outcome === 'pending') {
        pending = true;
        continue;
      }
      if (outcome !== 'next') return outcome;
      if (lane.status !== 'validated') pending = true;
    }
    if (pending) return { state: 'pending' };
    try {
      for (const id of this.#state.task.order) {
        const lane = this.#state.lanes[id];
        const content = await readFile(path.join(lane.worktreePath, lane.path));
        if (sha256(content) !== lane.hash) throw new Error(`lane ${id} 的 ${lane.path} 与校验哈希不一致`);
        const target = path.join(this.#worktree, lane.path);
        await mkdir(path.dirname(target), { recursive: true });
        const existing = await lstat(target).catch(() => null);
        if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new Error(`父集成树的 ${lane.path} 不是普通文件`);
        await writeFile(target, content);
      }
    } catch (error) {
      return await this.#hold(`汇总两路 lane 产物失败：${msg(error)}`);
    }
    this.#state.status = 'checks';
    await this.#save();
    return 'next';
  }
  async #lane(lane) {
    if (!lane.worktreePath) {
      try {
        const created = await this.#workspace.create({
          repo: this.#run.repo, localPath: this.#repoEntry.localPath, baseRef: this.#base,
          baseBranch: this.#control.prepare.baseBranch, runId: `${this.#run.id}-${lane.id}`,
        });
        if (created.baseCommit !== this.#base) return await this.#block(`lane ${lane.id} 基线 ${created.baseCommit} 与父树不一致`);
        Object.assign(lane, { worktreePath: created.worktreePath, baseCommit: created.baseCommit });
        await this.#save();
      } catch (error) {
        return await this.#block(`创建 lane ${lane.id} 工作树失败：${msg(error)}`);
      }
    }
    if (!lane.piId) {
      lane.piId = `${this.#run.id}-${lane.id}-${lane.attempt}`;
      lane.piStatus = 'starting';
      await this.#save();
    }
    let status;
    try {
      status = await this.#poll(lane.piId, lane.worktreePath, 'worker', () => this.#lanePrompt(lane));
    } catch (error) {
      return await this.#hold(`${msg(error)}；lane ${lane.id}`);
    }
    if (status === 'denied') return await this.#block('开发授权已失效，停止派发新的 lane');
    if (!status) return 'next';
    if (status.state === 'running') {
      if (lane.piStatus !== 'running') Object.assign(lane, { piStatus: 'running' }) && (await this.#save());
      return 'pending';
    }
    if (status.state === 'unknown') return await this.#hold(`lane ${lane.id} 的 Pi 状态不明：${status.error ?? ''}`);
    if (status.state !== 'completed') {
      lane.piStatus = status.state;
      return await this.#rework(lane.id, 'lane', `lane ${lane.id} 的 Pi ${status.state}：${status.error ?? ''}`);
    }
    lane.piStatus = 'completed';
    try {
      const handoff = yamlMap(status.output, `lane ${lane.id} 的交接`);
      const expected = { sop: DEVELOPMENT_SOP_ID, template: this.#state.plan.handoff, draft_rev: this.#state.task.draftRev, step: lane.id, artifact: lane.path };
      for (const key of LANE_KEYS) {
        if (!(key in handoff)) throw new Error(`lane ${lane.id} 交接缺少键 ${key}`);
        if (handoff[key] !== expected[key]) throw new Error(`lane ${lane.id} 交接的 ${key} 应为 ${expected[key]}，实际为 ${handoff[key]}`);
      }
      for (const key of Object.keys(handoff)) if (!LANE_KEYS.includes(key)) throw new Error(`lane ${lane.id} 交接含未知键 ${key}`);
      const base = String(this.#base).toLowerCase();
      const info = await this.#workspace.inspect({ worktreePath: lane.worktreePath });
      if (String(info.headSha).toLowerCase() !== base || String(lane.baseCommit).toLowerCase() !== base) {
        throw new Error(`lane ${lane.id} 的 HEAD ${info.headSha} 不是基线 ${this.#base}`);
      }
      const paths = [...new Set(info.paths ?? [])].sort();
      if (paths.length !== 1 || paths[0] !== lane.path) throw new Error(`lane ${lane.id} 只允许改 ${lane.path}，实际：${paths.join('、') || '无改动'}`);
      const source = path.join(lane.worktreePath, lane.path);
      const stat = await lstat(source);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`lane ${lane.id} 的 ${lane.path} 不是普通文件`);
      lane.hash = sha256(await readFile(source));
    } catch (error) {
      return await this.#rework(lane.id, 'handoff', msg(error));
    }
    Object.assign(lane, { status: 'validated', piStatus: 'completed', feedback: null });
    await this.#save();
    return 'next';
  }
  #lanePrompt(lane) {
    const state = this.#state;
    const rework = lane.feedback ? `## 返工要求（同一工作树、同一文件修正；另一 lane 不会重跑）\n上一轮未通过：${lane.feedback.stage}\n${clip(lane.feedback.reason)}\n` : '';
    return `你是双路开发 SOP（${DEVELOPMENT_SOP_ID}）的独立开发 Worker：lane ${lane.id}。
- 唯一允许修改的文件：${lane.path}（仓库内相对路径），可创建或整文件覆盖。
- 不得改其它文件、不得创建符号链接、不得运行 git、不得安装依赖或联网。
- 完成后只输出一个 YAML 映射：sop: ${DEVELOPMENT_SOP_ID} / template: ${state.plan.handoff} / draft_rev: ${state.task.draftRev} / step: ${lane.id} / artifact: ${lane.path}
${rework}## 已批准任务稿（只读）
- 目标：${state.task.goal}
- 验收（自然语言原文）：${state.task.acceptance.join('\n')}
- 本 lane 目标：${lane.goal}
\`\`\`yaml
${state.task.context}
\`\`\``;
  }
  async #checks() {
    const state = this.#state;
    const before = await this.#integrationTree();
    if (!before) return await this.#hold('父工作树与两路交接不一致，不能开始测试');
    const results = [];
    for (const check of state.task.checks) {
      if (!(await this.#authorized())) {
        state.checksRun = results;
        await this.#save();
        return await this.#block('开发授权已失效，停止派发新的检查');
      }
      const command = ['node', ...check.args].join(' ');
      let result;
      try {
        const outcome = await this.#runCheck(check);
        result = { lane: check.lane, command, ...outcome };
      } catch (error) {
        result = { lane: check.lane, command, status: 'failed', detail: clip(msg(error)) };
      }
      results.push(result);
      if (result.status !== 'passed') {
        state.checksRun = results;
        await this.#save();
        return await this.#rework(check.lane, 'check', `${command}：${result.detail}`);
      }
    }
    if ((await this.#integrationTree()) !== before) return await this.#hold('检查期间父工作树产物发生变化，检查证据作废');
    state.checksRun = results;
    state.testedTree = before;
    state.status = 'review';
    await this.#save();
    return 'next';
  }

  /** Script must match the fixed base, stay outside lane scopes, not be a symlink. */
  async #runCheck(check) {
    const state = this.#state;
    const script = check.args[0];
    for (const id of state.task.order) {
      const lanePath = state.lanes[id].path;
      if (script === lanePath || script.startsWith(`${lanePath}/`)) throw new Error(`检查脚本 ${script} 位于 lane ${id} 的写入范围`);
    }
    await this.#git(['rev-parse', '--verify', '--quiet', `${this.#base}:${script}`], `检查脚本不在固定基线中：${script}`);
    await this.#git(['diff', '--quiet', this.#base, '--', script], `检查脚本相对固定基线已被修改：${script}`);
    const absolute = path.join(this.#worktree, script);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`检查脚本不是普通文件：${script}`);
    const outcome = await new Promise((resolve) => {
      execFile(process.execPath, [absolute, ...check.args.slice(1)], {
        cwd: this.#worktree, env: checkEnvironment(), shell: false, timeout: CHECK_TIMEOUT_MS, maxBuffer: 4 << 20,
      }, (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, text: '' });
        if (error.killed || error.signal) return resolve({ code: null, text: `超时 ${CHECK_TIMEOUT_MS}ms 未结束` });
        const code = Number.isInteger(error.code) ? error.code : null;
        resolve({ code, text: head(String(stderr ?? '').trim() || String(stdout ?? '')) || msg(error) });
      });
    });
    return outcome.code === 0
      ? { status: 'passed', detail: '退出码 0' }
      : { status: 'failed', detail: clip(`退出码 ${outcome.code ?? '未知'}：${outcome.text}`) };
  }
  #git(args, label) {
    return exec('git', ['-C', this.#worktree, ...args], { timeout: 60_000, maxBuffer: 4 << 20 })
      .then(({ stdout }) => stdout)
      .catch((error) => { throw new Error(label ?? msg(error)); });
  }
  async #review() {
    const state = this.#state;
    if (!state.review) {
      if (!(await this.#authorized())) return await this.#block('开发授权已失效，停止派发新的评审');
      state.reviewRound += 1;
      const round = state.reviewRound;
      state.review = { round, piId: `${this.#run.id}-review-${round}`, piStatus: 'starting' };
      await this.#save();
    }
    const review = state.review;
    let status;
    try {
      status = await this.#poll(review.piId, this.#worktree, 'draft', () => this.#reviewPrompt(review.round));
    } catch (error) {
      return await this.#hold(`独立评审：${msg(error)}`);
    }
    if (status === 'denied') return await this.#block('开发授权已失效，停止派发新的评审');
    if (!status) return { state: 'pending' };
    if (status.state === 'running') {
      if (review.piStatus !== 'running') Object.assign(review, { piStatus: 'running' }) && (await this.#save());
      return { state: 'pending' };
    }
    if (status.state === 'unknown') return await this.#hold(`独立评审的 Pi 状态不明：${status.error ?? ''}`);
    review.piStatus = status.state;
    if (status.state !== 'completed') return await this.#block(`独立评审的 Pi ${status.state}：${status.error ?? ''}`);

    let verdict;
    try {
      const value = yamlMap(status.output, 'review 结果');
      const outcome = value.outcome;
      if (outcome !== 'approved' && outcome !== 'changes_requested') throw new Error('review.outcome 只能是 approved 或 changes_requested');
      for (const key of Object.keys(value)) if (!REVIEW_KEYS.includes(key) || (key === 'step' && outcome === 'approved')) throw new Error(`review 结果含未知键 ${key}`);
      for (const key of ['sop', 'template', 'draft_rev', 'outcome', 'reason']) if (!(key in value)) throw new Error(`review 结果缺少键 ${key}`);
      if (value.sop !== DEVELOPMENT_SOP_ID) throw new Error(`review.sop 应为 ${DEVELOPMENT_SOP_ID}`);
      if (value.template !== state.plan.review) throw new Error(`review.template 应为 ${state.plan.review}`);
      if (value.draft_rev !== state.task.draftRev) throw new Error(`review.draft_rev 应为 ${state.task.draftRev}`);
      if (outcome === 'changes_requested' && !state.task.order.includes(value.step)) throw new Error(`review.step 必须是 ${state.task.order.join(' / ')} 之一`);
      const reason = String(value.reason ?? '').trim();
      if (!reason) throw new Error('review.reason 不能为空');
      let acceptance;
      if (outcome === 'approved') {
        if (!Array.isArray(value.acceptance) || value.acceptance.length !== state.task.acceptance.length) {
          throw new Error(`review.acceptance 必须是与批准稿验收项等长的数组（${state.task.acceptance.length} 项）`);
        }
        acceptance = value.acceptance.map((item, index) => {
          if (typeof item !== 'string' || !item.trim()) throw new Error(`review.acceptance[${index}] 必须是非空字符串`);
          return item.trim();
        });
      }
      verdict = { outcome, reason, step: value.step, acceptance };
    } catch (error) {
      return await this.#block(`独立评审结果无效：${msg(error)}`);
    }
    if (verdict.outcome === 'approved') {
      if ((await this.#integrationTree()) !== state.testedTree) return await this.#hold('父工作树产物在评审期间发生变化，评审结论不再对应当前产物');
      return await this.#finish(verdict.reason, verdict.acceptance);
    }
    state.review = null;
    return await this.#rework(verdict.step, 'review', verdict.reason);
  }
  async #reviewPrompt(round) {
    const state = this.#state;
    const evidence = state.checksRun.map((item) => `- [${item.status}] ${item.command}：${clip(item.detail, 300)}`).join('\n') || '- 无';
    const diff = await this.#git(['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', this.#base, state.testedTree]);
    if (!diff || diff.length > MAX_DIFF || /^Binary files .* differ$/m.test(diff)) {
      throw new Error('独立评审需要完整的文本 diff，当前产物无法完整呈现');
    }
    return `你是双路开发 SOP（${DEVELOPMENT_SOP_ID}）的独立代码评审者，只读、无工具。只依据批准稿、最终 diff 和真实检查证据判断。
## 已批准任务稿（只读）
- 目标：${state.task.goal}
- 验收（自然语言原文，判断依据）：
${state.task.acceptance.map((item, index) => `${index + 1}. ${item}`).join('\n')}
- draft_rev：${state.task.draftRev}
\`\`\`yaml
${state.task.context}
\`\`\`
## 最终 diff（第 ${round} 轮评审）
\`\`\`diff
${diff.trimEnd()}
\`\`\`
## 检查证据（父集成工作树真实执行）
${evidence}
## 输出要求：只输出一个 YAML 映射。通过：sop: ${DEVELOPMENT_SOP_ID} / template: ${state.plan.review} / draft_rev: ${state.task.draftRev} / outcome: approved / reason / acceptance。acceptance 必须是与批准稿验收项等长、同序的字符串数组，逐项引用最终 diff 或检查证据说明该项如何满足，不得合并、省略或留空。返工：同上，outcome: changes_requested，并给出 step: ${state.task.order.join(' 或 ')} 与具体 reason。`;
  }

  async #integrationTree() {
    const lanes = this.#state.task.order.map((id) => this.#state.lanes[id]);
    const paths = lanes.map((lane) => lane.path);
    const info = await this.#workspace.inspect({ worktreePath: this.#worktree });
    if (info.headSha !== this.#base || info.paths.length !== paths.length ||
        info.paths.some((file) => !paths.includes(file))) return null;
    for (const lane of lanes) {
      const file = path.join(this.#worktree, lane.path);
      const stat = await lstat(file);
      if (!stat.isFile() || sha256(await readFile(file)) !== lane.hash) return null;
    }
    await this.#git(['--literal-pathspecs', 'add', '--', ...paths]);
    return (await this.#git(['write-tree'])).trim();
  }
  async #finish(reason, acceptance) {
    if (!(await this.#authorized())) return await this.#block('交付前授权已失效');
    const state = this.#state;
    const evidence = state.task.order.map((id) => ({ command: `development-sop handoff ${id}`, status: 'passed', detail: `${state.lanes[id].path} sha256:${String(state.lanes[id].hash).slice(0, 12)}` }));
    for (const check of state.checksRun) evidence.push({ command: check.command, status: check.status, detail: check.detail });
    evidence.push({
      command: 'development-sop review', status: 'passed',
      detail: `独立评审 approved（第 ${state.review.round} 轮）${state.reworks.length ? `，返工 ${state.reworks.length} 次` : ''}：${clip(reason, 300)}`,
    });
    state.task.acceptance.forEach((item, index) => evidence.push({
      command: `development-sop acceptance ${index + 1}`, status: 'passed', detail: clip(`验收项：${item}\n评审证据：${acceptance[index]}`),
    }));
    state.review.acceptance = acceptance;
    const result = {
      summary: `SOP ${DEVELOPMENT_SOP_ID} 两路开发通过：${state.task.order.map((id) => `${id} → ${state.lanes[id].path}`).join('，')}；${state.checksRun.length} 项检查通过；独立评审 approved`,
      artifacts: state.task.order.map((id) => state.lanes[id].path), evidence, blockers: [],
    };
    Object.assign(state, { result, status: 'passed', hold: null });
    await this.#save();
    return { state: 'completed', result };
  }
  async #rework(laneId, stage, reason) {
    const state = this.#state;
    const lane = state.lanes[laneId];
    if (!lane) return await this.#block(`返工目标 lane 不存在：${laneId}`);
    if (state.reworks.length >= state.plan.max_reworks) return await this.#block(`返工次数已用尽（max_reworks=${state.plan.max_reworks}）：${reason}`);
    state.reworks.push({ step: laneId, stage, reason: clip(reason) });
    Object.assign(lane, { status: 'pending', attempt: lane.attempt + 1, piId: null, piStatus: null, hash: null, feedback: { stage, reason: String(reason) } });
    Object.assign(state, { status: 'lanes', review: null, checksRun: [], testedTree: null, hold: null });
    await this.#save();
    return 'next';
  }
  async #authorized() {
    if (!this.#valid) return true;
    try {
      const value = await this.#valid();
      return value !== false && !(isObject(value) && value.ok === false);
    } catch {
      return false;
    }
  }

  /** A definite stop requires every started Pi confirmed terminal. */
  async #block(reason) {
    const state = this.#state;
    state.blockReason = clip(reason);
    const ids = state.task.order.map((id) => state.lanes[id]).filter((lane) => lane.piId && ACTIVE.includes(lane.piStatus)).map((lane) => lane.piId);
    if (state.review?.piId && ACTIVE.includes(state.review.piStatus)) ids.push(state.review.piId);
    for (const id of ids) {
      let stopped;
      try {
        stopped = TERMINAL.includes((await this.#pi.cancel(id))?.state);
      } catch (error) {
        stopped = /未找到任务/.test(msg(error));
      }
      if (!stopped) {
        state.stopPending = true;
        return await this.#hold(`${state.blockReason}（Pi 未确认停止，保持占用）`);
      }
    }
    state.stopPending = false;
    await this.#save();
    return { state: 'blocked', reason: state.blockReason };
  }
  async #hold(reason) {
    this.#state.hold = { reason: clip(reason), at: now() };
    await this.#save();
    return { state: 'hold', reason: this.#state.hold.reason };
  }

  /** Adopts a task by its stable id; only a confirmed-absent task is started. */
  async #poll(id, cwd, role, buildPrompt) {
    let status;
    try {
      status = await this.#pi.status(id);
    } catch (error) {
      if (!/未找到任务/.test(msg(error))) throw new Error(`读取 Pi ${id} 状态失败：${msg(error)}`);
      status = null;
    }
    if (status) return status;
    if (!(await this.#authorized())) return 'denied';
    if (this.#closingNow()) return null;
    await this.#pi.start({ id, cwd, prompt: await buildPrompt(), role });
    return null;
  }
}

function checkEnvironment() {
  const env = { NO_COLOR: '1' };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG']) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  return env;
}

export async function advanceDevelopmentSop(input) {
  return await new DevelopmentSop(input ?? {}).advance(input?.plan);
}

/**
 * Persists the cancel marker first (advance stops dispatching), then cancels
 * every Pi task this module owns. `stopped` is true only when each task is
 * confirmed terminal.
 */
export async function cancelDevelopmentSop({ run, control, pi, persist } = {}) {
  if (!isObject(control) || !pi || typeof pi.cancel !== 'function' || typeof persist !== 'function') throw new Error('取消依赖缺失');
  const state = control.sop;
  if (!isObject(state)) return { state: 'cancelled', stopped: true };
  if (!state.cancelRequested) {
    state.cancelRequested = { at: now(), runId: run?.id ?? null };
    await persist(control);
  }
  if (state.result) return { state: 'completed', stopped: true };
  const ids = Object.values(state.lanes ?? {}).map((lane) => lane?.piId).filter(Boolean);
  if (state.review?.piId) ids.push(state.review.piId);
  let stopped = true;
  for (const id of ids) {
    try {
      if (!TERMINAL.includes((await pi.cancel(id))?.state)) stopped = false;
    } catch (error) {
      if (!/未找到任务/.test(msg(error))) stopped = false;
    }
  }
  await persist(control);
  return stopped ? { state: 'cancelled', stopped: true } : { state: 'unknown', stopped: false };
}

/**
 * After the parent PR was read back, hand each lane to WorkspaceAdapter, which
 * verifies manifest ownership and the parent-delivered blob before cleaning the
 * one delivered file and removing the tree. Anything unconfirmed is reported.
 */
export async function archiveDevelopmentSop({ control, workspace, repoEntry, run } = {}) {
  const state = control?.sop;
  const head = run?.result?.pr?.headSha;
  const parent = control?.prepare?.worktreePath;
  const base = control?.prepare?.baseCommit;
  if (!isObject(state) || !isObject(state.task) || !head || !parent || !base || !repoEntry?.localPath) return [];
  const records = [];
  for (const id of state.task.order ?? []) {
    const lane = state.lanes[id];
    const fail = (reason) => records.push({ step: id, removed: false, reason });
    if (!lane?.worktreePath) {
      fail('没有 lane 工作树记录');
      continue;
    }
    if (typeof workspace?.archiveLane !== 'function') {
      fail('工作树回收接口不可用');
      continue;
    }
    try {
      const archived = await workspace.archiveLane({
        repo: run.repo, localPath: repoEntry.localPath, worktreePath: lane.worktreePath,
        runId: `${run.id}-${lane.id}`, baseCommit: base,
        deliveredFile: lane.path, deliveredHash: lane.hash,
        parentPath: parent, parentHead: head,
      });
      if (archived?.removed) records.push({ step: id, removed: true });
      else records.push({ step: id, removed: false, reason: archived?.reason ?? '未回收' });
    } catch (error) {
      records.push({ step: id, removed: false, reason: msg(error) });
    }
  }
  return records;
}
