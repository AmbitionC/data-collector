import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stableContentId, type NowcoderConversationSnapshot } from '@data-collector/shared';
import { NowcoderOperationsStore } from '../../packages/bridge/src/operations/store.js';
import { NowcoderOperationsActivity } from '../../packages/bridge/src/operations/activity.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';
const directories = createTemporaryDirectoryTracker();
afterEach(() => directories.cleanup());
const url = 'https://www.nowcoder.com/discuss/123456', title = '求 Agent 学习方向', body = '学过 LangGraph，想做一个能用的项目';
const snapshot: NowcoderConversationSnapshot = { sourceUrl: url, readAt: new Date().toISOString(), post: { title, body, images: [] }, comments: [],
  coverage: { total: 0, observed: 0, pagesRead: 1, hasMore: false, complete: true, limitations: [] } };
async function fixture() {
  const root = await directories.create('nowcoder-operation-activity-'), id = `ops-${stableContentId(url)}`;
  await writeFile(join(root, `${id}.json`), JSON.stringify({ schemaVersion: 1, visibility: 'private', id, sourceId: stableContentId(url), canonicalUrl: url, title, body,
    contextHash: createHash('sha256').update(`${title}\n${body}`).digest('hex'), collectedAt: snapshot.readAt, createdAt: snapshot.readAt, updatedAt: snapshot.readAt,
    revision: 1, status: 'queued', assessment: { fit: 'high', intent: 'learning', angle: '', reason: '求方向', limitations: [] }, note: '' }));
  const store = new NowcoderOperationsStore(root, root);
  return { root, id, store };
}
async function drafted(store: NowcoderOperationsStore, id: string) {
  const entry = await store.get(id);
  return store.update(id, { revision: entry!.revision, contextHash: entry!.contextHash, conversationHash: entry!.conversation!.hash,
    drafts: { primary: '先做一个同事能用的工具呗', alternative: '文档问答可以先从自己的资料试起', tone: 'practical', anchor: 'LangGraph', notes: '' } });
}
describe('durable plugin publication workflow', () => {
  it('persists context and a dispatch fence before calling the extension, and repeated keys never send twice', async () => {
    const c = await fixture();
    const execute = vi.fn(async (action: { kind: string }) => {
      if (action.kind === 'context') return { kind: 'context' as const, snapshot };
      const disk = JSON.parse(await readFile(join(c.root, `${c.id}.json`), 'utf8'));
      expect(disk.publicationAttempts[0].state).toBe('dispatching');
      return { kind: 'published' as const, receipt: { sourceUrl: url, url: 'https://www.nowcoder.com/discuss/comment/1234567', text: '先做一个同事能用的工具呗', observedAt: snapshot.readAt } };
    });
    const activity = new NowcoderOperationsActivity(c.store, { assertAvailable() {}, execute }, fetch);
    await activity.context(c.id, 1);
    const entry = await drafted(c.store, c.id);
    const input = { revision: entry.revision, contextHash: entry.contextHash, key: 'authorized-live-test-01', send: true as const };
    expect(await activity.publish(c.id, input)).toMatchObject({ publication: { state: 'published', replyUrl: 'https://www.nowcoder.com/discuss/comment/1234567' } });
    await activity.publish(c.id, input);
    expect(execute).toHaveBeenCalledTimes(2); // one read, one publication
    expect(await c.store.get(c.id)).toMatchObject({ status: 'replied' });
  });

  it('keeps a disconnect uncertain across service restarts and blocks every new send key', async () => {
    const c = await fixture();
    const execute = vi.fn(async (action: { kind: string }) => {
      if (action.kind === 'context') return { kind: 'context' as const, snapshot };
      throw new Error('socket disconnected after click');
    });
    const transport = { assertAvailable() {}, execute };
    const activity = new NowcoderOperationsActivity(c.store, transport, fetch);
    await activity.context(c.id, 1); const entry = await drafted(c.store, c.id);
    const input = { revision: entry.revision, contextHash: entry.contextHash, key: 'authorized-live-test-02', send: true as const };
    expect(await activity.publish(c.id, input)).toMatchObject({ publication: { state: 'uncertain' } });
    const recovered = new NowcoderOperationsActivity(new NowcoderOperationsStore(c.root, c.root), transport, fetch);
    await expect(recovered.publish(c.id, { ...input, key: 'authorized-live-test-03' })).rejects.toThrow('核验');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('rejects stale/unreviewed drafts and receipts from another source before marking replied', async () => {
    const c = await fixture();
    const execute = vi.fn(async () => ({ kind: 'context' as const, snapshot }));
    const activity = new NowcoderOperationsActivity(c.store, { assertAvailable() {}, execute }, fetch);
    const initial = (await c.store.get(c.id))!;
    await expect(activity.publish(c.id, { revision: 1, contextHash: initial.contextHash, key: 'authorized-live-test-04', send: true })).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    await activity.context(c.id, 1); const entry = await drafted(c.store, c.id);
    await expect(activity.publish(c.id, { revision: 1, contextHash: entry.contextHash, key: 'authorized-live-test-05', send: true })).rejects.toThrow('修改');
    await activity.context(c.id, 1);
    const newer = (await c.store.get(c.id))!;
    await expect(activity.publish(c.id, { revision: newer.revision, contextHash: newer.contextHash, key: 'authorized-live-test-06', send: true })).rejects.toThrow('草稿');
  });

  it('keeps search to one JSON request and only removes posts already replied to', async () => {
    const c = await fixture();
    const fetcher = vi.fn(async () => Response.json({ success: true, code: 0, data: { totalPage: 4, records: [
      { contentData: { id: '123456', title, content: body, createTime: Date.now() } },
      { contentData: { id: '987654', title: '另一个方向问题', content: '学了 Agent 怎么练习', createTime: Date.now() - 1000 } },
    ] } }));
    const activity = new NowcoderOperationsActivity(c.store, { assertAvailable() {}, execute: vi.fn() }, fetcher);
    const result = await activity.search('Agent 学习', 1);
    expect(result).toMatchObject({ provider: 'nowcoder-json', requestBudget: 1, hasMore: true, candidates: [{ url }] });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ query: 'Agent 学习', order: 'create', page: 1 });
    const original = (await c.store.get(c.id))!;
    const saved = await c.store.update(c.id, { revision: original.revision, contextHash: original.contextHash, drafts: {
      primary: '先做一个小工具', alternative: '从自己的资料开始', tone: 'practical', anchor: 'LangGraph', notes: '' } });
    await c.store.update(c.id, { revision: saved.revision, status: 'replied', replyUrl: 'https://www.nowcoder.com/discuss/comment/1234567' });
    expect(await activity.search('Agent 学习', 1)).toMatchObject({ candidates: [{ url: 'https://www.nowcoder.com/discuss/987654' }] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not accept a receipt from another source as a verified publication', async () => {
    const c = await fixture();
    const execute = vi.fn(async (action: { kind: string }) => action.kind === 'context' ? { kind: 'context' as const, snapshot }
      : { kind: 'published' as const, receipt: { sourceUrl: 'https://www.nowcoder.com/discuss/99999', url: 'https://www.nowcoder.com/discuss/comment/1234567', text: '先做一个同事能用的工具呗', observedAt: snapshot.readAt } });
    const activity = new NowcoderOperationsActivity(c.store, { assertAvailable() {}, execute }, fetch);
    await activity.context(c.id, 1); const entry = await drafted(c.store, c.id);
    const result = await activity.publish(c.id, { revision: entry.revision, contextHash: entry.contextHash, key: 'authorized-wrong-source-01', send: true });
    expect(result).toMatchObject({ publication: { state: 'uncertain' } });
    expect(result).not.toHaveProperty('receipt');
    expect((await c.store.get(c.id))?.status).toBe('drafted');
  });

  it('recovers a lost receipt using a read-only unique new comment, never submits again', async () => {
    const c = await fixture();
    const execute = vi.fn(async (action: { kind: string }) => {
      if (action.kind === 'publish') throw new Error('lost receipt');
      return { kind: 'context' as const, snapshot };
    });
    const activity = new NowcoderOperationsActivity(c.store, { assertAvailable() {}, execute }, fetch);
    await activity.context(c.id, 1); const entry = await drafted(c.store, c.id), key = 'authorized-verify-test-01';
    await activity.publish(c.id, { revision: entry.revision, contextHash: entry.contextHash, key, send: true });
    expect(await activity.context(c.id, 1)).toMatchObject({ verificationOnly: true });
    expect(await activity.verify(c.id, key, 1)).toMatchObject({ publication: { state: 'uncertain' } });
    execute.mockImplementation(async () => ({ kind: 'context', snapshot: { ...snapshot,
      comments: [{ url: 'https://www.nowcoder.com/discuss/comment/1234567', parentUrl: null, text: entry.drafts!.primary, images: [], likes: null, isAuthor: false }],
      coverage: { ...snapshot.coverage, total: 1, observed: 1 } } }));
    expect(await activity.verify(c.id, key, 1)).toMatchObject({ publication: { state: 'published', replyUrl: 'https://www.nowcoder.com/discuss/comment/1234567' } });
    expect((await c.store.get(c.id))?.status).toBe('replied');
    expect(execute.mock.calls.filter(([action]) => action.kind === 'publish')).toHaveLength(1);
  });

  it('preserves a still-dispatching fence across abrupt process loss before any result handler runs', async () => {
    const c = await fixture();
    await c.store.saveConversation(c.id, snapshot); const entry = await drafted(c.store, c.id);
    const input = { revision: entry.revision, contextHash: entry.contextHash, key: 'authorized-crash-test-01', send: true as const };
    await c.store.beginPublication(c.id, input, '12345678-1234-4234-8234-123456789012');
    const execute = vi.fn(), recovered = new NowcoderOperationsActivity(new NowcoderOperationsStore(c.root, c.root), { assertAvailable() {}, execute }, fetch);
    expect(await recovered.publish(c.id, input)).toMatchObject({ publication: { state: 'dispatching' } });
    await expect(recovered.publish(c.id, { ...input, key: 'authorized-crash-test-02' })).rejects.toThrow('核验');
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps manual reconciliation explicit and blocks a new send after recording the real link', async () => {
    const c = await fixture();
    await c.store.saveConversation(c.id, snapshot); const entry = await drafted(c.store, c.id);
    const input = { revision: entry.revision, contextHash: entry.contextHash, key: 'authorized-manual-test-01', send: true as const };
    const started = await c.store.beginPublication(c.id, input, '12345678-1234-4234-8234-123456789012');
    const saved = await c.store.update(c.id, { revision: started.entry.revision, status: 'replied', replyUrl: 'https://www.nowcoder.com/discuss/comment/1234567' });
    expect(saved.publicationAttempts?.[0]).toMatchObject({ state: 'published', evidence: 'manual' });
    await expect(c.store.beginPublication(c.id, { ...input, revision: saved.revision, key: 'authorized-manual-test-02' }, '12345678-1234-4234-8234-123456789013')).rejects.toThrow('核验');
  });
});
it('persists structured context-change evidence and passes it through publication receipts', async () => {
 const c = await fixture(), contextChanges = { fields: ['body' as const], comments: { added: [], removed: [], changed: [], truncated: false }, total: { before: 0, after: 0 } };
 const activity = new NowcoderOperationsActivity(c.store, { assertAvailable() {}, async execute(action) { return action.kind === 'context' ? { kind: 'context', snapshot } : { kind: 'attention', code: 'CONTEXT_CHANGED', message: '原帖已变', submission: 'not_attempted', contextChanges }; } }, fetch);
 await activity.context(c.id); const entry = await drafted(c.store, c.id);
 expect(await activity.publish(c.id, { key: 'structured-changes-01', revision: entry.revision, contextHash: entry.contextHash, send: true })).toMatchObject({ attention: { contextChanges }, publication: { contextChanges } });
 expect((await c.store.get(c.id))?.publicationAttempts?.[0]).toMatchObject({ contextChanges });
});
