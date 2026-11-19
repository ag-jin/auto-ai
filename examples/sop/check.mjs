import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';

const here = (name) => new URL(name, import.meta.url);
const readYaml = async (name) => YAML.parse(await readFile(here(name), 'utf8'));

const task = await readYaml('task-v1.yaml');
const sop = await readYaml('development-1.0.0.yaml');

assert.equal(sop.sop, task.sop, 'SOP 版本应与任务稿一致');

const taskRef = `${task.task}@${task.version}`;
for (const [step, lane] of Object.entries(sop.lanes)) {
  const handoff = await readYaml(lane.handoff);
  assert.deepEqual(Object.keys(handoff).sort(), ['artifact', 'sop', 'step', 'task', 'template']);
  assert.equal(handoff.sop, sop.sop);
  assert.equal(handoff.template, 'development-result@1.0.0');
  assert.equal(handoff.task, taskRef);
  assert.equal(handoff.step, step);
  assert.equal(handoff.artifact, lane.artifact);
}

const { subtotal } = await import(here('subtotal.mjs'));
const { fee } = await import(here('fee.mjs'));

const { unit_cents, quantity, subtotal_cents, total_cents } = task.acceptance;
const computed = subtotal(unit_cents, quantity);
assert.equal(computed, subtotal_cents, 'subtotal 与任务稿不符');
assert.equal(computed + fee(computed), total_cents, 'subtotal + fee 与任务稿总额不符');

console.log('check ok');
