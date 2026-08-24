import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  collectionBatchSchema,
  type CollectionBatch,
  type CollectionPlanId,
  type JobRecord,
} from '@data-collector/shared';

interface StoredBatch extends CollectionBatch {
  jobIds: string[];
}

interface StoredPlans {
  version: 1;
  batches: StoredBatch[];
}

const SKIPPED_ERROR_CODES = new Set(['DUPLICATE', 'QUALITY_REJECTED', 'SKIPPED']);

function parseStoredPlans(value: unknown): StoredPlans {
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { version?: unknown }).version !== 1 ||
    !Array.isArray((value as { batches?: unknown }).batches)
  ) {
    throw new Error('采集批次文件格式无效');
  }
  const batches = (value as { batches: unknown[] }).batches.map(item => {
    if (
      typeof item !== 'object' ||
      item === null ||
      !Array.isArray((item as { jobIds?: unknown }).jobIds) ||
      !(item as { jobIds: unknown[] }).jobIds.every(id => typeof id === 'string' && id.length > 0)
    ) {
      throw new Error('采集批次文件格式无效');
    }
    const { jobIds, ...batch } = item as StoredBatch;
    const parsed = collectionBatchSchema.safeParse(batch);
    if (!parsed.success) throw new Error('采集批次文件格式无效');
    const normalized = parsed.data as CollectionBatch;
    return { ...normalized, jobIds: [...new Set(jobIds)] };
  });
  return { version: 1, batches };
}

