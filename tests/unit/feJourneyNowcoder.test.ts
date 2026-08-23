import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  FE_JOURNEY_PRESET,
  discoverNowcoderPlanCandidates,
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

  it('accepts opaque feed detail IDs emitted by current Nowcoder pages', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(
      '<a href="/feed/main/detail/4c8da8a740e64eb5827fb1b962928eda">面经</a>',
      { status: 200 },
    ));

    const urls = await discoverNowcoderUrls(fetcher, new Set());

    expect(urls).toContain(
      'https://www.nowcoder.com/feed/main/detail/4c8da8a740e64eb5827fb1b962928eda',
    );
  });

  it('covers every target company with the fixed Agent role families', () => {
    const roleFamilies = [/Agent 开发/u, /AI 应用开发/u, /大模型应用开发/u, /RAG/u, /MCP/u, /AI 全栈/u, /Agent 平台/u];
    for (const company of ['bytedance', 'tencent', 'alibaba', 'ant'] as const) {
      const queries = FE_JOURNEY_PRESET.nowcoder.companyQueries
        .filter(item => item.company === company)
        .map(item => item.query);
      for (const family of roleFamilies) {
        expect(queries.some(query => family.test(query)), `${company} missing ${family}`).toBe(true);
      }
    }
  });

  it('discovers at most 60 company-labelled candidates from fixed company and role queries', async () => {
    let nextId = 20_000;
    const fetcher = vi.fn<typeof fetch>(async () => {
      const links = Array.from({ length: 10 }, () => `<a href="/discuss/${nextId++}">面经</a>`).join('');
      return new Response(links, { status: 200 });
    });

    const candidates = await discoverNowcoderPlanCandidates(fetcher, new Set());

    expect(candidates).toHaveLength(60);
    expect(new Set(candidates.map(candidate => candidate.url)).size).toBe(60);
    expect(new Set(candidates.map(candidate => candidate.queryCompany))).toEqual(
      new Set(['bytedance', 'tencent', 'alibaba', 'ant']),
    );
    for (const [rawUrl] of fetcher.mock.calls) {
      const query = new URL(String(rawUrl)).searchParams.get('query') ?? '';
      expect(FE_JOURNEY_PRESET.nowcoder.companyQueries.some(item => item.query === query)).toBe(true);
    }
  });
});
