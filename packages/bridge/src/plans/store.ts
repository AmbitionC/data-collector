import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
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
  const handle = await open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
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
        ...(planId === 'nowcoder-agent-market' ? { selectionStatus: 'collecting' as const } : {}),
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

  finalizeSelection(
    batchId: string,
    accepted: number,
    coverage: Record<string, number>,
    rejections: Record<string, number>,
    syncError?: string,
  ): Promise<CollectionBatch> {
    return this.serializeMutation(async () => {
      const batch = this.require(batchId);
      batch.accepted = accepted;
      batch.saved = accepted;
      batch.skipped = Math.max(
        0,
        batch.discovered - accepted - batch.failed - batch.needsAttention,
      );
      batch.coverage = { ...coverage };
      batch.rejections = { ...rejections };
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
      if (terminal) {
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

  private persist(): Promise<void> {
    return atomicWrite(this.path, {
      version: 1,
      batches: [...this.batches.values()].sort((left, right) => left.id.localeCompare(right.id)),
    });
  }
}
