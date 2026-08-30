import {
  NOWCODER_DETAIL_CAPABILITY,
  NOWCODER_DIRECTED_REJECTION_MESSAGES,
  ZSXQ_COMPLETE_CONTENT_CAPABILITY,
  nowcoderDirectedBuildEvidenceSchema,
  type JobRecord,
  type NowcoderDirectedAttentionCode,
  type NowcoderDirectedBuildEvidence,
  type NowcoderDirectedRetryRequest,
  type NowcoderDirectedRunAttempt,
  type NowcoderDirectedStartRequest,
  type PublicNowcoderDirectedRun,
  type NowcoderDirectedProgress,
  type NowcoderDirectedAttentionReason,
  type NowcoderDirectedRejectionCode,
} from '@data-collector/shared';
import { nowcoderDirectedJobId } from './jobIdentity.js';
import type {
  ArtifactReaderCoordinatorLike,
  ArtifactReaderHandle,
} from '../artifactReaderCoordinator.js';
import type { JobStore } from '../jobs/store.js';
import {
  type NowcoderDirectedMutationResult,
  type NowcoderDirectedReconciliationSnapshot,
  type NowcoderDirectedTabClearKind,
  type NowcoderDirectedStore,
  type NowcoderDirectedRunCheckpoint,
} from './store.js';

const TERMINAL_JOB_STATUSES = new Set(['saved', 'failed', 'needs_attention']);
const REQUIRED_CAPABILITIES = [NOWCODER_DETAIL_CAPABILITY, ZSXQ_COMPLETE_CONTENT_CAPABILITY]
  .sort((left, right) => left.localeCompare(right));
const SERVICE_CLOSED_MESSAGE = '牛客定向服务已关闭';
const SERVICE_CLOSE_FAILED_MESSAGE = '牛客定向服务未能安全关闭';

export type NowcoderDirectedBoundary =
  | 'new-start'
  | 'new-retry'
  | 'extension-hello'
  | 'restart-recovery'
  | 'before-dispatch'
  | 'before-job-collect-send'
  | 'before-progress'
  | 'before-result'
  | 'before-result-save'
  | 'before-error'
  | 'before-refill'
  | 'before-selection'
  | 'before-staging'
  | 'before-publisher-recovery';

export interface NowcoderDirectedLiveEvidence {
  applicationVersion: string;
  bridgeBuildId?: string;
  artifactBuildId?: string;
  extensionOnline: boolean;
  extensionVersion?: string;
  extensionBuildId?: string;
  extensionRuntimeId?: string;
  extensionCapabilities?: string[];
  observedAt: string;
}

export class NowcoderDirectedBoundaryError extends Error {
  override readonly name = 'NowcoderDirectedBoundaryError';
  readonly status = 409;

  constructor(
    public readonly code: NowcoderDirectedAttentionCode,
    message: string,
  ) {
    super(message);
  }

  toJSON(): { name: string; code: NowcoderDirectedAttentionCode; status: number; message: string } {
    return { name: this.name, code: this.code, status: this.status, message: this.message };
  }
}

export interface NowcoderDirectedReconciliationContext {
  run: NowcoderDirectedReconciliationSnapshot;
  jobs: JobRecord[];
  signal?: AbortSignal;
}

export interface NowcoderDirectedMarkerProbeContext {
  run: NowcoderDirectedReconciliationSnapshot;
}

export type NowcoderDirectedPublisherRecoveryContext =
  | (NowcoderDirectedMarkerProbeContext & { markerVerified: true })
  | (NowcoderDirectedReconciliationContext & { markerVerified: false });

export type NowcoderDirectedSelectionRecoveryResult =
  | { state: 'paused' }
  | { state: 'committed'; checkpointFingerprint: string };

export interface NowcoderDirectedServiceDependencies {
  store: NowcoderDirectedStore;
  jobs: JobStore;
  dispatch: (job: JobRecord) => Promise<void>;
  /** Send an exact tuple cancellation frame; the service calls this only after intent is durable. */
  sendCancel?: (job: JobRecord) => Promise<void>;
  /** Republish job.saved/job.failed only after the JobStore transition is durable. */
  acknowledgeTerminal?: (job: JobRecord) => Promise<void>;
  /** Ask the extension to replay its cached terminal for an exact job whose close proof is durable. */
  replayProvenTerminal?: (job: JobRecord) => Promise<void>;
  /** Task 7 replaces this provisional exact-proof predicate with authoritative telemetry. */
  ownedTabsClear?: (run: NowcoderDirectedReconciliationSnapshot) => Promise<boolean>;
  /** Server-owned sink/index writes must finish before reconnect recovery can touch their jobs. */
  isPersistenceInFlight?: (jobId: string) => boolean;
  /** Task 5 supplies deterministic selection/fill; this service only invokes its recovery seam. */
  reconcileSelection?: (
    context: NowcoderDirectedReconciliationContext,
  ) => Promise<NowcoderDirectedSelectionRecoveryResult | void>;
  /** Task 8 supplies exact staging/publisher recovery; this service only invokes its seam. */
  recoverPublisher?: (context: NowcoderDirectedPublisherRecoveryContext) => Promise<void>;
  /** Task 8 verifies the already-linearized marker before any generic live-build gate. */
  probeVerifiedMarker?: (context: NowcoderDirectedMarkerProbeContext) => Promise<boolean>;
  /** Report committed-run recovery failure without exposing the underlying private error. */
  reportRecoveryFailure?: (error: {
    code: 'DIRECTED_RECOVERY_FAILED';
    message: string;
  }) => void;
  artifactReaders?: ArtifactReaderCoordinatorLike;
  liveEvidence?: () => Promise<NowcoderDirectedLiveEvidence>;
  now?: () => string;
}

function childId(runId: string, attempt: NowcoderDirectedRunAttempt, url: string): string {
  return nowcoderDirectedJobId(runId, attempt, url);
}

function isTerminalJob(job: JobRecord | undefined): boolean {
  return Boolean(job && TERMINAL_JOB_STATUSES.has(job.status));
}

function runKey(runId: string, attempt: NowcoderDirectedRunAttempt): string {
  return `${runId}\u0000${attempt}`;
}

function exactStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export class NowcoderDirectedService {
  private reconciliationQueue: Promise<void> = Promise.resolve();
  private readonly activeOperations = new Set<Promise<unknown>>();
  private readonly releaseFlights = new Set<Promise<void>>();
  private readonly completedSelectionRecoveries = new Set<string>();
  private readonly completedPublisherRecoveries = new Set<string>();
  private readonly verifiedMarkerRecoveries = new Set<string>();
  private readonly publisherDecisionFlights = new Map<string, Promise<void>>();
  private readonly runReaders = new Map<string, ArtifactReaderHandle>();
  private readonly runMutationQueues = new Map<string, Promise<void>>();
  private readonly runAbortControllers = new Map<string, AbortController>();
  private readonly runCancellableOperations = new Map<string, Set<Promise<unknown>>>();
  private readonly closedError = new Error(SERVICE_CLOSED_MESSAGE);
  private readonly closeFailedError = new Error(SERVICE_CLOSE_FAILED_MESSAGE);
  private releaseFailed = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly dependencies: NowcoderDirectedServiceDependencies) {}

  hasActiveRun(): boolean {
    return this.dependencies.store.hasActiveRun();
  }

  initialize(): Promise<void> {
    if (this.closed) return Promise.reject(this.closedError);
    return this.trackOperation((async () => {
      await this.dependencies.jobs.reconcileDirectedPins(
        this.dependencies.store.reconciliationSnapshots().map(snapshot => ({
          runId: snapshot.id,
          attempt: snapshot.attempt,
          jobIds: snapshot.currentJobIds,
        })),
      );
      await this.reconcileAll();
    })());
  }

  async observeExtensionEvidence(): Promise<void> {
    this.assertOpen();
    await this.trackOperation((async () => {
      for (const snapshot of this.dependencies.store.reconciliationSnapshots()) {
        if (this.closed) return;
        if (snapshot.status === 'cancelling') {
          await this.ensureRunReader(snapshot);
          await this.reconcileCancellation(snapshot);
          continue;
        }
        if (snapshot.status === 'publishing'
          || (snapshot.status === 'running' && snapshot.phase === 'staging')) {
          await this.reconcilePublisherDecision(snapshot.id, snapshot.attempt);
          continue;
        }
        if (snapshot.status !== 'running') continue;
        await this.ensureRunReader(snapshot);
        if (this.closed) return;
        if (this.currentSnapshot(snapshot.id, snapshot.attempt)) {
          await this.guardBoundary(snapshot.id, snapshot.attempt, 'extension-hello');
        }
      }
    })());
  }

  async startRun(request: NowcoderDirectedStartRequest): Promise<NowcoderDirectedMutationResult> {
    this.assertOpen();
    return await this.trackOperation((async () => {
      const replay = await this.dependencies.store.findStartReplay(request);
      this.assertOpen();
      if (replay) return { run: replay, created: false };
      return await this.createAttempt(async evidence =>
        this.dependencies.store.startRunAtomic(request, evidence));
    })());
  }

  async retryRun(
    sourceRunId: string,
    request: NowcoderDirectedRetryRequest,
  ): Promise<NowcoderDirectedMutationResult> {
    this.assertOpen();
    return await this.trackOperation((async () => {
      const replay = await this.dependencies.store.findRetryReplay(sourceRunId, request);
      this.assertOpen();
      if (replay) return { run: replay, created: false };
      return await this.createAttempt(async evidence =>
        this.dependencies.store.retryRunAtomic(sourceRunId, request, evidence));
    })());
  }

  ownsCurrentJob(job: JobRecord): boolean {
    if (this.closed) return false;
    if (!job.directedRunId || !job.directedRunAttempt) return false;
    const snapshot = this.currentSnapshot(job.directedRunId, job.directedRunAttempt);
    return Boolean(snapshot && this.isOwnedBySnapshot(snapshot, job));
  }

  acceptsResult(job: JobRecord): boolean {
    if (this.closed) return false;
    if (!job.directedRunId || !job.directedRunAttempt) return false;
    const snapshot = this.currentSnapshot(job.directedRunId, job.directedRunAttempt);
    return Boolean(
      snapshot
      && snapshot.status === 'running'
      && snapshot.phase === 'collecting'
      && this.isOwnedBySnapshot(snapshot, job)
      && snapshot.currentRoundJobIds.includes(job.id),
    );
  }

  canDispatch(job: JobRecord): boolean {
    return !this.closed && job.status === 'queued' && this.acceptsResult(job);
  }

  /**
   * Linearized final send boundary. Recording dispatch and putting the collect frame on the
   * socket share the same per-run queue as cancellation intent, so whichever enters first wins.
   */
  async dispatchCurrent(job: JobRecord, sendFrame: () => void): Promise<boolean> {
    this.assertOpen();
    if (!job.directedRunId || !job.directedRunAttempt) return false;
    return await this.serializeRun(job.directedRunId, job.directedRunAttempt, async () => {
      const snapshot = this.currentSnapshot(job.directedRunId!, job.directedRunAttempt!);
      if (!snapshot
        || snapshot.status !== 'running'
        || snapshot.phase !== 'collecting'
        || !this.isOwnedBySnapshot(snapshot, job)
        || !snapshot.currentRoundJobIds.includes(job.id)) return false;
      await this.dependencies.store.recordDispatchedJobCurrent(
        snapshot.id,
        snapshot.attempt,
        job.id,
      );
      const current = this.currentSnapshot(snapshot.id, snapshot.attempt);
      if (!current || current.status !== 'running') return false;
      sendFrame();
      return true;
    });
  }

  async cancelRun(
    runId: string,
    attempt: NowcoderDirectedRunAttempt,
  ): Promise<PublicNowcoderDirectedRun> {
    this.assertOpen();
    return await this.trackOperation((async () => {
      // Only the intent/cutoff occupies the per-run mutation queue. Holding that queue while
      // awaiting the cancellable-operation barrier would deadlock an operation already waiting
      // at dispatchCurrent; once intent is durable, every later queued send observes cancelling.
      const intent = await this.serializeRun(runId, attempt, async () => {
        const publicRun = this.dependencies.store.getRun(runId);
        if (!publicRun || publicRun.attempt !== attempt) throw new Error('定向运行尝试已过期');
        if (publicRun.status === 'cancelled') return publicRun;
        return await this.dependencies.store.beginCancellationCurrent(runId, attempt);
      });
      if (intent.status === 'cancelled') return intent;
      const beforeBarrier = this.currentSnapshot(runId, attempt);
      if (!beforeBarrier) {
        const terminal = this.dependencies.store.getRun(runId);
        if (terminal?.attempt === attempt && terminal.status === 'cancelled') return terminal;
        throw new Error('定向运行取消状态丢失');
      }
      await this.ensureRunReader(beforeBarrier);
      this.abortRunOperations(runId, attempt);
      await this.waitForRunOperations(runId, attempt);
      const current = this.currentSnapshot(runId, attempt);
      if (!current) {
        const terminal = this.dependencies.store.getRun(runId);
        if (terminal?.attempt === attempt && terminal.status === 'cancelled') return terminal;
        throw new Error('定向运行取消状态丢失');
      }
      return await this.reconcileCancellation(current);
    })());
  }

  async reconcileCancellation(
    snapshot: NowcoderDirectedReconciliationSnapshot,
  ): Promise<PublicNowcoderDirectedRun> {
    this.assertOpen();
    return await this.trackOperation(this.serializeRun(snapshot.id, snapshot.attempt, async () => {
      const current = this.requireCurrentSnapshot(snapshot.id, snapshot.attempt);
      if (current.status !== 'cancelling') throw new Error('定向运行不在取消中');
      return await this.reconcileCancellationUnlocked(current);
    }));
  }

  /**
   * Extension terminal frames are close evidence while cancelling, never collected content.
   * Evidence is durable before the JobStore terminal and the acknowledgement comes last.
   */
  async onCancellationTerminal(
    job: JobRecord,
    kind: Exclude<NowcoderDirectedTabClearKind, 'never_dispatched'>,
  ): Promise<boolean> {
    this.assertOpen();
    if (!job.directedRunId || !job.directedRunAttempt) return false;
    if (!this.dependencies.store.ownsAttemptJob(
      job.directedRunId,
      job.directedRunAttempt,
      job.id,
      job.url,
    )) return false;
    return await this.trackOperation(this.serializeRun(
      job.directedRunId,
      job.directedRunAttempt,
      async () => {
        const publicRun = this.dependencies.store.getRun(job.directedRunId!);
        if (!publicRun || publicRun.attempt !== job.directedRunAttempt) return false;
        if (publicRun.status === 'cancelled') {
          const durable = this.dependencies.jobs.get(job.id);
          if (durable && isTerminalJob(durable)) {
            await this.dependencies.acknowledgeTerminal?.(durable);
            return true;
          }
          return false;
        }
        const snapshot = this.currentSnapshot(job.directedRunId!, job.directedRunAttempt!);
        if (!snapshot || snapshot.status !== 'cancelling') return false;
        await this.dependencies.store.recordTabClearEvidenceCurrent(
          snapshot.id,
          snapshot.attempt,
          job.id,
          kind,
        );
        let durable = this.dependencies.jobs.get(job.id);
        if (!durable) throw new Error('定向任务的 JobStore 证据缺失');
        if (!isTerminalJob(durable)) {
          durable = await this.dependencies.jobs.transition(job.id, 'failed', {
            errorCode: 'CANCELLED',
            errorMessage: '牛客定向采集已取消',
          });
        }
        await this.dependencies.acknowledgeTerminal?.(durable);
        await this.reconcileCancellationUnlocked(
          this.requireCurrentSnapshot(snapshot.id, snapshot.attempt),
        );
        return true;
      },
    ));
  }

  acceptsCancellationTerminal(job: JobRecord): boolean {
    if (this.closed || !job.directedRunId || !job.directedRunAttempt) return false;
    const run = this.dependencies.store.getRun(job.directedRunId);
    return Boolean(
      run
      && run.attempt === job.directedRunAttempt
      && (run.status === 'cancelling' || run.status === 'cancelled')
      && this.dependencies.store.ownsAttemptJob(
        job.directedRunId,
        job.directedRunAttempt,
        job.id,
        job.url,
      )
    );
  }

  async recordRemoteTerminalEvidence(job: JobRecord): Promise<boolean> {
    this.assertOpen();
    if (!job.directedRunId || !job.directedRunAttempt) return false;
    return await this.trackOperation(this.serializeRun(
      job.directedRunId,
      job.directedRunAttempt,
      async () => {
        const snapshot = this.currentSnapshot(job.directedRunId!, job.directedRunAttempt!);
        if (!snapshot
          || snapshot.status !== 'running'
          || snapshot.phase !== 'collecting'
          || !this.isOwnedBySnapshot(snapshot, job)
          || !snapshot.currentRoundJobIds.includes(job.id)) return false;
        await this.dependencies.store.recordTabClearEvidenceCurrent(
          snapshot.id,
          snapshot.attempt,
          job.id,
          'remote_terminal_after_close',
        );
        return true;
      },
    ));
  }

  async guardJobBoundary(job: JobRecord, boundary: NowcoderDirectedBoundary): Promise<boolean> {
    if (!job.directedRunId || !job.directedRunAttempt) return true;
    if (!this.ownsCurrentJob(job)) return false;
    return await this.guardBoundary(job.directedRunId, job.directedRunAttempt, boundary);
  }

  async guardBoundary(
    runId: string,
    attempt: NowcoderDirectedRunAttempt,
    boundary: NowcoderDirectedBoundary,
  ): Promise<boolean> {
    this.assertOpen();
    return await this.trackOperation((async () => {
      let snapshot = this.currentSnapshot(runId, attempt);
      if (!snapshot) return false;
      if (snapshot.status !== 'running' && snapshot.status !== 'publishing') return false;
      if (!this.dependencies.liveEvidence) return true;
      const live = await this.dependencies.liveEvidence();
      if (this.closed) return false;
      snapshot = this.currentSnapshot(runId, attempt);
      if (!snapshot) return false;
      if (snapshot.status !== 'running' && snapshot.status !== 'publishing') return false;
      if (!live.extensionOnline) return false;
      let current: { buildEvidence: NowcoderDirectedBuildEvidence; runtimeId: string };
      try {
        current = this.validateLiveEvidence(live);
      } catch (error) {
        if (!(error instanceof NowcoderDirectedBoundaryError)) throw error;
        if (snapshot.status !== 'running') return false;
        await this.attention(snapshot, error.code, error.message);
        return false;
      }
      const changed = this.compareEvidence(snapshot.buildEvidence, current.buildEvidence);
      if (changed) {
        if (snapshot.status !== 'running') return false;
        await this.attention(snapshot, changed.code, changed.message);
        return false;
      }
      if (snapshot.status === 'running' && !snapshot.observedRuntimeIds.includes(current.runtimeId)) {
        await this.dependencies.store.recordObservedRuntime(snapshot.id, snapshot.attempt, current.runtimeId);
      }
      void boundary;
      return true;
    })());
  }

  async enqueueRound(
    runId: string,
    attempt: NowcoderDirectedRunAttempt,
    requestedCount: number,
    selectionCheckpoint: Pick<
      NowcoderDirectedRunCheckpoint,
      'progress' | 'accepted' | 'deliveryItems' | 'privateRejections'
    > = {},
  ): Promise<JobRecord[]> {
    this.assertOpen();
    return await this.trackOperation(this.runCancellable(runId, attempt, async signal => {
      this.throwIfRunAborted(signal);
      if (!Number.isInteger(requestedCount) || requestedCount < 1) {
        throw new Error('定向采集轮次大小无效');
      }
      if (!(await this.guardBoundary(runId, attempt, 'before-refill'))) return [];
      this.throwIfRunAborted(signal);
      const snapshot = this.requireCurrentSnapshot(runId, attempt);
      if (snapshot.status !== 'running') throw new Error('定向运行当前不可创建采集轮次');
      const remainingBudget = snapshot.spec.maxDetails - snapshot.currentJobIds.length;
      const candidates = snapshot.frozenCandidates.slice(
        snapshot.candidateCursor,
        snapshot.candidateCursor + Math.min(requestedCount, remainingBudget),
      );
      if (candidates.length === 0) return [];
      if (snapshot.phase !== 'collecting' && snapshot.phase !== 'selecting') {
        throw new Error('定向运行当前不可创建采集轮次');
      }
      if (snapshot.currentRoundJobIds.some(id => !isTerminalJob(this.dependencies.jobs.get(id)))) {
        throw new Error('当前采集轮次尚未结束');
      }
      const ids = candidates.map(candidate => childId(snapshot.id, snapshot.attempt, candidate.canonicalUrl));
      const currentJobIds = [...snapshot.currentJobIds, ...ids];
      if (new Set(currentJobIds).size !== currentJobIds.length) {
        throw new Error('定向运行候选生成了重复任务');
      }
      const suppliedCheckpoint = [
        selectionCheckpoint.progress,
        selectionCheckpoint.accepted,
        selectionCheckpoint.deliveryItems,
        selectionCheckpoint.privateRejections,
      ];
      const suppliedCount = suppliedCheckpoint.filter(value => value !== undefined).length;
      if (suppliedCount !== 0 && suppliedCount !== suppliedCheckpoint.length) {
        throw new Error('定向筛选检查点不完整');
      }
      let completeCheckpoint = selectionCheckpoint;
      if (suppliedCount === 0) {
        const baseline = this.selectionBoundaryCheckpoint(snapshot);
        const message = NOWCODER_DIRECTED_REJECTION_MESSAGES.DETAIL_NOT_SAVED;
        const privateRejections = [
          ...(baseline.privateRejections ?? []),
          ...candidates.map((candidate, index) => ({
            jobId: ids[index]!,
            url: candidate.canonicalUrl,
            code: 'DETAIL_NOT_SAVED' as const,
            message,
            detail: message,
          })),
        ];
        const byCode = new Map<NowcoderDirectedRejectionCode, number>();
        for (const rejection of privateRejections) {
          byCode.set(rejection.code, (byCode.get(rejection.code) ?? 0) + 1);
        }
        completeCheckpoint = {
          progress: {
            ...baseline.progress!,
            detailScheduled: snapshot.candidateCursor + candidates.length,
            rejectionCounts: [...byCode.entries()]
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([code, count]) => ({
                code,
                message: NOWCODER_DIRECTED_REJECTION_MESSAGES[code],
                count,
              })),
          },
          accepted: baseline.accepted!,
          deliveryItems: baseline.deliveryItems!,
          privateRejections,
        };
      }

      this.throwIfRunAborted(signal);
      await this.dependencies.jobs.setDirectedAttemptPins(runId, attempt, currentJobIds);
      try {
        await this.dependencies.store.checkpointCurrentRun(runId, attempt, {
          phase: 'collecting',
          candidateCursor: snapshot.candidateCursor + candidates.length,
          currentJobIds,
          currentRoundJobIds: ids,
          ...completeCheckpoint,
        });
      } catch (error) {
        await this.dependencies.jobs.setDirectedAttemptPins(
          runId,
          attempt,
          snapshot.currentJobIds,
        );
        throw error;
      }
      this.throwIfRunAborted(signal);
      const jobs: JobRecord[] = [];
      for (const [index, candidate] of candidates.entries()) {
        this.throwIfRunAborted(signal);
        jobs.push(await this.dependencies.jobs.create({
          id: ids[index]!,
          url: candidate.canonicalUrl,
          requestedBy: 'codex',
          directedRunId: runId,
          directedRunAttempt: attempt,
        }));
      }
      for (const job of jobs) {
        this.throwIfRunAborted(signal);
        const current = this.dependencies.jobs.get(job.id);
        if (
          current
          && this.canDispatch(current)
          && await this.guardBoundary(runId, attempt, 'before-dispatch')
        ) await this.dependencies.dispatch(current);
      }
      return jobs;
    }));
  }

  reconcileAll(): Promise<void> {
    if (this.closed) return Promise.reject(this.closedError);
    const operation = this.reconciliationQueue.then(() => this.reconcileActiveRuns());
    this.reconciliationQueue = operation.catch(() => undefined);
    return this.trackOperation(operation);
  }

  async onJobTerminal(job: JobRecord): Promise<void> {
    this.assertOpen();
    await this.trackOperation((async () => {
      if (!isTerminalJob(job) || !this.acceptsResult(job)) return;
      if (!(await this.guardJobBoundary(job, 'before-selection'))) return;
      const snapshot = this.requireCurrentSnapshot(job.directedRunId!, job.directedRunAttempt!);
      if (!snapshot.currentRoundJobIds.every(id => isTerminalJob(this.dependencies.jobs.get(id)))) return;
      await this.dependencies.store.checkpointCurrentRun(
        snapshot.id,
        snapshot.attempt,
        this.selectionBoundaryCheckpoint(snapshot),
      );
      await this.reconcileAll();
    })());
  }

  async finalizeRun(
    runId: string,
    attempt: NowcoderDirectedRunAttempt,
    status: 'completed' | 'failed',
  ): Promise<PublicNowcoderDirectedRun> {
    this.assertOpen();
    return await this.trackOperation((async () => {
      const run = await this.dependencies.store.markTerminalCurrent(runId, attempt, status);
      await this.dependencies.jobs.setDirectedAttemptPins(runId, attempt, []);
      await this.releaseRunReader(runId, attempt);
      return run;
    })());
  }

  async finalizePublished(
    runId: string,
    attempt: NowcoderDirectedRunAttempt,
  ): Promise<PublicNowcoderDirectedRun> {
    this.assertOpen();
    return await this.trackOperation((async () => {
      const run = await this.dependencies.store.completePublishedCurrent(runId, attempt);
      await this.dependencies.jobs.setDirectedAttemptPins(runId, attempt, []);
      await this.releaseRunReader(runId, attempt);
      return run;
    })());
  }

  async finalizeSelectionAttention(
    runId: string,
    attempt: NowcoderDirectedRunAttempt,
    reason: NowcoderDirectedAttentionReason,
    checkpoint: {
      progress: NowcoderDirectedProgress;
      accepted: number;
      privateRejections: Array<{
        jobId: string;
        url: string;
        code: NowcoderDirectedRejectionCode;
        message: string;
        detail: string;
      }>;
    },
  ): Promise<{ run: PublicNowcoderDirectedRun; checkpointFingerprint: string }> {
    this.assertOpen();
    return await this.trackOperation((async () => {
      const run = await this.dependencies.store.markSelectionAttentionCurrent(
        runId,
        attempt,
        reason,
        checkpoint,
      );
      const checkpointFingerprint = this.dependencies.store.selectionCheckpointFingerprint(runId, attempt);
      if (!checkpointFingerprint) throw new Error('定向筛选终态未能持久化');
      await this.dependencies.jobs.setDirectedAttemptPins(runId, attempt, []);
      await this.releaseRunReader(runId, attempt);
      return { run, checkpointFingerprint };
    })());
  }

  async finalizeAttention(
    runId: string,
    attempt: NowcoderDirectedRunAttempt,
    reason: NowcoderDirectedAttentionReason,
  ): Promise<{ run: PublicNowcoderDirectedRun; checkpointFingerprint: string }> {
    this.assertOpen();
    return await this.trackOperation((async () => {
      const snapshot = this.requireCurrentSnapshot(runId, attempt);
      const run = await this.dependencies.store.markAttentionCurrent(
        runId,
        attempt,
        reason,
        this.exactCurrentDetailSaved(snapshot),
      );
      const checkpointFingerprint = this.dependencies.store.selectionCheckpointFingerprint(runId, attempt);
      if (!checkpointFingerprint) throw new Error('定向运行需处理终态未能持久化');
      await this.dependencies.jobs.setDirectedAttemptPins(runId, attempt, []);
      await this.releaseRunReader(runId, attempt);
      return { run, checkpointFingerprint };
    })());
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.closeAfterDrain();
    return this.closePromise;
  }

  private async createAttempt(
    persist: (
      evidence: { buildEvidence: NowcoderDirectedBuildEvidence; runtimeId: string },
    ) => Promise<NowcoderDirectedMutationResult>,
  ): Promise<NowcoderDirectedMutationResult> {
    const coordinator = this.dependencies.artifactReaders;
    if (!coordinator || !this.dependencies.liveEvidence) {
      throw new NowcoderDirectedBoundaryError(
        'DIRECTED_ARTIFACT_LEASE_FAILED',
        '定向运行的构建证据协调器不可用',
      );
    }
    const startIntent = coordinator.tryBeginStart();
    if (!startIntent) {
      throw new NowcoderDirectedBoundaryError(
        'DIRECTED_ARTIFACT_LEASE_FAILED',
        '扩展更新或重启正在进行，请稍后重试',
      );
    }
    let reader: ArtifactReaderHandle | undefined;
    let transferred = false;
    try {
      try {
        reader = await coordinator.acquireReader('nowcoder-directed-run');
      } catch {
        throw new NowcoderDirectedBoundaryError(
          'DIRECTED_ARTIFACT_LEASE_FAILED',
          '扩展产物当前不可安全读取',
        );
      }
      this.assertOpen();
      const live = await this.dependencies.liveEvidence();
      this.assertOpen();
      const frozen = this.validateLiveEvidence(live);
      const result = await persist(frozen);
      if (!result.created) {
        await this.releaseReader(reader);
        reader = undefined;
        return result;
      }
      this.assertOpen();
      const key = runKey(result.run.id, result.run.attempt);
      if (this.runReaders.has(key)) {
        await this.releaseReader(reader);
        reader = undefined;
        throw new Error('定向运行 reader 已存在');
      }
      this.runReaders.set(key, reader);
      reader = undefined;
      transferred = true;
      startIntent.release();
      try {
        await this.reconcileAll();
      } catch {
        this.reportRecoveryFailure();
      }
      return result;
    } finally {
      if (!transferred) startIntent.release();
      if (reader) await this.releaseReader(reader);
    }
  }

  private validateLiveEvidence(live: NowcoderDirectedLiveEvidence): {
    buildEvidence: NowcoderDirectedBuildEvidence;
    runtimeId: string;
  } {
    if (!live.extensionOnline) {
      throw new NowcoderDirectedBoundaryError('DIRECTED_EXTENSION_OFFLINE', '牛客定向运行要求扩展在线');
    }
    if (!live.extensionRuntimeId || !this.isUuid(live.extensionRuntimeId)) {
      throw new NowcoderDirectedBoundaryError(
        'DIRECTED_EXTENSION_RUNTIME_MISSING',
        '扩展没有提供有效的运行实例证明',
      );
    }
    if (!live.bridgeBuildId || !live.artifactBuildId || live.bridgeBuildId !== live.artifactBuildId) {
      throw new NowcoderDirectedBoundaryError(
        'DIRECTED_ARTIFACT_CHANGED',
        'Bridge 启动构建与当前扩展产物不一致',
      );
    }
    if (!live.extensionVersion || live.extensionVersion !== live.applicationVersion) {
      throw new NowcoderDirectedBoundaryError(
        'DIRECTED_EXTENSION_VERSION_CHANGED',
        '扩展版本与当前 Bridge 不兼容',
      );
    }
    if (!live.extensionBuildId || live.extensionBuildId !== live.artifactBuildId) {
      throw new NowcoderDirectedBoundaryError(
        'DIRECTED_EXTENSION_BUILD_CHANGED',
        '在线扩展构建与当前磁盘产物不一致',
      );
    }
    const rawCapabilities = live.extensionCapabilities ?? [];
    const uniqueCapabilities = [...new Set(rawCapabilities)].sort((left, right) => left.localeCompare(right));
    if (REQUIRED_CAPABILITIES.some(capability => !uniqueCapabilities.includes(capability))) {
      throw new NowcoderDirectedBoundaryError(
        'DIRECTED_EXTENSION_CAPABILITY_MISSING',
        '在线扩展缺少牛客定向采集所需能力',
      );
    }
    if (uniqueCapabilities.length !== rawCapabilities.length) {
      throw new NowcoderDirectedBoundaryError(
        'DIRECTED_EXTENSION_CAPABILITY_CHANGED',
        '在线扩展能力证明格式无效',
      );
    }
    const buildEvidence = nowcoderDirectedBuildEvidenceSchema.parse({
      applicationVersion: live.applicationVersion,
      bridgeBuildId: live.bridgeBuildId,
      artifactBuildId: live.artifactBuildId,
      extensionVersion: live.extensionVersion,
      extensionBuildId: live.extensionBuildId,
      extensionCapabilities: uniqueCapabilities,
      frozenAt: live.observedAt,
    });
    return { buildEvidence, runtimeId: live.extensionRuntimeId };
  }

  private compareEvidence(
    frozen: NowcoderDirectedBuildEvidence,
    current: NowcoderDirectedBuildEvidence,
  ): { code: NowcoderDirectedAttentionCode; message: string } | undefined {
    if (
      current.applicationVersion !== frozen.applicationVersion
      || current.extensionVersion !== frozen.extensionVersion
    ) return {
      code: 'DIRECTED_EXTENSION_VERSION_CHANGED',
      message: '定向运行期间扩展版本已变化，已停止当前批次',
    };
    if (
      current.bridgeBuildId !== frozen.bridgeBuildId
      || current.artifactBuildId !== frozen.artifactBuildId
    ) return {
      code: 'DIRECTED_ARTIFACT_CHANGED',
      message: '定向运行期间磁盘扩展产物已变化，已停止当前批次',
    };
    if (current.extensionBuildId !== frozen.extensionBuildId) return {
      code: 'DIRECTED_EXTENSION_BUILD_CHANGED',
      message: '定向运行期间在线扩展构建已变化，已停止当前批次',
    };
    if (!exactStrings(current.extensionCapabilities, frozen.extensionCapabilities)) return {
      code: 'DIRECTED_EXTENSION_CAPABILITY_CHANGED',
      message: '定向运行期间扩展能力集合已变化，已停止当前批次',
    };
    return undefined;
  }

  private async attention(
    snapshot: NowcoderDirectedReconciliationSnapshot,
    code: NowcoderDirectedAttentionCode,
    message: string,
  ): Promise<void> {
    await this.dependencies.store.markAttentionCurrent(snapshot.id, snapshot.attempt, {
      code,
      message,
      at: this.dependencies.now?.() ?? new Date().toISOString(),
      phase: snapshot.phase,
    }, this.exactCurrentDetailSaved(snapshot));
    await this.dependencies.jobs.setDirectedAttemptPins(snapshot.id, snapshot.attempt, []);
    await this.releaseRunReader(snapshot.id, snapshot.attempt);
  }

  private ensureRunReader(snapshot: NowcoderDirectedReconciliationSnapshot): Promise<void> {
    return this.trackOperation(this.acquireRunReader(snapshot));
  }

  private async acquireRunReader(snapshot: NowcoderDirectedReconciliationSnapshot): Promise<void> {
    const coordinator = this.dependencies.artifactReaders;
    const key = runKey(snapshot.id, snapshot.attempt);
    if (
      !coordinator
      || !this.isCurrentReconciliationSnapshot(snapshot.id, snapshot.attempt)
      || this.runReaders.has(key)
    ) return;
    try {
      const reader = await coordinator.acquireReader('nowcoder-directed-run');
      if (!this.isCurrentReconciliationSnapshot(snapshot.id, snapshot.attempt)) {
        await this.releaseReader(reader);
        return;
      }
      if (this.runReaders.has(key)) {
        await this.releaseReader(reader);
        return;
      }
      if (!this.isCurrentReconciliationSnapshot(snapshot.id, snapshot.attempt)) {
        await this.releaseReader(reader);
        return;
      }
      this.runReaders.set(key, reader);
    } catch {
      if (this.closed) return;
      const current = this.currentSnapshot(snapshot.id, snapshot.attempt);
      if (!current) return;
      if (current.status === 'cancelling') return;
      await this.attention(
        current,
        'DIRECTED_ARTIFACT_LEASE_FAILED',
        'Bridge 重启后无法重新取得扩展产物读取权',
      );
    }
  }

  private async releaseRunReader(runId: string, attempt: NowcoderDirectedRunAttempt): Promise<void> {
    const key = runKey(runId, attempt);
    const reader = this.runReaders.get(key);
    if (!reader) return;
    this.runReaders.delete(key);
    await this.releaseReader(reader);
  }

  private async reconcileCancellationUnlocked(
    snapshot: NowcoderDirectedReconciliationSnapshot,
  ): Promise<PublicNowcoderDirectedRun> {
    if (snapshot.status !== 'cancelling') throw new Error('定向运行不在取消中');
    const candidatesByJobId = new Map(
      snapshot.frozenCandidates
        .slice(0, snapshot.candidateCursor)
        .map(candidate => [
          childId(snapshot.id, snapshot.attempt, candidate.canonicalUrl),
          candidate,
        ]),
    );
    const evidence = new Map(snapshot.tabClearEvidence.map(item => [item.jobId, item.kind]));
    const dispatched = new Set(snapshot.dispatchedJobIds);
    for (const jobId of snapshot.currentJobIds) {
      const candidate = candidatesByJobId.get(jobId);
      if (!candidate) throw new Error('取消任务不属于已消费的冻结候选');
      let job = this.dependencies.jobs.get(jobId);
      if (!job) {
        job = await this.dependencies.jobs.create({
          id: jobId,
          url: candidate.canonicalUrl,
          requestedBy: 'codex',
          directedRunId: snapshot.id,
          directedRunAttempt: snapshot.attempt,
        });
      }
      if (!this.isOwnedBySnapshot(snapshot, job)) throw new Error('取消任务归属与冻结候选不一致');
      let proof = evidence.get(jobId);
      if (!proof && !dispatched.has(jobId)) {
        await this.dependencies.store.recordTabClearEvidenceCurrent(
          snapshot.id,
          snapshot.attempt,
          jobId,
          'never_dispatched',
        );
        proof = 'never_dispatched';
        evidence.set(jobId, proof);
      }
      if (proof) {
        if (!isTerminalJob(job)) {
          job = await this.dependencies.jobs.transition(job.id, 'failed', {
            errorCode: 'CANCELLED',
            errorMessage: '牛客定向采集已取消',
          });
        }
        await this.dependencies.acknowledgeTerminal?.(job);
        continue;
      }
      await this.dependencies.sendCancel?.(job);
    }

    const current = this.requireCurrentSnapshot(snapshot.id, snapshot.attempt);
    const jobsTerminal = current.currentJobIds.every(jobId =>
      isTerminalJob(this.dependencies.jobs.get(jobId)));
    const exactProofs = this.dependencies.store.hasCompleteTabClearEvidence(
      current.id,
      current.attempt,
    );
    const ownedTabsClear = exactProofs && (
      await this.dependencies.ownedTabsClear?.(current) ?? exactProofs
    );
    if (!jobsTerminal || !ownedTabsClear) {
      return this.dependencies.store.getRun(current.id)!;
    }
    const run = await this.dependencies.store.completeCancellationCurrent(
      current.id,
      current.attempt,
      this.exactCurrentDetailSaved(current),
    );
    await this.dependencies.jobs.setDirectedAttemptPins(current.id, current.attempt, []);
    await this.releaseRunReader(current.id, current.attempt);
    this.runAbortControllers.delete(runKey(current.id, current.attempt));
    this.runCancellableOperations.delete(runKey(current.id, current.attempt));
    return run;
  }

  private serializeRun<T>(
    runId: string,
    attempt: NowcoderDirectedRunAttempt,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = runKey(runId, attempt);
    const previous = this.runMutationQueues.get(key) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.runMutationQueues.set(key, tail);
    void tail.then(() => {
      if (this.runMutationQueues.get(key) === tail) this.runMutationQueues.delete(key);
    });
    return result;
  }

  private runAbortController(
    runId: string,
    attempt: NowcoderDirectedRunAttempt,
  ): AbortController {
    const key = runKey(runId, attempt);
    let controller = this.runAbortControllers.get(key);
    if (!controller) {
      controller = new AbortController();
      this.runAbortControllers.set(key, controller);
    }
    return controller;
  }

  private abortRunOperations(runId: string, attempt: NowcoderDirectedRunAttempt): void {
    const controller = this.runAbortController(runId, attempt);
    if (controller.signal.aborted) return;
    const error = new Error('牛客定向采集已取消');
    error.name = 'AbortError';
    controller.abort(error);
  }

  private async waitForRunOperations(
    runId: string,
    attempt: NowcoderDirectedRunAttempt,
  ): Promise<void> {
    const operations = this.runCancellableOperations.get(runKey(runId, attempt));
    if (operations?.size) await Promise.allSettled([...operations]);
  }

  private runCancellable<T>(
    runId: string,
    attempt: NowcoderDirectedRunAttempt,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const key = runKey(runId, attempt);
    const controller = this.runAbortController(runId, attempt);
    const pending = Promise.resolve().then(() => operation(controller.signal));
    const operations = this.runCancellableOperations.get(key) ?? new Set<Promise<unknown>>();
    operations.add(pending);
    this.runCancellableOperations.set(key, operations);
    void pending.then(
      () => {
        operations.delete(pending);
        if (operations.size === 0) this.runCancellableOperations.delete(key);
      },
      () => {
        operations.delete(pending);
        if (operations.size === 0) this.runCancellableOperations.delete(key);
      },
    );
    return pending;
  }

  private throwIfRunAborted(signal: AbortSignal): void {
    if (!signal.aborted) return;
    throw signal.reason instanceof Error ? signal.reason : new Error('牛客定向采集已取消');
  }

  private async reconcileActiveRuns(): Promise<void> {
    for (const initial of this.dependencies.store.reconciliationSnapshots()) {
      if (this.closed) return;
      if (initial.status === 'cancelling') {
        await this.ensureRunReader(initial);
        await this.reconcileCancellation(initial);
        continue;
      }
      // The extension retains each terminal tuple until its durable Bridge acknowledgement. A
      // reconnect may lose a previously written socket frame after JobStore committed, so every
      // recovery pass republishes only exact terminals whose close proof is already durable.
      await this.reacknowledgeProvenTerminals(initial);
      if (initial.status === 'publishing'
        || (initial.status === 'running' && initial.phase === 'staging')) {
        await this.reconcilePublisherDecision(initial.id, initial.attempt);
        continue;
      }
      if (initial.status !== 'running') continue;
      await this.ensureRunReader(initial);
      if (this.closed) return;
      if (!this.currentSnapshot(initial.id, initial.attempt)) continue;
      if (!(await this.guardBoundary(initial.id, initial.attempt, 'restart-recovery'))) continue;
      if (initial.phase === 'collecting') await this.reconcileCollecting(initial);
      const current = this.currentSnapshot(initial.id, initial.attempt);
      if (!current) continue;
      if (current.phase === 'selecting') await this.invokeSelection(current);
      const afterSelection = this.currentSnapshot(initial.id, initial.attempt);
      if (afterSelection?.phase === 'staging' || afterSelection?.phase === 'publishing') {
        await this.reconcilePublisherDecision(afterSelection.id, afterSelection.attempt);
      }
    }
  }

  private async reacknowledgeProvenTerminals(
    snapshot: NowcoderDirectedReconciliationSnapshot,
  ): Promise<void> {
    const proven = new Set(snapshot.tabClearEvidence
      .filter(evidence => evidence.kind === 'remote_terminal_after_close')
      .map(evidence => evidence.jobId));
    for (const jobId of snapshot.currentJobIds) {
      if (!proven.has(jobId)) continue;
      const job = this.dependencies.jobs.get(jobId);
      if (!job || !isTerminalJob(job) || !this.isOwnedBySnapshot(snapshot, job)) continue;
      await this.dependencies.acknowledgeTerminal?.(job);
    }
  }

  private async reconcileCollecting(snapshot: NowcoderDirectedReconciliationSnapshot): Promise<void> {
    if (
      snapshot.candidateCursor === 0
      && snapshot.currentJobIds.length === 0
      && snapshot.currentRoundJobIds.length === 0
    ) {
      await this.invokeSelection(snapshot);
      return;
    }
    const candidatesByJobId = new Map(
      snapshot.frozenCandidates
        .slice(0, snapshot.candidateCursor)
        .map(candidate => [childId(snapshot.id, snapshot.attempt, candidate.canonicalUrl), candidate]),
    );
    const provenTerminals = new Set(snapshot.tabClearEvidence
      .filter(evidence => evidence.kind === 'remote_terminal_after_close')
      .map(evidence => evidence.jobId));
    for (const id of snapshot.currentRoundJobIds) {
      const candidate = candidatesByJobId.get(id);
      if (!candidate || !snapshot.currentJobIds.includes(id)) throw new Error('当前轮任务不属于冻结候选');
      let job = this.dependencies.jobs.get(id);
      if (!job) {
        job = await this.dependencies.jobs.create({
          id,
          url: candidate.canonicalUrl,
          requestedBy: 'codex',
          directedRunId: snapshot.id,
          directedRunAttempt: snapshot.attempt,
        });
      }
      if (!this.ownsCurrentJob(job)) throw new Error('任务归属与当前定向运行不一致');
      if (this.dependencies.isPersistenceInFlight?.(job.id)) continue;
      if (provenTerminals.has(job.id) && !isTerminalJob(job)) {
        // The extension already closed this exact tuple and retains its immutable terminal until
        // acknowledgement. Re-send collect only as a cache replay request; never redispatch it.
        await this.dependencies.replayProvenTerminal?.(job);
        continue;
      }
      if (job.status === 'dispatched' || job.status === 'collecting') {
        job = await this.dependencies.jobs.transition(job.id, 'queued');
      }
      if (
        job.status === 'queued'
        && this.canDispatch(job)
        && await this.guardBoundary(snapshot.id, snapshot.attempt, 'before-dispatch')
      ) await this.dependencies.dispatch(job);
    }
    if (
      snapshot.currentRoundJobIds.length > 0
      && snapshot.currentRoundJobIds.every(id => isTerminalJob(this.dependencies.jobs.get(id)))
    ) {
      const current = this.requireCurrentSnapshot(snapshot.id, snapshot.attempt);
      await this.dependencies.store.checkpointCurrentRun(
        current.id,
        current.attempt,
        this.selectionBoundaryCheckpoint(current),
      );
    }
  }

  private async invokeSelection(snapshot: NowcoderDirectedReconciliationSnapshot): Promise<void> {
    const callback = this.dependencies.reconcileSelection;
    if (!callback) return;
    const key = [snapshot.id, snapshot.attempt, snapshot.candidateCursor, ...snapshot.currentRoundJobIds].join(':');
    if (this.completedSelectionRecoveries.has(key)) return;
    try {
      await this.runCancellable(snapshot.id, snapshot.attempt, async signal => {
        this.throwIfRunAborted(signal);
        if (!(await this.guardBoundary(snapshot.id, snapshot.attempt, 'before-selection'))) return;
        this.throwIfRunAborted(signal);
        const current = this.currentSnapshot(snapshot.id, snapshot.attempt);
        if (!current
          || current.status !== 'running'
          || (current.phase !== 'collecting' && current.phase !== 'selecting')) return;
        const before = this.dependencies.store.selectionCheckpointFingerprint(snapshot.id, snapshot.attempt);
        const result = await callback(this.context(current, signal));
        this.throwIfRunAborted(signal);
        const afterSnapshot = this.currentSnapshot(snapshot.id, snapshot.attempt);
        if (!afterSnapshot || afterSnapshot.status !== 'running') return;
        if (result?.state !== 'committed') return;
        const after = this.dependencies.store.selectionCheckpointFingerprint(snapshot.id, snapshot.attempt);
        if (!after || after === before || after !== result.checkpointFingerprint) {
          throw new Error('定向筛选回调未提交声明的持久检查点');
        }
        this.completedSelectionRecoveries.add(key);
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      throw error;
    }
  }

  private reconcilePublisherDecision(
    runId: string,
    attempt: NowcoderDirectedRunAttempt,
  ): Promise<void> {
    this.assertOpen();
    const key = runKey(runId, attempt);
    const existing = this.publisherDecisionFlights.get(key);
    if (existing) return existing;
    const initial = this.currentSnapshot(runId, attempt);
    const execution = initial?.status === 'running' && initial.phase === 'staging'
      ? this.runCancellable(runId, attempt, signal =>
          this.executePublisherDecision(runId, attempt, signal))
      : this.executePublisherDecision(runId, attempt);
    let flight!: Promise<void>;
    flight = this.trackOperation(
      Promise.resolve(execution)
        .catch(error => {
          if (error instanceof Error && error.name === 'AbortError') return;
          throw error;
        })
        .finally(() => {
          if (this.publisherDecisionFlights.get(key) === flight) {
            this.publisherDecisionFlights.delete(key);
          }
        }),
    );
    this.publisherDecisionFlights.set(key, flight);
    return flight;
  }

  private async executePublisherDecision(
    runId: string,
    attempt: NowcoderDirectedRunAttempt,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal) this.throwIfRunAborted(signal);
    if (this.closed) return;
    let snapshot = this.currentPublisherSnapshot(runId, attempt);
    if (!snapshot) return;
    let recoveryKey = this.publisherRecoveryKey(snapshot);
    if (
      this.completedPublisherRecoveries.has(recoveryKey)
      || this.verifiedMarkerRecoveries.has(recoveryKey)
    ) return;

    const markerVerified = await this.dependencies.probeVerifiedMarker?.({ run: snapshot }) ?? false;
    if (signal) this.throwIfRunAborted(signal);
    if (this.closed) return;
    snapshot = this.currentPublisherSnapshot(runId, attempt);
    if (!snapshot) return;
    recoveryKey = this.publisherRecoveryKey(snapshot);
    if (
      this.completedPublisherRecoveries.has(recoveryKey)
      || this.verifiedMarkerRecoveries.has(recoveryKey)
    ) return;
    const callback = this.dependencies.recoverPublisher;
    if (markerVerified) {
      if (callback) {
        await callback({ run: snapshot, markerVerified: true });
        this.completedPublisherRecoveries.add(recoveryKey);
      }
      this.verifiedMarkerRecoveries.add(recoveryKey);
      return;
    }

    await this.ensureRunReader(snapshot);
    if (signal) this.throwIfRunAborted(signal);
    if (this.closed) return;
    snapshot = this.currentPublisherSnapshot(runId, attempt);
    if (!snapshot) return;
    // Staging still depends on the live extension evidence and remains cancellable. A persisted
    // publishing run has already crossed that cutoff; its remaining work is the local,
    // idempotent exact sync and must be replayable immediately after a Bridge restart.
    if (snapshot.status === 'running'
      && !await this.guardBoundary(runId, attempt, 'before-publisher-recovery')) return;
    if (signal) this.throwIfRunAborted(signal);
    if (this.closed) return;
    snapshot = this.currentPublisherSnapshot(runId, attempt);
    if (!snapshot) return;
    recoveryKey = this.publisherRecoveryKey(snapshot);
    if (this.completedPublisherRecoveries.has(recoveryKey)) return;
    if (callback) {
      await callback({ ...this.context(snapshot, signal), markerVerified: false });
      if (signal) this.throwIfRunAborted(signal);
      this.completedPublisherRecoveries.add(recoveryKey);
    }
  }

  private currentPublisherSnapshot(
    runId: string,
    attempt: NowcoderDirectedRunAttempt,
  ): NowcoderDirectedReconciliationSnapshot | undefined {
    const snapshot = this.currentSnapshot(runId, attempt);
    return snapshot && (
      snapshot.status === 'publishing'
      || (snapshot.status === 'running' && snapshot.phase === 'staging')
    )
      ? snapshot
      : undefined;
  }

  private publisherRecoveryKey(snapshot: NowcoderDirectedReconciliationSnapshot): string {
    return `${snapshot.id}:${snapshot.attempt}:${snapshot.phase}`;
  }

  private isCurrentReconciliationSnapshot(
    runId: string,
    attempt: NowcoderDirectedRunAttempt,
  ): boolean {
    return !this.closed && this.currentSnapshot(runId, attempt) !== undefined;
  }

  private assertOpen(): void {
    if (this.closed) throw this.closedError;
  }

  private trackOperation<T>(operation: Promise<T>): Promise<T> {
    this.activeOperations.add(operation);
    void operation.then(
      () => this.activeOperations.delete(operation),
      () => this.activeOperations.delete(operation),
    );
    return operation;
  }

  private async drainActiveOperations(): Promise<void> {
    while (this.activeOperations.size > 0) {
      await Promise.allSettled([...this.activeOperations]);
    }
  }

  private releaseReader(reader: ArtifactReaderHandle): Promise<void> {
    let release: Promise<void>;
    try {
      release = reader.release();
    } catch (error) {
      release = Promise.reject(error);
    }
    if (this.releaseFlights.has(release)) return release;
    this.releaseFlights.add(release);
    void release.then(
      () => this.releaseFlights.delete(release),
      () => {
        this.releaseFailed = true;
        this.releaseFlights.delete(release);
      },
    );
    return release;
  }

  private async drainReleaseFlights(): Promise<void> {
    while (this.releaseFlights.size > 0) {
      await Promise.allSettled([...this.releaseFlights]);
    }
  }

  private async closeAfterDrain(): Promise<void> {
    await this.drainActiveOperations();
    await this.drainReleaseFlights();
    const handles = [...this.runReaders.values()];
    this.runReaders.clear();
    await Promise.allSettled(handles.map(handle => this.releaseReader(handle)));
    await this.drainActiveOperations();
    await this.drainReleaseFlights();
    if (this.releaseFailed) throw this.closeFailedError;
  }

  private reportRecoveryFailure(): void {
    try {
      this.dependencies.reportRecoveryFailure?.({
        code: 'DIRECTED_RECOVERY_FAILED',
        message: '牛客定向运行恢复不可用',
      });
    } catch {
      // A health/quarantine observer must never turn an already-committed attempt into failure.
    }
  }

  private context(
    snapshot: NowcoderDirectedReconciliationSnapshot,
    signal?: AbortSignal,
  ): NowcoderDirectedReconciliationContext {
    const expectedUrls = new Map(
      snapshot.frozenCandidates.slice(0, snapshot.candidateCursor).map(candidate => [
        childId(snapshot.id, snapshot.attempt, candidate.canonicalUrl), candidate.canonicalUrl,
      ]),
    );
    const jobs = snapshot.currentJobIds.map(id => {
      const expectedUrl = expectedUrls.get(id);
      if (!expectedUrl) throw new Error('当前任务不属于已消费的冻结候选');
      const job = this.dependencies.jobs.get(id);
      if (!job || job.url !== expectedUrl || !this.ownsCurrentJob(job)) {
        throw new Error('当前任务归属与冻结候选不一致');
      }
      return job;
    });
    return { run: snapshot, jobs, ...(signal ? { signal } : {}) };
  }

  /**
   * Entering selecting is itself a durable recovery boundary.  Persist a complete,
   * conservative audit before selection reads any local artifact; the selection
   * coordinator replaces this baseline with the authoritative loaded result.
   */
  private selectionBoundaryCheckpoint(
    snapshot: NowcoderDirectedReconciliationSnapshot,
  ): NowcoderDirectedRunCheckpoint {
    const jobs = this.context(snapshot).jobs;
    const privateRejections = jobs.map(job => {
      const code: NowcoderDirectedRejectionCode = job.status === 'failed'
        ? 'DETAIL_FAILED'
        : job.status === 'needs_attention'
          ? 'DETAIL_NEEDS_ATTENTION'
          : 'DETAIL_NOT_SAVED';
      return {
        jobId: job.id,
        url: job.url,
        code,
        message: NOWCODER_DIRECTED_REJECTION_MESSAGES[code],
        detail: NOWCODER_DIRECTED_REJECTION_MESSAGES[code],
      };
    });
    const byCode = new Map<NowcoderDirectedRejectionCode, number>();
    for (const rejection of privateRejections) {
      byCode.set(rejection.code, (byCode.get(rejection.code) ?? 0) + 1);
    }
    const detailSaved = jobs.filter(job =>
      job.status === 'saved'
      && job.markdownOutput?.sinkId === 'markdown'
      && job.markdownOutput.outputPath.length > 0).length;
    return {
      phase: 'selecting',
      progress: {
        discovered: snapshot.frozenCandidates.length,
        detailScheduled: snapshot.candidateCursor,
        detailSaved,
        inspected: 0,
        qualified: 0,
        accepted: 0,
        delivered: 0,
        rejectionCounts: [...byCode.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([code, count]) => ({
            code,
            message: NOWCODER_DIRECTED_REJECTION_MESSAGES[code],
            count,
          })),
        companies: [
          { company: 'bytedance', count: 0 },
          { company: 'tencent', count: 0 },
          { company: 'alibaba', count: 0 },
          { company: 'ant', count: 0 },
          { company: 'other', count: 0 },
        ],
      },
      accepted: 0,
      deliveryItems: [],
      privateRejections,
    };
  }

  /** Count only immutable evidence owned by this exact run/attempt and consumed prefix. */
  private exactCurrentDetailSaved(snapshot: NowcoderDirectedReconciliationSnapshot): number {
    let saved = 0;
    for (const id of snapshot.currentJobIds) {
      const job = this.dependencies.jobs.get(id);
      if (!job
        || !this.isOwnedBySnapshot(snapshot, job)
        || job.status !== 'saved'
        || job.markdownOutput?.sinkId !== 'markdown'
        || job.markdownOutput.outputPath.length === 0) continue;
      saved += 1;
    }
    return saved;
  }

  private currentSnapshot(
    runId: string,
    attempt: NowcoderDirectedRunAttempt,
  ): NowcoderDirectedReconciliationSnapshot | undefined {
    return this.dependencies.store.reconciliationSnapshots()
      .find(snapshot => snapshot.id === runId && snapshot.attempt === attempt);
  }

  private isOwnedBySnapshot(snapshot: NowcoderDirectedReconciliationSnapshot, job: JobRecord): boolean {
    const index = snapshot.currentJobIds.indexOf(job.id);
    const candidate = index >= 0 && index < snapshot.candidateCursor
      ? snapshot.frozenCandidates[index]
      : undefined;
    return Boolean(
      candidate
      && job.directedRunId === snapshot.id
      && job.directedRunAttempt === snapshot.attempt
      && job.id === childId(snapshot.id, snapshot.attempt, candidate.canonicalUrl)
      && job.url === candidate.canonicalUrl,
    );
  }

  private requireCurrentSnapshot(
    runId: string,
    attempt: NowcoderDirectedRunAttempt,
  ): NowcoderDirectedReconciliationSnapshot {
    const snapshot = this.currentSnapshot(runId, attempt);
    if (!snapshot) throw new Error('定向运行尝试已过期');
    return snapshot;
  }

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
  }
}
