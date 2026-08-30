import {
  NOWCODER_DIRECTED_REJECTION_MESSAGES,
  NOWCODER_DIRECTED_SELECTION_ATTENTION_MESSAGES,
  stableContentId,
  type JobRecord,
  type NowcoderDirectedAttentionCode,
  type NowcoderDirectedProgress,
  type NowcoderDirectedRejectionCode,
  type PrivateNowcoderDeliveryItem,
} from '@data-collector/shared';
import {
  filterProcessedNowcoderDocuments,
  historyFromSnapshot,
  loadStrictProcessedNowcoderHistory,
  processedNowcoderHistoryDigest,
  type ProcessedNowcoderHistorySnapshot,
  StrictNowcoderHistoryError,
} from '../plans/nowcoderProcessedHistory.js';
import { selectNowcoderPlanCandidates } from '../plans/nowcoderPlan.js';
import {
  loadNowcoderDirectedDocuments,
  NowcoderDirectedDocumentError,
} from './documentLoader.js';
import type {
  NowcoderDirectedReconciliationContext,
  NowcoderDirectedSelectionRecoveryResult,
  NowcoderDirectedService,
} from './service.js';
import type { NowcoderDirectedStore } from './store.js';
import { nowcoderDirectedJobId } from './jobIdentity.js';

export interface NowcoderDirectedFillState {
  target: number;
  candidateCursor: number;
  frozenCandidateCount: number;
  currentRoundTerminal: boolean;
  acceptedCount: number;
}

export type NowcoderDirectedFillAction =
  | { type: 'wait' }
  | { type: 'enqueue'; count: number }
  | { type: 'stage' }
  | { type: 'attention' };

/** Pure persisted-checkpoint decision used identically by live selection and restart recovery. */
export function nextNowcoderDirectedFillAction(
  state: NowcoderDirectedFillState,
): NowcoderDirectedFillAction {
  if (!Number.isInteger(state.target) || state.target < 1 || state.target > 10) {
    throw new RangeError('目标数量必须在 1–10 之间');
  }
  if (!state.currentRoundTerminal) return { type: 'wait' };
  if (state.candidateCursor === 0) {
    const count = Math.min(8, state.frozenCandidateCount, 24);
    return count > 0 ? { type: 'enqueue', count } : { type: 'attention' };
  }
  if (state.acceptedCount === state.target) return { type: 'stage' };
  if (state.acceptedCount > state.target) throw new Error('定向筛选接受数量超过目标');
  const remaining = Math.min(24, state.frozenCandidateCount) - state.candidateCursor;
  return remaining > 0
    ? { type: 'enqueue', count: Math.min(4, remaining) }
    : { type: 'attention' };
}

const ATTENTION_MESSAGES: Record<Extract<NowcoderDirectedAttentionCode,
  | 'DIRECTED_LOCAL_LIBRARY_CORRUPT'
  | 'DIRECTED_CANDIDATE_CATALOG_CORRUPT'
  | 'DIRECTED_HISTORY_CORRUPT'
  | 'DIRECTED_HISTORY_LIMIT_EXCEEDED'
  | 'DIRECTED_SELECTION_INVARIANT_FAILED'
  | 'DIRECTED_TARGET_UNAVAILABLE'>, string> = {
  ...NOWCODER_DIRECTED_SELECTION_ATTENTION_MESSAGES,
};

function companies(
  coverage: Record<'bytedance' | 'tencent' | 'alibaba' | 'ant' | 'other', number>,
): NowcoderDirectedProgress['companies'] {
  return (['bytedance', 'tencent', 'alibaba', 'ant', 'other'] as const)
    .map(company => ({ company, count: coverage[company] }));
}

function counts(codes: readonly NowcoderDirectedRejectionCode[]): NowcoderDirectedProgress['rejectionCounts'] {
  const byCode = new Map<NowcoderDirectedRejectionCode, number>();
  for (const code of codes) byCode.set(code, (byCode.get(code) ?? 0) + 1);
  return [...byCode.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([code, count]) => ({ code, message: NOWCODER_DIRECTED_REJECTION_MESSAGES[code], count }));
}

