#!/usr/bin/env node

// Local maintenance command: bind an already-delivered, still-pending Run/PR to
// a newer head that was verified outside the Runtime. It never runs the
// scheduler, never spawns a model, never pushes, never creates a PR and never
// merges. Registration only changes `result.pr.headSha` inside one Store
// transaction; the new head must be accepted again before canMerge passes.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { GitHubAdapter } from '../src/github-adapter.mjs';
import { issueId, normalizeIssue, sourceRevision } from '../src/rules.mjs';
import { ControllerLock } from '../src/runtime-state.mjs';
import { Workflow } from '../src/workflow.mjs';
import { WorkspaceAdapter } from '../src/workspace-adapter.mjs';

const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const REQUIRED_OPTIONS = ['dataDir', 'runId', 'from', 'to', 'evidence'];
const OPTION_NAMES = {
  'data-dir': 'dataDir',
  'run-id': 'runId',
  from: 'from',
  to: 'to',
  evidence: 'evidence',
};
const USAGE = [
  'Usage: node scripts/register-pr-head.mjs --data-dir <dir> --run-id <id>',
  '         --from <old完整SHA> --to <new完整SHA> --evidence <JSON文件> --confirm',
  '',
  '证据文件格式：{"headSha":"<新完整SHA>","summary":"<独立验收结果及原始证据引用>"}',
  '命令只读核对 PR/Issue 与本地 Git 后，把同一 Run 的同一 PR 绑定到新 head；',
  '不触发模型、不推送、不创建 PR、不合并，也不自动判定验收。',
].join('\n');

function fail(message) {
  const error = new Error(message);
  error.userFacing = true;
  throw error;
}

function parseArguments(argv) {
  const options = { confirm: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (!argument.startsWith('--') || argument === '--') {
      fail(`无法识别的参数：${argument}`);
    }
    const optionText = argument.slice(2);
    const separator = optionText.indexOf('=');
    const name = separator === -1 ? optionText : optionText.slice(0, separator);
    if (name === 'confirm') {
      if (separator !== -1) fail('--confirm 不接受值');
      options.confirm = true;
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(OPTION_NAMES, name)) {
      fail(`未知选项：--${name}`);
    }
    let value = separator === -1 ? undefined : optionText.slice(separator + 1);
    if (value === undefined) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        fail(`选项 --${name} 缺少值`);
      }
      value = next;
      index += 1;
    }
    if (value === '') fail(`选项 --${name} 的值不能为空`);
    options[OPTION_NAMES[name]] = value;
  }
  return options;
}

function requireCommit(value, name) {
  if (typeof value !== 'string' || !COMMIT_PATTERN.test(value)) {
    fail(`${name} 必须是完整的 40 或 64 位十六进制提交 SHA`);
  }
  return value;
}

function parseIssueRef(issueRef) {
  const match =
    typeof issueRef === 'string'
      ? /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*)$/.exec(issueRef)
      : null;
  if (!match) {
    fail(`Run 的 issueRef 不是合法的候选 ID：${issueRef}`);
  }
  return { repo: match[1], number: Number.parseInt(match[2], 10) };
}

function readEvidence(file, expectedHeadSha) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    fail(`读取证据文件失败：${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(`证据文件不是合法 JSON：${error.message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail('证据文件必须是 JSON 对象');
  }
  if (typeof parsed.headSha !== 'string' || parsed.headSha.trim() !== expectedHeadSha) {
    fail(`证据文件 headSha 必须是 --to 的完整 SHA（${expectedHeadSha}）`);
  }
  if (typeof parsed.summary !== 'string' || parsed.summary.trim().length === 0) {
    fail('证据文件 summary 必须是非空字符串');
  }
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    summary: parsed.summary.trim(),
  };
}

function mergeIntentFile(dataDir, candidateId) {
  const key = createHash('sha256').update(candidateId, 'utf8').digest('hex').slice(0, 16);
  return path.join(dataDir, 'merge-intents', `${key}.json`);
}

