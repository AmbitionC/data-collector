import { describe, expect, it } from 'vitest';
import type { CollectedDocument } from '@data-collector/shared';
import {
  analyzeNowcoderEvidence,
  scoreFeJourneyCandidate,
} from '../../packages/bridge/src/feJourney/index.js';

function nowcoder(
  title: string,
  text: string,
  overrides: Partial<CollectedDocument> = {},
): CollectedDocument {
  return {
    schemaVersion: 1,
    source: 'nowcoder',
    kind: 'post',
    url: 'https://www.nowcoder.com/feed/main/detail/42ba29ab006d4bb793112eb263d18f6a',
    canonicalUrl: 'https://www.nowcoder.com/feed/main/detail/42ba29ab006d4bb793112eb263d18f6a',
    title,
    author: '匿名候选人',
    publishedAt: '2026-08-18T15:39:00.000Z',
    collectedAt: '2026-08-23T00:00:00.000Z',
    html: `<p>${text}</p>`,
    text,
    images: [],
    sourceMetadata: { contentAccess: 'full' },
    ...overrides,
  };
}

function numberedQuestions(count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `${index + 1}.这是第${index + 1}个具体技术问题，应该如何设计和验证？`,
  ).join('');
}

describe('Nowcoder interview evidence', () => {
  it('recognizes a first-person Alibaba one-round post without requiring the word 面经', () => {
    const document = nowcoder(
      '阿里云-agent开发-8.18一面（面完秒挂）',
      `面试时间：8.18。我参加了阿里云 Agent 开发岗位一面，面试官围绕项目继续追问。${numberedQuestions(14)}`,
    );

    expect(analyzeNowcoderEvidence(document)).toMatchObject({
      company: 'alibaba',
      companyLabel: '阿里',
      businessUnit: '阿里云',
      role: 'Agent 开发',
      interviewRound: '一面',
      interviewDate: '2026-08-18',
      contentAccess: 'full',
      questionCount: 14,
      evidenceGrade: 'A',
    });
    expect(scoreFeJourneyCandidate(document).candidateKinds).toContain('interview');
  });

  it('uses the title identity instead of a company merely mentioned in the body', () => {
    const evidence = analyzeNowcoderEvidence(nowcoder(
      '腾讯 TEG 后端开发工程师秋招一面',
      `我参加了腾讯 TEG 后端开发一面。之前也投递过阿里和字节。${numberedQuestions(5)}`,
    ));

    expect(evidence).toMatchObject({
      company: 'tencent',
      businessUnit: 'TEG',
      role: '后端开发',
      evidenceGrade: 'A',
    });
  });

  it('marks a detailed but explicitly paywalled interview as grade C', () => {
    const evidence = analyzeNowcoderEvidence(nowcoder(
      '阿里云 Agent 开发一面',
      `我参加了阿里云 Agent 开发岗位一面。${numberedQuestions(8)}剩余60%内容，订阅专栏后可继续查看。`,
      { truncated: true, sourceMetadata: { contentAccess: 'paywalled' } },
    ));

    expect(evidence).toMatchObject({
      contentAccess: 'paywalled',
      questionCount: 8,
      evidenceGrade: 'C',
    });
  });

  it('rejects a marketing compilation even when it contains many question marks', () => {
    const evidence = analyzeNowcoderEvidence(nowcoder(
      '2026 大厂 Agent 面试题汇总与题库领取',
      `本文汇总网上资料供大家准备。${numberedQuestions(12)}扫码加微信领取付费训练营资料。`,
      { author: '求职资料号' },
    ));

    expect(evidence.evidenceGrade).toBe('C');
    expect(evidence.evidenceReasons).toContain('汇编或营销');
  });

  it('does not mistake a JD and preparation analysis for a first-hand interview', () => {
    const evidence = analyzeNowcoderEvidence(nowcoder(
      '年包50w的字节 Agent 岗，到底要会啥',
      [
        '我挑了这个 AI 应用开发岗仔细看了一下 JD，下面逐条拆解岗位职责。',
        '面试官大概率会追问：LLM 响应慢怎么办？上下文太长怎么办？',
        '准备清单：1.吃透 RAG 全链路。2.掌握 Agent 核心机制。3.夯实后端基础。',
      ].join(''),
    ));

    expect(evidence).toMatchObject({
      company: 'bytedance',
      evidenceGrade: 'C',
    });
    expect(evidence.evidenceReasons).toContain('汇编或营销');
    expect(evidence.evidenceReasons).toContain('缺少第一人称过程');
  });

  it('grades a first-hand post with one soft repository recommendation as B', () => {
    const evidence = analyzeNowcoderEvidence(nowcoder(
      '字节跳动火山引擎 Agent 平台一面面经',
      `我参加了字节跳动 Agent 平台开发一面。${numberedQuestions(6)}推荐我整理的开源仓库：https://github.com/example/agent-notes`,
    ));

    expect(evidence).toMatchObject({
      company: 'bytedance',
      evidenceGrade: 'B',
    });
    expect(evidence.evidenceReasons).toContain('轻度推荐');
  });

  it('keeps a title-identified PDD interview out of Alibaba when the body mentions Alibaba Cloud ASR', () => {
    const evidence = analyzeNowcoderEvidence(nowcoder(
      '拼多多 Agent 开发一面面经',
      `我参加了拼多多 Agent 开发一面，项目中接入过阿里云 ASR。${numberedQuestions(6)}`,
    ));

    expect(evidence).toMatchObject({
      company: 'other',
      companyLabel: '拼多多',
      agentRelevant: true,
      evidenceGrade: 'A',
    });
  });

  it('recognizes supplemental big-tech AI roles and counts structured question lists', () => {
    const oppo = nowcoder(
      'OPPO AI全栈 一面面经',
      '我参加了 OPPO AI 全栈一面。以下是具体问题：自我介绍用过哪些AI开发工具介绍项目有哪些线性数据结构反问部门方向',
      {
        html: [
          '<p>我参加了 OPPO AI 全栈一面。以下是具体问题：</p>',
          '<ol>',
          ...Array.from({ length: 13 }, (_, index) => `<li value="${index + 1}">核心问题 ${index + 1}</li>`),
          '</ol><p><strong>反问</strong></p><ol><li>部门方向</li><li>技术栈</li></ol>',
        ].join(''),
      },
    );
    const kuaishou = nowcoder(
      '快手大模型应用 Java 实习一面面经',
      `我参加了快手大模型应用岗位一面，面试官继续追问 Agent 工具和评测。${numberedQuestions(6)}`,
    );

    expect(analyzeNowcoderEvidence(oppo)).toMatchObject({
      company: 'other',
      companyLabel: 'OPPO',
      questionCount: 13,
      agentRelevant: true,
      evidenceGrade: 'B',
    });
    expect(analyzeNowcoderEvidence(kuaishou)).toMatchObject({
      company: 'other',
      companyLabel: '快手',
      agentRelevant: true,
      evidenceGrade: 'B',
    });
  });

  it('does not stop a numbered question sequence when a question starts with a number', () => {
    const evidence = analyzeNowcoderEvidence(nowcoder(
      '腾讯 AI 应用开发一面',
      '我参加了腾讯 AI 应用开发一面。1.Prompt 如何选择？2.RAG 如何评估？3.Agent 如何降级？4.Workflow 和 Agent 的边界？5.Token 如何预算？6.1个汉字大约是多少 token？7.上下文被截断怎么办？8.如何设计回滚？',
    ));

    expect(evidence.questionCount).toBe(8);
  });

  it('does not parse a model version as an interview date', () => {
    const evidence = analyzeNowcoderEvidence(nowcoder(
      '字节 Agent 开发一面：GPT-5.5 与工具调用',
      `我参加了字节 Agent 开发一面，主要讨论 GPT-5.5。${numberedQuestions(5)}`,
    ));

    expect(evidence.interviewDate).toBeUndefined();
  });

  it('accepts only a labelled short interview date or an explicit four-digit year', () => {
    const labelled = analyzeNowcoderEvidence(nowcoder(
      '腾讯 Agent 开发一面',
      `面试时间：5.5。我参加了腾讯 Agent 开发一面。${numberedQuestions(5)}`,
    ));
    const fullYear = analyzeNowcoderEvidence(nowcoder(
      '腾讯 Agent 开发一面',
      `2026-05-06 我参加了腾讯 Agent 开发一面。${numberedQuestions(5)}`,
    ));

    expect(labelled.interviewDate).toBe('2026-05-05');
    expect(fullYear.interviewDate).toBe('2026-05-06');
  });

  it('downgrades an explicit parody housekeeping interview to C', () => {
    const evidence = analyzeNowcoderEvidence(nowcoder(
      '字节保洁岗 Agent 一面面经，只为博君一笑',
      `我参加了字节 Agent 一面，以下内容纯属戏仿。${numberedQuestions(6)}`,
    ));

    expect(evidence.evidenceGrade).toBe('C');
    expect(evidence.evidenceReasons).toContain('戏仿或搬运');
  });

  it('downgrades a first-person merged compilation to C', () => {
    const evidence = analyzeNowcoderEvidence(nowcoder(
      '阿里 Agent 多份面经合并汇编稿',
      `我参加了阿里 Agent 开发面试，本文把多条网络面经合并整理。${numberedQuestions(8)}`,
    ));

    expect(evidence.evidenceGrade).toBe('C');
    expect(evidence.evidenceReasons).toContain('汇编或营销');
  });

  it('marks a generic backend interview as not Agent relevant despite strong interview evidence', () => {
    const evidence = analyzeNowcoderEvidence(nowcoder(
      '腾讯后端开发一面面经',
      `我参加了腾讯后端开发一面，面试官围绕数据库事务和 Java 并发追问。${numberedQuestions(6)}`,
    ));

    expect(evidence).toMatchObject({ evidenceGrade: 'A', agentRelevant: false });
  });
});
