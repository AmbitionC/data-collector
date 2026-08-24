import { describe, expect, it, vi } from 'vitest';
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
