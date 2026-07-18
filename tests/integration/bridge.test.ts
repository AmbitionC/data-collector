import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollectedDocument, WsEnvelope } from '@data-collector/shared';
import {
  startBridge,
  type BridgeHandle,
} from '../../packages/bridge/src/index.js';

const URL = 'https://mp.weixin.qq.com/s/integration-test';
const EXTENSION_ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const handles: BridgeHandle[] = [];
const sockets: WebSocket[] = [];

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'data-collector-bridge-'));
}

function document(overrides: Partial<CollectedDocument> = {}): CollectedDocument {
  return {
    schemaVersion: 1,
    source: 'wechat',
    kind: 'article',
    url: URL,
    canonicalUrl: URL,
    title: 'Bridge 集成测试文章',
    author: '测试公众号',
    collectedAt: '2026-07-18T00:00:00.000Z',
    html: '<p>Bridge 收到浏览器回传后，会清洗、归纳并写入本地 Markdown 知识库。</p>',
    text: 'Bridge 收到浏览器回传后，会清洗、归纳并写入本地 Markdown 知识库。',
    images: [],
    ...overrides,
  };
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  return { status: response.status, body: (await response.json()) as T };
}

async function pair(bridge: BridgeHandle): Promise<string> {
  const response = await requestJson<{ token: string }>(bridge.url, '/v1/pair', {
    method: 'POST',
    body: { code: bridge.pairingCode },
  });
  expect(response.status).toBe(200);
  return response.body.token;
}

async function connect(bridge: BridgeHandle, token: string): Promise<WebSocket> {
  const socket = new WebSocket(`${bridge.wsUrl}?token=${encodeURIComponent(token)}`, {
    origin: EXTENSION_ORIGIN,
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

async function nextMessage<T>(socket: WebSocket): Promise<WsEnvelope<string, T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket message timeout')), 5_000);
    socket.once('message', data => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as WsEnvelope<string, T>);
    });
  });
}

function envelope<T>(type: string, requestId: string, payload: T): string {
  return JSON.stringify({
    protocolVersion: 1,
    type,
    requestId,
    timestamp: new Date().toISOString(),
    payload,
  });
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const handle of handles.splice(0)) await handle.close();
});

