import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ISSUE_REF_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeTask(task) {
  if (!isObject(task)) {
    throw new Error('task must be an object');
  }

  if (typeof task.issue_ref !== 'string') {
    throw new Error('task.issue_ref must be a string');
  }
  const issueRef = task.issue_ref.trim();
  if (!ISSUE_REF_PATTERN.test(issueRef)) {
    throw new Error('task.issue_ref must use the form owner/repo#positive-integer');
  }

  if (typeof task.run_id !== 'string') {
    throw new Error('task.run_id must be a string');
  }
  const runId = task.run_id.trim();
  if (runId.length === 0) {
    throw new Error('task.run_id must not be empty');
  }

  if (!Number.isInteger(task.attempt) || task.attempt < 1) {
    throw new Error('task.attempt must be a positive integer');
  }

  if (!isObject(task.inputs)) {
    throw new Error('task.inputs must be an object');
  }

  if (typeof task.inputs.goal !== 'string') {
    throw new Error('task.inputs.goal must be a string');
  }
  const goal = task.inputs.goal.trim();
  if (goal.length === 0) {
    throw new Error('task.inputs.goal must not be empty');
  }

  const requestedAcceptance = task.inputs.acceptance;
  if (!Array.isArray(requestedAcceptance) || requestedAcceptance.length === 0) {
    throw new Error('task.inputs.acceptance must be a non-empty array');
  }
  const acceptance = [];
  for (let index = 0; index < requestedAcceptance.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(requestedAcceptance, index)) {
      throw new Error(`task.inputs.acceptance[${index}] must be a string`);
    }
    const item = requestedAcceptance[index];
    if (typeof item !== 'string') {
      throw new Error(`task.inputs.acceptance[${index}] must be a string`);
    }
    const normalized = item.trim();
    if (normalized.length === 0) {
      throw new Error(`task.inputs.acceptance[${index}] must not be empty`);
    }
    acceptance.push(normalized);
  }

  const scope = optionalInputString(task.inputs, 'scope');
  const context = optionalInputString(task.inputs, 'context');

  // Key order is part of the requirements revision contract.
  const inputs = { goal, acceptance, scope, context };

  return {
    issue_ref: issueRef,
    run_id: runId,
    attempt: task.attempt,
    inputs,
    requirements_rev: `sha256:${createHash('sha256')
      .update(JSON.stringify(inputs), 'utf8')
      .digest('hex')}`,
  };
}

function optionalInputString(inputs, key) {
  if (!Object.prototype.hasOwnProperty.call(inputs, key) || inputs[key] === undefined) {
    return '';
  }
  if (typeof inputs[key] !== 'string') {
    throw new Error(`task.inputs.${key} must be a string when provided`);
  }
  return inputs[key].trim();
}

function validateTemplatePath(templatePath) {
  if (typeof templatePath !== 'string' || templatePath.length === 0) {
    throw new Error('templatePath must be a non-empty string');
  }
  if (templatePath.includes('\\')) {
    throw new Error('templatePath must use forward slashes');
  }
  if (templatePath.startsWith('/') || /^[A-Za-z]:\//.test(templatePath)) {
    throw new Error('templatePath must be relative to the repository');
  }
  if (templatePath.includes('\0')) {
    throw new Error('templatePath must not contain NUL');
  }

  const segments = templatePath.split('/');
  if (segments.some((segment) => segment === '')) {
    throw new Error('templatePath must not contain empty path segments');
  }
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('templatePath must not contain . or .. path segments');
  }
  if (segments[0] !== 'templates') {
    throw new Error('templatePath must be under templates/');
  }
  if (!templatePath.endsWith('.md')) {
    throw new Error('templatePath must point to a .md file');
  }
}

async function runGit(repoDir, args) {
  return execFileAsync('git', ['-C', repoDir, ...args], {
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
  });
}

export async function prepareTask({ repoDir, ref = 'HEAD', templatePath, task } = {}) {
  if (typeof repoDir !== 'string' || repoDir.length === 0) {
    throw new Error('repoDir must be a non-empty string');
  }
  if (typeof ref !== 'string' || ref.trim().length === 0) {
    throw new Error('ref must be a non-empty string');
  }
  validateTemplatePath(templatePath);

  const normalized = normalizeTask(task);
  const gitRef = ref.trim();

  let commit;
  try {
    const { stdout } = await runGit(repoDir, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${gitRef}^{commit}`,
    ]);
    commit = stdout.trim();
  } catch (error) {
    throw new Error(`Invalid Git ref: ${gitRef}`, { cause: error });
  }

  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error(`Git did not resolve a full commit SHA for ref: ${gitRef}`);
  }

  const templateRef = `${commit}:${templatePath}`;
  let templateText;
  try {
    const { stdout } = await runGit(repoDir, ['cat-file', 'blob', templateRef]);
    templateText = stdout;
  } catch (error) {
    throw new Error(`Template not found at ${templateRef}`, { cause: error });
  }

  return {
    schema_version: 1,
    issue_ref: normalized.issue_ref,
    run_id: normalized.run_id,
    attempt: normalized.attempt,
    template_ref: templateRef,
    requirements_rev: normalized.requirements_rev,
    inputs: normalized.inputs,
    template_text: templateText,
  };
}
