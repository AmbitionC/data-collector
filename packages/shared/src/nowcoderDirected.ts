import { z } from 'zod';

export const NOWCODER_DETAIL_CAPABILITY = 'nowcoder-detail-v1';
export const NOWCODER_DIRECTED_MAX_DETAILS = 24;
export const NOWCODER_DIRECTED_MAX_OWNED_TABS = 2;

export const NOWCODER_DIRECTED_RUN_STATUSES = [
  'running',
  'cancelling',
  'publishing',
  'cancelled',
  'completed',
  'completed_with_attention',
  'failed',
] as const;
export const nowcoderDirectedRunStatusSchema = z.enum(NOWCODER_DIRECTED_RUN_STATUSES);
export type NowcoderDirectedRunStatus = z.infer<typeof nowcoderDirectedRunStatusSchema>;

export const NOWCODER_DIRECTED_RUN_PHASES = [
  'collecting',
  'selecting',
  'staging',
  'publishing',
] as const;
export const nowcoderDirectedRunPhaseSchema = z.enum(NOWCODER_DIRECTED_RUN_PHASES);
export type NowcoderDirectedRunPhase = z.infer<typeof nowcoderDirectedRunPhaseSchema>;

export const nowcoderDirectedRunAttemptSchema = z.string().regex(/^[a-f0-9]{16}$/u);
export type NowcoderDirectedRunAttempt = z.infer<typeof nowcoderDirectedRunAttemptSchema>;

export const NOWCODER_DIRECTED_ATTENTION_CODES = [
  'DIRECTED_EXTENSION_OFFLINE',
  'DIRECTED_EXTENSION_RUNTIME_MISSING',
  'DIRECTED_EXTENSION_VERSION_CHANGED',
  'DIRECTED_EXTENSION_BUILD_CHANGED',
  'DIRECTED_EXTENSION_CAPABILITY_MISSING',
  'DIRECTED_EXTENSION_CAPABILITY_CHANGED',
  'DIRECTED_ARTIFACT_CHANGED',
  'DIRECTED_ARTIFACT_LEASE_FAILED',
  'DIRECTED_LOCAL_LIBRARY_CORRUPT',
  'DIRECTED_CANDIDATE_CATALOG_CORRUPT',
  'DIRECTED_HISTORY_CORRUPT',
  'DIRECTED_HISTORY_LIMIT_EXCEEDED',
  'DIRECTED_SELECTION_INVARIANT_FAILED',
  'DIRECTED_TARGET_UNAVAILABLE',
] as const;
export const nowcoderDirectedAttentionCodeSchema = z.enum(NOWCODER_DIRECTED_ATTENTION_CODES);
export type NowcoderDirectedAttentionCode = z.infer<typeof nowcoderDirectedAttentionCodeSchema>;

export const NOWCODER_DIRECTED_SELECTION_ATTENTION_MESSAGES = {
  DIRECTED_LOCAL_LIBRARY_CORRUPT: '本地面经库无法安全读取',
  DIRECTED_CANDIDATE_CATALOG_CORRUPT: '候选目录无法安全读取',
  DIRECTED_HISTORY_CORRUPT: '历史记录无法安全读取',
  DIRECTED_HISTORY_LIMIT_EXCEEDED: '历史记录超过安全处理上限',
  DIRECTED_SELECTION_INVARIANT_FAILED: '本批筛选状态校验失败',
  DIRECTED_TARGET_UNAVAILABLE: '在最多 24 篇详情中未筛得足量有效面经',
} as const satisfies Partial<Record<NowcoderDirectedAttentionCode, string>>;

const capabilityListSchema = z.array(z.string().trim().min(1).max(100)).max(20)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: '扩展能力必须唯一' });
    }
    const sorted = [...values].sort((left, right) => left.localeCompare(right));
    if (values.some((value, index) => value !== sorted[index])) {
      context.addIssue({ code: 'custom', message: '扩展能力必须规范排序' });
    }
  });

