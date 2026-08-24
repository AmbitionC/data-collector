import { describe, expect, it, vi } from 'vitest';
import {
  FE_JOURNEY_PRESET,
  discoverNowcoderPlanCandidates,
  discoverNowcoderUrls,
} from '../../packages/bridge/src/feJourney/index.js';

interface ApiRecordFixture {
  id: string;
  title?: string;
  content?: string;
  createTime?: number;
}

function apiRecordResponse(records: readonly ApiRecordFixture[], totalPage = 1): Response {
  return Response.json({
    code: 0,
    success: true,
    data: {
      current: 1,
      totalPage,
      records: records.map(record => ({ contentData: record })),
    },
  });
}

function apiSearchResponse(ids: readonly string[], totalPage = 1): Response {
  return apiRecordResponse(ids.map(id => ({ id })), totalPage);
}

describe('Nowcoder plan discovery query expansion', () => {
  it('requests newest posts through the public JSON search API and stops after two pages', async () => {
    const firstQuery = FE_JOURNEY_PRESET.nowcoder.queries[0];
    const bodies: Array<{ type: string; query: string; order: string; page: number }> = [];
    const fetcher = vi.fn<typeof fetch>(async (rawUrl, init) => {
      expect(String(rawUrl)).toBe('https://gw-c.nowcoder.com/api/sparta/pc/search');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body)) as typeof bodies[number];
      bodies.push(body);
      if (body.query !== firstQuery) return apiSearchResponse([]);
      if (body.page === 1) {
        return apiSearchResponse(
          Array.from({ length: 20 }, (_, index) => String(71_001 + index)),
          99,
        );
      }
      return apiSearchResponse([
        '71001',
        ...Array.from({ length: 10 }, (_, index) => String(71_021 + index)),
      ], 99);
    });

    const urls = await discoverNowcoderUrls(fetcher, new Set());

    expect(urls).toEqual(Array.from(
      { length: 24 },
      (_, index) => `https://www.nowcoder.com/discuss/${71_001 + index}`,
    ));
    expect(bodies.filter(body => body.query === firstQuery).map(body => body.page)).toEqual([1, 2]);
    expect(bodies.every(body => body.type === 'post' && body.order === 'create')).toBe(true);
    expect(bodies.some(body => body.page > 2)).toBe(false);
  });

  it('never runs more than two public search requests concurrently', async () => {
    let active = 0;
    let peak = 0;
    let releaseFirstPair!: () => void;
    const firstPair = new Promise<void>(resolve => { releaseFirstPair = resolve; });
    const fetcher = vi.fn<typeof fetch>(async () => {
      const call = fetcher.mock.calls.length;
      active += 1;
      peak = Math.max(peak, active);
      try {
        if (call <= 2) await firstPair;
        return apiSearchResponse([]);
      } finally {
        active -= 1;
      }
    });

    const pending = discoverNowcoderPlanCandidates(fetcher, new Set());
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(active).toBe(2);
    releaseFirstPair();
    await pending;

    expect(peak).toBe(2);
  });

  it('times out even when an injected fetcher ignores signal and falls back to the SSR page', async () => {
    vi.useFakeTimers();
    try {
      const firstQuery = FE_JOURNEY_PRESET.nowcoder.queries[0];
      let ignoredSignal: AbortSignal | undefined;
      const fetcher = vi.fn<typeof fetch>(async (rawUrl, init) => {
        const url = new URL(String(rawUrl));
        if (url.hostname === 'gw-c.nowcoder.com') {
          const body = JSON.parse(String(init?.body)) as { query: string };
          if (body.query === firstQuery) {
            ignoredSignal = init?.signal ?? undefined;
            return await new Promise<Response>(() => undefined);
          }
          return apiSearchResponse([]);
        }
        return new Response(Array.from(
          { length: 24 },
          (_, index) => `<a href="/discuss/${72_001 + index}">面经</a>`,
        ).join(''));
      });

      const pending = discoverNowcoderUrls(fetcher, new Set());
      await vi.advanceTimersByTimeAsync(30_000);
      const urls = await pending;

      expect(ignoredSignal).toBeDefined();
      expect(ignoredSignal?.aborted).toBe(true);
      expect(urls).toHaveLength(24);
      expect(fetcher.mock.calls.some(([rawUrl]) => {
        const url = new URL(String(rawUrl));
        return url.hostname === 'www.nowcoder.com' && url.pathname === '/search';
      })).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the existing SSR parser when the JSON search API fails', async () => {
    const fetcher = vi.fn<typeof fetch>(async rawUrl => {
      const url = new URL(String(rawUrl));
      if (url.hostname === 'gw-c.nowcoder.com') return new Response('unavailable', { status: 503 });
      return new Response([
        '<a href="https://nowcoder.com/discuss/73001/?utm_source=search#answer">面经</a>',
        '<a href="/discuss/73001/">同一面经</a>',
      ].join(''));
    });

    const candidates = await discoverNowcoderPlanCandidates(fetcher, new Set([
      'https://www.nowcoder.com/discuss/99999',
    ]));

    expect(candidates.map(candidate => candidate.url)).toEqual([
      'https://www.nowcoder.com/discuss/73001',
    ]);
    expect(fetcher.mock.calls.some(([rawUrl]) => new URL(String(rawUrl)).pathname === '/search')).toBe(true);
  });

  it('builds the whole fixed-query pool before ranking company-relevant recent interviews', async () => {
    const genericIds = Array.from({ length: 15 }, (_, index) => String(74_001 + index));
    const fetcher = vi.fn<typeof fetch>(async (_rawUrl, init) => {
      const body = JSON.parse(String(init?.body)) as { query: string; page: number };
      if (body.page > 1) return apiSearchResponse([]);
      if (body.query === '字节 Agent 开发 面经') {
        return apiRecordResponse(genericIds.map((id, index) => ({
          id,
          title: `腾讯 Java 开发资料 ${index}`,
          content: '通用学习资料汇总',
          createTime: 200_000 + index,
        })));
      }
      if (body.query === '字节 MCP 面经') {
        return apiRecordResponse([
          {
            id: '74901',
            title: '字节 MCP Agent 一面面经',
            content: '面试官追问了 Agent 工具调用与 RAG。',
            createTime: 300_000,
          },
          {
            id: '74902',
            title: '字节 AI 应用开发二面复盘',
            content: '二面讨论大模型应用和 Agent 评测。',
            createTime: 400_000,
          },
        ]);
      }
      return apiSearchResponse([]);
    });

    const candidates = await discoverNowcoderPlanCandidates(fetcher, new Set());
    const byteCandidates = candidates.filter(candidate => candidate.queryCompany === 'bytedance');

    expect(byteCandidates).toHaveLength(2);
    expect(byteCandidates.slice(0, 2).map(candidate => candidate.url)).toEqual([
      'https://www.nowcoder.com/discuss/74902',
      'https://www.nowcoder.com/discuss/74901',
    ]);
    expect(byteCandidates.map(candidate => candidate.url)).not.toContain(
      'https://www.nowcoder.com/discuss/74001',
    );
    expect(fetcher.mock.calls.some(([, init]) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      return body.query === '字节 MCP 面经';
    })).toBe(true);
  });

  it('uses supplemental company queries, trusts title company over body vendors, and ranks recent relevant hits first', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_rawUrl, init) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query === '字节 Agent 开发 面经') {
        return apiRecordResponse([{
          id: '75101',
          title: '字节 Agent 开发一面面经',
          content: 'Agent、RAG、MCP 与大模型应用开发完整复盘',
          createTime: 100_000,
        }]);
      }
      if (body.query === '字节 AI 应用开发 面经') {
        return apiRecordResponse([{
          id: '75102',
          title: '字节 AI 应用一面面经',
          content: 'Agent 工具调用复盘',
          createTime: 200_000,
        }]);
      }
      if (body.query === '拼多多 Agent 面经') {
        return apiRecordResponse([{
          id: '75901',
          title: '拼多多 Agent 开发一面面经',
          content: '项目中使用阿里云 ASR，面试官继续追问 RAG。',
          createTime: 300_000,
        }]);
      }
      return apiSearchResponse([]);
    });

    const candidates = await discoverNowcoderPlanCandidates(fetcher, new Set());

    expect(candidates.filter(item => item.queryCompany === 'bytedance').map(item => item.url)).toEqual([
      'https://www.nowcoder.com/discuss/75102',
      'https://www.nowcoder.com/discuss/75101',
    ]);
    expect(candidates).toContainEqual({
      url: 'https://www.nowcoder.com/discuss/75901',
      queryCompany: 'other',
    });
    expect(fetcher.mock.calls.some(([, init]) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      return body.query === '华为 AI 面经';
    })).toBe(true);
  });

  it('uses fixed public Code Agent, AI engineering, and agent queries and deduplicates URLs', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => apiSearchResponse(['70001', '70001']));

    const candidates = await discoverNowcoderPlanCandidates(fetcher, new Set());
    const requestedQueries = fetcher.mock.calls.map(([rawUrl, init]) => {
      const url = new URL(String(rawUrl));
      expect(url.href).toBe('https://gw-c.nowcoder.com/api/sparta/pc/search');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body)) as {
        type: string;
        query: string;
        order: string;
      };
      expect(body.type).toBe('post');
      expect(body.order).toBe('create');
      return body.query;
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
