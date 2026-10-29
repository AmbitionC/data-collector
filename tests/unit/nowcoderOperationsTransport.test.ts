import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { NOWCODER_BROWSER_OPERATIONS_CAPABILITY } from '@data-collector/shared';
import { NowcoderOperationsTransport } from '../../packages/bridge/src/operations/transport.js';

const action = { kind: 'context' as const, url: 'https://www.nowcoder.com/discuss/123456', maxPages: 1 };
const result = { kind: 'attention', code: 'LOGIN_REQUIRED', message: '请登录', submission: 'not_attempted' };
const socket = () => Object.assign(new EventEmitter(), { readyState: 1, send: vi.fn() }) as unknown as WebSocket;
describe('operation RPC socket binding', () => {
  it('requires the authenticated current extension capability', async () => {
    const transport = new NowcoderOperationsTransport(() => ({ socket: socket(), ready: true, capabilities: [] }));
    await expect(transport.execute(action, 'read-1')).rejects.toThrow('插件');
  });
  it('ignores another socket and stops on disconnect instead of redispatching', async () => {
    const first = socket(), replacement = socket();
    const transport = new NowcoderOperationsTransport(() => ({ socket: first, ready: true, capabilities: [NOWCODER_BROWSER_OPERATIONS_CAPABILITY] }));
    const pending = transport.execute(action, 'read-2');
    const rejected = expect(pending).rejects.toThrow('断开');
    expect(transport.receive(replacement, 'read-2', result)).toBe(false);
    transport.disconnect(first);
    await rejected;
    expect(first.send).toHaveBeenCalledTimes(1);
  });
  it('accepts one typed result from the bound socket', async () => {
    const first = socket();
    const transport = new NowcoderOperationsTransport(() => ({ socket: first, ready: true, capabilities: [NOWCODER_BROWSER_OPERATIONS_CAPABILITY] }));
    const pending = transport.execute(action, 'read-3');
    expect(transport.receive(first, 'read-3', result)).toBe(true);
    expect(await pending).toEqual(result);
    expect(transport.busy).toBe(false);
  });
});