export const nowcoderDirectedBuildEvidenceSchema = z.object({
  applicationVersion: z.string().trim().regex(/^\d+\.\d+\.\d+$/u).max(50),
  /** Bridge 进程启动时捕获的部署来源 build-id，不是 Git HEAD。 */
  bridgeBuildId: z.string().trim().min(1).max(200),
  artifactBuildId: z.string().trim().min(1).max(200),
  extensionVersion: z.string().trim().regex(/^\d+\.\d+\.\d+$/u).max(50),
  extensionBuildId: z.string().trim().min(1).max(200),
  extensionCapabilities: capabilityListSchema,
  frozenAt: z.iso.datetime(),
}).strict();
export type NowcoderDirectedBuildEvidence = z.infer<typeof nowcoderDirectedBuildEvidenceSchema>;

export const nowcoderDirectedAttentionReasonSchema = z.object({
  code: nowcoderDirectedAttentionCodeSchema,
  message: z.string().trim().min(1).max(2_000),
  at: z.iso.datetime(),
  phase: nowcoderDirectedRunPhaseSchema,
}).strict().superRefine((reason, context) => {
  const expected = NOWCODER_DIRECTED_SELECTION_ATTENTION_MESSAGES[
    reason.code as keyof typeof NOWCODER_DIRECTED_SELECTION_ATTENTION_MESSAGES
  ];
  if (expected !== undefined && reason.message !== expected) {
    context.addIssue({ code: 'custom', path: ['message'], message: '筛选处理原因文案与代码不匹配' });
  }
});
export type NowcoderDirectedAttentionReason = z.infer<typeof nowcoderDirectedAttentionReasonSchema>;

export const NOWCODER_DIRECTED_REJECTION_MESSAGES = {
  LOCAL_SNAPSHOT_INVALID: '本批详情快照校验失败',
  SOURCE_HISTORY_DUPLICATE: '该内容已在历史批次处理',
  OUTSIDE_30_DAYS: '内容不在最近 30 天范围内',
  AGENT_RELEVANCE_INSUFFICIENT: '内容与 Agent 研发岗位关联不足',
  NON_AGENT_ROLE: '内容不是 Agent 研发岗位面经',
  EVIDENCE_GRADE_INSUFFICIENT: '内容证据不足以形成有效面经',
  DUPLICATE_CLUSTER: '内容与本批其他面经重复',
  DUPLICATE_QUESTION_SEQUENCE: '题目序列与本批其他面经重复',
  DETAIL_FAILED: '详情收集失败',
  DETAIL_NEEDS_ATTENTION: '详情收集需要人工确认',
  DETAIL_NOT_SAVED: '详情尚未形成可验证快照',
  TARGET_TRUNCATED: '已达到本批目标数量',
} as const;
export type NowcoderDirectedRejectionCode = keyof typeof NOWCODER_DIRECTED_REJECTION_MESSAGES;

export const NOWCODER_DIRECTED_COMPANIES = [
  'bytedance', 'tencent', 'alibaba', 'ant', 'other',
] as const;

export const nowcoderDirectedRejectionCountSchema = z.object({
  code: z.enum(Object.keys(NOWCODER_DIRECTED_REJECTION_MESSAGES) as [NowcoderDirectedRejectionCode, ...NowcoderDirectedRejectionCode[]]),
  message: z.string(),
  count: z.number().int().positive(),
}).strict().superRefine((value, context) => {
  if (value.message !== NOWCODER_DIRECTED_REJECTION_MESSAGES[value.code]) {
    context.addIssue({ code: 'custom', path: ['message'], message: '拒绝原因文案与代码不匹配' });
  }
});

export const nowcoderDirectedCompanyCountSchema = z.object({
  company: z.enum(NOWCODER_DIRECTED_COMPANIES),
  count: z.number().int().nonnegative(),
}).strict();

