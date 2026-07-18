import {
  APP_VERSION,
  bridgeAuthorizedPayloadSchema,
  wsEnvelopeSchema,
} from '@data-collector/shared';

export interface ExtensionStorage {
  get(keys?: string | string[] | Record<string, unknown>): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface SocketLike {
  readyState: number;
  addEventListener(type: string, listener: (event: { data?: string }) => void): void;
  send(value: string): void;
  close(): void;
}

interface ConnectionDependencies {
  storage: ExtensionStorage;
  extensionId: string;
  socketFactory: (url: string) => SocketLike;
  fetch: typeof fetch;
  setInterval: (callback: () => void, milliseconds: number) => unknown;
  clearInterval: (handle: unknown) => void;
  setTimeout: (callback: () => void, milliseconds: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

type CollectHandler = (requestId: string, url: string) => void | Promise<void>;

const DEFAULT_PORT = 17321;

interface ConnectionTransition {
  generation: number;
  values: Record<string, unknown>;
}

export class BridgeConnection {
  private socket: SocketLike | undefined;
  private pingTimer: unknown;
  private reconnectTimer: unknown;
  private reconnectAttempt = 0;
  private collectHandler: CollectHandler | undefined;
  private stopped = false;
  private startPromise: Promise<void> | undefined;
  private generation = 0;
  private latestTransition: ConnectionTransition | undefined;
  private latestJobTransition: ConnectionTransition | undefined;
  private tokenInvalidation: Promise<void> | undefined;
  private ignoreStoredToken = false;

  constructor(private readonly dependencies: ConnectionDependencies) {}

  onCollect(handler: CollectHandler): void {
    this.collectHandler = handler;
  }

  async start(): Promise<void> {
    this.stopped = false;
    if (this.startPromise) return this.startPromise;
    const startPromise = this.startOnce();
    this.startPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = undefined;
    }
  }

  private async startOnce(): Promise<void> {
    await this.tokenInvalidation;
    const settings = await this.settings();
    if (this.socket?.readyState === 0 || this.socket?.readyState === 1) return;
    const generation = ++this.generation;
    const bootstrap = !settings.token;
    if (bootstrap) {
      let trustedExtensionId: string;
      try {
        const fetcher = this.dependencies.fetch;
        const response = await fetcher(
          `http://127.0.0.1:${settings.port}/health`,
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const health = (await response.json()) as { trustedExtensionId?: unknown };
        if (typeof health.trustedExtensionId !== 'string') {
          throw new Error('Bridge health response is missing trustedExtensionId');
        }
        trustedExtensionId = health.trustedExtensionId;
      } catch {
        await this.markDisconnected(generation);
        return;
      }
      if (trustedExtensionId !== this.dependencies.extensionId) {
        this.cancelReconnect();
        await this.transition(generation, { bridgeStatus: 'identity_error' });
        return;
      }
    }
    if (!this.isCurrent(generation)) return;

    if (!(await this.transition(generation, { bridgeStatus: 'connecting' }))) return;
    let socket: SocketLike;
    try {
      socket = this.dependencies.socketFactory(
        bootstrap
          ? `ws://127.0.0.1:${settings.port}/v1/extension?bootstrap=1`
          : `ws://127.0.0.1:${settings.port}/v1/extension?token=${encodeURIComponent(settings.token!)}`,
      );
    } catch {
      await this.markDisconnected(generation);
      return;
    }
    if (!this.isCurrent(generation)) {
      socket.close();
      return;
    }
    this.socket = socket;
    let disconnected = false;
    let announced = false;
    let connectionReady: Promise<boolean> | undefined;
    const isCurrent = () =>
      this.isCurrent(generation) && !disconnected && this.socket === socket;

    const announce = async (token?: string): Promise<void> => {
      if (announced || !isCurrent()) return;
      if (token && !connectionReady) {
        connectionReady = this.transition(generation, {
          bridgeToken: token,
          bridgeStatus: 'connected',
        });
      }
      if (bootstrap && !connectionReady) return;
      connectionReady ??= this.transition(generation, { bridgeStatus: 'connected' });
      const readyCommitted = await connectionReady;
      if (token && readyCommitted) this.ignoreStoredToken = false;
      if (!readyCommitted) return;
      if (announced || !isCurrent() || socket.readyState !== 1) return;
      announced = true;
      this.reconnectAttempt = 0;
      this.cancelReconnect();
      this.send('extension.hello', 'extension', { version: APP_VERSION });
      this.startKeepalive();
    };

    socket.addEventListener('open', () => {
      void announce();
    });
    socket.addEventListener('message', event => {
      if (typeof event.data !== 'string' || !isCurrent()) return;
      void this.handleMessage(
        event.data,
        generation,
        isCurrent,
        token => announce(token),
      );
    });
    const disconnect = () => {
      if (disconnected || this.socket !== socket) return;
      disconnected = true;
      if (socket.readyState !== 3) socket.close();
      if (this.socket === socket) this.socket = undefined;
      if (this.pingTimer !== undefined) {
        this.dependencies.clearInterval(this.pingTimer);
        this.pingTimer = undefined;
      }
      const ready = connectionReady;
      const invalidateStoredToken = !bootstrap && !announced;
      void (async () => {
        if (ready) {
          try {
            await ready;
          } catch {
            // The disconnected transition below remains authoritative.
          }
        }
        if (invalidateStoredToken) await this.invalidateStoredToken();
        await this.markDisconnected(generation);
      })();
    };
    socket.addEventListener('close', disconnect);
    socket.addEventListener('error', disconnect);
    if (socket.readyState === 1 && !bootstrap) void announce();
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    if (this.pingTimer !== undefined) {
      this.dependencies.clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    this.cancelReconnect();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  send(type: string, requestId: string, payload: unknown): void {
    const socket = this.socket;
    if (socket?.readyState !== 1) throw new Error('Bridge WebSocket 未连接');
    socket.send(
      JSON.stringify({
        protocolVersion: 1,
        type,
        requestId,
        timestamp: new Date().toISOString(),
        payload,
      }),
    );
    const localStatus =
      type === 'job.progress'
        ? 'collecting'
        : type === 'job.result'
          ? 'organizing'
          : type === 'job.error'
            ? ((payload as { needsAttention?: boolean }).needsAttention ? 'needs_attention' : 'failed')
            : undefined;
    if (localStatus) {
      const generation = this.generation;
      const isCurrent = () => this.isCurrent(generation) && this.socket === socket;
      const errorMessage =
        type === 'job.error' && typeof (payload as { message?: unknown }).message === 'string'
          ? (payload as { message: string }).message
          : '';
      void this.transitionJob(generation, isCurrent, {
        lastJobId: requestId,
        lastJobStatus: localStatus,
        lastJobError: errorMessage,
      });
    }
  }

  async createJob(
    url: string,
    _overrides?: { userCategory?: string; userTags?: string[] },
  ): Promise<{ id: string }> {
    const settings = await this.settings();
    if (!settings.token) throw new Error('浏览器扩展仍在自动连接 Bridge');
    const generation = this.generation;
    const isCurrent = () => this.isCurrent(generation);
    const fetcher = this.dependencies.fetch;
    const response = await fetcher(
      `http://127.0.0.1:${settings.port}/v1/jobs`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${settings.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ url, requestedBy: 'extension' }),
      },
    );
    if (!response.ok) throw new Error(`创建采集任务失败：HTTP ${response.status}`);
    const job = (await response.json()) as { id?: unknown };
    if (typeof job.id !== 'string') throw new Error('Bridge 返回了无效任务');
    await this.transitionJob(generation, isCurrent, {
      lastJobId: job.id,
      lastJobStatus: 'queued',
      lastJobUrl: url,
      lastJobError: '',
    });
    return { id: job.id };
  }

  async reveal(path: string): Promise<void> {
    const settings = await this.settings();
    if (!settings.token) throw new Error('浏览器扩展仍在自动连接 Bridge');
    const fetcher = this.dependencies.fetch;
    const response = await fetcher(
      `http://127.0.0.1:${settings.port}/v1/reveal`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${settings.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ path }),
      },
    );
    if (!response.ok) throw new Error(`打开知识库文件失败：HTTP ${response.status}`);
  }

