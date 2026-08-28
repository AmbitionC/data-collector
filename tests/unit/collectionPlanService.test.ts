import { mkdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CollectionBatch,
  CollectionPlanAttempt,
  CollectionPlanId,
  JobRecord,
} from '@data-collector/shared';
import { JobStore } from '../../packages/bridge/src/jobs/store.js';
import {
  CollectionPlanService,
  CollectionPlanStore,
  ZsxqDayLedgerStore,
  planDueState,
} from '../../packages/bridge/src/plans/index.js';
import { writePlanBenchmark } from '../../packages/bridge/src/plans/benchmark.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const temporaryDirectories = createTemporaryDirectoryTracker();
afterEach(() => temporaryDirectories.cleanup());

type DiscoveryCompany = 'bytedance' | 'tencent' | 'alibaba' | 'ant' | 'other';

async function fixture(options: {
  connected?: boolean;
  now?: string;
  candidates?: Array<{ url: string; queryCompany: DiscoveryCompany }>;
  discoverNowcoder?: (knownUrls: ReadonlySet<string>) => Promise<Array<{
    url: string;
    queryCompany: DiscoveryCompany;
  }>>;
  shouldAutoSync?: (job: JobRecord) => Promise<boolean>;
  pendingNowcoderJobs?: (
    jobs: readonly JobRecord[],
    deliveryBatchId: string,
  ) => Promise<readonly JobRecord[]>;
  selectNowcoderJobs?: (
    jobs: readonly JobRecord[],
    now: string,
  ) => Promise<{
    accepted: JobRecord[];
    coverage: Record<string, number>;
      rejected: Array<{ url: string; reason: string }>;
    }>;
  syncJob?: (job: JobRecord) => Promise<void>;
  syncNowcoderJobs?: (jobs: readonly JobRecord[], deliveryBatchId: string) => Promise<void>;
  writeBenchmark?: (batch: CollectionBatch, jobs: readonly JobRecord[]) => Promise<void>;
  collectZsxq?: (
    batchId: string,
    planId: 'zsxq-chen-teacher',
    attempt: CollectionPlanAttempt,
    force: boolean,
    mode: 'daily-ledger' | 'owner-history',
    targetDays: readonly string[],
    resumeCursor?: string,
  ) => Promise<true>;
} = {}) {
  const root = await temporaryDirectories.create('collection-plan-service-');
  let connected = options.connected ?? true;
  let currentNow = options.now ?? '2026-08-23T01:05:00.000Z';
  const now = () => currentNow;
  const store = await CollectionPlanStore.open(join(root, 'plans.json'), now);
  const jobs = await JobStore.open(join(root, 'jobs.json'), { now, id: () => crypto.randomUUID() });
  const dispatched: string[] = [];
  const planMessages: Array<{
    batchId: string;
    planId: CollectionPlanId;
    attempt?: string;
    force?: boolean;
    mode?: 'daily-ledger' | 'owner-history';
    targetDays?: readonly string[];
    resumeCursor?: string;
  }> = [];
  const synced: string[] = [];
  const shouldAutoSync = options.shouldAutoSync ?? (async () => false);
  const discover = vi.fn(options.discoverNowcoder ?? (async knownUrls => (options.candidates ?? [
    { url: 'https://www.nowcoder.com/discuss/8001', queryCompany: 'bytedance' as const },
    { url: 'https://www.nowcoder.com/discuss/8002', queryCompany: 'tencent' as const },
  ]).filter(candidate => !knownUrls.has(candidate.url))));
  const collectZsxq = options.collectZsxq ?? (async (
    batchId: string,
    planId: 'zsxq-chen-teacher',
    attempt: CollectionPlanAttempt,
    force: boolean,
    mode: 'daily-ledger' | 'owner-history',
    targetDays: readonly string[],
    resumeCursor?: string,
  ) => {
    planMessages.push({
      batchId,
      planId,
      attempt,
      ...(force ? { force: true } : {}),
      mode,
      targetDays,
      ...(resumeCursor ? { resumeCursor } : {}),
    });
    return true as const;
  });
  const zsxqLedger = await ZsxqDayLedgerStore.open(join(root, 'zsxq-ledger.json'), now);
  const service = new CollectionPlanService({
    store,
    jobs,
    now,
    extensionConnected: () => connected,
    discoverNowcoder: discover,
    dispatch: async job => { dispatched.push(job.id); },
    collectZsxq,
    zsxqLedger,
    shouldAutoSync,
    pendingNowcoderJobs: deliveryBatchId =>
      options.pendingNowcoderJobs?.(jobs.list(), deliveryBatchId) ?? Promise.resolve([]),
    selectNowcoderJobs: options.selectNowcoderJobs ?? (async jobs => {
      const accepted: JobRecord[] = [];
      const rejected: Array<{ url: string; reason: string }> = [];
      for (const job of jobs) {
        if (await shouldAutoSync(job)) accepted.push(job);
        else rejected.push({ url: job.url, reason: '证据等级不足' });
      }
      return {
        accepted,
        coverage: { bytedance: 0, tencent: 0, alibaba: 0, ant: 0 },
        rejected,
      };
    }),
    syncJob: options.syncJob ?? (async job => { synced.push(job.id); }),
    ...(options.syncNowcoderJobs ? { syncNowcoderJobs: options.syncNowcoderJobs } : {}),
    writeBenchmark: options.writeBenchmark ?? (async () => undefined),
  });
  return {
    service,
    store,
    jobs,
    discover,
    dispatched,
    planMessages,
    synced,
    zsxqLedger,
    setConnected(value: boolean) { connected = value; },
    setNow(value: string) { currentNow = value; },
    async reopen() {
      const reopenedStore = await CollectionPlanStore.open(store.path, now);
      const reopenedJobs = await JobStore.open(jobs.path, { now, id: () => crypto.randomUUID() });
      const reopenedLedger = await ZsxqDayLedgerStore.open(zsxqLedger.path, now);
      const reopenedService = new CollectionPlanService({
        store: reopenedStore,
        jobs: reopenedJobs,
        now,
        extensionConnected: () => connected,
        discoverNowcoder: discover,
        dispatch: async job => { dispatched.push(job.id); },
        collectZsxq,
        zsxqLedger: reopenedLedger,
        shouldAutoSync,
        pendingNowcoderJobs: deliveryBatchId =>
          options.pendingNowcoderJobs?.(reopenedJobs.list(), deliveryBatchId) ?? Promise.resolve([]),
        selectNowcoderJobs: options.selectNowcoderJobs ?? (async planJobs => {
          const accepted: JobRecord[] = [];
          const rejected: Array<{ url: string; reason: string }> = [];
          for (const job of planJobs) {
            if (await shouldAutoSync(job)) accepted.push(job);
            else rejected.push({ url: job.url, reason: '证据等级不足' });
          }
          return {
            accepted,
            coverage: { bytedance: 0, tencent: 0, alibaba: 0, ant: 0 },
            rejected,
          };
        }),
        syncJob: options.syncJob ?? (async job => { synced.push(job.id); }),
        ...(options.syncNowcoderJobs ? { syncNowcoderJobs: options.syncNowcoderJobs } : {}),
        writeBenchmark: options.writeBenchmark ?? (async () => undefined),
      });
      return { store: reopenedStore, jobs: reopenedJobs, service: reopenedService };
    },
  };
}

