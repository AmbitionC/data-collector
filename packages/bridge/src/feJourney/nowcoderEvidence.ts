import type { CollectedDocument } from '@data-collector/shared';

export type NowcoderCompany = 'bytedance' | 'tencent' | 'alibaba' | 'ant' | 'other';
export type NowcoderContentAccess = 'full' | 'truncated' | 'paywalled';
export type NowcoderEvidenceGrade = 'A' | 'B' | 'C';

export interface NowcoderEvidence {
  company?: NowcoderCompany;
  companyLabel?: string;
  businessUnit?: string;
  role?: string;
  interviewRound?: string;
  interviewDate?: string;
  contentAccess: NowcoderContentAccess;
  questionCount: number;
  agentRelevant: boolean;
  evidenceGrade: NowcoderEvidenceGrade;
  evidenceReasons: string;
}

interface CompanyDefinition {
  id: NowcoderCompany;
  label: string;
  aliases: readonly RegExp[];
}

const COMPANIES: readonly CompanyDefinition[] = [
  { id: 'bytedance', label: '字节', aliases: [/字节跳动|字节|抖音|TikTok|火山引擎/i] },
  { id: 'tencent', label: '腾讯', aliases: [/腾讯|微信支付|微信|\bWXG\b|\bTEG\b/i] },
  { id: 'alibaba', label: '阿里', aliases: [/阿里云|阿里巴巴|阿里|淘天|淘宝|天猫/i] },
  { id: 'ant', label: '蚂蚁', aliases: [/蚂蚁集团|蚂蚁|支付宝|Alipay/i] },
  { id: 'other', label: '拼多多', aliases: [/拼多多|PDD/i] },
  { id: 'other', label: '小红书', aliases: [/小红书|REDnote/i] },
  { id: 'other', label: '月之暗面', aliases: [/月之暗面|Moonshot|Kimi/i] },
  { id: 'other', label: '百度', aliases: [/百度|Baidu/i] },
  { id: 'other', label: '华为', aliases: [/华为|Huawei/i] },
  { id: 'other', label: '快手', aliases: [/快手|Kuaishou/i] },
  { id: 'other', label: '哔哩哔哩', aliases: [/哔哩哔哩|B\s*站|bilibili|阿\s*b/i] },
  { id: 'other', label: '深信服', aliases: [/深信服|信服|Sangfor/i] },
  { id: 'other', label: '影石创新', aliases: [/影石创新|影石|Insta360/i] },
  { id: 'other', label: '大疆创新', aliases: [/大疆创新|大疆|DJI/i] },
  { id: 'other', label: 'OPPO', aliases: [/OPPO|欧珀/i] },
];

const BUSINESS_UNITS: readonly [RegExp, string][] = [
  [/火山引擎/i, '火山引擎'],
  [/抖音|TikTok/i, 'TikTok/抖音'],
  [/微信支付/i, '微信支付'],
  [/\bWXG\b/i, 'WXG'],
  [/\bTEG\b/i, 'TEG'],
  [/阿里云/i, '阿里云'],
  [/淘天|淘宝|天猫/i, '淘天'],
  [/支付宝|Alipay/i, '支付宝'],
];

const ROLE_PATTERNS: readonly [RegExp, string][] = [
  [/(?:AI\s*)?Agent\s*(?:平台)?开发/i, 'Agent 开发'],
  [/大模型应用开发/i, '大模型应用开发'],
  [/AI\s*应用开发/i, 'AI 应用开发'],
  [/AI\s*全栈开发/i, 'AI 全栈开发'],
  [/后端开发(?:工程师)?/i, '后端开发'],
  [/后台开发(?:工程师)?/i, '后台开发'],
  [/Agent\s*平台/i, 'Agent 平台'],
];

