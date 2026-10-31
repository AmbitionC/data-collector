import { randomUUID } from 'node:crypto';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';
import { NowcoderPublishingControl } from '../../packages/bridge/src/operations/publishingControl.js';
const dirs = createTemporaryDirectoryTracker(); afterEach(() => dirs.cleanup());
const content = { schemaVersion: 1, title: '字节 Agent 全栈一面｜备考整理', body: '来自不同公开记录的整理题单，非本人面试经历\n项目介绍与工具调用\nagent-journey.cn', browser: 'chrome', accountId: '544222414', provenance: 'compiled', sourceUrls: ['https://example.com/questions'] };
async function setup() {
  const module = await import('../../packages/bridge/src/articles/store.js').catch(() => undefined);
  expect(module, 'durable article journal is available').toBeDefined();
  const queue = await import('../../packages/bridge/src/operations/admission.js').catch(() => undefined); expect(queue).toBeDefined();
  const root = await dirs.create('article-store-'); let clock = Date.now(); let store: any;
  const control = new NowcoderPublishingControl(join(root, 'publishing.json'), async () => (await store.list()).flatMap((e: any) => e.publicationAttempts.map((publication: any) => ({ opportunityId: e.id, sourceUrl: 'https://www.nowcoder.com/creation/write/article', channel: 'article', browser: e.browser, accountId: e.accountId, publication }))), { now: () => clock });
  const options = { admission: new queue!.PublicationAdmissionQueue(), beforePublication: () => (control as any).assertArticleCapacity(), afterPublication: async () => { await control.status(); }, now: () => clock };
  store = new module!.NowcoderArticlesStore(join(root, 'articles'), options);
  const identity = () => ({ userId: content.accountId, nickname: '测试账号', profileUrl: `https://www.nowcoder.com/users/${content.accountId}`, observedAt: new Date(clock).toISOString() });
  async function draft(patch = {}) { const entry = await store.import({ ...content, ...patch }); return store.savePreview(entry.id, identity()); }
  const input = (e: any, key = `article-key-${randomUUID()}`) => ({ revision: e.revision, contentHash: e.contentHash, browser: e.browser, accountId: e.accountId, key, send: true });
  return { root, store, module: module!, control, options, draft, identity, input, at: (time: number) => { clock = time; } };
}
it('keeps a private identity-bound draft and requires a fresh matching account preview', async () => {
  const c = await setup(), entry = await c.store.import(content);
  await expect(c.store.beginPublication(entry.id, c.input(entry), randomUUID())).rejects.toThrow(/预览|账号/u);
  await expect(c.store.savePreview(entry.id, { ...c.identity(), userId: '1', profileUrl: 'https://www.nowcoder.com/users/1' })).rejects.toThrow(/账号/u);
  const prepared = await c.store.savePreview(entry.id, c.identity()); expect(prepared.contentHash).toBe(entry.contentHash);
  c.at(Date.now() + 31 * 60000);
  await expect(c.store.beginPublication(prepared.id, c.input(prepared), randomUUID())).rejects.toThrow(/过期|30分钟/u);
});
it('journal-first publication and original-key replay never dispatch twice, including after restart', async () => {
  const c = await setup(), e = await c.draft(), input = c.input(e);
  const begun = await c.store.beginPublication(e.id, input, randomUUID()); expect(begun.dispatch).toBe(true);
  expect(JSON.parse(await readFile(join(c.root, 'articles', `${e.id}.json`), 'utf8')).publicationAttempts[0].state).toBe('dispatching');
  expect((await c.store.beginPublication(e.id, input, randomUUID())).dispatch).toBe(false);
  const reopened = new c.module.NowcoderArticlesStore(join(c.root, 'articles'), c.options);
  expect((await reopened.beginPublication(e.id, input, randomUUID())).dispatch).toBe(false);
  await expect(reopened.beginPublication(e.id, { ...input, key: 'new-key-must-not-send' }, randomUUID())).rejects.toThrow(/核验|重复/u);
});
it('requires exact title, body, account and a real post link before marking observed', async () => {
  const c = await setup(), e = await c.draft(), input = c.input(e); await c.store.beginPublication(e.id, input, randomUUID());
  const receipt = { url: 'https://www.nowcoder.com/discuss/123456', title: e.title, body: e.body, accountId: e.accountId, observedAt: new Date().toISOString() };
  expect(await c.store.finishPublication(e.id, input.key, { kind: 'article-published', receipt: { ...receipt, accountId: '1' } })).toMatchObject({ state: 'uncertain' });
  expect(await c.store.reconcile(e.id, input.key, { kind: 'article-verified', identity: c.identity(), receipt })).toMatchObject({ state: 'published', evidence: 'observed', postUrl: receipt.url });
  expect((await c.store.get(e.id)).receipt).toEqual(receipt);
});
it('preserves word boundaries when matching observed article receipts', async () => {
  const c = await setup(), e = await c.draft({ body: '备考题单\nagent tool 怎么调用' }), input = c.input(e);
  await c.store.beginPublication(e.id, input, randomUUID());
  expect(await c.store.finishPublication(e.id, input.key, { kind: 'article-published', receipt: { url: 'https://www.nowcoder.com/discuss/123456', title: e.title, body: '备考题单\nagenttool 怎么调用', accountId: e.accountId, observedAt: new Date().toISOString() } })).toMatchObject({ state: 'uncertain' });
});
it('draft edits invalidate preview and stale revisions or reused content keys cannot overwrite', async () => {
  const c = await setup(), e = await c.draft();
  const changed = await c.store.import({ ...content, id: e.id, revision: e.revision, body: `${e.body}\n如何做幂等？` });
  expect(changed.preview).toBeUndefined(); expect(changed.contentHash).not.toBe(e.contentHash);
  await expect(c.store.import({ ...content, id: e.id, revision: e.revision })).rejects.toThrow(/修改|版本/u);
  await expect(c.store.beginPublication(changed.id, c.input(changed), randomUUID())).rejects.toThrow(/预览/u);
});
it('different article records share the daily budget and cannot evade it by changing account', async () => {
  const c = await setup(), e = await c.draft(), first = c.input(e); await c.store.beginPublication(e.id, first, randomUUID());
  await c.store.finishPublication(e.id, first.key, { kind: 'attention', code: 'NO_RECEIPT', message: '待核验', submission: 'uncertain' });
  const other = await c.store.import({ ...content, title: '另一个题单', accountId: '12345' });
  await c.store.savePreview(other.id, { ...c.identity(), userId: '12345', profileUrl: 'https://www.nowcoder.com/users/12345' });
  c.at(Date.now() + 121000);
  await expect(c.store.beginPublication(other.id, c.input(other), randomUUID())).rejects.toThrow(/24小时|上限/u);
  expect((await c.store.get(other.id)).publicationAttempts).toHaveLength(0);
});
it('rejects corrupted or tampered records and leaves them unchanged', async () => {
  const c = await setup(), e = await c.draft(), path = join(c.root, 'articles', `${e.id}.json`);
  const raw = JSON.parse(await readFile(path, 'utf8')); raw.body += '已被修改'; await writeFile(path, JSON.stringify(raw));
  await expect(c.store.get(e.id)).rejects.toThrow(/损坏|核对/u);
  expect(JSON.parse(await readFile(path, 'utf8')).body).toBe(raw.body);
});
