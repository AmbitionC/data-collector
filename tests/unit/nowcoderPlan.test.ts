import { describe, expect, it } from 'vitest';
import type { CollectedDocument } from '@data-collector/shared';
import { selectNowcoderPlanCandidates } from '../../packages/bridge/src/plans/nowcoderPlan.js';

const COMPANY_LABEL = {
  bytedance: '字节',
  tencent: '腾讯',
  alibaba: '阿里云',
  ant: '蚂蚁',
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
    sourceMetadata: { contentAccess: access },
  };
}

describe('Nowcoder fixed collection plan selection', () => {
  it('fills exactly ten slots without a company cap while preserving available diversity', () => {
    const candidates = [
      ...Array.from({ length: 10 }, (_, index) => interview('alibaba', 32_000 + index)),
      interview('bytedance', 30_000),
      interview('ant', 33_000, '2026-08-15T04:00:00.000Z', 'truncated'),
      interview('ant', 33_001, '2026-07-01T04:00:00.000Z'),
    ];

    const result = selectNowcoderPlanCandidates(candidates, '2026-08-23T01:00:00.000Z');

    expect(result.accepted).toHaveLength(10);
    expect(result.coverage).toEqual({ bytedance: 1, tencent: 0, alibaba: 9, ant: 0 });
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
});
