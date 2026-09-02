import {
  COLLECTION_PLAN_IDS,
  stableContentId,
  type CollectionBatch,
  type CollectionPlanAttempt,
  type CollectionPlanRejection,
  type CollectionPlanId,
  type CollectionPlanTrigger,
  type JobRecord,
  type ZsxqCollectionMode,
  type ZsxqDayDraft,
  type ZsxqOwnerAudit,
  type ZsxqOwnerCheckpoint,
} from '@data-collector/shared';
import type { JobStore } from '../jobs/store.js';
import type { NowcoderDiscoveryCandidate } from '../feJourney/nowcoderDiscovery.js';
import { FE_JOURNEY_PRESET } from '../feJourney/preset.js';
import { knownNowcoderPlanUrls } from './nowcoderHistory.js';
import {
  NOWCODER_COMPANIES,
  PRIMARY_NOWCODER_COMPANIES,
  type CompanyId,
} from './nowcoderPlan.js';
import type { CollectionPlanStore } from './store.js';
import type { ZsxqDayLedgerStore } from './zsxqLedger.js';

const PLAN_HOURS: Record<CollectionPlanId, number> = {
  'zsxq-chen-teacher': 8,
  'nowcoder-agent-market': 9,
};

const NOWCODER_CONTENT_REJECTION_CODES = new Map([
  ['UNSUPPORTED_LAYOUT', '页面结构不含可采集正文'],
]);
const MAX_PLAN_ERROR_LENGTH = 2_000;
const BENCHMARK_FAILURE_MESSAGE = '基准报告写入失败';

function benchmarkFailureError(prior?: string): string {
  if (!prior) return BENCHMARK_FAILURE_MESSAGE;
  const suffix = `；${BENCHMARK_FAILURE_MESSAGE}`;
  return `${prior.slice(0, MAX_PLAN_ERROR_LENGTH - suffix.length)}${suffix}`;
}

export interface PlanDueState {
  due: boolean;
  targetAt: string;
  nextRunAt: string;
}

function shanghaiDay(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
}

function targetAt(planId: CollectionPlanId, day: string): string {
  const utcHour = PLAN_HOURS[planId] - 8;
  return `${day}T${String(utcHour).padStart(2, '0')}:00:00.000Z`;
}

