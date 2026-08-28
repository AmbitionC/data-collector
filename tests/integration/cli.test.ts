import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_VERSION,
  TRUSTED_EXTENSION_ID,
  ZSXQ_COMPLETE_CONTENT_CAPABILITY,
  type CollectedDocument,
} from '@data-collector/shared';
import { bridgeStartOptions, runCli } from '../../packages/bridge/src/cli.js';
import { startBridge, type BridgeHandle } from '../../packages/bridge/src/index.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const ARTICLE_URL = 'https://mp.weixin.qq.com/s/cli-test';
const handles: BridgeHandle[] = [];
const sockets: WebSocket[] = [];
const temporaryDirectories = createTemporaryDirectoryTracker();

function envelope(type: string, requestId: string, payload: unknown): string {
  return JSON.stringify({ protocolVersion: 1, type, requestId, timestamp: new Date().toISOString(), payload });
}

function dailyLedgerFacts(payload: {
  zsxqMode?: string;
  targetDays?: string[];
}): Record<string, unknown> {
  const mode = payload.zsxqMode === 'owner-history' ? 'owner-history' : 'daily-ledger';
  const targetDays = payload.targetDays ?? [];
  return {
    checkpoint: { mode, pagesFetched: 1, exhausted: true },
    dayDrafts: targetDays.map(day => ({
      day, rawOwnerCount: 0, qualifyingCount: 0, filteredCount: 0,
      exactDuplicateCount: 0, semanticDuplicateCount: 0, knownCompleteCount: 0,
      repairCount: 0, candidateCount: 0, savedCount: 0, failedCount: 0,
      crossedDayBoundary: true,
    })),
    ownerAudit: {
      mode, pagesFetched: 1, observed: 0, qualifying: 0, exactDuplicates: 0,
      semanticDuplicates: 0, filtered: 0, knownComplete: 0, repaired: 0,
      saved: 0, failed: 0, exhausted: true, safetyCapReached: false,
      completedDays: 0, emptyDays: targetDays.length, failedDays: 0,
    },
  };
}

async function nextSocketMessage<T>(socket: WebSocket): Promise<{
  requestId: string;
  payload: T;
}> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket message timeout')), 5_000);
    socket.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once('message', data => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as { requestId: string; payload: T });
    });
  });
}

function document(): CollectedDocument {
  return {
    schemaVersion: 1,
    source: 'wechat',
    kind: 'article',
    url: ARTICLE_URL,
    canonicalUrl: ARTICLE_URL,
    title: 'CLI 自动采集文章',
    collectedAt: '2026-07-18T00:00:00.000Z',
    html: '<p>CLI 通过本机 Bridge 请求浏览器采集并等待落盘。</p>',
    text: 'CLI 通过本机 Bridge 请求浏览器采集并等待落盘。',
    images: [],
  };
}

async function authorize(bridge: BridgeHandle): Promise<{ socket: WebSocket; token: string }> {
  const socket = new WebSocket(`${bridge.wsUrl}?bootstrap=1`, {
    origin: `chrome-extension://${TRUSTED_EXTENSION_ID}`,
  });
  sockets.push(socket);
  const message = await new Promise<{ type: string; payload: { token: string } }>((resolve, reject) => {
    socket.once('message', data => resolve(JSON.parse(data.toString()) as { type: string; payload: { token: string } }));
    socket.once('error', reject);
  });
  expect(message.type).toBe('bridge.authorized');
  return { socket, token: message.payload.token };
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const handle of handles.splice(0)) await handle.close();
  await temporaryDirectories.cleanup();
});

