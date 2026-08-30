import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  NOWCODER_DIRECTED_REJECTION_MESSAGES,
  stableContentId,
  type JobRecord,
  type NowcoderSearchCandidate,
} from '@data-collector/shared';
import { JobStore } from '../../packages/bridge/src/jobs/store.js';
import { nowcoderDirectedJobId } from '../../packages/bridge/src/nowcoderDirected/jobIdentity.js';
import { NowcoderDirectedService } from '../../packages/bridge/src/nowcoderDirected/service.js';
import { NowcoderDirectedStore } from '../../packages/bridge/src/nowcoderDirected/store.js';

const NOW = '2026-08-30T00:00:00.000Z';
const ATTEMPT = '0123456789abcdef';
const EVIDENCE = {
  buildEvidence: {
    applicationVersion: '0.4.33',
    bridgeBuildId: 'v0.4.33 · cancel',
    artifactBuildId: 'v0.4.33 · cancel',
    extensionVersion: '0.4.33',
    extensionBuildId: 'v0.4.33 · cancel',
    extensionCapabilities: ['nowcoder-detail-v1', 'zsxq-complete-content-v2'],
    frozenAt: NOW,
  },
  runtimeId: '11111111-1111-4111-8111-111111111111',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function candidates(): NowcoderSearchCandidate[] {
  return [1, 2].map(index => ({
    id: `candidate-${index}`,
    canonicalUrl: `https://www.nowcoder.com/feed/main/detail/cancel-${index}`,
    contentType: 'post',
    matchedQueries: ['Agent'],
    page: 1,
    rank: index,
    publishedAt: `2026-08-${30 - index}T00:00:00.000Z`,
  }));
}

function pendingAudit(run: { id: string; attempt: string }, count: number) {
  const selected = candidates().slice(0, count);
  const ids = selected.map(candidate =>
    nowcoderDirectedJobId(run.id, run.attempt, candidate.canonicalUrl));
  const message = NOWCODER_DIRECTED_REJECTION_MESSAGES.DETAIL_NOT_SAVED;
  return {
    ids,
    checkpoint: {
      phase: 'collecting' as const,
      candidateCursor: count,
      currentJobIds: ids,
      currentRoundJobIds: ids,
      accepted: 0,
      deliveryItems: [],
      privateRejections: selected.map((candidate, index) => ({
        jobId: ids[index]!,
        url: candidate.canonicalUrl,
        code: 'DETAIL_NOT_SAVED' as const,
        message,
        detail: message,
      })),
      progress: {
        discovered: 2,
        detailScheduled: count,
        detailSaved: 0,
        inspected: 0,
        qualified: 0,
        accepted: 0,
        delivered: 0,
        rejectionCounts: count === 0 ? [] : [{
          code: 'DETAIL_NOT_SAVED' as const,
          message,
          count,
        }],
        companies: [
          { company: 'bytedance' as const, count: 0 },
          { company: 'tencent' as const, count: 0 },
          { company: 'alibaba' as const, count: 0 },
          { company: 'ant' as const, count: 0 },
          { company: 'other' as const, count: 0 },
        ],
      },
    },
  };
}

async function fixture(count: 0 | 1 | 2) {
  const root = await mkdtemp(join(tmpdir(), 'nowcoder-directed-cancel-'));
  const store = await NowcoderDirectedStore.open(join(root, 'directed.json'), {
    now: () => NOW,
    id: () => 'run-cancel',
    attempt: () => ATTEMPT,
  });
  await store.createSession({
    id: 'session-cancel',
    queries: ['Agent'],
    queryHash: 'a'.repeat(64),
    requestedSort: 'latest',
    provider: 'nowcoder-json',
    sortVerified: true,
    createdAt: NOW,
    expiresAt: '2026-08-30T00:30:00.000Z',
    candidates: candidates(),
  }, { target: 2 });
  const run = await store.startRun({
    searchSessionId: 'session-cancel',
    selectedCandidateIds: [],
    idempotencyKey: 'cancel-start',
    deliveryAuthorized: true,
  }, EVIDENCE);
  const jobs = await JobStore.open(join(root, 'jobs.json'), { now: () => NOW });
  const { ids, checkpoint } = pendingAudit(run, count);
  if (count > 0) {
    await store.checkpointCurrentRun(run.id, run.attempt, checkpoint);
    await jobs.setDirectedAttemptPins(run.id, run.attempt, ids);
    for (const [index, id] of ids.entries()) {
      await jobs.create({
        id,
        url: candidates()[index]!.canonicalUrl,
        requestedBy: 'codex',
        directedRunId: run.id,
        directedRunAttempt: run.attempt,
      });
    }
  }
  const cancels: Array<{ id: string; runId: string; attempt: string }> = [];
  const acks: JobRecord[] = [];
  const readerRelease = vi.fn(async () => undefined);
  const service = new NowcoderDirectedService({
    store,
    jobs,
    dispatch: async () => undefined,
    artifactReaders: {
      tryBeginStart: () => undefined,
      tryBeginUpdate: () => undefined,
      acquireReader: async () => ({ release: readerRelease }),
      snapshot: () => ({
        startIntents: 0,
        pendingReaders: 0,
        activeReaders: 1,
        updateState: 'idle',
      }),
      setOnIdle: () => undefined,
      close: async () => undefined,
    },
    sendCancel: async job => {
      cancels.push({ id: job.id, runId: job.directedRunId!, attempt: job.directedRunAttempt! });
    },
    acknowledgeTerminal: async job => { acks.push(job); },
    ownedTabsClear: async snapshot => store.hasCompleteTabClearEvidence(
      snapshot.id,
      snapshot.attempt,
    ),
  });
  return { store, jobs, run, ids, service, cancels, acks, readerRelease };
}

describe('bounded persisted directed cancellation', () => {
  it('cancels before first dispatch with local never-dispatched proof and no remote frame', async () => {
    const context = await fixture(1);

    const cancelled = await context.service.cancelRun(context.run.id, context.run.attempt);

    expect(cancelled).toMatchObject({
      status: 'cancelled',
      phase: 'collecting',
      accepted: 0,
      delivered: 0,
      progress: { detailScheduled: 1, detailSaved: 0, inspected: 0, qualified: 0 },
    });
    expect(context.cancels).toEqual([]);
    expect(context.jobs.get(context.ids[0]!)?.status).toBe('failed');
    expect(context.acks).toHaveLength(1);
    expect(context.readerRelease).toHaveBeenCalledOnce();
    expect(context.store.reconciliationSnapshots()).toEqual([]);
  });

  it('persists dispatch before collect, sends exact cancellation, and converges after two close proofs', async () => {
    const context = await fixture(2);
    const collectFrames: string[] = [];
    for (const id of context.ids) {
      const job = context.jobs.get(id)!;
      await context.service.dispatchCurrent(job, () => { collectFrames.push(id); });
    }

    const cancelling = context.service.cancelRun(context.run.id, context.run.attempt);
    await vi.waitFor(() => expect(context.cancels).toHaveLength(2));
    expect(context.store.getRun(context.run.id)?.status).toBe('cancelling');
    expect(collectFrames).toEqual(context.ids);
    expect(context.cancels).toEqual(context.ids.map(id => ({
      id,
      runId: context.run.id,
      attempt: context.run.attempt,
    })));

    await context.service.onCancellationTerminal(
      context.jobs.get(context.ids[0]!)!,
      'cancelled_after_close',
    );
    expect(context.store.getRun(context.run.id)?.status).toBe('cancelling');
    await context.service.onCancellationTerminal(
      context.jobs.get(context.ids[1]!)!,
      'remote_terminal_after_close',
    );
    await cancelling;

    expect(context.store.getRun(context.run.id)?.status).toBe('cancelled');
    expect(context.jobs.get(context.ids[0]!)?.status).toBe('failed');
    expect(context.jobs.get(context.ids[1]!)?.status).toBe('failed');
    expect(new Set(context.acks.map(job => job.id))).toEqual(new Set(context.ids));
    expect(context.acks.length).toBeGreaterThanOrEqual(2);
  });

  it('cancels between dispatches without deadlocking the run barrier or sending a later collect', async () => {
    const context = await fixture(0);
    const secondDispatchEntered = deferred<void>();
    const allowSecondDispatch = deferred<void>();
    const collectFrames: string[] = [];
    const cancels: string[] = [];
    let dispatchCalls = 0;
    let service!: NowcoderDirectedService;
    service = new NowcoderDirectedService({
      store: context.store,
      jobs: context.jobs,
      dispatch: async job => {
        dispatchCalls += 1;
        if (dispatchCalls === 2) {
          secondDispatchEntered.resolve();
          await allowSecondDispatch.promise;
        }
        await service.dispatchCurrent(job, () => { collectFrames.push(job.id); });
      },
      sendCancel: async job => { cancels.push(job.id); },
      acknowledgeTerminal: async () => undefined,
      ownedTabsClear: async snapshot => context.store.hasCompleteTabClearEvidence(
        snapshot.id,
        snapshot.attempt,
      ),
    });

    const refill = service.enqueueRound(context.run.id, context.run.attempt, 2);
    await secondDispatchEntered.promise;
    const cancellation = service.cancelRun(context.run.id, context.run.attempt);
    await vi.waitFor(() => {
      expect(context.store.getRun(context.run.id)?.status).toBe('cancelling');
    });
    allowSecondDispatch.resolve();
    await vi.waitFor(() => expect(cancels).toHaveLength(1), { timeout: 500 });

    const snapshot = context.store.reconciliationSnapshots()[0]!;
    await service.onCancellationTerminal(
      context.jobs.get(collectFrames[0]!)!,
      'cancelled_after_close',
    );
    await Promise.all([refill, cancellation]);

    expect(collectFrames).toEqual([snapshot.currentJobIds[0]]);
    expect(cancels).toEqual([snapshot.currentJobIds[0]]);
    expect(context.jobs.get(snapshot.currentJobIds[1]!)?.status).toBe('failed');
    expect(context.store.getRun(context.run.id)?.status).toBe('cancelled');
  });

  it('recovers proof-before-JobStore after restart without redispatch and re-acks the durable terminal', async () => {
    const context = await fixture(1);
    const job = context.jobs.get(context.ids[0]!)!;
    await context.service.dispatchCurrent(job, () => undefined);
    await context.store.beginCancellationCurrent(context.run.id, context.run.attempt);
    await context.store.recordTabClearEvidenceCurrent(
      context.run.id,
      context.run.attempt,
      job.id,
      'cancelled_after_close',
    );
    const dispatch = vi.fn(async () => undefined);
    const acknowledge = vi.fn(async () => undefined);
    const restarted = new NowcoderDirectedService({
      store: context.store,
      jobs: context.jobs,
      dispatch,
      sendCancel: vi.fn(async () => undefined),
      acknowledgeTerminal: acknowledge,
      ownedTabsClear: async snapshot => context.store.hasCompleteTabClearEvidence(
        snapshot.id,
        snapshot.attempt,
      ),
    });

    await restarted.initialize();

    expect(dispatch).not.toHaveBeenCalled();
    expect(context.jobs.get(job.id)).toMatchObject({ status: 'failed', errorCode: 'CANCELLED' });
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(context.store.getRun(context.run.id)?.status).toBe('cancelled');
  });

  it('re-acknowledges a proven normal terminal after reconnect without replaying its collect', async () => {
    const context = await fixture(1);
    const job = context.jobs.get(context.ids[0]!)!;
    await context.service.dispatchCurrent(job, () => undefined);
    await context.store.recordTabClearEvidenceCurrent(
      context.run.id,
      context.run.attempt,
      job.id,
      'remote_terminal_after_close',
    );
    await context.jobs.transition(job.id, 'dispatched');
    await context.jobs.transition(job.id, 'collecting');
    const outputPath = `/tmp/${job.id}/index.md`;
    const saved = await context.jobs.transition(job.id, 'saved', {
      outputPath,
      markdownOutput: { sinkId: 'markdown', outputPath },
    });
    const dispatch = vi.fn(async () => undefined);
    const acknowledge = vi.fn(async () => undefined);
    const restarted = new NowcoderDirectedService({
      store: context.store,
      jobs: context.jobs,
      dispatch,
      acknowledgeTerminal: acknowledge,
    });

    await restarted.initialize();

    expect(dispatch).not.toHaveBeenCalled();
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(acknowledge).toHaveBeenCalledWith(expect.objectContaining({
      id: saved.id,
      status: 'saved',
    }));
  });

  it('cancels immediately before refill without growing the persisted prefix, even while offline', async () => {
    const context = await fixture(1);
    const liveEvidenceEntered = deferred<void>();
    const liveEvidence = deferred<{
      applicationVersion: string;
      extensionOnline: boolean;
      observedAt: string;
    }>();
    const dispatch = vi.fn(async () => undefined);
    const service = new NowcoderDirectedService({
      store: context.store,
      jobs: context.jobs,
      dispatch,
      liveEvidence: async () => {
        liveEvidenceEntered.resolve();
        return await liveEvidence.promise;
      },
      ownedTabsClear: async snapshot => context.store.hasCompleteTabClearEvidence(
        snapshot.id,
        snapshot.attempt,
      ),
    });

    const refill = service.enqueueRound(context.run.id, context.run.attempt, 1);
    await liveEvidenceEntered.promise;
    const cancellation = service.cancelRun(context.run.id, context.run.attempt);
    await vi.waitFor(() => {
      expect(context.store.getRun(context.run.id)?.status).toBe('cancelling');
    });
    liveEvidence.resolve({
      applicationVersion: '0.4.33',
      extensionOnline: false,
      observedAt: NOW,
    });

    expect(await refill).toEqual([]);
    const cancelled = await cancellation;
    expect(dispatch).not.toHaveBeenCalled();
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      scheduledCandidateIds: ['candidate-1'],
      progress: { detailScheduled: 1 },
    });
  });

  it('aborts exact selection before its staging checkpoint and never enters the publisher', async () => {
    const context = await fixture(2);
    await context.store.checkpointCurrentRun(context.run.id, context.run.attempt, {
      phase: 'selecting',
    });
    const selectionEntered = deferred<void>();
    let signalObserved = false;
    let stagingRejected = false;
    const recoverPublisher = vi.fn(async () => undefined);
    const service = new NowcoderDirectedService({
      store: context.store,
      jobs: context.jobs,
      dispatch: async () => undefined,
      reconcileSelection: async selection => {
        selectionEntered.resolve();
        await new Promise<void>(resolve => {
          selection.signal!.addEventListener('abort', () => resolve(), { once: true });
        });
        signalObserved = selection.signal!.aborted;
        try {
          await context.store.checkpointCurrentRun(context.run.id, context.run.attempt, {
            phase: 'staging',
            accepted: 2,
            progress: {
              discovered: 2,
              detailScheduled: 2,
              detailSaved: 2,
              inspected: 2,
              qualified: 2,
              accepted: 2,
              delivered: 0,
              rejectionCounts: [],
              companies: [
                { company: 'bytedance', count: 0 }, { company: 'tencent', count: 0 },
                { company: 'alibaba', count: 0 }, { company: 'ant', count: 0 },
                { company: 'other', count: 2 },
              ],
            },
            deliveryItems: candidates().map((candidate, index) => ({
              jobId: context.ids[index]!,
              stableContentId: stableContentId(candidate.canonicalUrl),
              canonicalUrl: candidate.canonicalUrl,
              contentHash: `${index + 7}`.repeat(16),
              clusterId: `cancel-selection-${index}`,
            })),
            privateRejections: [],
          });
        } catch {
          stagingRejected = true;
        }
        return { state: 'paused' };
      },
      recoverPublisher,
      ownedTabsClear: async snapshot => context.store.hasCompleteTabClearEvidence(
        snapshot.id,
        snapshot.attempt,
      ),
    });

    const selection = service.reconcileAll();
    await selectionEntered.promise;
    const cancellation = service.cancelRun(context.run.id, context.run.attempt);
    await Promise.all([selection, cancellation]);

    expect(signalObserved).toBe(true);
    expect(stagingRejected).toBe(true);
    expect(recoverPublisher).not.toHaveBeenCalled();
    expect(context.store.getRun(context.run.id)).toMatchObject({
      status: 'cancelled',
      phase: 'selecting',
      accepted: 0,
      delivered: 0,
      deliveryIds: [],
      publicDeliveryItems: [],
    });
  });

  it('fences wrong/repeated attempts and refuses cancellation after publishing wins', async () => {
    const context = await fixture(1);
    await expect(context.service.cancelRun(context.run.id, 'fedcba9876543210'))
      .rejects.toThrow(/过期|attempt/u);
    const first = await context.service.cancelRun(context.run.id, context.run.attempt);
    const repeated = await context.service.cancelRun(context.run.id, context.run.attempt);
    expect(repeated).toEqual(first);

    const publishing = await fixture(2);
    const audit = pendingAudit(publishing.run, 2).checkpoint;
    await publishing.store.checkpointCurrentRun(publishing.run.id, publishing.run.attempt, {
      ...audit,
      phase: 'staging',
      accepted: 2,
      progress: {
        ...audit.progress,
        detailSaved: 2,
        inspected: 2,
        qualified: 2,
        accepted: 2,
        rejectionCounts: [],
        companies: [
          { company: 'bytedance', count: 0 }, { company: 'tencent', count: 0 },
          { company: 'alibaba', count: 0 }, { company: 'ant', count: 0 },
          { company: 'other', count: 2 },
        ],
      },
      deliveryItems: candidates().map((candidate, index) => ({
        jobId: publishing.ids[index]!,
        stableContentId: stableContentId(candidate.canonicalUrl),
        canonicalUrl: candidate.canonicalUrl,
        contentHash: `${index + 1}`.repeat(16),
        clusterId: `cluster-${index}`,
      })),
      privateRejections: [],
    });
    await publishing.store.beginPublishingCurrent(publishing.run.id, publishing.run.attempt);
    await expect(publishing.service.cancelRun(publishing.run.id, publishing.run.attempt))
      .rejects.toThrow(/取消|截止点|状态/u);
  });
});