export const nowcoderDirectedProgressSchema = z.object({
  discovered: z.number().int().nonnegative().max(500),
  detailScheduled: z.number().int().nonnegative().max(NOWCODER_DIRECTED_MAX_DETAILS),
  detailSaved: z.number().int().nonnegative().max(NOWCODER_DIRECTED_MAX_DETAILS),
  inspected: z.number().int().nonnegative().max(NOWCODER_DIRECTED_MAX_DETAILS),
  qualified: z.number().int().nonnegative().max(NOWCODER_DIRECTED_MAX_DETAILS),
  accepted: z.number().int().nonnegative().max(10),
  delivered: z.number().int().nonnegative().max(10),
  rejectionCounts: z.array(nowcoderDirectedRejectionCountSchema).max(12),
  companies: z.array(nowcoderDirectedCompanyCountSchema).length(NOWCODER_DIRECTED_COMPANIES.length),
}).strict().superRefine((progress, context) => {
  if (!(progress.delivered <= progress.accepted
    && progress.accepted <= progress.qualified
    && progress.qualified <= progress.inspected
    && progress.inspected <= progress.detailSaved
    && progress.detailSaved <= progress.detailScheduled
    && progress.detailScheduled <= progress.discovered)) {
    context.addIssue({ code: 'custom', message: '定向运行进度计数顺序无效' });
  }
  const expectedCompanies = NOWCODER_DIRECTED_COMPANIES;
  if (progress.companies.some((item, index) => item.company !== expectedCompanies[index])) {
    context.addIssue({ code: 'custom', path: ['companies'], message: '公司计数顺序无效' });
  }
  if (progress.companies.reduce((sum, item) => sum + item.count, 0) !== progress.accepted) {
    context.addIssue({ code: 'custom', path: ['companies'], message: '公司计数必须等于 accepted' });
  }
  const codes = progress.rejectionCounts.map(item => item.code);
  const sortedCodes = [...codes].sort();
  if (new Set(codes).size !== codes.length || codes.some((code, index) => code !== sortedCodes[index])) {
    context.addIssue({ code: 'custom', path: ['rejectionCounts'], message: '拒绝计数必须按代码唯一排序' });
  }
});
export type NowcoderDirectedProgress = z.infer<typeof nowcoderDirectedProgressSchema>;

const controlCharacter = /[\u0000-\u001F\u007F-\u009F]/u;
const opaqueIdSchema = z.string().trim().min(1).max(200);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const storedContentHashSchema = z.string().regex(/^[a-f0-9]{16}$/u);
const canonicalNowcoderUrlSchema = z.string().url().max(4_096).superRefine((value, context) => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'www.nowcoder.com' || url.username || url.password) {
      context.addIssue({ code: 'custom', message: '必须是规范的牛客 HTTPS 详情 URL' });
    }
  } catch {
    context.addIssue({ code: 'custom', message: '必须是规范的牛客 HTTPS 详情 URL' });
  }
});

/** Canonical query identity for dedupe and the deterministic query hash. */
export function normalizeNowcoderDirectedQueries(values: readonly string[]): string[] {
  if (values.length < 1 || values.length > 12) {
    throw new RangeError('定向牛客查询数量必须在 1–12 之间');
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (controlCharacter.test(value)) throw new RangeError('查询不能包含控制字符');
    const query = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
    if (query.length < 1 || query.length > 80) {
      throw new RangeError('规范化查询长度必须在 1–80 之间');
    }
    if (!seen.has(query)) {
      seen.add(query);
      normalized.push(query);
    }
  }
  if (normalized.reduce((total, query) => total + query.length, 0) > 480) {
    throw new RangeError('规范化查询总长度不能超过 480');
  }
  return normalized;
}

const nowcoderQueriesSchema = z.array(z.string()).superRefine((values, context) => {
  try {
    normalizeNowcoderDirectedQueries(values);
  } catch (error) {
    context.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : '查询不合法',
    });
  }
}).transform(values => normalizeNowcoderDirectedQueries(values));

export const nowcoderSearchRequestSchema = z.object({
  queries: nowcoderQueriesSchema,
  target: z.number().int().min(1).max(10),
  sort: z.literal('latest'),
}).strict();
export type NowcoderSearchRequest = z.infer<typeof nowcoderSearchRequestSchema>;

export const nowcoderSearchCandidateSchema = z.object({
  id: opaqueIdSchema,
  canonicalUrl: canonicalNowcoderUrlSchema,
  contentType: z.literal('post'),
  matchedQueries: z.array(z.string().trim().min(1).max(80)).min(1).max(12),
  page: z.number().int().min(1).max(100),
  rank: z.number().int().min(1).max(100),
  publishedAt: z.iso.datetime(),
}).strict();
export type NowcoderSearchCandidate = z.infer<typeof nowcoderSearchCandidateSchema>;

