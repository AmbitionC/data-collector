import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CollectedDocument } from '@data-collector/shared';
import {
  filterProcessedNowcoderDocuments,
  loadProcessedNowcoderHistory,
} from '../../packages/bridge/src/plans/nowcoderProcessedHistory.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const temporaryDirectories = createTemporaryDirectoryTracker();
afterEach(() => temporaryDirectories.cleanup());

function document(
  url: string,
  contentHash: string,
  clusterId: string,
): CollectedDocument {
  return {
    schemaVersion: 1,
    source: 'nowcoder',
    kind: 'post',
    url,
    canonicalUrl: url,
    title: 'Agent 开发面经',
    collectedAt: '2026-08-25T00:00:00.000Z',
    html: '<p>Agent 工具调用与异常恢复。</p>',
    text: 'Agent 工具调用与异常恢复。',
    images: [],
    feJourney: {
      candidateKinds: ['interview'],
      qualityScore: 90,
      qualitySignals: [],
      exclusionReasons: [],
      contentHash,
      simHash: '1111111111111111',
      clusterId,
    },
  };
}

describe('processed Nowcoder history', () => {
  it('rejects unchanged URLs and duplicate clusters while allowing a changed source revision', async () => {
    const repo = await temporaryDirectories.create('nowcoder-processed-history-');
    await mkdir(join(repo, '.codex'), { recursive: true });
    await writeFile(join(repo, '.codex', 'interview-source-history.json'), JSON.stringify({
      schemaVersion: 1,
      records: {
        a1b2c3d4e5f6: {
          source: 'nowcoder',
          url: 'https://www.nowcoder.com/discuss/1001?sourceSSR=post',
          contentHash: 'hash-original',
          clusterId: 'cluster-original',
          status: 'published',
        },
        '0123456789ab': {
          source: 'nowcoder',
          url: 'https://www.nowcoder.com/discuss/2001',
          contentHash: 'hash-reviewed',
          clusterId: 'cluster-reviewed',
          status: 'needs_review',
        },
      },
    }));
    const history = await loadProcessedNowcoderHistory(repo);
    const unchanged = document(
      'https://www.nowcoder.com/discuss/1001',
      'hash-original',
      'cluster-original',
    );
    const changed = document(
      'https://www.nowcoder.com/discuss/1001',
      'hash-new-revision',
      'cluster-original',
    );
    const duplicateCluster = document(
      'https://www.nowcoder.com/discuss/3001',
      'hash-duplicate-copy',
      'cluster-reviewed',
    );
    const fresh = document(
      'https://www.nowcoder.com/discuss/4001',
      'hash-fresh',
      'cluster-fresh',
    );

    const result = filterProcessedNowcoderDocuments(
      [unchanged, changed, duplicateCluster, fresh],
      history,
    );

    expect(result.eligible).toEqual([changed, fresh]);
    expect(result.rejected).toEqual([
      { url: unchanged.canonicalUrl, reason: '目标仓库已处理相同来源版本' },
      { url: duplicateCluster.canonicalUrl, reason: '目标仓库已处理相同问题簇' },
    ]);
  });

  it('fails open when the target repository has no readable history', async () => {
    const repo = await temporaryDirectories.create('nowcoder-missing-history-');
    const candidate = document(
      'https://www.nowcoder.com/discuss/5001',
      'hash-fresh',
      'cluster-fresh',
    );

    const result = filterProcessedNowcoderDocuments(
      [candidate],
      await loadProcessedNowcoderHistory(repo),
    );

    expect(result).toEqual({ eligible: [candidate], rejected: [] });
  });
});
