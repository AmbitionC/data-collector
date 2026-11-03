import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const dirs = createTemporaryDirectoryTracker();
afterEach(() => dirs.cleanup());
const base = Date.parse('2026-10-31T09:00:00.000Z');
const sourceUrl = 'https://www.nowcoder.com/discuss/123456';
function event(at: number, extra: Record<string, unknown> = {}) {
  return { opportunityId: 'ops-abcdef123456', sourceUrl, publication: {
    key: `comment-key-${at}`, requestId: '12345678-1234-4234-8234-123456789012', draftHash: 'a'.repeat(64), requestedRevision: 3,
    state: 'published', createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString(), ...extra,
  } };
}
async function fixture(history: ReturnType<typeof event>[] = []) {
  const module = await import('../../packages/bridge/src/operations/publishingControl.js').catch(() => undefined);
  expect(module, 'durable publishing policy enforces cross-batch admission').toBeDefined();
  const root = await dirs.create('publishing-control-');
  const path = join(root, 'control.json'); let now = base;
  const make = () => new module!.NowcoderPublishingControl(path, async () => history, { now: () => now });
  return { path, history, control: make(), reopen: make, at: (value: number) => { now = value; } };
}

it('counts pre-upgrade journal attempts and enforces the interval across a restart', async () => {
  const c = await fixture([event(base)]); c.at(base + 10_000);
  await expect(c.control.assertCapacity()).rejects.toThrow(/间隔/u);
  expect(await c.reopen().status()).toMatchObject({ usage: { lastHour: 1, last24Hours: 1 }, nextAllowedAt: '2026-10-31T09:02:00.000Z' });
  c.at(base + 120_000); await expect(c.control.assertCapacity()).resolves.toBeUndefined();
});
it('enforces rolling hour capacity for a whole batch without resetting history on configuration', async () => {
  const c = await fixture([50, 40, 30, 20, 10].map(minutes => event(base - minutes * 60_000)));
  await expect(c.control.assertCapacity(1, true)).rejects.toThrow(/上限/u);
  expect(await c.control.status()).toMatchObject({ usage: { lastHour: 5 }, nextAllowedAt: '2026-10-31T09:10:00.000Z' });
  c.at(base + 10 * 60_000);
  await expect(c.control.assertCapacity(1, true)).resolves.toBeUndefined();
  await expect(c.control.assertCapacity(2, true)).rejects.toThrow(/09:20:00/u);
  await c.control.configure({ minIntervalMs: 120000, maxPerHour: 10, maxPer24Hours: 20 });
  expect((await c.reopen().status()).usage.last24Hours).toBe(5);
});
it('retains rolling 24-hour limits even when the policy file is first created after historical sends', async () => {
  const history = Array.from({ length: 20 }, (_, i) => event(base - 23 * 3600_000 - 45 * 60_000 + i * 3600_000));
  const c = await fixture(history);
  await expect(c.control.assertCapacity(1, true)).rejects.toThrow(/上限/u);
  expect(await c.reopen().status()).toMatchObject({ usage: { last24Hours: 20 }, nextAllowedAt: '2026-10-31T09:15:00.000Z' });
  c.at(base + 15 * 60_000); await expect(c.control.assertCapacity(1, true)).resolves.toBeUndefined();
});
it('fails closed for corrupt state or corrupt history instead of writing an empty allowance', async () => {
  const c = await fixture(); await writeFile(c.path, '{broken');
  await expect(c.control.status()).rejects.toThrow(/损坏/u);
  expect(await readFile(c.path, 'utf8')).toBe('{broken');
  const module = await import('../../packages/bridge/src/operations/publishingControl.js');
  const control = new module.NowcoderPublishingControl(join(await dirs.create('bad-history-'), 'state.json'), async () => { throw new Error('journal corrupt'); });
  await expect(control.assertCapacity()).rejects.toThrow(/记录|核对|不可用/u);
});
it('persists a verification pause; configuration and stale generation clears cannot remove it', async () => {
  const c = await fixture();
  const pause = await c.control.pause({ sourceUrl, opportunityId: 'ops-abcdef123456', key: 'pending-comment-key', requestId: '12345678-1234-4234-8234-123456789012' });
  await c.control.configure({ minIntervalMs: 120000, maxPerHour: 8, maxPer24Hours: 20 });
  expect((await c.reopen().status()).verification?.id).toBe(pause.id);
  await expect(c.reopen().assertCapacity()).rejects.toThrow(/验证/u);
  await expect(c.control.clearVerification('00000000-0000-4000-8000-000000000000')).rejects.toThrow(/变化/u);
  expect((await c.control.status()).verification?.id).toBe(pause.id);
  await c.control.clearVerification(pause.id); expect((await c.reopen().status()).verification).toBeNull();
});
it('does not drop future journal attempts when the system clock moves backwards', async () => {
  const c = await fixture([event(base + 300_000)]);
  await expect(c.control.assertCapacity()).rejects.toThrow(/间隔/u);
  expect(await c.control.status()).toMatchObject({ usage: { lastHour: 1 }, nextAllowedAt: '2026-10-31T09:07:00.000Z' });
});
it('restores an unresolved historical verification when no control file exists', async () => {
  const c = await fixture([event(base - 3600_000, { state: 'uncertain', attentionCode: 'VERIFICATION_REQUIRED', message: '牛客要求验证，请在保留的页面完成验证' })]);
  await expect(c.control.assertCapacity()).rejects.toThrow(/验证/u);
  expect((await c.control.status()).verification).toMatchObject({ sourceUrl, key: `comment-key-${base - 3600_000}` });
});
it('restores a pre-submit challenge even though its publication was safely rejected', async () => {
  const c = await fixture([event(base - 3600_000, { state: 'rejected', attentionCode: 'VERIFICATION_REQUIRED' })]);
  await expect(c.control.assertCapacity()).rejects.toThrow(/验证/u);
});
it('acknowledges the original exact journal when a resume observes a second challenge', async () => {
  const prior = event(base - 3600_000, { state: 'uncertain', attentionCode: 'VERIFICATION_REQUIRED' });
  const c = await fixture([prior]); await c.control.status();
  const pause = await c.control.pause({ sourceUrl, opportunityId: prior.opportunityId, key: prior.publication.key, requestId: '12345678-1234-4234-8234-123456789013' });
  await c.control.clearVerification(pause.id);
  expect((await c.reopen().status()).verification).toBeNull();
});
it('stops interval waiting when the reviewed context would expire and never waits through hard budgets', async () => {
  const c = await fixture([event(base)]);
  await expect(c.control.waitForSlot(new Date(base - 29 * 60000).toISOString())).rejects.toThrow(/有效期/u);
  await c.control.configure({ minIntervalMs: 120000, maxPerHour: 1, maxPer24Hours: 20 });
  await expect(c.control.waitForSlot(new Date(base).toISOString())).rejects.toThrow(/上限/u);
});
it('fails closed across restart when previously observed journals disappear or only some are lost', async () => {
  const c = await fixture([event(base - 300000), event(base - 600000, { requestId: '12345678-1234-4234-8234-123456789013' })]);
  await c.control.status(); c.history.splice(0, 1);
  await expect(c.reopen().assertCapacity()).rejects.toThrow(/历史|记录/u);
  c.history.splice(0); await expect(c.reopen().status()).rejects.toThrow(/历史|记录/u);
});

