import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  collectionBatchSchema,
  stableContentId,
  type CollectionBatch,
  type CollectionPlanAttempt,
  type CollectionPlanRejection,
  type CollectionPlanId,
  type CollectionPlanTrigger,
  type JobRecord,
  type ZsxqCollectionMode,
  type ZsxqOwnerAudit,
} from '@data-collector/shared';

interface StoredBatch extends CollectionBatch {
  jobIds: string[];
}

interface StoredPlans {
  version: 1;
  batches: StoredBatch[];
}

interface ParsedStoredPlans {
  value: StoredPlans;
  migrated: boolean;
}

const SKIPPED_ERROR_CODES = new Set(['DUPLICATE', 'QUALITY_REJECTED', 'SKIPPED']);

function repairLegacyNowcoderSelectionCounters(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const batch = value as Record<string, unknown>;
  if (
    batch.planId !== 'nowcoder-agent-market'
    || batch.selectionStatus !== 'completed'
    || batch.status === 'running'
  ) return value;
  const counts = [batch.discovered, batch.accepted, batch.saved, batch.skipped,
    batch.failed, batch.needsAttention];
  if (!counts.every(count => Number.isSafeInteger(count) && (count as number) >= 0)) return value;
  const discovered = batch.discovered as number;
  const accepted = batch.accepted as number;
  const saved = batch.saved as number;
  const skipped = batch.skipped as number;
  const failed = batch.failed as number;
  const needsAttention = batch.needsAttention as number;
  if (saved + skipped + failed + needsAttention <= discovered) return value;
  // 0.4.35 briefly recounted every already-finalized Nowcoder batch from detail children on
  // reconnect. That overwrote selection-level `saved` while retaining selection-level `skipped`,
  // making the two overlap and the whole plans file unloadable on the next process start. Older
  // pending-pool selections can also contain accepted historical candidates beyond this batch's
  // detail count, so restore the same lower bound used by finalizeSelection.
  const repairedDiscovered = Math.max(discovered, accepted + failed + needsAttention);
  return {
    ...batch,
    discovered: repairedDiscovered,
    saved: accepted,
    skipped: repairedDiscovered - accepted - failed - needsAttention,
  };
}

function assertPersistablePlans(value: StoredPlans): void {
  for (const item of value.batches) {
    const { jobIds, ...batch } = item;
    if (
      !Array.isArray(jobIds)
      || !jobIds.every(id => typeof id === 'string' && id.length > 0)
      || !collectionBatchSchema.safeParse(batch).success
    ) throw new Error('采集批次文件格式无效');
  }
}

