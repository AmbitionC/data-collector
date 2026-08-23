import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JobRecord } from '@data-collector/shared';
import { CollectionPlanStore } from '../../packages/bridge/src/plans/index.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const temporaryDirectories = createTemporaryDirectoryTracker();
afterEach(() => temporaryDirectories.cleanup());

function job(id: string, status: JobRecord['status'], errorCode?: string): JobRecord {
  return {
    id,
    url: `https://www.nowcoder.com/discuss/${id.replace(/\D/g, '') || '1'}`,
    requestedBy: 'codex',
    status,
    createdAt: '2026-08-23T01:00:00.000Z',
    updatedAt: '2026-08-23T01:02:00.000Z',
    ...(errorCode ? { errorCode } : {}),
  };
}

describe('CollectionPlanStore', () => {
  it('keeps a batch running until every attached child is terminal', async () => {
    const root = await temporaryDirectories.create('plan-store-');
    const store = await CollectionPlanStore.open(
      join(root, 'collection-plans.json'),
      () => '2026-08-23T01:00:00.000Z',
    );
    const batch = await store.start('nowcoder-agent-market');
    await store.markDiscovery(batch.id, 3, { bytedance: 1, tencent: 0, alibaba: 0, ant: 0 });
    await Promise.all(['job-1', 'job-2', 'job-3'].map(id => store.attachJob(batch.id, id)));

    const running = await store.reconcile(batch.id, [
      job('job-1', 'saved'),
      job('job-2', 'collecting'),
      job('job-3', 'queued'),
    ]);

    expect(running).toMatchObject({ status: 'running', accepted: 3, saved: 1 });
    expect(running.finishedAt).toBeUndefined();
  });

  it('reconciles exact terminal saved, skipped, failed, and attention counts', async () => {
    const times = ['2026-08-23T01:00:00.000Z', '2026-08-23T01:03:00.000Z'];
    const root = await temporaryDirectories.create('plan-store-terminal-');
    const store = await CollectionPlanStore.open(join(root, 'plans.json'), () => times.shift()!);
    const batch = await store.start('nowcoder-agent-market');
    await store.markDiscovery(batch.id, 4);
    for (const id of ['saved', 'skipped', 'failed', 'attention']) await store.attachJob(batch.id, id);

    const terminal = await store.reconcile(batch.id, [
      job('saved', 'saved'),
      job('skipped', 'failed', 'QUALITY_REJECTED'),
      job('failed', 'failed', 'EXTRACTION_FAILED'),
      job('attention', 'needs_attention', 'AUTH_REQUIRED'),
    ]);

    expect(terminal).toMatchObject({
      status: 'completed_with_attention',
      discovered: 4,
      accepted: 4,
      saved: 1,
      skipped: 1,
      failed: 1,
      needsAttention: 1,
      finishedAt: '2026-08-23T01:03:00.000Z',
    });
  });

  it('persists batches and job membership across reopen', async () => {
    const root = await temporaryDirectories.create('plan-store-reopen-');
    const path = join(root, 'plans.json');
    const first = await CollectionPlanStore.open(path, () => '2026-08-23T01:00:00.000Z');
    const batch = await first.start('zsxq-chen-teacher');
    await first.markDiscovery(batch.id, 1);
    await first.attachJob(batch.id, 'topic-1');

    const reopened = await CollectionPlanStore.open(path, () => '2026-08-23T01:05:00.000Z');
    const completed = await reopened.reconcile(batch.id, [job('topic-1', 'saved')]);

    expect(completed.status).toBe('completed');
    expect(reopened.latest('zsxq-chen-teacher', 1)[0]).toEqual(completed);
  });

  it('does not overwrite a corrupt state file', async () => {
    const root = await temporaryDirectories.create('plan-store-corrupt-');
    const path = join(root, 'plans.json');
    const corrupt = '{"version":1,"batches":"broken"}\n';
    await writeFile(path, corrupt, 'utf8');

    await expect(CollectionPlanStore.open(path)).rejects.toThrow('采集批次文件格式无效');
    expect(await readFile(path, 'utf8')).toBe(corrupt);
  });
});
