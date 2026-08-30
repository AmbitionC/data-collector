import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  canonicalizeUrl,
  parseSupportedUrl,
  type CollectedDocument,
} from '@data-collector/shared';

export interface ProcessedNowcoderHistory {
  readonly hashesByUrl: ReadonlyMap<string, ReadonlySet<string>>;
  readonly clusterIds: ReadonlySet<string>;
}

export interface ProcessedNowcoderHistorySnapshot {
  version: 1;
  hashesByUrl: Array<{ url: string; hashes: string[] }>;
  clusterIds: string[];
}

export class StrictNowcoderHistoryError extends Error {
  constructor(
    public readonly code: 'DIRECTED_HISTORY_CORRUPT' | 'DIRECTED_HISTORY_LIMIT_EXCEEDED',
  ) {
    super(code === 'DIRECTED_HISTORY_LIMIT_EXCEEDED'
      ? '历史记录超过安全处理上限'
      : '历史记录无法安全读取');
    this.name = 'StrictNowcoderHistoryError';
  }
}

const MAX_HISTORY_BYTES = 16 * 1024 * 1024;
const MAX_HISTORY_VALUES = 100_000;
const HISTORY_STATUSES = new Set(['published', 'merged', 'skipped', 'retired', 'needs_review']);
const HISTORY_GRADES = new Set(['A', 'B', 'C']);

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep));
}

function corruptHistory(): never {
  throw new StrictNowcoderHistoryError('DIRECTED_HISTORY_CORRUPT');
}

function limitedHistory(): never {
  throw new StrictNowcoderHistoryError('DIRECTED_HISTORY_LIMIT_EXCEEDED');
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);
}

function parseStrictRecord(value: unknown): { url: string; contentHash: string; clusterId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return corruptHistory();
  const record = value as Record<string, unknown>;
  if (
    record.source !== 'nowcoder'
    || typeof record.url !== 'string'
    || typeof record.contentHash !== 'string'
    || !/^[a-f0-9]{16}$/u.test(record.contentHash)
    || typeof record.clusterId !== 'string'
    || record.clusterId.length === 0
    || !HISTORY_GRADES.has(String(record.evidenceGrade))
    || !HISTORY_STATUSES.has(String(record.status))
    || !Array.isArray(record.publicFiles)
    || !record.publicFiles.every(item => typeof item === 'string' && item.length > 0)
    || !(stringArray(record.knowledgeKeys) || (Array.isArray(record.knowledgeKeys) && record.knowledgeKeys.length === 0))
    || typeof record.processedAt !== 'string'
    || !Number.isFinite(Date.parse(record.processedAt))
    || (record.status === 'published' && (typeof record.articleKey !== 'string' || record.articleKey.length === 0))
  ) return corruptHistory();
  const url = canonicalNowcoderUrl(record.url);
  if (!url) return corruptHistory();
  return { url, contentHash: record.contentHash, clusterId: record.clusterId };
}

export function processedNowcoderHistoryDigest(snapshot: ProcessedNowcoderHistorySnapshot): string {
  // Canonical encoding is compact UTF-8 JSON of the byte-sorted normalized snapshot.
  const validated = validateProcessedNowcoderHistorySnapshot(snapshot);
  return createHash('sha256').update(JSON.stringify(validated), 'utf8').digest('hex');
}

export function historyFromSnapshot(snapshot: ProcessedNowcoderHistorySnapshot): ProcessedNowcoderHistory {
  const validated = validateProcessedNowcoderHistorySnapshot(snapshot);
  return {
    hashesByUrl: new Map(validated.hashesByUrl.map(item => [item.url, new Set(item.hashes)])),
    clusterIds: new Set(validated.clusterIds),
  };
}