const ROUND_PATTERN = /(?:秋招|暑期|实习|日常|技术|HR|主管|交叉|终)?\s*(一面|二面|三面|四面|五面|终面|技术面|HR面)/iu;
const FIRST_PERSON_PROCESS_PATTERN = /(?:^|[，。；：\s])(?:我|本人)(?:参加|经历|面了|面试|投递|回答|做过|先|当时)|我的(?:面试|回答|项目|经历)/u;
const INTERVIEWER_PROCESS_PATTERN = /面试官(?:先|接着|随后|最后)?(?:问了|追问了|让我|叫我)|(?:被|主要)问了/u;
const INTERVIEW_TITLE_PATTERN = /一面|二面|三面|四面|五面|终面|HR\s*面|面经|面试经验|面试复盘/iu;
const EDITORIAL_PATTERN = /JD\s*(?:拆解|分析)|岗位(?:拆解|分析)|准备清单|备考|全解析|到底要会啥|导读：|避坑指南|独家.{0,12}(?:公式|方法)|适合.{0,12}收藏/iu;
const COMPILATION_PATTERN = /(?:面试题|面经).{0,12}(?:汇总|合集|题库|整理|合并|汇编)|(?:汇总|合集|合并|汇编).{0,12}(?:面试题|面经)|多(?:条|份)面经|合并整理|汇编稿|三年面试五年模拟|含完整答案|参考答案/u;
const PARODY_OR_COPY_PATTERN = /戏仿|恶搞|段子|只为博君一笑|保洁岗|网络搬运|网上搬运|转载自|网传/u;
const HARD_PROMOTION_PATTERN = /加微信|扫码|训练营|付费资料|进群|领取资料|订阅专栏后|购买后(?:可)?继续查看/u;
const SOFT_RECOMMENDATION_PATTERN = /推荐.{0,30}(?:开源|仓库|GitHub)|github\.com\//iu;
const EXPLICIT_AGENT_PATTERN = /\bAgent\b|智能体|AI\s*(?:应用|全栈)|大模型应用|RAG|MCP|AI\s*Infra/iu;
const STRONG_ENGINEERING_SIGNALS: readonly RegExp[] = [
  /\bLLM\b|大语言模型/iu,
  /向量(?:数据库|检索)|Embedding/iu,
  /Prompt|提示词/iu,
  /Function\s*Calling|Tool\s*Calling|工具调用/iu,
  /LangChain|LangGraph/iu,
  /模型(?:推理|部署|微调|评测)/u,
  /多智能体|工作流编排/u,
];

function matchCompany(text: string): CompanyDefinition | undefined {
  return COMPANIES.find(company => company.aliases.some(pattern => pattern.test(text)));
}

function matchBusinessUnit(text: string): string | undefined {
  return BUSINESS_UNITS.find(([pattern]) => pattern.test(text))?.[1];
}

function matchRole(text: string): string | undefined {
  return ROLE_PATTERNS.find(([pattern]) => pattern.test(text))?.[1];
}

function accessOf(document: CollectedDocument): NowcoderContentAccess {
  const value = document.sourceMetadata?.contentAccess;
  if (value === 'full' || value === 'truncated' || value === 'paywalled') return value;
  return document.truncated ? 'truncated' : 'full';
}

