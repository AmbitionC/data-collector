import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket, { type RawData } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_VERSION,
  EXTENSION_REPLACED_CLOSE_CODE,
  EXTENSION_REPLACED_CLOSE_REASON,
  TRUSTED_EXTENSION_ID,
  type CollectedDocument,
  type WsEnvelope,
} from '@data-collector/shared';
import {
  startBridge,
  type BridgeHandle,
} from '../../packages/bridge/src/index.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const URL = 'https://mp.weixin.qq.com/s/integration-test';
const EXTENSION_ORIGIN = `chrome-extension://${TRUSTED_EXTENSION_ID}`;
const handles: BridgeHandle[] = [];
const sockets: WebSocket[] = [];
const temporaryDirectories = createTemporaryDirectoryTracker();

async function temporaryDirectory(): Promise<string> {
  return temporaryDirectories.create('data-collector-bridge-');
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
    socket.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once('message', data => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as WsEnvelope<string, T>);
    });
  });
}

async function expectNoMessage(socket: WebSocket, milliseconds = 150): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onMessage = (data: RawData) => {
      clearTimeout(timer);
      reject(new Error(`Unexpected WebSocket message: ${data.toString()}`));
    };
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      resolve();
    }, milliseconds);
    socket.once('message', onMessage);
  });
}

async function waitForExtensionReady(bridge: BridgeHandle): Promise<void> {
  await vi.waitFor(async () => {
    const health = await requestJson<{ extensionConnected: boolean }>(bridge.url, '/health');
    expect(health.body.extensionConnected).toBe(true);
  });
}

async function authorize(
  bridge: BridgeHandle,
  origin = `chrome-extension://${TRUSTED_EXTENSION_ID}`,
): Promise<{ socket: WebSocket; token: string }> {
  const socket = new WebSocket(`${bridge.wsUrl}?bootstrap=1`, { origin });
  sockets.push(socket);
  const message = await nextMessage<{ token: string }>(socket);
  expect(message.type).toBe('bridge.authorized');
  return { socket, token: message.payload.token };
}

