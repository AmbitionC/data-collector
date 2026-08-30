import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_VERSION,
  NOWCODER_DETAIL_CAPABILITY,
  ZSXQ_COMPLETE_CONTENT_CAPABILITY,
  stableContentId,
  type NowcoderDirectedBuildEvidence,
  type NowcoderDirectedRun,
  type NowcoderSearchCandidate,
} from '@data-collector/shared';
import {
  ArtifactReaderCoordinator,
  type ArtifactReaderCoordinatorLike,
} from '../../packages/bridge/src/artifactReaderCoordinator.js';
import { JobStore } from '../../packages/bridge/src/jobs/store.js';
import {
  NowcoderDirectedBoundaryError,
  NowcoderDirectedService,
  type NowcoderDirectedLiveEvidence,
} from '../../packages/bridge/src/nowcoderDirected/service.js';
import { NowcoderDirectedStore } from '../../packages/bridge/src/nowcoderDirected/store.js';
import { nowcoderDirectedJobId } from '../../packages/bridge/src/nowcoderDirected/jobIdentity.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const NOW = '2026-08-30T00:00:00.000Z';
const BUILD = 'v0.4.33 · abcdef1';
const RUNTIME_1 = '11111111-1111-4111-8111-111111111111';
const RUNTIME_2 = '22222222-2222-4222-8222-222222222222';
const CAPABILITIES = [NOWCODER_DETAIL_CAPABILITY, ZSXQ_COMPLETE_CONTENT_CAPABILITY].sort();
const temporaryDirectories = createTemporaryDirectoryTracker();

afterEach(() => temporaryDirectories.cleanup());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function candidate(): NowcoderSearchCandidate {
  return {
    id: 'candidate-1',
    canonicalUrl: 'https://www.nowcoder.com/feed/main/detail/capability-1',
    contentType: 'post',
    matchedQueries: ['Agent'],
    page: 1,
    rank: 1,
    publishedAt: '2026-08-29T00:00:00.000Z',
  };
}

function evidence(overrides: Partial<NowcoderDirectedLiveEvidence> = {}): NowcoderDirectedLiveEvidence {
  return {
    applicationVersion: APP_VERSION,
    bridgeBuildId: BUILD,
    artifactBuildId: BUILD,
    extensionOnline: true,
    extensionVersion: APP_VERSION,
    extensionBuildId: BUILD,
    extensionRuntimeId: RUNTIME_1,
    extensionCapabilities: CAPABILITIES,
    observedAt: NOW,
    ...overrides,
  };
}

function frozenEvidence(): NowcoderDirectedBuildEvidence {
  return {
    applicationVersion: APP_VERSION,
    bridgeBuildId: BUILD,
    artifactBuildId: BUILD,
    extensionVersion: APP_VERSION,
    extensionBuildId: BUILD,
    extensionCapabilities: CAPABILITIES,
    frozenAt: NOW,
  };
}

async function fixture(options: {
  live?: () => Promise<NowcoderDirectedLiveEvidence>;
  coordinator?: ArtifactReaderCoordinatorLike;
  atomicWrite?: (path: string, value: unknown) => Promise<void>;
  reconcileSelection?: (context: unknown) => Promise<void>;
  recoverPublisher?: (context: unknown) => Promise<void>;
  probeVerifiedMarker?: (context: unknown) => Promise<boolean>;
  reportRecoveryFailure?: (error: { code: string; message: string }) => void;
} = {}) {
  const root = await temporaryDirectories.create('nowcoder-directed-capability-');
  const store = await NowcoderDirectedStore.open(join(root, 'directed.json'), {
    now: () => NOW,
    id: (() => { const ids = ['run-1', 'run-2']; return () => ids.shift() ?? 'run-more'; })(),
    attempt: (() => {
      const attempts = ['0123456789abcdef', 'fedcba9876543210'];
      return () => attempts.shift() ?? '1111111111111111';
    })(),
    ...(options.atomicWrite ? { atomicWrite: options.atomicWrite as never } : {}),
  });
  await store.createSession({
    id: 'session-1',
    queries: ['Agent'],
    queryHash: 'a'.repeat(64),
    requestedSort: 'latest',
    provider: 'nowcoder-json',
    sortVerified: true,
    createdAt: NOW,
    expiresAt: '2026-08-30T00:30:00.000Z',
    candidates: [candidate()],
  }, { target: 1 });
  const jobs = await JobStore.open(join(root, 'jobs.json'), { now: () => NOW });
  const physicalRelease = vi.fn(async () => undefined);
  const coordinator = options.coordinator ?? new ArtifactReaderCoordinator({
    acquirePhysical: async () => ({ release: physicalRelease }),
  });
  let currentEvidence = evidence();
  const live = options.live ?? (async () => currentEvidence);
  const service = new NowcoderDirectedService({
    store,
    jobs,
    dispatch: async () => undefined,
    artifactReaders: coordinator,
    liveEvidence: live,
    ...(options.reconcileSelection ? { reconcileSelection: options.reconcileSelection as never } : {}),
    ...(options.recoverPublisher ? { recoverPublisher: options.recoverPublisher as never } : {}),
    ...(options.probeVerifiedMarker ? { probeVerifiedMarker: options.probeVerifiedMarker as never } : {}),
    ...(options.reportRecoveryFailure ? { reportRecoveryFailure: options.reportRecoveryFailure } : {}),
  });
  const request = {
    searchSessionId: 'session-1',
    selectedCandidateIds: ['candidate-1'],
    idempotencyKey: 'start-key',
    deliveryAuthorized: true as const,
  };
  return {
    root,
    store,
    jobs,
    service,
    coordinator,
    request,
    physicalRelease,
    live,
    setEvidence(value: NowcoderDirectedLiveEvidence) { currentEvidence = value; },
  };
}

