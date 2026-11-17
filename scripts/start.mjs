#!/usr/bin/env node

import path from 'node:path';

import { createHttpServer } from '../src/http-server.mjs';

const DEFAULT_PORT = 4310;
const VALUE_OPTIONS = new Set(['host', 'port', 'data-dir', 'app-repo-dir']);
const USAGE =
  'Usage: npm start -- [--host 127.0.0.1] [--port 4310] ' +
  '[--data-dir <abs|relative>] [--app-repo-dir <dir>]';

function parseArguments(argv) {
  const options = {
    host: '127.0.0.1',
    port: DEFAULT_PORT,
    dataDir: null,
    appRepoDir: process.cwd(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (!argument.startsWith('--') || argument === '--') {
      throw new Error(`无法识别的参数：${argument}`);
    }
    const optionText = argument.slice(2);
    const separator = optionText.indexOf('=');
    const name = separator === -1 ? optionText : optionText.slice(0, separator);
    let value = separator === -1 ? undefined : optionText.slice(separator + 1);
    if (!VALUE_OPTIONS.has(name)) throw new Error(`未知选项：--${name}`);
    if (value === undefined) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`选项 --${name} 缺少值`);
      }
      value = next;
      index += 1;
    }
    if (value === '') throw new Error(`选项 --${name} 的值不能为空`);
    if (name === 'host') options.host = value;
    if (name === 'port') options.port = value;
    if (name === 'data-dir') options.dataDir = value;
    if (name === 'app-repo-dir') options.appRepoDir = value;
  }

  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port 必须是 0..65535 的整数，收到 ${options.port}`);
  }
  options.port = port;
  options.appRepoDir = path.resolve(options.appRepoDir);
  options.dataDir = options.dataDir
    ? path.resolve(options.dataDir)
    : path.join(options.appRepoDir, '.auto-ai', 'app');
  return options;
}

async function loadRuntime() {
  try {
    const module = await import('../src/runtime.mjs');
    if (typeof module.Runtime !== 'function') {
      throw new Error('src/runtime.mjs 没有导出 Runtime');
    }
    return module.Runtime;
  } catch (error) {
    if (error && error.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes('runtime.mjs')) {
      throw new Error(
        '未找到 src/runtime.mjs：真实 Runtime 尚未集成，不能启动工作台。' +
          '请先完成 T005A Runtime；不会用 mock 或假数据替代生产后端。',
      );
    }
    throw error;
  }
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const Runtime = await loadRuntime();
  const runtime = new Runtime({
    dataDir: options.dataDir,
    appRepoDir: options.appRepoDir,
  });

  const { url, close } = await createHttpServer({
    runtime,
    host: options.host,
    port: options.port,
  });

  console.log(`auto-ai 本地工作台已启动：${url}`);
  console.log(`数据目录：${options.dataDir}`);
  console.log(`应用仓库：${options.appRepoDir}`);
  console.log('仅绑定 loopback；浏览器打开上方地址，Worker 不获得工作台令牌。');

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`收到 ${signal}，正在停止工作台并释放 Runtime…`);
    try {
      await close();
      process.exitCode = 0;
    } catch (error) {
      console.error(`停止失败：${error && error.message ? error.message : error}`);
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', () => {
    stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    stop('SIGTERM');
  });
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`启动失败：${error && error.message ? error.message : error}`);
  process.exitCode = 1;
});
