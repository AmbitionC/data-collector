import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CollectedDocument } from '@data-collector/shared';
import {
  filterProcessedNowcoderDocuments,
  loadProcessedNowcoderHistory,
  loadStrictProcessedNowcoderHistory,
  processedNowcoderHistoryDigest,
  historyFromSnapshot,
  StrictNowcoderHistoryError,
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

  it('strict mode distinguishes a genuinely missing leaf from corrupt history', async () => {
    const missing = await temporaryDirectories.create('nowcoder-strict-history-missing-');
    const empty = await loadStrictProcessedNowcoderHistory(missing);
    expect(empty.snapshot).toEqual({ version: 1, hashesByUrl: [], clusterIds: [] });
    expect(empty.digest).toBe(processedNowcoderHistoryDigest(empty.snapshot));

    const malformed = await temporaryDirectories.create('nowcoder-strict-history-malformed-');
    await mkdir(join(malformed, '.codex'), { recursive: true });
    await writeFile(join(malformed, '.codex', 'interview-source-history.json'), '{not-json');
    await expect(loadStrictProcessedNowcoderHistory(malformed)).rejects.toMatchObject({
      code: 'DIRECTED_HISTORY_CORRUPT',
    });

    const symlinked = await temporaryDirectories.create('nowcoder-strict-history-symlink-');
    await mkdir(join(symlinked, '.codex'), { recursive: true });
    await symlink(
      join(malformed, '.codex', 'interview-source-history.json'),
      join(symlinked, '.codex', 'interview-source-history.json'),
    );
    await expect(loadStrictProcessedNowcoderHistory(symlinked)).rejects.toMatchObject({
      code: 'DIRECTED_HISTORY_CORRUPT',
    });
  });

  it('strict mode canonicalizes byte-sorted URL/hash/cluster snapshots deterministically', async () => {
    const repo = await temporaryDirectories.create('nowcoder-strict-history-order-');
    await mkdir(join(repo, '.codex'), { recursive: true });
    await writeFile(join(repo, '.codex', 'interview-source-history.json'), JSON.stringify({
      schemaVersion: 1,
      updatedAt: '2026-08-30',
      records: {
        'bbbbbbbbbbbb': {
          source: 'nowcoder', url: 'https://www.nowcoder.com/discuss/2',
          contentHash: 'bbbbbbbbbbbbbbbb', clusterId: 'cluster-b', evidenceGrade: 'B',
          status: 'merged', publicFiles: [], knowledgeKeys: [], processedAt: '2026-08-30T00:00:00.000Z',
        },
        'aaaaaaaaaaaa': {
          source: 'nowcoder', url: 'https://www.nowcoder.com/discuss/1',
          contentHash: 'aaaaaaaaaaaaaaaa', clusterId: 'cluster-a', evidenceGrade: 'A',
          status: 'published', articleKey: 'a', publicFiles: ['interview/a.md'], knowledgeKeys: [],
          processedAt: '2026-08-30T00:00:00.000Z',
        },
      },
    }));

    const first = await loadStrictProcessedNowcoderHistory(repo);
    const second = await loadStrictProcessedNowcoderHistory(repo);
    expect(first).toEqual(second);
    expect(first.snapshot.hashesByUrl.map(item => item.url)).toEqual([
      'https://www.nowcoder.com/discuss/1',
      'https://www.nowcoder.com/discuss/2',
    ]);
    expect(first.snapshot.clusterIds).toEqual(['cluster-a', 'cluster-b']);
  });

  it('rejects non-canonical or malformed persisted snapshots before digest/use', () => {
    const malformed = {
      version: 1 as const,
      hashesByUrl: [{
        url: 'https://www.nowcoder.com/discuss/2',
        hashes: ['bbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaa'],
      }],
      clusterIds: ['cluster-b', 'cluster-a'],
    };
    expect(() => processedNowcoderHistoryDigest(malformed)).toThrow(StrictNowcoderHistoryError);
    expect(() => historyFromSnapshot(malformed)).toThrow(StrictNowcoderHistoryError);
  });

  it('classifies an oversized persisted normalized set as the strict history limit', () => {
    const oversized = {
      version: 1 as const,
      hashesByUrl: [],
      clusterIds: Array.from({ length: 100_001 }, (_, index) => `cluster-${index}`),
    };
    try {
      processedNowcoderHistoryDigest(oversized);
      throw new Error('expected strict limit error');
    } catch (error) {
      expect(error).toMatchObject({ code: 'DIRECTED_HISTORY_LIMIT_EXCEEDED' });
    }
  });
});