it('does not invent a future interval when the clock advances during an otherwise available snapshot', async () => {
  const { NowcoderPublishingControl } = await import('../../packages/bridge/src/operations/publishingControl.js');
  let clock = base;
  const control = new NowcoderPublishingControl(join(await dirs.create('advancing-status-'), 'control.json'), async () => [], { now: () => clock++ });
  expect(await control.status()).toMatchObject({ usage: { lastHour: 0, last24Hours: 0 }, nextAllowedAt: null });
});

it('admits a comment with no prior attempts even when successive clock reads advance by a millisecond', async () => {
  const { NowcoderPublishingControl } = await import('../../packages/bridge/src/operations/publishingControl.js');
  let clock = base;
  const control = new NowcoderPublishingControl(join(await dirs.create('advancing-admission-'), 'control.json'), async () => [], { now: () => clock++ });
  await expect(control.assertCapacity()).resolves.toBeUndefined();
});

it('evaluates article rolling-day usage at the same instant as its interval snapshot', async () => {
  const { NowcoderPublishingControl } = await import('../../packages/bridge/src/operations/publishingControl.js');
  const history = [{ ...event(base - 24 * 3600_000 + 1), opportunityId: 'article-abcdef123456', channel: 'article' as const, browser: 'chrome' as const, accountId: '544222414' }];
  let clock = base;
  const control = new NowcoderPublishingControl(join(await dirs.create('advancing-article-'), 'control.json'), async () => history, { now: () => clock++ });
  expect(await control.articleStatus()).toMatchObject({ usage: { last24Hours: 1 }, nextAllowedAt: null });
});