async function checkpointSelectedStaging(
  context: Awaited<ReturnType<typeof fixture>>,
  run: NowcoderDirectedRun,
): Promise<void> {
  const selected = candidate();
  const jobId = nowcoderDirectedJobId(run.id, run.attempt, selected.canonicalUrl);
  await context.jobs.create({
    id: jobId,
    url: selected.canonicalUrl,
    requestedBy: 'codex',
    directedRunId: run.id,
    directedRunAttempt: run.attempt,
  });
  await context.jobs.transition(jobId, 'collecting');
  await context.jobs.transition(jobId, 'saved', { outputPath: `/tmp/${jobId}/index.md` });
  await context.store.checkpointCurrentRun(run.id, run.attempt, {
    phase: 'staging',
    candidateCursor: 1,
    currentJobIds: [jobId],
    currentRoundJobIds: [jobId],
    accepted: 1,
    deliveryItems: [{
      jobId,
      stableContentId: stableContentId(selected.canonicalUrl),
      canonicalUrl: selected.canonicalUrl,
      contentHash: 'a'.repeat(16),
      clusterId: 'capability-cluster',
    }],
    progress: {
      discovered: 1,
      detailScheduled: 1,
      detailSaved: 1,
      inspected: 1,
      qualified: 1,
      accepted: 1,
      delivered: 0,
      rejectionCounts: [],
      companies: [
        { company: 'bytedance', count: 0 },
        { company: 'tencent', count: 0 },
        { company: 'alibaba', count: 0 },
        { company: 'ant', count: 0 },
        { company: 'other', count: 1 },
      ],
    },
    privateRejections: [],
  });
}

async function checkpointSelectedPublishing(
  context: Awaited<ReturnType<typeof fixture>>,
  run: NowcoderDirectedRun,
): Promise<void> {
  await checkpointSelectedStaging(context, run);
  await context.store.beginPublishingCurrent(run.id, run.attempt);
}

