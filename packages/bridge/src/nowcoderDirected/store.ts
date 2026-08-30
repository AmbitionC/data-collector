import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  NOWCODER_DIRECTED_REJECTION_MESSAGES,
  NOWCODER_DIRECTED_SELECTION_ATTENTION_MESSAGES,
  nowcoderDirectedStartRequestSchema,
  nowcoderDirectedAttentionReasonSchema,
  nowcoderDirectedBuildEvidenceSchema,
  nowcoderDirectedRunAttemptSchema,
  nowcoderDirectedRetryRequestSchema,
  nowcoderSearchCandidateSchema,
  nowcoderSearchSessionSchema,
  publicNowcoderDirectedRunSchema,
  stableContentId,
  storedNowcoderDirectedRunSchema,
  type NowcoderDirectedRetryRequest,
  type NowcoderDirectedAttentionReason,
  type NowcoderDirectedBuildEvidence,
  type NowcoderDirectedStartRequest,
  type NowcoderSearchCandidate,
  type NowcoderSearchSession,
  type PublicNowcoderDirectedRun,
  type PrivateNowcoderDeliveryItem,
  type NowcoderDirectedProgress,
  type NowcoderDirectedRejectionCode,
  type StoredNowcoderDirectedRun,
} from '@data-collector/shared';
import { nowcoderDirectedJobId } from './jobIdentity.js';
import {
  processedNowcoderHistoryDigest,
  validateProcessedNowcoderHistorySnapshot,
  StrictNowcoderHistoryError,
  type ProcessedNowcoderHistorySnapshot,
} from '../plans/nowcoderProcessedHistory.js';

interface StoredSession {
  session: NowcoderSearchSession;
  target: number;
}

interface PrivateNowcoderDirectedRun {
  run: StoredNowcoderDirectedRun;
  frozenCandidates: NowcoderSearchCandidate[];
  candidateCursor: number;
  currentRoundJobIds: string[];
  deliveryAuthorized: true;
  historySnapshot?: ProcessedNowcoderHistorySnapshot;
  historyDigest?: string;
  selectionAuditComplete: boolean;
  privateRejections: Array<{
    jobId: string;
    url: string;
    code: NowcoderDirectedRejectionCode;
    message: string;
    detail: string;
  }>;
  /** Persisted before the corresponding job.collect frame is allowed onto the wire. */
  dispatchedJobIds: string[];
  /** One immutable close proof per exact current-run job. */
  tabClearEvidence: Array<{
    jobId: string;
    kind: NowcoderDirectedTabClearKind;
  }>;
}

export type NowcoderDirectedTabClearKind =
  | 'never_dispatched'
  | 'remote_terminal_after_close'
  | 'cancelled_after_close';

interface IdempotencyEntry {
  fingerprint: string;
  runId: string;
}

interface StoreEnvelope {
  version: 1;
  sessions: StoredSession[];
  runs: PrivateNowcoderDirectedRun[];
  startIdempotency: Record<string, IdempotencyEntry>;
  retryIdempotency: Record<string, IdempotencyEntry>;
}

export interface NowcoderDirectedStoreDependencies {
  now: () => string;
  id: () => string;
  attempt: () => string;
  atomicWrite: (path: string, value: StoreEnvelope) => Promise<void>;
}

export interface CreateNowcoderSessionOptions {
  target?: number;
}

/** Private durable fields used to persist before a directed service performs external work. */
export interface NowcoderDirectedRunCheckpoint {
  phase?: StoredNowcoderDirectedRun['phase'];
  candidateCursor?: number;
  currentRoundJobIds?: string[];
  currentJobIds?: string[];
  progress?: NowcoderDirectedProgress;
  accepted?: number;
  deliveryItems?: PrivateNowcoderDeliveryItem[];
  privateRejections?: PrivateNowcoderDirectedRun['privateRejections'];
}

export interface NowcoderDirectedAttemptEvidence {
  buildEvidence: NowcoderDirectedBuildEvidence;
  runtimeId: string;
}

export interface NowcoderDirectedMutationResult {
  run: PublicNowcoderDirectedRun;
  created: boolean;
}

/** Narrow durable view used only by Bridge job orchestration and restart reconciliation. */
export interface NowcoderDirectedReconciliationSnapshot {
  id: string;
  attempt: StoredNowcoderDirectedRun['attempt'];
  status: StoredNowcoderDirectedRun['status'];
  phase: StoredNowcoderDirectedRun['phase'];
  spec: Pick<StoredNowcoderDirectedRun['spec'], 'target' | 'maxDetails'>;
  frozenCandidates: NowcoderSearchCandidate[];
  candidateCursor: number;
  currentJobIds: string[];
  currentRoundJobIds: string[];
  buildEvidence: NowcoderDirectedBuildEvidence;
  observedRuntimeIds: string[];
  scheduledCandidateIds: string[];
  dispatchedJobIds: string[];
  tabClearEvidence: Array<{ jobId: string; kind: NowcoderDirectedTabClearKind }>;
  progress: NowcoderDirectedProgress;
  historySnapshot?: ProcessedNowcoderHistorySnapshot;
  historyDigest?: string;
}

export interface NowcoderDirectedPublisherSnapshot {
  id: string;
  attempt: StoredNowcoderDirectedRun['attempt'];
  status: StoredNowcoderDirectedRun['status'];
  phase: StoredNowcoderDirectedRun['phase'];
  target: number;
  deliveryItems: PrivateNowcoderDeliveryItem[];
}

function emptyCompanies(): NowcoderDirectedProgress['companies'] {
  return [
    { company: 'bytedance', count: 0 },
    { company: 'tencent', count: 0 },
    { company: 'alibaba', count: 0 },
    { company: 'ant', count: 0 },
    { company: 'other', count: 0 },
  ];
}

function emptyEnvelope(): StoreEnvelope {
  return { version: 1, sessions: [], runs: [], startIdempotency: {}, retryIdempotency: {} };
}

