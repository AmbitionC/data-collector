import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NOWCODER_DIRECTED_REJECTION_MESSAGES,
  stableContentId,
  type JobRecord,
  type JobStatus,
  type NowcoderSearchCandidate,
} from '@data-collector/shared';
import { JobStore } from '../../packages/bridge/src/jobs/store.js';
import {
  NowcoderDirectedService,
  type NowcoderDirectedReconciliationContext,
  type NowcoderDirectedSelectionRecoveryResult,
} from '../../packages/bridge/src/nowcoderDirected/service.js';
import { NowcoderDirectedStore } from '../../packages/bridge/src/nowcoderDirected/store.js';
import { nowcoderDirectedJobId } from '../../packages/bridge/src/nowcoderDirected/jobIdentity.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const NOW = '2026-08-30T00:00:00.000Z';
const ATTEMPT = '0123456789abcdef';
const OLD_ATTEMPT = 'fedcba9876543210';
const RUN_EVIDENCE = {
  buildEvidence: {
    applicationVersion: '0.4.33',
    bridgeBuildId: 'v0.4.33 · abcdef1',
    artifactBuildId: 'v0.4.33 · abcdef1',
    extensionVersion: '0.4.33',
    extensionBuildId: 'v0.4.33 · abcdef1',
    extensionCapabilities: ['nowcoder-detail-v1', 'zsxq-complete-content-v2'],
    frozenAt: NOW,
  },
  runtimeId: '11111111-1111-4111-8111-111111111111',
};
const temporaryDirectories = createTemporaryDirectoryTracker();

afterEach(() => temporaryDirectories.cleanup());

function candidates(count = 30): NowcoderSearchCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `candidate-${index + 1}`,
    canonicalUrl: `https://www.nowcoder.com/feed/main/detail/recovery-${index + 1}`,
    contentType: 'post' as const,
    matchedQueries: ['Agent'],
    page: Math.floor(index / 10) + 1,
    rank: (index % 10) + 1,
    publishedAt: new Date(Date.parse('2026-08-29T23:59:00.000Z') - index * 60_000).toISOString(),
  }));
}

function jobId(url: string, attempt = ATTEMPT): string {
  return nowcoderDirectedJobId('run-recovery', attempt, url);
}

async function fixture(target = 10) {
  const root = await temporaryDirectories.create('nowcoder-directed-recovery-');
  const directedPath = join(root, 'directed.json');
  const jobsPath = join(root, 'jobs.json');
  const store = await NowcoderDirectedStore.open(directedPath, {
    now: () => NOW,
    id: () => 'run-recovery',
    attempt: () => ATTEMPT,
  });
  const frozenCandidates = candidates();
  await store.createSession({
    id: 'session-recovery',
    queries: ['Agent'],
    queryHash: 'c'.repeat(64),
    requestedSort: 'latest',
    provider: 'nowcoder-json',
    sortVerified: true,
    createdAt: NOW,
    expiresAt: '2026-08-30T00:30:00.000Z',
    candidates: frozenCandidates,
  }, { target });
  const run = await store.startRun({
    searchSessionId: 'session-recovery',
    selectedCandidateIds: [],
    idempotencyKey: 'recovery-key',
    deliveryAuthorized: true,
  }, RUN_EVIDENCE);
  const jobs = await JobStore.open(jobsPath, { now: () => NOW });
  return { root, directedPath, jobsPath, store, jobs, run, frozenCandidates };
}

async function createOwnedJob(
  jobs: JobStore,
  candidate: NowcoderSearchCandidate,
  status: JobStatus = 'queued',
  attempt = ATTEMPT,
): Promise<JobRecord> {
  let job = await jobs.create({
    id: jobId(candidate.canonicalUrl, attempt),
    url: candidate.canonicalUrl,
    requestedBy: 'codex',
    directedRunId: 'run-recovery',
    directedRunAttempt: attempt,
  });
  if (status === 'queued') return job;
  if (status === 'dispatched') return await jobs.transition(job.id, 'dispatched');
  if (status === 'collecting') {
    job = await jobs.transition(job.id, 'dispatched');
    return await jobs.transition(job.id, 'collecting');
  }
  if (status === 'saved') {
    job = await jobs.transition(job.id, 'collecting');
    const outputPath = `/tmp/${job.id}/index.md`;
    return await jobs.transition(job.id, 'saved', {
      outputPath,
      markdownOutput: { sinkId: 'markdown', outputPath },
    });
  }
  if (status === 'needs_attention') {
    job = await jobs.transition(job.id, 'dispatched');
    return await jobs.transition(job.id, 'needs_attention', { errorCode: 'LOGIN_REQUIRED' });
  }
  return await jobs.transition(job.id, 'failed', { errorCode: 'EXTRACT_FAILED' });
}

