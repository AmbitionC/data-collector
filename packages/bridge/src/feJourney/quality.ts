import type {
  CollectedDocument,
  FeJourneyCandidateKind,
  FeJourneyCandidateMetadata,
} from '@data-collector/shared';
import { contentFingerprint, simHash64 } from './fingerprint.js';
import { analyzeNowcoderEvidence } from './nowcoderEvidence.js';

type UnclusteredCandidate = Omit<FeJourneyCandidateMetadata, 'clusterId' | 'duplicateOf'>;

const INTERVIEW_SIGNALS = [
  /面经/i,
  /(?:一|二|三|四|五|终)面/u,
  /面试官/u,
  /追问/u,
  /笔试/u,
  /面试题/u,
];
const KNOWLEDGE_SIGNALS = [
  /原理/i,
  /实现/i,
  /架构/i,
  /源码/i,
  /评测/i,
  /部署/i,
  /故障/i,
  /性能/i,
  /对比/i,
  /工具调用/i,
  /向量检索|向量召回/i,
  /RAG/i,
  /MCP/i,
  /LangGraph/i,
  /事件循环/i,
  /可观测/i,
];
const OPERATION_SIGNALS = [
  /趋势/u,
  /争议/u,
  /踩坑/u,
  /痛点/u,
  /行业变化/u,
  /用户反馈/u,
  /爆火/u,
  /选题/u,
  /流量/u,
  /热点/u,
];
const PROJECT_SIGNALS = [/开源/u, /GitHub/i, /代码仓库|仓库/u, /\bDemo\b/i, /项目架构/u, /快速开始/u];
const PROMOTION_SIGNALS = [/加微信/u, /扫码/u, /付费/u, /训练营/u, /课程/u, /咨询/u, /进群/u, /领取资料/u];
const JOB_CHATTER_SIGNALS = [/求\s*offer/i, /许愿/u, /求捞|捞一下/u, /求内推/u, /蹲一个/u, /简历挂/u];
const TRUSTED_CONTENT_DOMAINS = [
  'github.com',
  'nowcoder.com',
  'arxiv.org',
  'huggingface.co',
  'openai.com',
  'microsoft.com',
  'python.org',
  'redis.io',
  'docker.com',
  'npmjs.com',
];

