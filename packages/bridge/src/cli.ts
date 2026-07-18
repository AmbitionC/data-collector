#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { AccessTokenManager } from './auth.js';
import { loadConfig, type ConfigOverrides } from './config.js';
import { startBridge } from './server/index.js';

export interface CliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

const PROCESS_IO: CliIo = {
  stdout: value => process.stdout.write(value),
  stderr: value => process.stderr.write(value),
};

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function configOverrides(args: string[]): ConfigOverrides {
  const portValue = option(args, '--port');
  const libraryRoot = option(args, '--library');
  const configDir = option(args, '--config');
  return {
    ...(portValue ? { port: Number(portValue) } : {}),
    ...(libraryRoot ? { libraryRoot } : {}),
    ...(configDir ? { configDir } : {}),
  };
}

async function authenticatedToken(args: string[]): Promise<{ baseUrl: string; token: string }> {
  const config = loadConfig(configOverrides(args));
  const access = await AccessTokenManager.open(config.authFile);
  const token = access.token();
  if (!token) throw new Error('扩展尚未自动连接，请先启动 Bridge 并在 Edge 中打开 Data Collector 侧边栏');
  return { baseUrl: `http://${config.host}:${config.port}`, token };
}

async function collect(args: string[], io: CliIo): Promise<number> {
  const url = args[1];
  if (!url || url.startsWith('--')) throw new Error('用法：data-collector collect <URL> [--wait 60000]');
  const waitMs = Number(option(args, '--wait') ?? 60_000);
  if (!Number.isFinite(waitMs) || waitMs < 100 || waitMs > 30 * 60 * 1000) {
    throw new Error('--wait 必须是 100 到 1800000 之间的毫秒数');
  }
  const { baseUrl, token } = await authenticatedToken(args);
  const response = await fetch(`${baseUrl}/v1/jobs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ url, requestedBy: 'cli' }),
  });
  if (!response.ok) throw new Error(`创建采集任务失败：HTTP ${response.status}`);
  const job = (await response.json()) as { id: string };
  const deadline = Date.now() + waitMs;
  while (Date.now() <= deadline) {
    const statusResponse = await fetch(`${baseUrl}/v1/jobs/${encodeURIComponent(job.id)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!statusResponse.ok) throw new Error(`读取采集任务失败：HTTP ${statusResponse.status}`);
    const status = (await statusResponse.json()) as {
      status: string;
      outputPath?: string;
      errorCode?: string;
      errorMessage?: string;
    };
    if (status.status === 'saved' && status.outputPath) {
      io.stdout(`${status.outputPath}\n`);
      return 0;
    }
    if (status.status === 'failed' || status.status === 'needs_attention') {
      throw new Error(`${status.errorCode ?? status.status}: ${status.errorMessage ?? '采集未完成'}`);
    }
    await new Promise(resolveTimeout => setTimeout(resolveTimeout, 100));
  }
  throw new Error('JOB_TIMEOUT: 浏览器未在等待时间内完成采集，请确认 Bridge 与扩展在线');
}

async function health(args: string[], io: CliIo): Promise<number> {
  const config = loadConfig(configOverrides(args));
  const response = await fetch(`http://${config.host}:${config.port}/health`);
  if (!response.ok) throw new Error(`Bridge 健康检查失败：HTTP ${response.status}`);
  io.stdout(`${JSON.stringify(await response.json())}\n`);
  return 0;
}

async function bridge(args: string[], io: CliIo): Promise<number> {
  if (args[1] !== 'start') throw new Error('用法：data-collector bridge start [--port 17321]');
  const handle = await startBridge(configOverrides(args));
  io.stderr(`Data Collector Bridge: ${handle.url}\n`);
  io.stderr('等待受信任的 Data Collector 扩展自动连接\n');
  await new Promise<void>(resolveSignal => {
    const stop = () => resolveSignal();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await handle.close();
  return 0;
}

export async function runCli(args: string[], io: CliIo = PROCESS_IO): Promise<number> {
  try {
    const command = args[0];
    if (command === 'collect') return await collect(args, io);
    if (command === 'health') return await health(args, io);
    if (command === 'bridge') return await bridge(args, io);
    io.stderr('用法：data-collector <bridge start|collect URL|health>\n');
    return 2;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : '未知错误'}\n`);
    return 1;
  }
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry && fileURLToPath(import.meta.url) === entry) {
  process.exitCode = await runCli(process.argv.slice(2));
}