describe('local Bridge', () => {
  it('authenticates, dispatches, saves, and ignores a duplicate result', async () => {
    const root = await temporaryDirectory();
    const bridge = await startBridge({
      port: 0,
      libraryRoot: root,
      configDir: join(root, '.config'),
      fetch: async () => new Response(null, { status: 404 }),
    });
    handles.push(bridge);

    const health = await requestJson<{ extensionConnected: boolean }>(bridge.url, '/health');
    expect(health).toMatchObject({ status: 200, body: { extensionConnected: false } });
    const unauthorized = await requestJson(bridge.url, '/v1/jobs', {
      method: 'POST',
      body: { url: URL },
    });
    expect(unauthorized.status).toBe(401);

    const token = await pair(bridge);
    const socket = await connect(bridge, token);
    socket.send(envelope('extension.hello', 'extension', { version: '0.1.0' }));
    const dispatchedPromise = nextMessage<{ url: string }>(socket);
    const jobResponse = await requestJson<{ id: string; status: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token,
      body: { url: URL, requestedBy: 'codex' },
    });
    expect(jobResponse.status).toBe(202);
    const job = jobResponse.body;
    const dispatched = await dispatchedPromise;
    expect(dispatched).toMatchObject({ type: 'job.collect', requestId: job.id });

    socket.send(envelope('job.progress', job.id, { stage: 'collecting' }));
    socket.send(envelope('job.result', job.id, { document: document() }));

    let saved: { status: string; outputPath?: string } | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const response = await requestJson<typeof saved>(bridge.url, `/v1/jobs/${job.id}`, { token });
      saved = response.body;
      if (saved?.status === 'saved') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(saved?.status).toBe('saved');
    expect(saved?.outputPath).toMatch(/index\.md$/);
    expect(await readFile(saved!.outputPath!, 'utf8')).toContain('Bridge 集成测试文章');

    socket.send(envelope('job.result', job.id, { document: document() }));
    await new Promise(resolve => setTimeout(resolve, 50));
    const catalog = JSON.parse(await readFile(join(root, '_catalog', 'index.json'), 'utf8')) as unknown[];
    expect(catalog).toHaveLength(1);
  });

  it('recovers a queued job after restart and dispatches it on extension reconnect', async () => {
    const root = await temporaryDirectory();
    const options = { port: 0, libraryRoot: root, configDir: join(root, '.config') };
    const first = await startBridge(options);
    handles.push(first);
    const token = await pair(first);
    const job = await requestJson<{ id: string }>(first.url, '/v1/jobs', {
      method: 'POST',
      token,
      body: { url: URL, requestedBy: 'cli' },
    });
    await first.close();
    handles.splice(handles.indexOf(first), 1);

    const restarted = await startBridge(options);
    handles.push(restarted);
    const socket = await connect(restarted, token);
    const dispatchedPromise = nextMessage<{ url: string }>(socket);
    socket.send(envelope('extension.hello', 'extension', { version: '0.1.0' }));
    const dispatched = await dispatchedPromise;

    expect(dispatched).toMatchObject({ type: 'job.collect', requestId: job.body.id });
  });

  it('requeues an in-flight job when the extension socket reconnects', async () => {
    const root = await temporaryDirectory();
    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir: join(root, '.config') });
    handles.push(bridge);
    const token = await pair(bridge);
    const firstSocket = await connect(bridge, token);
    firstSocket.send(envelope('extension.hello', 'extension', { version: '0.1.0' }));
    const firstDispatch = nextMessage<{ url: string }>(firstSocket);
    const job = await requestJson<{ id: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token,
      body: { url: URL, requestedBy: 'codex' },
    });
    await firstDispatch;
    firstSocket.close();
    await new Promise<void>(resolve => firstSocket.once('close', () => resolve()));

    const secondSocket = await connect(bridge, token);
    const redispatch = nextMessage<{ url: string }>(secondSocket);
    secondSocket.send(envelope('extension.hello', 'extension', { version: '0.1.0' }));

    expect(await redispatch).toMatchObject({ type: 'job.collect', requestId: job.body.id });
  });

  it('closes a peer that returns content for a different URL', async () => {
    const root = await temporaryDirectory();
    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir: join(root, '.config') });
    handles.push(bridge);
    const token = await pair(bridge);
    const socket = await connect(bridge, token);
    socket.send(envelope('extension.hello', 'extension', { version: '0.1.0' }));
    const dispatchedPromise = nextMessage<{ url: string }>(socket);
    const job = await requestJson<{ id: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token,
      body: { url: URL, requestedBy: 'codex' },
    });
    await dispatchedPromise;
    const closed = new Promise<number>(resolve => {
      socket.once('close', code => resolve(code));
    });

    socket.send(
      envelope('job.result', job.body.id, {
        document: document({
          url: 'https://mp.weixin.qq.com/s/other',
          canonicalUrl: 'https://mp.weixin.qq.com/s/other',
        }),
      }),
    );

    await expect(closed).resolves.toBe(1008);
    const status = await requestJson<{ status: string }>(bridge.url, `/v1/jobs/${job.body.id}`, {
      token,
    });
    expect(status.body.status).not.toBe('saved');
  });

  it('reveals only an existing path inside the configured library', async () => {
    const root = await temporaryDirectory();
    const target = join(root, 'saved.md');
    await writeFile(target, 'saved');
    const reveal = vi.fn(async () => undefined);
    const bridge = await startBridge({
      port: 0,
      libraryRoot: root,
      configDir: join(root, '.config'),
      reveal,
    });
    handles.push(bridge);
    const token = await pair(bridge);

    const accepted = await requestJson(bridge.url, '/v1/reveal', {
      method: 'POST',
      token,
      body: { path: target },
    });
    const rejected = await requestJson(bridge.url, '/v1/reveal', {
      method: 'POST',
      token,
      body: { path: join(root, '..', 'outside.md') },
    });

    expect(accepted.status).toBe(200);
    expect(rejected.status).toBe(400);
    expect(reveal).toHaveBeenCalledOnce();
    expect(reveal).toHaveBeenCalledWith(target);
  });
});