  private async settings(): Promise<{ token?: string; port: number }> {
    const values = await this.dependencies.storage.get(['bridgeToken', 'bridgePort']);
    return {
      ...(!this.ignoreStoredToken && typeof values.bridgeToken === 'string'
        ? { token: values.bridgeToken }
        : {}),
      port: typeof values.bridgePort === 'number' ? values.bridgePort : DEFAULT_PORT,
    };
  }

  private async invalidateStoredToken(): Promise<void> {
    if (this.tokenInvalidation) return this.tokenInvalidation;
    this.ignoreStoredToken = true;
    const invalidation = this.dependencies.storage.remove('bridgeToken').catch(() => undefined);
    this.tokenInvalidation = invalidation;
    try {
      await invalidation;
    } finally {
      if (this.tokenInvalidation === invalidation) this.tokenInvalidation = undefined;
    }
  }

  private async handleMessage(
    raw: string,
    generation: number,
    isCurrent: () => boolean,
    authorize: (token: string) => Promise<void>,
  ): Promise<void> {
    try {
      const message = wsEnvelopeSchema.parse(JSON.parse(raw));
      if (!isCurrent()) return;
      if (message.type === 'bridge.authorized') {
        const payload = bridgeAuthorizedPayloadSchema.parse(message.payload);
        await authorize(payload.token);
      } else if (message.type === 'job.collect') {
        const payload = message.payload as { url?: unknown };
        if (typeof payload.url === 'string' && isCurrent()) {
          const committed = await this.transitionJob(generation, isCurrent, {
            lastJobId: message.requestId,
            lastJobStatus: 'collecting',
            lastJobUrl: payload.url,
            lastJobError: '',
            lastOutputPath: '',
          });
          if (committed && isCurrent()) {
            await this.collectHandler?.(message.requestId, payload.url);
          }
        }
      } else if (message.type === 'job.saved' && isCurrent()) {
        const payload = message.payload as { markdownPath?: unknown };
        await this.transitionJob(generation, isCurrent, {
          lastJobId: message.requestId,
          lastJobStatus: 'saved',
          ...(typeof payload.markdownPath === 'string'
            ? { lastOutputPath: payload.markdownPath }
            : {}),
        });
      }
    } catch {
      if (isCurrent()) {
        await this.transition(generation, { bridgeStatus: 'protocol_error' });
      }
    }
  }

