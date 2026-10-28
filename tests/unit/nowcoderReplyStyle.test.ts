import { describe, expect, it } from 'vitest';
import { operationDraftsSchema, reviewNowcoderReply } from '@data-collector/shared';

const paragraph = '最难受的应该是前几天还说肯定没问题，前面的准备都照着能留下来安排了，结果突然换成另一个说法。转不转正至少早点说清楚，不该等半年干完才让人重新找。';
const drafts = { primary: paragraph.repeat(3), alternative: '前几天还说没问题，现在才通知，半年的安排全被打乱了', tone: 'contextual', anchor: '肯定没问题', notes: '' };

describe('comment-led reply preparation', () => {
  it('accepts a developed paragraph without selecting a preset voice', () => {
    expect([...drafts.primary].length).toBeGreaterThan(160);
    expect(operationDraftsSchema.safeParse(drafts).success).toBe(true);
    expect(reviewNowcoderReply(drafts.primary).warnings).toEqual([]);
  });

  it('counts Unicode characters consistently at the storage boundary', () => {
    expect(operationDraftsSchema.safeParse({ ...drafts, primary: '😀'.repeat(1000) }).success).toBe(true);
    expect(reviewNowcoderReply('😀'.repeat(1000)).characters).toBe(1000);
    expect(operationDraftsSchema.safeParse({ ...drafts, primary: '字'.repeat(1001) }).success).toBe(false);
  });

  it('continues to read existing draft tones and reject protocol-prefixed reply links', () => {
    for (const tone of ['empathetic', 'light_humor', 'practical']) {
      expect(operationDraftsSchema.safeParse({ ...drafts, primary: '这份面经的问题也太密了', tone }).success).toBe(true);
    }
    expect(operationDraftsSchema.safeParse({ ...drafts, primary: 'https://agent-journey.cn' }).success).toBe(false);
  });
});
