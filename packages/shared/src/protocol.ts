import { z } from 'zod';

export const collectedImageSchema = z.object({
  url: z.string().url().max(4096),
  alt: z.string().trim().max(500).optional(),
});

export const collectedDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.enum(['wechat', 'zsxq']),
  kind: z.enum(['article', 'post', 'question', 'answer']),
  url: z.string().url().max(4096),
  canonicalUrl: z.string().url().max(4096),
  title: z.string().trim().min(1).max(500),
  author: z.string().trim().max(200).optional(),
  publishedAt: z.iso.datetime().optional(),
  collectedAt: z.iso.datetime(),
  html: z.string().max(10_000_000),
  text: z.string().max(5_000_000),
  images: z.array(collectedImageSchema).max(30),
  suggestedCategory: z.string().trim().max(100).optional(),
  suggestedTags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  userCategory: z.string().trim().max(100).optional(),
  userTags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  sourceMetadata: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
});

export const wsEnvelopeSchema = z.object({
  protocolVersion: z.literal(1),
  type: z.string().trim().min(1).max(100),
  requestId: z.string().trim().min(1).max(100),
  timestamp: z.iso.datetime(),
  payload: z.unknown(),
});

export const collectJobPayloadSchema = z.object({
  url: z.string().url().max(4096),
  userCategory: z.string().trim().max(100).optional(),
  userTags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
});

export const jobResultPayloadSchema = z.object({
  document: collectedDocumentSchema,
});

export type CollectedDocumentInput = z.infer<typeof collectedDocumentSchema>;
