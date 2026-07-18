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
  readonly removals: Array<string | string[]> = [];
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

  async remove(keys: string | string[]): Promise<void> {
    this.removals.push(keys);
    for (const key of typeof keys === 'string' ? [keys] : keys) delete this.values[key];
  }
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

class DeferredStorage extends MemoryStorage {
  private readonly delays: Array<{
    matches: (values: Record<string, unknown>) => boolean;
    gate: ReturnType<typeof deferred>;
    startedGate: ReturnType<typeof deferred>;
    completedGate: ReturnType<typeof deferred>;
  }> = [];

  delayNextStatus(status: string) {
    return this.delayNextWrite(values => values.bridgeStatus === status);
  }

  delayNextJobWrite(jobId: string, status: string) {
    return this.delayNextWrite(
      values => values.lastJobId === jobId && values.lastJobStatus === status,
    );
  }

  private delayNextWrite(matches: (values: Record<string, unknown>) => boolean) {
    const gate = deferred();
    const startedGate = deferred();
    const completedGate = deferred();
    this.delays.push({ matches, gate, startedGate, completedGate });
    return {
      started: startedGate.promise,
      release: gate.release,
      completed: completedGate.promise,
    };
  }

  override async set(values: Record<string, unknown>): Promise<void> {
    const delayIndex = this.delays.findIndex(delay => delay.matches(values));
    if (delayIndex >= 0) {
      const [delay] = this.delays.splice(delayIndex, 1);
      delay!.startedGate.release();
      await delay!.gate.promise;
      await super.set(values);
      delay!.completedGate.release();
      return;
    }
    await super.set(values);
  }
}

class DeferredReadStorage extends MemoryStorage {
  private readonly readGate = deferred();
  private readonly startedGate = deferred();
  readonly readStarted = this.startedGate.promise;

  releaseRead(): void {
    this.readGate.release();
  }

  override async get(): Promise<Record<string, unknown>> {
    this.startedGate.release();
    await this.readGate.promise;
    return super.get();
  }
}

class MemorySocket implements SocketLike {
  readonly sent: string[] = [];
  readyState: number;
  private readonly listeners = new Map<string, Array<(event: {
    data?: string;
    code?: number;
    reason?: string;
  }) => void>>();

  constructor(readyState = 0) {
    this.readyState = readyState;
  }

