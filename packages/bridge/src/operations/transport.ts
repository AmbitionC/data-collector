import type { WebSocket } from 'ws';
import { NOWCODER_BROWSER_OPERATIONS_CAPABILITY, nowcoderOperationActionSchema, nowcoderOperationResultSchema,
  type NowcoderOperationAction, type NowcoderOperationResult } from '@data-collector/shared';
import { HttpError } from '../server/http.js';

interface Runtime { socket?: WebSocket | undefined; ready: boolean; capabilities: string[] }
interface Pending {
  socket: WebSocket;
  resolve(result: NowcoderOperationResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
export class NowcoderOperationsTransport {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly runtime: () => Runtime, private readonly timeout = 90_000) {}
  get busy(): boolean { return this.pending.size > 0; }

  assertAvailable(): void {
    const runtime = this.runtime();
    if (!runtime.ready || runtime.socket?.readyState !== 1 || !runtime.capabilities.includes(NOWCODER_BROWSER_OPERATIONS_CAPABILITY)) {
      throw new HttpError(409, 'OPERATIONS_EXTENSION_REQUIRED', '需要已连接且支持牛客页面操作的插件');
    }
  }

  async execute(raw: NowcoderOperationAction, requestId: string): Promise<NowcoderOperationResult> {
    const action = nowcoderOperationActionSchema.parse(raw), runtime = this.runtime();
    this.assertAvailable();
    if (this.pending.has(requestId)) throw new Error('重复的插件请求编号');
    const socket = runtime.socket!;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new HttpError(409, 'OPERATIONS_TIMEOUT', '插件操作超时；发送结果需人工核验，禁止自动重发'));
      }, this.timeout);
      this.pending.set(requestId, { socket, resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ protocolVersion: 1, type: 'operations.execute', requestId, timestamp: new Date().toISOString(), payload: action }));
      } catch (error) {
        clearTimeout(timer); this.pending.delete(requestId); reject(error);
      }
    });
  }

  receive(socket: WebSocket, requestId: string, raw: unknown): boolean {
    const flight = this.pending.get(requestId);
    if (!flight || flight.socket !== socket) return false;
    const result = nowcoderOperationResultSchema.safeParse(raw);
    if (!result.success) { clearTimeout(flight.timer); this.pending.delete(requestId); flight.reject(new Error('插件操作回执格式无效，需核验')); return true; }
    clearTimeout(flight.timer); this.pending.delete(requestId); flight.resolve(result.data);
    return true;
  }

  disconnect(socket?: WebSocket): void {
    for (const [id, flight] of this.pending) {
      if (socket && flight.socket !== socket) continue;
      clearTimeout(flight.timer); this.pending.delete(id);
      flight.reject(new Error('插件连接已断开，操作结果需核验，禁止自动重发'));
    }
  }
}
