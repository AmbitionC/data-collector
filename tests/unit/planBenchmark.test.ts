import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CollectionBatch, JobRecord } from '@data-collector/shared';
import { writePlanBenchmark } from '../../packages/bridge/src/plans/benchmark.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const temporaryDirectories = createTemporaryDirectoryTracker();
afterEach(() => temporaryDirectories.cleanup());

function job(
  id: string,
  url: string,
  status: JobRecord['status'],
  createdAt: string,
  updatedAt: string,
  extra: Partial<JobRecord> = {},
): JobRecord {
  return {
    id,
    url,
    requestedBy: 'codex',
    status,
    createdAt,
    updatedAt,
    batchId: 'nowcoder-run-20260825',
    planId: 'nowcoder-agent-market',
    ...extra,
  };
}

describe('writePlanBenchmark', () => {
  it('writes exact timestamp metrics and only allowlisted metadata with private permissions', async () => {
    const root = await temporaryDirectories.create('plan-benchmark-');
    const batch: CollectionBatch = {
      id: 'nowcoder-run-20260825',
      planId: 'nowcoder-agent-market',
      status: 'completed_with_attention',
      startedAt: '2026-08-25T00:00:00.000Z',
      finishedAt: '2026-08-25T00:10:00.000Z',
      discovered: 3,
      accepted: 2,
      saved: 2,
      skipped: 0,
      failed: 1,
      needsAttention: 0,
      deliveryIds: ['a265fb4ae1a3', '7daf7a39e447'],
      selectionStatus: 'completed',
      rounds: 2,
      coverage: { bytedance: 1, tencent: 1, alibaba: 0, ant: 0 },
    };
    const jobs = [
      job(
        'job-private-one',
        'https://www.nowcoder.com/discuss/91001',
        'saved',
        '2026-08-25T00:01:00.000Z',
        '2026-08-25T00:01:01.000Z',
        { outputPath: '/Users/private/raw-evidence/one/index.md' },
      ),
      job(
        'job-private-two',
        'https://www.nowcoder.com/discuss/91002',
        'saved',
        '2026-08-25T00:02:00.000Z',
        '2026-08-25T00:02:03.000Z',
      ),
      job(
        'job-private-three',
        'https://www.nowcoder.com/discuss/91003',
        'failed',
        '2026-08-25T00:04:00.000Z',
        '2026-08-25T00:04:09.000Z',
        { errorMessage: 'cookie=session-secret' },
      ),
    ];
    const metadata = new Map<string, Record<string, unknown>>([
      ['job-private-one', {
        company: 'bytedance',
        evidenceGrade: 'A',
        questionCount: 7,
        clusterId: 'cluster-a265fb4ae1a3',
        text: 'PRIVATE ARTICLE TEXT',
        html: '<p>PRIVATE HTML</p>',
        author: 'PRIVATE AUTHOR',
        cookies: 'session=RAW_COOKIE',
        sourcePath: '/Users/private/raw-evidence/one/index.md',
      }],
      ['job-private-two', {
        company: 'tencent',
        evidenceGrade: 'B',
        questionCount: 4,
        clusterId: 'cluster-7daf7a39e447',
      }],
      ['job-private-three', {
        company: '/Users/private/evidence',
        evidenceGrade: 'https://private.example/session',
        questionCount: 'Error: raw question metadata',
        clusterId: 'Error: /Users/private/evidence could not be read',
      }],
    ]);

    const reportPath = await writePlanBenchmark(root, batch, jobs, {
      metadataFor: async current => metadata.get(current.id),
    });
    const serialized = await readFile(reportPath, 'utf8');
    const report = JSON.parse(serialized) as Record<string, unknown>;

    expect(reportPath).toBe(join(root, 'benchmarks', 'nowcoder-run-20260825.json'));
    expect(report).toEqual({
      schemaVersion: 1,
      runId: 'nowcoder-run-20260825',
      batchId: 'nowcoder-run-20260825',
      planId: 'nowcoder-agent-market',
      status: 'completed_with_attention',
      startedAt: '2026-08-25T00:00:00.000Z',
      finishedAt: '2026-08-25T00:10:00.000Z',
      roundCount: 2,
      contentIds: ['7daf7a39e447', '847556c339e8', 'a265fb4ae1a3'],
      deliveryIds: ['a265fb4ae1a3', '7daf7a39e447'],
      terminalCounts: {
        discovered: 3,
        accepted: 2,
        saved: 2,
        skipped: 0,
        failed: 1,
        needsAttention: 0,
      },
      timing: {
        activeDurationMs: 600_000,
        detailWindowMs: 189_000,
        jobDurationMs: { total: 13_000, p50: 3_000, p90: 9_000 },
      },
      remoteTabs: { configuredLimit: 2 },
      jobs: [
        {
          contentId: '7daf7a39e447',
          status: 'saved',
          durationMs: 3_000,
          company: 'tencent',
          evidenceGrade: 'B',
          questionCount: 4,
          clusterId: 'cluster-7daf7a39e447',
        },
        {
          contentId: '847556c339e8',
          status: 'failed',
          durationMs: 9_000,
        },
        {
          contentId: 'a265fb4ae1a3',
          status: 'saved',
          durationMs: 1_000,
          company: 'bytedance',
          evidenceGrade: 'A',
          questionCount: 7,
          clusterId: 'cluster-a265fb4ae1a3',
        },
      ],
    });
    expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
    for (const secret of [
      'PRIVATE ARTICLE TEXT',
      'PRIVATE HTML',
      'PRIVATE AUTHOR',
      'RAW_COOKIE',
      '/Users/private',
      'nowcoder.com',
      'private.example',
      'raw question metadata',
      'could not be read',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it.each([
    ['numeric shorthand', '0'],
    ['timezone-less local time', '2026-08-25T00:01:00.000'],
    ['numeric timezone offset', '2026-08-25T08:01:00.000+08:00'],
    ['missing milliseconds', '2026-08-25T00:01:00Z'],
    ['impossible calendar date', '2026-02-30T00:01:00.000Z'],
  ])('rejects %s instead of normalizing a false job timestamp', async (_name, createdAt) => {
    const root = await temporaryDirectories.create('plan-benchmark-invalid-job-time-');
    const batch: CollectionBatch = {
      id: 'nowcoder-invalid-job-time',
      planId: 'nowcoder-agent-market',
      status: 'completed',
      startedAt: '2026-08-25T00:00:00.000Z',
      finishedAt: '2026-08-25T00:10:00.000Z',
      discovered: 1,
      accepted: 1,
      saved: 1,
      skipped: 0,
      failed: 0,
      needsAttention: 0,
      deliveryIds: [],
    };

    await expect(writePlanBenchmark(root, batch, [job(
      'invalid-time-job',
      'https://www.nowcoder.com/discuss/91001',
      'saved',
      createdAt,
      '2026-08-25T00:01:01.000Z',
      { batchId: batch.id },
    )], { metadataFor: () => undefined })).rejects.toThrow('时间无效');
  });

  it.each([
    ['timezone-less batch start', '2026-08-25T00:00:00.000'],
    ['impossible batch start', '2026-02-30T00:00:00.000Z'],
  ])('rejects %s before emitting batch metrics', async (_name, startedAt) => {
    const root = await temporaryDirectories.create('plan-benchmark-invalid-batch-time-');
    const batch: CollectionBatch = {
      id: 'nowcoder-invalid-batch-time',
      planId: 'nowcoder-agent-market',
      status: 'completed',
      startedAt,
      finishedAt: '2026-08-25T00:10:00.000Z',
      discovered: 0,
      accepted: 0,
      saved: 0,
      skipped: 0,
      failed: 0,
      needsAttention: 0,
      deliveryIds: [],
    };

    await expect(writePlanBenchmark(root, batch, [], {
      metadataFor: () => undefined,
    })).rejects.toThrow('时间无效');
  });
});
