import { describe, expect, it } from 'vitest';
import type { CollectedDocument } from '@data-collector/shared';
import {
  analyzeNowcoderEvidence,
  enrichNowcoderEvidence,
} from '../../packages/bridge/src/feJourney/nowcoderEvidence.js';
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

describe.each(['title', 'opening'] as const)('Nowcoder scoped employers in the %s', location => {
  it.each([
    ['网易', '网易'],
    ['网易互娱', '网易'],
    ['网易云音乐', '网易'],
    ['网易雷火', '网易'],
    ['科大讯飞', '科大讯飞'],
    ['金山', '金山'],
    ['金山数娱', '金山'],
    ['金山世游', '金山'],
    ['金山办公', '金山'],
    ['顺丰', '顺丰'],
    ['顺丰科技', '顺丰'],
    ['携程', '携程'],
    ['小米', '小米'],
  ])('keeps a complete %s interview selectable as %s', (employer, label) => {
    const document = interview(location === 'title'
      ? `${employer} Agent 开发一面面经`
      : 'Agent 开发一面面经');
    if (location === 'opening') document.text = `我参加了${employer}的这次一面。${document.text}`;

    expect(analyzeNowcoderEvidence(document)).toMatchObject({
      company: 'other', companyLabel: label, questionCount: 3,
      contentAccess: 'full', agentRelevant: true, evidenceGrade: 'A',
    });
    const result = selectNowcoderPlanCandidates([document], '2026-10-29T00:00:00.000Z', 1, 'latest-search');
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.sourceMetadata).toMatchObject({
      company: 'other', companyLabel: label, evidenceGrade: 'A',
    });
  });
});

