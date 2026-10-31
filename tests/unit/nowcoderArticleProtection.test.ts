import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { NowcoderPublishingControl } from '../../packages/bridge/src/operations/publishingControl.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';
const dirs = createTemporaryDirectoryTracker(); afterEach(() => dirs.cleanup());
it('fences publication synchronously when a challenge is observed while status I/O is queued', async () => {
  const root = await dirs.create('pause-latch-'); let release!: () => void;
  const control = new NowcoderPublishingControl(join(root, 'control.json'), async () => { await new Promise<void>(r => { release = r; }); return []; });
  const read = control.status(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const pause = control.pause({ requestId: randomUUID(), sourceUrl: 'https://www.nowcoder.com/discuss/123456' });
  const immediate = control.verificationPending;
  release();
  // Subsequent reads should not stall this synthetic history source.
  const releaseQueued = setInterval(() => release(), 1);
  try { await read; await pause; expect(immediate).toBe(true); } finally { clearInterval(releaseQueued); }
});
const base = Date.parse('2026-10-31T16:00:00.000Z');
function event(at: number, article = false, extra: Record<string, unknown> = {}) {
  return { opportunityId: article ? 'article-abcdef123456' : 'ops-abcdef123456', sourceUrl: article ? 'https://www.nowcoder.com/creation/write/article' : 'https://www.nowcoder.com/discuss/123456',
    ...(article ? { channel: 'article', browser: 'chrome', accountId: '544222414' } : {}),
    publication: { key: `publish-key-${at}`, requestId: randomUUID(), draftHash: 'a'.repeat(64), requestedRevision: 1, state: 'published', createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString(), ...extra } };
}
async function setup(history: any[] = []) {
  const root = await dirs.create('article-protection-'); let clock = base;
  const control = new NowcoderPublishingControl(join(root, 'control.json'), async () => history, { now: () => clock });
  return { root, control, history, at: (value: number) => { clock = value; } };
}
it('keeps article and comment budgets separate while both share the minimum interval', async () => {
  const c = await setup(Array.from({ length: 20 }, (_, i) => event(base - 2 * 3600000 - i * 1000)));
  expect(typeof (c.control as any).assertArticleCapacity).toBe('function');
  await (c.control as any).assertArticleCapacity();
  await expect(c.control.assertCapacity()).rejects.toThrow(/上限/u);
  c.history.push(event(base, true));
  expect((await c.control.status()).usage.last24Hours).toBe(20);
  await expect((c.control as any).assertArticleCapacity()).rejects.toThrow(/24小时|上限/u);
  c.at(base + 24 * 3600000); await (c.control as any).assertArticleCapacity();
});
it('an article attempt blocks a fresh comment until the common interval expires', async () => {
  const c = await setup([event(base, true)]);
  await expect(c.control.assertCapacity()).rejects.toThrow(/间隔/u);
  c.at(base + 120000); await expect(c.control.assertCapacity()).resolves.toBeUndefined();
  expect((await c.control.status()).usage.last24Hours).toBe(0);
});
it('restores an article challenge with its exact owner and prevents a stale or partial resume clear', async () => {
  const e = event(base - 3600000, true, { state: 'uncertain', attentionCode: 'VERIFICATION_REQUIRED' });
  const c = await setup([e]);
  const pause = (await c.control.status()).verification!;
  expect(pause).toMatchObject({ channel: 'article', articleId: e.opportunityId, browser: 'chrome', accountId: '544222414' });
  await expect(c.control.assertCapacity()).rejects.toThrow(/验证/u);
  const newer = await c.control.pause({ channel: 'article', articleId: e.opportunityId, sourceUrl: e.sourceUrl, browser: 'chrome', accountId: '544222414', key: e.publication.key, requestId: randomUUID() } as any);
  await expect(c.control.clearVerification(pause.id)).rejects.toThrow(/变化/u);
  await c.control.clearVerification(newer.id); expect((await c.control.status()).verification).toBeNull();
});
it('detects lost article history after its request has been durably observed', async () => {
  const c = await setup([event(base - 3600000, true)]); await c.control.status();
  c.history.splice(0); await expect(c.control.assertCapacity()).rejects.toThrow(/历史|记录/u);
});
