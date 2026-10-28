import { describe, expect, it } from 'vitest';
import type { CollectedDocument } from '@data-collector/shared';
import { analyzeNowcoderEvidence } from '../../packages/bridge/src/feJourney/nowcoderEvidence.js';
import { selectNowcoderPlanCandidates } from '../../packages/bridge/src/plans/nowcoderPlan.js';

function interview(title: string, overrides: Partial<CollectedDocument> = {}): CollectedDocument {
  const url = 'https://www.nowcoder.com/discuss/99000001';
  return {
    schemaVersion: 1, source: 'nowcoder', kind: 'post', url, canonicalUrl: url,
    title, author: '测试候选人', publishedAt: '2026-10-20T04:00:00.000Z',
    collectedAt: '2026-10-28T17:00:00.000Z', html: '', images: [], truncated: false,
    text: '我参加了这次一面。1.Agent 执行状态怎样保存？2.工具调用失败怎样恢复？3.上下文记忆怎样压缩？',
    sourceMetadata: { contentAccess: 'full' }, ...overrides,
  };
}

describe('Nowcoder additional company recognition', () => {
  // Missing a company alias must not discard an otherwise complete engineering interview.
  it.each([
    ['美团 Agent 开发一面面经', '美团'],
    ['Meituan Agent 开发一面面经', '美团'],
    ['京东 Agent 开发一面面经', '京东'],
    ['Jingdong Agent 开发一面面经', '京东'],
    ['JD.com Agent 开发一面面经', '京东'],
  ])('accepts a complete %s under its actual company', (title, label) => {
    const result = selectNowcoderPlanCandidates(
      [interview(title)], '2026-10-29T00:00:00.000Z', 1, 'latest-search',
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.sourceMetadata).toMatchObject({
      company: 'other', companyLabel: label, evidenceGrade: 'A',
    });
  });

  it('does not infer 京东 from an ordinary job-description JD', () => {
    const evidence = analyzeNowcoderEvidence(interview('Agent 开发岗位 JD 与一面记录'));
    expect(evidence.company).toBeUndefined();
    expect(evidence.evidenceGrade).toBe('C');
  });

  it('keeps a truncated newly recognized company interview below the evidence gate', () => {
    const document = interview('美团 Agent 开发一面面经', {
      truncated: true, sourceMetadata: { contentAccess: 'truncated' },
    });
    expect(analyzeNowcoderEvidence(document).evidenceGrade).toBe('C');
    expect(selectNowcoderPlanCandidates([document], '2026-10-29T00:00:00.000Z', 1, 'latest-search').accepted).toEqual([]);
  });

  it('does not accept a promoted company interview simply because its company is recognized', () => {
    const document = interview('京东 Agent 开发一面面经');
    document.text += ' 加微信领取资料。';
    expect(analyzeNowcoderEvidence(document).evidenceGrade).toBe('C');
    expect(selectNowcoderPlanCandidates([document], '2026-10-29T00:00:00.000Z', 1, 'latest-search').accepted).toEqual([]);
  });

  it('does not accept ordinary backend questions as an Agent role', () => {
    const document = interview('美团后端开发一面面经', {
      text: '我参加了后端开发一面。1.事务隔离级别有哪些？2.索引怎么设计？3.线程池怎样配置？',
    });
    const result = selectNowcoderPlanCandidates([document], '2026-10-29T00:00:00.000Z', 1, 'latest-search');
    expect(result.accepted).toEqual([]);
    expect(result.structuredRejected).toContainEqual(expect.objectContaining({ code: 'AGENT_RELEVANCE_INSUFFICIENT' }));
  });
});
