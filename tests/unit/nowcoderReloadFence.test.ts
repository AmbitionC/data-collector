import { describe, expect, it, vi } from 'vitest';
import { commitAutoReload, type UpdateSignal } from '../../packages/extension/src/background/autoReload.js';
describe('final auto-reload fence', () => {
  it('defers a reload when publication starts during persistence and preserves the later retry', async () => {
    const initial: UpdateSignal = { builtBuildId: 'new-build', runningBuildId: 'old-build' };
    let busy = false;
    const reload = vi.fn(), restore = vi.fn(async () => undefined);
    const deps = { remember: vi.fn(async () => { busy = true; }), restore, reload,
      latest: async () => ({ ...initial, busy, triedBuildId: 'new-build' }) };
    expect(await commitAutoReload(initial, deps)).toBe(false);
    expect(restore).toHaveBeenCalledWith(undefined);
    expect(reload).not.toHaveBeenCalled();
    busy = false; deps.remember.mockImplementation(async () => undefined);
    expect(await commitAutoReload(initial, deps)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
