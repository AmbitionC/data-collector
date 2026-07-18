import { describe, expect, it, vi } from 'vitest';
import {
  BridgeConnection,
  type ExtensionStorage,
  type SocketLike,
} from '../../packages/extension/src/background/connection.js';

class MemoryStorage implements ExtensionStorage {
  values: Record<string, unknown> = { bridgeToken: 'x'.repeat(43), bridgePort: 17321 };

  async get(): Promise<Record<string, unknown>> {
    return { ...this.values };
  }

  async set(values: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, values);
  }
}

class MemorySocket implements SocketLike {
  readonly sent: string[] = [];
  readyState = 0;
  private readonly listeners = new Map<string, Array<(event: { data?: string }) => void>>();

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
    for (const listener of this.listeners.get(type) ?? []) listener({ ...(data ? { data } : {}) });
  }
}

describe('extension Bridge connection', () => {
  it('authenticates a socket, announces the extension, and routes collection jobs', async () => {
    const storage = new MemoryStorage();
    const socket = new MemorySocket();
    const collect = vi.fn();
    const connection = new BridgeConnection({
      storage,
      socketFactory: () => socket,
      fetch: vi.fn<typeof fetch>(),
      setInterval: () => 1,
      clearInterval: () => undefined,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    });
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

    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: 'extension.hello' });
    expect(collect).toHaveBeenCalledWith('job-1', 'https://mp.weixin.qq.com/s/x');
    expect(storage.values.bridgeStatus).toBe('connected');
  });

  it('pairs over HTTP and stores the returned token', async () => {
    const storage = new MemoryStorage();
    delete storage.values.bridgeToken;
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ token: 'paired-token'.padEnd(43, 'x') }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const connection = new BridgeConnection({
      storage,
      socketFactory: () => new MemorySocket(),
      fetch: fetcher,
      setInterval: () => 1,
      clearInterval: () => undefined,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    });

    await connection.pair('123456');

    expect(storage.values.bridgeToken).toBe('paired-token'.padEnd(43, 'x'));
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:17321/v1/pair',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