function parseStoredPlans(value: unknown): ParsedStoredPlans {
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { version?: unknown }).version !== 1 ||
    !Array.isArray((value as { batches?: unknown }).batches)
  ) {
    throw new Error('采集批次文件格式无效');
  }
  let migrated = false;
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
    let parsed = collectionBatchSchema.safeParse(batch);
    if (!parsed.success) {
      const repaired = repairLegacyNowcoderSelectionCounters(batch);
      if (repaired !== batch) {
        parsed = collectionBatchSchema.safeParse(repaired);
        if (parsed.success) migrated = true;
      }
    }
    if (!parsed.success) throw new Error('采集批次文件格式无效');
    const normalized = parsed.data as CollectionBatch;
    return { ...normalized, jobIds: [...new Set(jobIds)] };
  });
  return { value: { version: 1, batches }, migrated };
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
      for (const batch of parsed.value.batches) store.batches.set(batch.id, batch);
      if (store.prune() || parsed.migrated) await store.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (error instanceof SyntaxError) throw new Error('采集批次文件格式无效');
        throw error;
      }
    }
    return store;
  }

  start(
    planId: CollectionPlanId,
    options: {
      force?: boolean;
      trigger?: CollectionPlanTrigger;
      zsxqMode?: ZsxqCollectionMode;
    } = {},
  ): Promise<CollectionBatch> {
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
        trigger: options.trigger ?? 'manual',
        ...(options.force === true ? { force: true } : {}),
        ...(planId === 'zsxq-chen-teacher' && options.zsxqMode
          ? { zsxqMode: options.zsxqMode }
          : {}),
        ...(planId === 'nowcoder-agent-market'
          ? { selectionStatus: 'collecting' as const, rounds: 0 }
          : { preparationStatus: 'collecting' as const }),
        jobIds: [],
      };
      this.batches.set(id, batch);
      await this.persist();
      return publicBatch(batch);
    });
  }

  /** 换新并持久化知识星球 staging 尝试；旧轮后续消息从此全部失效。 */
  beginPreparation(batchId: string): Promise<CollectionBatch> {
    return this.serializeTransactionalMutation(async () => {
      const batch = this.require(batchId);
      if (batch.planId !== 'zsxq-chen-teacher') throw new Error('仅知识星球固定计划支持准备尝试');
      if (batch.status !== 'running') throw new Error('采集批次已结束，无法开始新尝试');
      batch.preparationAttempt = randomBytes(8).toString('hex');
      batch.preparationStatus = 'collecting';
      // 每个 attempt 只结算自己的子任务。旧轮 JobRecord 保留供审计，
      // 但不再能把当前轮提前结算或污染统计。
      batch.jobIds = [];
      batch.discovered = 0;
      batch.accepted = 0;
      batch.saved = 0;
      batch.skipped = 0;
      batch.failed = 0;
      batch.needsAttention = 0;
      delete batch.coverage;
      delete batch.rejections;
      delete batch.rejectionDetails;
      delete batch.ownerAudit;
      await this.persist();
      return publicBatch(batch);
    });
  }

  assertPreparationAttempt(batchId: string, attempt: CollectionPlanAttempt): Promise<void> {
    return this.serializeMutation(async () => {
      this.requireCurrentPreparationAttempt(this.require(batchId), attempt);
    });
  }

  attachJob(batchId: string, jobId: string, attempt?: CollectionPlanAttempt): Promise<void> {
    return this.serializeTransactionalMutation(async () => {
      const batch = this.require(batchId);
      if (batch.planId === 'zsxq-chen-teacher') {
        this.requireCurrentPreparationAttempt(batch, attempt);
      }
      if (!batch.jobIds.includes(jobId)) batch.jobIds.push(jobId);
      batch.accepted = batch.jobIds.length;
      batch.discovered = Math.max(batch.discovered, batch.accepted);
      await this.persist();
    });
  }

  attachRound(batchId: string, jobIds: readonly string[]): Promise<boolean> {
    return this.serializeMutation(async () => {
      const batch = this.require(batchId);
      if (batch.planId !== 'nowcoder-agent-market') throw new Error('仅牛客固定计划支持补齐轮次');
      if (batch.status !== 'running' || batch.selectionStatus === 'completed') return false;
      const nextIds = [...new Set(jobIds)].filter(id => id.length > 0 && !batch.jobIds.includes(id));
      if (nextIds.length === 0) return true;
      batch.jobIds.push(...nextIds);
      batch.accepted = batch.jobIds.length;
      batch.discovered = Math.max(batch.discovered, batch.accepted);
      batch.rounds = (batch.rounds ?? 0) + 1;
      await this.persist();
      return true;
    });
  }

  attachRecoveredJobs(batchId: string, jobIds: readonly string[]): Promise<CollectionBatch> {
    return this.serializeMutation(async () => {
      const batch = this.require(batchId);
      if (batch.planId !== 'nowcoder-agent-market') throw new Error('仅牛客固定计划支持恢复任务归属');
      if (batch.status !== 'running' || batch.selectionStatus === 'completed') return publicBatch(batch);
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
    rejectionDetails?: readonly CollectionPlanRejection[],
  ): Promise<boolean> {
    return this.serializeMutation(async () => {
      const batch = this.require(batchId);
      if (batch.planId === 'nowcoder-agent-market' && (
        batch.status !== 'running' || batch.selectionStatus === 'completed'
      )) return false;
      batch.discovered = Math.max(discovered, batch.accepted);
      if (coverage) batch.coverage = { ...coverage };
      if (rejections) batch.rejections = { ...rejections };
      if (rejectionDetails) {
        batch.rejectionDetails = rejectionDetails.map(detail => ({ ...detail }));
      }
      await this.persist();
      return true;
    });
  }

  /**
   * 持久化知识星球两阶段 staging。completed 是单调状态：迟到或重放的
   * prepared:false 不得把已完整创建的任务集合重新降级为半成品。
   */
  markPreparation(batchId: string, prepared: boolean): Promise<CollectionBatch> {
    return this.serializeMutation(async () => {
      const batch = this.require(batchId);
      if (batch.planId !== 'zsxq-chen-teacher') throw new Error('仅知识星球固定计划支持准备阶段');
      if (prepared || batch.preparationStatus !== 'completed') {
        batch.preparationStatus = prepared ? 'completed' : 'collecting';
        await this.persist();
      }
      return publicBatch(batch);
    });
  }

  /** 只把当前 attempt 的发现结果与准备态作为一次原子事实落盘。 */
  recordPreparationResult(
    batchId: string,
    attempt: CollectionPlanAttempt,
    result: {
      discovered: number;
      prepared: boolean;
      coverage?: Record<string, number>;
      rejections?: Record<string, number>;
      rejectionDetails?: readonly CollectionPlanRejection[];
      ownerAudit?: ZsxqOwnerAudit;
    },
  ): Promise<CollectionBatch> {
    return this.serializeTransactionalMutation(async () => {
      const batch = this.require(batchId);
      if (
        batch.planId !== 'zsxq-chen-teacher'
        || batch.status !== 'running'
        || batch.preparationAttempt !== attempt
      ) return publicBatch(batch);
      // 同一 attempt 内的迟到 prepared:false 也不得回退或覆盖已完成统计。
      if (batch.preparationStatus === 'completed' && !result.prepared) return publicBatch(batch);
      batch.discovered = Math.max(result.discovered, batch.accepted);
      if (result.coverage) batch.coverage = { ...result.coverage };
      if (result.rejections) batch.rejections = { ...result.rejections };
      if (result.rejectionDetails) {
        batch.rejectionDetails = result.rejectionDetails.map(detail => ({ ...detail }));
      }
      if (result.ownerAudit) batch.ownerAudit = { ...result.ownerAudit };
      batch.preparationStatus = result.prepared ? 'completed' : 'collecting';
      await this.persist();
      return publicBatch(batch);
    });
  }

  /** 旧 attempt 的迟到错误不得终止已换新的批次。 */
  finishPreparationWithError(
    batchId: string,
    attempt: CollectionPlanAttempt,
    message: string,
    needsAttention: boolean,
  ): Promise<CollectionBatch> {
    return this.serializeTransactionalMutation(async () => {
      const batch = this.require(batchId);
      if (
        batch.planId !== 'zsxq-chen-teacher'
        || batch.status !== 'running'
        || batch.preparationAttempt !== attempt
      ) return publicBatch(batch);
      batch.status = needsAttention ? 'completed_with_attention' : 'failed';
      batch.finishedAt = this.now();
      batch.error = message;
      await this.persist();
      return publicBatch(batch);
    });
  }

  /** 追加运行期防线产生的逐条拒绝；同一 URL/原因重复上报时保持幂等。 */
  recordRejection(batchId: string, rejection: CollectionPlanRejection): Promise<void> {
    return this.serializeMutation(async () => {
      const batch = this.require(batchId);
      const details = batch.rejectionDetails ?? [];
      if (details.some(detail => detail.url === rejection.url && detail.reason === rejection.reason)) return;
      batch.rejectionDetails = details.concat({ ...rejection });
      batch.rejections = {
        ...(batch.rejections ?? {}),
        [rejection.reason]: (batch.rejections?.[rejection.reason] ?? 0) + 1,
      };
      await this.persist();
    });
  }

  markSelectionPending(batchId: string): Promise<boolean> {
    return this.serializeMutation(async () => {
      const batch = this.require(batchId);
      if (batch.planId === 'nowcoder-agent-market' && (
        batch.status !== 'running' || batch.selectionStatus === 'completed'
      )) return false;
      batch.selectionStatus = 'pending';
      await this.persist();
      return true;
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

  recordOwnerAudit(batchId: string, audit: ZsxqOwnerAudit): Promise<CollectionBatch> {
    return this.serializeMutation(async () => {
      const batch = this.require(batchId);
      if (batch.planId !== 'zsxq-chen-teacher') {
        throw new Error('只有知识星球批次支持只看星主审计');
      }
      batch.ownerAudit = { ...audit };
      await this.persist();
      return publicBatch(batch);
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
      // A user-close/recovery-limit stop is irrevocable.  A delayed sync/finalize
      // continuation must observe the durable terminal parent instead of rewriting it.
      if (
        batch.planId === 'nowcoder-agent-market'
        && batch.status !== 'running'
        && batch.selectionStatus === 'completed'
      ) return publicBatch(batch);
      if (!Number.isSafeInteger(reclassifiedFailureCount) || reclassifiedFailureCount < 0) {
        throw new Error('重分类失败数无效');
      }
      const uniqueDeliveryIds = deliveryIds ? [...new Set(deliveryIds)] : undefined;
      if (uniqueDeliveryIds?.some(contentId => !/^[a-f0-9]{12}$/.test(contentId))) {
        throw new Error('交付内容 ID 无效');
      }
      batch.failed = Math.max(0, batch.failed - reclassifiedFailureCount);
      batch.discovered = Math.max(
        batch.discovered,
        accepted + batch.failed + batch.needsAttention,
      );
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
      if (batch.status !== 'running' && batch.selectionStatus === 'completed') return publicBatch(batch);
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
      if (batch.status !== 'running') return publicBatch(batch);
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
      const preparationComplete = batch.planId !== 'zsxq-chen-teacher'
        || batch.preparationStatus === 'completed';
      if (terminal && preparationComplete && batch.planId !== 'nowcoder-agent-market') {
        const incompleteRejections = batch.rejections?.['正文不完整'] ?? 0;
        const undeliveredSaved = batch.planId === 'zsxq-chen-teacher'
          ? children.filter(job =>
              job.status === 'saved'
              && !batch.deliveryIds.includes(stableContentId(job.url)))
          : [];
        batch.status = batch.failed === batch.accepted && batch.accepted > 0
          ? 'failed'
          : batch.failed > 0
              || batch.needsAttention > 0
              || incompleteRejections > 0
              || undeliveredSaved.length > 0
            ? 'completed_with_attention'
            : 'completed';
        if (undeliveredSaved.length > 0 && batch.status === 'completed_with_attention') {
          batch.error = `${undeliveredSaved.length} 条已保存知识星球内容尚未确认交付`;
        } else if (incompleteRejections > 0 && batch.status === 'completed_with_attention') {
          batch.error = `${incompleteRejections} 条知识星球内容正文不完整，未归档交付`;
        }
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

  /** A hard fixed-plan stop must not be reopened by reconnect selection recovery. */
  stopNowcoder(batchId: string, message: string): Promise<CollectionBatch> {
    return this.serializeMutation(async () => {
      const batch = this.require(batchId);
      if (batch.planId !== 'nowcoder-agent-market') {
        throw new Error('仅牛客固定计划支持停止运行');
      }
      batch.status = 'completed_with_attention';
      batch.selectionStatus = 'completed';
      batch.finishedAt = this.now();
      batch.error = message;
      await this.persist();
      return publicBatch(batch);
    });
  }

  /** Recount the child partition only inside the active fixed-batch hard-stop lock. */
  reconcileStoppedNowcoder(batchId: string, jobs: readonly JobRecord[]): Promise<CollectionBatch> {
    return this.serializeMutation(async () => {
      const batch = this.require(batchId);
      if (batch.planId !== 'nowcoder-agent-market' || batch.status === 'running') return publicBatch(batch);
      const byId = new Map(jobs.map(job => [job.id, job]));
      const children = batch.jobIds
        .map(id => byId.get(id))
        .filter((job): job is JobRecord => Boolean(job));
      batch.saved = children.filter(job => job.status === 'saved').length;
      batch.failed = children.filter(
        job => job.status === 'failed' && !SKIPPED_ERROR_CODES.has(job.errorCode ?? ''),
      ).length;
      batch.needsAttention = children.filter(job => job.status === 'needs_attention').length;
      batch.skipped = Math.max(0, batch.discovered - batch.accepted) + children.filter(
        job => job.status === 'failed' && SKIPPED_ERROR_CODES.has(job.errorCode ?? ''),
      ).length;
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

  active(planId?: CollectionPlanId): CollectionBatch[] {
    return [...this.batches.values()]
      .filter(batch => batch.status === 'running' && (!planId || batch.planId === planId))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id))
      .map(publicBatch);
  }

  get(id: string): CollectionBatch | undefined {
    const batch = this.batches.get(id);
    return batch ? publicBatch(batch) : undefined;
  }

  private require(id: string): StoredBatch {
    const batch = this.batches.get(id);
    if (!batch) throw new Error(`采集批次不存在：${id}`);
    return batch;
  }

  private requireCurrentPreparationAttempt(
    batch: StoredBatch,
    attempt: CollectionPlanAttempt | undefined,
  ): void {
    if (batch.status !== 'running') throw new Error('采集批次已结束，拒绝追加任务');
    if (!attempt || batch.preparationAttempt !== attempt) {
      throw new Error('知识星球采集尝试已过期');
    }
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const transactionalOperation = async (): Promise<T> => {
      const snapshot = structuredClone(this.batches);
      try {
        return await operation();
      } catch (error) {
        this.batches.clear();
        for (const [id, batch] of snapshot) this.batches.set(id, batch);
        throw error;
      }
    };
    const result = this.mutationQueue.then(transactionalOperation, transactionalOperation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private serializeTransactionalMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.serializeMutation(operation);
  }

  private persist(): Promise<void> {
    this.prune();
    const value: StoredPlans = {
      version: 1,
      batches: [...this.batches.values()].sort((left, right) => left.id.localeCompare(right.id)),
    };
    assertPersistablePlans(value);
    return atomicWrite(this.path, value);
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
