import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRUSTED_EXTENSION_ID, type CollectedDocument } from '@data-collector/shared';
import { runCli } from '../../packages/bridge/src/cli.js';
import { startBridge, type BridgeHandle } from '../../packages/bridge/src/index.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const ARTICLE_URL = 'https://mp.weixin.qq.com/s/cli-test';
const handles: BridgeHandle[] = [];
const sockets: WebSocket[] = [];
const temporaryDirectories = createTemporaryDirectoryTracker();

function envelope(type: string, requestId: string, payload: unknown): string {
  return JSON.stringify({ protocolVersion: 1, type, requestId, timestamp: new Date().toISOString(), payload });
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
    const processOnce = vi.spyOn(process, 'once').mockImplementation(((event: string, listener: (...args: never[]) => void) => {
      if (event === 'SIGINT') queueMicrotask(listener);
      return process;
    }) as typeof process.once);
    let stderr = '';

    try {
      const result = await runCli(
        ['bridge', 'start', '--port', '0', '--library', root, '--config', join(root, '.config')],
        { stdout: () => undefined, stderr: value => { stderr += value; } },
      );
      expect(result).toBe(0);
    } finally {
      processOnce.mockRestore();
    }

    expect(stderr).toMatch(/Data Collector Bridge: http:\/\/127\.0\.0\.1:\d+/);
    expect(stderr).toContain('等待受信任的 Data Collector 扩展自动连接');
    expect(stderr).not.toContain(['配', '对码'].join(''));
  });
});