async function writeEnvelope(path: string, value: StoreEnvelope): Promise<void> {
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameCandidateSequence(left: readonly NowcoderSearchCandidate[], right: readonly NowcoderSearchCandidate[]): boolean {
  return left.length === right.length && left.every((candidate, index) => JSON.stringify(candidate) === JSON.stringify(right[index]));
}

function isUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function exactStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

const TAB_CLEAR_KINDS = new Set<NowcoderDirectedTabClearKind>([
  'never_dispatched',
  'remote_terminal_after_close',
  'cancelled_after_close',
]);

function parseTabClearEvidence(value: unknown): Array<{
  jobId: string;
  kind: NowcoderDirectedTabClearKind;
}> {
  if (!Array.isArray(value)) throw new Error('定向牛客状态文件格式无效');
  return value.map(raw => {
    if (!isObject(raw)
      || Object.keys(raw).some(key => key !== 'jobId' && key !== 'kind')
      || typeof raw.jobId !== 'string'
      || typeof raw.kind !== 'string'
      || !TAB_CLEAR_KINDS.has(raw.kind as NowcoderDirectedTabClearKind)) {
      throw new Error('定向牛客状态文件格式无效');
    }
    return { jobId: raw.jobId, kind: raw.kind as NowcoderDirectedTabClearKind };
  });
}

function parsePrivateRejections(value: unknown): {
  items: PrivateNowcoderDirectedRun['privateRejections'];
  changed: boolean;
} {
  if (value === undefined) return { items: [], changed: true };
  if (!Array.isArray(value)) throw new Error('定向牛客状态文件格式无效');
  let changed = false;
  const allowed = new Set(['jobId', 'url', 'code', 'message', 'detail']);
  const items = value.map(raw => {
    if (!isObject(raw)
      || Object.keys(raw).some(key => !allowed.has(key))
      || typeof raw.jobId !== 'string'
      || typeof raw.url !== 'string'
      || typeof raw.code !== 'string'
      || typeof raw.detail !== 'string'
      || (raw.message !== undefined && typeof raw.message !== 'string')) {
      throw new Error('定向牛客状态文件格式无效');
    }
    const code = raw.code as NowcoderDirectedRejectionCode;
    const message = NOWCODER_DIRECTED_REJECTION_MESSAGES[code];
    if (!message) throw new Error('定向牛客状态文件格式无效');
    if (raw.message === undefined) changed = true;
    else if (raw.message !== message) throw new Error('定向牛客状态文件格式无效');
    return { jobId: raw.jobId, url: raw.url, code, message, detail: raw.detail };
  });
  return { items, changed };
}

interface LegacySelectionAuditMigration {
  progress: unknown;
  privateRejections: unknown;
  selectionAuditComplete: unknown;
  changed: boolean;
}

/**
 * Envelope version 1 predates the total rejection partition. Migration is
 * deliberately narrower than the current schema: only an accepted=0 prefix
 * whose frozen candidate/job lineage is exact can be classified without
 * inventing which candidate was accepted.
 */
function migrateLegacySelectionAuditV1(options: {
  rawRun: Record<string, unknown>;
  frozenCandidates: readonly NowcoderSearchCandidate[];
  candidateCursor: number;
  currentRoundJobIds: readonly string[];
  scheduledCandidateIds: readonly string[];
  progress: unknown;
  privateRejections: unknown;
  selectionAuditComplete: unknown;
}): LegacySelectionAuditMigration {
  const unchanged = {
    progress: options.progress,
    privateRejections: options.privateRejections,
    selectionAuditComplete: options.selectionAuditComplete,
    changed: false,
  };
  const status = options.rawRun.status;
  const noStoredPrivateAudit = options.privateRejections === undefined
    || (Array.isArray(options.privateRejections) && options.privateRejections.length === 0);
  if (options.selectionAuditComplete !== undefined
    || !noStoredPrivateAudit
    || (status !== 'running' && status !== 'cancelling' && status !== 'failed')
    || options.candidateCursor < 1
    || options.candidateCursor > options.frozenCandidates.length
    || !isObject(options.progress)
    || !Array.isArray(options.progress.rejectionCounts)
    || options.progress.rejectionCounts.length !== 0
    || options.rawRun.accepted !== 0
    || options.rawRun.delivered !== 0
    || options.progress.detailSaved !== 0
    || options.progress.inspected !== 0
    || options.progress.qualified !== 0
    || options.progress.accepted !== 0
    || options.progress.delivered !== 0
    || options.progress.discovered !== options.frozenCandidates.length
    || options.progress.detailScheduled !== options.candidateCursor
    || !Array.isArray(options.rawRun.deliveryIds)
    || options.rawRun.deliveryIds.length !== 0
    || !Array.isArray(options.rawRun.deliveryItems)
    || options.rawRun.deliveryItems.length !== 0
    || !Array.isArray(options.rawRun.publicDeliveryItems)
    || options.rawRun.publicDeliveryItems.length !== 0
    || typeof options.rawRun.id !== 'string'
    || options.rawRun.id.trim().length === 0) return unchanged;

  const attempt = nowcoderDirectedRunAttemptSchema.safeParse(options.rawRun.attempt);
  if (!attempt.success) return unchanged;
  const consumed = options.frozenCandidates.slice(0, options.candidateCursor);
  const expectedCandidateIds = consumed.map(candidate => candidate.id);
  const expectedJobIds = consumed.map(candidate => nowcoderDirectedJobId(
    options.rawRun.id as string,
    attempt.data,
    candidate.canonicalUrl,
  ));
  const expectedRoundIds = expectedJobIds.slice(expectedJobIds.length - options.currentRoundJobIds.length);
  if (!Array.isArray(options.rawRun.currentJobIds)
    || !options.rawRun.currentJobIds.every(id => typeof id === 'string')
    || !exactStrings(options.rawRun.currentJobIds as string[], expectedJobIds)
    || !exactStrings(options.currentRoundJobIds, expectedRoundIds)
    || !exactStrings(options.scheduledCandidateIds, expectedCandidateIds)) return unchanged;

  const message = NOWCODER_DIRECTED_REJECTION_MESSAGES.DETAIL_NOT_SAVED;
  return {
    progress: {
      ...options.progress,
      rejectionCounts: [{ code: 'DETAIL_NOT_SAVED', message, count: options.candidateCursor }],
    },
    privateRejections: consumed.map((candidate, index) => ({
      jobId: expectedJobIds[index]!,
      url: candidate.canonicalUrl,
      code: 'DETAIL_NOT_SAVED' as const,
      message,
      detail: message,
    })),
    selectionAuditComplete: true,
    changed: true,
  };
}

function selectionAuditRequired(item: PrivateNowcoderDirectedRun): boolean {
  if (item.run.status === 'cancelled'
    || (
      item.run.status === 'completed_with_attention'
      && item.run.attentionReason?.code !== 'DIRECTED_TARGET_UNAVAILABLE'
      && item.run.verifiedMarkerHash === undefined
    )) return false;
  return item.selectionAuditComplete
    || (
      (item.run.status === 'running' || item.run.status === 'cancelling' || item.run.status === 'failed')
      && item.candidateCursor > 0
    )
    || item.run.status === 'publishing'
    || item.run.status === 'completed'
    || (
      item.run.status === 'completed_with_attention'
      && item.run.attentionReason?.code === 'DIRECTED_TARGET_UNAVAILABLE'
    )
    || (item.run.status === 'completed_with_attention' && item.run.verifiedMarkerHash !== undefined);
}

function assertSelectionAudit(item: PrivateNowcoderDirectedRun): void {
  const publicCounts = new Map(item.run.progress.rejectionCounts.map(entry => [entry.code, entry.count]));
  const rejected = [...publicCounts.values()].reduce((sum, count) => sum + count, 0);
  const required = selectionAuditRequired(item);
  if (!required) {
    if (item.selectionAuditComplete
      || item.privateRejections.length > 0
      || item.run.progress.rejectionCounts.length > 0) {
      throw new Error('定向牛客筛选审计状态无效');
    }
    return;
  }
  if (!item.selectionAuditComplete
    || rejected !== item.run.progress.detailScheduled - item.run.progress.accepted
    || item.privateRejections.length !== rejected) {
    throw new Error('定向牛客筛选审计不完整');
  }
  const expectedByJob = new Map(item.frozenCandidates.slice(0, item.candidateCursor).map(candidate => {
    const jobId = nowcoderDirectedJobId(item.run.id, item.run.attempt, candidate.canonicalUrl);
    return [jobId, candidate.canonicalUrl];
  }));
  const jobIds = new Set<string>();
  const urls = new Set<string>();
  const privateCounts = new Map<NowcoderDirectedRejectionCode, number>();
  for (const rejection of item.privateRejections) {
    const message = NOWCODER_DIRECTED_REJECTION_MESSAGES[rejection.code];
    if (!message
      || rejection.message !== message
      || typeof rejection.detail !== 'string'
      || rejection.detail.trim().length === 0
      || rejection.detail.length > 2_000
      || expectedByJob.get(rejection.jobId) !== rejection.url
      || jobIds.has(rejection.jobId)
      || urls.has(rejection.url)) {
      throw new Error('定向牛客筛选审计身份无效');
    }
    jobIds.add(rejection.jobId);
    urls.add(rejection.url);
    privateCounts.set(rejection.code, (privateCounts.get(rejection.code) ?? 0) + 1);
  }
  if (publicCounts.size !== privateCounts.size
    || [...publicCounts].some(([code, count]) => privateCounts.get(code) !== count)) {
    throw new Error('定向牛客筛选审计计数无效');
  }
}

function assertStagingDelivery(item: PrivateNowcoderDirectedRun): void {
  const items = item.run.deliveryItems;
  const staging = item.run.phase === 'staging'
    && (item.run.status === 'running' || item.run.status === 'cancelling' || item.run.status === 'failed');
  const publishing = item.run.status === 'publishing';
  const completed = item.run.status === 'completed';
  const markerAttention = item.run.status === 'completed_with_attention'
    && item.run.phase === 'publishing'
    && item.run.verifiedMarkerHash !== undefined;
  const exactDeliveryState = staging || publishing || completed || markerAttention;
  if (item.run.status === 'cancelled' && (
    items.length > 0
    || item.privateRejections.length > 0
    || item.selectionAuditComplete
    || item.run.recovery !== undefined
  )) throw new Error('已取消运行必须清空私有交付与审计');
  if (!exactDeliveryState && items.length > 0) {
    throw new Error('定向牛客 staging 交付身份无效');
  }
  if (!exactDeliveryState && items.length === 0) return;
  const expectedUrls = new Set(item.frozenCandidates.slice(0, item.candidateCursor).map(candidate => candidate.canonicalUrl));
  const uniqueKeys = ['jobId', 'stableContentId', 'canonicalUrl', 'contentHash', 'clusterId'] as const;
  if (exactDeliveryState && (
    item.run.accepted !== item.run.spec.target
    || item.run.progress.accepted !== item.run.spec.target
    || items.length !== item.run.spec.target
  )) {
    throw new Error('定向牛客 staging 交付身份无效');
  }
  if (staging && (
    item.run.delivered !== 0
    || item.run.deliveryIds.length !== 0
    || item.run.publicDeliveryItems.length !== 0
    || item.run.publishReceipt !== undefined
    || item.run.verifiedMarkerHash !== undefined
    || item.run.recovery !== undefined
  )) {
    throw new Error('定向牛客 staging 交付身份无效');
  }
  if (uniqueKeys.some(key => new Set(items.map(entry => entry[key])).size !== items.length)) {
    throw new Error('定向牛客 staging 交付身份无效');
  }
  for (const entry of items) {
    if (!item.run.currentJobIds.includes(entry.jobId)
      || !expectedUrls.has(entry.canonicalUrl)
      || entry.jobId !== nowcoderDirectedJobId(item.run.id, item.run.attempt, entry.canonicalUrl)
      || entry.stableContentId !== stableContentId(entry.canonicalUrl)) {
      throw new Error('定向牛客 staging 交付身份无效');
    }
  }
  if (exactDeliveryState && (
    items.some(entry => item.privateRejections.some(rejection => rejection.url === entry.canonicalUrl))
    || new Set([
      ...items.map(entry => entry.canonicalUrl),
      ...item.privateRejections.map(rejection => rejection.url),
    ]).size !== item.candidateCursor
  )) throw new Error('交付与拒绝必须精确分割已调度候选');
}

function assertPrivateCheckpoint(item: PrivateNowcoderDirectedRun): void {
  const expectedCurrentJobIds = item.frozenCandidates
    .slice(0, item.candidateCursor)
    .map(candidate => nowcoderDirectedJobId(item.run.id, item.run.attempt, candidate.canonicalUrl));
  const expectedCurrentRoundJobIds = expectedCurrentJobIds.slice(
    expectedCurrentJobIds.length - item.currentRoundJobIds.length,
  );
  if (item.candidateCursor > item.frozenCandidates.length
    || item.candidateCursor > item.run.spec.maxDetails
    || !isUnique(item.run.currentJobIds)
    || !isUnique(item.currentRoundJobIds)
    || !exactStrings(item.run.currentJobIds, expectedCurrentJobIds)
    || !exactStrings(item.run.scheduledCandidateIds, item.frozenCandidates.slice(0, item.candidateCursor).map(candidate => candidate.id))
    || item.run.progress.discovered !== item.frozenCandidates.length
    || item.run.progress.detailScheduled !== item.candidateCursor
    || item.currentRoundJobIds.length > expectedCurrentJobIds.length
    || !exactStrings(item.currentRoundJobIds, expectedCurrentRoundJobIds)) {
    throw new Error('定向牛客状态文件格式无效');
  }
  const dispatched = new Set(item.dispatchedJobIds);
  const proven = new Set(item.tabClearEvidence.map(evidence => evidence.jobId));
  if (!isUnique(item.dispatchedJobIds)
    || dispatched.size !== item.dispatchedJobIds.length
    || proven.size !== item.tabClearEvidence.length
    || item.dispatchedJobIds.some(jobId => !item.run.currentJobIds.includes(jobId))
    || item.tabClearEvidence.some(evidence =>
      !item.run.currentJobIds.includes(evidence.jobId)
      || (evidence.kind === 'never_dispatched'
        ? dispatched.has(evidence.jobId)
        : !dispatched.has(evidence.jobId)))) {
    throw new Error('定向牛客取消证据格式无效');
  }
  // History is selection input, so only a running run may interpret or repair it.
  // Later lifecycle states keep the original bytes authoritative for Task 6/8
  // recovery even when an older or damaged writer left an incomplete pair.
  if (item.run.status === 'running') {
    if ((item.historySnapshot === undefined) !== (item.historyDigest === undefined)) {
      throw new StrictNowcoderHistoryError('DIRECTED_HISTORY_CORRUPT');
    }
    if (item.historySnapshot !== undefined && item.historyDigest !== undefined) {
      const normalized = validateProcessedNowcoderHistorySnapshot(item.historySnapshot);
      if (JSON.stringify(normalized) !== JSON.stringify(item.historySnapshot)
        || processedNowcoderHistoryDigest(normalized) !== item.historyDigest) {
        throw new StrictNowcoderHistoryError('DIRECTED_HISTORY_CORRUPT');
      }
    }
  }
  assertSelectionAudit(item);
  assertStagingDelivery(item);
}

function convergeHistoryFailure(
  item: PrivateNowcoderDirectedRun,
  code: StrictNowcoderHistoryError['code'],
  now: string,
): void {
  if (item.run.status !== 'running') {
    throw new StrictNowcoderHistoryError(code);
  }
  delete item.historySnapshot;
  delete item.historyDigest;
  item.selectionAuditComplete = false;
  item.privateRejections = [];
  item.run.status = 'completed_with_attention';
  item.run.activeOwnedTabs = 0;
  item.run.terminalOwnedTabs = 0;
  item.run.accepted = 0;
  item.run.delivered = 0;
  item.run.deliveryIds = [];
  item.run.deliveryItems = [];
  item.run.publicDeliveryItems = [];
  delete item.run.publishReceipt;
  delete item.run.recovery;
  item.run.progress = {
    ...item.run.progress,
    inspected: 0,
    qualified: 0,
    accepted: 0,
    delivered: 0,
    rejectionCounts: [],
    companies: emptyCompanies(),
  };
  const message = NOWCODER_DIRECTED_SELECTION_ATTENTION_MESSAGES[code];
  item.run.attentionReason = { code, message, at: now, phase: item.run.phase };
  item.run.summary = message;
  item.run.actionable = '请确认历史记录后使用新的重试运行';
  storedNowcoderDirectedRunSchema.parse(item.run);
  assertPrivateCheckpoint(item);
}

function parseEnvelope(value: unknown, now: string, convergeHistory = false): {
  envelope: StoreEnvelope;
  converged: boolean;
} {
  let converged = false;
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.sessions) || !Array.isArray(value.runs)
    || !isObject(value.startIdempotency) || !isObject(value.retryIdempotency)) {
    throw new Error('定向牛客状态文件格式无效');
  }
  const sessions = value.sessions.map(item => {
    if (!isObject(item) || typeof item.target !== 'number' || !Number.isInteger(item.target) || item.target < 1 || item.target > 10) {
      throw new Error('定向牛客状态文件格式无效');
    }
    const parsed = nowcoderSearchSessionSchema.safeParse(item.session);
    if (!parsed.success || Date.parse(parsed.data.expiresAt) !== Date.parse(parsed.data.createdAt) + 30 * 60 * 1_000) {
      throw new Error('定向牛客状态文件格式无效');
    }
    return { session: parsed.data, target: item.target };
  });
  if (!isUnique(sessions.map(item => item.session.id))) throw new Error('定向牛客状态文件格式无效');
  const sessionsById = new Map(sessions.map(item => [item.session.id, item]));
  const runs = value.runs.map(item => {
    if (!isObject(item) || !Array.isArray(item.frozenCandidates) || !Array.isArray(item.currentRoundJobIds)
      || typeof item.candidateCursor !== 'number' || !Number.isInteger(item.candidateCursor) || item.candidateCursor < 0
      || item.deliveryAuthorized !== true) {
      throw new Error('定向牛客状态文件格式无效');
    }
    if (!isObject(item.run)) throw new Error('定向牛客状态文件格式无效');
    const rawRun = item.run;
    const frozenCandidates = item.frozenCandidates.map(candidate => {
      const parsed = nowcoderSearchCandidateSchema.safeParse(candidate);
      if (!parsed.success) throw new Error('定向牛客状态文件格式无效');
      return parsed.data;
    });
    if (!item.currentRoundJobIds.every(id => typeof id === 'string' && id.length > 0)) {
      throw new Error('定向牛客状态文件格式无效');
    }
    const scheduledCandidateIds = Array.isArray(rawRun.scheduledCandidateIds)
      ? rawRun.scheduledCandidateIds
      : frozenCandidates
          .slice(0, item.candidateCursor)
          .map(candidate => candidate.id);
    const initialProgress = rawRun.progress ?? {
      discovered: frozenCandidates.length,
      detailScheduled: item.candidateCursor,
      detailSaved: 0,
      inspected: 0,
      qualified: 0,
      accepted: rawRun.accepted ?? 0,
      delivered: rawRun.delivered ?? 0,
      rejectionCounts: [],
      companies: emptyCompanies(),
    };
    const legacyAudit = migrateLegacySelectionAuditV1({
      rawRun,
      frozenCandidates,
      candidateCursor: item.candidateCursor,
      currentRoundJobIds: item.currentRoundJobIds as string[],
      scheduledCandidateIds: scheduledCandidateIds as string[],
      progress: initialProgress,
      privateRejections: item.privateRejections,
      selectionAuditComplete: item.selectionAuditComplete,
    });
    if (legacyAudit.changed) converged = true;
    const parsedPrivateRejections = parsePrivateRejections(legacyAudit.privateRejections);
    if (parsedPrivateRejections.changed) converged = true;
    const privateRejections = parsedPrivateRejections.items;
    const run = storedNowcoderDirectedRunSchema.safeParse({
      ...rawRun,
      scheduledCandidateIds,
      progress: legacyAudit.progress,
    });
    if (!run.success) {
      throw new Error('定向牛客状态文件格式无效');
    }
    const rawCurrentJobIds = run.data.currentJobIds;
    const dispatchedJobIds = item.dispatchedJobIds === undefined
      ? [...rawCurrentJobIds]
      : Array.isArray(item.dispatchedJobIds)
        && item.dispatchedJobIds.every(jobId => typeof jobId === 'string')
        ? item.dispatchedJobIds as string[]
        : (() => { throw new Error('定向牛客状态文件格式无效'); })();
    const tabClearEvidence = item.tabClearEvidence === undefined
      ? []
      : parseTabClearEvidence(item.tabClearEvidence);
    if (item.dispatchedJobIds === undefined || item.tabClearEvidence === undefined) converged = true;
    const legacyAuditExempt = run.data.status === 'cancelled'
      || (
        run.data.status === 'completed_with_attention'
        && run.data.attentionReason?.code !== 'DIRECTED_TARGET_UNAVAILABLE'
        && run.data.verifiedMarkerHash === undefined
      );
    const selectionAuditComplete = typeof legacyAudit.selectionAuditComplete === 'boolean'
      ? legacyAudit.selectionAuditComplete
      : legacyAuditExempt
        ? false
        : (
          run.data.phase === 'staging'
          || run.data.phase === 'publishing'
          || run.data.status === 'publishing'
          || run.data.status === 'completed'
          || (
            run.data.progress.rejectionCounts.reduce((sum, entry) => sum + entry.count, 0)
              === run.data.progress.detailScheduled - run.data.progress.accepted
            && privateRejections.length
              === run.data.progress.detailScheduled - run.data.progress.accepted
            && run.data.progress.detailScheduled > 0
          )
        );
    if (typeof legacyAudit.selectionAuditComplete !== 'boolean') converged = true;
    const hasHistorySnapshot = Object.prototype.hasOwnProperty.call(item, 'historySnapshot');
    const hasHistoryDigest = Object.prototype.hasOwnProperty.call(item, 'historyDigest');
    const parsed = {
      run: run.data,
      frozenCandidates,
      candidateCursor: item.candidateCursor,
      currentRoundJobIds: item.currentRoundJobIds as string[],
      deliveryAuthorized: true as const,
      ...(hasHistorySnapshot ? { historySnapshot: item.historySnapshot as ProcessedNowcoderHistorySnapshot } : {}),
      ...(hasHistoryDigest ? { historyDigest: item.historyDigest as string } : {}),
      selectionAuditComplete,
      privateRejections,
      dispatchedJobIds,
      tabClearEvidence,
    };
    try {
      assertPrivateCheckpoint(parsed);
    } catch (error) {
      if (!convergeHistory || !(error instanceof StrictNowcoderHistoryError)) throw error;
      convergeHistoryFailure(parsed, error.code, now);
      converged = true;
    }
    const source = sessionsById.get(parsed.run.spec.searchSessionId);
    if (!source
      || parsed.run.spec.queryHash !== source.session.queryHash
      || JSON.stringify(parsed.run.spec.queries) !== JSON.stringify(source.session.queries)
      || parsed.run.spec.target !== source.target
      || !sameCandidateSequence(
        [...parsed.frozenCandidates].sort((left, right) => left.id.localeCompare(right.id)),
        [...source.session.candidates].sort((left, right) => left.id.localeCompare(right.id)),
      )) throw new Error('定向牛客状态文件格式无效');
    return parsed;
  });
  if (!isUnique(runs.map(item => item.run.id)) || runs.filter(item => !isTerminal(item.run.status)).length > 1) {
    throw new Error('定向牛客状态文件格式无效');
  }
  const parseMap = (map: Record<string, unknown>): Record<string, IdempotencyEntry> => Object.fromEntries(
    Object.entries(map).map(([key, entry]) => {
      if (!isObject(entry) || typeof entry.fingerprint !== 'string' || typeof entry.runId !== 'string') {
        throw new Error('定向牛客状态文件格式无效');
      }
      return [key, { fingerprint: entry.fingerprint, runId: entry.runId }];
    }),
  );
  const startIdempotency = parseMap(value.startIdempotency);
  const retryIdempotency = parseMap(value.retryIdempotency);
  if (Object.keys(startIdempotency).some(key => retryIdempotency[key] !== undefined)) {
    throw new Error('定向牛客状态文件格式无效');
  }
  const runsById = new Map(runs.map(item => [item.run.id, item]));
  const mappedRunIds = new Set<string>();
  for (const [key, entry] of Object.entries(startIdempotency)) {
    const run = runsById.get(entry.runId);
    let request: NowcoderDirectedStartRequest | undefined;
    try { request = nowcoderDirectedStartRequestSchema.parse(JSON.parse(entry.fingerprint) as unknown); } catch { /* invalid below */ }
    if (!run || !request || request.idempotencyKey !== key || fingerprint(request) !== entry.fingerprint
      || run.run.retryOf !== undefined || run.run.spec.idempotencyKey !== key
      || run.run.spec.searchSessionId !== request.searchSessionId
      || JSON.stringify(run.run.idempotencyLineage) !== JSON.stringify([key])
      || mappedRunIds.has(run.run.id)) throw new Error('定向牛客状态文件格式无效');
    const source = sessionsById.get(request.searchSessionId);
    if (!source || request.selectedCandidateIds.some(id => !source.session.candidates.some(candidate => candidate.id === id))
      || !isUnique(request.selectedCandidateIds)) throw new Error('定向牛客状态文件格式无效');
    const selected = new Set(request.selectedCandidateIds);
    const expectedFrozen = [
      ...request.selectedCandidateIds.map(id => source.session.candidates.find(candidate => candidate.id === id) as NowcoderSearchCandidate),
      ...source.session.candidates.filter(candidate => !selected.has(candidate.id)),
    ];
    if (!sameCandidateSequence(run.frozenCandidates, expectedFrozen)) throw new Error('定向牛客状态文件格式无效');
    mappedRunIds.add(run.run.id);
  }
  for (const [key, entry] of Object.entries(retryIdempotency)) {
    const run = runsById.get(entry.runId);
    let raw: { runId?: unknown; idempotencyKey?: unknown } | undefined;
    try { raw = JSON.parse(entry.fingerprint) as { runId?: unknown; idempotencyKey?: unknown }; } catch { /* invalid below */ }
    const request = raw ? nowcoderDirectedRetryRequestSchema.safeParse({ idempotencyKey: raw.idempotencyKey }) : undefined;
    const source = run?.run.retryOf ? runsById.get(run.run.retryOf) : undefined;
    const { idempotencyKey: sourceIdempotencyKey, ...sourceSpec } = source?.run.spec ?? {};
    const { idempotencyKey: retryIdempotencyKey, ...retrySpec } = run?.run.spec ?? {};
    if (!run || !raw || !request?.success || raw.runId !== run.run.retryOf || request.data.idempotencyKey !== key
      || fingerprint({ runId: raw.runId, ...request.data }) !== entry.fingerprint || !source
      || !isTerminal(source.run.status) || run.run.spec.idempotencyKey !== key
      || retryIdempotencyKey !== key || sourceIdempotencyKey === key
      || JSON.stringify(retrySpec) !== JSON.stringify(sourceSpec)
      || JSON.stringify(run.run.idempotencyLineage) !== JSON.stringify([...source.run.idempotencyLineage, key])
      || !sameCandidateSequence(run.frozenCandidates, source.frozenCandidates) || mappedRunIds.has(run.run.id)) {
      throw new Error('定向牛客状态文件格式无效');
    }
    mappedRunIds.add(run.run.id);
  }
  if (mappedRunIds.size !== runs.length) throw new Error('定向牛客状态文件格式无效');
  return {
    envelope: { version: 1, sessions, runs, startIdempotency, retryIdempotency },
    converged,
  };
}

