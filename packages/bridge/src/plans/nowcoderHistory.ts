import {
  canonicalizeUrl,
  parseSupportedUrl,
  stableContentId,
  type JobRecord,
} from '@data-collector/shared';
import { FE_JOURNEY_PRESET } from '../feJourney/preset.js';

function isTerminalFailure(job: JobRecord): boolean {
  return job.status === 'failed' || job.status === 'needs_attention';
}

function canonicalJobUrl(raw: string): string | undefined {
  try {
    const url = parseSupportedUrl(raw);
    if (url.hostname === 'nowcoder.com') url.hostname = 'www.nowcoder.com';
    return canonicalizeUrl(url).href;
  } catch {
    return undefined;
  }
}

/** Exclude persisted candidates except for their single cooled terminal-failure retry. */
export function knownNowcoderPlanUrls(
  jobs: readonly JobRecord[],
  currentBatchId: string,
  now: string,
): Set<string> {
  const grouped = new Map<string, JobRecord[]>();
  for (const job of jobs) {
    const url = canonicalJobUrl(job.url);
    if (!url) continue;
    const matches = grouped.get(url) ?? [];
    matches.push(job);
    grouped.set(url, matches);
  }

  const known = new Set<string>();
  const nowMs = Date.parse(now);
  for (const [url, matches] of grouped) {
    if (matches.some(job => job.batchId === currentBatchId)) {
      known.add(url);
      continue;
    }
    const failures = matches.filter(isTerminalFailure);
    if (failures.length !== matches.length || failures.length >= 2) {
      known.add(url);
      continue;
    }
    const mostRecentFailureMs = Math.max(...failures.map(job => Date.parse(job.updatedAt)));
    if (
      !Number.isFinite(nowMs) ||
      !Number.isFinite(mostRecentFailureMs) ||
      nowMs - mostRecentFailureMs < FE_JOURNEY_PRESET.nowcoder.recoverableFailureCooldownMs
    ) {
      known.add(url);
    }
  }
  return known;
}

/** Rehydrate catalog-pending Nowcoder evidence without rediscovering or recollecting it. */
export function pendingNowcoderPlanJobs(
  jobs: readonly JobRecord[],
  pendingContentIds: ReadonlySet<string>,
): JobRecord[] {
  const latestByContentId = new Map<string, JobRecord>();
  for (const job of jobs) {
    if (
      job.status !== 'saved'
      || !job.outputPath
    ) continue;
    const canonicalUrl = canonicalJobUrl(job.url);
    if (!canonicalUrl) continue;
    const contentId = stableContentId(canonicalUrl);
    if (!pendingContentIds.has(contentId)) continue;
    const existing = latestByContentId.get(contentId);
    if (!existing || job.updatedAt > existing.updatedAt) latestByContentId.set(contentId, job);
  }
  return [...latestByContentId.values()].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
}
