import { describe, expect, it } from 'vitest';
import type { CollectedDocument } from '@data-collector/shared';
import { enrichNowcoderEvidence } from '../../packages/bridge/src/feJourney/nowcoderEvidence.js';
import { selectNowcoderPlanCandidates } from '../../packages/bridge/src/plans/nowcoderPlan.js';

const COMPANY_LABEL = {
  bytedance: '字节',
  tencent: '腾讯',
  alibaba: '阿里云',
  ant: '蚂蚁',
  other: '拼多多',
} as const;

function interview(
  company: keyof typeof COMPANY_LABEL,
  id: number,
  publishedAt = '2026-08-15T04:00:00.000Z',
  access: 'full' | 'truncated' = 'full',
): CollectedDocument {
  const url = `https://www.nowcoder.com/discuss/${id}`;
  const label = COMPANY_LABEL[company];
  return {
    schemaVersion: 1,
    source: 'nowcoder',
    kind: 'post',
    url,
    canonicalUrl: url,
    title: `${label} AI 应用开发一面面经`,
    author: `候选人-${company}-${id}`,
    publishedAt,
    collectedAt: '2026-08-23T01:00:00.000Z',
    html: '<p>面经</p>',
    text: `我参加了${label} AI 应用开发一面。1.Agent Loop 怎么设计？2.Tool 如何定义？3.Memory 如何实现？`,
    images: [],
    truncated: access === 'truncated',
    sourceMetadata: { contentAccess: access },
  };
}

