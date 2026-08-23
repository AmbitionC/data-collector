#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { AccessTokenManager } from './auth.js';
import { autostartPlan, UnsupportedPlatformError } from './autostart.js';
import { buildStampCommit, updateWorkspace } from './autoUpdate.js';
import { runTool } from './git.js';
import { loadConfig, type ConfigOverrides } from './config.js';
import { discoverRepoRoot, startBridge } from './server/index.js';
import { COLLECTION_PLAN_IDS, type CollectionPlanId } from '@data-collector/shared';

export interface CliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

/** 安装登录项时要碰的外部世界；测试注入替身。 */
export interface AutostartHost {
  platform: NodeJS.Platform;
  home: string;
  appData?: string;
  nodePath: string;
  cliPath: string;
  writeFile(path: string, contents: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  run(command: string, args: string[]): Promise<void>;
  probe(url: string): Promise<boolean>;
}

const execFileAsync = promisify(execFile);

const PROCESS_HOST: AutostartHost = {
  platform: process.platform,
  home: homedir(),
  ...(process.env.APPDATA ? { appData: process.env.APPDATA } : {}),
  nodePath: process.execPath,
  cliPath: fileURLToPath(new URL('./cli.js', import.meta.url)),
  writeFile: (path, contents) => writeFile(path, contents, 'utf8'),
  mkdir: async path => { await mkdir(path, { recursive: true }); },
  remove: path => rm(path, { force: true }),
  run: async (command, args) => { await execFileAsync(command, args); },
  probe: async url => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      return response.ok;
    } catch {
      return false;
    }
  },
};

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

async function feJourney(args: string[], io: CliIo): Promise<number> {
  const action = args[1];
  if (action !== 'collect' && action !== 'status') {
    throw new Error('用法：data-collector fe-journey <collect|status> [--force]');
  }
  const { baseUrl, token } = await authenticatedToken(args);
  const response = await fetch(`${baseUrl}/v1/fe-journey/${action}`, {
    ...(action === 'collect'
      ? {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ force: args.includes('--force') }),
        }
      : { headers: { authorization: `Bearer ${token}` } }),
  });
  const body = await response.json() as unknown;
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null &&
      typeof (body as { error?: { message?: unknown } }).error?.message === 'string'
      ? (body as { error: { message: string } }).error.message
      : `HTTP ${response.status}`;
    throw new Error(`fe-journey ${action === 'collect' ? '采集' : '状态读取'}失败：${message}`);
  }
  io.stdout(`${JSON.stringify(body)}\n`);
  if (action === 'collect' && typeof body === 'object' && body !== null) {
    const sources = (body as { sources?: unknown }).sources;
    const failedSources = typeof sources === 'object' && sources !== null
      ? Object.entries(sources)
          .filter(([, report]) => (
            typeof report === 'object' && report !== null &&
            (report as { status?: unknown }).status === 'failed'
          ))
          .map(([source]) => source)
      : [];
    if (failedSources.length > 0) {
      io.stderr(`fe-journey 采集失败：${failedSources.join('、')}\n`);
      return 1;
    }
  }
  return 0;
}

