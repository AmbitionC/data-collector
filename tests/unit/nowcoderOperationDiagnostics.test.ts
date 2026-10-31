import { describe, expect, it } from 'vitest';
import * as conversationContracts from '../../packages/shared/src/nowcoderConversation.js';
import { operationPublicationSchema } from '../../packages/shared/src/nowcoderOperations.js';

const sourceUrl = 'https://www.nowcoder.com/discuss/123456';
const diagnostics = {
  pageStartedAt: '2026-10-31T02:00:00.000Z',
  beforeSubmitAt: '2026-10-31T02:00:02.000Z',
  submitClickedAt: '2026-10-31T02:00:02.100Z',
  verificationObservedAt: '2026-10-31T02:00:02.500Z',
  receiptObservedAt: '2026-10-31T02:00:04.000Z',
};
const results = [
  { kind: 'context', snapshot: {
    sourceUrl, readAt: '2026-10-31T02:00:01.000Z',
    post: { title: '学习方向', body: '想做一个能用的项目', images: [] }, comments: [],
    coverage: { total: 0, observed: 0, pagesRead: 1, hasMore: false, complete: true, limitations: [] },
  } },
  { kind: 'published', receipt: { sourceUrl, url: 'https://www.nowcoder.com/discuss/comment/102', text: '先做一个项目', observedAt: '2026-10-31T02:00:04.000Z' } },
  { kind: 'attention', code: 'VERIFICATION_REQUIRED', message: '请在页面完成验证', submission: 'uncertain' },
];
const publication = {
  key: 'timing-test-001', requestId: 'a5504e49-5f61-43fd-8be4-8a8d2faf42e1',
  draftHash: 'a'.repeat(64), requestedRevision: 1, state: 'uncertain',
  createdAt: '2026-10-31T02:00:00.000Z', updatedAt: '2026-10-31T02:00:05.000Z',
};

describe('Nowcoder operation timing contracts', () => {
  it('exports a strict timing contract with a required ISO page start', () => {
    const schema = conversationContracts.nowcoderOperationDiagnosticsSchema;
    expect(schema).toBeDefined();
    expect(schema.safeParse(diagnostics).success).toBe(true);
    expect(schema.safeParse({ pageStartedAt: '2026-10-31T02:00:00.000Z' }).success).toBe(true);
    expect(schema.safeParse({ submitClickedAt: '2026-10-31T02:00:02.100Z' }).success).toBe(false);
    expect(schema.safeParse({ ...diagnostics, verificationObservedAt: '2026-10-32T02:00:00.000Z' }).success).toBe(false);
    expect(schema.safeParse({ ...diagnostics, receiptObservedAt: 1793412004000 }).success).toBe(false);
    expect(schema.safeParse({ ...diagnostics, captchaToken: 'must-not-be-recorded' }).success).toBe(false);
  });

  it.each(results)('preserves optional timing diagnostics in $kind results while accepting old packets', result => {
    expect(conversationContracts.nowcoderOperationResultSchema.safeParse(result).success).toBe(true);
    const parsed = conversationContracts.nowcoderOperationResultSchema.safeParse({ ...result, diagnostics });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.diagnostics).toEqual(diagnostics);
  });

  it('retains timing and the local attention code in publication attempts without requiring either', () => {
    expect(operationPublicationSchema.safeParse(publication).success).toBe(true);
    const parsed = operationPublicationSchema.safeParse({ ...publication, diagnostics, attentionCode: 'VERIFICATION_REQUIRED' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toMatchObject({ diagnostics, attentionCode: 'VERIFICATION_REQUIRED' });
  });

  it('rejects invalid diagnostics and empty or overlong local attention codes in persisted attempts', () => {
    expect(operationPublicationSchema.safeParse({ ...publication, diagnostics: { pageStartedAt: 'not-a-timestamp' } }).success).toBe(false);
    expect(operationPublicationSchema.safeParse({ ...publication, attentionCode: '' }).success).toBe(false);
    expect(operationPublicationSchema.safeParse({ ...publication, attentionCode: 'A'.repeat(101) }).success).toBe(false);
  });
});
