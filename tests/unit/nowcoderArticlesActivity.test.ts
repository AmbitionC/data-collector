import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';
import { NowcoderArticlesStore } from '../../packages/bridge/src/articles/store.js';
import { PublicationAdmissionQueue } from '../../packages/bridge/src/operations/admission.js';
import { NowcoderPublishingControl } from '../../packages/bridge/src/operations/publishingControl.js';
const dirs = createTemporaryDirectoryTracker(); afterEach(() => dirs.cleanup());
const identity = () => ({ userId: '544222414', nickname: '测试账号', profileUrl: 'https://www.nowcoder.com/users/544222414', observedAt: new Date().toISOString() });
const draft = { schemaVersion: 1, title: '字节 Agent 全栈一面｜备考整理', body: '整理自不同公开记录，非本人经历\nAgent项目、SSE和并发题\nagent-journey.cn', browser: 'chrome', accountId: '544222414', provenance: 'compiled', sourceUrls: ['https://example.com/questions'] };
async function setup(execute?: (action: any) => Promise<any>) {
  const module = await import('../../packages/bridge/src/articles/activity.js').catch(() => undefined); expect(module, 'article activity is integrated').toBeDefined();
  const root = await dirs.create('article-activity-'); let store: NowcoderArticlesStore;
  const control = new NowcoderPublishingControl(join(root, 'control.json'), async () => (await store.list()).flatMap(e => e.publicationAttempts.map(publication => ({ opportunityId: e.id, sourceUrl: 'https://www.nowcoder.com/creation/write/article', channel: 'article' as const, browser: e.browser, accountId: e.accountId, publication }))));
  store = new NowcoderArticlesStore(join(root, 'articles'), { admission: new PublicationAdmissionQueue(), beforePublication: () => control.assertArticleCapacity(), afterPublication: async () => { await control.status(); } });
  const actions: string[] = [];
  const transport = { assertAvailable: vi.fn(), execute: vi.fn(async (action: any) => { actions.push(action.kind); return execute ? execute(action) : action.kind === 'account' ? { kind: 'account', identity: identity() } : { kind: 'article-published', receipt: { url: 'https://www.nowcoder.com/discuss/991001', title: draft.title, body: draft.body, accountId: draft.accountId, observedAt: new Date().toISOString() } }; }) };
  const activity = new module!.NowcoderArticlesActivity(store, transport, control), entry = await store.import(draft);
  const input = (e: any, key = 'authorized-article-key-001') => ({ revision: e.revision, contentHash: e.contentHash, key, browser: e.browser, accountId: e.accountId, send: true });
  return { root, store, control, transport, activity, entry, input, actions };
}
it('previews exact draft content with a live own-account probe and no remote draft action', async () => {
  const c = await setup(), result = await c.activity.preview(c.entry.id);
  expect(result.entry).toMatchObject({ id: c.entry.id, body: draft.body, preview: { identity: { userId: draft.accountId } } });
  expect(c.actions).toEqual(['account']);
});
it('refuses wrong bound browser/account and missing send before any site request', async () => {
  const c = await setup();
  await expect(c.activity.publish(c.entry.id, { ...c.input(c.entry), send: false })).rejects.toThrow();
  await expect(c.activity.publish(c.entry.id, { ...c.input(c.entry), accountId: '1' })).rejects.toThrow(/账号|绑定/u);
  expect(c.actions).toEqual([]);
});
it('does not journal a send when the actual account has changed since preview', async () => {
  const c = await setup(async () => ({ kind: 'account', identity: { ...identity(), userId: '1', profileUrl: 'https://www.nowcoder.com/users/1' } }));
  await c.store.savePreview(c.entry.id, identity());
  await expect(c.activity.publish(c.entry.id, c.input(c.entry))).rejects.toThrow(/账号/u);
  expect((await c.store.get(c.entry.id))!.publicationAttempts).toHaveLength(0);
  expect(c.actions).toEqual(['account']);
});
it('publishes once and original-key replay inspects the saved receipt without another account or send action', async () => {
  const c = await setup(), e = (await c.activity.preview(c.entry.id)).entry, input = c.input(e);
  expect(await c.activity.publish(e.id, input)).toMatchObject({ publication: { state: 'published', evidence: 'observed' }, receipt: { url: 'https://www.nowcoder.com/discuss/991001' } });
  const before = [...c.actions]; c.transport.assertAvailable.mockImplementation(() => { throw new Error('offline'); });
  expect(await c.activity.publish(e.id, input)).toMatchObject({ publication: { state: 'published' } });
  expect(c.actions).toEqual(before); expect(c.actions.filter(x => x === 'article-publish')).toHaveLength(1);
});
it('persists an uncertain interrupted submit, then only verifies its old key without resending', async () => {
  const c = await setup(async action => {
    if (action.kind === 'account') return { kind: 'account', identity: identity() };
    if (action.kind === 'article-publish') throw new Error('worker disconnected');
    return { kind: 'article-verified', identity: identity() };
  });
  const e = (await c.activity.preview(c.entry.id)).entry, input = c.input(e);
  expect(await c.activity.publish(e.id, input)).toMatchObject({ publication: { state: 'uncertain' } });
  expect(await c.activity.verify(e.id, input.key)).toMatchObject({ publication: { state: 'uncertain' } });
  expect(c.actions.filter(x => x === 'article-publish')).toHaveLength(1);
});
it('persists article verification globally and resumes by original-account readonly reconciliation', async () => {
  const c = await setup(async action => action.kind === 'account' ? { kind: 'account', identity: identity() } : action.kind === 'article-publish'
    ? { kind: 'attention', code: 'VERIFICATION_REQUIRED', message: '牛客要求验证', submission: 'uncertain' }
    : { kind: 'article-verified', identity: identity(), receipt: { url: 'https://www.nowcoder.com/discuss/991001', title: draft.title, body: draft.body, accountId: draft.accountId, observedAt: new Date().toISOString() } });
  const e = (await c.activity.preview(c.entry.id)).entry, input = c.input(e); await c.activity.publish(e.id, input);
  const pause = (await c.control.status()).verification!;
  expect(pause).toMatchObject({ channel: 'article', articleId: e.id, browser: 'chrome', accountId: draft.accountId });
  await expect(c.activity.resumeVerification({ id: randomUUID(), verificationCompleted: true })).rejects.toThrow(/变化/u);
  expect(await c.activity.resumeVerification({ id: pause.id, verificationCompleted: true })).toMatchObject({ status: { verification: null }, publication: { state: 'published' } });
  expect(c.actions.filter(x => x === 'article-publish')).toHaveLength(1); expect(c.actions.at(-1)).toBe('article-verify');
});
it('retains an article pause when readonly resume observes another account, even for a rejected attempt', async () => {
  const c = await setup(async action => action.kind === 'account' ? { kind: 'account', identity: identity() } : action.kind === 'article-publish'
    ? { kind: 'attention', code: 'VERIFICATION_REQUIRED', message: '验证发生在点击之前', submission: 'not_attempted' }
    : { kind: 'article-verified', identity: { ...identity(), userId: '1', profileUrl: 'https://www.nowcoder.com/users/1' } });
  const e = (await c.activity.preview(c.entry.id)).entry;
  await c.activity.publish(e.id, c.input(e));
  const pause = (await c.control.status()).verification!;
  await expect(c.activity.resumeVerification({ id: pause.id, verificationCompleted: true })).rejects.toThrow(/账号/u);
  expect((await c.control.status()).verification?.id).toBe(pause.id);
});