async function checkpointRound(
  context: Awaited<ReturnType<typeof fixture>>,
  consumed: number,
  roundStart: number,
  statuses: JobStatus[],
  options: { omitIndices?: ReadonlySet<number>; phase?: 'collecting' | 'selecting' | 'staging' } = {},
): Promise<string[]> {
  const currentJobIds = context.frozenCandidates.slice(0, consumed)
    .map(candidate => jobId(candidate.canonicalUrl));
  const currentRoundJobIds = context.frozenCandidates.slice(roundStart, roundStart + statuses.length)
    .map(candidate => jobId(candidate.canonicalUrl));
  const initialRejections = context.frozenCandidates.slice(0, consumed).map((candidate, index) => ({
    jobId: currentJobIds[index]!,
    url: candidate.canonicalUrl,
    code: 'DETAIL_NOT_SAVED' as const,
    message: NOWCODER_DIRECTED_REJECTION_MESSAGES.DETAIL_NOT_SAVED,
    detail: NOWCODER_DIRECTED_REJECTION_MESSAGES.DETAIL_NOT_SAVED,
  }));
  await context.store.checkpointRun(context.run.id, {
    candidateCursor: consumed,
    currentJobIds,
    currentRoundJobIds,
    accepted: 0,
    deliveryItems: [],
    privateRejections: initialRejections,
    progress: {
      discovered: context.frozenCandidates.length,
      detailScheduled: consumed,
      detailSaved: 0,
      inspected: 0,
      qualified: 0,
      accepted: 0,
      delivered: 0,
      rejectionCounts: consumed === 0 ? [] : [{
        code: 'DETAIL_NOT_SAVED',
        message: NOWCODER_DIRECTED_REJECTION_MESSAGES.DETAIL_NOT_SAVED,
        count: consumed,
      }],
      companies: [
        { company: 'bytedance', count: 0 },
        { company: 'tencent', count: 0 },
        { company: 'alibaba', count: 0 },
        { company: 'ant', count: 0 },
        { company: 'other', count: 0 },
      ],
    },
    ...(options.phase && options.phase !== 'selecting' ? { phase: options.phase } : {}),
  });
  for (let index = 0; index < consumed; index += 1) {
    if (options.omitIndices?.has(index)) continue;
    const roundOffset = index - roundStart;
    const status = roundOffset >= 0 && roundOffset < statuses.length
      ? statuses[roundOffset]!
      : 'saved';
    await createOwnedJob(context.jobs, context.frozenCandidates[index]!, status);
  }
  if (options.phase === 'selecting') {
    const privateRejections = currentJobIds.map(id => {
      const job = context.jobs.get(id)!;
      const code = job.status === 'failed'
        ? 'DETAIL_FAILED' as const
        : job.status === 'needs_attention'
          ? 'DETAIL_NEEDS_ATTENTION' as const
          : 'DETAIL_NOT_SAVED' as const;
      return {
        jobId: id,
        url: job.url,
        code,
        message: NOWCODER_DIRECTED_REJECTION_MESSAGES[code],
        detail: NOWCODER_DIRECTED_REJECTION_MESSAGES[code],
      };
    });
    const byCode = new Map<string, number>();
    for (const rejection of privateRejections) {
      byCode.set(rejection.code, (byCode.get(rejection.code) ?? 0) + 1);
    }
    await context.store.checkpointRun(context.run.id, {
      phase: 'selecting',
      accepted: 0,
      deliveryItems: [],
      privateRejections,
      progress: {
        discovered: context.frozenCandidates.length,
        detailScheduled: consumed,
        detailSaved: 0,
        inspected: 0,
        qualified: 0,
        accepted: 0,
        delivered: 0,
        rejectionCounts: [...byCode.entries()].sort(([left], [right]) => left.localeCompare(right))
          .map(([code, count]) => ({
            code: code as keyof typeof NOWCODER_DIRECTED_REJECTION_MESSAGES,
            message: NOWCODER_DIRECTED_REJECTION_MESSAGES[code as keyof typeof NOWCODER_DIRECTED_REJECTION_MESSAGES],
            count,
          })),
        companies: [
          { company: 'bytedance', count: 0 },
          { company: 'tencent', count: 0 },
          { company: 'alibaba', count: 0 },
          { company: 'ant', count: 0 },
          { company: 'other', count: 0 },
        ],
      },
    });
  }
  return currentRoundJobIds;
}