function nextShanghaiDay(day: string): string {
  const next = new Date(`${day}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

export function planDueState(
  planId: CollectionPlanId,
  now: string,
  lastStartedAt?: string,
): PlanDueState {
  const day = shanghaiDay(now);
  const todayTarget = targetAt(planId, day);
  const alreadyRanToday = lastStartedAt ? shanghaiDay(lastStartedAt) === day : false;
  const due = !alreadyRanToday && Date.parse(now) >= Date.parse(todayTarget);
  const nextRunAt = due
    ? todayTarget
    : Date.parse(now) < Date.parse(todayTarget) && !alreadyRanToday
      ? todayTarget
      : targetAt(planId, nextShanghaiDay(day));
  return { due, targetAt: todayTarget, nextRunAt };
}

export interface CollectionPlanServiceDependencies {
  store: CollectionPlanStore;
  jobs: JobStore;
  now?: () => string;
  extensionConnected: () => boolean;
  /** 当前扩展是否具备知识星球完整正文采集与审计能力。 */
  canCollectZsxq?: () => boolean;
  /** sink 正在保存当前轮结果时不得换代 attempt。 */
  canStartZsxqAttempt?: () => boolean;
  discoverNowcoder: (knownUrls: ReadonlySet<string>) => Promise<NowcoderDiscoveryCandidate[]>;
  dispatch: (job: JobRecord) => Promise<void>;
  collectZsxq: (
    batchId: string,
    planId: 'zsxq-chen-teacher',
    attempt: CollectionPlanAttempt,
    force: boolean,
    mode: ZsxqCollectionMode,
    targetDays: readonly string[],
    resumeCursor?: string,
  ) => Promise<true>;
  zsxqLedger?: ZsxqDayLedgerStore;
  /** 当前知识星球 attempt 已可靠写入终态，可释放外部互斥门禁。 */
  onZsxqAttemptTerminal?: (batch: CollectionBatch) => void;
  shouldAutoSync: (job: JobRecord) => Promise<boolean>;
  pendingNowcoderJobs?: (deliveryBatchId: string) => Promise<readonly JobRecord[]>;
  selectNowcoderJobs: (
    jobs: readonly JobRecord[],
    now: string,
  ) => Promise<{
    accepted: JobRecord[];
    coverage: Record<string, number>;
    rejected: Array<{ url: string; reason: string }>;
  }>;
  coverageKey?: (job: JobRecord) => Promise<string | undefined>;
  syncJob: (job: JobRecord, deliveryBatchId?: string) => Promise<void>;
  syncNowcoderJobs?: (jobs: readonly JobRecord[], deliveryBatchId: string) => Promise<void>;
  writeBenchmark?: (batch: CollectionBatch, jobs: readonly JobRecord[]) => Promise<void>;
}

export interface ExtensionPlanResult {
  batchId: string;
  attempt: CollectionPlanAttempt;
  discovered: number;
  coverage?: Record<string, number>;
  rejections?: Record<string, number>;
  rejectionDetails?: CollectionPlanRejection[];
  error?: string;
  needsAttention?: boolean;
  prepared?: boolean;
  checkpoint?: ZsxqOwnerCheckpoint;
  dayDrafts?: ZsxqDayDraft[];
  ownerAudit?: ZsxqOwnerAudit;
}

function rotatedCompanies(now: string): CompanyId[] {
  const day = Math.floor(Date.parse(`${shanghaiDay(now)}T00:00:00.000Z`) / 86_400_000);
  const offset = ((day % PRIMARY_NOWCODER_COMPANIES.length) + PRIMARY_NOWCODER_COMPANIES.length)
    % PRIMARY_NOWCODER_COMPANIES.length;
  return [
    ...PRIMARY_NOWCODER_COMPANIES.map((_, index) =>
      PRIMARY_NOWCODER_COMPANIES[(index + offset) % PRIMARY_NOWCODER_COMPANIES.length]!),
    'other',
  ];
}

function selectDiscoveryRound(
  candidates: readonly NowcoderDiscoveryCandidate[],
  now: string,
  limit: number,
): NowcoderDiscoveryCandidate[] {
  const buckets = new Map<CompanyId, NowcoderDiscoveryCandidate[]>(
    NOWCODER_COMPANIES.map(company => [company, candidates.filter(item => item.queryCompany === company)]),
  );
  const selected: NowcoderDiscoveryCandidate[] = [];
  let advanced = true;
  while (selected.length < limit && advanced) {
    advanced = false;
    for (const company of rotatedCompanies(now)) {
      const candidate = buckets.get(company)?.shift();
      if (!candidate) continue;
      selected.push(candidate);
      advanced = true;
      if (selected.length >= limit) break;
    }
  }
  return selected;
}

export class CollectionPlanService {
  private readonly now: () => string;
  private readonly executing = new Set<string>();
  /**
   * `collectZsxq` 只负责把长任务派给扩展，返回后 staging 仍在进行。
   * 同一 Bridge 进程里的 WebSocket 重连不得把这个活跃 attempt 当成进程恢复并换代；
   * Bridge 真正重启后此表为空，持久化中的未完成 attempt 仍会按原逻辑恢复重派。
   */
  private readonly liveZsxqAttempts = new Map<string, {
    attempt: CollectionPlanAttempt;
    runtimeId?: string;
  }>();
  private extensionRuntimeId: string | undefined;
  private readonly syncedJobs = new Set<string>();
  private readonly coveredJobs = new Set<string>();
  private readonly advancingBatches = new Set<string>();
  private readonly batchSyncErrors = new Map<string, string[]>();

  constructor(private readonly dependencies: CollectionPlanServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  private lastScheduledStartedAt(planId: CollectionPlanId): string | undefined {
    return this.dependencies.store.latest(planId, 180).find(batch => (
      batch.trigger === 'scheduled'
      // 旧批次没有 trigger；历史 force 批次明确是手动补采，其余按旧日任务兼容。
      || (batch.trigger === undefined && batch.force !== true)
    ))?.startedAt;
  }

  status(): { plans: Array<{
    id: CollectionPlanId;
    due: boolean;
    pending: boolean;
    nextRunAt: string;
    latest?: CollectionBatch;
  }> } {
    return {
      plans: COLLECTION_PLAN_IDS.map(id => {
        const latest = this.dependencies.store.latest(id, 1)[0];
        const due = planDueState(id, this.now(), this.lastScheduledStartedAt(id));
        return {
          id,
          due: due.due,
          pending: latest?.status === 'running' && !this.canExecute(id),
          nextRunAt: due.nextRunAt,
          ...(latest ? { latest } : {}),
        };
      }),
    };
  }

  batches(limit = 20, planId?: CollectionPlanId): CollectionBatch[] {
    return this.dependencies.store.latest(planId, limit);
  }

  async run(
    planId: CollectionPlanId,
    options: {
      force?: boolean;
      trigger?: CollectionPlanTrigger;
      zsxqMode?: ZsxqCollectionMode;
    } = {},
  ): Promise<CollectionBatch> {
    const running = this.dependencies.store.active(planId)[0];
    if (running && !options.force) {
      if (this.dependencies.extensionConnected()) {
        if (
          running.planId === 'zsxq-chen-teacher'
          && running.preparationStatus === 'completed'
        ) {
          await this.reconcileZsxqBatch(running.id);
        } else await this.execute(running);
      }
      return this.dependencies.store.get(running.id) ?? running;
    }
    const batch = await this.dependencies.store.start(
      planId,
      {
        trigger: options.trigger ?? 'manual',
        ...(options.force === undefined ? {} : { force: options.force }),
        ...(planId === 'zsxq-chen-teacher'
          ? { zsxqMode: options.zsxqMode ?? 'daily-ledger' }
          : {}),
      },
    );
    if (this.dependencies.extensionConnected()) await this.execute(batch);
    return this.dependencies.store.get(batch.id) ?? batch;
  }

  async runDuePlans(): Promise<void> {
    for (const planId of COLLECTION_PLAN_IDS) {
      if (planDueState(planId, this.now(), this.lastScheduledStartedAt(planId)).due) {
        await this.run(planId, { trigger: 'scheduled' });
      }
    }
  }

  async onExtensionConnected(options: { runDue?: boolean; runtimeId?: string } = {}): Promise<void> {
    if (
      options.runtimeId !== undefined
      && this.extensionRuntimeId !== undefined
      && options.runtimeId !== this.extensionRuntimeId
    ) {
      // 新 Service Worker 不可能继续旧 worker 内存里的采集协程；释放门禁，让持久化
      // 游标按相同批次的新 attempt 恢复。普通网络重连的 runtimeId 相同，不会换代。
      for (const [batchId, live] of this.liveZsxqAttempts) {
        if (live.runtimeId !== options.runtimeId) this.liveZsxqAttempts.delete(batchId);
      }
    }
    if (options.runtimeId !== undefined) this.extensionRuntimeId = options.runtimeId;
    const recent = this.dependencies.store.latest(undefined, 100);
    const persistedBatches = recent.concat(
      this.dependencies.store.active().filter(batch => !recent.some(item => item.id === batch.id)),
    );
    for (const persisted of persistedBatches) {
      const batch = persisted.planId === 'nowcoder-agent-market' && persisted.selectionStatus !== 'completed'
        ? await this.dependencies.store.attachRecoveredJobs(
            persisted.id,
            this.dependencies.jobs.list()
              .filter(job => job.batchId === persisted.id)
              .map(job => job.id),
          )
        : persisted;
      if (
        batch.planId === 'nowcoder-agent-market' &&
        batch.status !== 'running' &&
        batch.selectionStatus === 'pending'
      ) {
        await this.advanceNowcoderBatch(batch);
        continue;
      }
      if (batch.status !== 'running') continue;
      const jobs = this.dependencies.jobs.list();
      const attached = jobs.filter(job => job.batchId === batch.id);
      if (batch.planId === 'zsxq-chen-teacher') {
        // 旧运行中批次没有 preparationStatus，也按未完成处理。即使已经创建了
        // 部分子任务，也必须重跑发现/staging；任务 ID 稳定，重放是幂等的。
        if (batch.preparationStatus !== 'completed') await this.execute(batch);
        else await this.reconcileZsxqBatch(batch.id);
        continue;
      }
      if (
        batch.planId === 'nowcoder-agent-market' &&
        batch.selectionStatus === 'pending' &&
        attached.length === 0
      ) {
        const reconciled = await this.dependencies.store.reconcile(batch.id, jobs);
        await this.advanceNowcoderBatch(reconciled);
        continue;
      }
      // Bridge 已在 extension.hello 前把 dispatched/collecting 恢复为 queued 并重派。
      // 这里若再次执行发现，会覆盖原批次 discovered/coverage，甚至重复分发同一批子任务。
      if (attached.length > 0) {
        const reconciled = await this.dependencies.store.reconcile(batch.id, jobs);
        if (
          reconciled.planId === 'nowcoder-agent-market' &&
          reconciled.selectionStatus === 'pending' &&
          this.nowcoderRoundTerminal(reconciled.id)
        ) await this.advanceNowcoderBatch(reconciled);
      } else await this.execute(batch);
    }
    if (options.runDue) await this.runDuePlans();
  }

  async assertJobAttempt(
    batchId: string,
    planId: CollectionPlanId,
    attempt?: CollectionPlanAttempt,
  ): Promise<void> {
    if (planId !== 'zsxq-chen-teacher') return;
    if (!attempt) throw new Error('知识星球采集任务缺少尝试令牌');
    await this.dependencies.store.assertPreparationAttempt(batchId, attempt);
  }

  isCurrentJobAttempt(job: Pick<JobRecord, 'batchId' | 'planId' | 'planAttempt'>): boolean {
    if (!job.batchId || job.planId !== 'zsxq-chen-teacher' || !job.planAttempt) return false;
    const batch = this.dependencies.store.get(job.batchId);
    return batch?.status === 'running' && batch.preparationAttempt === job.planAttempt;
  }

  /** Fixed Nowcoder children are valid only while their owning batch is still running. */
  acceptsFixedNowcoderJob(job: Pick<JobRecord, 'batchId' | 'planId'>): boolean {
    if (job.planId !== 'nowcoder-agent-market' || !job.batchId) return true;
    return this.dependencies.store.get(job.batchId)?.status === 'running';
  }

  async onJobCreated(job: JobRecord): Promise<void> {
    if (!job.batchId || !job.planId) return;
    await this.dependencies.store.attachJob(job.batchId, job.id, job.planAttempt);
  }

  async onExtensionPlanResult(result: ExtensionPlanResult): Promise<CollectionBatch> {
    const persisted = this.dependencies.store.get(result.batchId);
    if (!persisted) throw new Error(`采集批次不存在：${result.batchId}`);
    if (persisted.status !== 'running' || persisted.planId !== 'zsxq-chen-teacher') return persisted;
    // 账本与批次必须共用同一道 attempt fence。迟到页不能先碰账本、再由批次层忽略。
    if (persisted.preparationAttempt !== result.attempt) return persisted;
    if (result.error) {
      const terminal = await this.dependencies.store.finishPreparationWithError(
        result.batchId,
        result.attempt,
        result.error,
        result.needsAttention === true,
      );
      this.releaseLiveZsxqAttempt(result.batchId, result.attempt);
      if (terminal.status === 'running') return terminal;
      const finalized = await this.finalizeZsxqLedger(terminal);
      const reported = await this.persistTerminalBenchmark(finalized);
      this.clearBatchRuntime(result.batchId);
      return reported;
    }
    if (result.checkpoint && result.ownerAudit) {
      await this.dependencies.zsxqLedger?.recordPage(
        result.batchId,
        result.attempt,
        result.checkpoint,
        result.dayDrafts ?? [],
        result.ownerAudit,
      );
    }
    // 重连可能让旧一轮和新一轮 staging 短暂并行；迟到的 prepared:false
    // 既不能回退完成态，也不能覆盖已完成轮次的发现/拒绝统计。
    if (persisted.preparationStatus === 'completed' && result.prepared !== true) {
      return this.reconcileZsxqBatch(result.batchId);
    }
    const prepared = await this.dependencies.store.recordPreparationResult(
      result.batchId,
      result.attempt,
      {
        discovered: result.discovered,
        prepared: result.prepared === true,
        ...(result.coverage ? { coverage: result.coverage } : {}),
        ...(result.rejections ? { rejections: result.rejections } : {}),
        ...(result.rejectionDetails ? { rejectionDetails: result.rejectionDetails } : {}),
        ...(result.ownerAudit ? { ownerAudit: result.ownerAudit } : {}),
      },
    );
    if (result.prepared === true) {
      this.releaseLiveZsxqAttempt(result.batchId, result.attempt);
    }
    // 成功结果必须显式证明 staging 已完成；省略 prepared 的旧消息只能保持运行，
    // 由能力门禁/下一次重连重新采集，不能把半批任务结算成成功。
    if (prepared.preparationStatus !== 'completed') return prepared;
    return this.reconcileZsxqBatch(result.batchId);
  }

  /**
   * `saved` 只证明本机 sink 已落盘；固定计划的交付确认必须另行持久化。
   * deliveryIds 是跨进程幂等事实，内存 Set 只负责抑制同一进程里的重复回调。
   */
  private async syncSavedPlanJob(job: JobRecord): Promise<void> {
    if (!job.batchId || !job.planId || job.planId === 'nowcoder-agent-market' || job.status !== 'saved') return;
    const batch = this.dependencies.store.get(job.batchId);
    if (!batch || batch.status !== 'running') return;
    const contentId = stableContentId(job.url);
    if (batch.deliveryIds.includes(contentId)) {
      this.syncedJobs.add(job.id);
      return;
    }
    if (this.syncedJobs.has(job.id)) return;
    this.syncedJobs.add(job.id);
    try {
      if (!await this.dependencies.shouldAutoSync(job)) return;
      await this.dependencies.syncJob(job);
      await this.dependencies.store.markDelivered(job.batchId, contentId);
    } catch (error) {
      this.recordSyncError(job.batchId, error);
    }
  }

  /** 重连前先补齐当前 attempt 的所有 saved 交付，再做唯一一次终态结算。 */
  private async reconcileZsxqBatch(batchId: string): Promise<CollectionBatch> {
    const batch = this.dependencies.store.get(batchId);
    const jobs = this.dependencies.jobs.list();
    if (batch?.status === 'running') {
      for (const job of jobs) {
        if (
          job.batchId === batchId
          && job.planId === 'zsxq-chen-teacher'
          && job.planAttempt === batch.preparationAttempt
          && job.status === 'saved'
        ) await this.syncSavedPlanJob(job);
      }
    }
    let reconciled = await this.dependencies.store.reconcile(batchId, jobs);
    if (reconciled.status !== 'running') {
      await this.surfaceSyncErrors(batchId);
      reconciled = this.dependencies.store.get(batchId) ?? reconciled;
      reconciled = await this.finalizeZsxqLedger(reconciled);
      this.clearBatchRuntime(batchId);
    }
    return reconciled;
  }

  private async finalizeZsxqLedger(batch: CollectionBatch): Promise<CollectionBatch> {
    const ledger = this.dependencies.zsxqLedger;
    if (
      !ledger
      || batch.planId !== 'zsxq-chen-teacher'
      || batch.status === 'running'
      || !batch.preparationAttempt
    ) return batch;
    try {
      const audit = await ledger.finalize(batch.id, batch.preparationAttempt, {
        status: batch.status,
        ...(batch.error ? { errorCode: batch.error.slice(0, 100) } : {}),
      });
      if (!audit && batch.status === 'completed') {
        return this.dependencies.store.attention(
          batch.id,
          '知识星球逐日账本结算失败：扩展未提交只看星主审计事实',
        );
      }
      if (!audit) return batch;
      const audited = await this.dependencies.store.recordOwnerAudit(batch.id, audit);
      if (
        audit.failed > 0
        || audit.failedDays > 0
        || audit.safetyCapReached
        || (audited.zsxqMode === 'owner-history' && audit.exhausted !== true)
      ) {
        const ledgerError =
          `知识星球逐日账本未通过：failed=${audit.failed}，failedDays=${audit.failedDays}，`
          + `exhausted=${String(audit.exhausted)}，safetyCapReached=${String(audit.safetyCapReached)}`;
        return this.dependencies.store.attention(
          batch.id,
          batch.error ? `${batch.error}；${ledgerError}` : ledgerError,
        );
      }
      return audited;
    } catch (error) {
      const message = `知识星球逐日账本结算失败：${error instanceof Error ? error.message : String(error)}`;
      return this.dependencies.store.attention(batch.id, message);
    }
  }

  async onJobTerminal(job: JobRecord): Promise<void> {
    if (!job.batchId || !job.planId) return;
    const currentBatch = this.dependencies.store.get(job.batchId);
    if (currentBatch?.status !== 'running') return;
    if (job.planId === 'zsxq-chen-teacher' && !this.isCurrentJobAttempt(job)) return;
    if (job.planId !== 'nowcoder-agent-market' && job.status === 'saved' && !this.coveredJobs.has(job.id)) {
      this.coveredJobs.add(job.id);
      const key = await this.dependencies.coverageKey?.(job);
      if (key) {
        const batch = this.dependencies.store.get(job.batchId);
        if (batch) {
          const coverage = { ...(batch.coverage ?? {}), [key]: (batch.coverage?.[key] ?? 0) + 1 };
          await this.dependencies.store.markDiscovery(batch.id, batch.discovered, coverage);
        }
      }
    }
    await this.syncSavedPlanJob(job);
    if (job.status !== 'saved' && job.status !== 'failed' && job.status !== 'needs_attention') return;
    if (job.planId === 'zsxq-chen-teacher') {
      await this.reconcileZsxqBatch(job.batchId);
      return;
    }
    if (job.planId === 'nowcoder-agent-market' && job.errorCode === 'TAB_CLOSED_BY_USER') {
      await this.stopNowcoderBatchForUserClose(currentBatch, job);
      return;
    }
    const reconciled = await this.dependencies.store.reconcile(
      job.batchId,
      this.dependencies.jobs.list(),
    );
    if (job.planId !== 'nowcoder-agent-market') {
      if (reconciled.status !== 'running') {
        await this.surfaceSyncErrors(job.batchId);
        this.clearBatchRuntime(job.batchId);
      }
      return;
    }
    if (!this.nowcoderRoundTerminal(reconciled.id)) {
      await this.dispatchNextNowcoderJob(reconciled.id);
      return;
    }
    await this.advanceNowcoderBatch(reconciled);
  }

  private async stopNowcoderBatchForUserClose(batch: CollectionBatch, job: JobRecord): Promise<void> {
    // Persist the parent stop first. This is the durable dispatch/ingress fence: if the process
    // exits while terminalizing siblings below, a restart still cannot reopen any queued child.
    // Reversing this order would leave a crash window where an untouched sibling has a running
    // parent and can be dispatched by a reconnect.
    const terminal = await this.dependencies.store.attention(
      batch.id,
      '用户关闭了牛客采集页面，已停止本次牛客运行',
    );
    for (const sibling of this.dependencies.jobs.list('queued')) {
      if (sibling.batchId !== batch.id || sibling.id === job.id) continue;
      await this.dependencies.jobs.transition(sibling.id, 'failed', {
        errorCode: 'PLAN_STOPPED_BY_USER',
        errorMessage: '用户关闭了牛客采集页面，所属计划已停止',
      });
    }
    await this.persistTerminalBenchmark(terminal);
    this.clearBatchRuntime(batch.id);
  }

  private async dispatchNextNowcoderJob(batchId: string): Promise<void> {
    const batch = this.dependencies.store.get(batchId);
    if (!batch || batch.planId !== 'nowcoder-agent-market' || batch.status !== 'running') return;
    const next = this.dependencies.jobs.list('queued')
      .find(job => job.batchId === batchId && job.planId === 'nowcoder-agent-market');
    if (!next) return;
    try {
      await this.dependencies.dispatch(next);
    } catch (error) {
      const failed = await this.dependencies.jobs.transition(next.id, 'failed', {
        errorCode: 'DISPATCH_FAILED',
        errorMessage: error instanceof Error ? error.message : '任务分发失败',
      });
      await this.onJobTerminal(failed);
    }
  }

  /** 记录 Bridge 运行期防线拒绝的计划子任务，再按终态推进批次。 */
  async onJobRejected(job: JobRecord, reason: string): Promise<void> {
    if (job.batchId && job.planId) {
      if (job.planId === 'zsxq-chen-teacher' && !this.isCurrentJobAttempt(job)) return;
      await this.dependencies.store.recordRejection(job.batchId, { url: job.url, reason });
    }
    await this.onJobTerminal(job);
  }

  async advanceNowcoderBatch(batch: CollectionBatch): Promise<void> {
    if (batch.selectionStatus === 'completed' || this.advancingBatches.has(batch.id)) return;
    this.advancingBatches.add(batch.id);
    try {
      let current = await this.dependencies.store.attachRecoveredJobs(
        batch.id,
        this.dependencies.jobs.list().filter(job => job.batchId === batch.id).map(job => job.id),
      );
      if (current.status !== 'running') {
        current = current.selectionStatus === 'pending'
          ? await this.dependencies.store.resumeSelection(batch.id)
          : await this.dependencies.store.resumeCollection(batch.id);
      }
      while (current.selectionStatus !== 'completed') {
        const jobs = this.dependencies.jobs.list();
        const attached = jobs.filter(job => job.batchId === current.id);
        let prepared: Awaited<ReturnType<CollectionPlanService['selectSaved']>>;
        try {
          prepared = await this.selectSaved(current, attached);
        } catch (error) {
          const terminal = await this.dependencies.store.attention(
            current.id,
            `牛客真实性筛选失败：${error instanceof Error ? error.message : String(error)}`,
          );
          await this.persistTerminalBenchmark(terminal);
          this.clearBatchRuntime(current.id);
          return;
        }

        const target = FE_JOURNEY_PRESET.nowcoder.planTargetAccepted;
        if (prepared.selection.accepted.length >= target) {
          await this.finalizeExactTen(current, prepared);
          return;
        }

        const wholeBatchLayoutOutage = attached.length > 0 &&
          prepared.saved.length === 0 &&
          attached.every(job =>
            job.status === 'failed' && NOWCODER_CONTENT_REJECTION_CODES.has(job.errorCode ?? ''));
        if (wholeBatchLayoutOutage) {
          const terminal = await this.dependencies.store.finalizeSelection(
            current.id,
            0,
            prepared.selection.coverage,
            prepared.rejectionCounts,
            undefined,
            0,
            [],
          );
          await this.persistTerminalBenchmark(terminal);
          this.clearBatchRuntime(current.id);
          return;
        }

        const budget = FE_JOURNEY_PRESET.nowcoder.planDetailBudget;
        if (attached.length >= budget) {
          await this.attentionWithoutDelivery(current, prepared, '已达到 24 条详情任务安全上限');
          return;
        }

        const roundSize = attached.length === 0
          ? FE_JOURNEY_PRESET.nowcoder.planInitialRoundSize
          : FE_JOURNEY_PRESET.nowcoder.planRefillRoundSize;
        let next: NowcoderDiscoveryCandidate[];
        try {
          next = await this.discoverRound(current, Math.min(roundSize, budget - attached.length));
        } catch (error) {
          const terminal = await this.dependencies.store.fail(
            current.id,
            error instanceof Error ? error.message : '固定采集计划执行失败',
          );
          await this.persistTerminalBenchmark(terminal);
          this.clearBatchRuntime(current.id);
          return;
        }
        if (next.length === 0) {
          await this.attentionWithoutDelivery(current, prepared, '公开候选已耗尽');
          return;
        }

        await this.dependencies.store.resumeCollection(current.id);
        current = await this.createAttachAndDispatch(current, attached.length, next);
        if (!this.nowcoderRoundTerminal(current.id)) return;
      }
    } finally {
      this.advancingBatches.delete(batch.id);
    }
  }

  private async selectSaved(batch: CollectionBatch, attached: readonly JobRecord[]) {
    const saved = attached.filter(candidate => candidate.status === 'saved');
    const pooled = await this.dependencies.pendingNowcoderJobs?.(batch.id) ?? [];
    const candidatesByContentId = new Map<string, JobRecord>();
    for (const candidate of [...saved, ...pooled]) {
      const contentId = stableContentId(candidate.url);
      if (!candidatesByContentId.has(contentId)) candidatesByContentId.set(contentId, candidate);
    }
    const selectionCandidates = [...candidatesByContentId.values()];
    // 搜索结果会混入求建议、招聘等非面经详情页。只在同批至少有一页成功抽取、
    // 足以证明采集器仍可用时，才把布局不支持降级为内容过滤；整批都失败仍保留故障信号。
    const contentRejectionFailures = saved.length === 0
      ? []
      : attached.filter(candidate =>
        candidate.status === 'failed' &&
        NOWCODER_CONTENT_REJECTION_CODES.has(candidate.errorCode ?? ''));
    const selection = selectionCandidates.length === 0
      ? {
          accepted: [],
          coverage: { bytedance: 0, tencent: 0, alibaba: 0, ant: 0, other: 0 },
          rejected: [],
        }
      : await this.dependencies.selectNowcoderJobs(selectionCandidates, batch.startedAt);
    const currentUrls = new Set(saved.map(job => job.url));
    const rejectionCounts: Record<string, number> = { ...(batch.rejections ?? {}) };
    for (const rejected of selection.rejected.filter(item => currentUrls.has(item.url))) {
      rejectionCounts[rejected.reason] = (rejectionCounts[rejected.reason] ?? 0) + 1;
    }
    for (const rejected of contentRejectionFailures) {
      const reason = NOWCODER_CONTENT_REJECTION_CODES.get(rejected.errorCode ?? '')!;
      rejectionCounts[reason] = (rejectionCounts[reason] ?? 0) + 1;
    }
    return { saved, selection, rejectionCounts, contentRejectionFailures };
  }

  private async discoverRound(
    batch: CollectionBatch,
    limit: number,
  ): Promise<NowcoderDiscoveryCandidate[]> {
    const jobs = this.dependencies.jobs.list();
    const known = knownNowcoderPlanUrls(jobs, batch.id, this.now());
    const discovered = await this.dependencies.discoverNowcoder(known);
    const unique = [...new Map(discovered.map(candidate => [candidate.url, candidate])).values()]
      .filter(candidate => !known.has(candidate.url));
    return selectDiscoveryRound(unique, batch.startedAt, limit);
  }

  private async createAttachAndDispatch(
    batch: CollectionBatch,
    attachedCount: number,
    candidates: readonly NowcoderDiscoveryCandidate[],
  ): Promise<CollectionBatch> {
    const staged: JobRecord[] = [];
    for (const candidate of candidates) {
      staged.push(await this.dependencies.jobs.create({
        id: `${batch.id}-${stableContentId(candidate.url)}`,
        url: candidate.url,
        requestedBy: 'codex',
        batchId: batch.id,
        planId: batch.planId,
      }));
    }
    await this.dependencies.store.markDiscovery(
      batch.id,
      Math.max(batch.discovered, attachedCount + staged.length),
      batch.coverage ?? { bytedance: 0, tencent: 0, alibaba: 0, ant: 0, other: 0 },
      batch.rejections ?? {},
    );
    await this.dependencies.store.attachRound(batch.id, staged.map(job => job.id));
    await this.dependencies.store.markSelectionPending(batch.id);
    await this.dispatchNextNowcoderJob(batch.id);
    return this.dependencies.store.reconcile(batch.id, this.dependencies.jobs.list());
  }

  private async finalizeExactTen(
    batch: CollectionBatch,
    prepared: Awaited<ReturnType<CollectionPlanService['selectSaved']>>,
  ): Promise<void> {
    const accepted = prepared.selection.accepted.slice(
      0,
      FE_JOURNEY_PRESET.nowcoder.planTargetAccepted,
    );
    const delivered = new Set(accepted.map(job => stableContentId(job.url)));
    if (this.dependencies.syncNowcoderJobs) {
      try {
        await this.dependencies.syncNowcoderJobs(accepted, batch.id);
      } catch (error) {
        this.recordSyncError(batch.id, error);
      }
    } else {
      for (const job of accepted) {
        try {
          await this.dependencies.syncJob(job, batch.id);
        } catch (error) {
          this.recordSyncError(batch.id, error);
        }
      }
    }
    const syncErrors = this.batchSyncErrors.get(batch.id);
    if (syncErrors?.length || delivered.size !== accepted.length) {
      const message = syncErrors?.length
        ? `自动同步失败：${syncErrors.join('；')}`
        : `自动同步结果不足 ${accepted.length} 条`;
      const terminal = await this.dependencies.store.retrySelection(batch.id, message);
      await this.persistTerminalBenchmark(terminal);
      this.clearBatchRuntime(batch.id);
      return;
    }
    await this.dependencies.store.markDiscovery(
      batch.id,
      Math.max(batch.discovered, accepted.length),
      prepared.selection.coverage,
      prepared.rejectionCounts,
    );
    const terminal = await this.dependencies.store.finalizeSelection(
      batch.id,
      accepted.length,
      prepared.selection.coverage,
      prepared.rejectionCounts,
      undefined,
      prepared.contentRejectionFailures.length,
      [...delivered],
    );
    await this.persistTerminalBenchmark(terminal);
    this.clearBatchRuntime(batch.id);
  }

  private async attentionWithoutDelivery(
    batch: CollectionBatch,
    prepared: Awaited<ReturnType<CollectionPlanService['selectSaved']>>,
    reason: string,
  ): Promise<void> {
    await this.dependencies.store.markDiscovery(
      batch.id,
      Math.max(batch.discovered, prepared.selection.accepted.length),
      prepared.selection.coverage,
      prepared.rejectionCounts,
    );
    const terminal = await this.dependencies.store.finalizeSelection(
      batch.id,
      prepared.selection.accepted.length,
      prepared.selection.coverage,
      prepared.rejectionCounts,
      `牛客合格候选不足 10 条（${prepared.selection.accepted.length}/10）：${reason}`,
      prepared.contentRejectionFailures.length,
      [],
    );
    await this.persistTerminalBenchmark(terminal);
    this.clearBatchRuntime(batch.id);
  }

  private nowcoderRoundTerminal(batchId: string): boolean {
    const attached = this.dependencies.jobs.list().filter(job => job.batchId === batchId);
    return attached.length > 0 && attached.every(job =>
      job.status === 'saved' || job.status === 'failed' || job.status === 'needs_attention');
  }

  private recordSyncError(batchId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const current = this.batchSyncErrors.get(batchId) ?? [];
    if (!current.includes(message)) current.push(message);
    this.batchSyncErrors.set(batchId, current);
  }

  private async surfaceSyncErrors(batchId: string): Promise<void> {
    const errors = this.batchSyncErrors.get(batchId);
    if (!errors || errors.length === 0) return;
    await this.dependencies.store.attention(batchId, `自动同步失败：${errors.join('；')}`);
  }

  private async persistTerminalBenchmark(batch: CollectionBatch): Promise<CollectionBatch> {
    if (
      batch.planId !== 'nowcoder-agent-market' ||
      batch.status === 'running' ||
      !this.dependencies.writeBenchmark
    ) return batch;
    const allJobs = this.dependencies.jobs.list();
    const jobs = allJobs.filter(job => job.batchId === batch.id);
    const delivered = new Set(batch.deliveryIds);
    const contributorByContentId = new Map<string, JobRecord>();
    for (const job of allJobs) {
      const contentId = stableContentId(job.url);
      if (!delivered.has(contentId) || job.status !== 'saved') continue;
      const existing = contributorByContentId.get(contentId);
      if (
        !existing
        || job.batchId === batch.id
        || (existing.batchId !== batch.id && job.updatedAt > existing.updatedAt)
      ) contributorByContentId.set(contentId, job);
    }
    for (const contributor of contributorByContentId.values()) {
      if (!jobs.some(job => job.id === contributor.id)) jobs.push(contributor);
    }
    try {
      await this.dependencies.writeBenchmark(batch, jobs);
      return batch;
    } catch {
      return this.dependencies.store.attention(
        batch.id,
        benchmarkFailureError(batch.error),
      );
    }
  }

  private clearBatchRuntime(batchId: string): void {
    for (const job of this.dependencies.jobs.list()) {
      if (job.batchId !== batchId) continue;
      this.syncedJobs.delete(job.id);
      this.coveredJobs.delete(job.id);
    }
    this.batchSyncErrors.delete(batchId);
    this.liveZsxqAttempts.delete(batchId);
  }

  private releaseLiveZsxqAttempt(batchId: string, attempt: CollectionPlanAttempt): void {
    if (this.liveZsxqAttempts.get(batchId)?.attempt === attempt) {
      this.liveZsxqAttempts.delete(batchId);
    }
  }

  private async execute(batch: CollectionBatch): Promise<void> {
    if (
      batch.planId === 'zsxq-chen-teacher'
      && this.liveZsxqAttempts.has(batch.id)
    ) return;
    if (this.executing.has(batch.id) || !this.canExecute(batch.planId)) return;
    this.executing.add(batch.id);
    let zsxqAttempt: CollectionPlanAttempt | undefined;
    try {
      if (batch.planId === 'zsxq-chen-teacher') {
        const preparing = await this.dependencies.store.beginPreparation(batch.id);
        zsxqAttempt = preparing.preparationAttempt;
        if (!zsxqAttempt) throw new Error('知识星球采集尝试未生成');
        this.liveZsxqAttempts.set(batch.id, {
          attempt: zsxqAttempt,
          ...(this.extensionRuntimeId ? { runtimeId: this.extensionRuntimeId } : {}),
        });
        const mode = preparing.zsxqMode ?? 'daily-ledger';
        const ledgerRequest = this.dependencies.zsxqLedger?.requestFor(mode)
          ?? { targetDays: [] as string[] };
        await this.dependencies.zsxqLedger?.beginAttempt(
          batch.id,
          zsxqAttempt,
          mode,
          ledgerRequest.targetDays,
        );
        const dispatched = await this.dependencies.collectZsxq(
          batch.id,
          batch.planId,
          zsxqAttempt,
          batch.force === true,
          mode,
          ledgerRequest.targetDays,
          ledgerRequest.resumeCursor,
        );
        if (dispatched !== true) throw new Error('知识星球采集命令未派发');
        return;
      }
      await this.advanceNowcoderBatch(batch);
    } catch (error) {
      const message = error instanceof Error ? error.message : '固定采集计划执行失败';
      const terminal = zsxqAttempt
        ? await this.dependencies.store.finishPreparationWithError(
            batch.id,
            zsxqAttempt,
            message,
            false,
          )
        : await this.dependencies.store.fail(batch.id, message);
      const finalized = zsxqAttempt ? await this.finalizeZsxqLedger(terminal) : terminal;
      const reported = await this.persistTerminalBenchmark(finalized);
      if (zsxqAttempt) this.releaseLiveZsxqAttempt(batch.id, zsxqAttempt);
      if (zsxqAttempt && reported.status !== 'running') {
        this.dependencies.onZsxqAttemptTerminal?.(reported);
      }
    } finally {
      this.executing.delete(batch.id);
    }
  }

  private canExecute(planId: CollectionPlanId): boolean {
    if (!this.dependencies.extensionConnected()) return false;
    return planId !== 'zsxq-chen-teacher' || (
      this.dependencies.canCollectZsxq?.() !== false
      && this.dependencies.canStartZsxqAttempt?.() !== false
    );
  }
}