function terminalCode(job: JobRecord): NowcoderDirectedRejectionCode {
  if (job.status === 'failed') return 'DETAIL_FAILED';
  if (job.status === 'needs_attention') return 'DETAIL_NEEDS_ATTENTION';
  return 'DETAIL_NOT_SAVED';
}

export interface NowcoderDirectedSelectionCoordinatorOptions {
  store: NowcoderDirectedStore;
  service: () => NowcoderDirectedService;
  libraryRoot: string;
  targetRoot?: string;
  now?: () => string;
}

export class NowcoderDirectedSelectionCoordinator {
  private readonly now: () => string;

  constructor(private readonly options: NowcoderDirectedSelectionCoordinatorOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async reconcile(
    context: NowcoderDirectedReconciliationContext,
  ): Promise<NowcoderDirectedSelectionRecoveryResult> {
    const run = context.run;
    const currentRoundTerminal = run.currentRoundJobIds.every(id => {
      const job = context.jobs.find(candidate => candidate.id === id);
      return job?.status === 'saved' || job?.status === 'failed' || job?.status === 'needs_attention';
    });
    if (!currentRoundTerminal) return { state: 'paused' };
    if (run.candidateCursor === 0) {
      const action = nextNowcoderDirectedFillAction({
        target: run.spec.target,
        candidateCursor: 0,
        frozenCandidateCount: run.frozenCandidates.length,
        currentRoundTerminal: true,
        acceptedCount: 0,
      });
      if (action.type !== 'enqueue') {
        return await this.finishUnavailable(context, this.emptyProgress(run, 0), []);
      }
      const progress = this.emptyProgress(run, action.count);
      progress.rejectionCounts = counts(Array.from({ length: action.count }, () => 'DETAIL_NOT_SAVED'));
      const initialRejections = run.frozenCandidates.slice(0, action.count).map(candidate => ({
        jobId: nowcoderDirectedJobId(run.id, run.attempt, candidate.canonicalUrl),
        url: candidate.canonicalUrl,
        code: 'DETAIL_NOT_SAVED' as const,
        message: NOWCODER_DIRECTED_REJECTION_MESSAGES.DETAIL_NOT_SAVED,
        detail: NOWCODER_DIRECTED_REJECTION_MESSAGES.DETAIL_NOT_SAVED,
      }));
      const jobs = await this.options.service().enqueueRound(run.id, run.attempt, action.count, {
        progress,
        accepted: 0,
        deliveryItems: [],
        privateRejections: initialRejections,
      });
      return jobs.length === 0 ? { state: 'paused' } : this.committed(run.id, run.attempt);
    }

    const persistenceFailure = context.jobs.find(job =>
      job.errorCode === 'DIRECTED_LOCAL_LIBRARY_CORRUPT'
      || job.errorCode === 'DIRECTED_CANDIDATE_CATALOG_CORRUPT');
    if (persistenceFailure?.errorCode === 'DIRECTED_LOCAL_LIBRARY_CORRUPT'
      || persistenceFailure?.errorCode === 'DIRECTED_CANDIDATE_CATALOG_CORRUPT') {
      return await this.finishSystemic(context, persistenceFailure.errorCode);
    }

    let snapshot: ProcessedNowcoderHistorySnapshot;
    try {
      if (run.historySnapshot || run.historyDigest) {
        if (!run.historySnapshot || !run.historyDigest
          || processedNowcoderHistoryDigest(run.historySnapshot) !== run.historyDigest) {
          throw new StrictNowcoderHistoryError('DIRECTED_HISTORY_CORRUPT');
        }
        snapshot = run.historySnapshot;
      } else {
        if (!this.options.targetRoot) {
          return await this.finishSystemic(context, 'DIRECTED_SELECTION_INVARIANT_FAILED');
        }
        const loaded = await loadStrictProcessedNowcoderHistory(this.options.targetRoot);
        const persisted = await this.options.store.persistHistorySnapshotCurrent(
          run.id, run.attempt, loaded.snapshot, loaded.digest,
        );
        if (processedNowcoderHistoryDigest(persisted.snapshot) !== persisted.digest) {
          throw new StrictNowcoderHistoryError('DIRECTED_HISTORY_CORRUPT');
        }
        snapshot = persisted.snapshot;
      }
    } catch (error) {
      const code = error instanceof StrictNowcoderHistoryError
        ? error.code
        : 'DIRECTED_HISTORY_CORRUPT';
      return await this.finishSystemic(context, code);
    }

    let loaded;
    try {
      loaded = await loadNowcoderDirectedDocuments({
        libraryRoot: this.options.libraryRoot,
        run,
        jobs: context.jobs,
      });
    } catch (error) {
      const code = error instanceof NowcoderDirectedDocumentError
        ? error.code
        : 'DIRECTED_LOCAL_LIBRARY_CORRUPT';
      return await this.finishSystemic(context, code);
    }

    let processed;
    let selection;
    try {
      processed = filterProcessedNowcoderDocuments(
        loaded.loaded.map(item => item.document),
        historyFromSnapshot(snapshot),
      );
      selection = selectNowcoderPlanCandidates(
        processed.eligible,
        run.buildEvidence.frozenAt,
        run.spec.target,
        'latest-search',
      );
    } catch {
      return await this.finishSystemic(context, 'DIRECTED_SELECTION_INVARIANT_FAILED');
    }
    const acceptedUrls = new Set(selection.accepted.map(document => document.canonicalUrl));
    const invalidByJob = new Map(loaded.invalid.map(item => [item.job.id, item.detail]));
    const historyRejected = new Set(processed.rejected.map(item => item.url));
    const selectorRejected = new Map(selection.structuredRejected.map(item => [item.url, item.code]));
    const codesByJob = new Map<string, NowcoderDirectedRejectionCode>();
    const privateRejections: Array<{
      jobId: string;
      url: string;
      code: NowcoderDirectedRejectionCode;
      message: string;
      detail: string;
    }> = [];
    for (const job of context.jobs) {
      if (acceptedUrls.has(job.url)) continue;
      const code = invalidByJob.has(job.id)
        ? 'LOCAL_SNAPSHOT_INVALID'
        : historyRejected.has(job.url)
          ? 'SOURCE_HISTORY_DUPLICATE'
          : selectorRejected.get(job.url) ?? terminalCode(job);
      codesByJob.set(job.id, code);
      privateRejections.push({
        jobId: job.id,
        url: job.url,
        code,
        message: NOWCODER_DIRECTED_REJECTION_MESSAGES[code],
        detail: invalidByJob.get(job.id) ?? NOWCODER_DIRECTED_REJECTION_MESSAGES[code],
      });
    }
    const progress: NowcoderDirectedProgress = {
      discovered: run.frozenCandidates.length,
      detailScheduled: run.candidateCursor,
      detailSaved: loaded.detailSaved,
      inspected: loaded.loaded.length,
      qualified: selection.qualifiedCount,
      accepted: selection.accepted.length,
      delivered: 0,
      rejectionCounts: counts([...codesByJob.values()]),
      companies: companies(selection.coverage),
    };
    const action = nextNowcoderDirectedFillAction({
      target: run.spec.target,
      candidateCursor: run.candidateCursor,
      frozenCandidateCount: run.frozenCandidates.length,
      currentRoundTerminal: true,
      acceptedCount: selection.accepted.length,
    });
    if (action.type === 'stage') {
      if (!await this.options.service().guardBoundary(run.id, run.attempt, 'before-staging')) {
        return { state: 'paused' };
      }
      let revalidatedLoaded;
      let revalidatedProcessed;
      let revalidatedSelection;
      try {
        revalidatedLoaded = await loadNowcoderDirectedDocuments({
          libraryRoot: this.options.libraryRoot,
          run,
          jobs: context.jobs,
        });
        revalidatedProcessed = filterProcessedNowcoderDocuments(
          revalidatedLoaded.loaded.map(item => item.document),
          historyFromSnapshot(snapshot),
        );
        revalidatedSelection = selectNowcoderPlanCandidates(
          revalidatedProcessed.eligible,
          run.buildEvidence.frozenAt,
          run.spec.target,
          'latest-search',
        );
      } catch (error) {
        if (error instanceof NowcoderDirectedDocumentError) {
          return await this.finishSystemic(context, error.code);
        }
        return await this.finishSystemic(context, 'DIRECTED_SELECTION_INVARIANT_FAILED');
      }
      if (!this.sameAcceptedSelection(selection.accepted, revalidatedSelection.accepted)) {
        return { state: 'paused' };
      }
      const revalidatedAcceptedUrls = new Set(
        revalidatedSelection.accepted.map(document => document.canonicalUrl),
      );
      const revalidatedInvalidByJob = new Map(
        revalidatedLoaded.invalid.map(item => [item.job.id, item.detail]),
      );
      const revalidatedHistoryRejected = new Set(
        revalidatedProcessed.rejected.map(item => item.url),
      );
      const revalidatedSelectorRejected = new Map(
        revalidatedSelection.structuredRejected.map(item => [item.url, item.code]),
      );
      const revalidatedCodes: NowcoderDirectedRejectionCode[] = [];
      const revalidatedPrivateRejections = [] as typeof privateRejections;
      for (const job of context.jobs) {
        if (revalidatedAcceptedUrls.has(job.url)) continue;
        const code = revalidatedInvalidByJob.has(job.id)
          ? 'LOCAL_SNAPSHOT_INVALID'
          : revalidatedHistoryRejected.has(job.url)
            ? 'SOURCE_HISTORY_DUPLICATE'
            : revalidatedSelectorRejected.get(job.url) ?? terminalCode(job);
        revalidatedCodes.push(code);
        revalidatedPrivateRejections.push({
          jobId: job.id,
          url: job.url,
          code,
          message: NOWCODER_DIRECTED_REJECTION_MESSAGES[code],
          detail: revalidatedInvalidByJob.get(job.id) ?? NOWCODER_DIRECTED_REJECTION_MESSAGES[code],
        });
      }
      const revalidatedProgress: NowcoderDirectedProgress = {
        discovered: run.frozenCandidates.length,
        detailScheduled: run.candidateCursor,
        detailSaved: revalidatedLoaded.detailSaved,
        inspected: revalidatedLoaded.loaded.length,
        qualified: revalidatedSelection.qualifiedCount,
        accepted: revalidatedSelection.accepted.length,
        delivered: 0,
        rejectionCounts: counts(revalidatedCodes),
        companies: companies(revalidatedSelection.coverage),
      };
      let items: PrivateNowcoderDeliveryItem[];
      try {
        items = this.deliveryItems(context, revalidatedSelection.accepted);
      } catch {
        return await this.finishSystemic(context, 'DIRECTED_SELECTION_INVARIANT_FAILED');
      }
      if (items.length !== run.spec.target || !this.uniqueItems(items)) {
        return await this.finishSystemic(context, 'DIRECTED_SELECTION_INVARIANT_FAILED');
      }
      await this.options.store.checkpointCurrentRun(run.id, run.attempt, {
        phase: 'staging',
        progress: revalidatedProgress,
        accepted: items.length,
        deliveryItems: items,
        privateRejections: revalidatedPrivateRejections,
      });
      return this.committed(run.id, run.attempt);
    }
    if (action.type === 'enqueue') {
      const futureCount = run.candidateCursor + action.count;
      const futureCodes = [
        ...codesByJob.values(),
        ...Array.from({ length: action.count }, () => 'DETAIL_NOT_SAVED' as const),
      ];
      const refillProgress = {
        ...progress,
        detailScheduled: futureCount,
        rejectionCounts: counts(futureCodes),
      };
      const futureRejections = [...privateRejections];
      for (const candidate of run.frozenCandidates.slice(run.candidateCursor, futureCount)) {
        futureRejections.push({
          jobId: nowcoderDirectedJobId(run.id, run.attempt, candidate.canonicalUrl),
          url: candidate.canonicalUrl,
          code: 'DETAIL_NOT_SAVED',
          message: NOWCODER_DIRECTED_REJECTION_MESSAGES.DETAIL_NOT_SAVED,
          detail: NOWCODER_DIRECTED_REJECTION_MESSAGES.DETAIL_NOT_SAVED,
        });
      }
      const jobs = await this.options.service().enqueueRound(run.id, run.attempt, action.count, {
        progress: refillProgress,
        accepted: selection.accepted.length,
        deliveryItems: [],
        privateRejections: futureRejections,
      });
      return jobs.length === 0 ? { state: 'paused' } : this.committed(run.id, run.attempt);
    }
    return await this.finishUnavailable(context, progress, privateRejections);
  }

  private emptyProgress(
    run: NowcoderDirectedReconciliationContext['run'],
    detailScheduled: number,
  ): NowcoderDirectedProgress {
    return {
      discovered: run.frozenCandidates.length,
      detailScheduled,
      detailSaved: 0,
      inspected: 0,
      qualified: 0,
      accepted: 0,
      delivered: 0,
      rejectionCounts: [],
      companies: companies({ bytedance: 0, tencent: 0, alibaba: 0, ant: 0, other: 0 }),
    };
  }

  private deliveryItems(
    context: NowcoderDirectedReconciliationContext,
    accepted: readonly { canonicalUrl: string; source: string; feJourney?: { contentHash: string; clusterId: string } }[],
  ): PrivateNowcoderDeliveryItem[] {
    const jobsByUrl = new Map(context.jobs.map(job => [job.url, job]));
    return accepted.map(document => {
      const job = jobsByUrl.get(document.canonicalUrl);
      if (!job || job.status !== 'saved' || job.directedRunId !== context.run.id
        || job.directedRunAttempt !== context.run.attempt || document.source !== 'nowcoder'
        || !document.feJourney?.contentHash || !document.feJourney.clusterId
        || job.id !== nowcoderDirectedJobId(context.run.id, context.run.attempt, document.canonicalUrl)) {
        throw new Error('定向筛选交付身份无效');
      }
      return {
        jobId: job.id,
        stableContentId: stableContentId(document.canonicalUrl),
        canonicalUrl: document.canonicalUrl,
        contentHash: document.feJourney.contentHash,
        clusterId: document.feJourney.clusterId,
      };
    });
  }

  private uniqueItems(items: readonly PrivateNowcoderDeliveryItem[]): boolean {
    return (['stableContentId', 'canonicalUrl', 'clusterId'] as const)
      .every(key => new Set(items.map(item => item[key])).size === items.length);
  }

  private sameAcceptedSelection(
    left: readonly { canonicalUrl: string; feJourney?: { contentHash: string; clusterId: string } }[],
    right: readonly { canonicalUrl: string; feJourney?: { contentHash: string; clusterId: string } }[],
  ): boolean {
    return left.length === right.length && left.every((document, index) => {
      const candidate = right[index];
      return candidate?.canonicalUrl === document.canonicalUrl
        && candidate.feJourney?.contentHash === document.feJourney?.contentHash
        && candidate.feJourney?.clusterId === document.feJourney?.clusterId;
    });
  }

  private async finishSystemic(
    context: NowcoderDirectedReconciliationContext,
    code: Exclude<keyof typeof ATTENTION_MESSAGES, 'DIRECTED_TARGET_UNAVAILABLE'>,
  ): Promise<NowcoderDirectedSelectionRecoveryResult> {
    const result = await this.options.service().finalizeAttention(context.run.id, context.run.attempt, {
      code,
      message: ATTENTION_MESSAGES[code],
      at: this.now(),
      phase: context.run.phase,
    });
    return { state: 'committed', checkpointFingerprint: result.checkpointFingerprint };
  }

  private async finishUnavailable(
    context: NowcoderDirectedReconciliationContext,
    progress: NowcoderDirectedProgress,
    privateRejections: Array<{
      jobId: string;
      url: string;
      code: NowcoderDirectedRejectionCode;
      message: string;
      detail: string;
    }>,
  ): Promise<NowcoderDirectedSelectionRecoveryResult> {
    const result = await this.options.service().finalizeSelectionAttention(
      context.run.id,
      context.run.attempt,
      {
        code: 'DIRECTED_TARGET_UNAVAILABLE',
        message: ATTENTION_MESSAGES.DIRECTED_TARGET_UNAVAILABLE,
        at: this.now(),
        phase: 'selecting',
      },
      { progress, accepted: progress.accepted, privateRejections },
    );
    return { state: 'committed', checkpointFingerprint: result.checkpointFingerprint };
  }

  private committed(
    runId: string,
    attempt: NowcoderDirectedReconciliationContext['run']['attempt'],
  ): NowcoderDirectedSelectionRecoveryResult {
    const checkpointFingerprint = this.options.store.selectionCheckpointFingerprint(runId, attempt);
    if (!checkpointFingerprint) throw new Error('定向筛选检查点不存在');
    return { state: 'committed', checkpointFingerprint };
  }
}
