import {
  COLLECTION_PLAN_IDS,
  stableContentId,
  type CollectionBatch,
  type CollectionPlanId,
  type JobRecord,
} from '@data-collector/shared';
import type { JobStore } from '../jobs/store.js';
import type { NowcoderDiscoveryCandidate } from '../feJourney/nowcoderDiscovery.js';
import { NOWCODER_COMPANIES, type CompanyId } from './nowcoderPlan.js';
import type { CollectionPlanStore } from './store.js';

const PLAN_HOURS: Record<CollectionPlanId, number> = {
  'zsxq-chen-teacher': 8,
  'nowcoder-agent-market': 9,
};

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
  coverageKey?: (job: JobRecord) => Promise<string | undefined>;
  syncJob: (job: JobRecord) => Promise<void>;
}

export interface ExtensionPlanResult {
  batchId: string;
  discovered: number;
  coverage?: Record<string, number>;
  error?: string;
  needsAttention?: boolean;
  prepared?: boolean;
}

function rotatedCompanies(now: string): CompanyId[] {
  const day = Math.floor(Date.parse(`${shanghaiDay(now)}T00:00:00.000Z`) / 86_400_000);
  const offset = ((day % NOWCODER_COMPANIES.length) + NOWCODER_COMPANIES.length) % NOWCODER_COMPANIES.length;
  return NOWCODER_COMPANIES.map((_, index) => NOWCODER_COMPANIES[(index + offset) % 4]!);
}

function selectDiscoveryPool(
  candidates: readonly NowcoderDiscoveryCandidate[],
  now: string,
): NowcoderDiscoveryCandidate[] {
  const buckets = new Map<CompanyId, NowcoderDiscoveryCandidate[]>(
    NOWCODER_COMPANIES.map(company => [company, candidates.filter(item => item.queryCompany === company)]),
  );
  const selected: NowcoderDiscoveryCandidate[] = [];
  let advanced = true;
  while (selected.length < 12 && advanced) {
    advanced = false;
    for (const company of rotatedCompanies(now)) {
      if (selected.filter(item => item.queryCompany === company).length >= 4) continue;
      const candidate = buckets.get(company)?.shift();
      if (!candidate) continue;
      selected.push(candidate);
      advanced = true;
      if (selected.length >= 12) break;
    }
  }
  return selected;
}

export class CollectionPlanService {
  private readonly now: () => string;
  private readonly executing = new Set<string>();
  private readonly syncedJobs = new Set<string>();
  private readonly coveredJobs = new Set<string>();

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
    for (const batch of this.dependencies.store.latest(undefined, 100)) {
      if (batch.status !== 'running') continue;
      const jobs = this.dependencies.jobs.list();
      const attached = jobs.filter(job => job.batchId === batch.id);
      // Bridge 已在 extension.hello 前把 dispatched/collecting 恢复为 queued 并重派。
      // 这里若再次执行发现，会覆盖原批次 discovered/coverage，甚至重复分发同一批子任务。
      if (attached.length > 0) await this.dependencies.store.reconcile(batch.id, jobs);
      else await this.execute(batch);
    }
    if (options.runDue) await this.runDuePlans();
  }

  async onJobCreated(job: JobRecord): Promise<void> {
    if (!job.batchId || !job.planId) return;
    await this.dependencies.store.attachJob(job.batchId, job.id);
  }

  async onExtensionPlanResult(result: ExtensionPlanResult): Promise<CollectionBatch> {
    if (result.error) {
      return result.needsAttention
        ? this.dependencies.store.attention(result.batchId, result.error)
        : this.dependencies.store.fail(result.batchId, result.error);
    }
    await this.dependencies.store.markDiscovery(result.batchId, result.discovered, result.coverage);
    if (result.prepared === false) {
      return this.dependencies.store.latest(undefined, 100)
        .find(batch => batch.id === result.batchId)!;
    }
    return this.dependencies.store.reconcile(result.batchId, this.dependencies.jobs.list());
  }

  async onJobTerminal(job: JobRecord): Promise<void> {
    if (!job.batchId || !job.planId) return;
    if (job.status === 'saved' && !this.coveredJobs.has(job.id)) {
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
    if (job.status === 'saved' && !this.syncedJobs.has(job.id)) {
      this.syncedJobs.add(job.id);
      if (await this.dependencies.shouldAutoSync(job)) {
        try {
          await this.dependencies.syncJob(job);
        } catch {
          // 本机原文已经保存；同步状态由 library catalog 如实保留，不能反过来打断任务回执。
        }
      }
    }
    if (job.status === 'saved' || job.status === 'failed' || job.status === 'needs_attention') {
      await this.dependencies.store.reconcile(job.batchId, this.dependencies.jobs.list());
    }
  }

  private async execute(batch: CollectionBatch): Promise<void> {
    if (this.executing.has(batch.id) || !this.dependencies.extensionConnected()) return;
    this.executing.add(batch.id);
    try {
      if (batch.planId === 'zsxq-chen-teacher') {
        await this.dependencies.collectZsxq(batch.id, batch.planId);
        return;
      }
      const known = new Set(this.dependencies.jobs.list().map(job => job.url));
      const discovered = await this.dependencies.discoverNowcoder(known);
      await this.dependencies.store.markDiscovery(batch.id, discovered.length, {
        bytedance: 0, tencent: 0, alibaba: 0, ant: 0,
      });
      const staged: JobRecord[] = [];
      for (const candidate of selectDiscoveryPool(discovered, this.now())) {
        const job = await this.dependencies.jobs.create({
          id: `${batch.id}-${stableContentId(candidate.url)}`,
          url: candidate.url,
          requestedBy: 'codex',
          batchId: batch.id,
          planId: batch.planId,
        });
        await this.onJobCreated(job);
        staged.push(job);
      }
      for (const job of staged) {
        try {
          await this.dependencies.dispatch(job);
        } catch (error) {
          const failed = await this.dependencies.jobs.transition(job.id, 'failed', {
            errorCode: 'DISPATCH_FAILED',
            errorMessage: error instanceof Error ? error.message : '任务分发失败',
          });
          await this.onJobTerminal(failed);
        }
      }
      await this.dependencies.store.reconcile(batch.id, this.dependencies.jobs.list());
    } catch (error) {
      await this.dependencies.store.fail(
        batch.id,
        error instanceof Error ? error.message : '固定采集计划执行失败',
      );
    } finally {
      this.executing.delete(batch.id);
    }
  }
}
