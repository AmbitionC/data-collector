import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NOWCODER_COMPANIES } from '../../packages/bridge/src/plans/nowcoderPlan.js';
import { NowcoderScheduleStore } from '../../packages/bridge/src/plans/nowcoderSchedule.js';
import type { CompanyInventory } from '../../packages/bridge/src/plans/nowcoderInventory.js';

const roots: string[] = [];
async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nowcoder-schedule-'));
  roots.push(root);
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function stock(): CompanyInventory {
  return {
    bytedance: { published: 51, qualifiedPending: 0 },
    tencent: { published: 10, qualifiedPending: 0 },
    alibaba: { published: 8, qualifiedPending: 0 },
    ant: { published: 6, qualifiedPending: 0 },
    other: { published: 20, qualifiedPending: 0 },
  };
}

describe('review-only Nowcoder schedule settings and ordering', () => {
  it('defaults disabled with all known companies and cannot mutate through returned settings', async () => {
    const store = await NowcoderScheduleStore.open(join(await temporary(), 'schedule.json'));
    expect(store.settings()).toEqual({ enabled: false, companies: [...NOWCODER_COMPANIES], reviewOnly: true });
    store.settings().companies.splice(0);
    expect(store.settings().companies).toHaveLength(5);
  });

  it('persists an explicit strictly validated configuration', async () => {
    const path = join(await temporary(), 'schedule.json');
    const store = await NowcoderScheduleStore.open(path);
    const config = { enabled: true, companies: ['ant', 'tencent'], reviewOnly: true };
    await store.configure(config);
    expect((await NowcoderScheduleStore.open(path)).settings()).toEqual(config);
    for (const invalid of [
      { ...config, companies: ['unknown'] }, { ...config, companies: [] },
      { ...config, companies: ['ant', 'ant'] }, { ...config, reviewOnly: false },
      { ...config, enabled: 'true' }, { ...config, deliver: true }, { companies: ['ant'], reviewOnly: true },
    ]) await expect(store.configure(invalid)).rejects.toThrow();
    expect(store.settings()).toEqual(config);
  });

  it('prioritizes published plus qualified pending instead of published stock alone', async () => {
    const store = await NowcoderScheduleStore.open(join(await temporary(), 'schedule.json'));
    const inventory = stock();
    inventory.ant.qualifiedPending = 5;
    expect(await store.prioritize(inventory)).toEqual(['alibaba', 'tencent', 'ant', 'other', 'bytedance']);
    expect(await store.prioritize(inventory, ['bytedance', 'tencent'])).toEqual(['tencent', 'bytedance']);
  });

  it('rotates equal-stock companies across reopen and leaves lower stock first', async () => {
    const path = join(await temporary(), 'schedule.json');
    const inventory = stock();
    inventory.ant.published = 10;
    let store = await NowcoderScheduleStore.open(path);
    await store.configure({ enabled: false, companies: ['tencent', 'ant', 'bytedance'], reviewOnly: true });
    expect(await store.prioritize(inventory)).toEqual(['tencent', 'ant', 'bytedance']);
    store = await NowcoderScheduleStore.open(path);
    expect(await store.prioritize(inventory)).toEqual(['ant', 'tencent', 'bytedance']);
    store = await NowcoderScheduleStore.open(path);
    expect(await store.prioritize(inventory)).toEqual(['tencent', 'ant', 'bytedance']);
  });

  it('serializes configuration and rotation even when two instances share a path', async () => {
    const path = join(await temporary(), 'schedule.json');
    const first = await NowcoderScheduleStore.open(path);
    const second = await NowcoderScheduleStore.open(path);
    const inventory = stock();
    inventory.ant.published = 10;
    const config = { enabled: true, companies: ['tencent', 'ant'], reviewOnly: true };
    const [left, , right] = await Promise.all([
      first.prioritize(inventory, ['tencent', 'ant']), second.configure(config),
      second.prioritize(inventory, ['tencent', 'ant']),
    ]);
    expect(left).toEqual(['tencent', 'ant']);
    expect(right).toEqual(['ant', 'tencent']);
    expect((await NowcoderScheduleStore.open(path)).settings()).toEqual(config);
  });

  it('does not advance in-memory rotation or configuration after an atomic write fails', async () => {
    const root = await temporary();
    const directory = join(root, 'state');
    await mkdir(directory);
    const path = join(directory, 'schedule.json');
    const store = await NowcoderScheduleStore.open(path);
    await store.configure({ enabled: false, companies: ['tencent', 'ant'], reviewOnly: true });
    const before = await readFile(path, 'utf8');
    const backup = join(root, 'backup');
    await rename(directory, backup);
    await writeFile(directory, 'blocked parent');
    await expect(store.configure({ enabled: true, companies: ['ant'], reviewOnly: true })).rejects.toThrow();
    await expect(store.prioritize(stock())).rejects.toThrow();
    expect(store.settings().enabled).toBe(false);
    await rm(directory);
    await rename(backup, directory);
    expect(await readFile(path, 'utf8')).toBe(before);
    const equal = stock(); equal.ant.published = 10;
    expect(await store.prioritize(equal)).toEqual(['tencent', 'ant']);
  });

  it('rejects invalid state and invalid configured inventory without rotation', async () => {
    const path = join(await temporary(), 'schedule.json');
    await writeFile(path, '{bad');
    await expect(NowcoderScheduleStore.open(path)).rejects.toThrow();
    await rm(path);
    const store = await NowcoderScheduleStore.open(path);
    for (const invalid of [
      { ...stock(), ant: undefined },
      { ...stock(), ant: { published: -1, qualifiedPending: 0 } },
      { ...stock(), ant: { published: 1, qualifiedPending: Number.NaN } },
      { ...stock(), ant: { published: 1, qualifiedPending: 0.5 } },
    ]) await expect(store.prioritize(invalid as CompanyInventory)).rejects.toThrow(/inventory/i);
    await expect(store.prioritize(stock(), ['ant', 'ant'])).rejects.toThrow();
  });
});
