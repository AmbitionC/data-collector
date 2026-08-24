import { describe, expect, it } from 'vitest';
import { planErrorNeedsAttention } from '../../packages/extension/src/background/planAttention.js';

describe('planErrorNeedsAttention', () => {
  it('keeps signed API protocol failures visible as actionable plan attention', () => {
    expect(planErrorNeedsAttention(
      'ZSXQ_API_SIGNATURE_INVALID：知识星球接口签名校验失败（HTTP 200，服务端 code 1059）',
    )).toBe(true);
  });

  it('keeps a transient generic collection failure as an ordinary failure', () => {
    expect(planErrorNeedsAttention('ZSXQ_API_FALLBACK_FAILED：知识星球接口请求失败：network error'))
      .toBe(false);
  });
});
