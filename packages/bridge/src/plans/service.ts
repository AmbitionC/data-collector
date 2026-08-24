import {
  COLLECTION_PLAN_IDS,
  stableContentId,
  type CollectionBatch,
  type CollectionPlanId,
  type JobRecord,
} from '@data-collector/shared';
import type { JobStore } from '../jobs/store.js';
import type { NowcoderDiscoveryCandidate } from '../feJourney/nowcoderDiscovery.js';
import { FE_JOURNEY_PRESET } from '../feJourney/preset.js';
import { knownNowcoderPlanUrls } from './nowcoderHistory.js';
import { NOWCODER_COMPANIES, type CompanyId } from './nowcoderPlan.js';
import type { CollectionPlanStore } from './store.js';

const PLAN_HOURS: Record<CollectionPlanId, number> = {
  'zsxq-chen-teacher': 8,
  'nowcoder-agent-market': 9,
};

const NOWCODER_CONTENT_REJECTION_CODES = new Map([
  ['UNSUPPORTED_LAYOUT', '页面结构不含可采集正文'],
]);

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
  discoverNowcoder: (knownUrls: ReadonlySet<string>) => Promise<NowcoderDiscoveryCandidate[]>;
  dispatch: (job: JobRecord) => Promise<void>;
  collectZsxq: (batchId: string, planId: 'zsxq-chen-teacher') => Promise<void>;
  shouldAutoSync: (job: JobRecord) => Promise<boolean>;
  selectNowcoderJobs: (
    jobs: readonly JobRecord[],
    now: string,
  ) => Promise<{
    accepted: JobRecord[];
    coverage: Record<string, number>;
    rejected: Array<{ url: string; reason: string }>;
  }>;
  coverageKey?: (job: JobRecord) => Promise<string | undefined>;
  syncJob: (job: JobRecord) => Promise<void>;
  writeBenchmark?: (batch: CollectionBatch, jobs: readonly JobRecord[]) => Promise<void>;
}

export interface ExtensionPlanResult {
  batchId: string;
  discovered: number;
  coverage?: Record<string, number>;
  rejections?: Record<string, number>;
  error?: string;
  needsAttention?: boolean;
  prepared?: boolean;
}

