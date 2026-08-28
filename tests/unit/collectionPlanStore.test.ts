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
  it('persists the ZSXQ owner mode and typed audit across preparation attempts', async () => {
    const root = await temporaryDirectories.create('plan-store-zsxq-owner-mode-');
    const path = join(root, 'plans.json');
    const store = await CollectionPlanStore.open(path, () => '2026-08-29T00:00:00.000Z');
    const batch = await store.start('zsxq-chen-teacher', { zsxqMode: 'owner-history' });
    const preparing = await store.beginPreparation(batch.id);
    await store.recordPreparationResult(batch.id, preparing.preparationAttempt!, {
      discovered: 1,
      prepared: false,
      ownerAudit: {
        mode: 'owner-history', pagesFetched: 1, observed: 1, qualifying: 1,
        exactDuplicates: 1, semanticDuplicates: 0, filtered: 0, knownComplete: 1,
        repaired: 0, saved: 0, failed: 0, exhausted: false,
        safetyCapReached: false, completedDays: 0, emptyDays: 0, failedDays: 0,
      },
    });

    expect((await CollectionPlanStore.open(path)).latest('zsxq-chen-teacher', 1)[0])
      .toMatchObject({
        zsxqMode: 'owner-history',
        ownerAudit: { mode: 'owner-history', pagesFetched: 1, exactDuplicates: 1 },
      });
  });

  it('persists a new ZSXQ attempt and rejects stale or terminal child attachments', async () => {
    const root = await temporaryDirectories.create('plan-store-zsxq-attempt-');
    const path = join(root, 'plans.json');
    const store = await CollectionPlanStore.open(path, () => '2026-08-25T00:00:00.000Z');
    const batch = await store.start('zsxq-chen-teacher');
    const first = await store.beginPreparation(batch.id);
    const current = await store.beginPreparation(batch.id);

    expect(first.preparationAttempt).toMatch(/^[a-f0-9]{16}$/);
    expect(current.preparationAttempt).toMatch(/^[a-f0-9]{16}$/);
    expect(current.preparationAttempt).not.toBe(first.preparationAttempt);
    await expect(store.attachJob(batch.id, 'stale-topic', first.preparationAttempt))
      .rejects.toThrow('采集尝试已过期');

    await store.attachJob(batch.id, 'current-topic', current.preparationAttempt);
    expect((await CollectionPlanStore.open(path)).latest('zsxq-chen-teacher', 1)[0]).toMatchObject({
      discovered: 1,
      accepted: 1,
    });
    await store.recordPreparationResult(batch.id, current.preparationAttempt!, {
      discovered: 0,
      prepared: false,
    });
    expect(store.latest('zsxq-chen-teacher', 1)[0]).toMatchObject({
      discovered: 1,
      accepted: 1,
    });
    await store.recordPreparationResult(batch.id, current.preparationAttempt!, {
      discovered: 1,
      prepared: true,
    });
    await store.markDelivered(batch.id, '9fa6e4766912');
    const completed = await store.reconcile(batch.id, [{
      ...job('current-topic', 'saved'),
      url: 'https://wx.zsxq.com/group/48844584441158/topic/844444444444441',
    }]);
    expect(completed.status).toBe('completed');

    await expect(store.attachJob(batch.id, 'late-topic', current.preparationAttempt))
      .rejects.toThrow('采集批次已结束');
    expect((await CollectionPlanStore.open(path)).latest('zsxq-chen-teacher', 1)[0]).toMatchObject({
      status: 'completed',
      accepted: 1,
      saved: 1,
    });
  });

  it('persists ZSXQ preparation and never regresses a completed staging phase', async () => {
    const root = await temporaryDirectories.create('plan-store-zsxq-preparation-');
    const path = join(root, 'plans.json');
    const store = await CollectionPlanStore.open(path, () => '2026-08-25T00:00:00.000Z');
    const batch = await store.start('zsxq-chen-teacher');

    expect(batch).toMatchObject({ preparationStatus: 'collecting' });

    await store.markPreparation(batch.id, false);
    const collecting = await CollectionPlanStore.open(path);
    expect(collecting.latest('zsxq-chen-teacher', 1)[0]).toMatchObject({
      preparationStatus: 'collecting',
    });

    await collecting.markPreparation(batch.id, true);
    await collecting.markPreparation(batch.id, false);
    const completed = await CollectionPlanStore.open(path);
    expect(completed.latest('zsxq-chen-teacher', 1)[0]).toMatchObject({
      preparationStatus: 'completed',
    });
  });

  it('does not finalize a partial ZSXQ child set before staging is prepared', async () => {
    const root = await temporaryDirectories.create('plan-store-zsxq-partial-');
    const store = await CollectionPlanStore.open(
      join(root, 'plans.json'),
      () => '2026-08-25T00:00:00.000Z',
    );
    const batch = await store.start('zsxq-chen-teacher');
    const preparing = await store.beginPreparation(batch.id);
    await store.markDiscovery(batch.id, 2);
    await store.attachJob(batch.id, 'topic-1', preparing.preparationAttempt);

    const partial = await store.reconcile(batch.id, [job('topic-1', 'saved')]);

    expect(partial).toMatchObject({
      status: 'running',
      preparationStatus: 'collecting',
      accepted: 1,
      saved: 1,
    });
    expect(partial.finishedAt).toBeUndefined();

    await store.recordPreparationResult(batch.id, preparing.preparationAttempt!, {
      discovered: 2,
      prepared: true,
    });
    await store.markDelivered(batch.id, '9fa6e4766912');
    const completed = await store.reconcile(batch.id, [{
      ...job('topic-1', 'saved'),
      url: 'https://wx.zsxq.com/group/48844584441158/topic/844444444444441',
    }]);
    expect(completed).toMatchObject({
      status: 'completed',
      preparationStatus: 'completed',
      skipped: 1,
    });
  });

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
    const preparing = await store.beginPreparation(batch.id);
    await store.attachJob(batch.id, 'topic-1', preparing.preparationAttempt);
    await store.recordPreparationResult(batch.id, preparing.preparationAttempt!, {
      discovered: 1,
      prepared: true,
    });
    await store.markDelivered(batch.id, '9fa6e4766912');
    const before = store.latest('zsxq-chen-teacher', 1)[0]!;
    await rename(path, backupPath);
    await mkdir(path);

    try {
      await expect(store.reconcile(batch.id, [{
        ...job('topic-1', 'saved'),
        url: 'https://wx.zsxq.com/group/48844584441158/topic/844444444444441',
      }])).rejects.toThrow();

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
    const preparing = await first.beginPreparation(batch.id);
    await first.markDiscovery(batch.id, 1);
    await first.attachJob(batch.id, 'topic-1', preparing.preparationAttempt);
    await first.recordPreparationResult(batch.id, preparing.preparationAttempt!, {
      discovered: 1,
      prepared: true,
    });
    await first.markDelivered(batch.id, '9fa6e4766912');
    await first.markDelivered(batch.id, '9fa6e4766912');

    const reopened = await CollectionPlanStore.open(path, () => '2026-08-23T01:05:00.000Z');
    const completed = await reopened.reconcile(batch.id, [{
      ...job('topic-1', 'saved'),
      url: 'https://wx.zsxq.com/group/48844584441158/topic/844444444444441',
    }]);

    expect(completed.status).toBe('completed');
    expect(completed.deliveryIds).toEqual(['9fa6e4766912']);
    expect(reopened.latest('zsxq-chen-teacher', 1)[0]).toEqual(completed);
  });

  it('refuses to complete a ZSXQ batch while a saved child lacks its durable delivery ID', async () => {
    const root = await temporaryDirectories.create('plan-store-zsxq-delivery-gate-');
    const store = await CollectionPlanStore.open(
      join(root, 'plans.json'),
      () => '2026-08-25T00:00:00.000Z',
    );
    const batch = await store.start('zsxq-chen-teacher');
    const preparing = await store.beginPreparation(batch.id);
    await store.attachJob(batch.id, 'saved-without-delivery', preparing.preparationAttempt);
    await store.recordPreparationResult(batch.id, preparing.preparationAttempt!, {
      discovered: 1,
      prepared: true,
    });

    const terminal = await store.reconcile(batch.id, [{
      ...job('saved-without-delivery', 'saved'),
      url: 'https://wx.zsxq.com/group/48844584441158/topic/844444444444441',
      batchId: batch.id,
      planId: 'zsxq-chen-teacher',
      planAttempt: preparing.preparationAttempt,
    }]);

    expect(terminal).toMatchObject({
      status: 'completed_with_attention',
      saved: 1,
      deliveryIds: [],
      error: expect.stringContaining('未确认交付'),
    });
  });

  it('persists per-item plan rejection details across reopen', async () => {
    const root = await temporaryDirectories.create('plan-store-rejections-');
    const path = join(root, 'plans.json');
    const store = await CollectionPlanStore.open(path, () => '2026-08-25T00:00:00.000Z');
    const batch = await store.start('zsxq-chen-teacher');
    const rejectionDetails = [{
      url: 'https://wx.zsxq.com/group/48844584441158/topic/844444444444444',
      reason: '正文不完整',
    }];

    await store.markDiscovery(
      batch.id,
      1,
      undefined,
      { '正文不完整': 1 },
      rejectionDetails,
    );
    rejectionDetails[0]!.reason = '外部数组已修改';

    const reopened = await CollectionPlanStore.open(path);
    const persisted = reopened.latest('zsxq-chen-teacher', 1)[0]!;
    expect(persisted.rejectionDetails).toEqual([{
      url: 'https://wx.zsxq.com/group/48844584441158/topic/844444444444444',
      reason: '正文不完整',
    }]);
    expect(collectionBatchSchema.safeParse(persisted).success).toBe(true);
  });

  it('records a runtime rejection exactly once across retries', async () => {
    const root = await temporaryDirectories.create('plan-store-runtime-rejection-');
    const path = join(root, 'plans.json');
    const store = await CollectionPlanStore.open(path, () => '2026-08-25T00:00:00.000Z');
    const batch = await store.start('zsxq-chen-teacher');
    const rejection = {
      url: 'https://wx.zsxq.com/group/48844584441158/topic/855555555555555',
      reason: '正文不完整',
    };

    await store.recordRejection(batch.id, rejection);
    await store.recordRejection(batch.id, rejection);

    const reopened = await CollectionPlanStore.open(path);
    expect(reopened.latest('zsxq-chen-teacher', 1)[0]).toMatchObject({
      rejections: { '正文不完整': 1 },
      rejectionDetails: [rejection],
    });
  });

  it('does not overwrite a corrupt state file', async () => {
    const root = await temporaryDirectories.create('plan-store-corrupt-');
    const path = join(root, 'plans.json');
    const corrupt = '{"version":1,"batches":"broken"}\n';
    await writeFile(path, corrupt, 'utf8');

    await expect(CollectionPlanStore.open(path)).rejects.toThrow('采集批次文件格式无效');
    expect(await readFile(path, 'utf8')).toBe(corrupt);
  });

  it('finds active attempts without applying the display history limit', async () => {
    const root = await temporaryDirectories.create('plan-store-active-');
    const path = join(root, 'plans.json');
    const terminal = Array.from({ length: 100 }, (_, index) => ({
      id: `newer-terminal-${String(index).padStart(3, '0')}`,
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
    const active = {
      ...terminal[0],
      id: 'old-active-attempt',
      status: 'running',
      startedAt: '2020-01-01T00:00:00.000Z',
      finishedAt: undefined,
      preparationStatus: 'collecting',
      preparationAttempt: '0123456789abcdef',
    };
    await writeFile(path, `${JSON.stringify({ version: 1, batches: [active, ...terminal] })}\n`);

    const store = await CollectionPlanStore.open(path);

    expect(store.latest('zsxq-chen-teacher', 100).some(batch => batch.id === active.id)).toBe(false);
    expect(store.active('zsxq-chen-teacher')).toEqual([
      expect.objectContaining({ id: active.id, status: 'running' }),
    ]);
    expect(store.get(active.id)).toMatchObject({ id: active.id, status: 'running' });
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