async function plans(args: string[], io: CliIo): Promise<number> {
  const action = args[1];
  if (action !== 'status' && action !== 'run' && action !== 'batches') {
    throw new Error('用法：data-collector plans <status|run <plan-id>|batches> [--force] [--limit 20]');
  }
  const { baseUrl, token } = await authenticatedToken(args);
  let path = '/v1/plans/status';
  let init: RequestInit = { headers: { authorization: `Bearer ${token}` } };
  let waitMs: number | undefined;
  let planId: CollectionPlanId | undefined;
  if (action === 'run') {
    const rawPlanId = args[2];
    if (!COLLECTION_PLAN_IDS.includes(rawPlanId as CollectionPlanId)) {
      throw new Error(`固定计划必须是：${COLLECTION_PLAN_IDS.join('、')}`);
    }
    planId = rawPlanId as CollectionPlanId;
    const rawWait = option(args, '--wait');
    if (rawWait !== undefined) {
      waitMs = Number(rawWait);
      if (!Number.isInteger(waitMs) || waitMs < 100 || waitMs > 30 * 60 * 1000) {
        throw new Error('--wait 必须是 100 到 1800000 之间的毫秒数');
      }
    }
    path = '/v1/plans/run';
    init = {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ planId, force: args.includes('--force') }),
    };
  } else if (action === 'batches') {
    const limit = Number(option(args, '--limit') ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('--limit 必须是 1 到 100 之间的整数');
    }
    path = `/v1/plans/batches?limit=${limit}`;
  }
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json() as unknown;
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null &&
      typeof (body as { error?: { message?: unknown } }).error?.message === 'string'
      ? (body as { error: { message: string } }).error.message
      : `HTTP ${response.status}`;
    throw new Error(`固定计划${action === 'run' ? '运行' : '读取'}失败：${message}`);
  }
  let result = body;
  if (action === 'run' && waitMs !== undefined && planId &&
    typeof body === 'object' && body !== null && typeof (body as { id?: unknown }).id === 'string') {
    const batchId = (body as { id: string }).id;
    const deadline = Date.now() + waitMs;
    while ((result as { status?: unknown }).status === 'running' && Date.now() <= deadline) {
      await new Promise(resolveTimeout => setTimeout(resolveTimeout, 100));
      const statusResponse = await fetch(
        `${baseUrl}/v1/plans/batches?limit=100&planId=${encodeURIComponent(planId)}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!statusResponse.ok) throw new Error(`固定计划读取失败：HTTP ${statusResponse.status}`);
      const statusBody = await statusResponse.json() as { batches?: unknown };
      if (!Array.isArray(statusBody.batches)) throw new Error('固定计划返回了无效批次列表');
      const exact = statusBody.batches.find(item => (
        typeof item === 'object' && item !== null && (item as { id?: unknown }).id === batchId
      ));
      if (!exact) throw new Error(`固定计划批次消失：${batchId}`);
      result = exact;
    }
    if ((result as { status?: unknown }).status === 'running') {
      io.stdout(`${JSON.stringify(result)}\n`);
      io.stderr(`固定计划等待超时：${batchId}\n`);
      return 1;
    }
  }
  io.stdout(`${JSON.stringify(result)}\n`);
  if (action === 'run' && typeof result === 'object' && result !== null) {
    const status = (result as { status?: unknown }).status;
    if (status === 'failed') {
      io.stderr('固定计划运行失败\n');
      return 1;
    }
    if (status === 'completed_with_attention') {
      io.stderr('固定计划需要处理\n');
      return 1;
    }
  }
  return 0;
}

/** 等服务真的能应答再报成功——登录项加载和端口就绪之间有几百毫秒。 */
async function waitUntilHealthy(host: AutostartHost, url: string): Promise<boolean> {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    if (await host.probe(url)) return true;
    await new Promise(resolveTimeout => setTimeout(resolveTimeout, 400));
  }
  return false;
}

export async function installAutostart(
  args: string[],
  io: CliIo,
  host: AutostartHost = PROCESS_HOST,
): Promise<number> {
  const config = loadConfig(configOverrides(args));
  const healthUrl = `http://${config.host}:${config.port}/health`;
  let plan;
  try {
    plan = autostartPlan({
      platform: host.platform,
      home: host.home,
      nodePath: host.nodePath,
      cliPath: host.cliPath,
      logFile: join(config.configDir, 'bridge.log'),
      ...(host.appData ? { appData: host.appData } : {}),
    });
  } catch (error) {
    if (error instanceof UnsupportedPlatformError) {
      io.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }

  await host.mkdir(dirname(plan.file));
  await host.mkdir(config.configDir);
  await host.writeFile(plan.file, plan.contents);
  for (const step of plan.commands) {
    try {
      await host.run(step.command, step.args);
    } catch (error) {
      if (step.allowFailure) continue;
      // 常见于容器 / WSL / 无桌面会话：系统压根没有登录项机制可用。
      // 说清楚发生了什么、以及不装登录项该怎么用，别丢一句原始报错。
      io.stderr(`无法把本机服务装成登录项：${step.command} ${step.args.join(' ')} 执行失败。\n`);
      io.stderr(`原因：${error instanceof Error ? error.message.split('\n')[0] : error}\n`);
      io.stderr(`已写入的文件：${plan.file}（不生效，可以删掉）\n`);
      io.stderr('这台机器上请改用手动方式，在一个终端里保持运行：\n');
      io.stderr('  npm run collector -- bridge start\n');
      return 1;
    }
  }

  if (!(await waitUntilHealthy(host, healthUrl))) {
    io.stderr(`登录项已写入 ${plan.file}，但本机服务没有在预期时间内就绪。\n`);
    io.stderr(`请查看日志：${join(config.configDir, 'bridge.log')}\n`);
    return 1;
  }
  io.stdout(`本机服务已启动，并已设为开机自动运行（${plan.file}）。\n`);
  io.stdout('以后打开浏览器直接用插件即可，不需要再手动启动。\n');
  return 0;
}

export async function uninstallAutostart(
  args: string[],
  io: CliIo,
  host: AutostartHost = PROCESS_HOST,
): Promise<number> {
  const config = loadConfig(configOverrides(args));
  let plan;
  try {
    plan = autostartPlan({
      platform: host.platform,
      home: host.home,
      nodePath: host.nodePath,
      cliPath: host.cliPath,
      logFile: join(config.configDir, 'bridge.log'),
      ...(host.appData ? { appData: host.appData } : {}),
    });
  } catch (error) {
    if (error instanceof UnsupportedPlatformError) {
      io.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
  for (const step of plan.uninstallCommands) {
    try {
      await host.run(step.command, step.args);
    } catch {
      // 没装过也算卸载成功。
    }
  }
  await host.remove(plan.file);
  io.stdout('已取消开机自动运行。\n');
  return 0;
}

async function bridgeStatus(
  args: string[],
  io: CliIo,
  host: AutostartHost = PROCESS_HOST,
): Promise<number> {
  const config = loadConfig(configOverrides(args));
  const healthy = await host.probe(`http://${config.host}:${config.port}/health`);
  io.stdout(
    healthy
      ? `本机服务在运行：http://${config.host}:${config.port}\n`
      : `本机服务没有在 ${config.port} 端口响应。运行 npm run setup 安装并启动。\n`,
  );
  return healthy ? 0 : 1;
}

async function readBuildId(repoRoot: string): Promise<string | undefined> {
  try {
    const text = await readFile(
      join(repoRoot, 'artifacts', 'data-collector-extension', 'build-id.txt'),
      'utf8',
    );
    return text.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function bridgeUpdate(io: CliIo): Promise<number> {
  const repoRoot = discoverRepoRoot();
  if (!repoRoot) {
    io.stderr('找不到 data-collector 仓库目录，无法自更新。\n');
    return 1;
  }
  const outcome = await updateWorkspace(repoRoot, {
    // 和常驻服务走同一条路径解析：手动跑一次和它自己跑一次，结果必须一致。
    run: (command, commandArgs, cwd) => runTool(command, commandArgs, cwd),
    builtCommit: async root => {
      const buildId = await readBuildId(root);
      return buildId ? buildStampCommit(buildId) : undefined;
    },
    now: () => new Date().toISOString(),
  });
  io.stdout(`${outcome.message}\n`);
  return outcome.message.includes('失败') ? 1 : 0;
}

async function bridge(args: string[], io: CliIo): Promise<number> {
  if (args[1] === 'update') return bridgeUpdate(io);
  if (args[1] === 'install') return installAutostart(args, io);
  if (args[1] === 'uninstall') return uninstallAutostart(args, io);
  if (args[1] === 'status') return bridgeStatus(args, io);
  if (args[1] !== 'start') {
    throw new Error(
      '用法：data-collector bridge <start|install|uninstall|status|update> [--port 17321]',
    );
  }
  // 只有真正常驻的服务才开自更新：拉新代码 + 重新构建，用户只剩「重新加载插件」。
  // --no-update 可关掉。
  const handle = await startBridge({
    ...configOverrides(args),
    enableFeJourneyScheduler: true,
    ...(args.includes('--no-update') ? {} : { repoRoot: discoverRepoRoot() ?? null }),
  });
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
    if (command === 'fe-journey') return await feJourney(args, io);
    if (command === 'plans') return await plans(args, io);
    if (command === 'bridge') return await bridge(args, io);
    io.stderr(
      '用法：data-collector <bridge install|bridge start|bridge status|bridge uninstall|collect URL|plans status|plans run|plans batches|fe-journey collect|fe-journey status|health>\n',
    );
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