function matchCount(text: string, patterns: readonly RegExp[]): number {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function suspiciousBareDomains(text: string): string[] {
  const matches = text.matchAll(
    /\b(?:https?:\/\/)?([a-z0-9][a-z0-9-]{2,}(?:\.[a-z0-9-]+)*\.(?:com\.cn|com|cn|net|top|xyz))\b/gi,
  );
  return [...new Set([...matches]
    .map(match => match[1]?.toLocaleLowerCase('en-US'))
    .filter((domain): domain is string => Boolean(domain))
    .filter(domain => !TRUSTED_CONTENT_DOMAINS.some(
      trusted => domain === trusted || domain.endsWith(`.${trusted}`),
    )))];
}

function scoreProject(document: CollectedDocument, combined: string): {
  score: number;
  signals: string[];
} {
  let score = 0;
  const signals: string[] = [];
  const metadata = document.sourceMetadata ?? {};

  if (/\b(?:AI\s+)?agent\b|RAG|MCP|教程|示例|example/i.test(combined)) {
    score += 25;
    signals.push('学习主题相关');
  }
  if (/architecture|架构|Docker|部署|evaluation|评测/i.test(combined)) {
    score += 20;
    signals.push('工程要素完整');
  }
  if (/quick\s*start|快速开始|npm\s+(?:install|run)|pnpm|docker\s+compose|安装/i.test(combined)) {
    score += 15;
    signals.push('有运行说明');
  }
  if (/(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|\.github\/workflows\/|(?:^|[\s`/])tests?\//im.test(combined)) {
    score += 15;
    signals.push('有代码质量证据');
  }
  if (/tool|memory|planning|RAG|MCP|multi-agent|workflow/i.test(combined)) {
    score += 10;
    signals.push('包含 Agent 技术实现');
  }
  if (typeof metadata.license === 'string' && metadata.license.trim().length > 0) {
    score += 6;
    signals.push('许可证明确');
  }
  const updatedAt = typeof metadata.updatedAt === 'string' ? Date.parse(metadata.updatedAt) : Number.NaN;
  const collectedAt = Date.parse(document.collectedAt);
  if (Number.isFinite(updatedAt) && Number.isFinite(collectedAt) && collectedAt - updatedAt <= 180 * 86_400_000) {
    score += 4;
    signals.push('近期仍维护');
  }
  if (/documentation|文档|demo|截图|screenshot/i.test(combined)) {
    score += 5;
    signals.push('文档或演示充分');
  }

  return { score: clampScore(score), signals };
}

export function scoreFeJourneyCandidate(document: CollectedDocument): UnclusteredCandidate {
  const combined = `${document.title}\n${document.text}`;
  const candidateKinds: FeJourneyCandidateKind[] = [];
  const qualitySignals: string[] = [];
  const exclusionReasons: string[] = [];
  const interviewCount = matchCount(combined, INTERVIEW_SIGNALS);
  const knowledgeCount = matchCount(combined, KNOWLEDGE_SIGNALS);
  const operationCount = matchCount(combined, OPERATION_SIGNALS);
  const projectCount = matchCount(combined, PROJECT_SIGNALS);
  const hasRepositoryEvidence = document.source === 'github' ||
    /https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/i.test(`${combined}\n${document.html}`);
  const nowcoderEvidence = document.source === 'nowcoder'
    ? analyzeNowcoderEvidence(document)
    : undefined;

  if (
    interviewCount >= 2 ||
    (nowcoderEvidence && nowcoderEvidence.evidenceGrade !== 'C' && nowcoderEvidence.questionCount >= 3)
  ) candidateKinds.push('interview');
  if (knowledgeCount >= 2) candidateKinds.push('knowledge');
  if (operationCount >= 2) candidateKinds.push('operation');
  if (document.source === 'github' || (projectCount >= 2 && hasRepositoryEvidence)) {
    candidateKinds.push('project');
  }

  let score = 10;
  if (candidateKinds.includes('interview')) score += 25;
  if (candidateKinds.includes('knowledge')) score += 20;
  if (candidateKinds.includes('operation')) score += 15;
  if (candidateKinds.includes('project')) score += 20;

  const length = [...document.text.trim()].length;
  if (length >= 1_000) {
    score += 20;
    qualitySignals.push('正文信息充足');
  } else if (length >= 300) {
    score += 15;
    qualitySignals.push('正文信息较完整');
  } else if (length >= 120) {
    score += 10;
  } else if (length >= 70) {
    score += 8;
  } else {
    score -= 25;
    exclusionReasons.push('正文过短');
  }

  if (candidateKinds.includes('interview') && /我|本人|参加|面试官|一面/u.test(combined)) {
    score += 12;
    qualitySignals.push('第一手面试经历');
  }
  if (knowledgeCount >= 3) {
    score += 10;
    qualitySignals.push('包含工程知识证据');
  }
  if (operationCount >= 3) {
    score += 8;
    qualitySignals.push('包含可验证的选题信号');
  }

  const promotionCount = matchCount(combined, PROMOTION_SIGNALS);
  if (promotionCount >= 2) {
    score -= 30;
    exclusionReasons.push('推广导流');
  }
  if (matchCount(combined, JOB_CHATTER_SIGNALS) >= 2) {
    score -= 30;
    exclusionReasons.push('求职闲聊');
  }
  if (document.source === 'nowcoder' && suspiciousBareDomains(combined).length >= 2) {
    score -= 50;
    exclusionReasons.push('可疑导流链接');
  }
  if (nowcoderEvidence?.evidenceGrade === 'C' && nowcoderEvidence.questionCount >= 3) {
    score -= nowcoderEvidence.contentAccess === 'full' ? 30 : 50;
    exclusionReasons.push(
      nowcoderEvidence.contentAccess === 'full' ? '面经证据不足' : '付费或截断正文',
    );
  }
  if (candidateKinds.length === 0) {
    score -= 20;
    exclusionReasons.push('缺少可消费内容类型');
  }

  const project = candidateKinds.includes('project') ? scoreProject(document, combined) : undefined;
  if (project) qualitySignals.push(...project.signals);

  return {
    candidateKinds,
    qualityScore: clampScore(score),
    qualitySignals,
    ...(exclusionReasons.length > 0 ? { exclusionReasons } : {}),
    contentHash: contentFingerprint(document.text),
    simHash: simHash64(document.text),
    ...(project ? { projectScore: project.score, projectSignals: project.signals } : {}),
  };
}