describe('Codex CLI', () => {
  it('keeps artifact authority enabled when --no-update disables only the updater', () => {
    expect(bridgeStartOptions([
      'bridge', 'start', '--no-update', '--port', '0', '--library', '/tmp/library',
    ], '/repo/data-collector')).toMatchObject({
      port: 0,
      libraryRoot: '/tmp/library',
      repoRoot: '/repo/data-collector',
      enableAutoUpdate: false,
      enableFeJourneyScheduler: true,
    });
  });

  it('rebuilds the local fe-journey candidate index without a running Bridge', async () => {
    const root = await temporaryDirectories.create('data-collector-cli-rebuild-index-');
    let stdout = '';
    let stderr = '';
    const io = {
      stdout: (value: string) => { stdout += value; },
      stderr: (value: string) => { stderr += value; },
    };

    expect(await runCli(['fe-journey', 'rebuild-index', '--library', root], io)).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ scanned: 0, rebuilt: 0 });
    expect(stderr).toBe('');
  });

  it('reads, runs, and lists fixed collection plans for Codex', async () => {
    const root = await temporaryDirectories.create('data-collector-cli-plans-');
    const configDir = join(root, '.config');
    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir });
    handles.push(bridge);
    await authorize(bridge);
    const port = new URL(bridge.url).port;
    const base = ['--port', port, '--library', root, '--config', configDir];
    let stdout = '';
    let stderr = '';
    const io = {
      stdout: (value: string) => { stdout += value; },
      stderr: (value: string) => { stderr += value; },
    };

    expect(await runCli(['plans', 'status', ...base], io)).toBe(0);
    expect(JSON.parse(stdout).plans).toHaveLength(2);
    stdout = '';
    expect(await runCli(['plans', 'run', 'zsxq-chen-teacher', '--force', ...base], io)).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ planId: 'zsxq-chen-teacher', status: 'running' });
    stdout = '';
    expect(await runCli([
      'plans', 'run', 'zsxq-chen-teacher', '--owner-history', '--force', ...base,
    ], io)).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      planId: 'zsxq-chen-teacher',
      zsxqMode: 'owner-history',
    });
    stdout = '';
    expect(await runCli(['plans', 'batches', '--limit', '1', ...base], io)).toBe(0);
    expect(JSON.parse(stdout).batches).toEqual([
      expect.objectContaining({ planId: 'zsxq-chen-teacher' }),
    ]);
    expect(stderr).toBe('');

    expect(await runCli(['plans', 'run', 'unknown-plan', ...base], io)).toBe(1);
    expect(stderr).toContain('固定计划');
  });

  it('waits for the exact plan batch and prints its terminal delivery manifest', async () => {
    const root = await temporaryDirectories.create('data-collector-cli-plan-wait-');
    const configDir = join(root, '.config');
    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir });
    handles.push(bridge);
    const { socket } = await authorize(bridge);
    socket.send(envelope('extension.hello', 'extension-plan-wait', {
      version: APP_VERSION,
      capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
    }));
    const port = new URL(bridge.url).port;
    let stdout = '';
    let stderr = '';
    const command = new Promise<{
      requestId: string;
      payload: { batchId: string; attempt: string };
    }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('plan timeout')), 5_000);
      socket.once('message', data => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()) as {
          requestId: string;
          payload: { batchId: string; attempt: string };
        });
      });
    });

    const running = runCli([
      'plans', 'run', 'zsxq-chen-teacher', '--force', '--wait', '5000',
      '--port', port, '--library', root, '--config', configDir,
    ], {
      stdout: value => { stdout += value; },
      stderr: value => { stderr += value; },
    });
    const collect = await command;
    socket.send(envelope('plan.result', collect.requestId, {
      batchId: collect.payload.batchId,
      attempt: collect.payload.attempt,
      discovered: 0,
      prepared: true,
      rejections: {},
      rejectionDetails: [],
      ...dailyLedgerFacts(collect.payload),
    }));

    expect(await running).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({
      id: collect.payload.batchId,
      status: 'completed',
      deliveryIds: [],
    });
  });

  it('preserves the terminal plan JSON and fails on attention', async () => {
    const root = await temporaryDirectories.create('data-collector-cli-plan-attention-');
    const configDir = join(root, '.config');
    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir });
    handles.push(bridge);
    const { socket } = await authorize(bridge);
    socket.send(envelope('extension.hello', 'extension-plan-attention', {
      version: APP_VERSION,
      capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
    }));
    const port = new URL(bridge.url).port;
    let stdout = '';
    let stderr = '';
    const command = nextSocketMessage<{ batchId: string; attempt: string }>(socket);
    const running = runCli([
      'plans', 'run', 'zsxq-chen-teacher', '--force', '--wait', '5000',
      '--port', port, '--library', root, '--config', configDir,
    ], {
      stdout: value => { stdout += value; },
      stderr: value => { stderr += value; },
    });
    const collect = await command;
    socket.send(envelope('plan.result', collect.requestId, {
      batchId: collect.payload.batchId,
      attempt: collect.payload.attempt,
      discovered: 0,
      error: '请先登录知识星球',
      needsAttention: true,
    }));

    expect(await running).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({
      id: collect.payload.batchId,
      status: 'completed_with_attention',
      error: '请先登录知识星球',
    });
    expect(stderr).toContain('固定计划需要处理');
  });

  it('runs and reports the fixed fe-journey collection without accepting search configuration', async () => {
    const root = await temporaryDirectories.create('data-collector-cli-fe-journey-');
    const repo = await temporaryDirectories.create('data-collector-cli-fe-repo-');
    const configDir = join(root, '.config');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'sinks.json'), JSON.stringify({
      sinks: {
        markdown: { type: 'markdown' },
        'fe-journey': { type: 'repo-inbox', repoPath: repo, commit: false, push: false },
      },
      routes: { nowcoder: ['fe-journey'], github: ['fe-journey'] },
    }));
    const bridge = await startBridge({
      port: 0,
      libraryRoot: root,
      configDir,
      fetch: async input => {
        const url = new URL(String(input));
        return url.hostname === 'www.nowcoder.com'
          ? new Response('<html></html>')
          : Response.json({ items: [] });
      },
    });
    handles.push(bridge);
    await authorize(bridge);
    const port = new URL(bridge.url).port;
    let stdout = '';
    let stderr = '';
    const io = {
      stdout: (value: string) => { stdout += value; },
      stderr: (value: string) => { stderr += value; },
    };

    expect(await runCli([
      'fe-journey', 'collect', '--force', '--port', port, '--library', root, '--config', configDir,
    ], io)).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({
      enabled: true,
      forced: true,
      sources: { nowcoder: { status: 'completed' }, github: { status: 'completed' } },
    });

    stdout = '';
    expect(await runCli([
      'fe-journey', 'status', '--port', port, '--library', root, '--config', configDir,
    ], io)).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ enabled: true, running: false });
  });

  it('returns a failing exit code when a forced fe-journey run reports source failures', async () => {
    const root = await temporaryDirectories.create('data-collector-cli-fe-failed-');
    const repo = await temporaryDirectories.create('data-collector-cli-fe-failed-repo-');
    const configDir = join(root, '.config');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'sinks.json'), JSON.stringify({
      sinks: {
        markdown: { type: 'markdown' },
        'fe-journey': { type: 'repo-inbox', repoPath: repo, commit: false, push: false },
      },
      routes: { nowcoder: ['fe-journey'], github: ['fe-journey'] },
    }));
    const bridge = await startBridge({
      port: 0,
      libraryRoot: root,
      configDir,
      fetch: async input => {
        const url = new URL(String(input));
        return url.hostname === 'www.nowcoder.com'
          ? new Response('temporary outage', { status: 503 })
          : new Response('rate limited', { status: 429 });
      },
    });
    handles.push(bridge);
    await authorize(bridge);
    const port = new URL(bridge.url).port;
    let stdout = '';
    let stderr = '';

    const code = await runCli([
      'fe-journey', 'collect', '--force', '--port', port, '--library', root, '--config', configDir,
    ], {
      stdout: value => { stdout += value; },
      stderr: value => { stderr += value; },
    });

    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({
      sources: {
        nowcoder: { status: 'failed' },
        github: { status: 'failed' },
      },
    });
    expect(stderr).toContain('fe-journey 采集失败');
  });

  it('submits a URL, waits for the extension, and prints only the saved path', async () => {
    const root = await temporaryDirectories.create('data-collector-cli-');
    const configDir = join(root, '.config');
    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir });
    handles.push(bridge);
    const authorized = await authorize(bridge);
    const socket = authorized.socket;
    socket.send(envelope('extension.hello', 'extension', { version: '0.1.0' }));

    const received = new Promise<{ requestId: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('job timeout')), 5_000);
      socket.once('message', data => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()) as { requestId: string });
      });
    });
    let stdout = '';
    let stderr = '';
    const port = new URL(bridge.url).port;
    const running = runCli(
      ['collect', ARTICLE_URL, '--wait', '5000', '--port', port, '--library', root, '--config', configDir],
      { stdout: value => { stdout += value; }, stderr: value => { stderr += value; } },
    );
    const job = await received;
    socket.send(envelope('job.progress', job.requestId, { stage: 'collecting' }));
    socket.send(envelope('job.result', job.requestId, { document: document() }));

    expect(await running).toBe(0);
    expect(stderr).toBe('');
    expect(stdout.trim()).toMatch(/^\/.+index\.md$/);
  });

  it('explains how to auto-authorize collect when no token exists', async () => {
    const root = await temporaryDirectories.create('data-collector-cli-no-token-');
    let stderr = '';

    const result = await runCli(
      ['collect', ARTICLE_URL, '--config', join(root, '.config')],
      { stdout: () => undefined, stderr: value => { stderr += value; } },
    );

    expect(result).toBe(1);
    expect(stderr.trim()).toBe('扩展尚未自动连接，请先启动 Bridge 并在 Edge 中打开 Data Collector 侧边栏');
  });

  it('prints the Bridge URL and waits for the trusted extension on start', async () => {
    const root = await temporaryDirectories.create('data-collector-cli-start-');
    const configDir = join(root, '.config');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'sinks.json'), JSON.stringify({
      sinks: { markdown: { type: 'markdown' } },
      routes: {},
    }));
    const processOnce = vi.spyOn(process, 'once').mockImplementation(((event: string, listener: (...args: never[]) => void) => {
      if (event === 'SIGINT') queueMicrotask(listener);
      return process;
    }) as typeof process.once);
    let stderr = '';

    try {
      // 这里只验证启动提示和信号收尾；真实 updater 另有专门测试。若让它参与，
      // close() 的可靠排空时间会受 git/npm 与并行测试负载影响，和本断言无关。
      const result = await runCli(
        [
          'bridge',
          'start',
          '--no-update',
          '--port',
          '0',
          '--library',
          root,
          '--config',
          configDir,
        ],
        { stdout: () => undefined, stderr: value => { stderr += value; } },
      );
      expect(result).toBe(0);
    } finally {
      processOnce.mockRestore();
    }

    expect(stderr).toMatch(/Data Collector Bridge: http:\/\/127\.0\.0\.1:\d+/);
    expect(stderr).toContain('等待受信任的 Data Collector 扩展自动连接');
    expect(stderr).not.toContain(['配', '对码'].join(''));
  }, 30_000);
});
