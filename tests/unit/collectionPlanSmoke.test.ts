import { describe, expect, it } from 'vitest';
import { validateCollectionPlanSmoke } from '../../scripts/smoke-collection-plans-validation.mjs';

describe('fixed collection plan smoke validation', () => {
  it('requires topic union, honest company caps, terminal counts, and exactly-once sync', () => {
    const report = {
      zsxq: {
        discovered: 3,
        uniqueTopics: 2,
        unionedTopics: 1,
        ownerAccepted: 1,
        viewLabels: ['最新、精华', '只看星主'],
      },
      nowcoder: {
        discovered: 16,
        accepted: 9,
        coverage: { bytedance: 3, tencent: 3, alibaba: 3, ant: 0 },
      },
      batch: { discovered: 3, saved: 1, skipped: 2, failed: 0, needsAttention: 0 },
      syncedIds: ['owner-topic', 'byte-interview'],
    };

    expect(validateCollectionPlanSmoke(report)).toBe(true);
    expect(() => validateCollectionPlanSmoke({
      ...report,
      nowcoder: { ...report.nowcoder, coverage: { ...report.nowcoder.coverage, bytedance: 5 } },
    })).toThrow('公司上限');
    expect(() => validateCollectionPlanSmoke({
      ...report,
      syncedIds: ['owner-topic', 'owner-topic'],
    })).toThrow('重复同步');
  });
});
