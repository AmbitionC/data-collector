import { z } from 'zod';
import { CONTENT_KINDS, FE_JOURNEY_CANDIDATE_KINDS, SOURCES } from './model.js';
import { descriptorForHost } from './sources.js';
import { canonicalizeUrl, parseSupportedUrl } from './url.js';
import {
  collectionBatchSchema,
  collectionPlanAttemptSchema,
  collectionPlanIdSchema,
  collectionPlanRejectionSchema,
  zsxqCollectionModeSchema,
  zsxqDayDraftSchema,
  zsxqOwnerAuditSchema,
  zsxqOwnerCheckpointSchema,
} from './plans.js';

export const EXTENSION_REPLACED_CLOSE_CODE = 4009;
export const EXTENSION_REPLACED_CLOSE_REASON = 'replaced';
/** 具备固定知识星球计划“补齐或拒绝，绝不归档半篇”完整链路。 */
export const ZSXQ_COMPLETE_CONTENT_CAPABILITY = 'zsxq-complete-content-v2';

export const collectedImageSchema = z.object({
  url: z.string().url().max(4096),
  alt: z.string().trim().max(500).optional(),
});

const feJourneySignalSchema = z.string().trim().min(1).max(200);
export const feJourneyCandidateMetadataSchema = z.object({
  candidateKinds: z.array(z.enum(FE_JOURNEY_CANDIDATE_KINDS)).max(4),
  qualityScore: z.number().int().min(0).max(100),
  qualitySignals: z.array(feJourneySignalSchema).max(20),
  exclusionReasons: z.array(feJourneySignalSchema).max(20).optional(),
  contentHash: z.string().regex(/^[a-f0-9]{16}$/),
  simHash: z.string().regex(/^[a-f0-9]{16}$/),
  clusterId: z.string().trim().min(1).max(100),
  duplicateOf: z.string().trim().min(1).max(100).optional(),
  projectScore: z.number().int().min(0).max(100).optional(),
  projectSignals: z.array(feJourneySignalSchema).max(20).optional(),
});

export const collectedDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.enum(SOURCES),
  kind: z.enum(CONTENT_KINDS),
  url: z.string().url().max(4096),
  canonicalUrl: z.string().url().max(4096),
  title: z.string().trim().min(1).max(500),
  author: z.string().trim().max(200).optional(),
  publishedAt: z.iso.datetime().optional(),
  collectedAt: z.iso.datetime(),
  html: z.string().max(10_000_000),
  text: z.string().max(5_000_000),
  images: z.array(collectedImageSchema).max(30),
  truncated: z.boolean().optional(),
  questioner: z.string().trim().max(200).optional(),
  suggestedCategory: z.string().trim().max(100).optional(),
  suggestedTags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  userCategory: z.string().trim().max(100).optional(),
  userTags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  sourceMetadata: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
  feJourney: feJourneyCandidateMetadataSchema.optional(),
}).superRefine((document, context) => {
  try {
    const rawUrl = parseSupportedUrl(document.url);
    const canonicalUrl = canonicalizeUrl(rawUrl).href;
    if (document.canonicalUrl !== canonicalUrl) {
      context.addIssue({
        code: 'custom',
        path: ['canonicalUrl'],
        message: 'canonicalUrl 与原始 URL 不一致',
      });
    }
    const descriptor = descriptorForHost(rawUrl.hostname);
    if (!descriptor) {
      context.addIssue({ code: 'custom', path: ['url'], message: '内容 URL 不在支持列表中' });
      return;
    }
    if (document.source !== descriptor.id) {
      context.addIssue({
        code: 'custom',
        path: ['source'],
        message: '内容来源与 URL 域名不一致',
      });
    }
    if (!descriptor.kinds.includes(document.kind)) {
      context.addIssue({
        code: 'custom',
        path: ['kind'],
        message: `${descriptor.label}不支持该内容类型`,
      });
    }
  } catch {
    context.addIssue({
      code: 'custom',
      path: ['url'],
      message: '内容 URL 不在支持列表中',
    });
  }
});

export const wsEnvelopeSchema = z.object({
  protocolVersion: z.literal(1),
  type: z.string().trim().min(1).max(100),
  requestId: z.string().trim().min(1).max(100),
  timestamp: z.iso.datetime(),
  payload: z.unknown(),
});

