import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stableContentId, type CollectedDocument } from '@data-collector/shared';
import { MarkdownLibrary } from '../../packages/bridge/src/library/index.js';
import { organize } from '../../packages/bridge/src/organize/index.js';
import { NowcoderOperationsStore } from '../../packages/bridge/src/operations/store.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const temporaryDirectories = createTemporaryDirectoryTracker();
afterEach(() => temporaryDirectories.cleanup());
async function fixture() {
  const root = await temporaryDirectories.create('nowcoder-ops-store-');
  const libraryRoot = join(root, 'library'), storeRoot = join(root, 'private');
  const url = 'https://www.nowcoder.com/feed/main/detail/abcdef123456';
  const document: CollectedDocument = { schemaVersion: 1, source: 'nowcoder', kind: 'post', url, canonicalUrl: url,
    title: 'Agent 项目怎么做', text: '学习了 LangGraph，但不知道下一步做什么，求建议。', html: '<p>学习了 LangGraph，但不知道下一步做什么，求建议。</p>',
    images: [], collectedAt: '2026-10-28T06:00:00.000Z' };
  const saved = await new MarkdownLibrary({ root: libraryRoot }).save(organize(document));
  return { root, libraryRoot, storeRoot, url, saved, sourceId: stableContentId(url), store: new NowcoderOperationsStore(storeRoot, libraryRoot) };
}

describe('private operations source boundaries', () => {
  it('preserves drafts after duplicate enqueue and process restart', async () => {
    const c = await fixture(), entry = await c.store.add(c.sourceId);
    const updated = await c.store.update(entry.id, { revision: 1, contextHash: entry.contextHash,
      drafts: { primary: '先做一个小任务。', alternative: '选一个已有项目，加一项能验证的能力，再记录自己做过哪些取舍。', tone: 'practical', anchor: 'LangGraph', notes: '' } });
    const reopened = new NowcoderOperationsStore(c.storeRoot, c.libraryRoot);
    expect(await reopened.add(c.sourceId)).toEqual(updated);
    expect((await reopened.get(entry.id))?.drafts?.primary).toBe('先做一个小任务。');
  });

  it('rejects a source snapshot whose canonical identity disagrees with the catalog', async () => {
    const c = await fixture();
    const sourcePath = join(dirname(c.saved.markdownPath), 'source.json');
    const value = JSON.parse(await readFile(sourcePath, 'utf8'));
    value.document.canonicalUrl = 'https://www.nowcoder.com/discuss/999999';
    await writeFile(sourcePath, JSON.stringify(value));
    await expect(c.store.add(c.sourceId)).rejects.toThrow('身份');
    expect(await c.store.list()).toEqual([]);
  });

  it('does not replace a corrupt operations record with an empty queue', async () => {
    const c = await fixture();
    await mkdir(c.storeRoot, { recursive: true });
    await writeFile(join(c.storeRoot, 'ops-000000000000.json'), '{broken');
    await expect(c.store.list()).rejects.toThrow('损坏');
    expect(await readFile(join(c.storeRoot, 'ops-000000000000.json'), 'utf8')).toBe('{broken');
  });

  it('accepts one of two simultaneous edits and rejects the stale edit', async () => {
    const c = await fixture(), entry = await c.store.add(c.sourceId);
    const outcomes = await Promise.allSettled([
      c.store.update(entry.id, { revision: 1, note: 'first' }),
      c.store.update(entry.id, { revision: 1, note: 'second' }),
    ]);
    expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(item => item.status === 'rejected')).toHaveLength(1);
    expect((await c.store.get(entry.id))?.revision).toBe(2);
  });

  it('never allows an unrelated patch to rewrite the frozen context hash', async () => {
    const c = await fixture(), entry = await c.store.add(c.sourceId);
    await expect(c.store.update(entry.id, { revision: 1, contextHash: '0'.repeat(64), note: 'note' })).rejects.toThrow('正文');
    expect((await c.store.get(entry.id))?.contextHash).toBe(entry.contextHash);
  });

  it('rejects a persisted publication claim without a draft and comment link', async () => {
    const c = await fixture(), entry = await c.store.add(c.sourceId);
    const path = join(c.storeRoot, `${entry.id}.json`);
    await writeFile(path, JSON.stringify({ ...entry, status: 'replied' }));
    await expect(c.store.get(entry.id)).rejects.toThrow('损坏');
    await expect(c.store.list()).rejects.toThrow('损坏');
  });
});
