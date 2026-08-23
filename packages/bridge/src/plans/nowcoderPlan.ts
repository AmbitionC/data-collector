import type { CollectedDocument } from '@data-collector/shared';
import { FE_JOURNEY_PRESET } from '../feJourney/preset.js';
import {
  enrichNowcoderEvidence,
  type NowcoderCompany,
} from '../feJourney/nowcoderEvidence.js';

export const NOWCODER_COMPANIES = ['bytedance', 'tencent', 'alibaba', 'ant'] as const;
export type CompanyId = NowcoderCompany;

export interface NowcoderPlanRejection {
  url: string;
  reason: string;
}

export interface NowcoderPlanSelection {
  accepted: CollectedDocument[];
  coverage: Record<CompanyId, number>;
  rejected: NowcoderPlanRejection[];
}

function shanghaiDate(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FE_JOURNEY_PRESET.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

function rotationOffset(iso: string): number {
  const day = Math.floor(Date.parse(`${shanghaiDate(iso)}T00:00:00.000Z`) / 86_400_000);
  return ((day % NOWCODER_COMPANIES.length) + NOWCODER_COMPANIES.length) % NOWCODER_COMPANIES.length;
}

function companyOf(document: CollectedDocument): CompanyId | undefined {
  const value = document.sourceMetadata?.company;
  return NOWCODER_COMPANIES.find(company => company === value);
}

function evidenceGradeOf(document: CollectedDocument): string | undefined {
  const value = document.sourceMetadata?.evidenceGrade;
  return typeof value === 'string' ? value : undefined;
}

function recencyOf(document: CollectedDocument): string | undefined {
  const interviewDate = document.sourceMetadata?.interviewDate;
  if (typeof interviewDate === 'string') return `${interviewDate}T00:00:00.000Z`;
  return document.publishedAt;
}

/** 30 天内 A/B 级真实面经，按公司轮转取样；任何公司都不能突破 4 条。 */
export function selectNowcoderPlanCandidates(
  documents: readonly CollectedDocument[],
  now: string,
): NowcoderPlanSelection {
  const cutoff = Date.parse(now) - 30 * 24 * 60 * 60 * 1_000;
  const rejected: NowcoderPlanRejection[] = [];
  const eligible: CollectedDocument[] = [];

  for (const raw of documents) {
    const document = enrichNowcoderEvidence(raw);
    if (document.feJourney?.duplicateOf) {
      rejected.push({ url: document.canonicalUrl, reason: '重复问题簇' });
      continue;
    }
    const recentAt = recencyOf(document);
    if (!recentAt || Date.parse(recentAt) < cutoff || Date.parse(recentAt) > Date.parse(now)) {
      rejected.push({ url: document.canonicalUrl, reason: '超过30天' });
      continue;
    }
    if (!companyOf(document) || !['A', 'B'].includes(evidenceGradeOf(document) ?? '')) {
      rejected.push({ url: document.canonicalUrl, reason: '证据等级不足' });
      continue;
    }
    eligible.push(document);
  }

  eligible.sort((left, right) =>
    (recencyOf(right) ?? '').localeCompare(recencyOf(left) ?? '') ||
    left.canonicalUrl.localeCompare(right.canonicalUrl));
  const buckets = new Map<CompanyId, CollectedDocument[]>(
    NOWCODER_COMPANIES.map(company => [
      company,
      eligible.filter(document => companyOf(document) === company),
    ]),
  );
  const offset = rotationOffset(now);
  const order = NOWCODER_COMPANIES.map((_, index) =>
    NOWCODER_COMPANIES[(index + offset) % NOWCODER_COMPANIES.length]!);
  const accepted: CollectedDocument[] = [];
  const seenClusters = new Set<string>();
  let advanced = true;
  while (accepted.length < FE_JOURNEY_PRESET.nowcoder.planAcceptedLimit && advanced) {
    advanced = false;
    for (const company of order) {
      const companyAccepted = accepted.filter(document => companyOf(document) === company).length;
      if (companyAccepted >= FE_JOURNEY_PRESET.nowcoder.planPerCompanyAcceptedLimit) continue;
      const bucket = buckets.get(company)!;
      while (bucket.length > 0) {
        const document = bucket.shift()!;
        const cluster = document.feJourney?.clusterId;
        if (cluster && seenClusters.has(cluster)) {
          rejected.push({ url: document.canonicalUrl, reason: '重复问题簇' });
          continue;
        }
        if (cluster) seenClusters.add(cluster);
        accepted.push(document);
        advanced = true;
        break;
      }
      if (accepted.length >= FE_JOURNEY_PRESET.nowcoder.planAcceptedLimit) break;
    }
  }

  const acceptedUrls = new Set(accepted.map(document => document.canonicalUrl));
  for (const document of eligible) {
    if (!acceptedUrls.has(document.canonicalUrl) && !rejected.some(item => item.url === document.canonicalUrl)) {
      rejected.push({ url: document.canonicalUrl, reason: '公司或批次上限' });
    }
  }
  const coverage = Object.fromEntries(NOWCODER_COMPANIES.map(company => [
    company,
    accepted.filter(document => companyOf(document) === company).length,
  ])) as Record<CompanyId, number>;
  return { accepted, coverage, rejected };
}
