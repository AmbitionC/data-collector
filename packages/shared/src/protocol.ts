import { z } from 'zod';
import { CONTENT_KINDS, FE_JOURNEY_CANDIDATE_KINDS, SOURCES } from './model.js';
import { descriptorForHost } from './sources.js';
import { canonicalizeUrl, parseSupportedUrl } from './url.js';
import { collectionBatchSchema, collectionPlanIdSchema } from './plans.js';

export const EXTENSION_REPLACED_CLOSE_CODE = 4009;
export const EXTENSION_REPLACED_CLOSE_REASON = 'replaced';

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

export const collectJobPayloadSchema = z.object({
  url: z.string().url().max(4096),
  userCategory: z.string().trim().max(100).optional(),
  userTags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  /** 用户为本次采集显式选择的落地去向（sink id）；缺省按来源默认路由。 */
  sinks: z.array(z.string().trim().min(1).max(100)).max(10).optional(),
});

export const jobResultPayloadSchema = z.object({
  document: collectedDocumentSchema,
});

export const planCollectPayloadSchema = z.object({
  planId: collectionPlanIdSchema,
  force: z.boolean().optional(),
}).strict();

export const planResultPayloadSchema = z.object({
  batch: collectionBatchSchema,
}).strict();

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