describe('Nowcoder directed build/capability gate', () => {
  it.each([
    ['offline', evidence({ extensionOnline: false }), 'DIRECTED_EXTENSION_OFFLINE'],
    ['missing runtime', evidence({ extensionRuntimeId: undefined }), 'DIRECTED_EXTENSION_RUNTIME_MISSING'],
    ['missing capability', evidence({ extensionCapabilities: [ZSXQ_COMPLETE_CONTENT_CAPABILITY] }), 'DIRECTED_EXTENSION_CAPABILITY_MISSING'],
    ['online/disk mismatch', evidence({ extensionBuildId: 'v0.4.33 · different' }), 'DIRECTED_EXTENSION_BUILD_CHANGED'],
    ['bridge/disk mismatch', evidence({ artifactBuildId: 'v0.4.33 · different' }), 'DIRECTED_ARTIFACT_CHANGED'],
  ])('rejects a new start with %s and creates no run', async (_label, live, code) => {
    const context = await fixture({ live: async () => live });

    await expect(context.service.startRun(context.request)).rejects.toMatchObject({
      name: 'NowcoderDirectedBoundaryError',
      code,
    });
    expect(context.store.reconciliationSnapshots()).toEqual([]);
    expect(context.coordinator.snapshot()).toMatchObject({ activeReaders: 0, pendingReaders: 0 });
    expect(context.physicalRelease).toHaveBeenCalledOnce();
  });

  it('orders start intent, logical lease, evidence, atomic persistence, then external work', async () => {
    const events: string[] = [];
    const coordinator: ArtifactReaderCoordinatorLike = {
      tryBeginStart: () => {
        events.push('start-intent');
        return { release: () => { events.push('start-transfer'); } };
      },
      tryBeginUpdate: () => undefined,
      acquireReader: async () => {
        events.push('logical-lease');
        return { release: async () => { events.push('logical-release'); } };
      },
      snapshot: () => ({ startIntents: 1, pendingReaders: 0, activeReaders: 1, updateState: 'idle' }),
      setOnIdle: () => undefined,
      close: async () => undefined,
    };
    const selection = vi.fn(async () => { events.push('external-work'); });
    const context = await fixture({
      coordinator,
      live: async () => { events.push('evidence'); return evidence(); },
      reconcileSelection: selection,
    });
    const original = context.store.startRunAtomic.bind(context.store);
    vi.spyOn(context.store, 'startRunAtomic').mockImplementation(async (...args) => {
      const result = await original(...args);
      events.push('atomic-persist');
      return result;
    });

    const started = await context.service.startRun(context.request);

    expect(started.created).toBe(true);
    expect(events).toEqual([
      'start-intent',
      'logical-lease',
      'evidence',
      'atomic-persist',
      'start-transfer',
      'evidence',
      'evidence',
      'external-work',
    ]);
  });

  it('rolls back run/idempotency state and releases exactly once on atomic start failure', async () => {
    let writes = 0;
    const context = await fixture({
      atomicWrite: async () => {
        writes += 1;
        if (writes === 2) throw new Error('disk full');
      },
    });

    await expect(context.service.startRun(context.request)).rejects.toThrow('disk full');
    expect(context.store.reconciliationSnapshots()).toEqual([]);
    expect(context.coordinator.snapshot()).toMatchObject({ activeReaders: 0, pendingReaders: 0 });
    expect(context.physicalRelease).toHaveBeenCalledOnce();
  });

  it('replays exact start and retry keys while offline without replacing the owned run handle', async () => {
    const context = await fixture();
    const first = await context.service.startRun(context.request);
    context.setEvidence(evidence({ extensionOnline: false }));

    const replay = await context.service.startRun(context.request);
    expect(replay).toEqual({ run: first.run, created: false });
    expect(context.coordinator.snapshot().activeReaders).toBe(1);

    await context.service.finalizeRun(first.run.id, first.run.attempt, 'failed');
    context.setEvidence(evidence({ extensionRuntimeId: RUNTIME_2 }));
    const retry = await context.service.retryRun(first.run.id, { idempotencyKey: 'retry-key' });
    context.setEvidence(evidence({ extensionOnline: false }));
    const retryReplay = await context.service.retryRun(first.run.id, { idempotencyKey: 'retry-key' });
    expect(retryReplay).toEqual({ run: retry.run, created: false });
    expect(context.coordinator.snapshot().activeReaders).toBe(1);
    expect(retry.run.buildEvidence).toEqual({ ...frozenEvidence(), frozenAt: NOW });
  });

  it('releases a provisional replay handle in concurrent same-key start and retry mutations', async () => {
    const context = await fixture();
    const [first, second] = await Promise.all([
      context.service.startRun(context.request),
      context.service.startRun(context.request),
    ]);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(context.coordinator.snapshot().activeReaders).toBe(1);

    await context.service.finalizeRun(first.run.id, first.run.attempt, 'failed');
    const retryRequest = { idempotencyKey: 'retry-key' };
    const [retryFirst, retrySecond] = await Promise.all([
      context.service.retryRun(first.run.id, retryRequest),
      context.service.retryRun(first.run.id, retryRequest),
    ]);
    expect([retryFirst.created, retrySecond.created].sort()).toEqual([false, true]);
    expect(context.coordinator.snapshot().activeReaders).toBe(1);
  });

  it('waits for failed start persistence before a same-key caller enters a fresh live gate', async () => {
    const writeEntered = deferred<void>();
    const writeGate = deferred<void>();
    let blockNextWrite = false;
    let blocked = false;
    let liveCalls = 0;
    const context = await fixture({
      atomicWrite: async () => {
        if (!blockNextWrite || blocked) return;
        blocked = true;
        writeEntered.resolve();
        await writeGate.promise;
      },
      live: async () => {
        liveCalls += 1;
        return evidence();
      },
    });
    blockNextWrite = true;
    const first = context.service.startRun(context.request);
    await writeEntered.promise;
    let secondSettled = false;
    const second = context.service.startRun(context.request).then(result => {
      secondSettled = true;
      return result;
    });

    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(liveCalls).toBe(1);
    writeGate.reject(new Error('disk full'));
    await expect(first).rejects.toThrow('disk full');
    await expect(second).resolves.toMatchObject({ created: true });
    expect(liveCalls).toBeGreaterThan(1);
    expect(context.coordinator.snapshot().activeReaders).toBe(1);
  });

  it('waits for committed retry persistence and replays without a second live gate', async () => {
    const writeEntered = deferred<void>();
    const writeGate = deferred<void>();
    let blockNextWrite = false;
    let blocked = false;
    let liveCalls = 0;
    const context = await fixture({
      atomicWrite: async () => {
        if (!blockNextWrite || blocked) return;
        blocked = true;
        writeEntered.resolve();
        await writeGate.promise;
      },
      live: async () => {
        liveCalls += 1;
        return evidence();
      },
    });
    const started = await context.service.startRun(context.request);
    await context.service.finalizeRun(started.run.id, started.run.attempt, 'failed');
    liveCalls = 0;
    blockNextWrite = true;
    const request = { idempotencyKey: 'retry-key' };
    const first = context.service.retryRun(started.run.id, request);
    await writeEntered.promise;
    let secondSettled = false;
    const second = context.service.retryRun(started.run.id, request).then(result => {
      secondSettled = true;
      return result;
    });

    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(liveCalls).toBe(1);
    writeGate.resolve();
    const created = await first;
    const callsAfterCommit = liveCalls;
    await expect(second).resolves.toEqual({ run: created.run, created: false });
    expect(liveCalls).toBe(callsAfterCommit);
    expect(context.coordinator.snapshot().activeReaders).toBe(1);
  });

  it('appends a same-build runtime once and attentions build drift before later boundaries', async () => {
    const context = await fixture();
    const started = await context.service.startRun(context.request);
    context.setEvidence(evidence({ extensionRuntimeId: RUNTIME_2 }));

    await expect(context.service.guardBoundary(started.run.id, started.run.attempt, 'before-dispatch'))
      .resolves.toBe(true);
    await context.service.guardBoundary(started.run.id, started.run.attempt, 'before-dispatch');
    expect(context.store.privateRunEvidence(started.run.id)?.observedRuntimeIds)
      .toEqual([RUNTIME_1, RUNTIME_2]);

    context.setEvidence(evidence({ extensionRuntimeId: RUNTIME_2, extensionBuildId: 'different-build' }));
    await expect(context.service.guardBoundary(started.run.id, started.run.attempt, 'before-result-save'))
      .resolves.toBe(false);
    expect(context.store.getRun(started.run.id)).toMatchObject({
      status: 'completed_with_attention',
      deliveryIds: [],
      publicDeliveryItems: [],
      attentionReason: { code: 'DIRECTED_EXTENSION_BUILD_CHANGED', phase: 'collecting' },
    });
    expect(context.coordinator.snapshot().activeReaders).toBe(0);
  });

  it.each([
    [
      'before-dispatch',
      evidence({ extensionVersion: '0.4.32' }),
      'DIRECTED_EXTENSION_VERSION_CHANGED',
    ],
    [
      'before-result',
      evidence({ extensionBuildId: 'different-build' }),
      'DIRECTED_EXTENSION_BUILD_CHANGED',
    ],
    [
      'before-refill',
      evidence({ artifactBuildId: 'different-artifact', extensionBuildId: 'different-artifact' }),
      'DIRECTED_ARTIFACT_CHANGED',
    ],
    [
      'before-staging',
      evidence({ extensionCapabilities: [...CAPABILITIES, 'unexpected-capability'].sort() }),
      'DIRECTED_EXTENSION_CAPABILITY_CHANGED',
    ],
  ] as const)('attentions %s evidence drift before external work', async (boundary, changed, code) => {
    const context = await fixture();
    const started = await context.service.startRun(context.request);
    context.setEvidence(changed);

    await expect(context.service.guardBoundary(started.run.id, started.run.attempt, boundary))
      .resolves.toBe(false);

    expect(context.store.getRun(started.run.id)).toMatchObject({
      status: 'completed_with_attention',
      deliveryIds: [],
      publicDeliveryItems: [],
      attentionReason: { code },
    });
    expect(context.coordinator.snapshot().activeReaders).toBe(0);
  });

  it('keeps an offline mid-run paused with its reader and does not cache skipped recovery', async () => {
    const selection = vi.fn(async () => undefined);
    const context = await fixture();
    const started = await context.service.startRun(context.request);
    await context.service.close();
    context.setEvidence(evidence({ extensionOnline: false }));
    const service = new NowcoderDirectedService({
      store: context.store,
      jobs: context.jobs,
      dispatch: async () => undefined,
      artifactReaders: context.coordinator,
      liveEvidence: context.live,
      reconcileSelection: selection,
    });

    await service.initialize();
    await service.reconcileAll();
    expect(selection).not.toHaveBeenCalled();
    expect(context.store.getRun(started.run.id)?.status).toBe('running');
    expect(context.coordinator.snapshot().activeReaders).toBe(1);

    context.setEvidence(evidence());
    await service.reconcileAll();
    expect(selection).toHaveBeenCalledOnce();
  });

  it('uses marker-first publisher recovery and bypasses live evidence only for a verified marker', async () => {
    const events: string[] = [];
    const context = await fixture({
      probeVerifiedMarker: async () => { events.push('marker'); return true; },
      recoverPublisher: async () => { events.push('publisher'); },
    });
    const started = await context.service.startRun(context.request);
    await checkpointSelectedPublishing(context, started.run);
    context.setEvidence(evidence({ extensionOnline: false }));

    await context.service.reconcileAll();

    expect(events).toEqual(['marker', 'publisher']);
    expect(context.store.getRun(started.run.id)?.status).toBe('publishing');
  });

  it('converges a verified marker before a drifted replacement hello can attention the run', async () => {
    const publisher = vi.fn(async (recovery: { run: { id: string; attempt: string }; markerVerified: boolean }) => {
      expect(recovery.markerVerified).toBe(true);
    });
    const context = await fixture({
      probeVerifiedMarker: async marker => {
        expect(marker).not.toHaveProperty('jobs');
        return true;
      },
      recoverPublisher: publisher as never,
    });
    const service = context.service;
    const started = await service.startRun(context.request);
    await checkpointSelectedPublishing(context, started.run);
    context.setEvidence(evidence({ extensionBuildId: 'drifted-replacement-build' }));

    await service.observeExtensionEvidence();

    expect(publisher).toHaveBeenCalledOnce();
    expect(context.store.getRun(started.run.id)).toMatchObject({ status: 'publishing' });
    expect(context.store.getRun(started.run.id)).not.toHaveProperty('attentionReason');
  });

  it('converges a verified marker before restart reader acquisition can fail', async () => {
    const first = await fixture();
    const started = await first.service.startRun(first.request);
    await checkpointSelectedStaging(first, started.run);
    await first.service.close();
    const failedCoordinator = new ArtifactReaderCoordinator({
      acquirePhysical: async () => { throw new Error('lease unavailable'); },
    });
    const publisher = vi.fn(async (_recovery: { run: { id: string; attempt: string } }) => undefined);
    const service = new NowcoderDirectedService({
      store: first.store,
      jobs: first.jobs,
      dispatch: async () => undefined,
      artifactReaders: failedCoordinator,
      liveEvidence: async () => evidence({ extensionOnline: false }),
      probeVerifiedMarker: async marker => {
        expect(marker).not.toHaveProperty('jobs');
        return true;
      },
      recoverPublisher: publisher as never,
    });

    await service.initialize();

    expect(publisher).toHaveBeenCalledOnce();
    expect(first.store.getRun(started.run.id)).toMatchObject({ status: 'running' });
    expect(first.store.getRun(started.run.id)).not.toHaveProperty('attentionReason');
    expect(failedCoordinator.snapshot()).toMatchObject({ activeReaders: 0, pendingReaders: 0 });
  });

  it('converges a verified marker without constructing corrupt or missing JobStore context', async () => {
    const publisher = vi.fn(async (recovery: { run: { id: string; attempt: string }; markerVerified: boolean }) => {
      expect(recovery).not.toHaveProperty('jobs');
      expect(recovery.markerVerified).toBe(true);
    });
    const context = await fixture({
      probeVerifiedMarker: async marker => {
        expect(marker).not.toHaveProperty('jobs');
        return true;
      },
      recoverPublisher: publisher as never,
    });
    const service = context.service;
    const started = await service.startRun(context.request);
    const missingJobId = nowcoderDirectedJobId(started.run.id, started.run.attempt, candidate().canonicalUrl);
    await context.store.checkpointCurrentRun(started.run.id, started.run.attempt, {
      phase: 'staging',
      candidateCursor: 1,
      currentJobIds: [missingJobId],
      currentRoundJobIds: [missingJobId],
      accepted: 1,
      deliveryItems: [{
        jobId: missingJobId,
        stableContentId: stableContentId(candidate().canonicalUrl),
        canonicalUrl: candidate().canonicalUrl,
        contentHash: 'a'.repeat(16),
        clusterId: 'missing-job-cluster',
      }],
      progress: {
        discovered: 1,
        detailScheduled: 1,
        detailSaved: 1,
        inspected: 1,
        qualified: 1,
        accepted: 1,
        delivered: 0,
        rejectionCounts: [],
        companies: [
          { company: 'bytedance', count: 0 },
          { company: 'tencent', count: 0 },
          { company: 'alibaba', count: 0 },
          { company: 'ant', count: 0 },
          { company: 'other', count: 1 },
        ],
      },
      privateRejections: [],
    });
    await context.store.beginPublishingCurrent(started.run.id, started.run.attempt);

    await service.reconcileAll();

    expect(publisher).toHaveBeenCalledOnce();
    expect(context.store.getRun(started.run.id)).toMatchObject({ status: 'publishing' });
  });

  it('replays a persisted publishing cutoff without waiting for the extension to reconnect', async () => {
    const events: string[] = [];
    const publisher = vi.fn(async () => { events.push('publisher'); });
    const context = await fixture({
      recoverPublisher: publisher,
    });
    const started = await context.service.startRun(context.request);
    await checkpointSelectedPublishing(context, started.run);
    context.setEvidence(evidence({ extensionOnline: false }));

    await context.service.reconcileAll();

    expect(events).toEqual(['publisher']);
    expect(publisher).toHaveBeenCalledOnce();
    expect(publisher.mock.calls[0]![0]).toMatchObject({ markerVerified: false });
    expect(context.store.getRun(started.run.id)?.status).toBe('publishing');
    expect(context.coordinator.snapshot().activeReaders).toBe(1);
  });

  it('single-flights concurrent hello marker verification and recovery', async () => {
    const probeStarted = deferred<void>();
    const probeGate = deferred<void>();
    const probe = vi.fn(async () => {
      probeStarted.resolve();
      await probeGate.promise;
      return true;
    });
    const publisher = vi.fn(async () => undefined);
    const context = await fixture({
      probeVerifiedMarker: probe,
      recoverPublisher: publisher,
    });
    const started = await context.service.startRun(context.request);
    await checkpointSelectedPublishing(context, started.run);

    const first = context.service.observeExtensionEvidence();
    await probeStarted.promise;
    const second = context.service.observeExtensionEvidence();
    probeGate.resolve();
    await Promise.all([first, second]);

    expect(probe).toHaveBeenCalledOnce();
    expect(publisher).toHaveBeenCalledOnce();
    expect(publisher.mock.calls[0]![0]).toMatchObject({ markerVerified: true });
    expect(context.store.getRun(started.run.id)).toMatchObject({ status: 'publishing' });
  });

  it('single-flights absent-marker hello and normal reconciliation through one publisher callback', async () => {
    const probeStarted = deferred<void>();
    const probeGate = deferred<void>();
    const probe = vi.fn(async () => {
      probeStarted.resolve();
      await probeGate.promise;
      return false;
    });
    const publisher = vi.fn(async () => undefined);
    const context = await fixture({
      probeVerifiedMarker: probe,
      recoverPublisher: publisher,
    });
    const started = await context.service.startRun(context.request);
    await checkpointSelectedStaging(context, started.run);

    const hello = context.service.observeExtensionEvidence();
    await probeStarted.promise;
    const reconciliation = context.service.reconcileAll();
    probeGate.resolve();
    await Promise.all([hello, reconciliation]);

    expect(probe).toHaveBeenCalledOnce();
    expect(publisher).toHaveBeenCalledOnce();
    expect(publisher.mock.calls[0]![0]).toMatchObject({ markerVerified: false });
  });

  it('joins a blocked ordinary publisher instead of attentioning after its marker linearizes', async () => {
    const publisherStarted = deferred<void>();
    const publisherGate = deferred<void>();
    let markerVerified = false;
    const publisher = vi.fn(async () => {
      publisherStarted.resolve();
      await publisherGate.promise;
      markerVerified = true;
    });
    const context = await fixture({
      probeVerifiedMarker: async () => markerVerified,
      recoverPublisher: publisher,
    });
    const started = await context.service.startRun(context.request);
    await checkpointSelectedPublishing(context, started.run);

    const reconciliation = context.service.reconcileAll();
    await publisherStarted.promise;
    context.setEvidence(evidence({ extensionBuildId: 'drifted-after-publisher-started' }));
    const hello = context.service.observeExtensionEvidence();
    publisherGate.resolve();
    await Promise.all([reconciliation, hello]);

    expect(markerVerified).toBe(true);
    expect(publisher).toHaveBeenCalledOnce();
    expect(context.store.getRun(started.run.id)).toMatchObject({ status: 'publishing' });
    expect(context.store.getRun(started.run.id)).not.toHaveProperty('attentionReason');
  });

  it('clears a rejected publisher flight by identity and retries it once', async () => {
    const firstProbeStarted = deferred<void>();
    const firstProbeGate = deferred<void>();
    let probeCalls = 0;
    const probe = vi.fn(async () => {
      probeCalls += 1;
      if (probeCalls === 1) {
        firstProbeStarted.resolve();
        await firstProbeGate.promise;
        throw new Error('transient marker read failure');
      }
      return true;
    });
    const publisher = vi.fn(async () => undefined);
    const context = await fixture({
      probeVerifiedMarker: probe,
      recoverPublisher: publisher,
    });
    const started = await context.service.startRun(context.request);
    await checkpointSelectedStaging(context, started.run);

    const first = context.service.observeExtensionEvidence();
    await firstProbeStarted.promise;
    const joined = context.service.reconcileAll();
    const firstRejected = expect(first).rejects.toThrow('transient marker read failure');
    const joinedRejected = expect(joined).rejects.toThrow('transient marker read failure');
    firstProbeGate.resolve();
    await Promise.all([firstRejected, joinedRejected]);
    expect(probe).toHaveBeenCalledOnce();
    expect(publisher).not.toHaveBeenCalled();

    await context.service.observeExtensionEvidence();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(publisher).toHaveBeenCalledOnce();
  });

  it.each([
    ['terminalization', false],
    ['replacement', true],
  ] as const)('does not install a reader acquired for a stale run after %s', async (_label, replaceRun) => {
    const first = await fixture();
    const started = await first.service.startRun(first.request);
    await first.service.close();
    const acquisitionStarted = deferred<void>();
    const acquisitionGate = deferred<void>();
    const physicalRelease = vi.fn(async () => undefined);
    const coordinator = new ArtifactReaderCoordinator({
      acquirePhysical: async () => {
        acquisitionStarted.resolve();
        await acquisitionGate.promise;
        return { release: physicalRelease };
      },
    });
    const selection = vi.fn(async () => undefined);
    const publisher = vi.fn(async () => undefined);
    const service = new NowcoderDirectedService({
      store: first.store,
      jobs: first.jobs,
      dispatch: async () => undefined,
      artifactReaders: coordinator,
      liveEvidence: async () => evidence(),
      reconcileSelection: selection,
      recoverPublisher: publisher,
    });

    const initialization = service.initialize();
    await acquisitionStarted.promise;
    await first.store.markTerminalCurrent(started.run.id, started.run.attempt, 'failed');
    if (replaceRun) {
      await first.store.retryRun(
        started.run.id,
        { idempotencyKey: 'replacement-key' },
        { buildEvidence: frozenEvidence(), runtimeId: RUNTIME_2 },
      );
    }
    acquisitionGate.resolve();
    await initialization;

    expect(selection).not.toHaveBeenCalled();
    expect(publisher).not.toHaveBeenCalled();
    expect(first.store.getRun(started.run.id)).not.toHaveProperty('attentionReason');
    expect(physicalRelease).toHaveBeenCalledOnce();
    expect(coordinator.snapshot()).toMatchObject({
      activeReaders: 0,
      pendingReaders: 0,
      physicalBusy: false,
    });
    const update = coordinator.tryBeginUpdate(false);
    expect(update).toBeDefined();
    update?.release();
    await service.close();
  });

  it('fences close during reader acquisition and never installs or uses the returned stale handle', async () => {
    const first = await fixture();
    await first.service.startRun(first.request);
    await first.service.close();
    const events: string[] = [];
    const acquisitionStarted = deferred<void>();
    const acquisitionGate = deferred<void>();
    const coordinator = new ArtifactReaderCoordinator({
      acquirePhysical: async () => {
        events.push('physical:acquire:start');
        acquisitionStarted.resolve();
        await acquisitionGate.promise;
        events.push('physical:acquire:end');
        return {
          release: async () => { events.push('physical:release'); },
        };
      },
    });
    const selection = vi.fn(async () => undefined);
    const publisher = vi.fn(async () => undefined);
    const service = new NowcoderDirectedService({
      store: first.store,
      jobs: first.jobs,
      dispatch: async () => undefined,
      artifactReaders: coordinator,
      liveEvidence: async () => evidence(),
      reconcileSelection: selection,
      recoverPublisher: publisher,
    });

    const initialization = service.initialize();
    await acquisitionStarted.promise;
    let closeSettled = false;
    const closing = service.close().then(() => {
      closeSettled = true;
      events.push('service:close:end');
    });
    await Promise.resolve();

    expect(closeSettled).toBe(false);
    acquisitionGate.resolve();
    await Promise.allSettled([initialization, closing]);
    expect(events).toEqual([
      'physical:acquire:start',
      'physical:acquire:end',
      'physical:release',
      'service:close:end',
    ]);
    expect(selection).not.toHaveBeenCalled();
    expect(publisher).not.toHaveBeenCalled();
    expect(first.store.getRun('run-1')).not.toHaveProperty('attentionReason');
    expect(coordinator.snapshot()).toMatchObject({
      activeReaders: 0,
      pendingReaders: 0,
      physicalBusy: false,
    });
    const update = coordinator.tryBeginUpdate(false);
    expect(update).toBeDefined();
    update?.release();
    await expect(service.reconcileAll()).rejects.toThrow('牛客定向服务已关闭');
    await expect(service.observeExtensionEvidence()).rejects.toThrow('牛客定向服务已关闭');
  });

  it.each([
    ['finalize', 'failed'],
    ['attention', 'completed_with_attention'],
  ] as const)('retains a rejected %s release flight in the shared close result', async (path, status) => {
    const releaseStarted = deferred<void>();
    const releaseGate = deferred<void>();
    const coordinator = new ArtifactReaderCoordinator({
      acquirePhysical: async () => ({
        release: async () => {
          releaseStarted.resolve();
          await releaseGate.promise;
        },
      }),
    });
    const context = await fixture({ coordinator });
    const started = await context.service.startRun(context.request);
    if (path === 'attention') {
      context.setEvidence(evidence({ extensionBuildId: 'attention-release-build-drift' }));
    }
    const terminalOperation = path === 'finalize'
      ? context.service.finalizeRun(started.run.id, started.run.attempt, 'failed')
      : context.service.guardBoundary(started.run.id, started.run.attempt, 'before-result-save');
    await releaseStarted.promise;
    const terminalSettlement = terminalOperation.then(
      value => ({ status: 'fulfilled' as const, value }),
      reason => ({ status: 'rejected' as const, reason }),
    );
    const closing = context.service.close();
    const repeated = context.service.close();
    let closeSettled = false;
    const closeSettlement = closing.then(
      () => {
        closeSettled = true;
        return { status: 'fulfilled' as const };
      },
      reason => {
        closeSettled = true;
        return { status: 'rejected' as const, reason };
      },
    );

    expect(repeated).toBe(closing);
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    releaseGate.reject(new Error('private finalize release failure'));
    const [terminalResult, closeResult] = await Promise.all([terminalSettlement, closeSettlement]);

    expect(terminalResult).toMatchObject({ status: 'rejected' });
    expect(closeResult).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: '牛客定向服务未能安全关闭' }),
    });
    if (closeResult.status !== 'rejected') throw new Error('service close unexpectedly fulfilled');
    expect(closeResult.reason.message).not.toContain('private finalize release failure');
    expect(context.service.close()).toBe(closing);
    await expect(context.service.close()).rejects.toBe(closeResult.reason);
    expect(context.store.getRun(started.run.id)).toMatchObject({ status });
    expect(coordinator.snapshot()).toMatchObject({
      activeReaders: 0,
      pendingReaders: 0,
      physicalBusy: true,
      physicalFaulted: true,
    });
  });

  it('retains a rejected stale-acquisition cleanup flight in the shared close result', async () => {
    const first = await fixture();
    await first.service.startRun(first.request);
    await first.service.close();
    const acquisitionStarted = deferred<void>();
    const acquisitionGate = deferred<void>();
    const releaseStarted = deferred<void>();
    const releaseGate = deferred<void>();
    const coordinator = new ArtifactReaderCoordinator({
      acquirePhysical: async () => {
        acquisitionStarted.resolve();
        await acquisitionGate.promise;
        return {
          release: async () => {
            releaseStarted.resolve();
            await releaseGate.promise;
          },
        };
      },
    });
    const selection = vi.fn(async () => undefined);
    const publisher = vi.fn(async () => undefined);
    const service = new NowcoderDirectedService({
      store: first.store,
      jobs: first.jobs,
      dispatch: async () => undefined,
      artifactReaders: coordinator,
      liveEvidence: async () => evidence(),
      reconcileSelection: selection,
      recoverPublisher: publisher,
    });

    const initialization = service.initialize();
    await acquisitionStarted.promise;
    const closing = service.close();
    expect(service.close()).toBe(closing);
    const initializationSettlement = initialization.then(
      value => ({ status: 'fulfilled' as const, value }),
      reason => ({ status: 'rejected' as const, reason }),
    );
    const closeSettlement = closing.then(
      () => ({ status: 'fulfilled' as const }),
      reason => ({ status: 'rejected' as const, reason }),
    );
    acquisitionGate.resolve();
    await releaseStarted.promise;
    let closeSettled = false;
    void closing.then(
      () => { closeSettled = true; },
      () => { closeSettled = true; },
    );
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    releaseGate.reject(new Error('private stale cleanup failure'));
    const [initializationResult, closeResult] = await Promise.all([
      initializationSettlement,
      closeSettlement,
    ]);

    expect(initializationResult).toMatchObject({ status: 'fulfilled' });
    expect(closeResult).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: '牛客定向服务未能安全关闭' }),
    });
    if (closeResult.status !== 'rejected') throw new Error('service close unexpectedly fulfilled');
    expect(closeResult.reason.message).not.toContain('private stale cleanup failure');
    expect(service.close()).toBe(closing);
    await expect(service.close()).rejects.toBe(closeResult.reason);
    expect(selection).not.toHaveBeenCalled();
    expect(publisher).not.toHaveBeenCalled();
    expect(first.store.getRun('run-1')).not.toHaveProperty('attentionReason');
    expect(coordinator.snapshot()).toMatchObject({
      activeReaders: 0,
      pendingReaders: 0,
      physicalBusy: true,
      physicalFaulted: true,
    });
  });

  it.each([
    ['ordinary', false],
    ['verified', true],
  ] as const)('drains a blocked %s publisher before close releases its run reader', async (_label, markerVerified) => {
    const events: string[] = [];
    const publisherStarted = deferred<void>();
    const publisherGate = deferred<void>();
    const publisher = vi.fn(async () => {
      events.push('publisher:start');
      publisherStarted.resolve();
      await publisherGate.promise;
      events.push('publisher:end');
    });
    const physicalRelease = vi.fn(async () => { events.push('reader:release'); });
    const coordinator = new ArtifactReaderCoordinator({
      acquirePhysical: async () => ({ release: physicalRelease }),
    });
    const context = await fixture({
      coordinator,
      probeVerifiedMarker: async () => markerVerified,
      recoverPublisher: publisher,
    });
    const started = await context.service.startRun(context.request);
    await checkpointSelectedPublishing(context, started.run);

    const recovery = context.service.reconcileAll();
    await publisherStarted.promise;
    let closeSettled = false;
    const closing = context.service.close().then(() => {
      closeSettled = true;
      events.push('service:close:end');
    });
    await Promise.resolve();

    expect(closeSettled).toBe(false);
    expect(coordinator.snapshot()).toMatchObject({ activeReaders: 1, physicalBusy: true });
    expect(events).toEqual(['publisher:start']);
    publisherGate.resolve();
    await Promise.all([recovery, closing]);

    expect(events).toEqual([
      'publisher:start',
      'publisher:end',
      'reader:release',
      'service:close:end',
    ]);
    expect(publisher).toHaveBeenCalledOnce();
    expect(physicalRelease).toHaveBeenCalledOnce();
    expect(coordinator.snapshot()).toMatchObject({ activeReaders: 0, physicalBusy: false });
    await expect(context.service.observeExtensionEvidence()).rejects.toThrow('牛客定向服务已关闭');
    await expect(context.service.reconcileAll()).rejects.toThrow('牛客定向服务已关闭');
    await expect(context.service.startRun(context.request)).rejects.toThrow('牛客定向服务已关闭');
    expect(publisher).toHaveBeenCalledOnce();
  });

  it('reacquires the active run reader before restart reconciliation and releases on terminal/close', async () => {
    const first = await fixture();
    const started = await first.service.startRun(first.request);
    await first.service.close();
    expect(first.coordinator.snapshot().activeReaders).toBe(0);

    const reopenedStore = await NowcoderDirectedStore.open(join(first.root, 'directed.json'), { now: () => NOW });
    const reopenedJobs = await JobStore.open(join(first.root, 'jobs.json'), { now: () => NOW });
    const events: string[] = [];
    const coordinator = new ArtifactReaderCoordinator({
      acquirePhysical: async () => {
        events.push('lease');
        return { release: async () => { events.push('release'); } };
      },
    });
    const selection = vi.fn(async () => { events.push('reconcile'); });
    const service = new NowcoderDirectedService({
      store: reopenedStore,
      jobs: reopenedJobs,
      dispatch: async () => undefined,
      artifactReaders: coordinator,
      liveEvidence: async () => evidence(),
      reconcileSelection: selection,
    });

    await service.initialize();
    expect(events.slice(0, 2)).toEqual(['lease', 'reconcile']);
    await service.finalizeRun(started.run.id, started.run.attempt, 'failed');
    expect(events).toEqual(['lease', 'reconcile', 'release']);
    await service.close();
    expect(events).toEqual(['lease', 'reconcile', 'release']);
  });

  it('returns committed start and retry attempts when immediate reconciliation fails', async () => {
    const recoveryFailures = vi.fn();
    const context = await fixture({
      reconcileSelection: async () => { throw new Error('PRIVATE_RECONCILIATION_DETAIL'); },
      reportRecoveryFailure: recoveryFailures,
    });

    const started = await context.service.startRun(context.request);
    expect(started.created).toBe(true);
    expect(recoveryFailures).toHaveBeenLastCalledWith({
      code: 'DIRECTED_RECOVERY_FAILED',
      message: '牛客定向运行恢复不可用',
    });
    expect(JSON.stringify(recoveryFailures.mock.calls)).not.toContain('PRIVATE_RECONCILIATION_DETAIL');
    context.setEvidence(evidence({ extensionOnline: false }));
    await expect(context.service.startRun(context.request)).resolves.toEqual({ run: started.run, created: false });
    expect(context.coordinator.snapshot().activeReaders).toBe(1);

    await context.service.finalizeRun(started.run.id, started.run.attempt, 'failed');
    context.setEvidence(evidence({ extensionRuntimeId: RUNTIME_2 }));
    recoveryFailures.mockClear();
    const retried = await context.service.retryRun(started.run.id, { idempotencyKey: 'retry-key' });
    expect(retried.created).toBe(true);
    expect(recoveryFailures).toHaveBeenCalledOnce();
    expect(JSON.stringify(recoveryFailures.mock.calls)).not.toContain('PRIVATE_RECONCILIATION_DETAIL');
    context.setEvidence(evidence({ extensionOnline: false }));
    await expect(context.service.retryRun(started.run.id, { idempotencyKey: 'retry-key' }))
      .resolves.toEqual({ run: retried.run, created: false });
    expect(context.coordinator.snapshot().activeReaders).toBe(1);
  });

  it('uses typed boundary errors instead of leaking evidence details', () => {
    const error = new NowcoderDirectedBoundaryError(
      'DIRECTED_EXTENSION_OFFLINE',
      '扩展当前未连接',
    );
    expect(error).toMatchObject({ code: 'DIRECTED_EXTENSION_OFFLINE', status: 409 });
    expect(JSON.stringify(error)).not.toContain(BUILD);
  });
});
