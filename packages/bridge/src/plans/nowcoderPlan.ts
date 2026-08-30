import type { CollectedDocument } from '@data-collector/shared';
import { FE_JOURNEY_PRESET } from '../feJourney/preset.js';
import {
  enrichNowcoderEvidence,
  type NowcoderCompany,
} from '../feJourney/nowcoderEvidence.js';
import {
  hammingDistance64,
  normalizedInterviewQuestions,
  simHash64,
} from '../feJourney/fingerprint.js';

export const PRIMARY_NOWCODER_COMPANIES = ['bytedance', 'tencent', 'alibaba', 'ant'] as const;
export const NOWCODER_COMPANIES = [...PRIMARY_NOWCODER_COMPANIES, 'other'] as const;
export type CompanyId = NowcoderCompany;

export interface NowcoderPlanRejection {
  url: string;
  reason: string;
}

export interface NowcoderPlanSelection {
  accepted: CollectedDocument[];
  coverage: Record<CompanyId, number>;
  rejected: NowcoderPlanRejection[];
  structuredRejected: Array<NowcoderPlanRejection & {
    code:
      | 'OUTSIDE_30_DAYS'
      | 'AGENT_RELEVANCE_INSUFFICIENT'
      | 'NON_AGENT_ROLE'
      | 'EVIDENCE_GRADE_INSUFFICIENT'
      | 'DUPLICATE_CLUSTER'
      | 'DUPLICATE_QUESTION_SEQUENCE'
      | 'TARGET_TRUNCATED';
  }>;
  /** Passed every per-document hard gate, before batch dedupe and target truncation. */
  qualifiedCount: number;
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
  return ((day % PRIMARY_NOWCODER_COMPANIES.length) + PRIMARY_NOWCODER_COMPANIES.length)
    % PRIMARY_NOWCODER_COMPANIES.length;
}

function companyOf(document: CollectedDocument): CompanyId | undefined {
  const value = document.sourceMetadata?.company;
  return NOWCODER_COMPANIES.find(company => company === value);
}

function evidenceGradeOf(document: CollectedDocument): string | undefined {
  const value = document.sourceMetadata?.evidenceGrade;
  return typeof value === 'string' ? value : undefined;
}

function agentRelevant(document: CollectedDocument): boolean {
  return document.sourceMetadata?.agentRelevant === true;
}

const EXPLICIT_AGENT_TITLE = /\bAgent\b|智能体|AI\s*(?:应用|全栈|研发|开发)|大模型|RAG/iu;
const NON_AGENT_ROLE = /前端|客户端|测试开发|产品经理|运营|全栈/iu;

function agentRoleRelevant(document: CollectedDocument): boolean {
  if (EXPLICIT_AGENT_TITLE.test(document.title)) return true;
  const identity = `${document.title}\n${document.text.slice(0, 240)}`;
  return !NON_AGENT_ROLE.test(identity);
}

function finiteTimestamp(value: string | undefined): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function recencyOf(document: CollectedDocument): number | undefined {
  const interviewDate = document.sourceMetadata?.interviewDate;
  if (typeof interviewDate === 'string') {
    const parsedInterviewDate = finiteTimestamp(`${interviewDate}T00:00:00.000Z`);
    if (parsedInterviewDate !== undefined) return parsedInterviewDate;
  }
  return finiteTimestamp(document.publishedAt);
}