it('gives recovery the exact timestamp used by its publishing snapshot at a quota boundary', async () => {
  const { NowcoderPublishingControl } = await import('../../packages/bridge/src/operations/publishingControl.js');
  const { getNowcoderRecoveryAdvice } = await import('../../packages/bridge/src/operations/recovery.js');
  const history = [event(base - 3600_000 + 1), ...[10, 9, 8, 7].map(minutes => event(base - minutes * 60_000))];
  let clock = base;
  const control = new NowcoderPublishingControl(join(await dirs.create('recovery-clock-'), 'control.json'), async () => history, { now: () => clock++ });
  const snapshot = await control.recoverySnapshot();
  expect(snapshot).toMatchObject({ now: base, publishing: { usage: { lastHour: 5 }, nextAllowedAt: new Date(base + 1).toISOString() } });
  expect(getNowcoderRecoveryAdvice({ ...snapshot, attempt: 0,
    runtime: { connected: true, supported: true, buildMatches: true, busy: false, updating: false } })).toMatchObject({ status: 'waiting', code: 'PUBLISH_WAIT' });
});

it('does not create a publishing journal while reading a recovery snapshot', async () => {
  const c = await fixture([event(base - 300_000)]);
  expect((await c.control.recoverySnapshot()).publishing.usage.last24Hours).toBe(1);
  await expect(readFile(c.path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preserves paused journal bytes during recovery even when a new historical request is observed', async () => {
  const c = await fixture([event(base - 300_000)]);
  const verification = { id: '12345678-1234-4234-8234-123456789013', detectedAt: new Date(base).toISOString(), sourceUrl,
    requestId: '12345678-1234-4234-8234-123456789012', opportunityId: 'ops-abcdef123456', key: 'original-comment-key' };
  const bytes = JSON.stringify({ schemaVersion: 1, policy: { minIntervalMs: 120000, maxPerHour: 5, maxPer24Hours: 20 }, verification, knownRequestIds: [], clearedRequestIds: [] });
  await writeFile(c.path, bytes);
  expect((await c.control.recoverySnapshot()).publishing.verification).toEqual(verification);
  expect(await readFile(c.path, 'utf8')).toBe(bytes);
  expect((await c.control.status()).verification).toEqual(verification);
  expect(JSON.parse(await readFile(c.path, 'utf8')).knownRequestIds).toEqual([verification.requestId]);
});

it('reports legacy verification read-only and preserves its identity when normal migration subsequently persists it', async () => {
  const c = await fixture([event(base - 3600_000, { state: 'uncertain', attentionCode: 'VERIFICATION_REQUIRED' })]);
  const snapshot = await c.control.recoverySnapshot();
  expect(snapshot.publishing.verification?.requestId).toBe(c.history[0]!.publication.requestId);
  expect((await c.reopen().recoverySnapshot()).publishing.verification?.id).toBe(snapshot.publishing.verification?.id);
  await expect(readFile(c.path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await c.control.status()).verification?.id).toBe(snapshot.publishing.verification?.id);
  expect((await c.reopen().status()).verification?.id).toBe(snapshot.publishing.verification?.id);
  await expect(c.control.assertCapacity()).rejects.toThrow(/验证/u);
});
