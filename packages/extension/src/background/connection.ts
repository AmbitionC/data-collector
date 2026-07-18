import {
  APP_VERSION,
  bridgeAuthorizedPayloadSchema,
  wsEnvelopeSchema,
} from '@data-collector/shared';

export interface ExtensionStorage {
  get(keys?: string | string[] | Record<string, unknown>): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
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

export class BridgeConnection {
  private socket: SocketLike | undefined;
  private pingTimer: unknown;
  private reconnectTimer: unknown;
  private reconnectAttempt = 0;
  private collectHandler: CollectHandler | undefined;
  private stopped = false;
  private startPromise: Promise<void> | undefined;

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
    const settings = await this.settings();
    if (this.socket?.readyState === 0 || this.socket?.readyState === 1) return;
    const bootstrap = !settings.token;
    if (bootstrap) {
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
        if (health.trustedExtensionId !== this.dependencies.extensionId) {
          this.cancelReconnect();
          await this.dependencies.storage.set({ bridgeStatus: 'identity_error' });
          return;
        }
      } catch {
        await this.markDisconnected();
        return;
      }
    }
    if (this.stopped) return;

    await this.dependencies.storage.set({ bridgeStatus: 'connecting' });
    let socket: SocketLike;
    try {
      socket = this.dependencies.socketFactory(
        bootstrap
          ? `ws://127.0.0.1:${settings.port}/v1/extension?bootstrap=1`
          : `ws://127.0.0.1:${settings.port}/v1/extension?token=${encodeURIComponent(settings.token!)}`,
      );
    } catch {
      await this.markDisconnected();
      return;
    }
    this.socket = socket;
    let disconnected = false;
    let announced = false;
    let authorization: Promise<void> | undefined;

    const announce = async (token?: string): Promise<void> => {
      if (announced || disconnected || this.socket !== socket) return;
      if (token && !authorization) {
        authorization = this.dependencies.storage.set({
          bridgeToken: token,
          bridgeStatus: 'connected',
        });
      }
      if (bootstrap && !authorization) return;
      if (authorization) await authorization;
      if (announced || disconnected || this.socket !== socket || socket.readyState !== 1) return;
      announced = true;
      this.reconnectAttempt = 0;
      this.cancelReconnect();
      if (!authorization) {
        void this.dependencies.storage.set({ bridgeStatus: 'connected' });
      }
      this.send('extension.hello', 'extension', { version: APP_VERSION });
      this.startKeepalive();
    };

    socket.addEventListener('open', () => {
      void announce();
    });
    socket.addEventListener('message', event => {
      if (typeof event.data !== 'string') return;
      void this.handleMessage(event.data, token => announce(token));
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
      void this.markDisconnected();
    };
    socket.addEventListener('close', disconnect);
    socket.addEventListener('error', disconnect);
    if (socket.readyState === 1 && !bootstrap) void announce();
  }

  stop(): void {
    this.stopped = true;
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
    if (this.socket?.readyState !== 1) throw new Error('Bridge WebSocket 未连接');
    this.socket.send(
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
      const errorMessage =
        type === 'job.error' && typeof (payload as { message?: unknown }).message === 'string'
          ? (payload as { message: string }).message
          : '';
      void this.dependencies.storage.set({
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
    await this.dependencies.storage.set({
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
      ...(typeof values.bridgeToken === 'string' ? { token: values.bridgeToken } : {}),
      port: typeof values.bridgePort === 'number' ? values.bridgePort : DEFAULT_PORT,
    };
  }

  private async handleMessage(
    raw: string,
    authorize: (token: string) => Promise<void>,
  ): Promise<void> {
    try {
      const message = wsEnvelopeSchema.parse(JSON.parse(raw));
      if (message.type === 'bridge.authorized') {
        const payload = bridgeAuthorizedPayloadSchema.parse(message.payload);
        await authorize(payload.token);
      } else if (message.type === 'job.collect') {
        const payload = message.payload as { url?: unknown };
        if (typeof payload.url === 'string') {
          void this.dependencies.storage.set({
            lastJobId: message.requestId,
            lastJobStatus: 'collecting',
            lastJobUrl: payload.url,
            lastJobError: '',
          });
          void this.collectHandler?.(message.requestId, payload.url);
        }
      } else if (message.type === 'job.saved') {
        const payload = message.payload as { markdownPath?: unknown };
        void this.dependencies.storage.set({
          lastJobId: message.requestId,
          lastJobStatus: 'saved',
          ...(typeof payload.markdownPath === 'string'
            ? { lastOutputPath: payload.markdownPath }
            : {}),
        });
      }
    } catch {
      void this.dependencies.storage.set({ bridgeStatus: 'protocol_error' });
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

  private async markDisconnected(): Promise<void> {
    await this.dependencies.storage.set({ bridgeStatus: 'disconnected' });
    if (this.stopped || this.reconnectTimer !== undefined) return;
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.dependencies.setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.start();
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer === undefined) return;
    this.dependencies.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }
}
