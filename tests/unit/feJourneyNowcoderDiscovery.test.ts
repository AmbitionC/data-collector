import { describe, expect, it, vi } from 'vitest';
import {
  FE_JOURNEY_PRESET,
  discoverNowcoderPlanCandidates,
} from '../../packages/bridge/src/feJourney/index.js';

describe('Nowcoder plan discovery query expansion', () => {
  it('uses fixed public Code Agent, AI engineering, and agent queries and deduplicates URLs', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(
      [
        '<a href="https://nowcoder.com/discuss/70001/?utm_source=search#answer">面经</a>',
        '<a href="/discuss/70001/">同一面经</a>',
      ].join(''),
      { status: 200 },
    ));

    const candidates = await discoverNowcoderPlanCandidates(fetcher, new Set());
    const requestedQueries = fetcher.mock.calls.map(([rawUrl]) => {
      const url = new URL(String(rawUrl));
      expect(url.origin).toBe('https://www.nowcoder.com');
      expect(url.pathname).toBe('/search');
      expect(url.searchParams.get('type')).toBe('post');
      return url.searchParams.get('query');
    });

    for (const company of ['字节', '腾讯', '阿里', '蚂蚁']) {
      expect(requestedQueries).toEqual(expect.arrayContaining([
        `${company} Code Agent 面经`,
        `${company} AI 工程 面经`,
        `${company} 智能体 面经`,
      ]));
    }
    expect(candidates.map(candidate => candidate.url)).toEqual([
      'https://www.nowcoder.com/discuss/70001',
    ]);
  });

  it('exposes bounded target-fill constants for the collection plan', () => {
    expect(FE_JOURNEY_PRESET.nowcoder).toMatchObject({
      planTargetAccepted: 10,
      planInitialRoundSize: 8,
      planRefillRoundSize: 4,
      planDetailBudget: 24,
      recoverableFailureCooldownMs: 3_600_000,
    });
  });
});
