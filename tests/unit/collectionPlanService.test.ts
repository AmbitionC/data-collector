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
  discoverNowcoder?: () => Promise<Array<{
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
  const now = () => options.now ?? '2026-08-23T01:05:00.000Z';
  const store = await CollectionPlanStore.open(join(root, 'plans.json'), now);
  const jobs = await JobStore.open(join(root, 'jobs.json'), { now, id: () => crypto.randomUUID() });
  const dispatched: string[] = [];
  const planMessages: Array<{ batchId: string; planId: CollectionPlanId }> = [];
  const synced: string[] = [];
  const shouldAutoSync = options.shouldAutoSync ?? (async () => false);
  const discover = vi.fn(options.discoverNowcoder ?? (async () => options.candidates ?? [
    { url: 'https://www.nowcoder.com/discuss/8001', queryCompany: 'bytedance' as const },
    { url: 'https://www.nowcoder.com/discuss/8002', queryCompany: 'tencent' as const },
  ]));
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
  };
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

  it('auto-syncs only eligible saved jobs and reconciles all terminal outcomes exactly once', async () => {
    const context = await fixture({ shouldAutoSync: async job => job.url.endsWith('/8001') });
    const batch = await context.service.run('nowcoder-agent-market', { force: true });
    const children = context.jobs.list().filter(job => job.batchId === batch.id);
    expect(children).toHaveLength(2);

    for (const child of children) {
      await context.jobs.transition(child.id, 'collecting');
      const saved = await context.jobs.transition(child.id, 'saved', { outputPath: `/tmp/${child.id}/index.md` });
      await context.service.onJobTerminal(saved);
      await context.service.onJobTerminal(saved);
    }

    expect(context.synced).toEqual([children.find(job => job.url.endsWith('/8001'))!.id]);
    expect(context.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      status: 'completed',
      accepted: 1,
      saved: 1,
      skipped: 1,
      failed: 0,
      needsAttention: 0,
      selectionStatus: 'completed',
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

  it('surfaces selected Nowcoder sync failures instead of reporting a clean completion', async () => {
    const context = await fixture({
      selectNowcoderJobs: async jobs => ({
        accepted: jobs,
        coverage: { bytedance: 1, tencent: 1, alibaba: 0, ant: 0 },
        rejected: [],
      }),
      syncJob: async job => { throw new Error(`${job.id} 推送失败`); },
    });
    const batch = await context.service.run('nowcoder-agent-market', { force: true });
    const children = context.jobs.list().filter(job => job.batchId === batch.id);
    for (const child of children) {
      await context.jobs.transition(child.id, 'collecting');
      const saved = await context.jobs.transition(child.id, 'saved', {
        outputPath: `/tmp/${child.id}/index.md`,
      });
      await context.service.onJobTerminal(saved);
    }

    expect(context.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      status: 'completed_with_attention',
      error: expect.stringContaining('自动同步失败'),
    });
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
    expect(context.synced).toEqual([children[1]!.id]);
    expect(context.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      accepted: 1,
      skipped: 1,
      selectionStatus: 'completed',
      coverage: { bytedance: 0, tencent: 1, alibaba: 0, ant: 0 },
      rejections: { '证据等级不足': 1 },
    });
  });

  it('resumes a terminal Nowcoder batch whose persisted final selection is still pending', async () => {
    const selected = vi.fn(async (jobs: readonly JobRecord[]) => ({
      accepted: [jobs[0]!],
      coverage: { bytedance: 1, tencent: 0, alibaba: 0, ant: 0 },
      rejected: jobs.slice(1).map(job => ({ url: job.url, reason: '证据等级不足' })),
    }));
    const context = await fixture({
      selectNowcoderJobs: selected,
      syncJob: async job => { context.synced.push(job.id); },
    });
    const batch = await context.service.run('nowcoder-agent-market', { force: true });
    const children = context.jobs.list().filter(job => job.batchId === batch.id);
    for (const child of children) {
      await context.jobs.transition(child.id, 'collecting');
      await context.jobs.transition(child.id, 'saved', { outputPath: `/tmp/${child.id}/index.md` });
    }
    await context.store.reconcile(batch.id, context.jobs.list());

    expect(context.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      status: 'completed',
      selectionStatus: 'pending',
    });

    await context.service.onExtensionConnected();

    expect(selected).toHaveBeenCalledOnce();
    expect(context.synced).toEqual([children[0]!.id]);
    expect(context.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      accepted: 1,
      skipped: 1,
      selectionStatus: 'completed',
    });
  });

  it('finalizes an empty Nowcoder discovery immediately without waiting for reconnect', async () => {
    const context = await fixture({ candidates: [] });

    const batch = await context.service.run('nowcoder-agent-market', { force: true });

    expect(context.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      id: batch.id,
      status: 'completed',
      selectionStatus: 'completed',
      discovered: 0,
      accepted: 0,
      saved: 0,
      skipped: 0,
      coverage: { bytedance: 0, tencent: 0, alibaba: 0, ant: 0 },
    });
  });

  it('recovers a persisted empty pending discovery without searching again', async () => {
    const context = await fixture();
    const batch = await context.store.start('nowcoder-agent-market');
    await context.store.markDiscovery(batch.id, 0, {
      bytedance: 0, tencent: 0, alibaba: 0, ant: 0,
    });
    await context.store.markSelectionPending(batch.id);

    await context.service.onExtensionConnected();

    expect(context.discover).not.toHaveBeenCalled();
    expect(context.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      status: 'completed',
      selectionStatus: 'completed',
      discovered: 0,
    });
  });

  it('accounts for candidates beyond the twelve-detail pool as explicit rejections', async () => {
    const companies = [
      ...Array.from({ length: 4 }, () => 'bytedance' as const),
      ...Array.from({ length: 4 }, () => 'tencent' as const),
      ...Array.from({ length: 3 }, () => 'alibaba' as const),
      ...Array.from({ length: 3 }, () => 'ant' as const),
    ];
    const context = await fixture({
      candidates: companies.map((queryCompany, index) => ({
        url: `https://www.nowcoder.com/discuss/${9000 + index}`,
        queryCompany,
      })),
      selectNowcoderJobs: async jobs => ({
        accepted: [...jobs],
        coverage: { bytedance: 4, tencent: 4, alibaba: 2, ant: 2 },
        rejected: [],
      }),
    });
    const batch = await context.service.run('nowcoder-agent-market', { force: true });
    const children = context.jobs.list().filter(job => job.batchId === batch.id);
    expect(children).toHaveLength(12);
    for (const child of children) {
      await context.jobs.transition(child.id, 'collecting');
      const saved = await context.jobs.transition(child.id, 'saved', {
        outputPath: `/tmp/${child.id}/index.md`,
      });
      await context.service.onJobTerminal(saved);
    }

    expect(context.store.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      discovered: 14,
      accepted: 12,
      saved: 12,
      skipped: 2,
      rejections: { '发现池/单批详情上限': 2 },
      selectionStatus: 'completed',
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
