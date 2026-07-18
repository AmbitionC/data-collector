import { describe, expect, it, vi } from 'vitest';
import {
  APP_VERSION,
  TRUSTED_EXTENSION_ID,
} from '@data-collector/shared';
import {
  BridgeConnection,
  type ExtensionStorage,
  type SocketLike,
} from '../../packages/extension/src/background/connection.js';

class MemoryStorage implements ExtensionStorage {
  readonly writes: Array<Record<string, unknown>> = [];
  values: Record<string, unknown>;

  constructor(values: Record<string, unknown> = {}) {
    this.values = { bridgePort: 17321, ...values };
  }

  async get(): Promise<Record<string, unknown>> {
    return { ...this.values };
  }

  async set(values: Record<string, unknown>): Promise<void> {
    this.writes.push(values);
    Object.assign(this.values, values);
  }
}

class MemorySocket implements SocketLike {
  readonly sent: string[] = [];
  readyState: number;
  private readonly listeners = new Map<string, Array<(event: { data?: string }) => void>>();

  constructor(readyState = 0) {
    this.readyState = readyState;
  }

  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    this.readyState = 3;
  }

  emit(type: string, data?: string): void {
    if (type === 'open') this.readyState = 1;
    if (type === 'close') this.readyState = 3;
    for (const listener of this.listeners.get(type) ?? []) listener({ ...(data ? { data } : {}) });
  }
}