export const nowcoderSearchSessionSchema = z.object({
  id: opaqueIdSchema,
  queries: nowcoderQueriesSchema,
  queryHash: hashSchema,
  requestedSort: z.literal('latest'),
  provider: z.literal('nowcoder-json'),
  sortVerified: z.literal(true),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  candidates: z.array(nowcoderSearchCandidateSchema).max(500),
}).strict().superRefine((session, context) => {
  const ids = new Set<string>();
  const urls = new Set<string>();
  for (const [index, candidate] of session.candidates.entries()) {
    if (ids.has(candidate.id)) context.addIssue({ code: 'custom', path: ['candidates', index, 'id'], message: '候选 ID 必须唯一' });
    if (urls.has(candidate.canonicalUrl)) context.addIssue({ code: 'custom', path: ['candidates', index, 'canonicalUrl'], message: '候选 URL 必须唯一' });
    ids.add(candidate.id);
    urls.add(candidate.canonicalUrl);
  }
});
export type NowcoderSearchSession = z.infer<typeof nowcoderSearchSessionSchema>;

export const nowcoderDirectedRunSpecSchema = z.object({
  queries: nowcoderQueriesSchema,
  queryHash: hashSchema,
  target: z.number().int().min(1).max(10),
  sort: z.literal('latest'),
  maxDetails: z.literal(NOWCODER_DIRECTED_MAX_DETAILS),
  searchSessionId: opaqueIdSchema,
  idempotencyKey: opaqueIdSchema,
  deliveryMode: z.literal('agent-journey-inbox'),
}).strict();
export type NowcoderDirectedRunSpec = z.infer<typeof nowcoderDirectedRunSpecSchema>;

export const publicNowcoderDeliveryItemSchema = z.object({
  stableContentId: opaqueIdSchema,
  canonicalUrl: canonicalNowcoderUrlSchema,
  contentHash: storedContentHashSchema,
  clusterId: opaqueIdSchema,
  /** One-way hash identifier; never a job ID or filesystem path. */
  lineageId: hashSchema,
}).strict();
export type PublicNowcoderDeliveryItem = z.infer<typeof publicNowcoderDeliveryItemSchema>;

export const privateNowcoderDeliveryItemSchema = z.object({
  jobId: opaqueIdSchema,
  stableContentId: opaqueIdSchema,
  canonicalUrl: canonicalNowcoderUrlSchema,
  contentHash: storedContentHashSchema,
  clusterId: opaqueIdSchema,
}).strict();
export type PrivateNowcoderDeliveryItem = z.infer<typeof privateNowcoderDeliveryItemSchema>;

export const publicNowcoderPublishReceiptSchema = z.object({
  deliveryIds: z.array(opaqueIdSchema).max(10),
  entryHashes: z.array(storedContentHashSchema).max(10),
  markerHash: hashSchema,
  publishedAt: z.iso.datetime(),
}).strict();
export type PublicNowcoderPublishReceipt = z.infer<typeof publicNowcoderPublishReceiptSchema>;

const publicRunBaseSchema = z.object({
  id: opaqueIdSchema,
  attempt: nowcoderDirectedRunAttemptSchema,
  status: nowcoderDirectedRunStatusSchema,
  phase: nowcoderDirectedRunPhaseSchema,
  scheduledCandidateIds: z.array(opaqueIdSchema).max(NOWCODER_DIRECTED_MAX_DETAILS),
  progress: nowcoderDirectedProgressSchema,
  spec: nowcoderDirectedRunSpecSchema,
  accepted: z.number().int().min(0).max(10),
  delivered: z.number().int().min(0).max(10),
  deliveryIds: z.array(opaqueIdSchema).max(10),
  publicDeliveryItems: z.array(publicNowcoderDeliveryItemSchema).max(10),
  publishReceipt: publicNowcoderPublishReceiptSchema.optional(),
  /** A marker verified during recovery is evidence that completion must converge. */
  verifiedMarkerHash: hashSchema.optional(),
  activeOwnedTabs: z.number().int().min(0).max(NOWCODER_DIRECTED_MAX_OWNED_TABS),
  peakOwnedTabs: z.number().int().min(0).max(NOWCODER_DIRECTED_MAX_OWNED_TABS),
  terminalOwnedTabs: z.number().int().min(0).max(NOWCODER_DIRECTED_MAX_OWNED_TABS),
  buildEvidence: nowcoderDirectedBuildEvidenceSchema,
  attentionReason: nowcoderDirectedAttentionReasonSchema.optional(),
  summary: z.string().trim().min(1).max(500).optional(),
  actionable: z.string().trim().min(1).max(500).optional(),
});