async function atomicWrite(path: string, value: StoredPlans): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const handle = await open(temporary, 'w', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function publicBatch(batch: StoredBatch): CollectionBatch {
  const { jobIds: _jobIds, ...value } = batch;
  return structuredClone(value);
}

export class CollectionPlanStore {
  private readonly batches = new Map<string, StoredBatch>();
  private mutationQueue: Promise<void> = Promise.resolve();

  private constructor(
    public readonly path: string,
    private readonly now: () => string,
  ) {}

  static async open(path: string, now: () => string = () => new Date().toISOString()): Promise<CollectionPlanStore> {
    const store = new CollectionPlanStore(path, now);
    try {
      const parsed = parseStoredPlans(JSON.parse(await readFile(path, 'utf8')) as unknown);
      for (const batch of parsed.batches) store.batches.set(batch.id, batch);
      if (store.prune()) await store.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (error instanceof SyntaxError) throw new Error('采集批次文件格式无效');
        throw error;
      }
    }
    return store;
  }

  start(planId: CollectionPlanId): Promise<CollectionBatch> {
    return this.serializeMutation(async () => {
      const startedAt = this.now();
      const id = `${planId}-${startedAt.replace(/\D/g, '')}-${randomBytes(4).toString('hex')}`;
      const batch: StoredBatch = {
        id,
        planId,
        status: 'running',
        startedAt,
        discovered: 0,
        accepted: 0,
        saved: 0,
        skipped: 0,
        failed: 0,
        needsAttention: 0,
        deliveryIds: [],
        ...(planId === 'nowcoder-agent-market'
          ? { selectionStatus: 'collecting' as const, rounds: 0 }
          : {}),
        jobIds: [],
      };
      this.batches.set(id, batch);
      await this.persist();
      return publicBatch(batch);
    });
  }

  attachJob(batchId: string, jobId: string): Promise<void> {
    return this.serializeMutation(async () => {
      const batch = this.require(batchId);
      if (!batch.jobIds.includes(jobId)) batch.jobIds.push(jobId);
      batch.accepted = batch.jobIds.length;
      await this.persist();
    });
  }

  attachRound(batchId: string, jobIds: readonly string[]): Promise<void> {
    return this.serializeMutation(async () => {
      const batch = this.require(batchId);
      if (batch.planId !== 'nowcoder-agent-market') throw new Error('仅牛客固定计划支持补齐轮次');
      const nextIds = [...new Set(jobIds)].filter(id => id.length > 0 && !batch.jobIds.includes(id));
      if (nextIds.length === 0) return;
      batch.jobIds.push(...nextIds);
      batch.accepted = batch.jobIds.length;
      batch.rounds = (batch.rounds ?? 0) + 1;
      await this.persist();
    });
  }

  attachRecoveredJobs(batchId: string, jobIds: readonly string[]): Promise<CollectionBatch> {
    return this.serializeMutation(async () => {
      const batch = this.require(batchId);
      if (batch.planId !== 'nowcoder-agent-market') throw new Error('仅牛客固定计划支持恢复任务归属');
      const recoveredIds = [...new Set(jobIds)].filter(id => id.length > 0 && !batch.jobIds.includes(id));
      if (recoveredIds.length > 0) {
        batch.jobIds.push(...recoveredIds);
        batch.accepted = batch.jobIds.length;
        batch.discovered = Math.max(batch.discovered, batch.accepted);
        batch.rounds = (batch.rounds ?? 0) + 1;
        await this.persist();
      }
      return publicBatch(batch);
    });
  }

  markDiscovery(
    batchId: string,
    discovered: number,
    coverage?: Record<string, number>,
    rejections?: Record<string, number>,
  ): Promise<void> {
    return this.serializeMutation(async () => {
      const batch = this.require(batchId);
      batch.discovered = discovered;
      if (coverage) batch.coverage = { ...coverage };
      if (rejections) batch.rejections = { ...rejections };
      await this.persist();
    });
  }

  markSelectionPending(batchId: string): Promise<void> {
    return this.serializeMutation(async () => {
      const batch = this.require(batchId);
      batch.selectionStatus = 'pending';
      await this.persist();
    });
  }

  resumeCollection(batchId: string): Promise<CollectionBatch> {
    return this.serializeMutation(async () => {
      const batch = this.require(batchId);
      if (batch.planId !== 'nowcoder-agent-market') throw new Error('仅牛客固定计划支持恢复筛选');
      if (batch.selectionStatus === 'completed') throw new Error('牛客固定计划已完成筛选');
      batch.status = 'running';
      batch.selectionStatus = 'collecting';
      delete batch.finishedAt;
      delete batch.error;
      await this.persist();
      return publicBatch(batch);
    });
  }

  resumeSelection(batchId: string): Promise<CollectionBatch> {
    return this.serializeTransactionalMutation(async () => {
      const batch = this.require(batchId);
      if (batch.planId !== 'nowcoder-agent-market') throw new Error('仅牛客固定计划支持恢复同步');
      if (batch.selectionStatus !== 'pending') throw new Error('牛客固定计划没有待重试筛选');
      batch.status = 'running';
      delete batch.finishedAt;
      delete batch.error;
      await this.persist();
      return publicBatch(batch);
    });
  }

  markDelivered(batchId: string, contentId: string): Promise<void> {
    return this.serializeMutation(async () => {
      if (!/^[a-f0-9]{12}$/.test(contentId)) throw new Error(`交付内容 ID 无效：${contentId}`);
      const batch = this.require(batchId);
      if (!batch.deliveryIds.includes(contentId)) batch.deliveryIds.push(contentId);
      await this.persist();
    });
  }

  finalizeSelection(
    batchId: string,
    accepted: number,
    coverage: Record<string, number>,
    rejections: Record<string, number>,
    syncError?: string,
    reclassifiedFailureCount = 0,
    deliveryIds?: readonly string[],
  ): Promise<CollectionBatch> {
    return this.serializeTransactionalMutation(async () => {
      const batch = this.require(batchId);
      if (!Number.isSafeInteger(reclassifiedFailureCount) || reclassifiedFailureCount < 0) {
        throw new Error('重分类失败数无效');
      }
      const uniqueDeliveryIds = deliveryIds ? [...new Set(deliveryIds)] : undefined;
      if (uniqueDeliveryIds?.some(contentId => !/^[a-f0-9]{12}$/.test(contentId))) {
        throw new Error('交付内容 ID 无效');
      }
      batch.failed = Math.max(0, batch.failed - reclassifiedFailureCount);
      batch.accepted = accepted;
      batch.saved = accepted;
      batch.skipped = Math.max(
        0,
        batch.discovered - accepted - batch.failed - batch.needsAttention,
      );
      batch.coverage = { ...coverage };
      batch.rejections = { ...rejections };
      if (uniqueDeliveryIds) batch.deliveryIds = uniqueDeliveryIds;
      batch.selectionStatus = 'completed';
      if (syncError) {
        batch.status = 'completed_with_attention';
        batch.error = syncError;
      } else {
        batch.status = batch.failed > 0 && batch.saved === 0
          ? 'failed'
          : batch.failed > 0 || batch.needsAttention > 0
            ? 'completed_with_attention'
            : 'completed';
        delete batch.error;
      }
      batch.finishedAt ??= this.now();
      await this.persist();
      return publicBatch(batch);
    });
  }

  retrySelection(batchId: string, message: string): Promise<CollectionBatch> {
    return this.serializeTransactionalMutation(async () => {
      const batch = this.require(batchId);
      if (batch.planId !== 'nowcoder-agent-market') throw new Error('仅牛客固定计划支持重试筛选');
      batch.status = 'completed_with_attention';
      batch.selectionStatus = 'pending';
      batch.deliveryIds = [];
      batch.finishedAt = this.now();
      batch.error = message;
      await this.persist();
      return publicBatch(batch);
    });
  }

  reconcile(batchId: string, jobs: readonly JobRecord[]): Promise<CollectionBatch> {
    return this.serializeMutation(async () => {
      const batch = this.require(batchId);
      if (batch.selectionStatus === 'completed') return publicBatch(batch);
      const byId = new Map(jobs.map(job => [job.id, job]));
      const children = batch.jobIds.map(id => byId.get(id)).filter((job): job is JobRecord => Boolean(job));
      batch.saved = children.filter(job => job.status === 'saved').length;
      batch.skipped = Math.max(0, batch.discovered - batch.accepted) + children.filter(
        job => job.status === 'failed' && SKIPPED_ERROR_CODES.has(job.errorCode ?? ''),
      ).length;
      batch.failed = children.filter(
        job => job.status === 'failed' && !SKIPPED_ERROR_CODES.has(job.errorCode ?? ''),
      ).length;
      batch.needsAttention = children.filter(job => job.status === 'needs_attention').length;

      const terminal = children.length === batch.jobIds.length && children.every(job =>
        job.status === 'saved' || job.status === 'failed' || job.status === 'needs_attention');
      if (terminal && batch.planId !== 'nowcoder-agent-market') {
        batch.status = batch.failed === batch.accepted && batch.accepted > 0
          ? 'failed'
          : batch.failed > 0 || batch.needsAttention > 0
            ? 'completed_with_attention'
            : 'completed';
        batch.finishedAt ??= this.now();
      } else {
        batch.status = 'running';
        delete batch.finishedAt;
      }
      await this.persist();
      return publicBatch(batch);
    });
  }

  fail(batchId: string, message: string): Promise<CollectionBatch> {
    return this.serializeMutation(async () => {
      const batch = this.require(batchId);
      batch.status = 'failed';
      batch.finishedAt = this.now();
      batch.error = message;
      await this.persist();
      return publicBatch(batch);
    });
  }

  attention(batchId: string, message: string): Promise<CollectionBatch> {
    return this.serializeMutation(async () => {
      const batch = this.require(batchId);
      batch.status = 'completed_with_attention';
      batch.finishedAt = this.now();
      batch.error = message;
      await this.persist();
      return publicBatch(batch);
    });
  }

  latest(planId?: CollectionPlanId, limit = 20): CollectionBatch[] {
    return [...this.batches.values()]
      .filter(batch => !planId || batch.planId === planId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id))
      .slice(0, Math.max(0, limit))
      .map(publicBatch);
  }

  private require(id: string): StoredBatch {
    const batch = this.batches.get(id);
    if (!batch) throw new Error(`采集批次不存在：${id}`);
    return batch;
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private serializeTransactionalMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.serializeMutation(async () => {
      const snapshot = structuredClone(this.batches);
      try {
        return await operation();
      } catch (error) {
        this.batches.clear();
        for (const [id, batch] of snapshot) this.batches.set(id, batch);
        throw error;
      }
    });
  }

  private persist(): Promise<void> {
    this.prune();
    return atomicWrite(this.path, {
      version: 1,
      batches: [...this.batches.values()].sort((left, right) => left.id.localeCompare(right.id)),
    });
  }

  private prune(): boolean {
    const terminal = [...this.batches.values()]
      .filter(batch => batch.status !== 'running')
      .sort((left, right) => (
        right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id)
      ));
    let changed = false;
    for (const batch of terminal.slice(180)) {
      this.batches.delete(batch.id);
      changed = true;
    }
    return changed;
  }
}
