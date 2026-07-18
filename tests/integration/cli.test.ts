import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { CollectedDocument } from '@data-collector/shared';
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

async function pair(bridge: BridgeHandle): Promise<void> {
  const response = await fetch(`${bridge.url}/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: bridge.pairingCode }),
  });
  expect(response.status).toBe(200);
}

async function connect(bridge: BridgeHandle, token: string): Promise<WebSocket> {
  const socket = new WebSocket(`${bridge.wsUrl}?token=${encodeURIComponent(token)}`, {
    origin: `chrome-extension://${'b'.repeat(32)}`,
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
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
    await pair(bridge);
    const auth = JSON.parse(await (await import('node:fs/promises')).readFile(join(configDir, 'auth.json'), 'utf8')) as { token: string };
    const socket = await connect(bridge, auth.token);
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
});