function assertUniqueDeliveryIdentity(
  items: readonly { stableContentId: string; canonicalUrl: string; clusterId: string }[],
  context: z.RefinementCtx,
  path: string,
): void {
  for (const key of ['stableContentId', 'canonicalUrl', 'clusterId'] as const) {
    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (seen.has(item[key])) {
        context.addIssue({ code: 'custom', path: [path, index, key], message: `${key} 必须唯一` });
      }
      seen.add(item[key]);
    }
  }
}

function hasExactSet(values: readonly string[], expected: readonly string[]): boolean {
  return values.length === expected.length
    && new Set(values).size === values.length
    && values.every(value => expected.includes(value));
}

function assertPublicRunInvariants(
  run: z.infer<typeof publicRunBaseSchema>,
  context: z.RefinementCtx,
): void {
  const phaseMatchesStatus = run.status === 'publishing' || run.status === 'completed'
    ? run.phase === 'publishing'
    : run.status === 'completed_with_attention'
      ? run.attentionReason?.phase === run.phase
      : run.phase !== 'publishing';
  if (!phaseMatchesStatus) {
    context.addIssue({ code: 'custom', path: ['phase'], message: '运行状态与阶段不匹配' });
  }
  const exactSelectionState = run.status === 'publishing'
    || (
      run.phase === 'staging'
      && (run.status === 'running' || run.status === 'cancelling' || run.status === 'failed')
    )
    || (
      run.status === 'completed_with_attention'
      && run.phase === 'publishing'
      && run.verifiedMarkerHash !== undefined
    );
  if (exactSelectionState && run.accepted !== run.spec.target) {
    context.addIssue({ code: 'custom', message: 'staging/publishing 必须精确筛得 target 条' });
  }
  if (run.activeOwnedTabs > run.peakOwnedTabs) {
    context.addIssue({ code: 'custom', path: ['activeOwnedTabs'], message: '当前 owned tab 不能超过峰值' });
  }
  if (new Set(run.scheduledCandidateIds).size !== run.scheduledCandidateIds.length
    || run.scheduledCandidateIds.length !== run.progress.detailScheduled
    || run.accepted !== run.progress.accepted
    || run.delivered !== run.progress.delivered) {
    context.addIssue({ code: 'custom', path: ['progress'], message: '公开进度与运行状态不一致' });
  }
  assertUniqueDeliveryIdentity(run.publicDeliveryItems, context, 'publicDeliveryItems');
  const publicIds = run.publicDeliveryItems.map(item => item.stableContentId);
  const publicHashes = run.publicDeliveryItems.map(item => item.contentHash);
  const lineageIds = run.publicDeliveryItems.map(item => item.lineageId);
  if (new Set(lineageIds).size !== lineageIds.length) {
    context.addIssue({ code: 'custom', path: ['publicDeliveryItems'], message: 'lineageId 必须唯一' });
  }
  if (!hasExactSet(run.deliveryIds, publicIds)) {
    context.addIssue({ code: 'custom', path: ['deliveryIds'], message: '公开交付 ID 必须精确匹配交付项' });
  }
  const isCompleted = run.status === 'completed';
  if (isCompleted) {
    const exact = run.spec.target;
    if (
      run.accepted !== exact
      || run.delivered !== exact
      || run.deliveryIds.length !== exact
      || run.publicDeliveryItems.length !== exact
    ) context.addIssue({ code: 'custom', message: 'completed 定向运行必须精确交付 target 条' });
    if (!run.publishReceipt) context.addIssue({ code: 'custom', path: ['publishReceipt'], message: 'completed 定向运行必须有发布回执' });
  } else if (
    (run.deliveryIds.length > 0 || run.publicDeliveryItems.length > 0 || run.delivered > 0)
    && !run.verifiedMarkerHash
  ) {
    context.addIssue({ code: 'custom', message: '未完成运行不能暴露部分交付' });
  }
  if (run.status === 'completed_with_attention') {
    if (!run.attentionReason) {
      context.addIssue({ code: 'custom', path: ['attentionReason'], message: '需处理运行必须有结构化原因' });
    }
    if (!run.verifiedMarkerHash && (
      run.delivered !== 0
      || run.deliveryIds.length !== 0
      || run.publicDeliveryItems.length !== 0
      || run.publishReceipt !== undefined
    )) {
      context.addIssue({ code: 'custom', message: 'marker 前的需处理运行不能暴露交付' });
    }
  } else if (run.attentionReason) {
    context.addIssue({ code: 'custom', path: ['attentionReason'], message: '只有需处理运行可携带 attentionReason' });
  }
  const publicationEvidence = run.verifiedMarkerHash !== undefined
    || run.publishReceipt !== undefined
    || run.delivered > 0
    || run.deliveryIds.length > 0
    || run.publicDeliveryItems.length > 0;
  const publicationEvidenceAllowed = run.status === 'publishing'
    || run.status === 'completed'
    || (
      run.status === 'completed_with_attention'
      && run.phase === 'publishing'
      && run.verifiedMarkerHash !== undefined
    );
  if (publicationEvidence && !publicationEvidenceAllowed) {
    context.addIssue({ code: 'custom', message: '发布证据与运行状态不匹配' });
  }
  const targetUnavailable = run.status === 'completed_with_attention'
    && run.attentionReason?.code === 'DIRECTED_TARGET_UNAVAILABLE';
  if (targetUnavailable && (
    run.phase !== 'selecting'
    || run.accepted >= run.spec.target
    || publicationEvidence
  )) context.addIssue({ code: 'custom', message: '目标不足终态必须保持在发布前' });
  const preMarkerSystemicAttention = run.status === 'completed_with_attention'
    && run.attentionReason?.code !== 'DIRECTED_TARGET_UNAVAILABLE'
    && run.verifiedMarkerHash === undefined;
  if (preMarkerSystemicAttention && (
    run.accepted !== 0
    || run.delivered !== 0
    || run.deliveryIds.length !== 0
    || run.publicDeliveryItems.length !== 0
    || run.publishReceipt !== undefined
    || run.progress.inspected !== 0
    || run.progress.qualified !== 0
    || run.progress.accepted !== 0
    || run.progress.delivered !== 0
    || run.progress.rejectionCounts.length !== 0
    || run.progress.companies.some(item => item.count !== 0)
  )) context.addIssue({ code: 'custom', message: '系统需处理运行必须清空筛选与交付状态' });
  if (run.publishReceipt) {
    if (
      !hasExactSet(run.publishReceipt.deliveryIds, publicIds)
      || !hasExactSet(run.publishReceipt.entryHashes, publicHashes)
    ) context.addIssue({ code: 'custom', path: ['publishReceipt'], message: '发布回执必须精确匹配公开交付项' });
  }
  const selectionAuditRequired = (
    run.status === 'running' || run.status === 'cancelling'
  ) || run.status === 'publishing'
    || run.status === 'completed'
    || run.status === 'failed'
    || (
      run.status === 'completed_with_attention'
      && run.attentionReason?.code === 'DIRECTED_TARGET_UNAVAILABLE'
    )
    || (run.status === 'completed_with_attention' && run.verifiedMarkerHash !== undefined);
  if (selectionAuditRequired) {
    const rejected = run.progress.rejectionCounts.reduce((sum, entry) => sum + entry.count, 0);
    if (rejected !== run.progress.detailScheduled - run.progress.accepted) {
      context.addIssue({
        code: 'custom',
        path: ['progress', 'rejectionCounts'],
        message: '筛选审计必须精确覆盖未接受的已调度详情',
      });
    }
  }
  if (run.status === 'cancelled') {
    if (run.activeOwnedTabs !== 0 || run.terminalOwnedTabs !== 0) {
      context.addIssue({ code: 'custom', path: ['activeOwnedTabs'], message: '已取消运行必须清空 owned tab 证据' });
    }
    if (
      run.progress.qualified !== 0
      || run.progress.accepted !== 0
      || run.progress.delivered !== 0
      || run.progress.rejectionCounts.length !== 0
      || run.progress.companies.some(item => item.count !== 0)
    ) context.addIssue({ code: 'custom', path: ['progress'], message: '已取消运行必须清空筛选审计' });
    if (run.accepted !== 0
      || run.delivered !== 0
      || run.deliveryIds.length !== 0
      || run.publicDeliveryItems.length !== 0
      || run.publishReceipt !== undefined
      || run.verifiedMarkerHash !== undefined) {
      context.addIssue({ code: 'custom', message: '已取消运行不能保留交付证据' });
    }
  }
}

