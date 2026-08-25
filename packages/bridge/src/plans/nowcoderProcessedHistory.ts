import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  canonicalizeUrl,
  parseSupportedUrl,
  type CollectedDocument,
} from '@data-collector/shared';

export interface ProcessedNowcoderHistory {
  readonly hashesByUrl: ReadonlyMap<string, ReadonlySet<string>>;
  readonly clusterIds: ReadonlySet<string>;
}

export async function loadProcessedNowcoderHistory(
  repoRoot: string,
): Promise<ProcessedNowcoderHistory> {
  const hashesByUrl = new Map<string, Set<string>>();
  const clusterIds = new Set<string>();
  try {
    const raw = JSON.parse(await readFile(
      join(repoRoot, '.codex', 'interview-source-history.json'),
      'utf8',
    )) as { records?: Record<string, unknown> };
    for (const value of Object.values(raw.records ?? {})) {
      if (!value || typeof value !== 'object') continue;
      const record = value as Record<string, unknown>;
      if (
        record.source !== 'nowcoder'
        || typeof record.url !== 'string'
        || typeof record.contentHash !== 'string'
        || typeof record.clusterId !== 'string'
      ) continue;
      const url = canonicalNowcoderUrl(record.url);
      if (!url) continue;
      const hashes = hashesByUrl.get(url) ?? new Set<string>();
      hashes.add(record.contentHash);
      hashesByUrl.set(url, hashes);
      clusterIds.add(record.clusterId);
    }
  } catch {
    // History is a target-repository optimization boundary. A missing or malformed
    // file must not make collection unavailable; the target inspector remains the
    // final publication gate.
  }
  return { hashesByUrl, clusterIds };
}

export function filterProcessedNowcoderDocuments(
  documents: readonly CollectedDocument[],
  history: ProcessedNowcoderHistory,
): {
  eligible: CollectedDocument[];
  rejected: Array<{ url: string; reason: string }>;
} {
  const eligible: CollectedDocument[] = [];
  const rejected: Array<{ url: string; reason: string }> = [];
  for (const document of documents) {
    const url = canonicalNowcoderUrl(document.canonicalUrl);
    const contentHash = document.feJourney?.contentHash;
    const knownHashes = url ? history.hashesByUrl.get(url) : undefined;
    if (knownHashes && contentHash && knownHashes.has(contentHash)) {
      rejected.push({ url: document.canonicalUrl, reason: '目标仓库已处理相同来源版本' });
      continue;
    }
    // A revised body at the same canonical URL is an update, even if the candidate
    // index keeps it in the old similarity cluster. Different URLs in that cluster
    // remain duplicate evidence and must not create another public article.
    if (
      !knownHashes
      && document.feJourney?.clusterId
      && history.clusterIds.has(document.feJourney.clusterId)
    ) {
      rejected.push({ url: document.canonicalUrl, reason: '目标仓库已处理相同问题簇' });
      continue;
    }
    eligible.push(document);
  }
  return { eligible, rejected };
}

function canonicalNowcoderUrl(raw: string): string | undefined {
  try {
    const url = parseSupportedUrl(raw);
    if (url.hostname === 'nowcoder.com') url.hostname = 'www.nowcoder.com';
    return canonicalizeUrl(url).href;
  } catch {
    return undefined;
  }
}
