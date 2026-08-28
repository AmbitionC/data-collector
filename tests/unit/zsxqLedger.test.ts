import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ZsxqDayLedgerStore } from '../../packages/bridge/src/plans/zsxqLedger.js';

const ATTEMPT = 'a1b2c3d4e5f60718';

function emptyDraft(day: string) {
  return {
    day,
    rawOwnerCount: 0,
    qualifyingCount: 0,
    filteredCount: 0,
    exactDuplicateCount: 0,
    semanticDuplicateCount: 0,
    knownCompleteCount: 0,
    repairCount: 0,
    candidateCount: 0,
    savedCount: 0,
    failedCount: 0,
    crossedDayBoundary: true,
  } as const;
}

function emptyAudit() {
  return {
    mode: 'daily-ledger' as const,
    pagesFetched: 1,
    observed: 0,
    qualifying: 0,
    exactDuplicates: 0,
    semanticDuplicates: 0,
    filtered: 0,
    knownComplete: 0,
    repaired: 0,
    saved: 0,
    failed: 0,
    exhausted: false,
    safetyCapReached: false,
    completedDays: 0,
    emptyDays: 0,
    failedDays: 0,
  };
}

describe('ZSXQ Shanghai-day ledger', () => {
  it('finalizes only the crossed closed day as explicitly empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zsxq-ledger-'));
    const store = await ZsxqDayLedgerStore.open(
      join(root, 'zsxq-day-ledger.json'),
      () => '2026-08-29T00:00:00.000Z',
    );

    expect(store.requestFor('daily-ledger')).toEqual({ targetDays: ['2026-08-28'] });
    await store.beginAttempt(
      'batch-daily',
      ATTEMPT,
      'daily-ledger',
      ['2026-08-28'],
    );
    await store.recordPage(
      'batch-daily',
      ATTEMPT,
      {
        mode: 'daily-ledger',
        cursor: '2026-08-27T23:59:59.999Z',
        pagesFetched: 1,
        exhausted: false,
      },
      [emptyDraft('2026-08-28')],
      emptyAudit(),
    );
    await store.finalize('batch-daily', ATTEMPT, { status: 'completed' });

    expect(store.snapshot().days['2026-08-28']).toMatchObject({
      status: 'completed_empty',
      crossedDayBoundary: true,
      batchId: 'batch-daily',
    });
    expect(store.snapshot().days).not.toHaveProperty('2026-08-29');
  });

  it('fills every closed day only after owner history proves API exhaustion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zsxq-ledger-history-'));
    const store = await ZsxqDayLedgerStore.open(
      join(root, 'zsxq-day-ledger.json'),
      () => '2026-08-29T00:00:00.000Z',
    );
    await store.beginAttempt('batch-history', ATTEMPT, 'owner-history', []);
    await store.recordPage(
      'batch-history',
      ATTEMPT,
      {
        mode: 'owner-history',
        pagesFetched: 9,
        newestObservedAt: '2026-08-28T01:00:00.000Z',
        oldestObservedAt: '2026-08-25T01:00:00.000Z',
        exhausted: true,
      },
      [{
        ...emptyDraft('2026-08-25'),
        rawOwnerCount: 1,
        qualifyingCount: 1,
        exactDuplicateCount: 1,
        knownCompleteCount: 1,
        itemFacts: [{
          url: 'https://wx.zsxq.com/group/48844584441158/topic/1001',
          day: '2026-08-25',
          outcome: 'exact' as const,
          mappedUrl: 'https://wx.zsxq.com/group/48844584441158/topic/1001',
        }],
      }],
      {
        ...emptyAudit(),
        mode: 'owner-history',
        pagesFetched: 9,
        observed: 1,
        qualifying: 1,
        exactDuplicates: 1,
        knownComplete: 1,
        newestObservedAt: '2026-08-28T01:00:00.000Z',
        oldestObservedAt: '2026-08-25T01:00:00.000Z',
        exhausted: true,
      },
    );
    await store.finalize('batch-history', ATTEMPT, { status: 'completed' });

    expect(Object.keys(store.snapshot().days).sort()).toEqual([
      '2026-08-25',
      '2026-08-26',
      '2026-08-27',
      '2026-08-28',
    ]);
    expect(store.snapshot().days['2026-08-25']?.status).toBe('completed_content');
    expect(store.snapshot().days['2026-08-26']?.status).toBe('completed_empty');
    expect(store.snapshot().coverageStartDay).toBe('2026-08-25');
    expect(store.snapshot().lastHistoryAudit).toMatchObject({
      batchId: 'batch-history',
      attempt: ATTEMPT,
      itemFacts: [{ outcome: 'exact' }],
    });
    expect(store.snapshot().days).not.toHaveProperty('2026-08-29');
  });

  it('returns an older failed day instead of rescanning completed dates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zsxq-ledger-gap-'));
    const store = await ZsxqDayLedgerStore.open(
      join(root, 'zsxq-day-ledger.json'),
      () => '2026-08-29T00:00:00.000Z',
    );
    await store.beginAttempt('batch-history', ATTEMPT, 'owner-history', []);
    await store.recordPage(
      'batch-history',
      ATTEMPT,
      {
        mode: 'owner-history',
        pagesFetched: 2,
        oldestObservedAt: '2026-08-25T01:00:00.000Z',
        newestObservedAt: '2026-08-28T01:00:00.000Z',
        exhausted: true,
      },
      [],
      {
        ...emptyAudit(),
        mode: 'owner-history',
        pagesFetched: 2,
        oldestObservedAt: '2026-08-25T01:00:00.000Z',
        newestObservedAt: '2026-08-28T01:00:00.000Z',
        exhausted: true,
      },
    );
    await store.finalize('batch-history', ATTEMPT, { status: 'completed' });

    const retryAttempt = 'b1b2c3d4e5f60718';
    await store.beginAttempt('batch-failed-day', retryAttempt, 'daily-ledger', ['2026-08-27']);
    await store.recordPage(
      'batch-failed-day',
      retryAttempt,
      {
        mode: 'daily-ledger',
        pagesFetched: 1,
        cursor: '2026-08-26T23:59:59.999Z',
        exhausted: false,
      },
      [emptyDraft('2026-08-27')],
      emptyAudit(),
    );
    await store.finalize('batch-failed-day', retryAttempt, {
      status: 'failed',
      errorCode: 'AUTH_REQUIRED',
    });

    expect(store.requestFor('daily-ledger')).toEqual({ targetDays: ['2026-08-27'] });
  });

  it('resumes the safe history cursor without accepting stale or replayed page facts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zsxq-ledger-resume-'));
    const store = await ZsxqDayLedgerStore.open(
      join(root, 'zsxq-day-ledger.json'),
      () => '2026-08-29T00:00:00.000Z',
    );
    await store.beginAttempt('batch-first', ATTEMPT, 'owner-history', []);
    const checkpoint = {
      mode: 'owner-history' as const,
      cursor: '2026-08-20T00:00:00.000Z',
      pagesFetched: 1,
      newestObservedAt: '2026-08-28T01:00:00.000Z',
      oldestObservedAt: '2026-08-20T00:00:00.001Z',
      exhausted: false,
    };
    const pageDraft = {
      ...emptyDraft('2026-08-28'),
      rawOwnerCount: 1,
      qualifyingCount: 1,
      exactDuplicateCount: 1,
      knownCompleteCount: 1,
    };
    const audit = {
      ...emptyAudit(),
      mode: 'owner-history' as const,
      pagesFetched: 1,
      observed: 1,
      qualifying: 1,
      exactDuplicates: 1,
      knownComplete: 1,
      newestObservedAt: '2026-08-28T01:00:00.000Z',
      oldestObservedAt: '2026-08-20T00:00:00.001Z',
    };
    await store.recordPage('batch-first', ATTEMPT, checkpoint, [pageDraft], audit);
    await store.finalize('batch-first', ATTEMPT, { status: 'failed', errorCode: 'AUTH_REQUIRED' });
    expect(store.requestFor('owner-history')).toEqual({
      targetDays: [],
      resumeCursor: '2026-08-20T00:00:00.000Z',
    });

    const nextAttempt = 'b1b2c3d4e5f60718';
    await store.beginAttempt('batch-resumed', nextAttempt, 'owner-history', []);
    expect(store.snapshot().active).toMatchObject({
      batchId: 'batch-resumed',
      attempt: nextAttempt,
      checkpoint: { cursor: '2026-08-20T00:00:00.000Z' },
      drafts: { '2026-08-28': { rawOwnerCount: 1, qualifyingCount: 1 } },
    });
    await expect(store.recordPage('batch-first', ATTEMPT, checkpoint, [pageDraft], audit))
      .rejects.toThrow('尝试已过期');
    await store.recordPage('batch-resumed', nextAttempt, checkpoint, [pageDraft], audit);

    expect(store.snapshot().active).toMatchObject({
      batchId: 'batch-resumed',
      attempt: nextAttempt,
      checkpoint: { cursor: '2026-08-20T00:00:00.000Z' },
      drafts: { '2026-08-28': { rawOwnerCount: 1, qualifyingCount: 1 } },
    });

    const resumedCheckpoint = {
      ...checkpoint,
      cursor: '2026-08-19T00:00:00.000Z',
      oldestObservedAt: '2026-08-19T00:00:00.001Z',
    };
    await store.recordPage(
      'batch-resumed',
      nextAttempt,
      resumedCheckpoint,
      [{ ...pageDraft, day: '2026-08-27' }],
      {
        ...audit,
        oldestObservedAt: '2026-08-19T00:00:00.001Z',
      },
    );
    expect(store.snapshot().active).toMatchObject({
      checkpoint: {
        pagesFetched: 2,
        cursor: '2026-08-19T00:00:00.000Z',
      },
      audit: {
        pagesFetched: 2,
        observed: 2,
        qualifying: 2,
        exactDuplicates: 2,
        knownComplete: 2,
        newestObservedAt: '2026-08-28T01:00:00.000Z',
        oldestObservedAt: '2026-08-19T00:00:00.001Z',
      },
      drafts: {
        '2026-08-28': { rawOwnerCount: 1, qualifyingCount: 1 },
        '2026-08-27': { rawOwnerCount: 1, qualifyingCount: 1 },
      },
    });
  });

  it('refuses to finalize owner history without safe API exhaustion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zsxq-ledger-unexhausted-'));
    const store = await ZsxqDayLedgerStore.open(
      join(root, 'zsxq-day-ledger.json'),
      () => '2026-08-29T00:00:00.000Z',
    );
    await store.beginAttempt('batch-unexhausted', ATTEMPT, 'owner-history', []);
    await store.recordPage(
      'batch-unexhausted',
      ATTEMPT,
      {
        mode: 'owner-history',
        cursor: '2026-08-20T00:00:00.000Z',
        pagesFetched: 1,
        oldestObservedAt: '2026-08-20T00:00:00.001Z',
        exhausted: false,
      },
      [],
      {
        ...emptyAudit(),
        mode: 'owner-history',
        pagesFetched: 1,
        oldestObservedAt: '2026-08-20T00:00:00.001Z',
        exhausted: false,
      },
    );

    await expect(store.finalize('batch-unexhausted', ATTEMPT, { status: 'completed' }))
      .rejects.toThrow('未证明安全耗尽');
    expect(store.snapshot().days).toEqual({});
  });
});