export const publicNowcoderDirectedRunSchema = publicRunBaseSchema.strict().superRefine(assertPublicRunInvariants);
export type PublicNowcoderDirectedRun = z.infer<typeof publicNowcoderDirectedRunSchema>;

export const publisherRecoveryStateSchema = z.object({
  verifiedMarkerHash: hashSchema,
  markerDeliveryIds: z.array(opaqueIdSchema).min(1).max(10),
  markerEntryHashes: z.array(storedContentHashSchema).min(1).max(10),
}).strict().superRefine((state, context) => {
  if (state.markerDeliveryIds.length !== state.markerEntryHashes.length) {
    context.addIssue({ code: 'custom', message: 'marker ID 与 hash 数量必须相等' });
  }
});
export type PublisherRecoveryState = z.infer<typeof publisherRecoveryStateSchema>;

export const storedNowcoderDirectedRunSchema = publicRunBaseSchema.extend({
  currentJobIds: z.array(opaqueIdSchema).max(NOWCODER_DIRECTED_MAX_DETAILS),
  deliveryItems: z.array(privateNowcoderDeliveryItemSchema).max(10),
  idempotencyLineage: z.array(opaqueIdSchema).min(1).max(20),
  retryOf: opaqueIdSchema.optional(),
  recovery: publisherRecoveryStateSchema.optional(),
  observedRuntimeIds: z.array(z.string().uuid()).min(1).max(100),
}).strict().superRefine((run, context) => {
  assertPublicRunInvariants(run, context);
  assertUniqueDeliveryIdentity(run.deliveryItems, context, 'deliveryItems');
  if (new Set(run.observedRuntimeIds).size !== run.observedRuntimeIds.length) {
    context.addIssue({ code: 'custom', path: ['observedRuntimeIds'], message: 'runtime ID 必须按首次观察唯一记录' });
  }
  const privateIds = run.deliveryItems.map(item => item.stableContentId);
  const privateHashes = run.deliveryItems.map(item => item.contentHash);
  const hasPublicDeliveryEvidence = run.delivered > 0
    || run.deliveryIds.length > 0
    || run.publicDeliveryItems.length > 0
    || run.publishReceipt !== undefined;
  if (hasPublicDeliveryEvidence) {
    const exact = run.spec.target;
    if (run.deliveryItems.length !== exact || run.deliveryItems.length !== run.publicDeliveryItems.length) {
      context.addIssue({ code: 'custom', message: '私有与公开交付项必须精确等于 target' });
    }
    for (const [index, item] of run.deliveryItems.entries()) {
      if (!run.currentJobIds.includes(item.jobId)) {
        context.addIssue({ code: 'custom', path: ['deliveryItems', index, 'jobId'], message: '交付任务必须属于当前运行' });
      }
    }
    const privateIds = run.deliveryItems.map(item => item.stableContentId);
    const privateHashes = run.deliveryItems.map(item => item.contentHash);
    const publicIdentity = run.publicDeliveryItems.map(item =>
      `${item.stableContentId}\u0000${item.canonicalUrl}\u0000${item.contentHash}\u0000${item.clusterId}`);
    const privateIdentity = run.deliveryItems.map(item =>
      `${item.stableContentId}\u0000${item.canonicalUrl}\u0000${item.contentHash}\u0000${item.clusterId}`);
    if (!hasExactSet(privateIdentity, publicIdentity)) {
      context.addIssue({ code: 'custom', message: '私有与公开交付身份必须精确一致' });
    }
    if (
      !run.publishReceipt
      || !hasExactSet(run.publishReceipt.deliveryIds, privateIds)
      || !hasExactSet(run.publishReceipt.entryHashes, privateHashes)
    ) context.addIssue({ code: 'custom', path: ['publishReceipt'], message: '发布回执必须精确匹配私有交付项' });
  }
  if (run.publishReceipt !== undefined && run.verifiedMarkerHash !== undefined
    && run.publishReceipt.markerHash !== run.verifiedMarkerHash) {
    context.addIssue({ code: 'custom', path: ['publishReceipt', 'markerHash'], message: 'marker hash 必须精确一致' });
  }
  if (run.recovery !== undefined) {
    if ((run.verifiedMarkerHash !== undefined && run.recovery.verifiedMarkerHash !== run.verifiedMarkerHash)
      || (run.publishReceipt !== undefined && run.recovery.verifiedMarkerHash !== run.publishReceipt.markerHash)) {
      context.addIssue({ code: 'custom', path: ['recovery', 'verifiedMarkerHash'], message: 'marker hash 必须精确一致' });
    }
    if (!hasExactSet(run.recovery.markerDeliveryIds, privateIds)
      || !hasExactSet(run.recovery.markerEntryHashes, privateHashes)) {
      context.addIssue({ code: 'custom', path: ['recovery'], message: '发布恢复证据必须精确匹配私有交付项' });
    }
  }
  if (run.status === 'cancelled' && (run.deliveryItems.length !== 0 || run.recovery !== undefined)) {
    context.addIssue({ code: 'custom', message: '已取消运行必须清空私有交付与审计' });
  }
  const preMarkerSystemicAttention = run.status === 'completed_with_attention'
    && run.attentionReason?.code !== 'DIRECTED_TARGET_UNAVAILABLE'
    && run.verifiedMarkerHash === undefined;
  if (preMarkerSystemicAttention && (run.deliveryItems.length !== 0 || run.recovery !== undefined)) {
    context.addIssue({ code: 'custom', message: '系统需处理运行必须清空筛选与交付状态' });
  }
  if (run.status === 'completed_with_attention'
    && run.attentionReason?.code === 'DIRECTED_TARGET_UNAVAILABLE'
    && (run.deliveryItems.length !== 0 || run.recovery !== undefined)) {
    context.addIssue({ code: 'custom', message: '目标不足终态必须保持在发布前' });
  }
  if (run.recovery !== undefined && !(
    run.status === 'publishing'
    || (
      run.status === 'completed_with_attention'
      && run.phase === 'publishing'
      && run.verifiedMarkerHash !== undefined
    )
  )) context.addIssue({ code: 'custom', message: '发布恢复证据与运行状态不匹配' });
});
export type StoredNowcoderDirectedRun = z.infer<typeof storedNowcoderDirectedRunSchema>;

