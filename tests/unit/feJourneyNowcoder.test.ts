import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  FE_JOURNEY_PRESET,
  discoverNowcoderUrls,
} from '../../packages/bridge/src/feJourney/index.js';

describe('fixed fe-journey Nowcoder discovery', () => {
  it('extracts only canonical unseen detail URLs and enforces the fixed run limit', async () => {
    const fixture = await readFile(join(process.cwd(), 'tests/fixtures/nowcoder-search.html'), 'utf8');
    const fetcher = vi.fn<typeof fetch>(async () => new Response(fixture, { status: 200 }));

    const urls = await discoverNowcoderUrls(
      fetcher,
      new Set(['https://www.nowcoder.com/discuss/1003']),
    );

    expect(FE_JOURNEY_PRESET).toMatchObject({
      timezone: 'Asia/Shanghai',
      nowcoder: { intervalMs: 86_400_000, maxPerRun: 24 },
      github: { intervalMs: 604_800_000, maxPerRun: 12 },
    });
    // 达到本轮上限就停止继续请求后续固定查询，避免无意义抓取。
    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(FE_JOURNEY_PRESET.nowcoder.queries.length);
    for (const [rawUrl] of fetcher.mock.calls) {
      const url = new URL(String(rawUrl));
      expect(url.origin).toBe('https://www.nowcoder.com');
      expect(url.pathname).toBe('/search');
      expect(FE_JOURNEY_PRESET.nowcoder.queries).toContain(url.searchParams.get('query'));
      expect(url.searchParams.get('type')).toBe('post');
    }
    expect(urls).toHaveLength(24);
    expect(urls.slice(0, 3)).toEqual([
      'https://www.nowcoder.com/discuss/1001',
      'https://www.nowcoder.com/feed/main/detail/1002',
      'https://www.nowcoder.com/feed/main/detail/1004',
    ]);
    expect(urls).not.toContain('https://www.nowcoder.com/discuss/1003');
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls.every(url => /^https:\/\/www\.nowcoder\.com\/(?:discuss\/\d+|feed\/main\/detail\/\d+)$/.test(url))).toBe(true);
  });

  it('surfaces a failed fixed search instead of silently reporting an empty run', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('temporary failure', { status: 503 }));

    await expect(discoverNowcoderUrls(fetcher, new Set())).rejects.toThrow(
      /牛客搜索请求失败.*503/,
    );
  });
});
