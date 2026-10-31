import { z } from 'zod';
import { operationIdSchema, operationSourceUrlSchema } from './nowcoderOperations.js';

export const nowcoderPublishingPolicySchema = z.object({
  minIntervalMs: z.number().int().min(1).max(3_600_000),
  maxPerHour: z.number().int().min(1).max(10_000),
  maxPer24Hours: z.number().int().min(1).max(40_000),
}).strict();
export const DEFAULT_NOWCODER_PUBLISHING_POLICY = { minIntervalMs: 120_000, maxPerHour: 5, maxPer24Hours: 20 } as const;
export type NowcoderPublishingPolicy = z.infer<typeof nowcoderPublishingPolicySchema>;
export const nowcoderVerificationPauseSchema = z.object({
  id: z.string().uuid(), detectedAt: z.iso.datetime(), sourceUrl: operationSourceUrlSchema,
  requestId: z.string().uuid(), opportunityId: operationIdSchema.optional(),
  key: z.string().regex(/^[a-zA-Z0-9_-]{12,100}$/u).optional(),
}).strict();
export type NowcoderVerificationPause = z.infer<typeof nowcoderVerificationPauseSchema>;
export const nowcoderPublishingStatusSchema = z.object({
  schemaVersion: z.literal(1), policy: nowcoderPublishingPolicySchema,
  usage: z.object({ lastHour: z.number().int().nonnegative(), last24Hours: z.number().int().nonnegative() }).strict(),
  nextAllowedAt: z.iso.datetime().nullable(), verification: nowcoderVerificationPauseSchema.nullable(),
}).strict();
export type NowcoderPublishingStatus = z.infer<typeof nowcoderPublishingStatusSchema>;
export const nowcoderVerificationResumeSchema = z.object({
  id: z.string().uuid(), verificationCompleted: z.literal(true),
}).strict();
