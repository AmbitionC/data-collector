import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  zsxqDayDraftSchema,
  zsxqOwnerAuditSchema,
  zsxqOwnerCheckpointSchema,
  type BatchStatus,
  type CollectionPlanAttempt,
  type ZsxqCollectionMode,
  type ZsxqDayDraft,
  type ZsxqOwnerAudit,
  type ZsxqOwnerCheckpoint,
  type ZsxqOwnerItemFact,
} from '@data-collector/shared';

export type ZsxqDayStatus = 'completed_content' | 'completed_empty' | 'failed';

export interface ZsxqDayLedgerEntry extends ZsxqDayDraft {
  status: ZsxqDayStatus;
  checkedAt: string;
  batchId: string;
  attemptToken: CollectionPlanAttempt;
  errorCode?: string;
}

interface ActiveOwnerRun {
  batchId: string;
  attempt: CollectionPlanAttempt;
  mode: ZsxqCollectionMode;
  targetDays: string[];
  checkpoint?: ZsxqOwnerCheckpoint;
  drafts: Record<string, ZsxqDayDraft>;
  audit?: ZsxqOwnerAudit;
  processedPages: string[];
  /** 历史任务重启后，扩展页计数从 1 重新开始；账本用这份基线还原累计审计。 */
  resumeBaseAudit?: ZsxqOwnerAudit;
  resumeBasePagesFetched?: number;
}

interface StoredLedger {
  version: 1;
  planId: 'zsxq-chen-teacher';
  timeZone: 'Asia/Shanghai';
  coverageStartDay?: string;
  days: Record<string, ZsxqDayLedgerEntry>;
  active?: ActiveOwnerRun;
  lastHistoryAudit?: {
    batchId: string;
    attempt: CollectionPlanAttempt;
    itemFacts: ZsxqOwnerItemFact[];
  };
}