  addEventListener(type: string, listener: (event: {
    data?: string;
    code?: number;
    reason?: string;
  }) => void): void {
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

  emit(type: string, data?: string, close?: { code: number; reason: string }): void {
    if (type === 'open') this.readyState = 1;
    if (type === 'close') this.readyState = 3;
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ ...(data ? { data } : {}), ...close });
    }
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
    expect(fetcher.mock.calls.some(([url]) => String(url).includes(`/v1/${['pa', 'ir'].join('')}`))).toBe(false);
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
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

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

  it('removes a stale stored token and reauthorizes through health on the scheduled retry', async () => {
    const staleToken = 'stale-token'.padEnd(43, 'x');
    const freshToken = 'fresh-token'.padEnd(43, 'x');
    const storage = new MemoryStorage({ bridgeToken: staleToken });
    const rejectedSocket = new MemorySocket();
    const bootstrapSocket = new MemorySocket();
    const socketFactory = vi.fn()
      .mockReturnValueOnce(rejectedSocket)
      .mockReturnValueOnce(bootstrapSocket);
    const fetcher = vi.fn<typeof fetch>(async () => healthResponse());
    const deps = dependencies(storage, socketFactory, fetcher);
    const connection = new BridgeConnection(deps);

    await connection.start();
    expect(socketFactory).toHaveBeenCalledWith(
      `ws://127.0.0.1:17321/v1/extension?token=${staleToken}`,
    );

    rejectedSocket.emit('close');
    await vi.waitFor(() => expect(deps.setTimeout).toHaveBeenCalledOnce());

    expect(storage.removals).toEqual(['bridgeToken']);
    expect(storage.values.bridgeToken).toBeUndefined();
    expect(storage.values.bridgeStatus).toBe('disconnected');
    expect(fetcher).not.toHaveBeenCalled();

    deps.setTimeout.mock.calls[0]![0]();
    await vi.waitFor(() => expect(socketFactory).toHaveBeenCalledTimes(2));
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:17321/health');
    expect(socketFactory).toHaveBeenLastCalledWith(
      'ws://127.0.0.1:17321/v1/extension?bootstrap=1',
    );

    bootstrapSocket.emit('open');
    bootstrapSocket.emit(
      'message',
      JSON.stringify({
        protocolVersion: 1,
        type: 'bridge.authorized',
        requestId: 'authorization',
        timestamp: '2026-07-18T00:00:00.000Z',
        payload: { token: freshToken },
      }),
    );
    await vi.waitFor(() => expect(bootstrapSocket.sent).toHaveLength(1));

    expect(storage.values.bridgeToken).toBe(freshToken);
    expect(bootstrapSocket.sent.map(raw => JSON.parse(raw).type)).toEqual(['extension.hello']);
  });

  it('stops after a stale token retry discovers a different fixed extension identity', async () => {
    const storage = new MemoryStorage({ bridgeToken: 'stale-token'.padEnd(43, 'x') });
    const rejectedSocket = new MemorySocket();
    const socketFactory = vi.fn(() => rejectedSocket);
    const fetcher = vi.fn<typeof fetch>(async () => healthResponse('different-extension-id'));
    const deps = dependencies(storage, socketFactory, fetcher);
    const connection = new BridgeConnection(deps);

    await connection.start();
    rejectedSocket.emit('close');
    await vi.waitFor(() => expect(deps.setTimeout).toHaveBeenCalledOnce());
    deps.setTimeout.mock.calls[0]![0]();
    await vi.waitFor(() => expect(storage.values.bridgeStatus).toBe('identity_error'));

    expect(storage.values.bridgeToken).toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(socketFactory).toHaveBeenCalledOnce();
    expect(deps.setTimeout).toHaveBeenCalledOnce();
  });

  it('retries a failed bootstrap socket only through backoff without token invalidation', async () => {
    const storage = new MemoryStorage();
    const firstSocket = new MemorySocket();
    const secondSocket = new MemorySocket();
    const socketFactory = vi.fn()
      .mockReturnValueOnce(firstSocket)
      .mockReturnValueOnce(secondSocket);
    const fetcher = vi.fn<typeof fetch>(async () => healthResponse());
    const deps = dependencies(storage, socketFactory, fetcher);
    const connection = new BridgeConnection(deps);

    await connection.start();
    firstSocket.emit('close');
    await vi.waitFor(() => expect(deps.setTimeout).toHaveBeenCalledOnce());

    expect(storage.removals).toEqual([]);
    expect(socketFactory).toHaveBeenCalledOnce();

    deps.setTimeout.mock.calls[0]![0]();
    await vi.waitFor(() => expect(socketFactory).toHaveBeenCalledTimes(2));
    expect(fetcher).toHaveBeenCalledTimes(2);

    secondSocket.emit('close');
    await vi.waitFor(() => expect(deps.setTimeout).toHaveBeenCalledTimes(2));
    expect(storage.removals).toEqual([]);
    expect(socketFactory).toHaveBeenCalledTimes(2);
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
    await vi.waitFor(() => expect(deps.setTimeout).toHaveBeenCalledOnce());

    expect(storage.writes.filter(write => write.bridgeStatus === 'disconnected')).toHaveLength(1);
  });

  it('enters standby on an explicit replacement close until the user retries', async () => {
    const storage = new MemoryStorage({ bridgeToken: 'x'.repeat(43) });
    const replacedSocket = new MemorySocket();
    const retrySocket = new MemorySocket();
    const socketFactory = vi.fn()
      .mockReturnValueOnce(replacedSocket)
      .mockReturnValueOnce(retrySocket);
    const deps = dependencies(storage, socketFactory);
    const connection = new BridgeConnection(deps);
    await connection.start();
    replacedSocket.emit('open');
    await vi.waitFor(() => expect(replacedSocket.sent).toHaveLength(1));

    replacedSocket.emit('close', undefined, { code: 4009, reason: 'replaced' });
    await vi.waitFor(() => expect(storage.values.bridgeStatus).toBe('replaced'));

    expect(deps.setTimeout).not.toHaveBeenCalled();
    await connection.start();
    expect(socketFactory).toHaveBeenCalledOnce();

    await (connection as BridgeConnection & { retry(): Promise<void> }).retry();
    expect(socketFactory).toHaveBeenCalledTimes(2);
    retrySocket.emit('open');
    await vi.waitFor(() => expect(retrySocket.sent).toHaveLength(1));
    expect(storage.values.bridgeStatus).toBe('connected');
  });

  it('suppresses automatic startup from a persisted replaced status but allows manual retry', async () => {
    const storage = new MemoryStorage({
      bridgeToken: 'x'.repeat(43),
      bridgeStatus: 'replaced',
    });
    const socket = new MemorySocket();
    const socketFactory = vi.fn(() => socket);
    const connection = new BridgeConnection(dependencies(storage, socketFactory));

    await connection.start();
    expect(socketFactory).not.toHaveBeenCalled();

    await (connection as BridgeConnection & { retry(): Promise<void> }).retry();
    expect(socketFactory).toHaveBeenCalledOnce();
  });

  it('honors manual retry while automatic startup is still reading persisted standby', async () => {
    const storage = new DeferredReadStorage({
      bridgeToken: 'x'.repeat(43),
      bridgeStatus: 'replaced',
    });
    const socketFactory = vi.fn(() => new MemorySocket());
    const connection = new BridgeConnection(dependencies(storage, socketFactory));

    const automatic = connection.start();
    await storage.readStarted;
    const manual = connection.retry();
    storage.releaseRead();
    await Promise.all([automatic, manual]);

    expect(socketFactory).toHaveBeenCalledOnce();
  });

  it('keeps a newer identity error after an older disconnect write resumes', async () => {
    const storage = new DeferredStorage({ bridgeToken: 'x'.repeat(43) });
    const socket = new MemorySocket();
    const fetcher = vi.fn<typeof fetch>(async () => healthResponse('different-extension-id'));
    const deps = dependencies(storage, () => socket, fetcher);
    const connection = new BridgeConnection(deps);
    await connection.start();
    socket.emit('open');

    delete storage.values.bridgeToken;
    const disconnectWrite = storage.delayNextStatus('disconnected');
    socket.emit('close');
    await disconnectWrite.started;

    await connection.start();
    expect(storage.values.bridgeStatus).toBe('identity_error');
    disconnectWrite.release();
    await flushPromises();
    await flushPromises();

    expect(storage.values.bridgeStatus).toBe('identity_error');
    expect(deps.setTimeout).not.toHaveBeenCalled();
  });

  it('lets disconnect win when authorization persistence finishes late', async () => {
    const storage = new DeferredStorage();
    const socket = new MemorySocket();
    const deps = dependencies(
      storage,
      () => socket,
      vi.fn<typeof fetch>(async () => healthResponse()),
    );
    const connection = new BridgeConnection(deps);
    await connection.start();
    socket.emit('open');

    const authorizationWrite = storage.delayNextStatus('connected');
    socket.emit(
      'message',
      JSON.stringify({
        protocolVersion: 1,
        type: 'bridge.authorized',
        requestId: 'authorization',
        timestamp: '2026-07-18T00:00:00.000Z',
        payload: { token: 'late-token'.padEnd(43, 'x') },
      }),
    );
    await authorizationWrite.started;
    socket.emit('close');
    await flushPromises();

    authorizationWrite.release();
    await vi.waitFor(() => expect(deps.setTimeout).toHaveBeenCalledOnce());

    expect(storage.values).toMatchObject({
      bridgeToken: 'late-token'.padEnd(43, 'x'),
      bridgeStatus: 'disconnected',
    });
    expect(socket.sent).toEqual([]);
  });

  it('ignores collection and invalid messages from a disconnected old socket', async () => {
    const storage = new MemoryStorage({ bridgeToken: 'x'.repeat(43) });
    const oldSocket = new MemorySocket();
    const currentSocket = new MemorySocket();
    const socketFactory = vi.fn()
      .mockReturnValueOnce(oldSocket)
      .mockReturnValueOnce(currentSocket);
    const collect = vi.fn();
    const connection = new BridgeConnection(dependencies(storage, socketFactory));
    connection.onCollect(collect);
    await connection.start();
    oldSocket.emit('open');
    await vi.waitFor(() => expect(oldSocket.sent).toHaveLength(1));
    oldSocket.emit('close');
    await flushPromises();
    await connection.start();
    currentSocket.emit('open');

    oldSocket.emit(
      'message',
      JSON.stringify({
        protocolVersion: 1,
        type: 'job.collect',
        requestId: 'stale-job',
        timestamp: '2026-07-18T00:00:00.000Z',
        payload: { url: 'https://mp.weixin.qq.com/s/stale' },
      }),
    );
    oldSocket.emit('message', '{invalid json');
    await flushPromises();

    expect(collect).not.toHaveBeenCalled();
    expect(storage.values.lastJobId).toBeUndefined();
    expect(storage.values.bridgeStatus).toBe('connected');
  });

  it('restores the latest job after old collect and saved writes finish late', async () => {
    const storage = new DeferredStorage({ bridgeToken: 'x'.repeat(43) });
    const oldSocket = new MemorySocket();
    const currentSocket = new MemorySocket();
    const socketFactory = vi.fn()
      .mockReturnValueOnce(oldSocket)
      .mockReturnValueOnce(currentSocket);
    const collect = vi.fn();
    const connection = new BridgeConnection(dependencies(storage, socketFactory));
    connection.onCollect(collect);
    await connection.start();
    oldSocket.emit('open');
    await vi.waitFor(() => expect(oldSocket.sent).toHaveLength(1));

    const oldCollectWrite = storage.delayNextJobWrite('job-A', 'collecting');
    const oldSavedWrite = storage.delayNextJobWrite('job-A', 'saved');
    oldSocket.emit(
      'message',
      JSON.stringify({
        protocolVersion: 1,
        type: 'job.collect',
        requestId: 'job-A',
        timestamp: '2026-07-18T00:00:00.000Z',
        payload: { url: 'https://mp.weixin.qq.com/s/A' },
      }),
    );
    oldSocket.emit(
      'message',
      JSON.stringify({
        protocolVersion: 1,
        type: 'job.saved',
        requestId: 'job-A',
        timestamp: '2026-07-18T00:00:00.000Z',
        payload: { markdownPath: '/library/A.md' },
      }),
    );
    await Promise.all([oldCollectWrite.started, oldSavedWrite.started]);

    oldSocket.emit('close');
    await vi.waitFor(() => expect(storage.values.bridgeStatus).toBe('disconnected'));
    await connection.start();
    currentSocket.emit('open');
    await vi.waitFor(() => expect(currentSocket.sent).toHaveLength(1));
    currentSocket.emit(
      'message',
      JSON.stringify({
        protocolVersion: 1,
        type: 'job.collect',
        requestId: 'job-B',
        timestamp: '2026-07-18T00:00:01.000Z',
        payload: { url: 'https://mp.weixin.qq.com/s/B' },
      }),
    );
    await vi.waitFor(() => expect(collect).toHaveBeenCalledWith('job-B', 'https://mp.weixin.qq.com/s/B'));
    currentSocket.emit(
      'message',
      JSON.stringify({
        protocolVersion: 1,
        type: 'job.saved',
        requestId: 'job-B',
        timestamp: '2026-07-18T00:00:02.000Z',
        payload: { markdownPath: '/library/B.md' },
      }),
    );
    await vi.waitFor(() => expect(storage.values).toMatchObject({
      lastJobId: 'job-B',
      lastJobStatus: 'saved',
      lastOutputPath: '/library/B.md',
    }));

    const currentJobWrites = storage.writes.filter(write => write.lastJobId === 'job-B').length;
    oldCollectWrite.release();
    oldSavedWrite.release();
    await vi.waitFor(() => expect(
      storage.writes.filter(write => write.lastJobId === 'job-B').length,
    ).toBeGreaterThan(currentJobWrites));

    expect(storage.values).toMatchObject({
      lastJobId: 'job-B',
      lastJobStatus: 'saved',
      lastJobUrl: 'https://mp.weixin.qq.com/s/B',
      lastOutputPath: '/library/B.md',
    });
    expect(collect).toHaveBeenCalledTimes(1);
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

    await flushPromises();
    expect(collect).toHaveBeenCalledWith('job-1', 'https://mp.weixin.qq.com/s/x');
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

  it('restores saved state after an older outgoing organizing write finishes late', async () => {
    const url = 'https://mp.weixin.qq.com/s/outgoing-organizing';
    const storage = new DeferredStorage({ bridgeToken: 'x'.repeat(43) });
    const socket = new MemorySocket();
    const connection = new BridgeConnection(dependencies(storage, () => socket));
    await connection.start();
    socket.emit('open');
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.emit(
      'message',
      JSON.stringify({
        protocolVersion: 1,
        type: 'job.collect',
        requestId: 'job-outgoing',
        timestamp: '2026-07-18T00:00:00.000Z',
        payload: { url },
      }),
    );
    await vi.waitFor(() => expect(storage.values.lastJobStatus).toBe('collecting'));

    const organizingWrite = storage.delayNextJobWrite('job-outgoing', 'organizing');
    connection.send('job.result', 'job-outgoing', { document: {} });
    await organizingWrite.started;
    socket.emit(
      'message',
      JSON.stringify({
        protocolVersion: 1,
        type: 'job.saved',
        requestId: 'job-outgoing',
        timestamp: '2026-07-18T00:00:01.000Z',
        payload: { markdownPath: '/library/outgoing.md' },
      }),
    );
    await vi.waitFor(() => expect(storage.values.lastJobStatus).toBe('saved'));

    organizingWrite.release();
    await organizingWrite.completed;
    await flushPromises();
    await flushPromises();

    expect(storage.values).toMatchObject({
      lastJobId: 'job-outgoing',
      lastJobStatus: 'saved',
      lastJobUrl: url,
      lastOutputPath: '/library/outgoing.md',
    });
  });

  it('restores collecting and saved state after an older queued write finishes late', async () => {
    const url = 'https://mp.weixin.qq.com/s/outgoing-queued';
    const storage = new DeferredStorage({ bridgeToken: 'x'.repeat(43) });
    const socket = new MemorySocket();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ id: 'job-queued' }),
      { status: 202, headers: { 'content-type': 'application/json' } },
    ));
    const connection = new BridgeConnection(dependencies(storage, () => socket, fetcher));
    await connection.start();
    socket.emit('open');
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    const queuedWrite = storage.delayNextJobWrite('job-queued', 'queued');
    const created = connection.createJob(url);
    await queuedWrite.started;
    connection.send('job.progress', 'job-queued', { stage: 'collecting' });
    await vi.waitFor(() => expect(storage.values.lastJobStatus).toBe('collecting'));
    socket.emit(
      'message',
      JSON.stringify({
        protocolVersion: 1,
        type: 'job.saved',
        requestId: 'job-queued',
        timestamp: '2026-07-18T00:00:01.000Z',
        payload: { markdownPath: '/library/queued.md' },
      }),
    );
    await vi.waitFor(() => expect(storage.values.lastJobStatus).toBe('saved'));

    queuedWrite.release();
    await queuedWrite.completed;
    await expect(created).resolves.toEqual({ id: 'job-queued' });
    await flushPromises();
    await flushPromises();

    expect(storage.values).toMatchObject({
      lastJobId: 'job-queued',
      lastJobStatus: 'saved',
      lastJobUrl: url,
      lastOutputPath: '/library/queued.md',
    });
  });

  it('does not persist job state when send fails before a connected socket accepts it', async () => {
    const storage = new MemoryStorage({ bridgeToken: 'x'.repeat(43) });
    const socket = new MemorySocket();
    const connection = new BridgeConnection(dependencies(storage, () => socket));
    await connection.start();

    expect(() => connection.send('job.progress', 'not-sent', { stage: 'collecting' }))
      .toThrow('Bridge WebSocket 未连接');
    await flushPromises();

    expect(storage.writes.some(write => write.lastJobId === 'not-sent')).toBe(false);
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