  private startKeepalive(): void {
    if (this.pingTimer !== undefined) this.dependencies.clearInterval(this.pingTimer);
    this.pingTimer = this.dependencies.setInterval(() => {
      if (this.socket?.readyState === 1) {
        this.send('bridge.ping', 'keepalive', {});
      }
    }, 20_000);
  }

  private async markDisconnected(generation: number): Promise<void> {
    if (!(await this.transition(generation, { bridgeStatus: 'disconnected' }))) return;
    if (!this.isCurrent(generation) || this.reconnectTimer !== undefined) return;
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.dependencies.setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.start();
    }, delay);
  }

  private isCurrent(generation: number): boolean {
    return !this.stopped && generation === this.generation;
  }

  private async transition(
    generation: number,
    values: Record<string, unknown>,
  ): Promise<boolean> {
    if (!this.isCurrent(generation)) return false;
    const transition = { generation, values };
    this.latestTransition = transition;
    await this.dependencies.storage.set(values);
    if (this.latestTransition !== transition) {
      let latest = this.latestTransition;
      while (latest) {
        await this.dependencies.storage.set(latest.values);
        if (this.latestTransition === latest) break;
        latest = this.latestTransition;
      }
      return false;
    }
    return this.isCurrent(generation);
  }

  private async transitionJob(
    generation: number,
    isCurrent: () => boolean,
    values: Record<string, unknown>,
  ): Promise<boolean> {
    if (!isCurrent()) return false;
    const previous = this.latestJobTransition?.values;
    const transitionValues =
      previous?.lastJobId === values.lastJobId
        ? { ...previous, ...values }
        : values;
    const transition = { generation, values: transitionValues };
    this.latestJobTransition = transition;
    await this.dependencies.storage.set(values);
    if (this.latestJobTransition !== transition) {
      let latest = this.latestJobTransition;
      while (latest) {
        await this.dependencies.storage.set(latest.values);
        if (this.latestJobTransition === latest) break;
        latest = this.latestJobTransition;
      }
      return false;
    }
    return isCurrent();
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer === undefined) return;
    this.dependencies.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }
}
