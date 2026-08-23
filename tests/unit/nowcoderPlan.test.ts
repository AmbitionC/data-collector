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
  it('accepts only recent A/B evidence, caps each company at four, and keeps honest zero coverage', () => {
    const recent = [
      ...Array.from({ length: 6 }, (_, index) => interview('bytedance', 30_000 + index)),
      ...Array.from({ length: 6 }, (_, index) => interview('tencent', 31_000 + index)),
      ...Array.from({ length: 6 }, (_, index) => interview('alibaba', 32_000 + index)),
      interview('ant', 33_000, '2026-08-15T04:00:00.000Z', 'truncated'),
      interview('ant', 33_001, '2026-07-01T04:00:00.000Z'),
    ];

    const result = selectNowcoderPlanCandidates(recent, '2026-08-23T01:00:00.000Z');

    expect(result.accepted).toHaveLength(12);
    expect(result.coverage).toEqual({ bytedance: 4, tencent: 4, alibaba: 4, ant: 0 });
    expect(result.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: expect.stringContaining('33000'), reason: '证据等级不足' }),
      expect.objectContaining({ url: expect.stringContaining('33001'), reason: '超过30天' }),
    ]));
  });

  it('rotates the first company by Shanghai calendar date without exceeding company caps', () => {
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
    expect(Math.max(...Object.values(firstDay.coverage))).toBeLessThanOrEqual(4);
  });
});