function healthResponse(trustedExtensionId = TRUSTED_EXTENSION_ID): Response {
  return new Response(JSON.stringify({ ok: true, trustedExtensionId }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function dependencies(
  storage: MemoryStorage,
  socketFactory: (url: string) => SocketLike,
  fetcher: typeof fetch = vi.fn<typeof fetch>(),
) {
  return {
    storage,
    extensionId: TRUSTED_EXTENSION_ID,
    socketFactory,
    fetch: fetcher,
    setInterval: vi.fn(() => 1),
    clearInterval: vi.fn(),
    setTimeout: vi.fn(() => 1),
    clearTimeout: vi.fn(),
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('extension Bridge connection', () => {
  it('bootstraps an empty installation and saves the authorized token without pairing', async () => {
    const storage = new MemoryStorage();
    const socket = new MemorySocket();
    const socketFactory = vi.fn(() => socket);
    const fetcher = vi.fn<typeof fetch>(async () => healthResponse());
    const connection = new BridgeConnection(dependencies(storage, socketFactory, fetcher));

    await connection.start();

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:17321/health');
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/v1/pair'))).toBe(false);
    expect(socketFactory).toHaveBeenCalledWith(
      'ws://127.0.0.1:17321/v1/extension?bootstrap=1',
    );
    expect(storage.values.bridgeStatus).toBe('connecting');

    socket.emit('open');
    expect(socket.sent).toEqual([]);
    socket.emit(
      'message',
      JSON.stringify({
        protocolVersion: 1,
        type: 'bridge.authorized',
        requestId: 'authorization',
        timestamp: '2026-07-18T00:00:00.000Z',
        payload: { token: 'authorized-token'.padEnd(43, 'x') },
      }),
    );
    await flushPromises();

    expect(storage.values).toMatchObject({
      bridgeToken: 'authorized-token'.padEnd(43, 'x'),
      bridgeStatus: 'connected',
    });
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      type: 'extension.hello',
      payload: { version: APP_VERSION },
    });
  });

  it('rejects a Bridge configured for another extension without opening or retrying', async () => {
    const storage = new MemoryStorage();
    const socketFactory = vi.fn(() => new MemorySocket());
    const fetcher = vi.fn<typeof fetch>(async () => healthResponse('different-extension-id'));
    const deps = dependencies(storage, socketFactory, fetcher);
    const connection = new BridgeConnection(deps);

    await connection.start();

    expect(storage.values.bridgeStatus).toBe('identity_error');
    expect(socketFactory).not.toHaveBeenCalled();
    expect(deps.setTimeout).not.toHaveBeenCalled();
  });

  it('marks an unavailable unauthenticated Bridge disconnected and schedules one retry', async () => {
    const storage = new MemoryStorage();
    const socketFactory = vi.fn(() => new MemorySocket());
    const fetcher = vi.fn<typeof fetch>(async () => { throw new TypeError('fetch failed'); });
    const deps = dependencies(storage, socketFactory, fetcher);
    const connection = new BridgeConnection(deps);

    await expect(connection.start()).resolves.toBeUndefined();

    expect(storage.values.bridgeStatus).toBe('disconnected');
    expect(socketFactory).not.toHaveBeenCalled();
    expect(deps.setTimeout).toHaveBeenCalledOnce();
    expect(deps.setTimeout).toHaveBeenCalledWith(expect.any(Function), 1_000);
  });

  it('checks health with a native-style fetch function without rebinding this', async () => {
    const storage = new MemoryStorage();
    const socket = new MemorySocket();
    const nativeStyleFetch = async function (this: unknown): Promise<Response> {
      if (this !== undefined) throw new TypeError('Illegal invocation');
      return healthResponse();
    };
    const connection = new BridgeConnection(
      dependencies(storage, () => socket, nativeStyleFetch as typeof fetch),
    );

    await connection.start();

    expect(storage.values.bridgeStatus).toBe('connecting');
  });

  it('uses an existing token directly and announces the shared app version on open', async () => {
    const storage = new MemoryStorage({ bridgeToken: 'x'.repeat(43) });
    const socket = new MemorySocket();
    const socketFactory = vi.fn(() => socket);
    const fetcher = vi.fn<typeof fetch>();
    const connection = new BridgeConnection(dependencies(storage, socketFactory, fetcher));

    await connection.start();
    socket.emit('open');

    expect(fetcher).not.toHaveBeenCalled();
    expect(socketFactory).toHaveBeenCalledWith(
      `ws://127.0.0.1:17321/v1/extension?token=${'x'.repeat(43)}`,
    );
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      type: 'extension.hello',
      payload: { version: APP_VERSION },
    });
    expect(storage.values.bridgeStatus).toBe('connected');
  });

  it('announces once when the socket is already open before listeners are attached', async () => {
    const storage = new MemoryStorage({ bridgeToken: 'x'.repeat(43) });
    const socket = new MemorySocket(1);
    const connection = new BridgeConnection(dependencies(storage, () => socket));

    await connection.start();
    await flushPromises();

    expect(socket.sent.map(raw => JSON.parse(raw).type)).toEqual(['extension.hello']);
    expect(storage.values.bridgeStatus).toBe('connected');
  });

  it('preserves authorization received before the socket open event', async () => {
    const storage = new MemoryStorage();
    const socket = new MemorySocket();
    const connection = new BridgeConnection(
      dependencies(storage, () => socket, vi.fn<typeof fetch>(async () => healthResponse())),
    );
    await connection.start();

    socket.emit(
      'message',
      JSON.stringify({
        protocolVersion: 1,
        type: 'bridge.authorized',
        requestId: 'authorization',
        timestamp: '2026-07-18T00:00:00.000Z',
        payload: { token: 'early-token'.padEnd(43, 'x') },
      }),
    );
    await flushPromises();
    expect(storage.values.bridgeToken).toBe('early-token'.padEnd(43, 'x'));
    expect(socket.sent).toEqual([]);

    socket.emit('open');
    await flushPromises();
    expect(socket.sent.map(raw => JSON.parse(raw).type)).toEqual(['extension.hello']);
  });

  it('deduplicates error and close events from the same socket', async () => {
    const storage = new MemoryStorage({ bridgeToken: 'x'.repeat(43) });
    const socket = new MemorySocket();
    const deps = dependencies(storage, () => socket);
    const connection = new BridgeConnection(deps);
    await connection.start();
    socket.emit('open');

    socket.emit('error');
    socket.emit('close');
    await flushPromises();

    expect(deps.setTimeout).toHaveBeenCalledOnce();
    expect(storage.writes.filter(write => write.bridgeStatus === 'disconnected')).toHaveLength(1);
  });

  it('serializes concurrent start attempts into a single socket', async () => {
    const storage = new MemoryStorage();
    const socketFactory = vi.fn(() => new MemorySocket());
    const fetcher = vi.fn<typeof fetch>(async () => healthResponse());
    const connection = new BridgeConnection(dependencies(storage, socketFactory, fetcher));

    await Promise.all([connection.start(), connection.start()]);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(socketFactory).toHaveBeenCalledOnce();
  });

  it('routes collection jobs and persists semantic progress', async () => {
    const storage = new MemoryStorage({ bridgeToken: 'x'.repeat(43) });
    const socket = new MemorySocket();
    const collect = vi.fn();
    const connection = new BridgeConnection(dependencies(storage, () => socket));
    connection.onCollect(collect);

    await connection.start();
    socket.emit('open');
    socket.emit(
      'message',
      JSON.stringify({
        protocolVersion: 1,
        type: 'job.collect',
        requestId: 'job-1',
        timestamp: '2026-07-18T00:00:00.000Z',
        payload: { url: 'https://mp.weixin.qq.com/s/x' },
      }),
    );

    expect(collect).toHaveBeenCalledWith('job-1', 'https://mp.weixin.qq.com/s/x');
    await flushPromises();
    expect(storage.values.lastJobUrl).toBe('https://mp.weixin.qq.com/s/x');

    connection.send('job.progress', 'job-1', { stage: 'collecting' });
    await flushPromises();
    expect(storage.values.lastJobStatus).toBe('collecting');
    connection.send('job.result', 'job-1', { document: {} });
    await flushPromises();
    expect(storage.values.lastJobStatus).toBe('organizing');
    connection.send('job.error', 'job-1', { message: '页面加载超时', needsAttention: false });
    await flushPromises();
    expect(storage.values).toMatchObject({
      lastJobStatus: 'failed',
      lastJobError: '页面加载超时',
    });
  });

  it('reports that automatic connection is in progress when protected actions lack a token', async () => {
    const storage = new MemoryStorage();
    const connection = new BridgeConnection(dependencies(storage, () => new MemorySocket()));

    await expect(connection.createJob('https://mp.weixin.qq.com/s/x')).rejects.toThrow(
      '浏览器扩展仍在自动连接 Bridge',
    );
    await expect(connection.reveal('/tmp/x.md')).rejects.toThrow(
      '浏览器扩展仍在自动连接 Bridge',
    );
  });
});
