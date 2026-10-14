import { afterEach, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CollectedDocument } from '@data-collector/shared';
import { MarkdownLibrary } from '../../packages/bridge/src/library/writer.js';
import { organize } from '../../packages/bridge/src/organize/index.js';
import { pendingIds, syncEntries } from '../../packages/bridge/src/library/sync.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const temp = createTemporaryDirectoryTracker();
afterEach(() => temp.cleanup());
const source = (): CollectedDocument => ({ schemaVersion: 1, source: 'nowcoder', kind: 'post',
  url: 'https://www.nowcoder.com/discuss/99001', canonicalUrl: 'https://www.nowcoder.com/discuss/99001',
  title: 'Agent 研发面经', text: '1. 如何设计工具调用？', html: '<p>1. 如何设计工具调用？</p>',
  images: [], collectedAt: '2026-10-13T09:00:00.000Z',
  sourceMetadata: { batchId: 'review-batch', nowcoderReviewOnly: true },
});

describe('held local review snapshots', () => {
  it('excludes review evidence from automatic pending and keeps the hold on recapture', async () => {
    const root = await temp.create('review-local-library-');
    const library = new MarkdownLibrary({ root });
    const saved = await library.save(organize(source()));
    expect(await pendingIds(root)).toEqual([]);
    const recapture = source(); delete recapture.sourceMetadata;
    await library.save(organize(recapture));
    expect(await pendingIds(root)).toEqual([]);
    expect(JSON.parse(await readFile(join(root, '_catalog/index.json'), 'utf8'))[0]).toMatchObject({ id: saved.id, nowcoderReviewOnly: true });
    const entries = JSON.parse(await readFile(join(root, '_catalog/index.json'), 'utf8'));
    const snapshot = JSON.parse(await readFile(join(root, entries[0].relativePath.replace(/index\.md$/, 'source.json')), 'utf8'));
    expect(snapshot.document.sourceMetadata?.nowcoderReviewOnly).toBe(true);
  });

  it('restores a lost catalog hold from source before ordinary recapture and automatic sync', async () => {
    const root = await temp.create('review-recapture-library-');
    const library = new MarkdownLibrary({ root });
    const saved = await library.save(organize(source()));
    const catalogFile = join(root, '_catalog/index.json');
    const entries = JSON.parse(await readFile(catalogFile, 'utf8')); delete entries[0].nowcoderReviewOnly;
    await writeFile(catalogFile, JSON.stringify(entries));
    const recapture = source(); delete recapture.sourceMetadata;
    await library.save(organize(recapture));
    let writes = 0;
    const result = await syncEntries(root, [saved.id], () => ({ id: 'target', label: 'target', root: '/tmp/target', categories: [], save: async () => {
      writes++; return { sinkId: 'target', ok: true, outputRef: '/tmp/target' };
    } }), undefined, { deliveryBatchId: 'later-auto-batch', deliveryPlanId: 'nowcoder-agent-market' });
    expect(result.failed).toBe(1);
    expect(writes).toBe(0);
    expect(await pendingIds(root)).toEqual([]);
  });

  it('blocks automatic sync even when the catalog marker is missing but source retains it', async () => {
    const root = await temp.create('review-local-library-');
    const saved = await new MarkdownLibrary({ root }).save(organize(source()));
    const catalogFile = join(root, '_catalog/index.json');
    const entries = JSON.parse(await readFile(catalogFile, 'utf8')); delete entries[0].nowcoderReviewOnly;
    await writeFile(catalogFile, JSON.stringify(entries));
    let writes = 0;
    const result = await syncEntries(root, [saved.id], () => ({ id: 'target', label: 'target', root: '/tmp/target', categories: [], save: async () => {
      writes++; return { sinkId: 'target', ok: true, outputRef: '/tmp/target' };
    } }), undefined, { deliveryBatchId: 'next-automatic-batch', deliveryPlanId: 'nowcoder-agent-market' });
    expect(result.failed).toBe(1);
    expect(writes).toBe(0);
  });
});