function rotatedCompanies(now: string): CompanyId[] {
  const day = Math.floor(Date.parse(`${shanghaiDay(now)}T00:00:00.000Z`) / 86_400_000);
  const offset = ((day % NOWCODER_COMPANIES.length) + NOWCODER_COMPANIES.length) % NOWCODER_COMPANIES.length;
  return NOWCODER_COMPANIES.map((_, index) => NOWCODER_COMPANIES[(index + offset) % 4]!);
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
  private readonly syncedJobs = new Set<string>();
  private readonly coveredJobs = new Set<string>();
  private readonly advancingBatches = new Set<string>();
  private readonly batchSyncErrors = new Map<string, string[]>();

  constructor(private readonly dependencies: CollectionPlanServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
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
        const due = planDueState(id, this.now(), latest?.startedAt);
        return {
          id,
          due: due.due,
          pending: latest?.status === 'running' && !this.dependencies.extensionConnected(),
          nextRunAt: due.nextRunAt,
          ...(latest ? { latest } : {}),
        };
      }),
    };
  }

  batches(limit = 20, planId?: CollectionPlanId): CollectionBatch[] {
    return this.dependencies.store.latest(planId, limit);
  }

  async run(planId: CollectionPlanId, options: { force?: boolean } = {}): Promise<CollectionBatch> {
    const running = this.dependencies.store.latest(planId, 20).find(batch => batch.status === 'running');
    if (running && !options.force) {
      if (this.dependencies.extensionConnected()) await this.execute(running);
      return this.dependencies.store.latest(planId, 20).find(batch => batch.id === running.id) ?? running;
    }
    const batch = await this.dependencies.store.start(planId);
    if (this.dependencies.extensionConnected()) await this.execute(batch);
    return this.dependencies.store.latest(planId, 20).find(item => item.id === batch.id) ?? batch;
  }

  async runDuePlans(): Promise<void> {
    for (const planId of COLLECTION_PLAN_IDS) {
      const latest = this.dependencies.store.latest(planId, 1)[0];
      if (planDueState(planId, this.now(), latest?.startedAt).due) await this.run(planId);
    }
  }

  async onExtensionConnected(options: { runDue?: boolean } = {}): Promise<void> {
    for (const persisted of this.dependencies.store.latest(undefined, 100)) {
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

  async onJobCreated(job: JobRecord): Promise<void> {
    if (!job.batchId || !job.planId) return;
    await this.dependencies.store.attachJob(job.batchId, job.id);
  }

  async onExtensionPlanResult(result: ExtensionPlanResult): Promise<CollectionBatch> {
    if (result.error) {
      const terminal = await (result.needsAttention
        ? this.dependencies.store.attention(result.batchId, result.error)
        : this.dependencies.store.fail(result.batchId, result.error));
      const reported = await this.persistTerminalBenchmark(terminal);
      this.clearBatchRuntime(result.batchId);
      return reported;
    }
    await this.dependencies.store.markDiscovery(
      result.batchId,
      result.discovered,
      result.coverage,
      result.rejections,
    );
    if (result.prepared === false) {
      return this.dependencies.store.latest(undefined, 100)
        .find(batch => batch.id === result.batchId)!;
    }
    const batch = await this.dependencies.store.reconcile(result.batchId, this.dependencies.jobs.list());
    if (batch.status !== 'running') this.clearBatchRuntime(batch.id);
    return batch;
  }

  async onJobTerminal(job: JobRecord): Promise<void> {
    if (!job.batchId || !job.planId) return;
    const currentBatch = this.dependencies.store.latest(job.planId, 100)
      .find(batch => batch.id === job.batchId);
    if (currentBatch?.status !== 'running') return;
    if (job.planId !== 'nowcoder-agent-market' && job.status === 'saved' && !this.coveredJobs.has(job.id)) {
      this.coveredJobs.add(job.id);
      const key = await this.dependencies.coverageKey?.(job);
      if (key) {
        const batch = this.dependencies.store.latest(job.planId, 100)
          .find(item => item.id === job.batchId);
        if (batch) {
          const coverage = { ...(batch.coverage ?? {}), [key]: (batch.coverage?.[key] ?? 0) + 1 };
          await this.dependencies.store.markDiscovery(batch.id, batch.discovered, coverage);
        }
      }
    }
    if (job.planId !== 'nowcoder-agent-market' && job.status === 'saved' && !this.syncedJobs.has(job.id)) {
      this.syncedJobs.add(job.id);
      if (await this.dependencies.shouldAutoSync(job)) {
        try {
          await this.dependencies.syncJob(job);
          await this.dependencies.store.markDelivered(job.batchId, stableContentId(job.url));
        } catch (error) {
          this.recordSyncError(job.batchId, error);
        }
      }
    }
    if (job.status !== 'saved' && job.status !== 'failed' && job.status !== 'needs_attention') return;
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
    if (!this.nowcoderRoundTerminal(reconciled.id)) return;
    await this.advanceNowcoderBatch(reconciled);
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
    // 搜索结果会混入求建议、招聘等非面经详情页。只在同批至少有一页成功抽取、
    // 足以证明采集器仍可用时，才把布局不支持降级为内容过滤；整批都失败仍保留故障信号。
    const contentRejectionFailures = saved.length === 0
      ? []
      : attached.filter(candidate =>
        candidate.status === 'failed' &&
        NOWCODER_CONTENT_REJECTION_CODES.has(candidate.errorCode ?? ''));
    const selection = saved.length === 0
      ? {
          accepted: [],
          coverage: { bytedance: 0, tencent: 0, alibaba: 0, ant: 0 },
          rejected: [],
        }
      : await this.dependencies.selectNowcoderJobs(saved, batch.startedAt);
    const rejectionCounts: Record<string, number> = { ...(batch.rejections ?? {}) };
    for (const rejected of selection.rejected) {
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
      batch.coverage ?? { bytedance: 0, tencent: 0, alibaba: 0, ant: 0 },
      batch.rejections ?? {},
    );
    await this.dependencies.store.attachRound(batch.id, staged.map(job => job.id));
    await this.dependencies.store.markSelectionPending(batch.id);
    for (const job of staged) {
      try {
        await this.dependencies.dispatch(job);
      } catch (error) {
        await this.dependencies.jobs.transition(job.id, 'failed', {
          errorCode: 'DISPATCH_FAILED',
          errorMessage: error instanceof Error ? error.message : '任务分发失败',
        });
      }
    }
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
    const delivered = new Set<string>();
    for (const job of accepted) {
      const contentId = stableContentId(job.url);
      if (delivered.has(contentId)) continue;
      try {
        await this.dependencies.syncJob(job);
        delivered.add(contentId);
      } catch (error) {
        this.recordSyncError(batch.id, error);
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
    const jobs = this.dependencies.jobs.list().filter(job => job.batchId === batch.id);
    try {
      await this.dependencies.writeBenchmark(batch, jobs);
      return batch;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const prior = batch.error ? `${batch.error}；` : '';
      return this.dependencies.store.attention(
        batch.id,
        `${prior}基准报告写入失败：${detail}`,
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
  }

  private async execute(batch: CollectionBatch): Promise<void> {
    if (this.executing.has(batch.id) || !this.dependencies.extensionConnected()) return;
    this.executing.add(batch.id);
    try {
      if (batch.planId === 'zsxq-chen-teacher') {
        await this.dependencies.collectZsxq(batch.id, batch.planId);
        return;
      }
      await this.advanceNowcoderBatch(batch);
    } catch (error) {
      const terminal = await this.dependencies.store.fail(
        batch.id,
        error instanceof Error ? error.message : '固定采集计划执行失败',
      );
      await this.persistTerminalBenchmark(terminal);
    } finally {
      this.executing.delete(batch.id);
    }
  }
}
