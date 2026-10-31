import type { WebSocket } from 'ws';
import { NOWCODER_ARTICLE_CAPABILITY, articleActionSchema, articleResultSchema,
  type ArticleAction, type ArticleResult, type BrowserFamily } from '@data-collector/shared';
import { HttpError } from '../server/http.js';

interface Runtime {
  socket?: WebSocket | undefined;
  ready: boolean;
  capabilities: string[];
  browserFamily?: BrowserFamily | undefined;
  runtimeId?: string | undefined;
}
interface Pending {
  socket: WebSocket;
  resolve(result: ArticleResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Article requests never use the collector socket or resolve another runtime's result. */
export class ArticleTransport {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly runtime: () => Runtime, private readonly timeout = 90_000) {}
  get busy(): boolean { return this.pending.size > 0; }

  private available(browser?: BrowserFamily): Runtime {
    const runtime = this.runtime();
    if (!runtime.ready || runtime.socket?.readyState !== 1
      || !runtime.capabilities.includes(NOWCODER_ARTICLE_CAPABILITY)
      || !runtime.browserFamily) {
      throw new HttpError(409, 'ARTICLE_EXTENSION_REQUIRED', '需要已连接且已识别浏览器的发文插件');
    }
    if (browser && runtime.browserFamily !== browser) {
      throw new HttpError(409, 'ARTICLE_BROWSER_MISMATCH', '发文插件所在浏览器与草稿绑定不符');
    }
    return runtime;
  }

  assertAvailable(browser?: BrowserFamily): void { this.available(browser); }

  async execute(raw: ArticleAction, requestId: string, browser?: BrowserFamily): Promise<ArticleResult> {
    const action = articleActionSchema.parse(raw), runtime = this.available(browser);
    if (this.pending.has(requestId)) throw new Error('重复的发文插件请求编号');
    const socket = runtime.socket!;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new HttpError(409, 'ARTICLE_TIMEOUT', '发文插件操作超时；结果需人工核验，禁止自动重发'));
      }, this.timeout);
      this.pending.set(requestId, { socket, resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ protocolVersion: 1, type: 'article.execute', requestId, timestamp: new Date().toISOString(), payload: action }));
      } catch {
        clearTimeout(timer); this.pending.delete(requestId);
        reject(new HttpError(409, 'ARTICLE_DISPATCH_FAILED', '发文插件发送中断；结果需核验，禁止自动重发'));
      }
    });
  }

  receive(socket: WebSocket, requestId: string, raw: unknown): boolean {
    const flight = this.pending.get(requestId);
    if (!flight || flight.socket !== socket) return false;
    const result = articleResultSchema.safeParse(raw);
    clearTimeout(flight.timer); this.pending.delete(requestId);
    if (!result.success) flight.reject(new Error('发文插件回执格式无效，需核验，禁止自动重发'));
    else flight.resolve(result.data);
    return true;
  }

  disconnect(socket?: WebSocket): void {
    for (const [id, flight] of this.pending) {
      if (socket && flight.socket !== socket) continue;
      clearTimeout(flight.timer); this.pending.delete(id);
      flight.reject(new Error('发文插件连接已断开，结果需核验，禁止自动重发'));
    }
  }
}