function toPublic(run: StoredNowcoderDirectedRun): PublicNowcoderDirectedRun {
  const { currentJobIds: _currentJobIds, deliveryItems: _deliveryItems, idempotencyLineage: _idempotencyLineage,
    retryOf: _retryOf, recovery: _recovery, observedRuntimeIds: _observedRuntimeIds, ...publicRun } = run;
  return publicNowcoderDirectedRunSchema.parse(publicRun);
}

function fingerprint(value: unknown): string {
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isTerminal(status: StoredNowcoderDirectedRun['status']): boolean {
  return status === 'cancelled' || status === 'completed' || status === 'completed_with_attention' || status === 'failed';
}

export class NowcoderDirectedStore {
  private mutationQueue: Promise<void> = Promise.resolve();

  private constructor(
    public readonly path: string,
    private envelope: StoreEnvelope,
    private readonly dependencies: NowcoderDirectedStoreDependencies,
  ) {}

  static async open(path: string, overrides: Partial<NowcoderDirectedStoreDependencies> = {}): Promise<NowcoderDirectedStore> {
    const dependencies: NowcoderDirectedStoreDependencies = {
      now: () => new Date().toISOString(),
      id: () => randomUUID(),
      attempt: () => randomBytes(8).toString('hex'),
      atomicWrite: writeEnvelope,
      ...overrides,
    };
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new NowcoderDirectedStore(path, emptyEnvelope(), dependencies);
      }
      throw error;
    }
    try {
      const parsed = parseEnvelope(JSON.parse(raw) as unknown, dependencies.now(), true);
      if (parsed.converged) await dependencies.atomicWrite(path, parsed.envelope);
      return new NowcoderDirectedStore(path, parsed.envelope, dependencies);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('定向牛客状态文件格式无效');
      throw error;
    }
  }

  getSession(id: string): NowcoderSearchSession | undefined {
    const item = this.envelope.sessions.find(session => session.session.id === id);
    return item ? structuredClone(item.session) : undefined;
  }

  getRun(id: string): PublicNowcoderDirectedRun | undefined {
    const item = this.envelope.runs.find(run => run.run.id === id);
    return item ? toPublic(structuredClone(item.run)) : undefined;
  }

  publisherSnapshotCurrent(
    id: string,
    attempt: StoredNowcoderDirectedRun['attempt'],
  ): NowcoderDirectedPublisherSnapshot {
    const item = this.requirePrivateRun(id);
    if (item.run.attempt !== attempt) throw new Error('定向运行尝试已过期');
    const publisherState = item.run.status === 'publishing'
      || item.run.status === 'completed'
      || (item.run.status === 'running' && item.run.phase === 'staging');
    if (!publisherState) throw new Error('定向发布状态无效');
    assertPrivateCheckpoint(item);
    return {
      id: item.run.id,
      attempt: item.run.attempt,
      status: item.run.status,
      phase: item.run.phase,
      target: item.run.spec.target,
      deliveryItems: structuredClone(item.run.deliveryItems),
    };
  }

  selectionCheckpointFingerprint(
    id: string,
    attempt: StoredNowcoderDirectedRun['attempt'],
  ): string | undefined {
    const item = this.envelope.runs.find(candidate => candidate.run.id === id && candidate.run.attempt === attempt);
    if (!item) return undefined;
    return JSON.stringify({
      status: item.run.status,
      phase: item.run.phase,
      candidateCursor: item.candidateCursor,
      currentJobIds: item.run.currentJobIds,
      currentRoundJobIds: item.currentRoundJobIds,
      scheduledCandidateIds: item.run.scheduledCandidateIds,
      progress: item.run.progress,
      accepted: item.run.accepted,
      deliveryItems: item.run.deliveryItems,
      historyDigest: item.run.status === 'running' ? item.historyDigest : undefined,
      attentionCode: item.run.attentionReason?.code,
    });
  }

  reconciliationSnapshots(): NowcoderDirectedReconciliationSnapshot[] {
    return this.envelope.runs
      .filter(item => !isTerminal(item.run.status))
      .map(item => ({
        id: item.run.id,
        attempt: item.run.attempt,
        status: item.run.status,
        phase: item.run.phase,
        spec: {
          target: item.run.spec.target,
          maxDetails: item.run.spec.maxDetails,
        },
        frozenCandidates: structuredClone(item.frozenCandidates),
        candidateCursor: item.candidateCursor,
        currentJobIds: [...item.run.currentJobIds],
        currentRoundJobIds: [...item.currentRoundJobIds],
        buildEvidence: structuredClone(item.run.buildEvidence),
        observedRuntimeIds: [...item.run.observedRuntimeIds],
        scheduledCandidateIds: [...item.run.scheduledCandidateIds],
        dispatchedJobIds: [...item.dispatchedJobIds],
        tabClearEvidence: structuredClone(item.tabClearEvidence),
        progress: structuredClone(item.run.progress),
        ...(item.run.status === 'running' && item.historySnapshot
          ? { historySnapshot: structuredClone(item.historySnapshot) }
          : {}),
        ...(item.run.status === 'running' && item.historyDigest ? { historyDigest: item.historyDigest } : {}),
      }));
  }

  hasActiveRun(): boolean {
    return this.envelope.runs.some(item => !isTerminal(item.run.status));
  }

  privateRunEvidence(id: string): {
    attempt: StoredNowcoderDirectedRun['attempt'];
    buildEvidence: NowcoderDirectedBuildEvidence;
    observedRuntimeIds: string[];
  } | undefined {
    const item = this.envelope.runs.find(candidate => candidate.run.id === id);
    return item ? {
      attempt: item.run.attempt,
      buildEvidence: structuredClone(item.run.buildEvidence),
      observedRuntimeIds: [...item.run.observedRuntimeIds],
    } : undefined;
  }

  createSession(session: NowcoderSearchSession, options: CreateNowcoderSessionOptions = {}): Promise<NowcoderSearchSession> {
    return this.mutate(async () => {
      const parsed = nowcoderSearchSessionSchema.parse(session);
      const target = options.target ?? Math.min(10, Math.max(1, parsed.candidates.length));
      if (!Number.isInteger(target) || target < 1 || target > 10) throw new Error('目标数量必须在 1–10 之间');
      const existing = this.envelope.sessions.find(item => item.session.id === parsed.id);
      if (existing) {
        if (fingerprint(existing.session) !== fingerprint(parsed) || existing.target !== target) throw new Error('搜索会话 ID 已用于不同请求');
        return structuredClone(existing.session);
      }
      if (Date.parse(parsed.expiresAt) !== Date.parse(parsed.createdAt) + 30 * 60 * 1_000) {
        throw new Error('搜索会话有效期必须为 30 分钟');
      }
      this.envelope.sessions.push({ session: parsed, target });
      return structuredClone(parsed);
    });
  }

  findStartReplay(rawRequest: NowcoderDirectedStartRequest): Promise<PublicNowcoderDirectedRun | undefined> {
    return this.committedRead(() => {
      const request = nowcoderDirectedStartRequestSchema.parse(rawRequest);
      const requestFingerprint = fingerprint(request);
      const known = this.envelope.startIdempotency[request.idempotencyKey];
      if (!known) {
        if (this.envelope.retryIdempotency[request.idempotencyKey]) throw new Error('幂等键已用于不同请求');
        return undefined;
      }
      if (known.fingerprint !== requestFingerprint) throw new Error('幂等键已用于不同请求');
      return toPublic(structuredClone(this.requirePrivateRun(known.runId).run));
    });
  }

  startRun(
    rawRequest: NowcoderDirectedStartRequest,
    evidence: NowcoderDirectedAttemptEvidence,
  ): Promise<PublicNowcoderDirectedRun> {
    return this.startRunAtomic(rawRequest, evidence).then(result => result.run);
  }

  startRunAtomic(
    rawRequest: NowcoderDirectedStartRequest,
    rawEvidence: NowcoderDirectedAttemptEvidence,
  ): Promise<NowcoderDirectedMutationResult> {
    return this.mutate(async () => {
      const request = nowcoderDirectedStartRequestSchema.parse(rawRequest);
      const evidence = this.parseAttemptEvidence(rawEvidence);
      const requestFingerprint = fingerprint(request);
      const known = this.envelope.startIdempotency[request.idempotencyKey];
      if (known) {
        if (known.fingerprint !== requestFingerprint) throw new Error('幂等键已用于不同请求');
        const replay = this.requirePrivateRun(known.runId);
        return { run: toPublic(structuredClone(replay.run)), created: false };
      }
      if (this.envelope.retryIdempotency[request.idempotencyKey]) throw new Error('幂等键已用于不同请求');
      const session = this.requireSession(request.searchSessionId);
      if (Date.parse(this.dependencies.now()) >= Date.parse(session.session.expiresAt)) throw new Error('搜索会话已过期');
      const selected = new Set(request.selectedCandidateIds);
      if (selected.size !== request.selectedCandidateIds.length || [...selected].some(id => !session.session.candidates.some(candidate => candidate.id === id))) {
        throw new Error('所选候选不属于搜索会话');
      }
      this.assertNoActiveRun();
      const id = this.dependencies.id();
      const attempt = nowcoderDirectedRunAttemptSchema.parse(this.dependencies.attempt());
      const frozenCandidates = [
        ...request.selectedCandidateIds.map(candidateId => session.session.candidates.find(candidate => candidate.id === candidateId) as NowcoderSearchCandidate),
        ...session.session.candidates.filter(candidate => !selected.has(candidate.id)),
      ];
      const run: StoredNowcoderDirectedRun = {
        id,
        attempt,
        status: 'running',
        phase: 'collecting',
        scheduledCandidateIds: [],
        progress: {
          discovered: frozenCandidates.length,
          detailScheduled: 0,
          detailSaved: 0,
          inspected: 0,
          qualified: 0,
          accepted: 0,
          delivered: 0,
          rejectionCounts: [],
          companies: emptyCompanies(),
        },
        spec: {
          queries: session.session.queries,
          queryHash: session.session.queryHash,
          target: session.target,
          sort: 'latest',
          maxDetails: 24,
          searchSessionId: session.session.id,
          idempotencyKey: request.idempotencyKey,
          deliveryMode: 'agent-journey-inbox',
        },
        accepted: 0,
        delivered: 0,
        deliveryIds: [],
        publicDeliveryItems: [],
        activeOwnedTabs: 0,
        peakOwnedTabs: 0,
        terminalOwnedTabs: 0,
        buildEvidence: evidence.buildEvidence,
        currentJobIds: [],
        deliveryItems: [],
        idempotencyLineage: [request.idempotencyKey],
        observedRuntimeIds: [evidence.runtimeId],
      };
      storedNowcoderDirectedRunSchema.parse(run);
      this.envelope.runs.push({
        run, frozenCandidates, candidateCursor: 0, currentRoundJobIds: [],
        deliveryAuthorized: true, selectionAuditComplete: false, privateRejections: [],
        dispatchedJobIds: [], tabClearEvidence: [],
      });
      this.envelope.startIdempotency[request.idempotencyKey] = { fingerprint: requestFingerprint, runId: id };
      return { run: toPublic(run), created: true };
    });
  }

  findRetryReplay(
    runId: string,
    rawRequest: NowcoderDirectedRetryRequest,
  ): Promise<PublicNowcoderDirectedRun | undefined> {
    return this.committedRead(() => {
      const request = nowcoderDirectedRetryRequestSchema.parse(rawRequest);
      const requestFingerprint = fingerprint({ runId, ...request });
      if (this.envelope.startIdempotency[request.idempotencyKey]) throw new Error('重试必须使用新的幂等键');
      const known = this.envelope.retryIdempotency[request.idempotencyKey];
      if (!known) return undefined;
      if (known.fingerprint !== requestFingerprint) throw new Error('幂等键已用于不同请求');
      return toPublic(structuredClone(this.requirePrivateRun(known.runId).run));
    });
  }

  retryRun(
    runId: string,
    rawRequest: NowcoderDirectedRetryRequest,
    evidence: NowcoderDirectedAttemptEvidence,
  ): Promise<PublicNowcoderDirectedRun> {
    return this.retryRunAtomic(runId, rawRequest, evidence).then(result => result.run);
  }

  retryRunAtomic(
    runId: string,
    rawRequest: NowcoderDirectedRetryRequest,
    rawEvidence: NowcoderDirectedAttemptEvidence,
  ): Promise<NowcoderDirectedMutationResult> {
    return this.mutate(async () => {
      const request = nowcoderDirectedRetryRequestSchema.parse(rawRequest);
      const evidence = this.parseAttemptEvidence(rawEvidence);
      const requestFingerprint = fingerprint({ runId, ...request });
      const startUse = this.envelope.startIdempotency[request.idempotencyKey];
      if (startUse) throw new Error('重试必须使用新的幂等键');
      const known = this.envelope.retryIdempotency[request.idempotencyKey];
      if (known) {
        if (known.fingerprint !== requestFingerprint) throw new Error('幂等键已用于不同请求');
        return { run: toPublic(structuredClone(this.requirePrivateRun(known.runId).run)), created: false };
      }
      const source = this.requirePrivateRun(runId);
      if (!isTerminal(source.run.status)) throw new Error('已有活跃定向运行');
      this.assertNoActiveRun();
      const id = this.dependencies.id();
      const attempt = nowcoderDirectedRunAttemptSchema.parse(this.dependencies.attempt());
      const run: StoredNowcoderDirectedRun = {
        ...structuredClone(source.run),
        id,
        attempt,
        status: 'running',
        phase: 'collecting',
        scheduledCandidateIds: [],
        progress: {
          discovered: source.frozenCandidates.length,
          detailScheduled: 0,
          detailSaved: 0,
          inspected: 0,
          qualified: 0,
          accepted: 0,
          delivered: 0,
          rejectionCounts: [],
          companies: emptyCompanies(),
        },
        spec: { ...source.run.spec, idempotencyKey: request.idempotencyKey },
        accepted: 0,
        delivered: 0,
        deliveryIds: [],
        publicDeliveryItems: [],
        activeOwnedTabs: 0,
        peakOwnedTabs: 0,
        terminalOwnedTabs: 0,
        buildEvidence: evidence.buildEvidence,
        currentJobIds: [],
        deliveryItems: [],
        idempotencyLineage: [...source.run.idempotencyLineage, request.idempotencyKey],
        retryOf: source.run.id,
        observedRuntimeIds: [evidence.runtimeId],
      };
      delete run.attentionReason;
      delete run.summary;
      delete run.actionable;
      delete run.publishReceipt;
      delete run.verifiedMarkerHash;
      delete run.recovery;
      storedNowcoderDirectedRunSchema.parse(run);
      this.envelope.runs.push({
        run,
        frozenCandidates: structuredClone(source.frozenCandidates),
        candidateCursor: 0,
        currentRoundJobIds: [],
        deliveryAuthorized: true,
        selectionAuditComplete: false,
        privateRejections: [],
        dispatchedJobIds: [],
        tabClearEvidence: [],
      });
      this.envelope.retryIdempotency[request.idempotencyKey] = { fingerprint: requestFingerprint, runId: id };
      return { run: toPublic(run), created: true };
    });
  }

  beginCancellationCurrent(
    id: string,
    attempt: StoredNowcoderDirectedRun['attempt'],
  ): Promise<PublicNowcoderDirectedRun> {
    return this.mutate(async () => {
      const item = this.requirePrivateRun(id);
      if (item.run.attempt !== attempt) throw new Error('定向运行尝试已过期');
      if (item.run.status === 'cancelling' || item.run.status === 'cancelled') {
        return toPublic(item.run);
      }
      if (item.run.status !== 'running') {
        throw new Error('定向运行已越过取消截止点');
      }
      item.run.status = 'cancelling';
      storedNowcoderDirectedRunSchema.parse(item.run);
      assertPrivateCheckpoint(item);
      return toPublic(item.run);
    });
  }

  recordDispatchedJobCurrent(
    id: string,
    attempt: StoredNowcoderDirectedRun['attempt'],
    jobId: string,
  ): Promise<PublicNowcoderDirectedRun> {
    return this.mutate(async () => {
      const item = this.requirePrivateRun(id);
      if (item.run.attempt !== attempt || item.run.status !== 'running') {
        throw new Error('定向运行尝试已过期');
      }
      if (!item.run.currentJobIds.includes(jobId)) throw new Error('任务不属于当前定向运行');
      if (item.tabClearEvidence.some(evidence => evidence.jobId === jobId)) {
        throw new Error('任务已形成关页证据，不能重新派发');
      }
      if (!item.dispatchedJobIds.includes(jobId)) item.dispatchedJobIds.push(jobId);
      assertPrivateCheckpoint(item);
      return toPublic(item.run);
    });
  }

  recordTabClearEvidenceCurrent(
    id: string,
    attempt: StoredNowcoderDirectedRun['attempt'],
    jobId: string,
    kind: NowcoderDirectedTabClearKind,
  ): Promise<PublicNowcoderDirectedRun> {
    return this.mutate(async () => {
      const item = this.requirePrivateRun(id);
      const allowedWhileRunning = item.run.status === 'running'
        && kind === 'remote_terminal_after_close';
      if (item.run.attempt !== attempt
        || (item.run.status !== 'cancelling' && !allowedWhileRunning)) {
        throw new Error('定向运行尝试已过期');
      }
      if (!item.run.currentJobIds.includes(jobId) || !TAB_CLEAR_KINDS.has(kind)) {
        throw new Error('取消关页证据不属于当前运行');
      }
      const existing = item.tabClearEvidence.find(evidence => evidence.jobId === jobId);
      if (existing) {
        if (existing.kind !== kind) throw new Error('同一任务的关页证据冲突');
        return toPublic(item.run);
      }
      const dispatched = item.dispatchedJobIds.includes(jobId);
      if ((kind === 'never_dispatched') === dispatched) {
        throw new Error('取消关页证据与派发记录冲突');
      }
      item.tabClearEvidence.push({ jobId, kind });
      assertPrivateCheckpoint(item);
      return toPublic(item.run);
    });
  }

  hasCompleteTabClearEvidence(
    id: string,
    attempt: StoredNowcoderDirectedRun['attempt'],
  ): boolean {
    const item = this.envelope.runs.find(candidate =>
      candidate.run.id === id && candidate.run.attempt === attempt);
    if (!item) return false;
    const proven = new Set(item.tabClearEvidence.map(evidence => evidence.jobId));
    return item.run.currentJobIds.every(jobId => proven.has(jobId));
  }

  ownsAttemptJob(
    id: string,
    attempt: StoredNowcoderDirectedRun['attempt'],
    jobId: string,
    url: string,
  ): boolean {
    const item = this.envelope.runs.find(candidate =>
      candidate.run.id === id && candidate.run.attempt === attempt);
    if (!item) return false;
    const index = item.run.currentJobIds.indexOf(jobId);
    const candidate = index >= 0 ? item.frozenCandidates[index] : undefined;
    return Boolean(candidate
      && candidate.canonicalUrl === url
      && nowcoderDirectedJobId(id, attempt, url) === jobId);
  }

  completeCancellationCurrent(
    id: string,
    attempt: StoredNowcoderDirectedRun['attempt'],
    detailSaved: number,
  ): Promise<PublicNowcoderDirectedRun> {
    return this.mutate(async () => {
      const item = this.requirePrivateRun(id);
      if (item.run.attempt !== attempt) throw new Error('定向运行尝试已过期');
      if (item.run.status === 'cancelled') return toPublic(item.run);
      if (item.run.status !== 'cancelling') throw new Error('定向运行尚未进入取消状态');
      if (!Number.isInteger(detailSaved) || detailSaved < 0 || detailSaved > item.run.currentJobIds.length) {
        throw new Error('已保存详情计数无效');
      }
      if (item.run.activeOwnedTabs !== 0 || item.run.terminalOwnedTabs !== 0) {
        throw new Error('当前尝试仍有 owned tab 证据，不能完成取消');
      }
      const proven = new Set(item.tabClearEvidence.map(evidence => evidence.jobId));
      if (!item.run.currentJobIds.every(jobId => proven.has(jobId))) {
        throw new Error('当前尝试的关页证据不完整');
      }
      item.run.status = 'cancelled';
      item.run.accepted = 0;
      item.run.delivered = 0;
      item.run.deliveryIds = [];
      item.run.deliveryItems = [];
      item.run.publicDeliveryItems = [];
      item.run.progress = {
        ...item.run.progress,
        detailSaved,
        qualified: 0,
        accepted: 0,
        delivered: 0,
        rejectionCounts: [],
        companies: emptyCompanies(),
      };
      item.selectionAuditComplete = false;
      item.privateRejections = [];
      delete item.run.attentionReason;
      delete item.run.publishReceipt;
      delete item.run.verifiedMarkerHash;
      delete item.run.recovery;
      item.run.summary = '牛客定向采集已取消';
      item.run.actionable = '如需继续，请使用新的幂等键发起重试运行';
      storedNowcoderDirectedRunSchema.parse(item.run);
      assertPrivateCheckpoint(item);
      return toPublic(item.run);
    });
  }

  markTerminalCurrent(
    id: string,
    attempt: StoredNowcoderDirectedRun['attempt'],
    status: 'completed' | 'failed',
  ): Promise<PublicNowcoderDirectedRun> {
    return this.mutate(async () => {
      const item = this.requirePrivateRun(id);
      if (item.run.attempt !== attempt || item.run.status !== 'running') {
        throw new Error('定向运行尝试已过期');
      }
      item.run.status = status;
      item.run.activeOwnedTabs = 0;
      item.run.terminalOwnedTabs = 0;
      delete item.run.attentionReason;
      storedNowcoderDirectedRunSchema.parse(item.run);
      return toPublic(item.run);
    });
  }

  markAttentionCurrent(
    id: string,
    attempt: StoredNowcoderDirectedRun['attempt'],
    rawReason: NowcoderDirectedAttentionReason,
    detailSaved?: number,
  ): Promise<PublicNowcoderDirectedRun> {
    return this.mutate(async () => {
      const item = this.requirePrivateRun(id);
      if (item.run.attempt !== attempt || item.run.status !== 'running') throw new Error('定向运行尝试已过期');
      const reason = nowcoderDirectedAttentionReasonSchema.parse(rawReason);
      item.run.status = 'completed_with_attention';
      item.run.activeOwnedTabs = 0;
      item.run.terminalOwnedTabs = 0;
      item.run.delivered = 0;
      item.run.deliveryIds = [];
      item.run.publicDeliveryItems = [];
      item.run.deliveryItems = [];
      item.run.accepted = 0;
      item.run.progress = {
        ...item.run.progress,
        ...(detailSaved === undefined ? {} : { detailSaved }),
        inspected: 0,
        qualified: 0,
        accepted: 0,
        delivered: 0,
        rejectionCounts: [],
        companies: emptyCompanies(),
      };
      item.selectionAuditComplete = false;
      item.privateRejections = [];
      delete item.run.publishReceipt;
      item.run.attentionReason = reason;
      item.run.summary = reason.message;
      item.run.actionable = '请确认本机环境后使用新的重试运行';
      storedNowcoderDirectedRunSchema.parse(item.run);
      return toPublic(item.run);
    });
  }

  recordObservedRuntime(
    id: string,
    attempt: StoredNowcoderDirectedRun['attempt'],
    runtimeId: string,
  ): Promise<PublicNowcoderDirectedRun> {
    return this.mutate(async () => {
      const item = this.requirePrivateRun(id);
      if (item.run.attempt !== attempt || item.run.status !== 'running') throw new Error('定向运行尝试已过期');
      const parsedRuntimeId = z.string().uuid().parse(runtimeId);
      if (!item.run.observedRuntimeIds.includes(parsedRuntimeId)) {
        item.run.observedRuntimeIds.push(parsedRuntimeId);
      }
      storedNowcoderDirectedRunSchema.parse(item.run);
      return toPublic(item.run);
    });
  }

  checkpointRun(id: string, checkpoint: NowcoderDirectedRunCheckpoint): Promise<PublicNowcoderDirectedRun> {
    return this.mutate(async () => {
      const item = this.requirePrivateRun(id);
      if (item.run.status !== 'running') throw new Error('定向运行尝试已过期');
      this.applyCheckpoint(item, checkpoint);
      return toPublic(item.run);
    });
  }

  /** Attempt-fenced checkpoint used by the Bridge service; old attempts cannot mutate a run. */
  checkpointCurrentRun(
    id: string,
    attempt: StoredNowcoderDirectedRun['attempt'],
    checkpoint: NowcoderDirectedRunCheckpoint,
  ): Promise<PublicNowcoderDirectedRun> {
    return this.mutate(async () => {
      const item = this.requirePrivateRun(id);
      if (item.run.attempt !== attempt || item.run.status !== 'running') {
        throw new Error('定向运行尝试已过期');
      }
      this.applyCheckpoint(item, checkpoint);
      return toPublic(item.run);
    });
  }

  /** Task 8 publisher entry is a single validated cutover from an exact staging checkpoint. */
  beginPublishingCurrent(
    id: string,
    attempt: StoredNowcoderDirectedRun['attempt'],
  ): Promise<PublicNowcoderDirectedRun> {
    return this.mutate(async () => {
      const item = this.requirePrivateRun(id);
      if (item.run.attempt !== attempt
        || item.run.status !== 'running'
        || item.run.phase !== 'staging') {
        throw new Error('定向发布截止点状态无效');
      }
      assertPrivateCheckpoint(item);
      item.run.status = 'publishing';
      item.run.phase = 'publishing';
      storedNowcoderDirectedRunSchema.parse(item.run);
      assertPrivateCheckpoint(item);
      return toPublic(item.run);
    });
  }

  completePublishedCurrent(
    id: string,
    attempt: StoredNowcoderDirectedRun['attempt'],
  ): Promise<PublicNowcoderDirectedRun> {
    return this.mutate(async () => {
      const item = this.requirePrivateRun(id);
      if (item.run.attempt !== attempt) throw new Error('定向运行尝试已过期');
      if (item.run.status === 'completed') return toPublic(item.run);
      if (item.run.status !== 'publishing' || item.run.phase !== 'publishing') {
        throw new Error('定向发布完成状态无效');
      }
      assertPrivateCheckpoint(item);
      const deliveryItems = structuredClone(item.run.deliveryItems);
      if (deliveryItems.length !== item.run.spec.target) {
        throw new Error('定向发布条目数量不等于目标');
      }
      const publicDeliveryItems = deliveryItems.map(deliveryItem => ({
        stableContentId: deliveryItem.stableContentId,
        canonicalUrl: deliveryItem.canonicalUrl,
        contentHash: deliveryItem.contentHash,
        clusterId: deliveryItem.clusterId,
        lineageId: sha256({
          kind: 'nowcoder-directed-lineage-v1',
          runId: item.run.id,
          attempt: item.run.attempt,
          item: {
            stableContentId: deliveryItem.stableContentId,
            canonicalUrl: deliveryItem.canonicalUrl,
            contentHash: deliveryItem.contentHash,
            clusterId: deliveryItem.clusterId,
          },
        }),
      }));
      const markerHash = sha256({
        kind: 'nowcoder-directed-publish-v1',
        runId: item.run.id,
        attempt: item.run.attempt,
        items: publicDeliveryItems.map(({ lineageId: _lineageId, ...deliveryItem }) => deliveryItem),
      });
      item.run.status = 'completed';
      item.run.delivered = item.run.spec.target;
      item.run.deliveryIds = deliveryItems.map(deliveryItem => deliveryItem.stableContentId);
      item.run.publicDeliveryItems = publicDeliveryItems;
      item.run.publishReceipt = {
        deliveryIds: [...item.run.deliveryIds],
        entryHashes: deliveryItems.map(deliveryItem => deliveryItem.contentHash),
        markerHash,
        publishedAt: this.dependencies.now(),
      };
      item.run.activeOwnedTabs = 0;
      item.run.terminalOwnedTabs = 0;
      item.run.progress = {
        ...item.run.progress,
        delivered: item.run.spec.target,
      };
      delete item.run.attentionReason;
      delete item.run.verifiedMarkerHash;
      delete item.run.recovery;
      item.run.summary = `已精确交付 ${item.run.spec.target} 篇牛客 Agent 面经`;
      item.run.actionable = '当前批次已完成，可按运行 ID 读取交付清单';
      storedNowcoderDirectedRunSchema.parse(item.run);
      assertPrivateCheckpoint(item);
      return toPublic(item.run);
    });
  }

  persistHistorySnapshotCurrent(
    id: string,
    attempt: StoredNowcoderDirectedRun['attempt'],
    snapshot: ProcessedNowcoderHistorySnapshot,
    digest: string,
  ): Promise<{ snapshot: ProcessedNowcoderHistorySnapshot; digest: string }> {
    return this.mutate(async () => {
      const item = this.requirePrivateRun(id);
      if (item.run.attempt !== attempt || item.run.status !== 'running') {
        throw new Error('定向运行尝试已过期');
      }
      if (processedNowcoderHistoryDigest(snapshot) !== digest) {
        throw new Error('历史快照摘要无效');
      }
      if (item.historySnapshot || item.historyDigest) {
        if (!item.historySnapshot || !item.historyDigest
          || processedNowcoderHistoryDigest(item.historySnapshot) !== item.historyDigest) {
          throw new Error('历史快照摘要无效');
        }
        return { snapshot: structuredClone(item.historySnapshot), digest: item.historyDigest };
      }
      item.historySnapshot = structuredClone(snapshot);
      item.historyDigest = digest;
      assertPrivateCheckpoint(item);
      return { snapshot: structuredClone(snapshot), digest };
    });
  }

  markSelectionAttentionCurrent(
    id: string,
    attempt: StoredNowcoderDirectedRun['attempt'],
    rawReason: NowcoderDirectedAttentionReason,
    checkpoint: Pick<NowcoderDirectedRunCheckpoint, 'progress' | 'accepted' | 'privateRejections'>,
  ): Promise<PublicNowcoderDirectedRun> {
    return this.mutate(async () => {
      const item = this.requirePrivateRun(id);
      if (item.run.attempt !== attempt || item.run.status !== 'running') throw new Error('定向运行尝试已过期');
      const reason = nowcoderDirectedAttentionReasonSchema.parse(rawReason);
      if (reason.code !== 'DIRECTED_TARGET_UNAVAILABLE') throw new Error('筛选终态原因无效');
      if (!checkpoint.progress || checkpoint.accepted === undefined) throw new Error('筛选终态进度无效');
      const rejected = checkpoint.progress.rejectionCounts.reduce((sum, entry) => sum + entry.count, 0);
      if (rejected !== item.candidateCursor - checkpoint.accepted) {
        throw new Error('筛选终态拒绝计数不完整');
      }
      item.run.status = 'completed_with_attention';
      item.run.phase = reason.phase;
      item.run.activeOwnedTabs = 0;
      item.run.terminalOwnedTabs = 0;
      item.run.accepted = checkpoint.accepted;
      item.run.progress = structuredClone(checkpoint.progress);
      item.privateRejections = structuredClone(checkpoint.privateRejections ?? []);
      item.selectionAuditComplete = true;
      item.run.delivered = 0;
      item.run.deliveryIds = [];
      item.run.publicDeliveryItems = [];
      item.run.deliveryItems = [];
      delete item.run.publishReceipt;
      item.run.attentionReason = reason;
      item.run.summary = `目标 ${item.run.spec.target} 篇，当前仅筛得 ${checkpoint.accepted} 篇合格面经`;
      item.run.actionable = '请扩大同一搜索会话的候选范围后重试';
      storedNowcoderDirectedRunSchema.parse(item.run);
      return toPublic(item.run);
    });
  }

  private applyCheckpoint(
    item: PrivateNowcoderDirectedRun,
    checkpoint: NowcoderDirectedRunCheckpoint,
  ): void {
    if (checkpoint.phase === 'publishing') throw new Error('发布截止点必须使用专用原子转换');
    if (checkpoint.phase !== undefined) item.run.phase = checkpoint.phase;
    if (checkpoint.candidateCursor !== undefined) {
      if (!Number.isInteger(checkpoint.candidateCursor) || checkpoint.candidateCursor < 0
        || checkpoint.candidateCursor > item.frozenCandidates.length
        || checkpoint.candidateCursor > item.run.spec.maxDetails) {
        throw new Error('候选游标无效');
      }
      if (checkpoint.candidateCursor < item.candidateCursor) throw new Error('候选游标不能回退');
      item.candidateCursor = checkpoint.candidateCursor;
      item.run.scheduledCandidateIds = item.frozenCandidates
        .slice(0, checkpoint.candidateCursor)
        .map(candidate => candidate.id);
      item.run.progress = {
        ...item.run.progress,
        detailScheduled: checkpoint.candidateCursor,
      };
    }
    if (checkpoint.currentRoundJobIds !== undefined) {
      if (!checkpoint.currentRoundJobIds.every(jobId => jobId.length > 0) || !isUnique(checkpoint.currentRoundJobIds)) throw new Error('当前轮任务 ID 无效');
      item.currentRoundJobIds = [...checkpoint.currentRoundJobIds];
    }
    if (checkpoint.currentJobIds !== undefined) {
      if (!checkpoint.currentJobIds.every(jobId => jobId.length > 0) || !isUnique(checkpoint.currentJobIds)) throw new Error('任务 ID 无效');
      item.run.currentJobIds = [...checkpoint.currentJobIds];
    }
    if (checkpoint.progress !== undefined) item.run.progress = structuredClone(checkpoint.progress);
    if (checkpoint.accepted !== undefined) item.run.accepted = checkpoint.accepted;
    if (checkpoint.deliveryItems !== undefined) item.run.deliveryItems = structuredClone(checkpoint.deliveryItems);
    if (checkpoint.privateRejections !== undefined) item.privateRejections = structuredClone(checkpoint.privateRejections);
    if (checkpoint.progress !== undefined && checkpoint.privateRejections !== undefined) {
      item.selectionAuditComplete = true;
    }
    if (item.currentRoundJobIds.some(jobId => !item.run.currentJobIds.includes(jobId))) {
      throw new Error('当前轮任务必须属于当前任务');
    }
    assertPrivateCheckpoint(item);
    storedNowcoderDirectedRunSchema.parse(item.run);
  }

  private parseAttemptEvidence(raw: NowcoderDirectedAttemptEvidence): NowcoderDirectedAttemptEvidence {
    return {
      buildEvidence: nowcoderDirectedBuildEvidenceSchema.parse(raw.buildEvidence),
      runtimeId: z.string().uuid().parse(raw.runtimeId),
    };
  }

  private requireSession(id: string): StoredSession {
    const session = this.envelope.sessions.find(item => item.session.id === id);
    if (!session) throw new Error('搜索会话不存在');
    return session;
  }

  private requirePrivateRun(id: string): PrivateNowcoderDirectedRun {
    const run = this.envelope.runs.find(item => item.run.id === id);
    if (!run) throw new Error('定向运行不存在');
    return run;
  }

  private assertNoActiveRun(): void {
    if (this.envelope.runs.some(item => !isTerminal(item.run.status))) throw new Error('已有活跃定向运行');
  }

  private async mutate<T>(operation: () => Promise<T> | T): Promise<T> {
    const queued = this.mutationQueue.then(async () => {
      const previous = structuredClone(this.envelope);
      try {
        const result = await operation();
        parseEnvelope(this.envelope, this.dependencies.now());
        await this.dependencies.atomicWrite(this.path, this.envelope);
        return result;
      } catch (error) {
        this.envelope = previous;
        throw error;
      }
    });
    this.mutationQueue = queued.then(() => undefined, () => undefined);
    return await queued;
  }

  /** Replay decisions observe only state whose atomic write has already committed. */
  private async committedRead<T>(operation: () => T): Promise<T> {
    const queued = this.mutationQueue.then(operation);
    return await queued;
  }
}
