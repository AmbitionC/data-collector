import { describe, expect, it } from 'vitest';
import {
  isHighConfidenceZsxqDuplicate,
  zsxqSemanticSignature,
} from '../../packages/shared/src/zsxqDedupe.js';

function signature(publishedAt: string, text: string) {
  return zsxqSemanticSignature({
    publishedAt,
    text,
    authorRole: 'owner',
  });
}

describe('ZSXQ semantic dedupe', () => {
  it('matches only a highly overlapping owner body at the exact publication instant', () => {
    const paragraph = '市场下跌时先检查仓位纪律、现金流和投资假设，再决定是否调整组合。';
    const body = paragraph.repeat(40);
    const original = signature('2026-08-11T03:00:00.000Z', body);

    expect(isHighConfidenceZsxqDuplicate(
      original,
      signature('2026-08-11T03:00:00.000Z', `标题微调 ${body} 补充一句复盘。`),
    )).toBe(true);
    expect(isHighConfidenceZsxqDuplicate(
      original,
      signature('2026-08-11T03:00:01.000Z', body),
    )).toBe(false);
    expect(isHighConfidenceZsxqDuplicate(
      original,
      signature('2026-08-11T03:00:00.000Z', '完全不同的职业规划内容。'.repeat(40)),
    )).toBe(false);
  });
});