describe('Nowcoder employer evidence boundaries', () => {
  it.each([
    ['科大讯飞 AI全栈面经', '科大讯飞'],
    ['金山数娱 AI应用一面面经', '金山'],
  ])('keeps %s selectable at B when no normalized role is present', (title, label) => {
    const document = interview(title);
    const evidence = analyzeNowcoderEvidence(document);
    expect(evidence).toMatchObject({
      company: 'other', companyLabel: label, agentRelevant: true, evidenceGrade: 'B',
    });
    expect(evidence.role).toBeUndefined();
    const result = selectNowcoderPlanCandidates([document], '2026-10-29T00:00:00.000Z', 1, 'latest-search');
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.sourceMetadata?.evidenceGrade).toBe('B');
  });

  it('enriches a title employer instead of retaining a stale Tencent guess', () => {
    const document = interview('网易互娱 Agent 开发一面面经', {
      text: '我参加了这次一面，之前在腾讯实习，项目使用阿里云。1.Agent 状态如何保存？2.工具调用怎样降级？3.上下文记忆怎样压缩？',
      sourceMetadata: { company: 'tencent', companyLabel: '腾讯', evidenceGrade: 'A', captureId: 'synthetic-capture' },
    });
    expect(enrichNowcoderEvidence(document).sourceMetadata).toMatchObject({
      company: 'other', companyLabel: '网易', evidenceGrade: 'A', captureId: 'synthetic-capture',
    });
    expect(document.sourceMetadata?.company).toBe('tencent');
  });

  it.each([
    ['未识别雇主甲 Agent 开发一面面经', '通过腾讯会议进行远程面试。'],
    ['未识别雇主乙 Agent 开发一面面经', '远程面试使用腾讯 会议。'],
    ['未识别雇主丙 Agent 开发一面面经', `${'开场'.repeat(159)}腾讯会议。`],
    ['未识别雇主丁 Agent 开发一面面经', `腾讯会议${'开场'.repeat(158)}网易`],
  ])('does not assign %s to Tencent from the meeting tool', (title, opening) => {
    const document = interview(title);
    document.text = `${opening}${document.text}`;
    const evidence = analyzeNowcoderEvidence(document);
    expect(evidence.company).toBeUndefined();
    expect(evidence.companyLabel).toBeUndefined();
    expect(evidence.evidenceGrade).toBe('C');
    const enriched = enrichNowcoderEvidence({
      ...document, sourceMetadata: { company: 'tencent', companyLabel: '腾讯', evidenceGrade: 'A' },
    });
    expect(enriched.sourceMetadata?.company).toBeUndefined();
    expect(enriched.sourceMetadata?.companyLabel).toBeUndefined();
    expect(enriched.sourceMetadata?.evidenceGrade).toBe('C');
    const result = selectNowcoderPlanCandidates([document], '2026-10-29T00:00:00.000Z', 1, 'latest-search');
    expect(result.accepted).toEqual([]);
    expect(result.structuredRejected).toContainEqual(expect.objectContaining({ code: 'EVIDENCE_GRADE_INSUFFICIENT' }));
  });

  it.each([
    ['腾讯会议后端开发一面面经', '我参加了这次一面。'],
    ['腾讯 Agent 开发一面面经', '我参加了这次一面。'],
    ['Agent 开发一面面经', '我参加了腾讯的这次一面。'],
    ['Agent 开发一面面经', '通过腾讯会议，我参加了腾讯的这次一面。'],
  ])('preserves explicit Tencent employer evidence in %s / %s', (title, opening) => {
    const document = interview(title);
    document.text = `${opening}${document.text}`;
    expect(analyzeNowcoderEvidence(document)).toMatchObject({
      company: 'tencent', companyLabel: '腾讯', evidenceGrade: 'A',
    });
  });

  it('finds a named opening employer even when a meeting tool appears first', () => {
    const document = interview('Agent 开发一面面经');
    document.text = `通过腾讯会议，我参加了顺丰科技的这次一面。${document.text}`;
    expect(analyzeNowcoderEvidence(document)).toMatchObject({
      company: 'other', companyLabel: '顺丰', evidenceGrade: 'A',
    });
  });

  it.each(['paywalled', 'truncated'] as const)('keeps a newly recognized %s interview below the evidence gate', access => {
    const document = interview('科大讯飞 Agent 开发一面面经', {
      truncated: true, sourceMetadata: { contentAccess: access },
    });
    expect(analyzeNowcoderEvidence(document)).toMatchObject({
      company: 'other', companyLabel: '科大讯飞', contentAccess: access, evidenceGrade: 'C',
    });
    const result = selectNowcoderPlanCandidates([document], '2026-10-29T00:00:00.000Z', 1, 'latest-search');
    expect(result.accepted).toEqual([]);
    expect(result.structuredRejected).toContainEqual(expect.objectContaining({ code: 'EVIDENCE_GRADE_INSUFFICIENT' }));
  });

  it.each([
    ['网易 Agent 开发面经合集', '本文把多份面经合并整理。', '网易'],
    ['携程 Agent 开发一面面经', '加微信领取资料。', '携程'],
  ])('keeps %s below the compilation and promotion gates', (title, extraText, label) => {
    const document = interview(title);
    document.text += extraText;
    expect(analyzeNowcoderEvidence(document)).toMatchObject({
      company: 'other', companyLabel: label, evidenceGrade: 'C',
    });
    const result = selectNowcoderPlanCandidates([document], '2026-10-29T00:00:00.000Z', 1, 'latest-search');
    expect(result.accepted).toEqual([]);
    expect(result.structuredRejected).toContainEqual(expect.objectContaining({ code: 'EVIDENCE_GRADE_INSUFFICIENT' }));
  });

  it('keeps a named employer without first-hand process below the evidence gate', () => {
    const document = interview('顺丰科技 Agent 开发记录', {
      text: '技术讨论记录。1.Agent 执行状态怎样保存？2.工具调用失败怎样恢复？3.上下文记忆怎样压缩？',
    });
    const evidence = analyzeNowcoderEvidence(document);
    expect(evidence).toMatchObject({ companyLabel: '顺丰', questionCount: 3, evidenceGrade: 'C' });
    expect(evidence.evidenceReasons).toContain('缺少第一人称过程');
    expect(selectNowcoderPlanCandidates([document], '2026-10-29T00:00:00.000Z', 1, 'latest-search').accepted).toEqual([]);
  });

  it('keeps a named employer with only two questions below the evidence gate', () => {
    const document = interview('小米 Agent 开发一面面经', {
      text: '我参加了这次一面。1.Agent 执行状态怎样保存？2.工具调用失败怎样恢复？',
    });
    expect(analyzeNowcoderEvidence(document)).toMatchObject({ companyLabel: '小米', questionCount: 2, evidenceGrade: 'C' });
    expect(selectNowcoderPlanCandidates([document], '2026-10-29T00:00:00.000Z', 1, 'latest-search').accepted).toEqual([]);
  });

  it('rejects an ordinary backend interview even when its new employer has grade A evidence', () => {
    const document = interview('金山办公后端开发一面面经', {
      text: '我参加了后端开发一面。1.事务隔离级别有哪些？2.索引怎么设计？3.线程池怎样配置？',
    });
    expect(analyzeNowcoderEvidence(document)).toMatchObject({
      company: 'other', companyLabel: '金山', agentRelevant: false, evidenceGrade: 'A',
    });
    const result = selectNowcoderPlanCandidates([document], '2026-10-29T00:00:00.000Z', 1, 'latest-search');
    expect(result.accepted).toEqual([]);
    expect(result.structuredRejected).toContainEqual(expect.objectContaining({ code: 'AGENT_RELEVANCE_INSUFFICIENT' }));
  });
});
