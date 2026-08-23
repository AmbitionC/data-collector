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
  shouldAutoSync?: (job: JobRecord) => Promise<boolean>;
} = {}) {
  const root = await temporaryDirectories.create('collection-plan-service-');
  let connected = options.connected ?? true;
  const now = () => options.now ?? '2026-08-23T01:05:00.000Z';
  const store = await CollectionPlanStore.open(join(root, 'plans.json'), now);
  const jobs = await JobStore.open(join(root, 'jobs.json'), { now, id: () => crypto.randomUUID() });
  const dispatched: string[] = [];
  const planMessages: Array<{ batchId: string; planId: CollectionPlanId }> = [];
  const synced: string[] = [];
  const discover = vi.fn(async () => options.candidates ?? [
    { url: 'https://www.nowcoder.com/discuss/8001', queryCompany: 'bytedance' as const },
    { url: 'https://www.nowcoder.com/discuss/8002', queryCompany: 'tencent' as const },
  ]);
  const service = new CollectionPlanService({
    store,
    jobs,
    now,
    extensionConnected: () => connected,
    discoverNowcoder: discover,
    dispatch: async job => { dispatched.push(job.id); },
    collectZsxq: async (batchId, planId) => { planMessages.push({ batchId, planId }); },
    shouldAutoSync: options.shouldAutoSync ?? (async () => false),
    syncJob: async job => { synced.push(job.id); },
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
      saved: 2,
      failed: 0,
      needsAttention: 0,
    });
  });
});
