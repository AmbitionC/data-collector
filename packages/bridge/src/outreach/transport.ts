import type { WebSocket } from 'ws';
import { INVEST_OUTREACH_CAPABILITY, outreachActionSchema, outreachResultSchema,
  type OutreachAction, type OutreachResult } from '@data-collector/shared';
import { HttpError } from '../server/http.js';

interface Runtime {
  socket?: WebSocket | undefined;
  ready: boolean;
  capabilities: string[];
}
interface Pending {
  socket: WebSocket;
  resolve(result: OutreachResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 引流发布走发文连接（同一个已登录浏览器、同一条认证通道），但消息类型独立：
 * outreach.execute / outreach.result。只接受发出请求的那条连接的回执，断线不重放。
 */
export class OutreachTransport {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly runtime: () => Runtime, private readonly timeout = 180_000) {}
  get busy(): boolean { return this.pending.size > 0; }

  private available(): Runtime {
    const runtime = this.runtime();
    if (!runtime.ready || runtime.socket?.readyState !== 1 || !runtime.capabilities.includes(INVEST_OUTREACH_CAPABILITY)) {
      throw new HttpError(409, 'OUTREACH_EXTENSION_REQUIRED', '需要已连接且支持引流发布的发文插件');
    }
    return runtime;
  }

  isAvailable(): boolean {
    try { this.available(); return true; } catch { return false; }
  }

  async execute(raw: OutreachAction, requestId: string): Promise<OutreachResult> {
    const action = outreachActionSchema.parse(raw), runtime = this.available();
    if (this.pending.has(requestId)) throw new Error('重复的引流发布请求编号');
    const socket = runtime.socket!;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new HttpError(409, 'OUTREACH_TIMEOUT', '引流发布超时；结果需核验，禁止自动重发'));
      }, this.timeout);
      this.pending.set(requestId, { socket, resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ protocolVersion: 1, type: 'outreach.execute', requestId, timestamp: new Date().toISOString(), payload: action }));
      } catch {
        clearTimeout(timer); this.pending.delete(requestId);
        reject(new HttpError(409, 'OUTREACH_DISPATCH_FAILED', '引流发布发送中断；结果需核验，禁止自动重发'));
      }
    });
  }

  receive(socket: WebSocket, requestId: string, raw: unknown): boolean {
    const flight = this.pending.get(requestId);
    if (!flight || flight.socket !== socket) return false;
    const result = outreachResultSchema.safeParse(raw);
    clearTimeout(flight.timer); this.pending.delete(requestId);
    if (!result.success) flight.reject(new Error('引流发布回执格式无效，需核验，禁止自动重发'));
    else flight.resolve(result.data);
    return true;
  }

  disconnect(socket?: WebSocket): void {
    for (const [id, flight] of this.pending) {
      if (socket && flight.socket !== socket) continue;
      clearTimeout(flight.timer); this.pending.delete(id);
      flight.reject(new Error('发文插件连接已断开，引流发布结果需核验，禁止自动重发'));
    }
  }
}