export const bridgeAuthorizedPayloadSchema = z.object({
  token: z.string().min(32).max(512),
});

export const extensionHelloPayloadSchema = z.object({
  version: z.string().trim().regex(/^\d+\.\d+\.\d+$/).max(50),
  buildId: z.string().trim().min(1).max(200).optional(),
  capabilities: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
}).strict();

export const collectJobPayloadSchema = z.object({
  url: z.string().url().max(4096),
  userCategory: z.string().trim().max(100).optional(),
  userTags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  /** 用户为本次采集显式选择的落地去向（sink id）；缺省按来源默认路由。 */
  sinks: z.array(z.string().trim().min(1).max(100)).max(10).optional(),
});

export const jobCollectPayloadSchema = z.object({
  url: z.string().url().max(4096),
  /** 只有用户直接发起的单条任务可把登录页交给用户；自动批次必须自行回收页面。 */
  interactive: z.boolean().default(true),
}).strict();

export const jobResultPayloadSchema = z.object({
  document: collectedDocumentSchema,
});

/** Bridge 已把内容及任务终态持久化后的成功回执。 */
export const jobSavedPayloadSchema = z.object({
  outputPath: z.string().trim().min(1).max(4_096).optional(),
  results: z.array(z.unknown()).max(20).optional(),
  /** 固定计划任务必须回显所属尝试，扩展据此拒绝跨代回执。 */
  attempt: collectionPlanAttemptSchema.optional(),
}).strict();

/** Bridge 已接收正文、但落地或任务状态持久化失败后的终态回执。 */
export const jobFailedPayloadSchema = z.object({
  code: z.string().trim().min(1).max(100),
  message: z.string().trim().min(1).max(2_000),
  /** 固定计划任务必须回显所属尝试，扩展据此拒绝跨代回执。 */
  attempt: collectionPlanAttemptSchema.optional(),
}).strict();

export const planCollectPayloadSchema = z.object({
  planId: collectionPlanIdSchema,
  batchId: z.string().trim().min(1).max(200),
  attempt: collectionPlanAttemptSchema,
  force: z.boolean().optional(),
  zsxqMode: zsxqCollectionModeSchema.optional(),
  targetDays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/u)).max(3660).optional(),
  resumeCursor: z.iso.datetime().optional(),
}).strict().superRefine((payload, context) => {
  if (payload.zsxqMode && payload.planId !== 'zsxq-chen-teacher') {
    context.addIssue({
      code: 'custom',
      path: ['zsxqMode'],
      message: '只有知识星球计划支持逐日或历史模式',
    });
  }
});

export const extensionPlanResultPayloadSchema = z.object({
  batchId: z.string().trim().min(1).max(200),
  attempt: collectionPlanAttemptSchema,
  discovered: z.number().int().min(0),
  coverage: z.record(z.string().trim().min(1).max(100), z.number().int().min(0)).optional(),
  rejections: z.record(z.string().trim().min(1).max(100), z.number().int().min(0)).optional(),
  rejectionDetails: z.array(collectionPlanRejectionSchema).max(500).optional(),
  error: z.string().trim().min(1).max(2_000).optional(),
  needsAttention: z.boolean().optional(),
  prepared: z.boolean().optional(),
  checkpoint: zsxqOwnerCheckpointSchema.optional(),
  dayDrafts: z.array(zsxqDayDraftSchema).max(3660).optional(),
  ownerAudit: zsxqOwnerAuditSchema.optional(),
}).strict();

export const planResultPayloadSchema = z.union([
  z.object({ batch: collectionBatchSchema }).strict(),
  extensionPlanResultPayloadSchema,
]);

export const planCollectEnvelopeSchema = wsEnvelopeSchema.extend({
  type: z.literal('plan.collect'),
  payload: planCollectPayloadSchema,
});

export const planResultEnvelopeSchema = wsEnvelopeSchema.extend({
  type: z.literal('plan.result'),
  payload: planResultPayloadSchema,
});

export type CollectedDocumentInput = z.infer<typeof collectedDocumentSchema>;
export type BridgeAuthorizedPayload = z.infer<typeof bridgeAuthorizedPayloadSchema>;