async function expectWebSocketRejected(
  bridge: BridgeHandle,
  query: string,
  origin: string,
): Promise<void> {
  const socket = new WebSocket(`${bridge.wsUrl}${query}`, { origin });
  const status = await new Promise<number | undefined>((resolve, reject) => {
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once('open', () => reject(new Error(`Unexpected WebSocket connection for ${origin}`)));
    socket.once('error', reject);
  });
  expect(status).toBe(401);
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
  await temporaryDirectories.cleanup();
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

    const health = await requestJson<{
      ok: boolean;
      version: string;
      trustedExtensionId: string;
      extensionConnected: boolean;
      routing: { sinks: unknown[]; defaults: Record<string, string[]> };
    }>(bridge.url, '/health');
    expect(health).toEqual({
      status: 200,
      body: {
        ok: true,
        version: APP_VERSION,
        trustedExtensionId: TRUSTED_EXTENSION_ID,
        extensionConnected: false,
        // 默认无 sinks.json：只有本机库，所有来源都回退到它；分类清单供侧栏下拉。
        routing: {
          sinks: [
            {
              id: 'markdown',
              label: '本机库',
              categories: [
                '前端开发', '人工智能', '产品与设计', '商业与投资',
                '效率与工具', '生活与随笔', '其他',
              ],
            },
          ],
          defaults: { wechat: ['markdown'], zsxq: ['markdown'], nowcoder: ['markdown'] },
        },
      },
    });
    const unauthorized = await requestJson(bridge.url, '/v1/jobs', {
      method: 'POST',
      body: { url: URL },
    });
    expect(unauthorized.status).toBe(401);
    const removedPairing = await requestJson(bridge.url, `/v1/${['pa', 'ir'].join('')}`, {
      method: 'POST',
      body: { code: '123456' },
    });
    expect(removedPairing.status).toBe(404);

    const { socket, token } = await authorize(bridge);
    expect(token.length).toBeGreaterThanOrEqual(32);
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
    const { token } = await authorize(first);
    const job = await requestJson<{ id: string }>(first.url, '/v1/jobs', {
      method: 'POST',
      token,
      body: { url: URL, requestedBy: 'cli' },
    });
    await first.close();
    handles.splice(handles.indexOf(first), 1);

    const restarted = await startBridge(options);
    handles.push(restarted);
    const authorized = await authorize(restarted);
    expect(authorized.token).toBe(token);
    const socket = authorized.socket;
    const dispatchedPromise = nextMessage<{ url: string }>(socket);
    socket.send(envelope('extension.hello', 'extension', { version: '0.1.0' }));
    const dispatched = await dispatchedPromise;

    expect(dispatched).toMatchObject({ type: 'job.collect', requestId: job.body.id });
  });

  it('requeues an in-flight job when the extension socket reconnects', async () => {
    const root = await temporaryDirectory();
    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir: join(root, '.config') });
    handles.push(bridge);
    const authorized = await authorize(bridge);
    const token = authorized.token;
    const firstSocket = authorized.socket;
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

  it('lets an extension-requested current-page job report progress and save without redispatch', async () => {
    const root = await temporaryDirectory();
    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir: join(root, '.config') });
    handles.push(bridge);
    const { socket, token } = await authorize(bridge);
    socket.send(envelope('extension.hello', 'extension', { version: APP_VERSION }));
    await waitForExtensionReady(bridge);

    const noDispatch = expectNoMessage(socket);
    const created = await requestJson<{ id: string; status: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token,
      body: { url: URL, requestedBy: 'extension' },
    });
    expect(created).toMatchObject({ status: 202, body: { status: 'queued' } });
    await noDispatch;

    const savedMessage = nextMessage<{
      type: string;
      requestId: string;
      payload: { outputPath: string; results: { sinkId: string; ok: boolean }[] };
    }>(socket);
    socket.send(envelope('job.progress', created.body.id, { stage: 'collecting' }));
    socket.send(envelope('job.result', created.body.id, {
      document: document({ userCategory: '当前页分类', userTags: ['当前页', '覆盖值'] }),
    }));
    const saved = await savedMessage;

    // 侧边栏「已保存」屏依赖 job.saved 载荷里的 outputPath（多 sink 后的首要产出）。
    expect(saved).toMatchObject({ type: 'job.saved', requestId: created.body.id });
    expect(saved.payload.outputPath).toMatch(/index\.md$/);
    expect(saved.payload.results.some(result => result.sinkId === 'markdown' && result.ok)).toBe(true);
    const status = await requestJson<{ status: string; outputPath: string }>(
      bridge.url,
      `/v1/jobs/${created.body.id}`,
      { token },
    );
    expect(status.body.status).toBe('saved');
    const markdown = await readFile(status.body.outputPath, 'utf8');
    expect(markdown).toContain('category: "当前页分类"');
    expect(markdown).toContain('  - "当前页"');
    expect(markdown).toContain('  - "覆盖值"');
  });

  it('dispatches an abandoned extension-requested queued job after extension reconnect', async () => {
    const root = await temporaryDirectory();
    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir: join(root, '.config') });
    handles.push(bridge);
    const first = await authorize(bridge);
    first.socket.send(envelope('extension.hello', 'extension', { version: APP_VERSION }));
    await waitForExtensionReady(bridge);

    const noInitialDispatch = expectNoMessage(first.socket);
    const created = await requestJson<{ id: string }>(bridge.url, '/v1/jobs', {
      method: 'POST',
      token: first.token,
      body: { url: URL, requestedBy: 'extension' },
    });
    await noInitialDispatch;
    first.socket.close();
    await new Promise<void>(resolve => first.socket.once('close', () => resolve()));

    const second = await connect(bridge, first.token);
    const redispatch = nextMessage<{ url: string }>(second);
    second.send(envelope('extension.hello', 'extension', { version: APP_VERSION }));

    await expect(redispatch).resolves.toMatchObject({
      type: 'job.collect',
      requestId: created.body.id,
      payload: { url: URL },
    });
  });

  it('closes a peer that returns content for a different URL', async () => {
    const root = await temporaryDirectory();
    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir: join(root, '.config') });
    handles.push(bridge);
    const { socket, token } = await authorize(bridge);
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
    const { token } = await authorize(bridge);

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

  it('rejects untrusted bootstrap Origins without creating an access token', async () => {
    const root = await temporaryDirectory();
    const configDir = join(root, '.config');
    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir });
    handles.push(bridge);

    await expectWebSocketRejected(bridge, '?bootstrap=1', `chrome-extension://${'a'.repeat(32)}`);
    await expectWebSocketRejected(bridge, '?bootstrap=1', 'https://example.com');

    await expect(readFile(join(configDir, 'auth.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires bootstrap or a valid token from a trusted Origin', async () => {
    const root = await temporaryDirectory();
    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir: join(root, '.config') });
    handles.push(bridge);

    await expectWebSocketRejected(bridge, '', EXTENSION_ORIGIN);
    await expectWebSocketRejected(bridge, '?token=invalid', EXTENSION_ORIGIN);

    const authorized = await authorize(bridge, `extension://${TRUSTED_EXTENSION_ID}`);
    expect(authorized.token.length).toBeGreaterThanOrEqual(32);
  });

  it('replaces an older extension peer with an application close while keeping the new peer usable', async () => {
    const root = await temporaryDirectory();
    const bridge = await startBridge({ port: 0, libraryRoot: root, configDir: join(root, '.config') });
    handles.push(bridge);
    const first = await authorize(bridge);
    first.socket.send(envelope('extension.hello', 'extension-a', { version: APP_VERSION }));
    await waitForExtensionReady(bridge);
    const firstClosed = new Promise<{ code: number; reason: string }>(resolve => {
      first.socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    const second = await connect(bridge, first.token);
    await expect(firstClosed).resolves.toEqual({
      code: EXTENSION_REPLACED_CLOSE_CODE,
      reason: EXTENSION_REPLACED_CLOSE_REASON,
    });
    second.send(envelope('extension.hello', 'extension-b', { version: APP_VERSION }));
    await waitForExtensionReady(bridge);
    const pong = nextMessage(second);
    second.send(envelope('bridge.ping', 'replacement-check', {}));

    await expect(pong).resolves.toMatchObject({
      type: 'bridge.pong',
      requestId: 'replacement-check',
    });
    expect(second.readyState).toBe(WebSocket.OPEN);
  });
});
