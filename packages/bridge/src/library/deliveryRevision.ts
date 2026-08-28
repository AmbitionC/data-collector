import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { OrganizedDocument } from '../organize/index.js';
import { contentFingerprint } from '../feJourney/fingerprint.js';
import { renderMarkdown } from './markdown.js';

const encoder = new TextEncoder();

/** These fields identify a collection/delivery attempt, not the content delivered downstream. */
const VOLATILE_SOURCE_METADATA = new Set([
  'batchId',
  'sourceBatchId',
  'deliveryBatchId',
  'planId',
  'contentCompletenessBuildId',
]);

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

function semanticSourceMetadata(
  metadata: OrganizedDocument['document']['sourceMetadata'],
): Record<string, string | number | boolean | null> | undefined {
  if (!metadata) return undefined;
  const stable = Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !VOLATILE_SOURCE_METADATA.has(key)),
  );
  return Object.keys(stable).length > 0 ? stable : undefined;
}

/**
 * Stable revision of the payload a repository inbox actually consumes.
 * Capture timestamps and attempt identifiers are intentionally absent.
 */
export function deliveryRevision(input: OrganizedDocument): string {
  const document = input.document;
  const sourceMetadata = semanticSourceMetadata(document.sourceMetadata);
  const payload = stableValue({
    source: document.source,
    kind: document.kind,
    canonicalUrl: document.canonicalUrl,
    title: document.title,
    ...(document.author ? { author: document.author } : {}),
    ...(document.questioner ? { questioner: document.questioner } : {}),
    ...(document.publishedAt ? { publishedAt: document.publishedAt } : {}),
    ...(document.truncated !== undefined ? { truncated: document.truncated } : {}),
    markdown: renderMarkdown(input.sanitizedHtml),
    contentHash: contentFingerprint(document.text),
    images: document.images.map(image => ({
      url: image.url,
      ...(image.alt ? { alt: image.alt } : {}),
    })),
    category: input.category,
    tags: input.tags,
    summary: input.summary,
    ...(sourceMetadata ? { sourceMetadata } : {}),
    ...(document.feJourney ? { feJourney: document.feJourney } : {}),
  });
  return bytesToHex(sha256(encoder.encode(JSON.stringify(payload))));
}
