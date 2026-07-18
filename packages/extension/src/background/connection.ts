import { wsEnvelopeSchema } from '@data-collector/shared';

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

  constructor(private readonly dependencies: ConnectionDependencies) {}

  onCollect(handler: CollectHandler): void {
    this.collectHandler = handler;
  }

  async start(): Promise<void> {
    this.stopped = false;
    const settings = await this.settings();
    if (!settings.token) {
      await this.dependencies.storage.set({ bridgeStatus: 'unpaired' });
      return;
    }
    if (this.socket?.readyState === 0 || this.socket?.readyState === 1) return;
    const socket = this.dependencies.socketFactory(
      `ws://127.0.0.1:${settings.port}/v1/extension?token=${encodeURIComponent(settings.token)}`,
    );
    this.socket = socket;
    await this.dependencies.storage.set({ bridgeStatus: 'connecting' });

    socket.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      void this.dependencies.storage.set({ bridgeStatus: 'connected' });
      this.send('extension.hello', 'extension', { version: '0.1.0' });
      this.startKeepalive();
    });
    socket.addEventListener('message', event => {
      if (typeof event.data !== 'string') return;
      this.handleMessage(event.data);
    });
    socket.addEventListener('close', () => this.handleDisconnect());
    socket.addEventListener('error', () => this.handleDisconnect());
  }

  stop(): void {
    this.stopped = true;
    if (this.pingTimer !== undefined) this.dependencies.clearInterval(this.pingTimer);
    if (this.reconnectTimer !== undefined) this.dependencies.clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = undefined;
  }

  async pair(code: string): Promise<void> {
    const settings = await this.settings();
    const fetcher = this.dependencies.fetch;
    const response = await fetcher(
      `http://127.0.0.1:${settings.port}/v1/pair`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      },
    );
    if (!response.ok) throw new Error('配对失败，请确认配对码与 Bridge 状态');
    const body = (await response.json()) as { token?: unknown };
    if (typeof body.token !== 'string' || body.token.length < 32) {
      throw new Error('Bridge 返回了无效令牌');
    }
    await this.dependencies.storage.set({
      bridgeToken: body.token,
      bridgeStatus: 'connecting',
    });
    this.socket?.close();
    this.socket = undefined;
    await this.start();
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
    if (!settings.token) throw new Error('浏览器扩展尚未与 Bridge 配对');
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
    if (!settings.token) throw new Error('浏览器扩展尚未与 Bridge 配对');
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

  private handleMessage(raw: string): void {
    try {
      const message = wsEnvelopeSchema.parse(JSON.parse(raw));
      if (message.type === 'job.collect') {
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

  private handleDisconnect(): void {
    if (this.socket?.readyState !== 3) this.socket?.close();
    this.socket = undefined;
    if (this.pingTimer !== undefined) this.dependencies.clearInterval(this.pingTimer);
    void this.dependencies.storage.set({ bridgeStatus: 'disconnected' });
    if (this.stopped || this.reconnectTimer !== undefined) return;
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.dependencies.setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.start();
    }, delay);
  }
}
