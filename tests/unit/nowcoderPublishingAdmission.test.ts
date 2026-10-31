import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { stableContentId, type NowcoderConversationSnapshot } from '@data-collector/shared';
import { NowcoderOperationsStore } from '../../packages/bridge/src/operations/store.js';
import { NowcoderOperationsActivity } from '../../packages/bridge/src/operations/activity.js';
import { NowcoderPublishingControl } from '../../packages/bridge/src/operations/publishingControl.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';
const dirs = createTemporaryDirectoryTracker();
afterEach(() => dirs.cleanup());
async function fixture() {
  const root = await dirs.create('publish-admission-'), ops = join(root, 'ops'); await mkdir(ops);
  let store: NowcoderOperationsStore;
  const control = new NowcoderPublishingControl(join(root, 'control.json'), async () =>
    (await store.list()).flatMap(e => (e.publicationAttempts ?? []).map(publication => ({ opportunityId: e.id, sourceUrl: e.canonicalUrl, publication }))));
  store = new NowcoderOperationsStore(ops, root, { beforePublication: () => control.assertCapacity(), afterPublication: async () => { await control.status(); } });
  async function seed(n: number) {
    const url = `https://www.nowcoder.com/discuss/${n}`, id = `ops-${stableContentId(url)}`, now = new Date().toISOString(), title = 'Agent 项目求助', body = '学习 LangGraph，下一步想做一个实际项目';
    await writeFile(join(ops, `${id}.json`), JSON.stringify({ schemaVersion: 1, visibility: 'private', id, sourceId: stableContentId(url), canonicalUrl: url, title, body, contextHash: createHash('sha256').update(`${title}\n${body}`).digest('hex'), collectedAt: now, createdAt: now, updatedAt: now, revision: 1, status: 'queued', assessment: { fit: 'high', intent: 'learning', angle: '', reason: '', limitations: [] }, note: '' }));
    const snapshot: NowcoderConversationSnapshot = { sourceUrl: url, readAt: now, post: { title, body, images: [] }, comments: [], coverage: { total: 0, observed: 0, pagesRead: 1, hasMore: false, complete: true, limitations: [] } };
    const saved = await store.saveConversation(id, snapshot);
    const entry = await store.update(id, { revision: saved.revision, contextHash: saved.contextHash, conversationHash: saved.conversation!.hash, drafts: { primary: '先做一个能用的小项目', alternative: '拿自己的资料试一遍', tone: 'contextual', anchor: 'LangGraph', notes: '' } });
    const input = { revision: entry.revision, contextHash: entry.contextHash, key: `publish-admission-${n}`, send: true as const };
    return { id, url, snapshot, entry, input };
  }
  return { root, store, control, seed };
}
it('admits only one of concurrent different-post attempts before either transport can send', async () => {
  const c = await fixture(), a = await c.seed(123456), b = await c.seed(234567);
  const results = await Promise.allSettled([
    c.store.beginPublication(a.id, a.input, '12345678-1234-4234-8234-123456789012'),
    c.store.beginPublication(b.id, b.input, '12345678-1234-4234-8234-123456789013'),
  ]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect((await c.store.list()).flatMap(e => e.publicationAttempts ?? [])).toHaveLength(1);
  expect((await c.control.status()).usage.lastHour).toBe(1);
});
it('allows readonly original-key replay while paused but no new source or key', async () => {
  const c = await fixture(), a = await c.seed(123456), b = await c.seed(234567);
  await c.store.beginPublication(a.id, a.input, '12345678-1234-4234-8234-123456789012');
  await c.control.pause({ sourceUrl: a.url, opportunityId: a.id, key: a.input.key, requestId: '12345678-1234-4234-8234-123456789012' });
  expect(await c.store.beginPublication(a.id, a.input, '12345678-1234-4234-8234-123456789013')).toMatchObject({ dispatch: false });
  await expect(c.store.beginPublication(b.id, b.input, '12345678-1234-4234-8234-123456789014')).rejects.toThrow(/验证/u);
  expect((await c.store.get(b.id))?.publicationAttempts).toBeUndefined();
});
it('persists a page challenge globally and resumes by readonly original-key reconciliation', async () => {
  const c = await fixture(), a = await c.seed(123456); const actions: string[] = [];
  const activity = new NowcoderOperationsActivity(c.store, { assertAvailable() {}, async execute(action) {
    actions.push(action.kind);
    if (action.kind === 'publish') return { kind: 'attention', code: 'VERIFICATION_REQUIRED', message: '牛客要求验证，请在保留的页面完成验证', submission: 'uncertain' };
    return { kind: 'context', snapshot: { ...a.snapshot, comments: [{ url: 'https://www.nowcoder.com/discuss/comment/778899', parentUrl: null, text: a.entry.drafts!.primary, images: [], isAuthor: false, likes: null }], coverage: { ...a.snapshot.coverage, total: 1, observed: 1 } } };
  } }, fetch, c.control);
  expect(await activity.publish(a.id, a.input)).toMatchObject({ publication: { state: 'uncertain' } });
  const pause = (await c.control.status()).verification!; expect(pause).toBeTruthy();
  const result = await activity.resumeVerification({ id: pause.id, verificationCompleted: true });
  expect(result).toMatchObject({ status: { verification: null }, publication: { state: 'published', replyUrl: 'https://www.nowcoder.com/discuss/comment/778899' } });
  expect(actions).toEqual(['publish', 'context']);
  expect((await c.store.get(a.id))?.publicationAttempts).toHaveLength(1);
});
it('cannot clear a newer challenge with an older in-flight resume request', async () => {
  const c = await fixture(), a = await c.seed(123456);
  const old = await c.control.pause({ sourceUrl: a.url, opportunityId: a.id, requestId: '12345678-1234-4234-8234-123456789012' });
  let finish!: () => void;
  const activity = new NowcoderOperationsActivity(c.store, { assertAvailable() {}, async execute() { await new Promise<void>(r => { finish = r; }); return { kind: 'context', snapshot: a.snapshot }; } }, fetch, c.control);
  const pending = activity.resumeVerification({ id: old.id, verificationCompleted: true });
  const rejected = expect(pending).rejects.toThrow(/变化/u);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const newer = await c.control.pause({ sourceUrl: a.url, requestId: '12345678-1234-4234-8234-123456789013' });
  finish(); await rejected;
  expect((await c.control.status()).verification?.id).toBe(newer.id);
});
it('retains a pre-submit challenge in its original journal if global pause persistence fails', async () => {
  const c = await fixture(), a = await c.seed(123456), path = join(c.root, 'control.json');
  const activity = new NowcoderOperationsActivity(c.store, { assertAvailable() {}, async execute() {
    await rm(path); await mkdir(path);
    return { kind: 'attention', code: 'VERIFICATION_REQUIRED', message: '牛客要求验证', submission: 'not_attempted' };
  } }, fetch, c.control);
  await expect(activity.publish(a.id, a.input)).rejects.toThrow(/损坏/u);
  expect((await c.store.get(a.id))!.publicationAttempts?.[0]).toMatchObject({ state: 'rejected', attentionCode: 'VERIFICATION_REQUIRED' });
  await rm(path, { recursive: true });
  const reopened = new NowcoderPublishingControl(path, async () => (await c.store.list()).flatMap(e => (e.publicationAttempts ?? []).map(publication => ({ opportunityId: e.id, sourceUrl: e.canonicalUrl, publication }))));
  await expect(reopened.assertCapacity()).rejects.toThrow(/验证/u);
});
it('does not reach transport when durable history acknowledgement fails after journaling', async () => {
  const c = await fixture(), a = await c.seed(123456);
  const store = new NowcoderOperationsStore(join(c.root, 'ops'), c.root, { beforePublication: () => c.control.assertCapacity(), afterPublication: async () => { throw new Error('history marker write failed'); } });
  const execute = vi.fn();
  const activity = new NowcoderOperationsActivity(store, { assertAvailable() {}, execute }, fetch, c.control);
  await expect(activity.publish(a.id, a.input)).rejects.toThrow(/history marker/u);
  expect(execute).not.toHaveBeenCalled();
  expect((await store.get(a.id))!.publicationAttempts).toMatchObject([{ key: a.input.key, state: 'dispatching' }]);
});
it('a verification pause established after admission still fences the final transport dispatch', async () => {
  const c = await fixture(), a = await c.seed(123456); let finish!: () => void;
  const store = new NowcoderOperationsStore(join(c.root, 'ops'), c.root, { beforePublication: () => c.control.assertCapacity(), afterPublication: async () => {
    await c.control.status(); await new Promise<void>(resolve => { finish = resolve; });
  } });
  const execute = vi.fn(async () => { throw new Error('must never submit'); });
  const activity = new NowcoderOperationsActivity(store, { assertAvailable() {}, execute }, fetch, c.control);
  const pending = activity.publish(a.id, a.input);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const pause = await c.control.pause({ sourceUrl: a.url, requestId: '12345678-1234-4234-8234-123456789099' });
  finish(); const result = await pending;
  expect(execute).not.toHaveBeenCalled();
  expect(result).toMatchObject({ publication: { state: 'rejected' }, attention: { code: 'PUBLISH_VERIFICATION_PAUSED', submission: 'not_attempted' } });
  expect((await c.control.status()).verification?.id).toBe(pause.id);
});
