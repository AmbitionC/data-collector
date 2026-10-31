import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { NOWCODER_ARTICLE_CAPABILITY } from '@data-collector/shared';
import { ArticleTransport } from '../../packages/bridge/src/articles/transport.js';

const socket = () => Object.assign(new EventEmitter(), { readyState: 1, send: vi.fn() }) as unknown as WebSocket;
const action = { kind: 'account' as const, expectedAccountId: '123' };
const result = { kind: 'account', identity: { userId: '123', nickname: '作者', profileUrl: 'https://www.nowcoder.com/users/123', observedAt: '2026-10-31T00:00:00.000Z' } };
const ready = (bound = socket()) => ({ socket: bound, ready: true, capabilities: [NOWCODER_ARTICLE_CAPABILITY], browserFamily: 'chrome' as const, runtimeId: 'runtime' });

describe('article runtime transport', () => {
  it.each([
    { ...ready(), ready: false },
    { ...ready(), capabilities: [] },
    { ...ready(), browserFamily: undefined },
    { ...ready(), browserFamily: 'edge' as const },
  ])('refuses unavailable or mismatched article browser before dispatch', async runtime => {
    const transport = new ArticleTransport(() => runtime);
    await expect(transport.execute(action, 'read-1', 'chrome')).rejects.toThrow();
    expect(runtime.socket.send).not.toHaveBeenCalled();
  });

  it('requires observed browser identity even when the caller omits a browser', () => {
    const transport = new ArticleTransport(() => ({ ...ready(), browserFamily: undefined }));
    expect(() => transport.assertAvailable()).toThrow();
  });

  it('binds requests to the original socket and dispatches only the article wire name', async () => {
    const bound = socket(), stranger = socket();
    const transport = new ArticleTransport(() => ready(bound));
    const pending = transport.execute(action, 'read-2', 'chrome');
    expect(transport.busy).toBe(true);
    expect(JSON.parse(vi.mocked(bound.send).mock.calls[0]![0] as string)).toMatchObject({ type: 'article.execute', requestId: 'read-2', payload: action });
    expect(transport.receive(stranger, 'read-2', result)).toBe(false);
    transport.disconnect(stranger);
    expect(transport.busy).toBe(true);
    expect(transport.receive(bound, 'read-2', result)).toBe(true);
    expect(await pending).toEqual(result);
    expect(transport.busy).toBe(false);
  });

  it('refuses duplicate pending IDs without sending twice', async () => {
    const bound = socket(), transport = new ArticleTransport(() => ready(bound));
    const pending = transport.execute(action, 'same-id');
    await expect(transport.execute(action, 'same-id')).rejects.toThrow('重复');
    expect(bound.send).toHaveBeenCalledTimes(1);
    transport.receive(bound, 'same-id', result);
    await pending;
  });

  it('rejects internal click evidence as a public receipt', async () => {
    const bound = socket(), transport = new ArticleTransport(() => ready(bound));
    const pending = transport.execute(action, 'clicked');
    const rejected = expect(pending).rejects.toThrow('回执');
    expect(transport.receive(bound, 'clicked', { kind: 'article-clicked', diagnostics: {} })).toBe(true);
    await rejected;
    expect(transport.busy).toBe(false);
  });

  it('disconnects without redispatching and keeps publication uncertainty explicit', async () => {
    const bound = socket(), transport = new ArticleTransport(() => ready(bound));
    const pending = transport.execute(action, 'disconnected');
    const rejected = expect(pending).rejects.toThrow('禁止自动重发');
    transport.disconnect(bound);
    await rejected;
    expect(bound.send).toHaveBeenCalledTimes(1);
  });

  it('times out once without dispatching a retry', async () => {
    vi.useFakeTimers();
    try {
      const bound = socket(), transport = new ArticleTransport(() => ready(bound), 25);
      const pending = transport.execute(action, 'timeout');
      const rejected = expect(pending).rejects.toThrow('禁止自动重发');
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      expect(transport.busy).toBe(false);
      expect(bound.send).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