function commonQuestionSequenceLength(left: readonly string[], right: readonly string[]): number {
  let previous = new Array<number>(right.length + 1).fill(0);
  for (const leftQuestion of left) {
    const current = new Array<number>(right.length + 1).fill(0);
    for (let index = 1; index <= right.length; index += 1) {
      current[index] = leftQuestion === right[index - 1]
        ? (previous[index - 1] ?? 0) + 1
        : Math.max(previous[index] ?? 0, current[index - 1] ?? 0);
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

function repeatsQuestionSequence(left: CollectedDocument, right: CollectedDocument): boolean {
  const leftQuestions = normalizedInterviewQuestions(left.text);
  const rightQuestions = normalizedInterviewQuestions(right.text);
  const shorter = Math.min(leftQuestions.length, rightQuestions.length);
  if (shorter < 8) return false;
  if (
    companyOf(left) === companyOf(right)
    && commonQuestionSequenceLength(leftQuestions, rightQuestions) / shorter >= 0.7
  ) {
    return true;
  }
  const longer = Math.max(leftQuestions.length, rightQuestions.length);
  return shorter >= 15
    && shorter / longer >= 0.85
    && hammingDistance64(simHash64(left.text), simHash64(right.text)) <= 9;
}

/** A/B 级真实面经，固定计划限 30 天；定向搜索沿已验证的 latest 顺序继续补位。 */
export function selectNowcoderPlanCandidates(
  documents: readonly CollectedDocument[],
  now: string,
  target: number = FE_JOURNEY_PRESET.nowcoder.planTargetAccepted,
  mode: 'fixed-plan' | 'latest-search' = 'fixed-plan',
): NowcoderPlanSelection {
  if (!Number.isInteger(target) || target < 1 || target > 10) {
    throw new RangeError('目标数量必须在 1–10 之间');
  }
  const currentTime = Date.parse(now);
  if (!Number.isFinite(currentTime)) throw new RangeError('当前时间无效');
  const cutoff = currentTime - 30 * 24 * 60 * 60 * 1_000;
  const rejected: NowcoderPlanRejection[] = [];
  const structuredRejected: NowcoderPlanSelection['structuredRejected'] = [];
  const reject = (
    document: CollectedDocument,
    reason: string,
    code: NowcoderPlanSelection['structuredRejected'][number]['code'],
  ): void => {
    rejected.push({ url: document.canonicalUrl, reason });
    structuredRejected.push({ url: document.canonicalUrl, reason, code });
  };
  const eligible: CollectedDocument[] = [];

  for (const raw of documents) {
    const document = enrichNowcoderEvidence(raw);
    const recentAt = recencyOf(document);
    if (
      recentAt === undefined
      || recentAt > currentTime
      || (mode === 'fixed-plan' && recentAt < cutoff)
    ) {
      reject(document, '超过30天', 'OUTSIDE_30_DAYS');
      continue;
    }
    if (!agentRelevant(document)) {
      reject(document, 'Agent 相关性不足', 'AGENT_RELEVANCE_INSUFFICIENT');
      continue;
    }
    if (!agentRoleRelevant(document)) {
      reject(document, '非 Agent 研发岗位', 'NON_AGENT_ROLE');
      continue;
    }
    if (!companyOf(document) || !['A', 'B'].includes(evidenceGradeOf(document) ?? '')) {
      reject(document, '证据等级不足', 'EVIDENCE_GRADE_INSUFFICIENT');
      continue;
    }
    eligible.push(document);
  }

  eligible.sort((left, right) =>
    (recencyOf(right) ?? Number.NEGATIVE_INFINITY) - (recencyOf(left) ?? Number.NEGATIVE_INFINITY) ||
    left.canonicalUrl.localeCompare(right.canonicalUrl));
  const buckets = new Map<CompanyId, CollectedDocument[]>(
    NOWCODER_COMPANIES.map(company => [
      company,
      eligible.filter(document => companyOf(document) === company),
    ]),
  );
  const offset = rotationOffset(now);
  const order: CompanyId[] = [
    ...PRIMARY_NOWCODER_COMPANIES.map((_, index) =>
      PRIMARY_NOWCODER_COMPANIES[(index + offset) % PRIMARY_NOWCODER_COMPANIES.length]!),
    'other',
  ];
  const accepted: CollectedDocument[] = [];
  const seenClusters = new Set<string>();
  let advanced = true;
  while (accepted.length < target && advanced) {
    advanced = false;
    for (const company of order) {
      const bucket = buckets.get(company)!;
      while (bucket.length > 0) {
        const document = bucket.shift()!;
        const cluster = document.feJourney?.clusterId;
        if (document.feJourney?.duplicateOf || (cluster && seenClusters.has(cluster))) {
          reject(document, '重复问题簇', 'DUPLICATE_CLUSTER');
          continue;
        }
        if (accepted.some(existing => repeatsQuestionSequence(existing, document))) {
          reject(document, '重复问题簇', 'DUPLICATE_QUESTION_SEQUENCE');
          continue;
        }
        if (cluster) seenClusters.add(cluster);
        accepted.push(document);
        advanced = true;
        break;
      }
      if (accepted.length >= target) break;
    }
  }

  const acceptedUrls = new Set(accepted.map(document => document.canonicalUrl));
  for (const document of eligible) {
    if (!acceptedUrls.has(document.canonicalUrl) && !rejected.some(item => item.url === document.canonicalUrl)) {
      reject(document, '批次上限', 'TARGET_TRUNCATED');
    }
  }
  const coverage = Object.fromEntries(NOWCODER_COMPANIES.map(company => [
    company,
    accepted.filter(document => companyOf(document) === company).length,
  ])) as Record<CompanyId, number>;
  return { accepted, coverage, rejected, structuredRejected, qualifiedCount: eligible.length };
}
