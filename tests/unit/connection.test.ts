import { describe, expect, it, vi } from 'vitest';
import {
  APP_VERSION,
  TRUSTED_EXTENSION_ID,
  ZSXQ_COMPLETE_CONTENT_CAPABILITY,
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

function healthResponse(
  trustedExtensionId = TRUSTED_EXTENSION_ID,
  version = APP_VERSION,
): Response {
  return new Response(JSON.stringify({ ok: true, trustedExtensionId, version }), {
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

const PLAN_ATTEMPT = 'a1b2c3d4e5f60718';

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
      payload: {
        version: APP_VERSION,
        runtimeId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
      },
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

    // 已有 token 时仍会尽力刷新一次路由（失败不影响连接），但不再走 bootstrap 授权。
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:17321/health');
    expect(socketFactory).toHaveBeenCalledWith(
      `ws://127.0.0.1:17321/v1/extension?token=${'x'.repeat(43)}`,
    );
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      type: 'extension.hello',
      payload: {
        version: APP_VERSION,
        capabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY],
      },
    });
    expect(storage.values.bridgeStatus).toBe('connected');
  });

  it('fails a ZSXQ staging result closed on a Bridge too old for completeness audit fields', async () => {
    const storage = new MemoryStorage({ bridgeToken: 'x'.repeat(43) });
    const socket = new MemorySocket();
    const connection = new BridgeConnection(dependencies(
      storage,
      () => socket,
      vi.fn<typeof fetch>(async () => healthResponse(TRUSTED_EXTENSION_ID, '0.4.10')),
    ));
    await connection.start();
    socket.emit('open');
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    expect(() => connection.send('plan.result', 'batch-1', {
      batchId: 'batch-1',
      discovered: 3,
      prepared: false,
      rejections: { '非星主': 2 },
      rejectionDetails: [{
        url: 'https://wx.zsxq.com/group/48844584441158/topic/811111111111111',
        reason: '非星主',
      }],
    })).toThrow('BRIDGE_UPDATE_REQUIRED');
    expect(socket.sent).toHaveLength(1);
  });

  it('keeps rejection counts but omits per-item details for a strict 0.4.28 Bridge', async () => {
    const storage = new MemoryStorage({ bridgeToken: 'x'.repeat(43) });
    const socket = new MemorySocket();
    const connection = new BridgeConnection(dependencies(
      storage,
      () => socket,
      vi.fn<typeof fetch>(async () => healthResponse(TRUSTED_EXTENSION_ID, '0.4.28')),
    ));
    await connection.start();
    socket.emit('open');
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    connection.send('plan.result', 'batch-1', {
      batchId: 'batch-1',
      discovered: 3,
      rejections: { '非星主': 2 },
      rejectionDetails: [{
        url: 'https://wx.zsxq.com/group/48844584441158/topic/811111111111111',
        reason: '非星主',
      }],
    });

    expect(JSON.parse(socket.sent.at(-1)!).payload).toEqual({
      batchId: 'batch-1',
      discovered: 3,
      rejections: { '非星主': 2 },
    });
  });

  it('keeps rejection counts and per-item details when the Bridge supports them', async () => {
    const storage = new MemoryStorage({ bridgeToken: 'x'.repeat(43) });
    const socket = new MemorySocket();
    const connection = new BridgeConnection(dependencies(
      storage,
      () => socket,
      vi.fn<typeof fetch>(async () => healthResponse(TRUSTED_EXTENSION_ID, '0.4.29')),
    ));
    await connection.start();
    socket.emit('open');
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    connection.send('plan.result', 'batch-1', {
      batchId: 'batch-1',
      discovered: 3,
      rejections: { '非星主': 2 },
      rejectionDetails: [{
        url: 'https://wx.zsxq.com/group/48844584441158/topic/811111111111111',
        reason: '非星主',
      }],
    });

    expect(JSON.parse(socket.sent.at(-1)!).payload).toMatchObject({
      rejections: { '非星主': 2 },
      rejectionDetails: [{
        url: 'https://wx.zsxq.com/group/48844584441158/topic/811111111111111',
        reason: '非星主',
      }],
    });
  });

  it('fails closed after a later health refresh cannot verify the Bridge version', async () => {
    const storage = new MemoryStorage({ bridgeToken: 'x'.repeat(43) });
    const firstSocket = new MemorySocket();
    const secondSocket = new MemorySocket();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(healthResponse(TRUSTED_EXTENSION_ID, APP_VERSION))
      .mockRejectedValueOnce(new Error('health unavailable'));
    const connection = new BridgeConnection(dependencies(
      storage,
      vi.fn()
        .mockReturnValueOnce(firstSocket)
        .mockReturnValueOnce(secondSocket),
      fetcher,
    ));
    await connection.start();
    firstSocket.emit('open');
    await vi.waitFor(() => expect(firstSocket.sent).toHaveLength(1));
    connection.send('plan.result', 'new-bridge', {
      batchId: 'new-bridge', discovered: 1, rejections: { '非星主': 1 },
    });
    expect(JSON.parse(firstSocket.sent.at(-1)!).payload.rejections).toBeDefined();

    firstSocket.emit('close');
    await flushPromises();
    await connection.retry();
    secondSocket.emit('open');
    await vi.waitFor(() => expect(secondSocket.sent).toHaveLength(1));
    expect(() => connection.send('plan.result', 'unknown-bridge', {
      batchId: 'unknown-bridge',
      discovered: 1,
      prepared: true,
      rejections: { '正文不完整': 1 },
      rejectionDetails: [{
        url: 'https://wx.zsxq.com/group/48844584441158/topic/811111111111111',
        reason: '正文不完整',
      }],
    })).toThrow('BRIDGE_UPDATE_REQUIRED');
    expect(secondSocket.sent).toHaveLength(1);
  });

  it('refreshes routing on every authorized connect（改去向无需重装扩展）', async () => {
    const storage = new MemoryStorage({
      bridgeToken: 'x'.repeat(43),
      routing: { sinks: [{ id: 'markdown', label: '本机库', categories: [] }], defaults: {} },
    });
    const socket = new MemorySocket();
    const nextRouting = {
      sinks: [
        { id: 'markdown', label: '本机库', categories: ['其他'] },
        { id: 'life-teachers', label: 'life-teachers 收件箱', categories: ['投资', '认知'] },
      ],
      defaults: { wechat: ['markdown', 'life-teachers'] },
    };
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ trustedExtensionId: 'irrelevant', routing: nextRouting }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    const connection = new BridgeConnection(dependencies(storage, () => socket, fetcher));

    await connection.start();
    socket.emit('open');
    await vi.waitFor(() => expect(storage.values.bridgeStatus).toBe('connected'));

    // Bridge 侧新增的去向已进入扩展缓存，侧栏下次渲染即可见。
    expect(storage.values.routing).toEqual(nextRouting);
  });

  it('refreshes routing on the periodic wake-up even while the socket stays connected', async () => {
    const storage = new MemoryStorage({ bridgeToken: 'x'.repeat(43) });
    const socket = new MemorySocket();
    let routing = { sinks: [{ id: 'markdown', label: '本机库', categories: [] }], defaults: {} };
    // 浏览器的 fetch 认接收者：写成 deps.fetch(...) 会以 deps 为 this 调用并抛
    // Illegal invocation。这里如实模拟，否则「改配置要重装扩展」这类 bug 测不出来。
    const fetcher = vi.fn(function (this: unknown) {
      if (this !== undefined) throw new TypeError("Failed to execute 'fetch': Illegal invocation");
      return Promise.resolve(
        new Response(JSON.stringify({ trustedExtensionId: 'irrelevant', routing }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch;
    const connection = new BridgeConnection(dependencies(storage, () => socket, fetcher));

    await connection.start();
    socket.emit('open');
    await vi.waitFor(() => expect(storage.values.bridgeStatus).toBe('connected'));

    // 用户在 Bridge 侧新建了一个去向目录后，下一次 1 分钟闹钟唤醒就应该看到它，
    // 不需要重装扩展——连接还开着也要刷新，不能被「已连接」的提前返回挡掉。
    routing = {
      sinks: [{ id: 'life-teachers', label: 'life-teachers 收件箱', categories: ['投资'] }],
      defaults: {},
    };
    await connection.start();

    expect(storage.values.routing).toEqual(routing);
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
    // 带 token 的首次尝试只做一次「路由刷新」health 调用，不走 bootstrap 授权。
    expect(fetcher).toHaveBeenCalledOnce();
    expect(socketFactory).not.toHaveBeenCalledWith(
      'ws://127.0.0.1:17321/v1/extension?bootstrap=1',
    );

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
    // 两次 health：① 带 token 时的路由刷新 ② 重试时的 bootstrap 身份校验（发现 ID 不符）。
    expect(fetcher).toHaveBeenCalledTimes(2);
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
        payload: { outputPath: '/library/A.md' },
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
    await vi.waitFor(() => expect(collect).toHaveBeenCalledWith(
      'job-B',
      'https://mp.weixin.qq.com/s/B',
      true,
    ));
    currentSocket.emit(
      'message',
      JSON.stringify({
        protocolVersion: 1,
        type: 'job.saved',
        requestId: 'job-B',
        timestamp: '2026-07-18T00:00:02.000Z',
        payload: { outputPath: '/library/B.md' },
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

  it('records a Bridge-side persistence failure instead of leaving the job organizing', async () => {
    const storage = new MemoryStorage({ bridgeToken: 'x'.repeat(43) });
    const socket = new MemorySocket();
    const connection = new BridgeConnection(dependencies(storage, () => socket));
    await connection.start();
    socket.emit('open');
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    socket.emit(
      'message',
      JSON.stringify({
        protocolVersion: 1,
        type: 'job.failed',
        requestId: 'job-save-failed',
        timestamp: '2026-07-18T00:00:00.000Z',
        payload: { code: 'SAVE_FAILED', message: '知识库写入失败' },
      }),
    );

    await vi.waitFor(() => expect(storage.values).toMatchObject({
      lastJobId: 'job-save-failed',
      lastJobStatus: 'failed',
      lastJobError: '知识库写入失败',
    }));
  });

  it('settles a persistence waiter only for the matching job and plan attempt', async () => {
    const storage = new MemoryStorage({ bridgeToken: 'x'.repeat(43) });
    const socket = new MemorySocket();
    const connection = new BridgeConnection(dependencies(storage, () => socket));
    await connection.start();
    socket.emit('open');
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    let settled = false;
    const waiting = connection.waitForJobTerminal('job-current-attempt', PLAN_ATTEMPT, 30_000)
      .then(() => { settled = true; });
    socket.emit('message', JSON.stringify({
      protocolVersion: 1,
      type: 'job.saved',
      requestId: 'job-other',
      timestamp: '2026-08-25T00:00:00.000Z',
      payload: { outputPath: '/library/other.md', results: [], attempt: PLAN_ATTEMPT },
    }));
    await flushPromises();
    expect(settled).toBe(false);

    socket.emit('message', JSON.stringify({
      protocolVersion: 1,
      type: 'job.saved',
      requestId: 'job-current-attempt',
      timestamp: '2026-08-25T00:00:01.000Z',
      payload: {
        outputPath: '/library/current.md',
        results: [],
        attempt: PLAN_ATTEMPT,
      },
    }));

    await expect(waiting).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it('replays an early terminal notice and rejects a cached cross-attempt notice', async () => {
    const storage = new MemoryStorage({ bridgeToken: 'x'.repeat(43) });
    const socket = new MemorySocket();
    const connection = new BridgeConnection(dependencies(storage, () => socket));
    await connection.start();
    socket.emit('open');
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    const saved = (jobId: string, attempt: string) => socket.emit('message', JSON.stringify({
      protocolVersion: 1,
      type: 'job.saved',
      requestId: jobId,
      timestamp: '2026-08-25T00:00:00.000Z',
      payload: { outputPath: `/library/${jobId}.md`, results: [], attempt },
    }));
    saved('job-early-current', PLAN_ATTEMPT);
    await flushPromises();
    await expect(connection.waitForJobTerminal(
      'job-early-current',
      PLAN_ATTEMPT,
    )).resolves.toBeUndefined();

    saved('job-early-stale', '0123456789abcdef');
    await flushPromises();
    await expect(connection.waitForJobTerminal(
      'job-early-stale',
      PLAN_ATTEMPT,
    )).rejects.toThrow('回执尝试不匹配');
  });

  it('rejects a persistence waiter when the matching job reports sink failure', async () => {
    const storage = new MemoryStorage({ bridgeToken: 'x'.repeat(43) });
    const socket = new MemorySocket();
    const connection = new BridgeConnection(dependencies(storage, () => socket));
    await connection.start();
    socket.emit('open');
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    const waiting = connection.waitForJobTerminal('job-sink-failed', PLAN_ATTEMPT, 30_000);
    socket.emit('message', JSON.stringify({
      protocolVersion: 1,
      type: 'job.failed',
      requestId: 'job-sink-failed',
      timestamp: '2026-08-25T00:00:00.000Z',
      payload: {
        code: 'SAVE_FAILED',
        message: '知识库目录写入失败',
        attempt: PLAN_ATTEMPT,
      },
    }));

    await expect(waiting).rejects.toThrow('知识库目录写入失败');
  });

  it('allows slow image and attachment sinks ten minutes before timeout recovery', async () => {
    const storage = new MemoryStorage({ bridgeToken: 'x'.repeat(43) });
    const socket = new MemorySocket();
    const deps = dependencies(storage, () => socket);
    const connection = new BridgeConnection(deps);
    await connection.start();
    socket.emit('open');
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    const waiting = connection.waitForJobTerminal('job-slow-media', PLAN_ATTEMPT);

    expect(deps.setTimeout).toHaveBeenCalledWith(expect.any(Function), 10 * 60_000);
    socket.emit('message', JSON.stringify({
      protocolVersion: 1,
      type: 'job.saved',
      requestId: 'job-slow-media',
      timestamp: '2026-08-25T00:00:00.000Z',
      payload: {
        outputPath: '/library/job-slow-media.md',
        results: [],
        attempt: PLAN_ATTEMPT,
      },
    }));
    await expect(waiting).resolves.toBeUndefined();
  });

  it('recovers a lost WebSocket acknowledgement from the persisted JobStore state', async () => {
    const storage = new MemoryStorage({ bridgeToken: 'x'.repeat(43) });
    const socket = new MemorySocket();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      id: 'job-notice-lost',
      status: 'saved',
      planAttempt: PLAN_ATTEMPT,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const deps = dependencies(storage, () => socket, fetcher);
    let expire!: () => void;
    deps.setTimeout = vi.fn(callback => {
      expire = callback;
      return 91;
    });
    const connection = new BridgeConnection(deps);
    await connection.start();
    socket.emit('open');
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    const waiting = connection.waitForJobTerminal('job-notice-lost', PLAN_ATTEMPT, 500);
    expire();

    await expect(waiting).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:17321/v1/jobs/job-notice-lost',
      { headers: { authorization: `Bearer ${'x'.repeat(43)}` } },
    );
  });

  it('rejects instead of assuming saved when timeout recovery finds no terminal state', async () => {
    const storage = new MemoryStorage({ bridgeToken: 'x'.repeat(43) });
    const socket = new MemorySocket();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      id: 'job-still-collecting',
      status: 'collecting',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const deps = dependencies(storage, () => socket, fetcher);
    let expire!: () => void;
    deps.setTimeout = vi.fn(callback => {
      expire = callback;
      return 92;
    });
    const connection = new BridgeConnection(deps);
    await connection.start();
    socket.emit('open');
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    const waiting = connection.waitForJobTerminal('job-still-collecting', undefined, 500);
    expire();

    await expect(waiting).rejects.toThrow('持久化回执超时');
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
    expect(collect).toHaveBeenCalledWith('job-1', 'https://mp.weixin.qq.com/s/x', true);
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

  it('does not drop a collection job when a newer sidebar-state write wins', async () => {
    const storage = new DeferredStorage({ bridgeToken: 'x'.repeat(43) });
    const socket = new MemorySocket();
    const collect = vi.fn(async () => undefined);
    const connection = new BridgeConnection(dependencies(storage, () => socket));
    connection.onCollect(collect);
    await connection.start();
    socket.emit('open');
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    const firstWrite = storage.delayNextJobWrite('job-burst-1', 'collecting');
    socket.emit('message', JSON.stringify({
      protocolVersion: 1,
      type: 'job.collect',
      requestId: 'job-burst-1',
      timestamp: '2026-08-23T00:00:00.000Z',
      payload: { url: 'https://www.nowcoder.com/discuss/10001' },
    }));
    await firstWrite.started;
    socket.emit('message', JSON.stringify({
      protocolVersion: 1,
      type: 'job.collect',
      requestId: 'job-burst-2',
      timestamp: '2026-08-23T00:00:01.000Z',
      payload: { url: 'https://www.nowcoder.com/discuss/10002' },
    }));
    await vi.waitFor(() => expect(collect).toHaveBeenCalledWith(
      'job-burst-2',
      'https://www.nowcoder.com/discuss/10002',
      true,
    ));

    firstWrite.release();
    await firstWrite.completed;
    await vi.waitFor(() => expect(collect).toHaveBeenCalledWith(
      'job-burst-1',
      'https://www.nowcoder.com/discuss/10001',
      true,
    ));
    expect(collect).toHaveBeenCalledTimes(2);
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
        payload: { outputPath: '/library/outgoing.md' },
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
        payload: { outputPath: '/library/queued.md' },
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

  it('binds a ZSXQ plan job creation request to the dispatched attempt token', async () => {
    const storage = new MemoryStorage({ bridgeToken: 'x'.repeat(43) });
    let requestBody: unknown;
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: 'attempt-bound-job' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    });
    const connection = new BridgeConnection(dependencies(storage, () => new MemorySocket(), fetcher));

    await connection.createJob(
      'https://wx.zsxq.com/group/48844584441158/topic/811111111111111',
      {
        batchId: 'batch-attempt-bound',
        planId: 'zsxq-chen-teacher',
        attempt: 'a1b2c3d4e5f60718',
      },
    );

    expect(requestBody).toMatchObject({
      batchId: 'batch-attempt-bound',
      planId: 'zsxq-chen-teacher',
      attempt: 'a1b2c3d4e5f60718',
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

  it('loads the compact ZSXQ index through the protected Bridge endpoint', async () => {
    const storage = new MemoryStorage({ bridgeToken: 'x'.repeat(43) });
    const entries = [{
      id: 'abc123def456',
      url: 'https://wx.zsxq.com/group/48844584441158/topic/811111111111111',
      contentComplete: true,
    }];
    const fetcher = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ entries }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const connection = new BridgeConnection(dependencies(storage, () => new MemorySocket(), fetcher));

    await expect(connection.zsxqIndex()).resolves.toEqual(entries);
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:17321/v1/library/zsxq-index',
      expect.objectContaining({
        headers: { authorization: `Bearer ${'x'.repeat(43)}` },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('aborts a stalled compact ZSXQ index request instead of hanging the plan', async () => {
    const storage = new MemoryStorage({ bridgeToken: 'x'.repeat(43) });
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    const deps = dependencies(storage, () => new MemorySocket(), fetcher);
    const connection = new BridgeConnection(deps);
    const pending = connection.zsxqIndex();
    const rejected = expect(pending).rejects.toThrow(/去重索引请求超时/u);

    await flushPromises();
    expect(deps.setTimeout).toHaveBeenCalled();
    deps.setTimeout.mock.calls.at(-1)![0]();
    await rejected;
    expect(signal?.aborted).toBe(true);
  });

  it('proxies fixed collection plan status and run requests with extension authorization', async () => {
    const storage = new MemoryStorage({ bridgeToken: 'x'.repeat(43) });
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v1/plans/status')) {
        return new Response(JSON.stringify({ plans: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        planId: 'nowcoder-agent-market',
        force: true,
      });
      return new Response(JSON.stringify({ batch: { id: 'batch-1' } }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    });
    const connection = new BridgeConnection(dependencies(storage, () => new MemorySocket(), fetcher));

    await expect(connection.planStatus()).resolves.toEqual({ plans: [] });
    await expect(connection.runPlan('nowcoder-agent-market', true)).resolves.toEqual({
      batch: { id: 'batch-1' },
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:17321/v1/plans/status',
      { headers: { authorization: `Bearer ${'x'.repeat(43)}` } },
    );
  });
});