function nowcoderCandidates(count: number, firstId = 10_000) {
  const companies = ['bytedance', 'tencent', 'alibaba', 'ant'] as const;
  return Array.from({ length: count }, (_, index) => ({
    url: `https://www.nowcoder.com/discuss/${firstId + index}`,
    queryCompany: companies[index % companies.length]!,
  }));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function currentZsxqAttempt(store: CollectionPlanStore, batchId: string): CollectionPlanAttempt {
  const attempt = store.latest('zsxq-chen-teacher', 100)
    .find(batch => batch.id === batchId)?.preparationAttempt;
  if (!attempt) throw new Error(`批次 ${batchId} 没有当前采集尝试`);
  return attempt;
}

function dailyLedgerFacts(day = '2026-08-22') {
  const publishedAt = `${day}T10:00:00.000Z`;
  return {
    checkpoint: {
      mode: 'daily-ledger' as const,
      pagesFetched: 1,
      exhausted: true,
      newestObservedAt: publishedAt,
      oldestObservedAt: publishedAt,
    },
    dayDrafts: [{
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
    }],
    ownerAudit: {
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
      newestObservedAt: publishedAt,
      oldestObservedAt: publishedAt,
      exhausted: true,
      safetyCapReached: false,
      completedDays: 0,
      emptyDays: 0,
      failedDays: 0,
    },
  };
}

async function stageSavedZsxqJob(
  context: Awaited<ReturnType<typeof fixture>>,
  id: string,
  url: string,
): Promise<{ batch: CollectionBatch; saved: JobRecord }> {
  const batch = await context.service.run('zsxq-chen-teacher', { force: true });
  const attempt = currentZsxqAttempt(context.store, batch.id);
  const child = await context.jobs.create({
    id,
    url,
    requestedBy: 'extension',
    batchId: batch.id,
    planId: 'zsxq-chen-teacher',
    planAttempt: attempt,
  });
  await context.service.onJobCreated(child);
  await context.service.onExtensionPlanResult({
    batchId: batch.id,
    attempt,
    discovered: 1,
    prepared: true,
    ...dailyLedgerFacts(),
  });
  await context.jobs.transition(child.id, 'collecting');
  const saved = await context.jobs.transition(child.id, 'saved', {
    outputPath: `/tmp/${child.id}/index.md`,
  });
  return { batch, saved };
}

function acceptAllExcept(excludedUrls: ReadonlySet<string>) {
  return async (jobs: readonly JobRecord[]) => ({
    accepted: jobs.filter(job => !excludedUrls.has(job.url)),
    coverage: { bytedance: 0, tencent: 0, alibaba: 0, ant: 0 },
    rejected: jobs
      .filter(job => excludedUrls.has(job.url))
      .map(job => ({ url: job.url, reason: '证据等级不足' })),
  });
}

async function saveJobs(
  context: Awaited<ReturnType<typeof fixture>>,
  jobs: readonly JobRecord[],
): Promise<void> {
  for (const job of jobs) {
    await context.jobs.transition(job.id, 'collecting');
    const saved = await context.jobs.transition(job.id, 'saved', {
      outputPath: `/tmp/${job.id}/index.md`,
    });
    await context.service.onJobTerminal(saved);
  }
}

describe('CollectionPlanService', () => {
  it('dispatches owner history from the ledger and finalizes a continuous exhausted day', async () => {
    const context = await fixture({ now: '2026-08-25T01:05:00.000Z' });
    const batch = await context.service.run('zsxq-chen-teacher', {
      force: true,
      zsxqMode: 'owner-history',
    });
    expect(context.planMessages).toEqual([expect.objectContaining({
      batchId: batch.id,
      mode: 'owner-history',
      targetDays: [],
    })]);
    const attempt = currentZsxqAttempt(context.store, batch.id);
    const audit = {
      mode: 'owner-history' as const,
      pagesFetched: 1, observed: 1, qualifying: 1, exactDuplicates: 1,
      semanticDuplicates: 0, filtered: 0, knownComplete: 1, repaired: 0,
      saved: 0, failed: 0, newestObservedAt: '2026-08-24T10:00:00.000Z',
      oldestObservedAt: '2026-08-24T10:00:00.000Z', exhausted: true,
      safetyCapReached: false, completedDays: 0, emptyDays: 0, failedDays: 0,
    };
    const completed = await context.service.onExtensionPlanResult({
      batchId: batch.id,
      attempt,
      discovered: 1,
      prepared: true,
      checkpoint: {
        mode: 'owner-history', pagesFetched: 1, exhausted: true,
        newestObservedAt: audit.newestObservedAt, oldestObservedAt: audit.oldestObservedAt,
      },
      dayDrafts: [{
        day: '2026-08-24', rawOwnerCount: 1, qualifyingCount: 1, filteredCount: 0,
        exactDuplicateCount: 1, semanticDuplicateCount: 0, knownCompleteCount: 1,
        repairCount: 0, candidateCount: 0, savedCount: 0, failedCount: 0,
        crossedDayBoundary: true,
      }],
      ownerAudit: audit,
    });

    expect(completed).toMatchObject({
      status: 'completed',
      zsxqMode: 'owner-history',
      ownerAudit: { exhausted: true, completedDays: 1, emptyDays: 0, failedDays: 0 },
    });
    expect(context.zsxqLedger.snapshot().days['2026-08-24']).toMatchObject({
      status: 'completed_content', qualifyingCount: 1,
    });
  });

  it('calculates 08:00/09:00 due state in Asia/Shanghai', () => {
    expect(planDueState('zsxq-chen-teacher', '2026-08-23T00:01:00.000Z')).toMatchObject({ due: true });
    expect(planDueState('nowcoder-agent-market', '2026-08-23T00:59:00.000Z')).toMatchObject({ due: false });
    expect(planDueState('nowcoder-agent-market', '2026-08-23T01:01:00.000Z')).toMatchObject({ due: true });
    expect(planDueState(
      'zsxq-chen-teacher',
      '2026-08-23T02:00:00.000Z',
      '2026-08-23T00:10:00.000Z',
    )).toMatchObject({ due: false });
  });

  it('does not let a manual backfill consume the scheduled run for the same Shanghai day', async () => {
    const context = await fixture({ now: '2026-08-25T16:34:00.000Z' });

    const manual = await context.service.run('zsxq-chen-teacher');
    expect((manual as CollectionBatch & { trigger?: string }).trigger).toBe('manual');
    await context.service.onExtensionPlanResult({
      batchId: manual.id,
      attempt: currentZsxqAttempt(context.store, manual.id),
      discovered: 0,
      prepared: true,
    });

    context.setNow('2026-08-26T00:01:00.000Z');
    await context.service.runDuePlans();

    expect(context.planMessages).toHaveLength(2);
    expect(context.store.latest('zsxq-chen-teacher', 2).map(batch => ({
      trigger: (batch as CollectionBatch & { trigger?: string }).trigger,
      startedAt: batch.startedAt,
    }))).toEqual([
      { trigger: 'scheduled', startedAt: '2026-08-26T00:01:00.000Z' },
      { trigger: 'manual', startedAt: '2026-08-25T16:34:00.000Z' },
    ]);

    await context.service.runDuePlans();
    expect(context.planMessages).toHaveLength(2);
  });

  it('dispatches eight detail jobs in the initial Nowcoder target-fill round', async () => {
    const context = await fixture({ candidates: nowcoderCandidates(12) });

    const batch = await context.service.run('nowcoder-agent-market', { force: true });
    const attached = context.jobs.list().filter(job => job.batchId === batch.id);

    expect(attached).toHaveLength(8);
    expect(context.dispatched).toHaveLength(8);
    expect(context.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      status: 'running',
      rounds: 1,
      accepted: 8,
    });
  });

  it('rotates all four primary companies before using the supplemental other bucket', async () => {
    const otherUrls = new Set(Array.from(
      { length: 4 },
      (_, index) => `https://www.nowcoder.com/discuss/${89_001 + index}`,
    ));
    const context = await fixture({
      candidates: [
        { url: 'https://www.nowcoder.com/discuss/88001', queryCompany: 'bytedance' },
        { url: 'https://www.nowcoder.com/discuss/88002', queryCompany: 'tencent' },
        { url: 'https://www.nowcoder.com/discuss/88003', queryCompany: 'alibaba' },
        { url: 'https://www.nowcoder.com/discuss/88004', queryCompany: 'ant' },
        ...[...otherUrls].map(url => ({ url, queryCompany: 'other' as const })),
      ],
    });

    const batch = await context.service.run('nowcoder-agent-market', { force: true });
    const attachedUrls = context.jobs.list()
      .filter(job => job.batchId === batch.id)
      .map(job => job.url);

    expect(attachedUrls).toHaveLength(8);
    expect(attachedUrls.slice(0, 4).some(url => otherUrls.has(url))).toBe(false);
    expect(attachedUrls.slice(4).every(url => otherUrls.has(url))).toBe(true);
  });

  it('dispatches a four-detail refill after only six initial jobs qualify', async () => {
    const candidates = nowcoderCandidates(12, 11_000);
    const excluded = new Set(candidates.slice(0, 2).map(candidate => candidate.url));
    const context = await fixture({
      candidates,
      selectNowcoderJobs: acceptAllExcept(excluded),
    });
    const batch = await context.service.run('nowcoder-agent-market', { force: true });
    const firstRound = context.jobs.list().filter(job => job.batchId === batch.id);

    await saveJobs(context, firstRound);

    expect(context.jobs.list().filter(job => job.batchId === batch.id)).toHaveLength(12);
    expect(context.dispatched).toHaveLength(12);
    expect(context.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      status: 'running',
      rounds: 2,
    });
    expect(context.synced).toEqual([]);
  });

  it('keeps a terminal round running while refill discovery is unresolved', async () => {
    const initial = nowcoderCandidates(8, 18_000);
    const refill = nowcoderCandidates(4, 18_100);
    const refillDiscovery = deferred<typeof refill>();
    let discoveryRound = 0;
    const excluded = new Set(initial.slice(0, 2).map(candidate => candidate.url));
    const context = await fixture({
      discoverNowcoder: async () => {
        discoveryRound += 1;
        return discoveryRound === 1 ? initial : refillDiscovery.promise;
      },
      selectNowcoderJobs: acceptAllExcept(excluded),
    });
    const batch = await context.service.run('nowcoder-agent-market', { force: true });
    const firstRound = context.jobs.list().filter(job => job.batchId === batch.id);
    await saveJobs(context, firstRound.slice(0, -1));
    const last = firstRound.at(-1)!;
    await context.jobs.transition(last.id, 'collecting');
    const saved = await context.jobs.transition(last.id, 'saved', {
      outputPath: `/tmp/${last.id}/index.md`,
    });

    const advancing = context.service.onJobTerminal(saved);
    await vi.waitFor(() => expect(context.discover).toHaveBeenCalledTimes(2));

    expect(context.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      status: 'running',
      selectionStatus: 'pending',
      deliveryIds: [],
    });

    refillDiscovery.resolve(refill);
    await advancing;
    expect(context.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      status: 'running',
      rounds: 2,
    });
  });

  it('keeps delivery invisible while exact-ten synchronization is unresolved', async () => {
    const syncStarted = deferred<void>();
    const releaseSync = deferred<void>();
    let firstSync = true;
    const context = await fixture({
      candidates: nowcoderCandidates(10, 18_200),
      selectNowcoderJobs: acceptAllExcept(new Set()),
      syncJob: async job => {
        if (firstSync) {
          firstSync = false;
          syncStarted.resolve();
        }
        await releaseSync.promise;
        context.synced.push(job.id);
      },
    });
    const batch = await context.service.run('nowcoder-agent-market', { force: true });
    await saveJobs(context, context.jobs.list().filter(job => job.batchId === batch.id));
    const refill = context.jobs.list().filter(job => job.batchId === batch.id && job.status === 'queued');
    await saveJobs(context, refill.slice(0, -1));
    const last = refill.at(-1)!;
    await context.jobs.transition(last.id, 'collecting');
    const saved = await context.jobs.transition(last.id, 'saved', {
      outputPath: `/tmp/${last.id}/index.md`,
    });

    const advancing = context.service.onJobTerminal(saved);
    await syncStarted.promise;

    expect(context.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      status: 'running',
      selectionStatus: 'pending',
      deliveryIds: [],
    });

    releaseSync.resolve();
    await advancing;
    expect(context.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      status: 'completed',
      selectionStatus: 'completed',
      deliveryIds: expect.arrayContaining([expect.stringMatching(/^[a-f0-9]{12}$/)]),
    });
    expect(context.store.latest('nowcoder-agent-market', 1)[0]!.deliveryIds).toHaveLength(10);
  });

  it('retries idempotent sink writes after real delivery persistence fails', async () => {
    const sinkUrls = new Set<string>();
    const syncAttempts: string[] = [];
    const context = await fixture({
      candidates: nowcoderCandidates(10, 18_400),
      selectNowcoderJobs: acceptAllExcept(new Set()),
      syncJob: async job => {
        syncAttempts.push(job.url);
        sinkUrls.add(job.url);
      },
    });
    const batch = await context.service.run('nowcoder-agent-market', { force: true });
    await saveJobs(context, context.jobs.list().filter(job => job.batchId === batch.id));
    const refill = context.jobs.list().filter(job => job.batchId === batch.id && job.status === 'queued');
    await saveJobs(context, refill.slice(0, -1));
    const last = refill.at(-1)!;
    await context.jobs.transition(last.id, 'collecting');
    await context.jobs.transition(last.id, 'saved', {
      outputPath: `/tmp/${last.id}/index.md`,
    });
    const reconciled = await context.store.reconcile(batch.id, context.jobs.list());
    const persistedPath = `${context.store.path}.persisted`;
    await rename(context.store.path, persistedPath);
    await mkdir(context.store.path);

    try {
      await expect(context.service.advanceNowcoderBatch(reconciled)).rejects.toThrow();

      expect(context.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
        status: 'running',
        selectionStatus: 'pending',
        deliveryIds: [],
      });
    } finally {
      await rmdir(context.store.path);
      await rename(persistedPath, context.store.path);
    }
    expect(syncAttempts).toHaveLength(10);
    expect(sinkUrls.size).toBe(10);

    const reopened = await context.reopen();
    await reopened.service.onExtensionConnected();

    expect(syncAttempts).toHaveLength(20);
    expect(sinkUrls.size).toBe(10);
    const terminal = reopened.store.latest('nowcoder-agent-market', 1)[0]!;
    expect(terminal).toMatchObject({
      status: 'completed',
      selectionStatus: 'completed',
    });
    expect(new Set(terminal.deliveryIds).size).toBe(10);
  });

  it('finalizes candidate exhaustion without a second terminal transition', async () => {
    const candidates = nowcoderCandidates(2, 18_300);
    const context = await fixture({
      candidates,
      selectNowcoderJobs: acceptAllExcept(new Set()),
    });
    vi.spyOn(context.store, 'attention').mockRejectedValue(
      new Error('shortfall attempted a second terminal write'),
    );
    const batch = await context.service.run('nowcoder-agent-market', { force: true });

    await expect(saveJobs(
      context,
      context.jobs.list().filter(job => job.batchId === batch.id),
    )).resolves.toBeUndefined();

    expect(context.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      status: 'completed_with_attention',
      selectionStatus: 'completed',
      deliveryIds: [],
      error: expect.stringContaining('候选不足'),
    });
  });

  it('synchronizes and finalizes exactly ten deterministic jobs after a refill', async () => {
    const candidates = nowcoderCandidates(12, 12_000);
    const excluded = new Set(candidates.slice(0, 2).map(candidate => candidate.url));
    const context = await fixture({
      candidates,
      selectNowcoderJobs: acceptAllExcept(excluded),
    });
    const batch = await context.service.run('nowcoder-agent-market', { force: true });

    await saveJobs(context, context.jobs.list().filter(job => job.batchId === batch.id));
    const refill = context.jobs.list().filter(job =>
      job.batchId === batch.id && job.status === 'queued');
    await saveJobs(context, refill);

    const terminal = context.store.latest('nowcoder-agent-market', 1)[0]!;
    expect(context.synced).toEqual(
      context.jobs.list()
        .filter(job => job.batchId === batch.id && !excluded.has(job.url))
        .map(job => job.id),
    );
    expect(context.synced).toHaveLength(10);
    expect(terminal).toMatchObject({
      status: 'completed',
      accepted: 10,
      saved: 10,
      selectionStatus: 'completed',
      rounds: 2,
    });
    expect(new Set(terminal.deliveryIds)).toHaveProperty('size', 10);
  });

  it('stops after five rounds without attaching more than twenty-four detail jobs', async () => {
    const context = await fixture({
      candidates: nowcoderCandidates(30, 13_000),
      selectNowcoderJobs: acceptAllExcept(new Set(nowcoderCandidates(30, 13_000).map(item => item.url))),
    });
    const batch = await context.service.run('nowcoder-agent-market', { force: true });
    const roundSizes: number[] = [];
    const finished = new Set<string>();

    while (context.store.latest('nowcoder-agent-market', 1)[0]?.status === 'running') {
      const round = context.jobs.list().filter(job => job.batchId === batch.id && !finished.has(job.id));
      roundSizes.push(round.length);
      round.forEach(job => finished.add(job.id));
      await saveJobs(context, round);
    }

    const terminal = context.store.latest('nowcoder-agent-market', 1)[0]!;
    expect(roundSizes).toEqual([8, 4, 4, 4, 4]);
    expect(context.jobs.list().filter(job => job.batchId === batch.id)).toHaveLength(24);
    expect(terminal).toMatchObject({
      status: 'completed_with_attention',
      selectionStatus: 'completed',
      rounds: 5,
      deliveryIds: [],
    });
  });

  it('ends candidate exhaustion with attention and no partial delivery', async () => {
    const candidates = nowcoderCandidates(8, 14_000);
    const excluded = new Set(candidates.slice(6).map(candidate => candidate.url));
    const context = await fixture({
      candidates,
      selectNowcoderJobs: acceptAllExcept(excluded),
    });
    const batch = await context.service.run('nowcoder-agent-market', { force: true });

    await saveJobs(context, context.jobs.list().filter(job => job.batchId === batch.id));

    expect(context.synced).toEqual([]);
    expect(context.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      status: 'completed_with_attention',
      accepted: 6,
      saved: 6,
      selectionStatus: 'completed',
      deliveryIds: [],
    });
  });

  it('delivers six pending historical saves with four new candidates as one exact-ten batch', async () => {
    let available = nowcoderCandidates(6, 24_000);
    let pendingBatchId = '';
    const benchmarkJobs = new Map<string, readonly JobRecord[]>();
    const selectionTimes: string[] = [];
    const syncBatches: Array<{ deliveryBatchId: string; jobs: readonly JobRecord[] }> = [];
    let context!: Awaited<ReturnType<typeof fixture>>;
    context = await fixture({
      discoverNowcoder: async knownUrls => available.filter(candidate => !knownUrls.has(candidate.url)),
      pendingNowcoderJobs: async jobs => jobs.filter(job =>
        job.batchId === pendingBatchId && job.status === 'saved'),
      selectNowcoderJobs: async (jobs, now) => {
        selectionTimes.push(now);
        return acceptAllExcept(new Set())(jobs);
      },
      syncJob: async () => { throw new Error('Nowcoder 不得逐条提交 catalog 同步状态'); },
      syncNowcoderJobs: async (jobs, deliveryBatchId) => {
        syncBatches.push({ deliveryBatchId, jobs: [...jobs] });
        context.synced.push(...jobs.map(job => job.id));
      },
      writeBenchmark: async (batch, jobs) => { benchmarkJobs.set(batch.id, jobs); },
    });
    const shortfall = await context.service.run('nowcoder-agent-market', { force: true });
    pendingBatchId = shortfall.id;
    await saveJobs(context, context.jobs.list().filter(job => job.batchId === shortfall.id));
    expect(context.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      status: 'completed_with_attention',
      accepted: 6,
      deliveryIds: [],
    });

    available = available.concat(nowcoderCandidates(4, 25_000));
    context.setNow('2026-08-23T01:05:00.001Z');
    const delivery = await context.service.run('nowcoder-agent-market', { force: true });
    const currentJobs = context.jobs.list().filter(job => job.batchId === delivery.id);
    expect(currentJobs).toHaveLength(4);
    context.setNow('2026-08-24T01:05:00.000Z');
    await saveJobs(context, currentJobs);

    const terminal = context.store.latest('nowcoder-agent-market', 1)[0]!;
    expect(terminal).toMatchObject({
      id: delivery.id,
      status: 'completed',
      discovered: 10,
      accepted: 10,
      saved: 10,
      deliveryIds: expect.arrayContaining(Array.from({ length: 10 }, () =>
        expect.stringMatching(/^[a-f0-9]{12}$/))),
    });
    expect(new Set(terminal.deliveryIds).size).toBe(10);
    expect(context.synced).toHaveLength(10);
    expect(syncBatches).toEqual([{ deliveryBatchId: delivery.id, jobs: expect.any(Array) }]);
    expect(syncBatches[0]?.jobs).toHaveLength(10);
    expect(selectionTimes.at(-1)).toBe(delivery.startedAt);
    expect(new Set(benchmarkJobs.get(delivery.id)?.map(job => job.batchId))).toEqual(
      new Set([shortfall.id, delivery.id]),
    );
  });

  it('leaves a pooled exact-ten batch retryable when one historical sync fails', async () => {
    let available = nowcoderCandidates(6, 26_000);
    let pendingBatchId = '';
    const context = await fixture({
      discoverNowcoder: async knownUrls => available.filter(candidate => !knownUrls.has(candidate.url)),
      pendingNowcoderJobs: async jobs => jobs.filter(job =>
        job.batchId === pendingBatchId && job.status === 'saved'),
      selectNowcoderJobs: acceptAllExcept(new Set()),
      syncNowcoderJobs: async jobs => {
        context.synced.push(jobs[0]!.id);
        throw new Error('historical sink unavailable');
      },
    });
    const shortfall = await context.service.run('nowcoder-agent-market', { force: true });
    pendingBatchId = shortfall.id;
    await saveJobs(context, context.jobs.list().filter(job => job.batchId === shortfall.id));

    available = available.concat(nowcoderCandidates(4, 27_000));
    context.setNow('2026-08-23T01:05:00.001Z');
    const delivery = await context.service.run('nowcoder-agent-market', { force: true });
    await saveJobs(context, context.jobs.list().filter(job => job.batchId === delivery.id));

    expect(context.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      id: delivery.id,
      status: 'completed_with_attention',
      selectionStatus: 'pending',
      deliveryIds: [],
      error: expect.stringContaining('historical sink unavailable'),
    });
  });

  it('retries the same pooled exact ten when plan finalization fails after atomic sync', async () => {
    let available = nowcoderCandidates(6, 28_000);
    let pendingBatchId = '';
    const catalogPending = new Set<string>();
    const deliveryIntent = new Map<string, string>();
    const syncSelections: string[][] = [];
    const context = await fixture({
      discoverNowcoder: async knownUrls => available.filter(candidate => !knownUrls.has(candidate.url)),
      pendingNowcoderJobs: async (jobs, deliveryBatchId) => jobs.filter(job =>
        job.batchId === pendingBatchId
        && job.status === 'saved'
        && (catalogPending.has(job.id) || deliveryIntent.get(job.id) === deliveryBatchId)),
      selectNowcoderJobs: acceptAllExcept(new Set()),
      syncNowcoderJobs: async (jobs, deliveryBatchId) => {
        syncSelections.push(jobs.map(job => job.url));
        for (const job of jobs) {
          catalogPending.delete(job.id);
          deliveryIntent.set(job.id, deliveryBatchId);
        }
      },
    });
    const shortfall = await context.service.run('nowcoder-agent-market', { force: true });
    pendingBatchId = shortfall.id;
    const historical = context.jobs.list().filter(job => job.batchId === shortfall.id);
    await saveJobs(context, historical);
    for (const job of historical) catalogPending.add(job.id);

    available = available.concat(nowcoderCandidates(4, 29_000));
    context.setNow('2026-08-23T01:05:00.001Z');
    const delivery = await context.service.run('nowcoder-agent-market', { force: true });
    const originalFinalize = context.store.finalizeSelection.bind(context.store);
    vi.spyOn(context.store, 'finalizeSelection')
      .mockRejectedValueOnce(new Error('plan persistence unavailable'))
      .mockImplementation(originalFinalize);
    await expect(saveJobs(
      context,
      context.jobs.list().filter(job => job.batchId === delivery.id),
    )).rejects.toThrow('plan persistence unavailable');

    const retry = await context.reopen();
    await retry.service.onExtensionConnected();

    expect(syncSelections).toHaveLength(2);
    expect(syncSelections[1]).toEqual(syncSelections[0]);
    expect(retry.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      id: delivery.id,
      status: 'completed',
      accepted: 10,
      deliveryIds: expect.any(Array),
    });
    expect(retry.store.latest('nowcoder-agent-market', 1)[0]!.deliveryIds).toHaveLength(10);
  });

  it('writes a benchmark only after a Nowcoder attention outcome is persisted', async () => {
    const candidates = nowcoderCandidates(2, 14_100);
    let context!: Awaited<ReturnType<typeof fixture>>;
    let batchDuringWrite: CollectionBatch | undefined;
    let jobCountDuringWrite = 0;
    context = await fixture({
      candidates,
      selectNowcoderJobs: acceptAllExcept(new Set(candidates.map(candidate => candidate.url))),
      writeBenchmark: async (terminal, jobs) => {
        batchDuringWrite = context.store.latest('nowcoder-agent-market', 1)[0];
        jobCountDuringWrite = jobs.length;
        expect(terminal).toEqual(batchDuringWrite);
      },
    });
    const batch = await context.service.run('nowcoder-agent-market', { force: true });
    const children = context.jobs.list().filter(job => job.batchId === batch.id);

    await saveJobs(context, children.slice(0, 1));
    expect(batchDuringWrite).toBeUndefined();

    await saveJobs(context, children.slice(1));

    expect(batchDuringWrite).toMatchObject({
      status: 'completed_with_attention',
      selectionStatus: 'completed',
      deliveryIds: [],
    });
    expect(jobCountDuringWrite).toBe(2);
  });

  it('surfaces benchmark write failure without deleting saved evidence or delivery IDs', async () => {
    const context = await fixture({
      candidates: nowcoderCandidates(10, 14_200),
      selectNowcoderJobs: acceptAllExcept(new Set()),
      writeBenchmark: async () => { throw new Error('benchmark disk unavailable'); },
    });
    const batch = await context.service.run('nowcoder-agent-market', { force: true });
    await saveJobs(context, context.jobs.list().filter(job => job.batchId === batch.id));
    await saveJobs(context, context.jobs.list().filter(job =>
      job.batchId === batch.id && job.status === 'queued'));

    const terminal = context.store.latest('nowcoder-agent-market', 1)[0]!;
    const saved = context.jobs.list().filter(job => job.batchId === batch.id);
    expect(terminal).toMatchObject({
      status: 'completed_with_attention',
      selectionStatus: 'completed',
      saved: 10,
      error: expect.stringContaining('基准报告写入失败'),
    });
    expect(terminal.error).not.toContain('benchmark disk unavailable');
    expect(terminal.deliveryIds).toHaveLength(10);
    expect(saved).toHaveLength(10);
    expect(saved.every(job => job.status === 'saved' && Boolean(job.outputPath))).toBe(true);
  });

  it('ignores repeated stale extension results after a Nowcoder batch and benchmark are terminal', async () => {
    const benchmarkRoot = await temporaryDirectories.create('plan-benchmark-idempotency-');
    let benchmarkWrites = 0;
    const context = await fixture({
      candidates: nowcoderCandidates(10, 14_300),
      selectNowcoderJobs: acceptAllExcept(new Set()),
      writeBenchmark: async (terminal, jobs) => {
        benchmarkWrites += 1;
        await writePlanBenchmark(benchmarkRoot, terminal, jobs, {
          metadataFor: () => undefined,
        });
      },
    });
    const batch = await context.service.run('nowcoder-agent-market', { force: true });
    await saveJobs(context, context.jobs.list().filter(job => job.batchId === batch.id));
    await saveJobs(context, context.jobs.list().filter(job =>
      job.batchId === batch.id && job.status === 'queued'));
    const terminal = context.store.latest('nowcoder-agent-market', 1)[0]!;
    const benchmarkPath = join(benchmarkRoot, 'benchmarks', `${batch.id}.json`);
    const benchmarkBefore = await readFile(benchmarkPath, 'utf8');

    const staleError = await context.service.onExtensionPlanResult({
      batchId: batch.id,
      discovered: 0,
      error: 'stale extension failure',
      needsAttention: true,
    });
    const repeatedError = await context.service.onExtensionPlanResult({
      batchId: batch.id,
      discovered: 0,
      error: 'duplicate stale extension failure',
    });
    const repeatedResult = await context.service.onExtensionPlanResult({
      batchId: batch.id,
      discovered: 999,
    });

    expect(staleError).toEqual(terminal);
    expect(repeatedError).toEqual(terminal);
    expect(repeatedResult).toEqual(terminal);
    expect(context.store.latest('nowcoder-agent-market', 1)[0]).toEqual(terminal);
    expect(benchmarkWrites).toBe(1);
    expect(await readFile(benchmarkPath, 'utf8')).toBe(benchmarkBefore);
  });

  it('bounds and sanitizes benchmark failure attention so the real store reopens', async () => {
    const sensitiveFailure = [
      '/Users/private/evidence/index.md',
      'https://private.example/session?cookie=secret',
      'raw benchmark failure',
      'x'.repeat(4_000),
    ].join(' ');
    const context = await fixture({
      candidates: nowcoderCandidates(10, 14_400),
      selectNowcoderJobs: acceptAllExcept(new Set()),
      syncJob: async () => { throw new Error('push failed first'); },
      writeBenchmark: async () => { throw new Error(sensitiveFailure); },
    });
    const batch = await context.service.run('nowcoder-agent-market', { force: true });
    await saveJobs(context, context.jobs.list().filter(job => job.batchId === batch.id));
    await saveJobs(context, context.jobs.list().filter(job =>
      job.batchId === batch.id && job.status === 'queued'));

    const terminal = context.store.latest('nowcoder-agent-market', 1)[0]!;
    expect(terminal.error).toContain('自动同步失败：push failed first');
    expect(terminal.error).toContain('基准报告写入失败');
    expect(terminal.error!.length).toBeLessThanOrEqual(2_000);
    expect(terminal.error).not.toContain('/Users/private');
    expect(terminal.error).not.toContain('private.example');
    expect(terminal.error).not.toContain('raw benchmark failure');

    const reopened = await context.reopen();
    expect(reopened.store.latest('nowcoder-agent-market', 1)[0]).toEqual(terminal);
  });

  it('resumes a terminal round on reconnect and dispatches only its refill jobs', async () => {
    const candidates = nowcoderCandidates(12, 15_000);
    const excluded = new Set(candidates.slice(0, 2).map(candidate => candidate.url));
    const context = await fixture({
      candidates,
      selectNowcoderJobs: acceptAllExcept(excluded),
    });
    const batch = await context.service.run('nowcoder-agent-market', { force: true });
    const firstRound = context.jobs.list().filter(job => job.batchId === batch.id);
    for (const job of firstRound) {
      await context.jobs.transition(job.id, 'collecting');
      await context.jobs.transition(job.id, 'saved', { outputPath: `/tmp/${job.id}/index.md` });
    }
    await context.store.reconcile(batch.id, context.jobs.list());
    context.dispatched.splice(0);

    await context.service.onExtensionConnected();

    expect(context.dispatched).toHaveLength(4);
    expect(context.dispatched.every(id => !firstRound.some(job => job.id === id))).toBe(true);
    expect(context.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      status: 'running',
      selectionStatus: 'pending',
      rounds: 2,
    });
  });

  it('repairs a queued current-batch orphan on reopen as one idempotent round', async () => {
    const context = await fixture();
    const batch = await context.store.start('nowcoder-agent-market');
    await context.store.markSelectionPending(batch.id);
    await context.jobs.create({
      id: 'orphan-after-job-create',
      url: 'https://www.nowcoder.com/discuss/18500',
      requestedBy: 'codex',
      batchId: batch.id,
      planId: 'nowcoder-agent-market',
    });
    const reopened = await context.reopen();

    await reopened.service.onExtensionConnected();

    expect(reopened.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      status: 'running',
      selectionStatus: 'pending',
      discovered: 1,
      accepted: 1,
      rounds: 1,
    });
    expect(context.discover).not.toHaveBeenCalled();
  });

  it('retries one cooled historical failure but keeps its second failure known', async () => {
    const candidate = nowcoderCandidates(1, 16_000)[0]!;
    const context = await fixture({
      now: '2026-08-24T05:00:00.000Z',
      candidates: [candidate],
    });
    const historical = await context.jobs.create({
      id: 'historical-failure',
      url: candidate.url,
      requestedBy: 'codex',
    });
    await context.jobs.transition(historical.id, 'failed', {
      errorCode: 'EXTRACTION_FAILED',
      errorMessage: '暂时失败',
    });
    context.setNow('2026-08-24T07:00:00.001Z');

    const batch = await context.service.run('nowcoder-agent-market', { force: true });
    const retry = context.jobs.list().find(job => job.batchId === batch.id)!;
    await context.jobs.transition(retry.id, 'collecting');
    const failed = await context.jobs.transition(retry.id, 'failed', {
      errorCode: 'EXTRACTION_FAILED',
      errorMessage: '再次失败',
    });
    await context.service.onJobTerminal(failed);

    expect(context.jobs.list().filter(job => job.url === candidate.url)).toHaveLength(2);
    expect(context.discover).toHaveBeenCalledTimes(2);
    expect(context.discover.mock.calls[1]![0]).toContain(candidate.url);
  });

  it('keeps an offline due batch pending and catches up immediately after Edge reconnects', async () => {
    const context = await fixture({ connected: false });

    const pending = await context.service.run('nowcoder-agent-market');
    expect(pending.status).toBe('running');
    expect(context.discover).not.toHaveBeenCalled();
    expect(context.dispatched).toEqual([]);

    context.setConnected(true);
    await context.service.onExtensionConnected();

    expect(context.discover).toHaveBeenCalledOnce();
    expect(context.dispatched).toHaveLength(2);
    expect(context.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      status: 'running',
      discovered: 2,
      accepted: 2,
    });
  });

  it('reconciles a running batch with attached jobs on reconnect without rediscovering or redispatching', async () => {
    const context = await fixture();
    const batch = await context.service.run('nowcoder-agent-market', { force: true });
    const children = context.jobs.list().filter(job => job.batchId === batch.id);
    expect(children).toHaveLength(2);
    await context.jobs.transition(children[0]!.id, 'dispatched');
    const dispatchedBeforeReconnect = [...context.dispatched];
    context.discover.mockClear();

    await context.service.onExtensionConnected();

    expect(context.discover).not.toHaveBeenCalled();
    expect(context.dispatched).toEqual(dispatchedBeforeReconnect);
    expect(context.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      status: 'running',
      discovered: 2,
      accepted: 2,
    });
  });

  it('starts ZSXQ collection through the extension and records discovery after its union pass', async () => {
    const context = await fixture();
    const batch = await context.service.run('zsxq-chen-teacher', { force: true });
    const attempt = currentZsxqAttempt(context.store, batch.id);
    expect(context.planMessages).toEqual([{
      batchId: batch.id,
      planId: 'zsxq-chen-teacher',
      attempt,
      force: true,
      mode: 'daily-ledger',
      targetDays: ['2026-08-22'],
    }]);

    const ownerJob = await context.jobs.create({
      id: 'owner-topic',
      url: 'https://wx.zsxq.com/group/48844584441158/topic/811111111111111',
      requestedBy: 'extension',
      batchId: batch.id,
      planId: 'zsxq-chen-teacher',
      planAttempt: attempt,
    });
    await context.service.onJobCreated(ownerJob);
    await context.service.onExtensionPlanResult({
      batchId: batch.id,
      attempt,
      discovered: 3,
      prepared: true,
      rejections: { '正文不完整': 1 },
      rejectionDetails: [{
        url: 'https://wx.zsxq.com/group/48844584441158/topic/822222222222222',
        reason: '正文不完整',
      }],
    });

    expect(context.store.latest('zsxq-chen-teacher', 1)[0]).toMatchObject({
      discovered: 3,
      accepted: 1,
      skipped: 2,
      rejections: { '正文不完整': 1 },
      rejectionDetails: [{
        url: 'https://wx.zsxq.com/group/48844584441158/topic/822222222222222',
        reason: '正文不完整',
      }],
    });
  });

  it('fails a ZSXQ attempt when its dispatcher resolves without an explicit delivery acknowledgement', async () => {
    const context = await fixture({
      collectZsxq: (async () => undefined) as unknown as (
        batchId: string,
        planId: 'zsxq-chen-teacher',
        attempt: CollectionPlanAttempt,
        force: boolean,
      ) => Promise<true>,
    });

    const started = await context.service.run('zsxq-chen-teacher', { force: true });

    expect(started).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('未派发'),
    });
    expect(context.store.latest('zsxq-chen-teacher', 1)[0]).toMatchObject({
      id: started.id,
      status: 'failed',
      error: expect.stringContaining('未派发'),
    });
  });

  it('restarts incomplete ZSXQ staging on reconnect even when one child was already attached', async () => {
    const context = await fixture();
    const batch = await context.service.run('zsxq-chen-teacher', { force: true });
    const firstAttempt = currentZsxqAttempt(context.store, batch.id);
    await context.service.onExtensionPlanResult({
      batchId: batch.id,
      attempt: firstAttempt,
      discovered: 3,
      prepared: false,
    });
    const partial = await context.jobs.create({
      id: `${batch.id}-partial`,
      url: 'https://wx.zsxq.com/group/48844584441158/topic/866666666666666',
      requestedBy: 'extension',
      batchId: batch.id,
      planId: 'zsxq-chen-teacher',
      planAttempt: firstAttempt,
    });
    await context.service.onJobCreated(partial);
    const reopened = await context.reopen();
    context.planMessages.length = 0;

    await reopened.service.onExtensionConnected();
    const currentAttempt = currentZsxqAttempt(reopened.store, batch.id);

    expect(context.planMessages).toEqual([{
      batchId: batch.id,
      planId: 'zsxq-chen-teacher',
      attempt: currentAttempt,
      force: true,
      mode: 'daily-ledger',
      targetDays: ['2026-08-22'],
    }]);
    expect(reopened.store.latest('zsxq-chen-teacher', 1)[0]).toMatchObject({
      status: 'running',
      preparationStatus: 'collecting',
      preparationAttempt: currentAttempt,
      discovered: 0,
      accepted: 0,
    });

    const currentChild = await reopened.jobs.create({
      id: `${batch.id}-current`,
      url: 'https://wx.zsxq.com/group/48844584441158/topic/877777777777777',
      requestedBy: 'extension',
      batchId: batch.id,
      planId: 'zsxq-chen-teacher',
      planAttempt: currentAttempt,
    });
    await reopened.service.onJobCreated(currentChild);

    await reopened.service.onExtensionPlanResult({
      batchId: batch.id,
      attempt: currentAttempt,
      discovered: 3,
      prepared: true,
    });
    context.planMessages.length = 0;
    await reopened.service.onExtensionConnected();

    expect(context.planMessages).toEqual([]);
    expect(reopened.store.latest('zsxq-chen-teacher', 1)[0]).toMatchObject({
      status: 'running',
      preparationStatus: 'completed',
      accepted: 1,
    });
  });

  it('treats a legacy running ZSXQ batch without preparation state as incomplete', async () => {
    const context = await fixture();
    const batch = await context.store.start('zsxq-chen-teacher');
    const stored = JSON.parse(await readFile(context.store.path, 'utf8')) as {
      batches: Array<Record<string, unknown>>;
    };
    delete stored.batches[0]!.preparationStatus;
    await writeFile(context.store.path, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
    const reopened = await context.reopen();
    context.planMessages.length = 0;

    await reopened.service.onExtensionConnected();

    expect(context.planMessages).toEqual([{
      batchId: batch.id,
      planId: 'zsxq-chen-teacher',
      attempt: expect.stringMatching(/^[a-f0-9]{16}$/),
      mode: 'daily-ledger',
      targetDays: ['2026-08-22'],
    }]);
  });

  it('reconciles rather than restaging a prepared running ZSXQ batch on a repeated run request', async () => {
    const context = await fixture();
    const batch = await context.service.run('zsxq-chen-teacher', { force: true });
    const attempt = currentZsxqAttempt(context.store, batch.id);
    const child = await context.jobs.create({
      id: `${batch.id}-prepared`,
      url: 'https://wx.zsxq.com/group/48844584441158/topic/877777777777777',
      requestedBy: 'extension',
      batchId: batch.id,
      planId: 'zsxq-chen-teacher',
      planAttempt: attempt,
    });
    await context.service.onJobCreated(child);
    await context.service.onExtensionPlanResult({
      batchId: batch.id,
      attempt,
      discovered: 1,
      prepared: true,
    });
    context.planMessages.length = 0;

    const resumed = await context.service.run('zsxq-chen-teacher');

    expect(context.planMessages).toEqual([]);
    expect(resumed).toMatchObject({
      id: batch.id,
      status: 'running',
      preparationStatus: 'completed',
      accepted: 1,
    });
  });

  it('ignores a stale prepared:false report after ZSXQ staging is complete', async () => {
    const context = await fixture();
    const batch = await context.service.run('zsxq-chen-teacher', { force: true });
    const attempt = currentZsxqAttempt(context.store, batch.id);
    const child = await context.jobs.create({
      id: `${batch.id}-monotonic`,
      url: 'https://wx.zsxq.com/group/48844584441158/topic/888888888888888',
      requestedBy: 'extension',
      batchId: batch.id,
      planId: 'zsxq-chen-teacher',
      planAttempt: attempt,
    });
    await context.service.onJobCreated(child);
    await context.service.onExtensionPlanResult({
      batchId: batch.id,
      attempt,
      discovered: 3,
      prepared: true,
      rejections: { '超出15天': 2 },
    });

    const afterStale = await context.service.onExtensionPlanResult({
      batchId: batch.id,
      attempt,
      discovered: 1,
      prepared: false,
      rejections: { '正文不完整': 1 },
    });

    expect(afterStale).toMatchObject({
      status: 'running',
      preparationStatus: 'completed',
      discovered: 3,
      rejections: { '超出15天': 2 },
    });
  });

  it('keeps a reconnected ZSXQ attempt running until the current attempt and all children finish', async () => {
    const context = await fixture({ shouldAutoSync: async () => true });
    const first = await context.service.run('zsxq-chen-teacher', { force: true });
    const firstAttempt = first.preparationAttempt;
    expect(firstAttempt).toMatch(/^[a-f0-9]{16}$/);

    const firstChild = await context.jobs.create({
      id: `${first.id}-first-attempt`,
      url: 'https://wx.zsxq.com/group/48844584441158/topic/811111111111111',
      requestedBy: 'extension',
      batchId: first.id,
      planId: 'zsxq-chen-teacher',
      planAttempt: firstAttempt,
    });
    await context.service.onJobCreated(firstChild);
    await context.jobs.transition(firstChild.id, 'collecting');
    const firstSaved = await context.jobs.transition(firstChild.id, 'saved', {
      outputPath: `/tmp/${firstChild.id}/index.md`,
    });
    await context.service.onJobTerminal(firstSaved);

    await context.service.onExtensionConnected();
    const current = context.store.latest('zsxq-chen-teacher', 1)[0]!;
    const currentAttempt = current.preparationAttempt;
    expect(currentAttempt).toBe(firstAttempt);
    expect(context.planMessages).toHaveLength(1);

    const prepared = await context.service.onExtensionPlanResult({
      batchId: first.id,
      attempt: currentAttempt!,
      discovered: 1,
      prepared: true,
      ...dailyLedgerFacts(),
    });
    expect(prepared).toMatchObject({ status: 'completed', accepted: 1, saved: 1 });

    expect(context.store.latest('zsxq-chen-teacher', 1)[0]).toMatchObject({
      status: 'completed',
      accepted: 1,
      saved: 1,
      deliveryIds: [expect.stringMatching(/^[a-f0-9]{12}$/)],
    });
    expect(context.synced).toEqual([firstChild.id]);
  });

  it('does not report a no-change success when relevant ZSXQ content stayed incomplete', async () => {
    const context = await fixture();
    const batch = await context.service.run('zsxq-chen-teacher', { force: true });
    const attempt = currentZsxqAttempt(context.store, batch.id);
    const incompleteUrl = 'https://wx.zsxq.com/group/48844584441158/topic/899999999999999';

    const result = await context.service.onExtensionPlanResult({
      batchId: batch.id,
      attempt,
      discovered: 1,
      prepared: true,
      rejections: { '正文不完整': 1 },
      rejectionDetails: [{ url: incompleteUrl, reason: '正文不完整' }],
    });

    expect(result).toMatchObject({
      status: 'completed_with_attention',
      saved: 0,
      deliveryIds: [],
      rejections: { '正文不完整': 1 },
      rejectionDetails: [{ url: incompleteUrl, reason: '正文不完整' }],
      error: expect.stringContaining('正文不完整'),
    });
  });

  it('turns an authentication result into attention instead of retrying or reporting a hard failure', async () => {
    const context = await fixture();
    const batch = await context.service.run('zsxq-chen-teacher', { force: true });
    const attempt = currentZsxqAttempt(context.store, batch.id);

    const result = await context.service.onExtensionPlanResult({
      batchId: batch.id,
      attempt,
      discovered: 0,
      error: '请先登录知识星球',
      needsAttention: true,
    });

    expect(result).toMatchObject({ status: 'completed_with_attention', error: '请先登录知识星球' });
  });

  it('records only successfully synchronized ZSXQ content as batch deliveries', async () => {
    const context = await fixture({ shouldAutoSync: async () => true });
    const batch = await context.service.run('zsxq-chen-teacher', { force: true });
    const attempt = currentZsxqAttempt(context.store, batch.id);
    const child = await context.jobs.create({
      id: 'owner-delivered',
      url: 'https://wx.zsxq.com/group/48844584441158/topic/833333333333333',
      requestedBy: 'extension',
      batchId: batch.id,
      planId: 'zsxq-chen-teacher',
      planAttempt: attempt,
    });
    await context.service.onJobCreated(child);
    await context.service.onExtensionPlanResult({
      batchId: batch.id,
      attempt,
      discovered: 1,
      prepared: true,
      ...dailyLedgerFacts(),
    });
    await context.jobs.transition(child.id, 'collecting');
    const saved = await context.jobs.transition(child.id, 'saved', {
      outputPath: `/tmp/${child.id}/index.md`,
    });

    await context.service.onJobTerminal(saved);
    await context.service.onJobTerminal(saved);

    expect(context.synced).toEqual([child.id]);
    expect(context.store.latest('zsxq-chen-teacher', 1)[0]).toMatchObject({
      status: 'completed',
      deliveryIds: [expect.stringMatching(/^[a-f0-9]{12}$/)],
    });
  });

  it('resumes the saved-before-sync crash gap and durably delivers the ZSXQ job after reopen', async () => {
    const context = await fixture({ shouldAutoSync: async () => true });
    const { batch, saved } = await stageSavedZsxqJob(
      context,
      'owner-restart-gap',
      'https://wx.zsxq.com/group/48844584441158/topic/844444444444441',
    );

    // 模拟 Bridge 在 JobStore 写入 saved 后、调用 onJobTerminal 前退出。
    const reopened = await context.reopen();
    await reopened.service.onExtensionConnected();

    expect(context.synced).toEqual([saved.id]);
    expect(reopened.store.latest('zsxq-chen-teacher', 1)[0]).toMatchObject({
      id: batch.id,
      status: 'completed',
      saved: 1,
      deliveryIds: ['9fa6e4766912'],
    });
  });

  it('does not complete a saved ZSXQ batch when source validation rejects automatic sync', async () => {
    const context = await fixture({ shouldAutoSync: async () => false });
    const { batch, saved } = await stageSavedZsxqJob(
      context,
      'owner-invalid-source',
      'https://wx.zsxq.com/group/48844584441158/topic/844444444444442',
    );

    await context.service.onJobTerminal(saved);

    expect(context.synced).toEqual([]);
    expect(context.store.latest('zsxq-chen-teacher', 1)[0]).toMatchObject({
      id: batch.id,
      status: 'completed_with_attention',
      saved: 1,
      deliveryIds: [],
      error: expect.stringContaining('未确认交付'),
    });
  });

  it('does not turn a restart-time ZSXQ sync failure into a completed batch', async () => {
    const syncAttempts: string[] = [];
    const context = await fixture({
      shouldAutoSync: async () => true,
      syncJob: async job => {
        syncAttempts.push(job.id);
        throw new Error('重启补同步失败');
      },
    });
    const { batch, saved } = await stageSavedZsxqJob(
      context,
      'owner-restart-sync-failure',
      'https://wx.zsxq.com/group/48844584441158/topic/844444444444443',
    );

    const reopened = await context.reopen();
    await reopened.service.onExtensionConnected();

    expect(syncAttempts).toEqual([saved.id]);
    expect(reopened.store.latest('zsxq-chen-teacher', 1)[0]).toMatchObject({
      id: batch.id,
      status: 'completed_with_attention',
      saved: 1,
      deliveryIds: [],
      error: expect.stringContaining('重启补同步失败'),
    });
  });

  it('replays a crash-gap ZSXQ delivery at most once across repeated reconnects', async () => {
    const syncAttempts: string[] = [];
    const context = await fixture({
      shouldAutoSync: async () => true,
      syncJob: async job => { syncAttempts.push(job.id); },
    });
    const { batch, saved } = await stageSavedZsxqJob(
      context,
      'owner-restart-idempotent',
      'https://wx.zsxq.com/group/48844584441158/topic/844444444444441',
    );

    const reopened = await context.reopen();
    await reopened.service.onExtensionConnected();
    await reopened.service.onExtensionConnected();

    expect(syncAttempts).toEqual([saved.id]);
    expect(reopened.store.latest('zsxq-chen-teacher', 1)[0]).toMatchObject({
      id: batch.id,
      status: 'completed',
      deliveryIds: ['9fa6e4766912'],
    });
  });

  it('surfaces a ZSXQ automatic sync failure on the terminal batch', async () => {
    const context = await fixture({
      shouldAutoSync: async () => true,
      syncJob: async () => { throw new Error('推送失败'); },
    });
    const batch = await context.service.run('zsxq-chen-teacher', { force: true });
    const attempt = currentZsxqAttempt(context.store, batch.id);
    const child = await context.jobs.create({
      id: 'owner-sync-failure',
      url: 'https://wx.zsxq.com/group/48844584441158/topic/822222222222222',
      requestedBy: 'extension',
      batchId: batch.id,
      planId: 'zsxq-chen-teacher',
      planAttempt: attempt,
    });
    await context.service.onJobCreated(child);
    await context.service.onExtensionPlanResult({
      batchId: batch.id,
      attempt,
      discovered: 1,
      prepared: true,
    });
    await context.jobs.transition(child.id, 'collecting');
    const saved = await context.jobs.transition(child.id, 'saved', {
      outputPath: `/tmp/${child.id}/index.md`,
    });

    await context.service.onJobTerminal(saved);

    expect(context.store.latest('zsxq-chen-teacher', 1)[0]).toMatchObject({
      status: 'completed_with_attention',
      error: expect.stringContaining('自动同步失败：推送失败'),
    });
  });

  it('retries the same exact ten after mixed sync and retry-finalization failures', async () => {
    const syncAttempts: string[] = [];
    const sinkUrls = new Set<string>();
    let failOne = true;
    let planPath = '';
    let persistedPath = '';
    const context = await fixture({
      candidates: nowcoderCandidates(10, 17_000),
      selectNowcoderJobs: async jobs => ({
        accepted: jobs,
        coverage: { bytedance: 1, tencent: 1, alibaba: 0, ant: 0 },
        rejected: [],
      }),
      syncJob: async job => {
        syncAttempts.push(job.url);
        if (failOne && syncAttempts.length === 4) throw new Error(`${job.id} 推送失败`);
        sinkUrls.add(job.url);
        if (!failOne && syncAttempts.length === 20) {
          persistedPath = `${planPath}.persisted`;
          await rename(planPath, persistedPath);
          await mkdir(planPath);
        }
      },
    });
    planPath = context.store.path;
    const batch = await context.service.run('nowcoder-agent-market', { force: true });
    await saveJobs(context, context.jobs.list().filter(job => job.batchId === batch.id));
    await saveJobs(context, context.jobs.list().filter(job =>
      job.batchId === batch.id && job.status === 'queued'));

    const retryable = context.store.latest('nowcoder-agent-market', 1)[0]!;
    expect(retryable).toMatchObject({
      status: 'completed_with_attention',
      error: expect.stringContaining('自动同步失败'),
      deliveryIds: [],
      selectionStatus: 'pending',
    });
    expect(syncAttempts).toHaveLength(10);
    const firstSelection = [...syncAttempts];
    expect(sinkUrls.size).toBe(9);

    failOne = false;
    const retry = await context.reopen();
    try {
      await expect(retry.service.onExtensionConnected()).rejects.toThrow();

      expect(retry.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
        status: 'running',
        selectionStatus: 'pending',
        deliveryIds: [],
      });
    } finally {
      await rmdir(planPath);
      await rename(persistedPath, planPath);
    }

    expect(syncAttempts).toHaveLength(20);
    expect(syncAttempts.slice(10)).toEqual(firstSelection);
    expect(sinkUrls.size).toBe(10);
    const reopened = await context.reopen();
    expect(reopened.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      status: 'running',
      selectionStatus: 'pending',
      deliveryIds: [],
    });

    await reopened.service.onExtensionConnected();

    expect(syncAttempts).toHaveLength(30);
    expect(syncAttempts.slice(20)).toEqual(firstSelection);
    expect(sinkUrls.size).toBe(10);
    expect(reopened.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      status: 'completed',
      selectionStatus: 'completed',
      deliveryIds: expect.arrayContaining(firstSelection.map(() =>
        expect.stringMatching(/^[a-f0-9]{12}$/))),
    });
    const deliveryIds = reopened.store.latest('nowcoder-agent-market', 1)[0]!.deliveryIds;
    expect(deliveryIds).toHaveLength(10);
    expect(new Set(deliveryIds).size).toBe(10);
  });

  it('waits for every Nowcoder detail before applying the real evidence selection once', async () => {
    const selectedCalls: string[][] = [];
    const context = await fixture({
      shouldAutoSync: async () => true,
      selectNowcoderJobs: async jobs => {
        selectedCalls.push(jobs.map(job => job.url));
        return {
          accepted: [jobs[1]!],
          coverage: { bytedance: 0, tencent: 1, alibaba: 0, ant: 0 },
          rejected: [{ url: jobs[0]!.url, reason: '证据等级不足' }],
        };
      },
    });
    const batch = await context.service.run('nowcoder-agent-market', { force: true });
    const children = context.jobs.list().filter(job => job.batchId === batch.id);

    await context.jobs.transition(children[0]!.id, 'collecting');
    const first = await context.jobs.transition(children[0]!.id, 'saved', {
      outputPath: `/tmp/${children[0]!.id}/index.md`,
    });
    await context.service.onJobTerminal(first);
    expect(context.synced).toEqual([]);
    expect(selectedCalls).toEqual([]);

    await context.jobs.transition(children[1]!.id, 'collecting');
    const second = await context.jobs.transition(children[1]!.id, 'saved', {
      outputPath: `/tmp/${children[1]!.id}/index.md`,
    });
    await context.service.onJobTerminal(second);
    await context.service.onJobTerminal(second);

    expect(selectedCalls).toEqual([[children[0]!.url, children[1]!.url]]);
    expect(context.synced).toEqual([]);
    expect(context.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      status: 'completed_with_attention',
      accepted: 1,
      skipped: 1,
      selectionStatus: 'completed',
      coverage: { bytedance: 0, tencent: 1, alibaba: 0, ant: 0 },
      rejections: { '证据等级不足': 1 },
    });
  });

  it('treats one unsupported discovery detail as a content rejection when another detail proves extraction works', async () => {
    const context = await fixture({
      selectNowcoderJobs: async jobs => ({
        accepted: [],
        coverage: { bytedance: 0, tencent: 0, alibaba: 0, ant: 0 },
        rejected: jobs.map(item => ({ url: item.url, reason: '证据等级不足' })),
      }),
    });
    const batch = await context.service.run('nowcoder-agent-market', { force: true });
    const children = context.jobs.list().filter(job => job.batchId === batch.id);

    await context.jobs.transition(children[0]!.id, 'collecting');
    const saved = await context.jobs.transition(children[0]!.id, 'saved', {
      outputPath: `/tmp/${children[0]!.id}/index.md`,
    });
    await context.service.onJobTerminal(saved);
    await context.jobs.transition(children[1]!.id, 'collecting');
    const unsupported = await context.jobs.transition(children[1]!.id, 'failed', {
      errorCode: 'UNSUPPORTED_LAYOUT',
      errorMessage: '请在牛客网打开一篇面经或讨论的详情页后重试',
    });
    await context.service.onJobTerminal(unsupported);

    expect(context.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      status: 'completed_with_attention',
      discovered: 2,
      accepted: 0,
      saved: 0,
      skipped: 2,
      failed: 0,
      selectionStatus: 'completed',
      rejections: {
        '证据等级不足': 1,
        '页面结构不含可采集正文': 1,
      },
      deliveryIds: [],
    });
  });

  it('keeps an all-unsupported Nowcoder batch failed so a site-wide layout change cannot pass silently', async () => {
    const context = await fixture();
    const batch = await context.service.run('nowcoder-agent-market', { force: true });
    const children = context.jobs.list().filter(job => job.batchId === batch.id);

    for (const child of children) {
      await context.jobs.transition(child.id, 'collecting');
      const unsupported = await context.jobs.transition(child.id, 'failed', {
        errorCode: 'UNSUPPORTED_LAYOUT',
        errorMessage: '请在牛客网打开一篇面经或讨论的详情页后重试',
      });
      await context.service.onJobTerminal(unsupported);
    }

    expect(context.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      status: 'failed',
      accepted: 0,
      saved: 0,
      failed: 2,
      selectionStatus: 'completed',
    });
  });

  it('ends an empty Nowcoder discovery with attention instead of a false success', async () => {
    const context = await fixture({ candidates: [] });

    const batch = await context.service.run('nowcoder-agent-market', { force: true });

    expect(context.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      id: batch.id,
      status: 'completed_with_attention',
      selectionStatus: 'completed',
      discovered: 0,
      accepted: 0,
      saved: 0,
      skipped: 0,
      coverage: { bytedance: 0, tencent: 0, alibaba: 0, ant: 0 },
    });
  });

  it('recovers a persisted empty pending round by restarting discovery', async () => {
    const context = await fixture();
    const batch = await context.store.start('nowcoder-agent-market');
    await context.store.markDiscovery(batch.id, 0, {
      bytedance: 0, tencent: 0, alibaba: 0, ant: 0,
    });
    await context.store.markSelectionPending(batch.id);

    await context.service.onExtensionConnected();

    expect(context.discover).toHaveBeenCalledOnce();
    expect(context.dispatched).toHaveLength(2);
    expect(context.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      status: 'running',
      selectionStatus: 'pending',
      discovered: 2,
      rounds: 1,
    });
  });

  it('does not turn a discovery failure into a clean completion on reconnect', async () => {
    const context = await fixture({
      discoverNowcoder: async () => { throw new Error('搜索端不可用'); },
    });

    const failed = await context.service.run('nowcoder-agent-market', { force: true });
    expect(failed).toMatchObject({
      status: 'failed',
      selectionStatus: 'collecting',
      error: '搜索端不可用',
    });

    await context.service.onExtensionConnected();

    expect(context.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      status: 'failed',
      selectionStatus: 'collecting',
      error: '搜索端不可用',
    });
  });
});
