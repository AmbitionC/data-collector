import { mkdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectionBatchSchema, type JobRecord } from '@data-collector/shared';
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
  it('persists one round while atomically attaching all jobs in that round', async () => {
    const root = await temporaryDirectories.create('plan-store-round-');
    const path = join(root, 'plans.json');
    const store = await CollectionPlanStore.open(path, () => '2026-08-23T01:00:00.000Z');
    const batch = await store.start('nowcoder-agent-market');

    expect(batch.rounds).toBe(0);

    await store.markDiscovery(batch.id, 2);
    await store.attachRound(batch.id, ['job-1', 'job-2', 'job-2']);
    const reopened = await CollectionPlanStore.open(path);

    expect(reopened.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      accepted: 2,
      rounds: 1,
    });
  });

  it('counts recovered orphan jobs as one round without double-incrementing on replay', async () => {
    const root = await temporaryDirectories.create('plan-store-recovered-jobs-');
    const path = join(root, 'plans.json');
    const store = await CollectionPlanStore.open(path, () => '2026-08-23T01:00:00.000Z');
    const batch = await store.start('nowcoder-agent-market');
    await store.markDiscovery(batch.id, 1);
    await store.attachRound(batch.id, ['job-1']);

    await store.attachRecoveredJobs(batch.id, ['job-1', 'orphan-job']);
    await store.attachRecoveredJobs(batch.id, ['job-1', 'orphan-job']);
    const reopened = await CollectionPlanStore.open(path);

    expect(reopened.latest('nowcoder-agent-market', 1)[0]).toMatchObject({
      discovered: 2,
      accepted: 2,
      rounds: 2,
    });
  });

  it('reopens a terminal pending Nowcoder selection and keeps its round count schema-valid', async () => {
    const times = ['2026-08-23T01:00:00.000Z', '2026-08-23T01:03:00.000Z'];
    const root = await temporaryDirectories.create('plan-store-resume-');
    const path = join(root, 'plans.json');
    const store = await CollectionPlanStore.open(path, () => times.shift()!);
    const batch = await store.start('nowcoder-agent-market');
    await store.markDiscovery(batch.id, 1);
    await store.attachRound(batch.id, ['job-1']);
    await store.markSelectionPending(batch.id);
    await store.reconcile(batch.id, [job('job-1', 'saved')]);

    const resumed = await store.resumeCollection(batch.id);
    const reopened = await CollectionPlanStore.open(path);
    const persisted = reopened.latest('nowcoder-agent-market', 1)[0]!;

    expect(resumed).toMatchObject({
      status: 'running',
      selectionStatus: 'collecting',
      rounds: 1,
    });
    expect(resumed.finishedAt).toBeUndefined();
    expect(persisted).toEqual(resumed);
    expect(collectionBatchSchema.safeParse(persisted).success).toBe(true);
  });

  it('does not resume a completed Nowcoder selection', async () => {
    const root = await temporaryDirectories.create('plan-store-finalized-');
    const store = await CollectionPlanStore.open(
      join(root, 'plans.json'),
      () => '2026-08-23T01:00:00.000Z',
    );
    const batch = await store.start('nowcoder-agent-market');
    await store.finalizeSelection(batch.id, 0, {}, {});

    await expect(store.resumeCollection(batch.id)).rejects.toThrow('已完成筛选');
  });

  it('rolls back the live finalized batch when its atomic persistence fails', async () => {
    const root = await temporaryDirectories.create('plan-store-finalize-rollback-');
    const path = join(root, 'plans.json');
    const backupPath = join(root, 'plans.persisted.json');
    const store = await CollectionPlanStore.open(path, () => '2026-08-23T01:00:00.000Z');
    const batch = await store.start('nowcoder-agent-market');
    await store.markSelectionPending(batch.id);
    const before = store.latest('nowcoder-agent-market', 1)[0]!;
    await rename(path, backupPath);
    await mkdir(path);

    try {
      await expect(store.finalizeSelection(
        batch.id,
        1,
        { bytedance: 1, tencent: 0, alibaba: 0, ant: 0 },
        {},
        undefined,
        0,
        ['000000000001'],
      )).rejects.toThrow();

      expect(store.latest('nowcoder-agent-market', 1)[0]).toEqual(before);
    } finally {
      await rmdir(path);
      await rename(backupPath, path);
    }

    await expect(CollectionPlanStore.open(path).then(reopened =>
      reopened.latest('nowcoder-agent-market', 1)[0])).resolves.toEqual(before);
  });


  it('rolls back a reconciled terminal batch when its atomic persistence fails', async () => {
    const root = await temporaryDirectories.create('plan-store-reconcile-rollback-');
    const path = join(root, 'plans.json');
    const backupPath = join(root, 'plans.persisted.json');
    const store = await CollectionPlanStore.open(path, () => '2026-08-25T00:00:00.000Z');
    const batch = await store.start('zsxq-chen-teacher');
    await store.markDiscovery(batch.id, 1);
    await store.attachJob(batch.id, 'topic-1');
    const before = store.latest('zsxq-chen-teacher', 1)[0]!;
    await rename(path, backupPath);
    await mkdir(path);

    try {
      await expect(store.reconcile(batch.id, [job('topic-1', 'saved')])).rejects.toThrow();
      expect(store.latest('zsxq-chen-teacher', 1)[0]).toEqual(before);
    } finally {
      await rmdir(path);
      await rename(backupPath, path);
    }

    await expect(CollectionPlanStore.open(path).then(reopened =>
      reopened.latest('zsxq-chen-teacher', 1)[0])).resolves.toEqual(before);
  });

  it('rolls back ordinary plan mutations when their atomic persistence fails', async () => {
    const root = await temporaryDirectories.create('plan-store-mutation-rollback-');
    const path = join(root, 'plans.json');
    const backupPath = join(root, 'plans.persisted.json');
    const store = await CollectionPlanStore.open(path, () => '2026-08-25T00:00:00.000Z');
    const batch = await store.start('zsxq-chen-teacher');
    const before = store.latest('zsxq-chen-teacher', 1)[0]!;
    await rename(path, backupPath);
    await mkdir(path);

    try {
      await expect(store.markDelivered(batch.id, '9fa6e4766912')).rejects.toThrow();
      expect(store.latest('zsxq-chen-teacher', 1)[0]).toEqual(before);
    } finally {
      await rmdir(path);
      await rename(backupPath, path);
    }
  });
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

  it('keeps a terminal Nowcoder round running until final selection is committed', async () => {
    const times = ['2026-08-23T01:00:00.000Z', '2026-08-23T01:03:00.000Z'];
    const root = await temporaryDirectories.create('plan-store-terminal-');
    const store = await CollectionPlanStore.open(join(root, 'plans.json'), () => times.shift()!);
    const batch = await store.start('nowcoder-agent-market');
    await store.markDiscovery(batch.id, 4);
    for (const id of ['saved', 'skipped', 'failed', 'attention']) await store.attachJob(batch.id, id);

    const terminalRound = await store.reconcile(batch.id, [
      job('saved', 'saved'),
      job('skipped', 'failed', 'QUALITY_REJECTED'),
      job('failed', 'failed', 'EXTRACTION_FAILED'),
      job('attention', 'needs_attention', 'AUTH_REQUIRED'),
    ]);

    expect(terminalRound).toMatchObject({
      status: 'running',
      discovered: 4,
      accepted: 4,
      saved: 1,
      skipped: 1,
      failed: 1,
      needsAttention: 1,
    });
    expect(terminalRound.finishedAt).toBeUndefined();
  });

  it('persists batches and job membership across reopen', async () => {
    const root = await temporaryDirectories.create('plan-store-reopen-');
    const path = join(root, 'plans.json');
    const first = await CollectionPlanStore.open(path, () => '2026-08-23T01:00:00.000Z');
    const batch = await first.start('zsxq-chen-teacher');
    await first.markDiscovery(batch.id, 1);
    await first.attachJob(batch.id, 'topic-1');
    await first.markDelivered(batch.id, 'a1b2c3d4e5f6');
    await first.markDelivered(batch.id, 'a1b2c3d4e5f6');

    const reopened = await CollectionPlanStore.open(path, () => '2026-08-23T01:05:00.000Z');
    const completed = await reopened.reconcile(batch.id, [job('topic-1', 'saved')]);

    expect(completed.status).toBe('completed');
    expect(completed.deliveryIds).toEqual(['a1b2c3d4e5f6']);
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

  it('keeps every running batch plus only the newest 180 terminal batches', async () => {
    const root = await temporaryDirectories.create('plan-store-retention-');
    const path = join(root, 'plans.json');
    const terminal = Array.from({ length: 185 }, (_, index) => ({
      id: `terminal-${String(index).padStart(3, '0')}`,
      planId: 'zsxq-chen-teacher',
      status: 'completed',
      startedAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + index * 1_000).toISOString(),
      finishedAt: new Date(Date.parse('2026-01-01T00:00:00.500Z') + index * 1_000).toISOString(),
      discovered: 0,
      accepted: 0,
      saved: 0,
      skipped: 0,
      failed: 0,
      needsAttention: 0,
      deliveryIds: [],
      jobIds: [],
    }));
    const running = {
      ...terminal[0],
      id: 'running-oldest',
      status: 'running',
      startedAt: '2020-01-01T00:00:00.000Z',
      finishedAt: undefined,
    };
    await writeFile(path, `${JSON.stringify({ version: 1, batches: [...terminal, running] })}\n`);

    const store = await CollectionPlanStore.open(path);

    expect(store.latest(undefined, 500)).toHaveLength(181);
    expect(store.latest(undefined, 500).some(batch => batch.id === running.id)).toBe(true);
    expect(store.latest(undefined, 500).some(batch => batch.id === 'terminal-004')).toBe(false);
    expect(store.latest(undefined, 500).some(batch => batch.id === 'terminal-005')).toBe(true);
    const persisted = JSON.parse(await readFile(path, 'utf8')) as { batches: unknown[] };
    expect(persisted.batches).toHaveLength(181);
  });
});
