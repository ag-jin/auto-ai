#!/usr/bin/env node

import { readFile, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { prepareTask } from '../src/prepare-task.mjs';

const VALUE_OPTIONS = new Set(['input', 'template', 'ref', 'repo', 'out']);
const USAGE =
  'Usage: node scripts/prepare-task.mjs --input <task.json> --template <templates/...md> ' +
  '[--ref <ref>] [--repo <dir>] [--out <packet.json>]';

function parseArguments(argv) {
  const options = {
    ref: 'HEAD',
    repo: process.cwd(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--') || argument === '--') {
      throw new Error(`Unknown argument: ${argument}`);
    }

    const optionText = argument.slice(2);
    const separator = optionText.indexOf('=');
    const name = separator === -1 ? optionText : optionText.slice(0, separator);
    let value = separator === -1 ? undefined : optionText.slice(separator + 1);

    if (!VALUE_OPTIONS.has(name)) {
      throw new Error(`Unknown option: --${name}`);
    }
    if (value === undefined) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`Missing value for --${name}`);
      }
      value = next;
      index += 1;
    }
    if (value.length === 0) {
      throw new Error(`Missing value for --${name}`);
    }

    options[name] = value;
  }

  if (options.input === undefined) {
    throw new Error('Missing required option: --input');
  }
  if (options.template === undefined) {
    throw new Error('Missing required option: --template');
  }

  return options;
}

async function main(argv) {
  const options = parseArguments(argv);

  const inputPath = path.resolve(options.input);
  const repoDir = path.resolve(options.repo);

  let task;
  try {
    task = JSON.parse(await readFile(inputPath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read JSON from --input ${inputPath}: ${error.message}`, {
      cause: error,
    });
  }

  const packet = await prepareTask({
    repoDir,
    ref: options.ref,
    templatePath: options.template,
    task,
  });
  const output = `${JSON.stringify(packet, null, 2)}\n`;

  if (options.out === undefined) {
    process.stdout.write(output);
    return;
  }

  const outputPath = path.resolve(options.out);
  await mkdir(path.dirname(outputPath), { recursive: true });

  let handle;
  try {
    handle = await open(outputPath, 'wx');
    await handle.writeFile(output, 'utf8');
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`Output file already exists: ${outputPath}`, { cause: error });
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`prepare-task: ${error.message}`);
  console.error(USAGE);
  process.exitCode = 1;
}