function shanghaiDay(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

function shiftDay(day: string, offset: number): string {
  const value = new Date(`${day}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

function emptyLedger(): StoredLedger {
  return {
    version: 1,
    planId: 'zsxq-chen-teacher',
    timeZone: 'Asia/Shanghai',
    days: {},
  };
}

function parseStoredLedger(value: unknown): StoredLedger {
  if (
    typeof value !== 'object'
    || value === null
    || (value as { version?: unknown }).version !== 1
    || (value as { planId?: unknown }).planId !== 'zsxq-chen-teacher'
    || (value as { timeZone?: unknown }).timeZone !== 'Asia/Shanghai'
    || typeof (value as { days?: unknown }).days !== 'object'
    || (value as { days?: unknown }).days === null
  ) throw new Error('知识星球逐日账本格式无效');
  return structuredClone(value as StoredLedger);
}

async function atomicWrite(path: string, value: StoredLedger): Promise<void> {
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

function mergeDraft(left: ZsxqDayDraft | undefined, right: ZsxqDayDraft): ZsxqDayDraft {
  if (!left) return { ...right };
  return {
    day: right.day,
    rawOwnerCount: left.rawOwnerCount + right.rawOwnerCount,
    qualifyingCount: left.qualifyingCount + right.qualifyingCount,
    filteredCount: left.filteredCount + right.filteredCount,
    exactDuplicateCount: left.exactDuplicateCount + right.exactDuplicateCount,
    semanticDuplicateCount: left.semanticDuplicateCount + right.semanticDuplicateCount,
    knownCompleteCount: left.knownCompleteCount + right.knownCompleteCount,
    repairCount: left.repairCount + right.repairCount,
    candidateCount: left.candidateCount + right.candidateCount,
    savedCount: left.savedCount + right.savedCount,
    failedCount: left.failedCount + right.failedCount,
    crossedDayBoundary: left.crossedDayBoundary || right.crossedDayBoundary,
    itemFacts: [...new Map(
      [...(left.itemFacts ?? []), ...(right.itemFacts ?? [])]
        .map(fact => [`${fact.url}:${fact.outcome}:${fact.mappedUrl}`, fact]),
    ).values()],
  };
}

export class ZsxqDayLedgerStore {
  private constructor(
    public readonly path: string,
    private readonly now: () => string,
    private value: StoredLedger,
  ) {}

  static async open(
    path: string,
    now: () => string = () => new Date().toISOString(),
  ): Promise<ZsxqDayLedgerStore> {
    let value = emptyLedger();
    try {
      value = parseStoredLedger(JSON.parse(await readFile(path, 'utf8')) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (error instanceof SyntaxError) throw new Error('知识星球逐日账本格式无效');
        throw error;
      }
    }
    return new ZsxqDayLedgerStore(path, now, value);
  }

  snapshot(): StoredLedger {
    return structuredClone(this.value);
  }

  requestFor(mode: ZsxqCollectionMode): { targetDays: string[]; resumeCursor?: string } {
    const yesterday = shiftDay(shanghaiDay(this.now()), -1);
    if (mode === 'owner-history') {
      const cursor = this.value.active?.mode === mode
        ? this.value.active.checkpoint?.cursor
        : undefined;
      return { targetDays: [], ...(cursor ? { resumeCursor: cursor } : {}) };
    }
    if (!this.value.coverageStartDay) {
      return this.value.days[yesterday]?.status.startsWith('completed_')
        ? { targetDays: [] }
        : { targetDays: [yesterday] };
    }
    const targetDays: string[] = [];
    for (
      let day = yesterday;
      day >= this.value.coverageStartDay;
      day = shiftDay(day, -1)
    ) {
      const entry = this.value.days[day];
      if (!entry || entry.status === 'failed') targetDays.push(day);
    }
    return { targetDays };
  }

  async beginAttempt(
    batchId: string,
    attempt: CollectionPlanAttempt,
    mode: ZsxqCollectionMode,
    targetDays: readonly string[],
  ): Promise<void> {
    const previous = this.value.active;
    this.value.active = {
      batchId,
      attempt,
      mode,
      targetDays: [...targetDays],
      ...(mode === 'owner-history' && previous?.mode === mode
        ? {
            ...(previous.checkpoint ? { checkpoint: { ...previous.checkpoint } } : {}),
            drafts: structuredClone(previous.drafts),
            ...(previous.audit ? { audit: { ...previous.audit } } : {}),
            processedPages: [...previous.processedPages],
            ...(previous.audit ? { resumeBaseAudit: { ...previous.audit } } : {}),
            resumeBasePagesFetched:
              previous.checkpoint?.pagesFetched ?? previous.audit?.pagesFetched ?? 0,
          }
        : { drafts: {}, processedPages: [] }),
    };
    await atomicWrite(this.path, this.value);
  }

  async recordPage(
    batchId: string,
    attempt: CollectionPlanAttempt,
    checkpoint: ZsxqOwnerCheckpoint,
    dayDrafts: readonly ZsxqDayDraft[],
    audit: ZsxqOwnerAudit,
  ): Promise<void> {
    const active = this.requireActive(batchId, attempt);
    const parsedCheckpoint = zsxqOwnerCheckpointSchema.parse(checkpoint);
    const parsedAudit = zsxqOwnerAuditSchema.parse(audit);
    const pageKey = `${parsedCheckpoint.pagesFetched}:${parsedCheckpoint.cursor ?? 'end'}:${String(parsedCheckpoint.exhausted)}`;
    if (active.processedPages.includes(pageKey)) return;
    for (const draft of dayDrafts) {
      const parsed = zsxqDayDraftSchema.parse(draft);
      const { itemFacts, ...required } = parsed;
      const normalized: ZsxqDayDraft = {
        ...required,
        ...(itemFacts ? { itemFacts } : {}),
      };
      active.drafts[parsed.day] = mergeDraft(active.drafts[parsed.day], normalized);
    }
    const baseAudit = active.resumeBaseAudit;
    const basePagesFetched = active.resumeBasePagesFetched ?? 0;
    const cumulativeNewestObservedAt =
      baseAudit?.newestObservedAt ?? parsedCheckpoint.newestObservedAt;
    const cumulativeOldestObservedAt =
      parsedCheckpoint.oldestObservedAt ?? baseAudit?.oldestObservedAt;
    active.checkpoint = {
      mode: parsedCheckpoint.mode,
      pagesFetched: basePagesFetched + parsedCheckpoint.pagesFetched,
      exhausted: parsedCheckpoint.exhausted,
      ...(parsedCheckpoint.cursor ? { cursor: parsedCheckpoint.cursor } : {}),
      ...(cumulativeNewestObservedAt
        ? { newestObservedAt: cumulativeNewestObservedAt }
        : {}),
      ...(cumulativeOldestObservedAt
        ? { oldestObservedAt: cumulativeOldestObservedAt }
        : {}),
    };
    active.audit = {
      mode: parsedAudit.mode,
      pagesFetched: basePagesFetched + parsedAudit.pagesFetched,
      observed: (baseAudit?.observed ?? 0) + parsedAudit.observed,
      qualifying: (baseAudit?.qualifying ?? 0) + parsedAudit.qualifying,
      exactDuplicates: (baseAudit?.exactDuplicates ?? 0) + parsedAudit.exactDuplicates,
      semanticDuplicates: (baseAudit?.semanticDuplicates ?? 0) + parsedAudit.semanticDuplicates,
      filtered: (baseAudit?.filtered ?? 0) + parsedAudit.filtered,
      knownComplete: (baseAudit?.knownComplete ?? 0) + parsedAudit.knownComplete,
      repaired: (baseAudit?.repaired ?? 0) + parsedAudit.repaired,
      saved: (baseAudit?.saved ?? 0) + parsedAudit.saved,
      failed: (baseAudit?.failed ?? 0) + parsedAudit.failed,
      exhausted: parsedAudit.exhausted,
      safetyCapReached: parsedAudit.safetyCapReached,
      completedDays: parsedAudit.completedDays,
      emptyDays: parsedAudit.emptyDays,
      failedDays: parsedAudit.failedDays,
      ...(cumulativeNewestObservedAt
        ? { newestObservedAt: cumulativeNewestObservedAt }
        : {}),
      ...(parsedAudit.oldestObservedAt ?? baseAudit?.oldestObservedAt
        ? { oldestObservedAt: parsedAudit.oldestObservedAt ?? baseAudit!.oldestObservedAt! }
        : {}),
    };
    active.processedPages.push(pageKey);
    await atomicWrite(this.path, this.value);
  }

  async finalize(
    batchId: string,
    attempt: CollectionPlanAttempt,
    outcome: { status: BatchStatus; errorCode?: string },
  ): Promise<ZsxqOwnerAudit | undefined> {
    const active = this.requireActive(batchId, attempt);
    const today = shanghaiDay(this.now());
    const yesterday = shiftDay(today, -1);
    const checkedAt = this.now();
    let daysToFinalize = [...active.targetDays];
    if (active.mode === 'owner-history' && outcome.status === 'completed') {
      if (
        active.checkpoint?.exhausted !== true
        || active.audit?.exhausted !== true
        || active.audit.safetyCapReached
        || active.audit.failed > 0
        || !active.audit.oldestObservedAt
      ) throw new Error('知识星球历史审计未证明安全耗尽');
      const oldestDay = shanghaiDay(active.audit.oldestObservedAt);
      daysToFinalize = [];
      for (let day = oldestDay; day <= yesterday; day = shiftDay(day, 1)) {
        daysToFinalize.push(day);
      }
      this.value.coverageStartDay = oldestDay;
      this.value.lastHistoryAudit = {
        batchId,
        attempt,
        itemFacts: [...new Map(
          Object.values(active.drafts)
            .flatMap(draft => draft.itemFacts ?? [])
            .map(fact => [`${fact.url}:${fact.outcome}:${fact.mappedUrl}`, fact]),
        ).values()],
      };
    }
    let completedDays = 0;
    let emptyDays = 0;
    let failedDays = 0;
    for (const day of daysToFinalize) {
      if (day >= today) continue;
      const observedDraft = active.drafts[day];
      const draft = observedDraft ?? (active.mode === 'owner-history'
        ? {
            day,
            rawOwnerCount: 0,
            qualifyingCount: 0,
            filteredCount: 0,
            exactDuplicateCount: 0,
            semanticDuplicateCount: 0,
            knownCompleteCount: 0,
            repairCount: 0,
            candidateCount: 0,
            savedCount: 0,
            failedCount: 0,
            crossedDayBoundary: true,
          }
        : undefined);
      const completed = outcome.status === 'completed'
        && draft?.crossedDayBoundary === true
        && draft.failedCount === 0;
      const base = draft ?? {
        day,
        rawOwnerCount: 0,
        qualifyingCount: 0,
        filteredCount: 0,
        exactDuplicateCount: 0,
        semanticDuplicateCount: 0,
        knownCompleteCount: 0,
        repairCount: 0,
        candidateCount: 0,
        savedCount: 0,
        failedCount: 1,
        crossedDayBoundary: false,
      };
      const status: ZsxqDayStatus = completed
        ? base.qualifyingCount > 0 ? 'completed_content' : 'completed_empty'
        : 'failed';
      this.value.days[day] = {
        ...base,
        status,
        checkedAt,
        batchId,
        attemptToken: attempt,
        ...(!completed && outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      };
      if (status === 'completed_content') completedDays += 1;
      else if (status === 'completed_empty') emptyDays += 1;
      else failedDays += 1;
    }
    if (active.audit) {
      active.audit = { ...active.audit, completedDays, emptyDays, failedDays };
    }
    if (outcome.status === 'completed') delete this.value.active;
    await atomicWrite(this.path, this.value);
    return active.audit ? { ...active.audit } : undefined;
  }

  private requireActive(batchId: string, attempt: CollectionPlanAttempt): ActiveOwnerRun {
    const active = this.value.active;
    if (!active || active.batchId !== batchId || active.attempt !== attempt) {
      throw new Error('知识星球逐日账本尝试已过期');
    }
    return active;
  }
}