async function run(options) {
  const dataDir = path.resolve(options.dataDir);
  const dbPath = path.join(dataDir, 'workflow.db');
  if (!existsSync(dataDir)) {
    fail(`数据目录不存在：${dataDir}（不会自动创建）`);
  }
  if (!existsSync(dbPath)) {
    fail(`数据目录没有 workflow.db：${dataDir}（拒绝新建空数据库）`);
  }

  const fromHeadSha = requireCommit(options.from, '--from');
  const toHeadSha = requireCommit(options.to, '--to');
  if (fromHeadSha.toLowerCase() === toHeadSha.toLowerCase()) {
    fail('--from 与 --to 必须是两个不同的完整提交 SHA');
  }
  const evidencePath = path.resolve(options.evidence);
  const evidence = readEvidence(evidencePath, toHeadSha);

  let lock = null;
  let workflow = null;
  try {
    lock = ControllerLock.acquire(path.join(dataDir, 'controller.lock'));
    workflow = new Workflow({ dbPath });

    const run0 = workflow.getRun(options.runId);
    const candidate = workflow.getCandidate(run0.candidateId);
    const intentFile = mergeIntentFile(dataDir, candidate.id);
    if (existsSync(intentFile)) {
      fail(`候选 ${candidate.id} 存在合并意图文件 ${intentFile}，拒绝登记新 head`);
    }

    const pr = run0.result?.pr ?? null;
    if (!pr) {
      fail(`Run ${run0.id} 的结果没有 PR，不能登记新 head`);
    }
    if (
      typeof pr.repo !== 'string' ||
      !Number.isSafeInteger(pr.number) ||
      pr.number < 1 ||
      typeof pr.url !== 'string' ||
      typeof pr.headSha !== 'string'
    ) {
      fail(`Run ${run0.id} 的结果 PR 记录不完整，不能登记新 head`);
    }
    if (pr.headSha.toLowerCase() !== fromHeadSha.toLowerCase()) {
      fail(
        `Run ${run0.id} 已登记的 PR head 为 ${pr.headSha}，与 --from ${fromHeadSha} 不一致`,
      );
    }

    const settings = workflow.getSettings();
    const repoEntry = settings.repositories.find(
      (entry) => entry.repo.toLowerCase() === run0.repo.toLowerCase(),
    );
    if (!repoEntry) {
      fail(`持久设置中没有仓库 ${run0.repo}，拒绝猜测仓库路径`);
    }
    if (typeof repoEntry.localPath !== 'string' || repoEntry.localPath.trim().length === 0) {
      fail(`持久设置中仓库 ${run0.repo} 没有本地路径，拒绝猜测仓库路径`);
    }

    const github = new GitHubAdapter();
    const live = await github.readPullRequest({ repo: pr.repo, number: pr.number });
    if (
      live.repo.toLowerCase() !== pr.repo.toLowerCase() ||
      live.number !== pr.number ||
      live.url !== pr.url
    ) {
      fail(`实时 PR 与已登记结果不是同一 PR（#${pr.number} ${pr.url}），拒绝登记`);
    }
    if (live.state !== 'open') {
      fail(`PR #${pr.number} 当前状态为 ${live.state}，只有开放 PR 可以登记新 head`);
    }
    if (live.headSha.toLowerCase() !== toHeadSha.toLowerCase()) {
      fail(`PR #${pr.number} 实时 head 为 ${live.headSha}，与 --to ${toHeadSha} 不一致`);
    }

    const issueRef = parseIssueRef(run0.issueRef);
    if (issueRef.repo.toLowerCase() !== run0.repo.toLowerCase()) {
      fail(`Run 的 issueRef ${run0.issueRef} 与仓库 ${run0.repo} 不一致`);
    }
    const issue = await github.readIssue({ repo: issueRef.repo, number: issueRef.number });
    const normalizedIssue = normalizeIssue(issue);
    if (issueId(normalizedIssue) !== candidate.id) {
      fail(`读回的 Issue 不是候选 ${candidate.id}，拒绝登记`);
    }
    const liveSourceRev = sourceRevision(normalizedIssue);
    if (liveSourceRev !== run0.sourceRev) {
      fail(
        `Issue 源版本已变化（登记时 ${liveSourceRev}，Run ${run0.sourceRev}），原授权失效，拒绝登记`,
      );
    }

    const workspace = new WorkspaceAdapter({ rootDir: path.join(dataDir, 'workspace') });
    const range = await workspace.verifyCommittedRange({
      repo: run0.repo,
      localPath: repoEntry.localPath,
      baseCommit: fromHeadSha,
      headSha: toHeadSha,
      writeScopes: run0.draftSnapshot?.writeScopes ?? ['*'],
    });

    const registered = workflow.registerDeliveryHead(run0.id, {
      fromHeadSha,
      toHeadSha,
      pr: { repo: live.repo, number: live.number, url: live.url },
      evidence,
    });

    return {
      registered: true,
      ...registered,
      commits: range.commits,
      paths: range.paths,
    };
  } finally {
    if (workflow) {
      workflow.close();
    }
    if (lock) {
      lock.release();
    }
  }
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(USAGE);
    return;
  }
  for (const name of REQUIRED_OPTIONS) {
    if (options[name] === undefined) {
      fail(`缺少必要参数 --${name === 'dataDir' ? 'data-dir' : name === 'runId' ? 'run-id' : name}`);
    }
  }
  if (!options.confirm) {
    fail('缺少 --confirm；该命令默认不会写入任何内容');
  }
  const result = await run(options);
  console.log(JSON.stringify(result, null, 2));
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`登记失败：${error && error.message ? error.message : error}`);
  process.exitCode = 1;
});