async function reopen(
  context: Awaited<ReturnType<typeof fixture>>,
  selectionOverride?: (
    input: NowcoderDirectedReconciliationContext,
    store: NowcoderDirectedStore,
  ) => Promise<NowcoderDirectedSelectionRecoveryResult>,
) {
  const store = await NowcoderDirectedStore.open(context.directedPath, { now: () => NOW });
  const jobs = await JobStore.open(context.jobsPath, { now: () => NOW });
  const dispatched: string[] = [];
  const reconcileSelection = vi.fn(async (input: NowcoderDirectedReconciliationContext) =>
    selectionOverride ? await selectionOverride(input, store) : { state: 'paused' as const });
  const recoverPublisher = vi.fn(async () => undefined);
  const service = new NowcoderDirectedService({
    store,
    jobs,
    dispatch: async job => { dispatched.push(job.id); },
    reconcileSelection,
    recoverPublisher,
  });
  return { store, jobs, service, dispatched, reconcileSelection, recoverPublisher };
}

describe('directed Nowcoder restart reconciliation', () => {
  it('invokes initial fill recovery once for an unchanged empty collecting checkpoint', async () => {
    const context = await fixture();
    const before = context.store.reconciliationSnapshots()[0];
    const recovery = await reopen(context);

    await recovery.service.reconcileAll();
    await recovery.service.reconcileAll();

    expect(recovery.reconcileSelection).toHaveBeenCalledTimes(2);
    expect(recovery.reconcileSelection.mock.calls[0]![0]).toMatchObject({
      run: {
        phase: 'collecting',
        candidateCursor: 0,
        currentJobIds: [],
        currentRoundJobIds: [],
      },
      jobs: [],
    });
    expect(recovery.store.reconciliationSnapshots()[0]).toEqual(before);
    expect(recovery.dispatched).toEqual([]);
  });

  it('requeues only unfinished current-attempt jobs in a first round', async () => {
    const context = await fixture();
    const round = await checkpointRound(
      context,
      4,
      0,
      ['saved', 'dispatched', 'collecting', 'queued'],
    );
    const old = await createOwnedJob(context.jobs, context.frozenCandidates[1]!, 'collecting', OLD_ATTEMPT);
    const recovery = await reopen(context);

    await recovery.service.reconcileAll();

    expect(recovery.dispatched).toEqual(round.slice(1));
    expect(recovery.jobs.get(round[0]!)?.status).toBe('saved');
    expect(recovery.jobs.get(old.id)?.status).toBe('collecting');
    expect(recovery.store.reconciliationSnapshots()[0]).toMatchObject({
      phase: 'collecting',
      candidateCursor: 4,
      currentJobIds: round,
      currentRoundJobIds: round,
    });
    expect(recovery.jobs.list()).toHaveLength(5);
    expect(recovery.reconcileSelection).not.toHaveBeenCalled();
    expect(recovery.recoverPublisher).not.toHaveBeenCalled();
  });

  it('recovers only the unfinished refill round without duplicating prior or terminal jobs', async () => {
    const context = await fixture();
    const round = await checkpointRound(
      context,
      12,
      8,
      ['saved', 'failed', 'needs_attention', 'collecting'],
    );
    const historical = await context.jobs.create({
      id: 'historical-not-owned',
      url: 'https://www.nowcoder.com/feed/main/detail/historical',
      requestedBy: 'codex',
    });
    const recovery = await reopen(context);

    await recovery.service.reconcileAll();

    expect(recovery.dispatched).toEqual([round[3]]);
    expect(recovery.jobs.list()).toHaveLength(13);
    expect(recovery.store.reconciliationSnapshots()[0]).toMatchObject({
      phase: 'collecting',
      candidateCursor: 12,
      currentRoundJobIds: round,
    });
    expect(recovery.store.reconciliationSnapshots()[0]!.currentJobIds).not.toContain(historical.id);
    expect(recovery.reconcileSelection).not.toHaveBeenCalled();
  });

  it('recreates a checkpointed current-round job after a crash before JobStore creation', async () => {
    const context = await fixture();
    const round = await checkpointRound(
      context,
      4,
      0,
      ['queued', 'queued', 'queued', 'queued'],
      { omitIndices: new Set([3]) },
    );
    const recovery = await reopen(context);

    await recovery.service.reconcileAll();

    expect(recovery.jobs.get(round[3]!)).toMatchObject({
      id: round[3],
      directedRunId: context.run.id,
      directedRunAttempt: ATTEMPT,
      status: 'queued',
    });
    expect(recovery.dispatched).toEqual(round);
    expect(recovery.jobs.list()).toHaveLength(4);
  });

  it('advances an all-terminal collecting checkpoint once into deterministic selection', async () => {
    const context = await fixture();
    await checkpointRound(context, 4, 0, ['saved', 'failed', 'needs_attention', 'saved']);
    const recovery = await reopen(context);

    await recovery.service.reconcileAll();
    await recovery.service.reconcileAll();

    expect(recovery.store.getRun(context.run.id)?.phase).toBe('selecting');
    expect(recovery.reconcileSelection).toHaveBeenCalledTimes(2);
    expect(recovery.reconcileSelection.mock.calls[0]![0].jobs).toHaveLength(4);
    expect(recovery.store.reconciliationSnapshots()[0]?.candidateCursor).toBe(4);
    expect(recovery.dispatched).toEqual([]);
  });

  it('does nothing at seven-of-eight terminal and selects once when the last job terminates', async () => {
    const context = await fixture(7);
    const round = await checkpointRound(
      context,
      8,
      0,
      [...Array<JobStatus>(7).fill('saved'), 'collecting'],
    );
    const recovery = await reopen(context);

    await recovery.service.reconcileAll();
    expect(recovery.reconcileSelection).not.toHaveBeenCalled();
    await recovery.jobs.transition(round[7]!, 'collecting');
    const last = await recovery.jobs.transition(round[7]!, 'saved', {
      outputPath: `/tmp/${round[7]!}/index.md`,
    });
    await recovery.service.onJobTerminal(last);

    expect(recovery.reconcileSelection).toHaveBeenCalledOnce();
    expect(recovery.reconcileSelection.mock.calls[0]![0].jobs).toHaveLength(8);
    expect(recovery.store.getRun(context.run.id)?.phase).toBe('selecting');
  });

  it('reruns a persisted selecting checkpoint once without searching or changing the cursor', async () => {
    const context = await fixture();
    await checkpointRound(context, 4, 0, ['saved', 'failed', 'needs_attention', 'saved'], {
      phase: 'selecting',
    });
    const recovery = await reopen(context);

    await recovery.service.reconcileAll();
    await recovery.service.reconcileAll();

    expect(recovery.reconcileSelection).toHaveBeenCalledTimes(2);
    expect(recovery.store.reconciliationSnapshots()[0]).toMatchObject({
      phase: 'selecting',
      candidateCursor: 4,
    });
    expect(recovery.dispatched).toEqual([]);
  });

  it('caches only an explicit committed fingerprint for the same selecting checkpoint', async () => {
    const context = await fixture();
    await checkpointRound(context, 4, 0, Array<JobStatus>(4).fill('saved'), { phase: 'selecting' });
    const recovery = await reopen(context, async (input, store) => {
      await store.checkpointCurrentRun(input.run.id, input.run.attempt, {
        progress: { ...input.run.progress, detailSaved: 4 },
      });
      return {
        state: 'committed',
        checkpointFingerprint: store.selectionCheckpointFingerprint(input.run.id, input.run.attempt)!,
      };
    });

    await recovery.service.reconcileAll();
    await recovery.service.reconcileAll();

    expect(recovery.reconcileSelection).toHaveBeenCalledOnce();
  });

  it('rejects a claimed commit without a durable fingerprint change and never caches it', async () => {
    const context = await fixture();
    await checkpointRound(context, 4, 0, Array<JobStatus>(4).fill('saved'), { phase: 'selecting' });
    const recovery = await reopen(context, async (input, store) => ({
      state: 'committed',
      checkpointFingerprint: store.selectionCheckpointFingerprint(input.run.id, input.run.attempt)!,
    }));

    await expect(recovery.service.reconcileAll()).rejects.toThrow('未提交声明的持久检查点');
    await expect(recovery.service.reconcileAll()).rejects.toThrow('未提交声明的持久检查点');
    expect(recovery.reconcileSelection).toHaveBeenCalledTimes(2);
  });

  it('invokes selection again for a later refill checkpoint while deduping each checkpoint', async () => {
    const context = await fixture();
    await checkpointRound(context, 8, 0, Array<JobStatus>(8).fill('saved'));
    const recovery = await reopen(context);

    await recovery.service.reconcileAll();
    await recovery.service.reconcileAll();
    const futureCandidates = context.frozenCandidates.slice(0, 12);
    const refill = await recovery.service.enqueueRound(context.run.id, ATTEMPT, 4, {
      accepted: 0,
      deliveryItems: [],
      privateRejections: futureCandidates.map(candidate => ({
        jobId: jobId(candidate.canonicalUrl),
        url: candidate.canonicalUrl,
        code: 'DETAIL_NOT_SAVED',
        message: NOWCODER_DIRECTED_REJECTION_MESSAGES.DETAIL_NOT_SAVED,
        detail: NOWCODER_DIRECTED_REJECTION_MESSAGES.DETAIL_NOT_SAVED,
      })),
      progress: {
        discovered: 30,
        detailScheduled: 12,
        detailSaved: 0,
        inspected: 0,
        qualified: 0,
        accepted: 0,
        delivered: 0,
        rejectionCounts: [{
          code: 'DETAIL_NOT_SAVED',
          message: NOWCODER_DIRECTED_REJECTION_MESSAGES.DETAIL_NOT_SAVED,
          count: 12,
        }],
        companies: [
          { company: 'bytedance', count: 0 },
          { company: 'tencent', count: 0 },
          { company: 'alibaba', count: 0 },
          { company: 'ant', count: 0 },
          { company: 'other', count: 0 },
        ],
      },
    });
    for (const job of refill) {
      await recovery.jobs.transition(job.id, 'collecting');
      await recovery.jobs.transition(job.id, 'saved', {
        outputPath: `/tmp/${job.id}/index.md`,
      });
    }
    await recovery.service.reconcileAll();
    await recovery.service.reconcileAll();

    expect(recovery.reconcileSelection).toHaveBeenCalledTimes(4);
    expect(recovery.reconcileSelection.mock.calls.map(call => call[0].run.candidateCursor))
      .toEqual([8, 8, 12, 12]);
  });

  it.each(['staging', 'publishing'] as const)(
    'delegates a persisted %s checkpoint exactly once to publisher recovery',
    async phase => {
      const context = await fixture(4);
      const ids = await checkpointRound(context, 4, 0, Array<JobStatus>(4).fill('saved'));
      await context.store.checkpointRun(context.run.id, {
        phase: 'staging',
        accepted: 4,
        progress: {
          discovered: 30,
          detailScheduled: 4,
          detailSaved: 4,
          inspected: 4,
          qualified: 4,
          accepted: 4,
          delivered: 0,
          rejectionCounts: [],
          companies: [
            { company: 'bytedance', count: 0 },
            { company: 'tencent', count: 0 },
            { company: 'alibaba', count: 0 },
            { company: 'ant', count: 0 },
            { company: 'other', count: 4 },
          ],
        },
        deliveryItems: ids.map((id, index) => ({
          jobId: id,
          stableContentId: stableContentId(context.frozenCandidates[index]!.canonicalUrl),
          canonicalUrl: context.frozenCandidates[index]!.canonicalUrl,
          contentHash: `${index}`.repeat(16),
          clusterId: `cluster-${index}`,
        })),
        privateRejections: [],
      });
      if (phase === 'publishing') {
        await context.store.beginPublishingCurrent(context.run.id, context.run.attempt);
      }
      const recovery = await reopen(context);

      await recovery.service.reconcileAll();
      await recovery.service.reconcileAll();

      expect(recovery.recoverPublisher).toHaveBeenCalledOnce();
      expect(recovery.recoverPublisher.mock.calls[0]![0].run.phase).toBe(phase);
      expect(recovery.reconcileSelection).not.toHaveBeenCalled();
      expect(recovery.dispatched).toEqual([]);
    },
  );

  it.each(['collecting', 'selecting', 'staging'] as const)(
    'routes a cancelling %s checkpoint to bounded convergence before phase recovery',
    async phase => {
      const context = await fixture(4);
      const ids = await checkpointRound(
        context,
        4,
        0,
        Array<JobStatus>(4).fill(phase === 'collecting' ? 'queued' : 'saved'),
        phase === 'selecting' ? { phase: 'selecting' } : {},
      );
      if (phase === 'staging') {
        await context.store.checkpointRun(context.run.id, {
          phase: 'staging',
          accepted: 4,
          progress: {
            discovered: 30,
            detailScheduled: 4,
            detailSaved: 4,
            inspected: 4,
            qualified: 4,
            accepted: 4,
            delivered: 0,
            rejectionCounts: [],
            companies: [
              { company: 'bytedance', count: 0 },
              { company: 'tencent', count: 0 },
              { company: 'alibaba', count: 0 },
              { company: 'ant', count: 0 },
              { company: 'other', count: 4 },
            ],
          },
          deliveryItems: ids.map((id, index) => ({
            jobId: id,
            stableContentId: stableContentId(context.frozenCandidates[index]!.canonicalUrl),
            canonicalUrl: context.frozenCandidates[index]!.canonicalUrl,
            contentHash: `${index}`.repeat(16),
            clusterId: `cluster-${index}`,
          })),
          privateRejections: [],
        });
      }
      if (phase !== 'collecting') {
        for (const id of ids) {
          await context.store.recordDispatchedJobCurrent(context.run.id, ATTEMPT, id);
          await context.store.recordTabClearEvidenceCurrent(
            context.run.id,
            ATTEMPT,
            id,
            'remote_terminal_after_close',
          );
        }
      }
      await context.store.beginCancellationCurrent(context.run.id, ATTEMPT);
      const recovery = await reopen(context);

      await recovery.service.initialize();
      await recovery.service.reconcileAll();
      await recovery.service.observeExtensionEvidence();

      expect(recovery.store.reconciliationSnapshots()).toEqual([]);
      expect(recovery.store.getRun(context.run.id)).toMatchObject({
        id: context.run.id,
        status: 'cancelled',
        phase,
        accepted: 0,
        delivered: 0,
        progress: {
          detailScheduled: 4,
          detailSaved: phase === 'collecting' ? 0 : 4,
          inspected: phase === 'staging' ? 4 : 0,
          qualified: 0,
          accepted: 0,
          delivered: 0,
          rejectionCounts: [],
        },
      });
      expect(recovery.reconcileSelection).not.toHaveBeenCalled();
      expect(recovery.recoverPublisher).not.toHaveBeenCalled();
      expect(recovery.dispatched).toEqual([]);
    },
  );

  it('never exceeds 24 jobs or attaches an uncheckpointed same-attempt job', async () => {
    const context = await fixture();
    await checkpointRound(
      context,
      24,
      20,
      ['saved', 'failed', 'needs_attention', 'saved'],
    );
    const unattached = await createOwnedJob(context.jobs, context.frozenCandidates[24]!, 'saved');
    const recovery = await reopen(context);

    await recovery.service.reconcileAll();
    const added = await recovery.service.enqueueRound(context.run.id, ATTEMPT, 4);

    expect(added).toEqual([]);
    const snapshot = recovery.store.reconciliationSnapshots()[0]!;
    expect(snapshot.candidateCursor).toBe(24);
    expect(snapshot.currentJobIds).toHaveLength(24);
    expect(snapshot.currentJobIds).not.toContain(unattached.id);
    expect(snapshot.frozenCandidates).toHaveLength(30);
  });

  it('rejects a cursor checkpoint beyond the fixed 24-detail budget', async () => {
    const context = await fixture();

    await expect(context.store.checkpointRun(context.run.id, {
      candidateCursor: 25,
    })).rejects.toThrow(/24|预算|游标/);
    expect(context.store.reconciliationSnapshots()[0]?.candidateCursor).toBe(0);
  });

  it('rejects a non-derived current job before it can become a recovery checkpoint', async () => {
    const context = await fixture();
    const valid = await checkpointRound(context, 1, 0, ['saved']);
    const unrelatedUrl = 'https://www.nowcoder.com/feed/main/detail/not-in-frozen-run';
    const unrelated = await context.jobs.create({
      id: jobId(unrelatedUrl),
      url: unrelatedUrl,
      requestedBy: 'codex',
      directedRunId: context.run.id,
      directedRunAttempt: ATTEMPT,
    });
    await context.jobs.transition(unrelated.id, 'collecting');
    await context.jobs.transition(unrelated.id, 'saved', {
      outputPath: `/tmp/${unrelated.id}/index.md`,
    });
    await expect(context.store.checkpointRun(context.run.id, {
      phase: 'selecting',
      currentJobIds: [...valid, unrelated.id],
      currentRoundJobIds: valid,
    })).rejects.toThrow(/状态文件|冻结候选|任务归属/);
    expect(context.store.reconciliationSnapshots()[0]).toMatchObject({
      phase: 'collecting',
      candidateCursor: 1,
      currentJobIds: valid,
      currentRoundJobIds: valid,
    });
  });
});
