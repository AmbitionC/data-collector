import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CollectedDocument } from '@data-collector/shared';
import { listLibrary, pendingIds, syncEntries } from '../../packages/bridge/src/library/index.js';
import { organize } from '../../packages/bridge/src/organize/index.js';
import { SinkRouter } from '../../packages/bridge/src/sinks/index.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const temporaryDirectories = createTemporaryDirectoryTracker();
afterEach(() => temporaryDirectories.cleanup());

describe('Nowcoder pooled delivery metadata', () => {
  it('keeps the capture batch and marks the current delivery batch in inbox meta.json', async () => {
    const library = await temporaryDirectories.create('nowcoder-delivery-library-');
    const repo = await temporaryDirectories.create('nowcoder-delivery-repo-');
    const router = SinkRouter.build({
      sinks: {
        markdown: { type: 'markdown' },
        'fe-journey': {
          type: 'repo-inbox',
          repoPath: repo,
          commit: false,
          push: false,
        },
      },
      routes: { nowcoder: ['fe-journey'] },
    }, { libraryRoot: library });
    const url = 'https://www.nowcoder.com/discuss/93001';
    const document: CollectedDocument = {
      schemaVersion: 1,
      source: 'nowcoder',
      kind: 'post',
      url,
      canonicalUrl: url,
      title: '字节 Agent 开发一面面经',
      collectedAt: '2026-08-25T00:00:00.000Z',
      publishedAt: '2026-08-24T00:00:00.000Z',
      html: '<p>面试官追问 RAG 检索与工具调用。</p>',
      text: '面试官追问 RAG 检索与工具调用。',
      images: [],
      truncated: false,
      sourceMetadata: {
        batchId: 'nowcoder-capture-batch',
        planId: 'nowcoder-agent-market',
        evidenceGrade: 'A',
        agentRelevant: true,
      },
    };
    await router.save(organize(document));
    const [entry] = await listLibrary(library);

    const outcome = await syncEntries(
      library,
      [entry!.id],
      source => router.syncTarget(source),
      undefined,
      { deliveryBatchId: 'nowcoder-delivery-batch' },
    );

    expect(outcome).toMatchObject({ synced: 1, failed: 0 });
    const inboxRoot = join(repo, '_inbox', 'nowcoder');
    expect(existsSync(inboxRoot)).toBe(true);
    const [directory] = await readdir(inboxRoot);
    const meta = JSON.parse(await readFile(join(inboxRoot, directory!, 'meta.json'), 'utf8')) as {
      sourceMetadata: Record<string, unknown>;
    };
    expect(meta.sourceMetadata).toMatchObject({
      batchId: 'nowcoder-capture-batch',
      sourceBatchId: 'nowcoder-capture-batch',
      deliveryBatchId: 'nowcoder-delivery-batch',
    });
    expect(await pendingIds(library)).toEqual([]);
    expect(await pendingIds(library, 'nowcoder-delivery-batch')).toEqual([entry!.id]);
  });

  it('marks a one-off capture as a fixed-plan delivery without inventing a capture batch', async () => {
    const library = await temporaryDirectories.create('nowcoder-one-off-library-');
    const repo = await temporaryDirectories.create('nowcoder-one-off-repo-');
    const router = SinkRouter.build({
      sinks: {
        markdown: { type: 'markdown' },
        'fe-journey': { type: 'repo-inbox', repoPath: repo, commit: false, push: false },
      },
      routes: { nowcoder: ['fe-journey'] },
    }, { libraryRoot: library });
    const url = 'https://www.nowcoder.com/discuss/93002';
    await router.save(organize({
      schemaVersion: 1,
      source: 'nowcoder',
      kind: 'post',
      url,
      canonicalUrl: url,
      title: '阿里 Agent 开发一面面经',
      collectedAt: '2026-08-25T00:00:00.000Z',
      publishedAt: '2026-08-24T00:00:00.000Z',
      html: '<p>面试官追问 Agent Loop。</p>',
      text: '面试官追问 Agent Loop。',
      images: [],
      truncated: false,
      sourceMetadata: { evidenceGrade: 'A', agentRelevant: true },
    }));
    const [entry] = await listLibrary(library);

    const outcome = await syncEntries(
      library,
      [entry!.id],
      source => router.syncTarget(source),
      undefined,
      {
        deliveryBatchId: 'nowcoder-delivery-batch',
        deliveryPlanId: 'nowcoder-agent-market',
      },
    );

    expect(outcome).toMatchObject({ synced: 1, failed: 0 });
    const [directory] = await readdir(join(repo, '_inbox', 'nowcoder'));
    const meta = JSON.parse(await readFile(
      join(repo, '_inbox', 'nowcoder', directory!, 'meta.json'),
      'utf8',
    )) as { sourceMetadata: Record<string, unknown> };
    expect(meta.sourceMetadata).toMatchObject({
      planId: 'nowcoder-agent-market',
      deliveryBatchId: 'nowcoder-delivery-batch',
    });
    expect(meta.sourceMetadata).not.toHaveProperty('sourceBatchId');
  });

  it('keeps every entry pending when one atomic fixed-plan sync fails', async () => {
    const library = await temporaryDirectories.create('nowcoder-atomic-library-');
    const router = SinkRouter.build({
      sinks: { markdown: { type: 'markdown' } },
      routes: {},
    }, { libraryRoot: library });
    for (const id of ['94001', '94002']) {
      const url = `https://www.nowcoder.com/discuss/${id}`;
      await router.save(organize({
        schemaVersion: 1,
        source: 'nowcoder',
        kind: 'post',
        url,
        canonicalUrl: url,
        title: `Agent 面经 ${id}`,
        collectedAt: '2026-08-25T00:00:00.000Z',
        html: '<p>RAG 与工具调用。</p>',
        text: 'RAG 与工具调用。',
        images: [],
        sourceMetadata: { batchId: 'capture-batch', evidenceGrade: 'A', agentRelevant: true },
      }));
    }
    const ids = (await listLibrary(library)).map(entry => entry.id).sort();
    let writes = 0;

    const outcome = await syncEntries(
      library,
      ids,
      () => ({
        id: 'failing-inbox',
        label: 'failing inbox',
        categories: [],
        root: library,
        save: async () => {
          writes += 1;
          if (writes === 2) throw new Error('second write failed');
          return { sinkId: 'failing-inbox', ok: true, outputRef: '/tmp/sent' };
        },
      }),
      undefined,
      { deliveryBatchId: 'delivery-batch', atomic: true },
    );

    expect(outcome).toMatchObject({ synced: 1, failed: 1 });
    expect((await pendingIds(library)).sort()).toEqual(ids);
  });
});