export function validateProcessedNowcoderHistorySnapshot(
  snapshot: ProcessedNowcoderHistorySnapshot,
): ProcessedNowcoderHistorySnapshot {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || snapshot.version !== 1 || !Array.isArray(snapshot.hashesByUrl) || !Array.isArray(snapshot.clusterIds)
    || Object.keys(snapshot).some(key => key !== 'version' && key !== 'hashesByUrl' && key !== 'clusterIds')) {
    return corruptHistory();
  }
  try {
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MAX_HISTORY_BYTES) {
      return limitedHistory();
    }
  } catch {
    return corruptHistory();
  }
  if (snapshot.hashesByUrl.length > MAX_HISTORY_VALUES || snapshot.clusterIds.length > MAX_HISTORY_VALUES) {
    return limitedHistory();
  }
  let pairs = 0;
  let previousUrl: string | undefined;
  for (const entry of snapshot.hashesByUrl) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.url !== 'string' || !Array.isArray(entry.hashes)
      || Object.keys(entry).some(key => key !== 'url' && key !== 'hashes')
      || entry.hashes.length === 0 || entry.hashes.some(hash => typeof hash !== 'string' || !/^[a-f0-9]{16}$/u.test(hash))
      || new Set(entry.hashes).size !== entry.hashes.length
      || entry.hashes.some((hash, index) => index > 0 && compareUtf8(entry.hashes[index - 1]!, hash) >= 0)) {
      return corruptHistory();
    }
    const canonical = canonicalNowcoderUrl(entry.url);
    if (!canonical || canonical !== entry.url || (previousUrl !== undefined && compareUtf8(previousUrl, entry.url) >= 0)) {
      return corruptHistory();
    }
    previousUrl = entry.url;
    pairs += entry.hashes.length;
    if (pairs > MAX_HISTORY_VALUES) return limitedHistory();
  }
  if (snapshot.clusterIds.some(cluster => typeof cluster !== 'string' || cluster.length === 0)
    || new Set(snapshot.clusterIds).size !== snapshot.clusterIds.length
    || snapshot.clusterIds.some((cluster, index) => index > 0 && compareUtf8(snapshot.clusterIds[index - 1]!, cluster) >= 0)) {
    return corruptHistory();
  }
  return structuredClone(snapshot);
}

export async function loadStrictProcessedNowcoderHistory(repoRoot: string): Promise<{
  snapshot: ProcessedNowcoderHistorySnapshot;
  digest: string;
  history: ProcessedNowcoderHistory;
}> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(repoRoot);
    if (!(await lstat(canonicalRoot)).isDirectory()) return corruptHistory();
  } catch {
    return corruptHistory();
  }
  const codexPath = join(canonicalRoot, '.codex');
  const historyPath = join(codexPath, 'interview-source-history.json');
  let historyStat;
  try {
    historyStat = await lstat(historyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return corruptHistory();
    try {
      const codexStat = await lstat(codexPath);
      if (codexStat.isSymbolicLink() || !codexStat.isDirectory()) return corruptHistory();
      const canonicalCodex = await realpath(codexPath);
      if (!isInside(canonicalRoot, canonicalCodex)) return corruptHistory();
    } catch (parentError) {
      if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT') return corruptHistory();
    }
    const snapshot: ProcessedNowcoderHistorySnapshot = { version: 1, hashesByUrl: [], clusterIds: [] };
    return { snapshot, digest: processedNowcoderHistoryDigest(snapshot), history: historyFromSnapshot(snapshot) };
  }
  if (historyStat.isSymbolicLink() || !historyStat.isFile()) return corruptHistory();
  if (historyStat.size > MAX_HISTORY_BYTES) return limitedHistory();
  let canonicalHistory: string;
  try {
    canonicalHistory = await realpath(historyPath);
  } catch {
    return corruptHistory();
  }
  if (!isInside(canonicalRoot, canonicalHistory)) return corruptHistory();
  let parsed: unknown;
  try {
    const raw = await readFile(canonicalHistory);
    if (raw.byteLength > MAX_HISTORY_BYTES) return limitedHistory();
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof StrictNowcoderHistoryError) throw error;
    return corruptHistory();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return corruptHistory();
  const envelope = parsed as Record<string, unknown>;
  if (envelope.schemaVersion !== 1 || typeof envelope.updatedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/u.test(envelope.updatedAt)
    || !envelope.records || typeof envelope.records !== 'object' || Array.isArray(envelope.records)) {
    return corruptHistory();
  }
  const records = Object.entries(envelope.records as Record<string, unknown>);
  if (records.length > MAX_HISTORY_VALUES) return limitedHistory();
  const hashesByUrl = new Map<string, Set<string>>();
  const clusters = new Set<string>();
  for (const [id, rawRecord] of records) {
    if (!/^[a-f0-9]{12}$/u.test(id)) return corruptHistory();
    const record = parseStrictRecord(rawRecord);
    const hashes = hashesByUrl.get(record.url) ?? new Set<string>();
    hashes.add(record.contentHash);
    hashesByUrl.set(record.url, hashes);
    clusters.add(record.clusterId);
  }
  const pairCount = [...hashesByUrl.values()].reduce((count, hashes) => count + hashes.size, 0);
  if (hashesByUrl.size > MAX_HISTORY_VALUES || pairCount > MAX_HISTORY_VALUES || clusters.size > MAX_HISTORY_VALUES) {
    return limitedHistory();
  }
  const snapshot: ProcessedNowcoderHistorySnapshot = {
    version: 1,
    hashesByUrl: [...hashesByUrl.entries()]
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(([url, hashes]) => ({ url, hashes: [...hashes].sort(compareUtf8) })),
    clusterIds: [...clusters].sort(compareUtf8),
  };
  return { snapshot, digest: processedNowcoderHistoryDigest(snapshot), history: historyFromSnapshot(snapshot) };
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
