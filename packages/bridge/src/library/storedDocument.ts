import { z } from 'zod';
import {
  collectedDocumentSchema,
  nowcoderDirectedRunAttemptSchema,
  type CollectedDocument,
} from '@data-collector/shared';
import type { OrganizedDocument } from '../organize/index.js';

const localEvidenceHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const contentHashSchema = z.string().regex(/^[a-f0-9]{16}$/u);

export const nowcoderDirectedLocalEvidenceSchema = z.object({
  runId: z.string().trim().min(1).max(200),
  attempt: nowcoderDirectedRunAttemptSchema,
  currentJobId: z.string().trim().min(1).max(500),
  stableContentId: z.string().trim().min(1).max(200),
  canonicalUrl: z.string().url().max(4_096),
  contentHash: contentHashSchema,
  clusterId: z.string().trim().min(1).max(200),
  deliveryRevision: localEvidenceHashSchema,
}).strict();

export type NowcoderDirectedLocalEvidence = z.infer<typeof nowcoderDirectedLocalEvidenceSchema>;

export const localDocumentEvidenceSchema = z.object({
  nowcoderDirected: nowcoderDirectedLocalEvidenceSchema,
}).strict();
export type LocalDocumentEvidence = z.infer<typeof localDocumentEvidenceSchema>;

export const storedOrganizedDocumentSchema = z.object({
  document: collectedDocumentSchema,
  sanitizedHtml: z.string().max(10_000_000),
  summary: z.string().max(5_000),
  category: z.string().max(200),
  tags: z.array(z.string().max(200)).max(100),
  localEvidence: localDocumentEvidenceSchema.optional(),
}).strict();
export type StoredOrganizedDocument = z.infer<typeof storedOrganizedDocumentSchema>;

/** Runtime privacy boundary: local-only evidence never reaches ordinary sinks or revisions. */
export function projectOrganized(value: unknown): OrganizedDocument {
  const parsed = storedOrganizedDocumentSchema.parse(value);
  return {
    document: parsed.document as CollectedDocument,
    sanitizedHtml: parsed.sanitizedHtml,
    summary: parsed.summary,
    category: parsed.category,
    tags: [...parsed.tags],
  };
}

export function storeOrganized(
  organized: OrganizedDocument,
  localEvidence?: LocalDocumentEvidence,
): StoredOrganizedDocument {
  return storedOrganizedDocumentSchema.parse({
    ...organized,
    ...(localEvidence ? { localEvidence } : {}),
  });
}