export const nowcoderSearchPreviewRequestSchema = nowcoderSearchRequestSchema;
export const nowcoderSearchPreviewResponseSchema = z.object({ session: nowcoderSearchSessionSchema }).strict();
export type NowcoderSearchPreviewRequest = z.infer<typeof nowcoderSearchPreviewRequestSchema>;
export type NowcoderSearchPreviewResponse = z.infer<typeof nowcoderSearchPreviewResponseSchema>;

export const nowcoderDirectedStartRequestSchema = z.object({
  searchSessionId: opaqueIdSchema,
  selectedCandidateIds: z.array(opaqueIdSchema).max(24),
  idempotencyKey: opaqueIdSchema,
  deliveryAuthorized: z.literal(true),
}).strict();
export const nowcoderDirectedStartResponseSchema = z.object({ run: publicNowcoderDirectedRunSchema }).strict();
export type NowcoderDirectedStartRequest = z.infer<typeof nowcoderDirectedStartRequestSchema>;
export type NowcoderDirectedStartResponse = z.infer<typeof nowcoderDirectedStartResponseSchema>;

export const nowcoderDirectedCancelRequestSchema = z.object({ attempt: nowcoderDirectedRunAttemptSchema }).strict();
export const nowcoderDirectedCancelResponseSchema = z.object({ run: publicNowcoderDirectedRunSchema }).strict();
export type NowcoderDirectedCancelRequest = z.infer<typeof nowcoderDirectedCancelRequestSchema>;
export type NowcoderDirectedCancelResponse = z.infer<typeof nowcoderDirectedCancelResponseSchema>;

export const nowcoderDirectedRetryRequestSchema = z.object({ idempotencyKey: opaqueIdSchema }).strict();
export const nowcoderDirectedRetryResponseSchema = z.object({ run: publicNowcoderDirectedRunSchema }).strict();
export type NowcoderDirectedRetryRequest = z.infer<typeof nowcoderDirectedRetryRequestSchema>;
export type NowcoderDirectedRetryResponse = z.infer<typeof nowcoderDirectedRetryResponseSchema>;
