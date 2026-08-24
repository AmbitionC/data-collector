import { describe, expect, it } from 'vitest';
import type { JobRecord } from '@data-collector/shared';
import { knownNowcoderPlanUrls } from '../../packages/bridge/src/plans/nowcoderHistory.js';

const NOW = '2026-08-24T08:00:00.000Z';

function job(
  id: string,
  status: JobRecord['status'],
  updatedAt: string,
  overrides: Partial<JobRecord> = {},
): JobRecord {
  return {
    id,
    url: `https://www.nowcoder.com/discuss/${id}`,
    requestedBy: 'codex',
    status,
    createdAt: '2026-08-24T06:00:00.000Z',
    updatedAt,
    ...overrides,
  };
}

describe('knownNowcoderPlanUrls', () => {
  it('keeps saved and nonterminal jobs known', () => {
    const savedJob = job('1001', 'saved', '2026-08-23T08:00:00.000Z');
    const queuedJob = job('1002', 'queued', '2026-08-23T08:00:00.000Z');

    const known = knownNowcoderPlanUrls([savedJob, queuedJob], 'new-batch', NOW);

    expect(known).toContain(savedJob.url);
    expect(known).toContain(queuedJob.url);
  });

  it('keeps a fresh terminal failure known during the cooldown', () => {
    const freshFailedJob = job('1003', 'needs_attention', '2026-08-24T07:30:00.000Z');

    expect(knownNowcoderPlanUrls([freshFailedJob], 'new-batch', NOW)).toContain(
      freshFailedJob.url,
    );
  });

  it('allows one cooled terminal failure to re-enter discovery', () => {
    const cooledFailedJob = job('1004', 'failed', '2026-08-24T06:59:59.999Z');

    expect(knownNowcoderPlanUrls([cooledFailedJob], 'new-batch', NOW)).not.toContain(
      cooledFailedJob.url,
    );
  });

  it('permanently knows a canonical URL after two terminal failures', () => {
    const firstFailure = job('1005', 'failed', '2026-08-24T05:00:00.000Z');
    const secondFailure = job('second', 'needs_attention', '2026-08-24T06:00:00.000Z', {
      url: 'https://nowcoder.com/discuss/1005/?utm_source=retry#result',
    });

    expect(knownNowcoderPlanUrls([firstFailure, secondFailure], 'new-batch', NOW)).toContain(
      firstFailure.url,
    );
  });

  it('keeps every URL from the current batch known after cooldown', () => {
    const currentBatchFailure = job('1006', 'failed', '2026-08-24T05:00:00.000Z', {
      batchId: 'current-batch',
    });

    expect(
      knownNowcoderPlanUrls([currentBatchFailure], currentBatchFailure.batchId!, NOW),
    ).toContain(currentBatchFailure.url);
  });
});
