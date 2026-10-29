import { describe, expect, it, vi } from 'vitest';
import { NowcoderOperationsRunner } from '../../packages/extension/src/background/nowcoderOperations.js';

const action = { kind: 'context' as const, url: 'https://www.nowcoder.com/discuss/123456', maxPages: 1 };
describe('plugin operation owned tabs', () => {
  it('owns an inactive tab, waits for load, and hands verification to the user without closing it', async () => {
    const create = vi.fn(async () => ({ id: 77 })), close = vi.fn(async () => undefined), handoff = vi.fn(async () => undefined), wait = vi.fn(async () => undefined);
    const runner = new NowcoderOperationsRunner({ create, close, handoff, wait,
      execute: async () => ({ kind: 'attention', code: 'LOGIN_REQUIRED', message: '请登录', submission: 'not_attempted' }) });
    expect(await runner.run(action)).toMatchObject({ kind: 'attention', tabUrl: action.url });
    expect(create).toHaveBeenCalledWith(action.url);
    expect(wait).toHaveBeenCalledWith(77);
    expect(handoff).toHaveBeenCalledWith(77, action.url);
    expect(close).not.toHaveBeenCalled();
    expect(runner.busy).toBe(false);
  });

  it('does not run a second operation while the first tab is active and always closes successful reads', async () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const close = vi.fn(async () => undefined);
    const runner = new NowcoderOperationsRunner({ create: async () => ({ id: 78 }), close, handoff: vi.fn(async () => undefined), wait: () => wait,
      execute: async () => ({ kind: 'context', snapshot: { sourceUrl: action.url, readAt: new Date().toISOString(),
        post: { title: '求方向', body: '项目不知道怎么做', images: [] }, comments: [], coverage: { total: 0, observed: 0, pagesRead: 1, hasMore: false, complete: true, limitations: [] } } }) });
    const first = runner.run(action);
    expect(runner.busy).toBe(true);
    expect(await runner.run(action)).toMatchObject({ kind: 'attention', code: 'OPERATIONS_BUSY', submission: 'not_attempted' });
    release(); await first;
    expect(close).toHaveBeenCalledWith(78);
  });
});
