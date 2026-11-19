import { createHash } from 'node:crypto';

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ISSUE_STATES = new Set(['open', 'closed']);

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimString(value, name) {
  if (typeof value !== 'string') {
    throw new Error(`${name} 必须是字符串`);
  }
  return value.trim();
}

function normalizeStringList(value, name, { lowercase = false } = {}) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${name} 必须是字符串数组`);
  }
  const seen = new Set();
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new Error(`${name}[${index}] 必须是字符串`);
    }
    const item = trimString(value[index], `${name}[${index}]`);
    if (item.length === 0) {
      throw new Error(`${name}[${index}] 不能为空`);
    }
    const normalized = lowercase ? item.toLowerCase() : item;
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

/**
 * Normalizes the rule section of Settings. Missing rule lists become empty
 * (unrestricted), except states which defaults to ["open"] only when omitted.
 */
export function normalizeRules(rules) {
  if (rules === undefined || rules === null) {
    rules = {};
  }
  if (!isObject(rules)) {
    throw new Error('rules 必须是对象');
  }

  const repositories = normalizeStringList(rules.repositories, 'rules.repositories');
  for (const repository of repositories) {
    if (!REPO_PATTERN.test(repository)) {
      throw new Error(`rules.repositories 中的仓库格式无效：${repository}`);
    }
  }

  const labels = normalizeStringList(rules.labels, 'rules.labels');
  const authors = normalizeStringList(rules.authors, 'rules.authors');
  const keywords = normalizeStringList(rules.keywords, 'rules.keywords');

  let states;
  if (rules.states === undefined) {
    states = ['open'];
  } else {
    states = normalizeStringList(rules.states, 'rules.states', { lowercase: true });
    for (const state of states) {
      if (!ISSUE_STATES.has(state)) {
        throw new Error(`rules.states 只能包含 open 或 closed：${state}`);
      }
    }
  }

  return { repositories, labels, authors, keywords, states };
}

export function normalizeIssue(issue) {
  if (!isObject(issue)) {
    throw new Error('issue 必须是对象');
  }

  const repo = trimString(issue.repo, 'issue.repo');
  if (!REPO_PATTERN.test(repo)) {
    throw new Error('issue.repo 必须使用 owner/repo 格式');
  }

  if (!Number.isSafeInteger(issue.number) || issue.number < 1) {
    throw new Error('issue.number 必须是正整数');
  }

  const title = trimString(issue.title, 'issue.title');
  const body = issue.body === undefined ? '' : trimString(issue.body, 'issue.body');
  const state = trimString(issue.state, 'issue.state').toLowerCase();
  if (!ISSUE_STATES.has(state)) {
    throw new Error('issue.state 只能是 open 或 closed');
  }

  const author = trimString(issue.author, 'issue.author');
  if (author.length === 0) {
    throw new Error('issue.author 不能为空');
  }

  const labels = normalizeStringList(issue.labels, 'issue.labels');
  const updatedAt = issue.updatedAt === undefined ? '' : trimString(issue.updatedAt, 'issue.updatedAt');
  const url = issue.url === undefined ? '' : trimString(issue.url, 'issue.url');

  let isPullRequest = false;
  if (issue.isPullRequest !== undefined) {
    if (typeof issue.isPullRequest !== 'boolean') {
      throw new Error('issue.isPullRequest 必须是布尔值');
    }
    isPullRequest = issue.isPullRequest;
  }

  return {
    repo,
    number: issue.number,
    title,
    body,
    state,
    author,
    labels,
    updatedAt,
    url,
    isPullRequest,
  };
}

export function issueId(issue) {
  return `${issue.repo.toLowerCase()}#${issue.number}`;
}
export function sourceRevision(issue) {
  const content = { title: issue.title, body: issue.body };
  return `sha256:${createHash('sha256').update(JSON.stringify(content), 'utf8').digest('hex')}`;
}

/**
 * A rule category matches when at least one value matches (OR). Categories are
 * combined with AND. Pull requests are always excluded. Every evaluation
 * carries Chinese reasons for both matching and exclusion.
 */
export function evaluateIssue(issue, rules) {
  const normalizedIssue = normalizeIssue(issue);
  const normalizedRules = normalizeRules(rules);
  const reasons = [];

  if (normalizedIssue.isPullRequest) {
    return {
      matched: false,
      reasons: ['该条目是 Pull Request，收集规则只处理 Issue，已排除'],
    };
  }

  if (normalizedRules.repositories.length === 0) {
    return {
      matched: false,
      reasons: ['仓库规则为空，不匹配任何 Issue'],
    };
  }

  const repositoryHit = normalizedRules.repositories.some(
    (repository) => repository.toLowerCase() === normalizedIssue.repo.toLowerCase(),
  );
  reasons.push(
    repositoryHit
      ? `仓库 ${normalizedIssue.repo} 命中收集规则`
      : `仓库 ${normalizedIssue.repo} 不在收集规则内`,
  );

  let labelsHit = true;
  if (normalizedRules.labels.length > 0) {
    const issueLabels = new Set(normalizedIssue.labels.map((label) => label.toLowerCase()));
    const matchedLabels = normalizedRules.labels.filter((label) =>
      issueLabels.has(label.toLowerCase()),
    );
    labelsHit = matchedLabels.length > 0;
    reasons.push(
      labelsHit
        ? `标签 ${matchedLabels.join('、')} 命中收集规则`
        : `标签不在收集规则内（Issue 标签：${normalizedIssue.labels.join('、') || '无'}）`,
    );
  } else {
    reasons.push('未限制标签');
  }

  let authorHit = true;
  if (normalizedRules.authors.length > 0) {
    authorHit = normalizedRules.authors.some(
      (author) => author.toLowerCase() === normalizedIssue.author.toLowerCase(),
    );
    reasons.push(
      authorHit
        ? `作者 ${normalizedIssue.author} 命中收集规则`
        : `作者 ${normalizedIssue.author} 不在收集规则内`,
    );
  } else {
    reasons.push('未限制作者');
  }

  let keywordsHit = true;
  if (normalizedRules.keywords.length > 0) {
    const haystack = `${normalizedIssue.title}\n${normalizedIssue.body}`.toLowerCase();
    const matchedKeyword = normalizedRules.keywords.find((keyword) =>
      haystack.includes(keyword.toLowerCase()),
    );
    keywordsHit = matchedKeyword !== undefined;
    reasons.push(
      keywordsHit
        ? `关键词「${matchedKeyword}」命中标题或正文`
        : `标题和正文均未命中关键词：${normalizedRules.keywords.join('、')}`,
    );
  } else {
    reasons.push('未限制关键词');
  }

  let statesHit = true;
  if (normalizedRules.states.length > 0) {
    statesHit = normalizedRules.states.includes(normalizedIssue.state);
    reasons.push(
      statesHit
        ? `状态 ${normalizedIssue.state} 在收集状态内`
        : `状态 ${normalizedIssue.state} 不在收集状态内（允许：${normalizedRules.states.join('、')}）`,
    );
  } else {
    reasons.push('未限制状态');
  }

  return {
    matched: repositoryHit && labelsHit && authorHit && keywordsHit && statesHit,
    reasons,
  };
}
