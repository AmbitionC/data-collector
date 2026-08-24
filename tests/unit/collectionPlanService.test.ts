import { mkdir, rename, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollectionPlanId, JobRecord } from '@data-collector/shared';
import { JobStore } from '../../packages/bridge/src/jobs/store.js';
import {
  CollectionPlanService,
  CollectionPlanStore,
  planDueState,
} from '../../packages/bridge/src/plans/index.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const temporaryDirectories = createTemporaryDirectoryTracker();
afterEach(() => temporaryDirectories.cleanup());

async function fixture(options: {
  connected?: boolean;
  now?: string;
  candidates?: Array<{ url: string; queryCompany: 'bytedance' | 'tencent' | 'alibaba' | 'ant' }>;
  discoverNowcoder?: (knownUrls: ReadonlySet<string>) => Promise<Array<{
    url: string;
    queryCompany: 'bytedance' | 'tencent' | 'alibaba' | 'ant';
  }>>;
  shouldAutoSync?: (job: JobRecord) => Promise<boolean>;
  selectNowcoderJobs?: (
    jobs: readonly JobRecord[],
    now: string,
  ) => Promise<{
    accepted: JobRecord[];
    coverage: Record<string, number>;
      rejected: Array<{ url: string; reason: string }>;
    }>;
  syncJob?: (job: JobRecord) => Promise<void>;
} = {}) {
  const root = await temporaryDirectories.create('collection-plan-service-');
  let connected = options.connected ?? true;
  let currentNow = options.now ?? '2026-08-23T01:05:00.000Z';
  const now = () => currentNow;
  const store = await CollectionPlanStore.open(join(root, 'plans.json'), now);
  const jobs = await JobStore.open(join(root, 'jobs.json'), { now, id: () => crypto.randomUUID() });
  const dispatched: string[] = [];
  const planMessages: Array<{ batchId: string; planId: CollectionPlanId }> = [];
  const synced: string[] = [];
  const shouldAutoSync = options.shouldAutoSync ?? (async () => false);
  const discover = vi.fn(options.discoverNowcoder ?? (async knownUrls => (options.candidates ?? [
    { url: 'https://www.nowcoder.com/discuss/8001', queryCompany: 'bytedance' as const },
    { url: 'https://www.nowcoder.com/discuss/8002', queryCompany: 'tencent' as const },
  ]).filter(candidate => !knownUrls.has(candidate.url))));
  const service = new CollectionPlanService({
    store,
    jobs,
    now,
    extensionConnected: () => connected,
    discoverNowcoder: discover,
    dispatch: async job => { dispatched.push(job.id); },
    collectZsxq: async (batchId, planId) => { planMessages.push({ batchId, planId }); },
    shouldAutoSync,
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
  });
  return {
    service,
    store,
    jobs,
    discover,
    dispatched,
    planMessages,
    synced,
    setConnected(value: boolean) { connected = value; },
    setNow(value: string) { currentNow = value; },
    async reopen() {
      const reopenedStore = await CollectionPlanStore.open(store.path, now);
      const reopenedJobs = await JobStore.open(jobs.path, { now, id: () => crypto.randomUUID() });
      const reopenedService = new CollectionPlanService({
        store: reopenedStore,
        jobs: reopenedJobs,
        now,
        extensionConnected: () => connected,
        discoverNowcoder: discover,
        dispatch: async job => { dispatched.push(job.id); },
        collectZsxq: async (batchId, planId) => { planMessages.push({ batchId, planId }); },
        shouldAutoSync,
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
    expect(context.planMessages).toEqual([{ batchId: batch.id, planId: 'zsxq-chen-teacher' }]);

    const ownerJob = await context.jobs.create({
      id: 'owner-topic',
      url: 'https://wx.zsxq.com/group/48844584441158/topic/811111111111111',
      requestedBy: 'extension',
      batchId: batch.id,
      planId: 'zsxq-chen-teacher',
    });
    await context.service.onJobCreated(ownerJob);
    await context.service.onExtensionPlanResult({ batchId: batch.id, discovered: 3 });

    expect(context.store.latest('zsxq-chen-teacher', 1)[0]).toMatchObject({
      discovered: 3,
      accepted: 1,
      skipped: 2,
    });
  });

  it('turns an authentication result into attention instead of retrying or reporting a hard failure', async () => {
    const context = await fixture();
    const batch = await context.service.run('zsxq-chen-teacher', { force: true });

    const result = await context.service.onExtensionPlanResult({
      batchId: batch.id,
      discovered: 0,
      error: '请先登录知识星球',
      needsAttention: true,
    });

    expect(result).toMatchObject({ status: 'completed_with_attention', error: '请先登录知识星球' });
  });

  it('records only successfully synchronized ZSXQ content as batch deliveries', async () => {
    const context = await fixture({ shouldAutoSync: async () => true });
    const batch = await context.service.run('zsxq-chen-teacher', { force: true });
    const child = await context.jobs.create({
      id: 'owner-delivered',
      url: 'https://wx.zsxq.com/group/48844584441158/topic/833333333333333',
      requestedBy: 'extension',
      batchId: batch.id,
      planId: 'zsxq-chen-teacher',
    });
    await context.service.onJobCreated(child);
    await context.service.onExtensionPlanResult({ batchId: batch.id, discovered: 1 });
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

  it('surfaces a ZSXQ automatic sync failure on the terminal batch', async () => {
    const context = await fixture({
      shouldAutoSync: async () => true,
      syncJob: async () => { throw new Error('推送失败'); },
    });
    const batch = await context.service.run('zsxq-chen-teacher', { force: true });
    const child = await context.jobs.create({
      id: 'owner-sync-failure',
      url: 'https://wx.zsxq.com/group/48844584441158/topic/822222222222222',
      requestedBy: 'extension',
      batchId: batch.id,
      planId: 'zsxq-chen-teacher',
    });
    await context.service.onJobCreated(child);
    await context.service.onExtensionPlanResult({ batchId: batch.id, discovered: 1 });
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

  it('retries the same exact ten without partial delivery after a mixed sync failure', async () => {
    const syncAttempts: string[] = [];
    const sinkUrls = new Set<string>();
    let failOne = true;
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
      },
    });
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
    const reopened = await context.reopen();
    await reopened.service.onExtensionConnected();

    expect(syncAttempts).toHaveLength(20);
    expect(syncAttempts.slice(10)).toEqual(firstSelection);
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