function interviewDateOf(document: CollectedDocument, text: string): string | undefined {
  const fullYear = text.match(/(?:^|[^\d])((?:19|20)\d{2})[年./-](\d{1,2})[月./-](\d{1,2})(?:日|号)?/u);
  const labelledShort = text.match(/(?:面试时间|面试日期|面试经过)\s*[:：]?\s*(\d{1,2})[月./-](\d{1,2})(?:日|号)?/u);
  const year = fullYear?.[1] ?? (labelledShort ? document.publishedAt?.slice(0, 4) : undefined);
  const month = Number(fullYear?.[2] ?? labelledShort?.[1]);
  const day = Number(fullYear?.[3] ?? labelledShort?.[2]);
  if (!year || !Number.isSafeInteger(month) || !Number.isSafeInteger(day)) return undefined;
  const parsed = new Date(Date.UTC(Number(year), month - 1, day));
  if (
    parsed.getUTCFullYear() !== Number(year)
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) return undefined;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isAgentRelevant(text: string): boolean {
  if (EXPLICIT_AGENT_PATTERN.test(text)) return true;
  return STRONG_ENGINEERING_SIGNALS.filter(pattern => pattern.test(text)).length >= 2;
}

/**
 * 面经正文经 DOM 抽取后常把换行压成空格，`1.…2.…` 仍保留编号。
 * 编号序列比问号更可靠；没有编号时才按明确问句计数。
 */
export function countInterviewQuestions(text: string, html = ''): number {
  const numbered = [...text.matchAll(/(?:^|[^\d])([1-9]|[1-9]\d)[.、．]\s*(?=[\p{L}\p{N}“"（(])/gu)]
    .map(match => Number(match[1]));
  if (numbered.length >= 3) {
    let count = 0;
    let expected = numbered[0] ?? 1;
    for (const value of numbered) {
      if (value === expected) {
        count += 1;
        expected += 1;
      } else if (value === 1 && count > 0) {
        break;
      }
    }
    if (count >= 3) return count;
  }
  const questions = text
    .split(/[？?]/u)
    .slice(0, -1)
    .map(part => part.slice(-120).trim())
    .filter(part => [...part].length >= 6);
  const counterQuestionHeading = html.search(/<(?:strong|h[1-6])\b[^>]*>\s*反问\s*<\//iu);
  const interviewHtml = counterQuestionHeading >= 0 ? html.slice(0, counterQuestionHeading) : html;
  const structuredListItems = [...interviewHtml.matchAll(/<li\b/giu)].length;
  return Math.min(Math.max(questions.length, structuredListItems), 100);
}

export function analyzeNowcoderEvidence(document: CollectedDocument): NowcoderEvidence {
  const title = document.title.trim();
  const combined = `${title}\n${document.text}`;
  const titleCompany = matchCompany(title);
  const openingCompany = matchCompany(document.text.slice(0, 320));
  const company = titleCompany ?? openingCompany;
  const identityText = `${title}\n${document.text.slice(0, 360)}`;
  const businessUnit = company?.id === 'other' ? undefined : matchBusinessUnit(identityText);
  const role = matchRole(identityText);
  const round = ROUND_PATTERN.exec(identityText)?.[1];
  const interviewDate = interviewDateOf(document, identityText);
  const contentAccess = accessOf(document);
  const questionCount = countInterviewQuestions(document.text, document.html);
  const agentRelevant = isAgentRelevant(`${title}\n${document.text.slice(0, 1_200)}`);
  const editorial = EDITORIAL_PATTERN.test(title) || EDITORIAL_PATTERN.test(document.text.slice(0, 800));
  const firstHand = !editorial && (
    FIRST_PERSON_PROCESS_PATTERN.test(combined) ||
    INTERVIEWER_PROCESS_PATTERN.test(combined) ||
    (INTERVIEW_TITLE_PATTERN.test(title) && questionCount >= 3)
  );
  const compilation = editorial || COMPILATION_PATTERN.test(combined);
  const parodyOrCopied = PARODY_OR_COPY_PATTERN.test(combined);
  const hardPromotion = HARD_PROMOTION_PATTERN.test(combined);
  const softRecommendation = SOFT_RECOMMENDATION_PATTERN.test(combined);

  let evidenceGrade: NowcoderEvidenceGrade = 'C';
  if (
    contentAccess === 'full' &&
    !compilation &&
    !parodyOrCopied &&
    !hardPromotion &&
    firstHand &&
    company &&
    role &&
    (round || interviewDate) &&
    questionCount >= 3 &&
    !softRecommendation
  ) {
    evidenceGrade = 'A';
  } else if (
    contentAccess === 'full' &&
    !compilation &&
    !parodyOrCopied &&
    !hardPromotion &&
    firstHand &&
    company &&
    questionCount >= 3
  ) {
    evidenceGrade = 'B';
  }

  const reasons: string[] = [];
  if (firstHand) reasons.push('第一人称过程');
  if (company) reasons.push(`公司：${company.label}`);
  if (role) reasons.push(`岗位：${role}`);
  if (round) reasons.push(`轮次：${round}`);
  if (interviewDate) reasons.push(`面试日期：${interviewDate}`);
  reasons.push(`问题：${questionCount}个`);
  reasons.push(agentRelevant ? 'Agent 相关' : 'Agent 相关性不足');
  if (contentAccess !== 'full') reasons.push(`正文：${contentAccess}`);
  if (parodyOrCopied) reasons.push('戏仿或搬运');
  else if (compilation || hardPromotion) reasons.push('汇编或营销');
  else if (softRecommendation) reasons.push('轻度推荐');
  if (!firstHand) reasons.push('缺少第一人称过程');

  return {
    ...(company ? { company: company.id, companyLabel: company.label } : {}),
    ...(businessUnit ? { businessUnit } : {}),
    ...(role ? { role } : {}),
    ...(round ? { interviewRound: round } : {}),
    ...(interviewDate ? { interviewDate } : {}),
    contentAccess,
    questionCount,
    agentRelevant,
    evidenceGrade,
    evidenceReasons: reasons.join('；'),
  };
}

export function enrichNowcoderEvidence(document: CollectedDocument): CollectedDocument {
  if (document.source !== 'nowcoder') return document;
  const evidence = analyzeNowcoderEvidence(document);
  return {
    ...document,
    sourceMetadata: {
      ...(document.sourceMetadata ?? {}),
      ...evidence,
    },
  };
}
