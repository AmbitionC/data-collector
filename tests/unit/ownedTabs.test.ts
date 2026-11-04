import { describe, expect, it, vi } from 'vitest';
import { NowcoderOperationsRunner } from '../../packages/extension/src/background/nowcoderOperations.js';
import {
  OWNED_TABS_STORAGE_KEY,
  OwnedTabRegistry,
  type OwnedTabsStorage,
} from '../../packages/extension/src/background/ownedTabs.js';

class MemorySessionStorage implements OwnedTabsStorage {
  values: Record<string, unknown> = {};

  async get(): Promise<Record<string, unknown>> {
    return structuredClone(this.values);
  }

  async set(values: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, structuredClone(values));
  }
}

describe('owned browser tabs', () => {
  it('preserves an uncertain original page across worker restart when its handoff storage read never completes', async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemorySessionStorage(), remove = vi.fn(async () => undefined);
      const registry = new OwnedTabRegistry(storage, { remove });
      const url = 'https://www.nowcoder.com/discuss/77';
      await registry.track({ id: 77, url }, 'nowcoder-operations');
      await registry.track({ id: 78, url: 'https://www.nowcoder.com/discuss/78' }, 'remote-job');
      await registry.track({ id: 79, url: 'https://wx.zsxq.com/group/1' }, 'zsxq-plan');
      await registry.track({ id: 80, url: 'https://articles.zsxq.com/a.html' }, 'linked-article');
      const get = storage.get.bind(storage); let stalled = false, executionId = '';
      storage.get = () => stalled ? new Promise(() => undefined) : get();
      const runner = new NowcoderOperationsRunner({ create: async () => ({ id: 77 }), wait: async () => undefined,
        execute: async (_id, _action, nonce) => { executionId = nonce; throw new Error('Lost after click'); },
        readProgress: async () => ({ executionId, actionKind: 'publish', url, pageStage: 'wait_receipt',
          diagnostics: { pageStartedAt: '2026-11-04T12:01:04.257Z', submitClickedAt: '2026-11-04T12:01:10.553Z' } }),
        close: id => registry.close(id), handoff: (id, source) => { stalled = true; return registry.handoff(id, source, { preservePrevious: true }); } });
      const pending = runner.run({ kind: 'publish', url, text: '先做一个项目', expected: { sourceUrl: url,
        readAt: '2026-11-04T12:00:00.000Z', post: { title: '项目', body: '讨论项目', images: [] }, comments: [],
        coverage: { total: 0, observed: 0, pagesRead: 1, hasMore: false, complete: true, limitations: [] } } });
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toMatchObject({ submission: 'uncertain', failure: { clickState: 'invoked' } });
      expect(runner.busy).toBe(false);
      // A fresh registry represents a worker restart, without the abandoned queue.
      stalled = false;
      await new OwnedTabRegistry(storage, { remove }).cleanupStale();
      expect(remove.mock.calls.map(([id]) => id)).toEqual([78, 79, 80]);
      expect(storage.values[OWNED_TABS_STORAGE_KEY]).toMatchObject({ owned: [], attention: { id: 77, preserve: true } });
    } finally { vi.useRealTimers(); }
  });

  it('still closes successful operation pages normally and leaves an earlier attention page intact during recovery', async () => {
    const storage = new MemorySessionStorage(), remove = vi.fn(async () => undefined);
    const registry = new OwnedTabRegistry(storage, { remove });
    await registry.track({ id: 83, url: 'https://www.nowcoder.com/discuss/83' }, 'nowcoder-operations');
    await registry.close(83);
    await registry.track({ id: 84, url: 'https://www.nowcoder.com/discuss/84' }, 'nowcoder-operations');
    await registry.handoff(84, 'https://www.nowcoder.com/discuss/84', { preservePrevious: true });
    await registry.track({ id: 85, url: 'https://www.nowcoder.com/discuss/85' }, 'nowcoder-operations');
    await new OwnedTabRegistry(storage, { remove }).cleanupStale();
    expect(remove.mock.calls.map(([id]) => id)).toEqual([83]);
    expect(storage.values[OWNED_TABS_STORAGE_KEY]).toMatchObject({ owned: [], attention: { id: 84, preserve: true } });
  });
  it('preserves operation handoffs and earlier user work when another attention tab is handed off', async () => {
    const storage = new MemorySessionStorage(), remove = vi.fn(async () => undefined);
    const registry = new OwnedTabRegistry(storage, { remove });
    await registry.track({ id: 60, url: 'https://www.nowcoder.com/discuss/60' }, 'nowcoder-operations');
    await registry.handoff(60, 'https://www.nowcoder.com/discuss/60', { preservePrevious: true });
    await registry.track({ id: 61, url: 'https://www.nowcoder.com/discuss/61' }, 'nowcoder-operations');
    await registry.handoff(61, 'https://www.nowcoder.com/discuss/61', { preservePrevious: true });
    await registry.track({ id: 62, url: 'https://wx.zsxq.com/login' }, 'zsxq-plan');
    await registry.handoff(62, 'https://wx.zsxq.com/login');
    await registry.cleanupStale();
    expect(remove).not.toHaveBeenCalled();
  });
  it('persists created tabs and closes every stale owned tab after worker recovery', async () => {
    const storage = new MemorySessionStorage();
    const remove = vi.fn(async () => undefined);
    const registry = new OwnedTabRegistry(storage, { remove }, () => 1_000);
    await registry.track({ id: 10, url: 'https://www.nowcoder.com/discuss/10' }, 'remote-job');
    await registry.track({ id: 11, url: 'https://articles.zsxq.com/a.html' }, 'linked-article');

    expect(storage.values[OWNED_TABS_STORAGE_KEY]).toMatchObject({
      owned: [{ id: 10 }, { id: 11 }],
    });

    await registry.cleanupStale();

    expect(remove.mock.calls.map(([id]) => id)).toEqual([10, 11]);
    expect(storage.values[OWNED_TABS_STORAGE_KEY]).toMatchObject({ owned: [] });
  });

  it('hands off one authentication tab, excludes it from stale cleanup, and replaces the prior handoff', async () => {
    const storage = new MemorySessionStorage();
    const remove = vi.fn(async () => undefined);
    const registry = new OwnedTabRegistry(storage, { remove }, () => 2_000);
    await registry.track({ id: 20, url: 'https://wx.zsxq.com/login' }, 'zsxq-plan');
    await registry.handoff(20, 'https://wx.zsxq.com/login');
    await registry.cleanupStale();
    expect(remove).not.toHaveBeenCalled();

    await registry.track({ id: 21, url: 'https://wx.zsxq.com/login-again' }, 'remote-job');
    await registry.handoff(21, 'https://wx.zsxq.com/login-again');

    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith(20);
    expect(storage.values[OWNED_TABS_STORAGE_KEY]).toMatchObject({
      owned: [],
      attention: { id: 21, url: 'https://wx.zsxq.com/login-again' },
    });
  });

  it('unregisters a normally closed tab even when Chrome already removed it', async () => {
    const storage = new MemorySessionStorage();
    const registry = new OwnedTabRegistry(
      storage,
      { remove: async () => { throw new Error('No tab with id'); } },
      () => 3_000,
    );
    await registry.track({ id: 30, url: 'https://mp.weixin.qq.com/s/x' }, 'remote-job');

    await expect(registry.close(30)).resolves.toBeUndefined();
    expect(storage.values[OWNED_TABS_STORAGE_KEY]).toMatchObject({ owned: [] });
  });

  it('retains ownership when physical removal fails and forgets only after a later success', async () => {
    const storage = new MemorySessionStorage();
    const remove = vi.fn()
      .mockRejectedValueOnce(new Error('Tabs cannot be edited right now'))
      .mockResolvedValueOnce(undefined);
    const registry = new OwnedTabRegistry(storage, { remove }, () => 3_100);
    await registry.track({ id: 31, url: 'https://www.nowcoder.com/discuss/31' }, 'remote-job');

    await expect(registry.close(31)).rejects.toThrow('Tabs cannot be edited right now');
    expect(storage.values[OWNED_TABS_STORAGE_KEY]).toMatchObject({ owned: [{ id: 31 }] });

    await expect(registry.close(31)).resolves.toBeUndefined();
    expect(storage.values[OWNED_TABS_STORAGE_KEY]).toMatchObject({ owned: [] });
  });

  it('persists partial stale cleanup and retains every tab whose removal was not proven', async () => {
    const storage = new MemorySessionStorage();
    const remove = vi.fn(async (id: number) => {
      if (id === 51) throw new Error('Chrome is busy');
      if (id === 52) throw new Error('No tab with id: 52');
    });
    const registry = new OwnedTabRegistry(storage, { remove }, () => 3_200);
    await registry.track({ id: 50, url: 'https://www.nowcoder.com/discuss/50' }, 'remote-job');
    await registry.track({ id: 51, url: 'https://www.nowcoder.com/discuss/51' }, 'remote-job');
    await registry.track({ id: 52, url: 'https://www.nowcoder.com/discuss/52' }, 'remote-job');

    await expect(registry.cleanupStale()).rejects.toThrow('Chrome is busy');
    expect(remove.mock.calls.map(([id]) => id)).toEqual([50, 51, 52]);
    expect(storage.values[OWNED_TABS_STORAGE_KEY]).toMatchObject({ owned: [{ id: 51 }] });
  });

  it('best-effort closes a newly created tab when session tracking cannot be persisted', async () => {
    const persistenceError = new Error('session storage unavailable');
    const storage: OwnedTabsStorage = {
      get: async () => ({}),
      set: async () => { throw persistenceError; },
    };
    const remove = vi.fn(async () => { throw new Error('tab already disappeared'); });
    const registry = new OwnedTabRegistry(storage, { remove }, () => 4_000);

    await expect(registry.track(
      { id: 40, url: 'https://wx.zsxq.com/group/48844584441158' },
      'zsxq-plan',
    )).rejects.toBe(persistenceError);
    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith(40);
  });
});
