import { z } from 'zod';
import { operationIdSchema, operationSourceUrlSchema } from './nowcoderOperations.js';
import { articleIdSchema, browserFamilySchema, nowcoderAccountIdSchema, NOWCODER_ARTICLE_EDITOR_URL } from './nowcoderArticles.js';

export const nowcoderPublishingPolicySchema = z.object({
  minIntervalMs: z.number().int().min(1).max(3_600_000),
  maxPerHour: z.number().int().min(1).max(10_000),
  maxPer24Hours: z.number().int().min(1).max(40_000),
}).strict();
export const DEFAULT_NOWCODER_PUBLISHING_POLICY = { minIntervalMs: 120_000, maxPerHour: 5, maxPer24Hours: 20 } as const;
export type NowcoderPublishingPolicy = z.infer<typeof nowcoderPublishingPolicySchema>;
export const publishingReferenceUrlSchema = z.union([operationSourceUrlSchema, z.literal(NOWCODER_ARTICLE_EDITOR_URL),
  z.string().regex(/^https:\/\/www\.nowcoder\.com\/users\/\d{1,20}$/u)]);
export const nowcoderVerificationPauseSchema = z.object({
  id: z.string().uuid(), detectedAt: z.iso.datetime(), sourceUrl: publishingReferenceUrlSchema,
  requestId: z.string().uuid(), opportunityId: operationIdSchema.optional(),
  key: z.string().regex(/^[a-zA-Z0-9_-]{12,100}$/u).optional(),
  channel: z.enum(['comment', 'article']).optional(), articleId: articleIdSchema.optional(),
  browser: browserFamilySchema.optional(), accountId: nowcoderAccountIdSchema.optional(),
  /** Set when the other channel also hit verification while this pause was pending. */
  allChannels: z.literal(true).optional(),
}).strict();
export type NowcoderVerificationPause = z.infer<typeof nowcoderVerificationPauseSchema>;
export const nowcoderPublishingStatusSchema = z.object({
  schemaVersion: z.literal(1), policy: nowcoderPublishingPolicySchema,
  usage: z.object({ lastHour: z.number().int().nonnegative(), last24Hours: z.number().int().nonnegative() }).strict(),
  nextAllowedAt: z.iso.datetime().nullable(), verification: nowcoderVerificationPauseSchema.nullable(),
}).strict();
export type NowcoderPublishingStatus = z.infer<typeof nowcoderPublishingStatusSchema>;
export const articlePublishingStatusSchema = z.object({
  schemaVersion: z.literal(1), policy: z.object({ minIntervalMs: z.number().int().positive(), maxPer24Hours: z.null() }).strict(),
  usage: z.object({ last24Hours: z.number().int().nonnegative() }).strict(), nextAllowedAt: z.iso.datetime().nullable(),
  verification: nowcoderVerificationPauseSchema.nullable(),
}).strict();
export type ArticlePublishingStatus = z.infer<typeof articlePublishingStatusSchema>;
export const nowcoderVerificationResumeSchema = z.object({
  id: z.string().uuid(), verificationCompleted: z.literal(true),
}).strict();

export type NowcoderPublishingChannel = 'comment' | 'article';
/** A captcha belongs to one account: it pauses only its own channel unless both were hit. */
export function verificationBlocks(pause: NowcoderVerificationPause | null | undefined, channel: NowcoderPublishingChannel): boolean {
  return !!pause && (pause.allChannels === true || (pause.channel ?? 'comment') === channel);
}