describe('Nowcoder fixed collection plan selection', () => {
  it('supports exact directed targets while preserving the scheduled default', () => {
    const candidates = Array.from(
      { length: 10 },
      (_, index) => interview('alibaba', 29_000 + index),
    );

    expect(selectNowcoderPlanCandidates(candidates, '2026-08-23T01:00:00.000Z', 1).accepted)
      .toHaveLength(1);
    expect(selectNowcoderPlanCandidates(candidates, '2026-08-23T01:00:00.000Z', 7).accepted)
      .toHaveLength(7);
    expect(selectNowcoderPlanCandidates(candidates, '2026-08-23T01:00:00.000Z').accepted)
      .toHaveLength(10);
    expect(() => selectNowcoderPlanCandidates(candidates, '2026-08-23T01:00:00.000Z', 0))
      .toThrow('目标数量');
    expect(() => selectNowcoderPlanCandidates(candidates, '2026-08-23T01:00:00.000Z', 11))
      .toThrow('目标数量');
  });

  it('fills exactly ten slots without a company cap while preserving available diversity', () => {
    const candidates = [
      ...Array.from({ length: 10 }, (_, index) => interview('alibaba', 32_000 + index)),
      interview('bytedance', 30_000),
      interview('ant', 33_000, '2026-08-15T04:00:00.000Z', 'truncated'),
      interview('ant', 33_001, '2026-07-01T04:00:00.000Z'),
    ];

    const result = selectNowcoderPlanCandidates(candidates, '2026-08-23T01:00:00.000Z');

    expect(result.accepted).toHaveLength(10);
    expect(result.coverage).toEqual({ bytedance: 1, tencent: 0, alibaba: 9, ant: 0, other: 0 });
    expect(result.accepted).toContainEqual(
      expect.objectContaining({ canonicalUrl: 'https://www.nowcoder.com/discuss/30000' }),
    );
    expect(result.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: expect.stringContaining('33000'), reason: '证据等级不足' }),
      expect.objectContaining({ url: expect.stringContaining('33001'), reason: '超过30天' }),
    ]));
  });

  it('rotates the first company by Shanghai calendar date', () => {
    const documents = (['bytedance', 'tencent', 'alibaba', 'ant'] as const)
      .flatMap((company, companyIndex) => Array.from(
        { length: 2 },
        (_, index) => interview(company, 40_000 + companyIndex * 10 + index),
      ));

    const firstDay = selectNowcoderPlanCandidates(documents, '2026-08-23T01:00:00.000Z');
    const nextDay = selectNowcoderPlanCandidates(documents, '2026-08-24T01:00:00.000Z');

    expect(firstDay.accepted[0]?.sourceMetadata?.company).not.toBe(
      nextDay.accepted[0]?.sourceMetadata?.company,
    );
  });

  it('rejects a candidate already linked to an existing question-cluster representative', () => {
    const original = interview('bytedance', 50_000);
    const duplicate = {
      ...interview('bytedance', 50_001),
      feJourney: {
        candidateKinds: ['interview'] as const,
        qualityScore: 90,
        qualitySignals: [],
        contentHash: '1'.repeat(64),
        simHash: '2'.repeat(16),
        clusterId: 'cluster-existing',
        duplicateOf: 'existing-representative',
      },
    };

    const result = selectNowcoderPlanCandidates([original, duplicate], '2026-08-23T01:00:00.000Z');

    expect(result.accepted.map(document => document.canonicalUrl)).toEqual([original.canonicalUrl]);
    expect(result.rejected).toContainEqual({
      url: duplicate.canonicalUrl,
      reason: '重复问题簇',
    });
  });

  it('deduplicates a paraphrased question sequence even when the repost uses another author', () => {
    const first = {
      ...interview('other', 50_010, '2026-08-18T04:00:00.000Z'),
      title: '小红书 Agent 开发一面',
      author: '候选人甲',
      text: [
        '我参加了小红书 Agent 开发一面。',
        '1.自我介绍。2.实习时关注哪些业务指标？3.介绍项目背景和上下游。',
        '4.Agent 用在什么场景？5.Agent 使用什么开发框架？6.OpenManus 的框架是什么？',
        '7.怎么理解 Harness？8.多 Agent 并发有什么问题？9.怎样控制 Agent 并发量？',
        '10.长短期记忆怎么实现？11.ReAct 的流程是什么？12.Planner、Executor、Critic 如何协作？',
        '13.上下文过长如何处理？14.Redis 有哪些数据结构？15.Java 类加载机制是什么？',
        '16.设计 Agent 广告投放自我优化方案。',
      ].join(''),
    };
    const repost = {
      ...interview('other', 50_011, '2026-08-17T04:00:00.000Z'),
      title: '小红书 Agent 开发一面凉经',
      author: '候选人乙',
      text: [
        '我参加了小红书 Agent 开发一面。',
        '1.请简单介绍自己。2.平时实习主要看什么业务指标？3.讲讲项目的业务背景与链路。',
        '4.项目里的 Agent 解决了什么场景？5.Agent 代码采用了哪个框架？6.OpenManus 基于什么框架？',
        '7.Harness 为什么有效？8.多智能体协同有哪些性能瓶颈？9.如何限制 Agent 的并发数？',
        '10.短期记忆和长期记忆的底层实现？11.讲一下 ReAct 执行过程。12.Planner、Executor、Critic 分别做什么？',
        '13.上下文超长怎么压缩？14.Redis 常见数据结构？15.Class 文件的加载过程？',
        '16.如何用 Agent 自动迭代广告投放策略？',
      ].join(''),
    };

    const result = selectNowcoderPlanCandidates([first, repost], '2026-08-23T01:00:00.000Z');

    expect(result.accepted.map(document => document.canonicalUrl)).toEqual([first.canonicalUrl]);
    expect(result.rejected).toContainEqual({
      url: repost.canonicalUrl,
      reason: '重复问题簇',
    });
  });

  it('deduplicates a long interview template reused across employers with reordered questions', () => {
    const questions = [
      '自我介绍和常用开发工具',
      'Agent 的核心模块如何拆分',
      '短期记忆和长期记忆怎么实现',
      '工具调用失败后如何恢复',
      '怎样降低大模型幻觉',
      '上下文过长如何压缩',
      'Skill 和普通提示词有什么区别',
      '如何设计 Agent 执行循环',
      '线程池核心参数如何配置',
      'JVM 内存区域如何划分',
      'MySQL 索引为什么会失效',
      '分布式事务两阶段提交有什么问题',
      '如何合并两个有序数组',
      'Tool Schema 怎样做参数校验',
      '模型超时后如何重试和降级',
      '如何记录 Agent 可观测指标',
      '多 Agent 之间怎样传递状态',
      'RAG 召回结果如何评测',
    ];
    const numbered = (items: readonly string[]) => items
      .map((question, index) => `${index + 1}.${question}？`)
      .join('');
    const dji = {
      ...interview('other', 50_020, '2026-08-18T04:00:00.000Z'),
      title: '大疆创新 Agent 开发一面面经',
      author: '候选人甲',
      text: `我参加了大疆创新 Agent 开发一面。${numbered(questions)}`,
    };
    const insta360 = {
      ...interview('other', 50_021, '2026-08-17T04:00:00.000Z'),
      title: '影石创新 Agent 开发一面面经',
      author: '候选人乙',
      text: `我参加了影石创新 Agent 开发一面。${numbered([...questions].reverse())}`,
    };

    const result = selectNowcoderPlanCandidates([dji, insta360], '2026-08-23T01:00:00.000Z');

    expect(result.accepted.map(document => document.canonicalUrl)).toEqual([dji.canonicalUrl]);
    expect(result.rejected).toContainEqual({
      url: insta360.canonicalUrl,
      reason: '重复问题簇',
    });
  });

  it('rejects a recent A-grade interview that is not Agent or AI-application relevant', () => {
    const genericBackend = {
      ...interview('tencent', 60_000),
      title: '腾讯后端开发一面面经',
      text: '我参加了腾讯后端开发一面。1.数据库隔离级别？2.Java 线程池参数？3.索引为何失效？',
    };

    const result = selectNowcoderPlanCandidates(
      [genericBackend],
      '2026-08-23T01:00:00.000Z',
    );

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toContainEqual({
      url: genericBackend.canonicalUrl,
      reason: 'Agent 相关性不足',
    });
  });

  it('rejects a frontend-role interview that only mentions RAG as a side question', () => {
    const frontend = {
      ...interview('other', 60_001),
      title: '快手主站增长前端一面',
      text: '我参加了快手前端开发一面。1.React 如何更新？2.RAG 是什么？3.浏览器缓存怎么设计？',
    };

    const result = selectNowcoderPlanCandidates([frontend], '2026-08-23T01:00:00.000Z');

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toContainEqual({
      url: frontend.canonicalUrl,
      reason: '非 Agent 研发岗位',
    });
  });

  it('rejects a generic full-stack interview that only mentions Agent as a side question', () => {
    const fullstack = {
      ...interview('bytedance', 60_002),
      title: '字节全栈二面与三面面经',
      text: '我参加了字节全栈开发面试。1.数据库表如何设计？2.RAG 怎么召回？3.ReAct 是什么？',
    };

    const result = selectNowcoderPlanCandidates([fullstack], '2026-08-23T01:00:00.000Z');

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toContainEqual({
      url: fullstack.canonicalUrl,
      reason: '非 Agent 研发岗位',
    });
  });

  it('keeps the four primary companies ahead of the supplemental other bucket', () => {
    const documents = (['bytedance', 'tencent', 'alibaba', 'ant', 'other'] as const)
      .map((company, index) => interview(company, 61_000 + index));

    const result = selectNowcoderPlanCandidates(documents, '2026-08-23T01:00:00.000Z');

    expect(result.accepted).toHaveLength(5);
    expect(result.accepted.slice(0, 4).map(item => item.sourceMetadata?.company)).not.toContain('other');
    expect(result.accepted[4]?.sourceMetadata?.company).toBe('other');
    expect(result.coverage.other).toBe(1);
  });

  it('does not trust caller-supplied optional evidence that the current body cannot derive', () => {
    const raw = {
      ...interview('bytedance', 62_000),
      title: 'AI 应用开发面经',
      text: '我参加了 AI 应用开发岗位面试。1.Agent Loop？2.Tool Schema？3.Memory？',
      sourceMetadata: {
        company: 'bytedance', companyLabel: '字节', businessUnit: '火山引擎',
        role: 'Agent 开发', interviewRound: '一面', interviewDate: '2026-08-20',
        contentAccess: 'full', questionCount: 99, agentRelevant: true,
        evidenceGrade: 'A', evidenceReasons: 'caller supplied',
      },
    };

    const enriched = enrichNowcoderEvidence(raw);

    expect(enriched.sourceMetadata).not.toHaveProperty('company');
    expect(enriched.sourceMetadata).not.toHaveProperty('companyLabel');
    expect(enriched.sourceMetadata).not.toHaveProperty('businessUnit');
    expect(enriched.sourceMetadata).not.toHaveProperty('interviewDate');
    expect(enriched.sourceMetadata?.questionCount).not.toBe(99);
  });

  it('rejects non-finite interview dates instead of letting them bypass the 30-day gate', () => {
    const legalPublishedFallback = {
      ...interview('alibaba', 62_000, '2026-08-20T00:00:00.000Z'),
      sourceMetadata: { contentAccess: 'full', interviewDate: 'not-a-date' },
    };
    const poisoned = {
      ...interview('bytedance', 62_001, '2026-06-01T00:00:00.000Z'),
      sourceMetadata: { contentAccess: 'full', interviewDate: 'not-a-date' },
    };
    const invalidPublished = {
      ...interview('tencent', 62_002),
      publishedAt: 'not-a-date',
      sourceMetadata: { contentAccess: 'full', interviewDate: 'not-a-date' },
    };

    const result = selectNowcoderPlanCandidates(
      [legalPublishedFallback, poisoned, invalidPublished],
      '2026-08-23T01:00:00.000Z',
    );

    expect(result.accepted.map(item => item.canonicalUrl)).toEqual([
      legalPublishedFallback.canonicalUrl,
    ]);
    expect(result.structuredRejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: poisoned.canonicalUrl, code: 'OUTSIDE_30_DAYS' }),
      expect.objectContaining({ url: invalidPublished.canonicalUrl, code: 'OUTSIDE_30_DAYS' }),
    ]));
  });
});
