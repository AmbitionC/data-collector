import { describe, expect, it, vi } from 'vitest';
import { discoverNowcoderDirectedCandidates } from '../../packages/bridge/src/nowcoderDirected/discovery.js';

const NOW = '2026-08-30T00:00:00.000Z';

interface RecordFixture {
  id: string | number;
  url?: string;
  detailUrl?: string;
  createTime?: number | string;
}

function response(records: readonly RecordFixture[], totalPage = 1): Response {
  return Response.json({
    success: true,
    code: 0,
    data: { totalPage, records: records.map(contentData => ({ contentData })) },
  });
}

describe('directed Nowcoder latest discovery', () => {
  it('retains real moment UUIDs and dates; explains unsupported records and undated review candidates', async () => {
    const fetcher = async (): Promise<Response> => Response.json({success:true,code:0,data:{totalPage:1,records:[
      {contentType:74,momentData:{id:900,uuid:'real-moment',title:'字节 Agent 实习一面',createdAt:1_725_000_000_000}},
      {momentData:{uuid:'missing-date',title:'待核实日期'}},
      {momentData:{uuid:'bad-date',createdAt:'bad'}},
      {momentData:{uuid:'unsafe',url:'https://example.test/discuss/99',createdAt:1_725_000_000_000}},
      {subjectData:{uuid:'not-a-post'}},
    ]}});
    const result = await discoverNowcoderDirectedCandidates(fetcher,{queries:['字节 Agent'],target:1,sort:'latest'},new Set(),new Date(NOW));
    expect(result.candidates[0]).toMatchObject({canonicalUrl:'https://www.nowcoder.com/feed/main/detail/real-moment',sourceRecordType:'moment',title:'字节 Agent 实习一面',publishedAt:'2024-08-30T06:40:00.000Z'});
    expect(result.previewOnly.map(x=>x.reason)).toEqual(['missing_published_at','invalid_published_at']);
    expect(result.diagnostics).toMatchObject({rawRecords:5,parsedRecords:3,retainedCandidates:1,reviewOnlyCandidates:2,
      skippedCounts:{unsupported_record:1,invalid_url:1,missing_published_at:1,invalid_published_at:1}});
  });

  it('fetches effective third and fourth pages but never exceeds the shared request budget', async () => {
    const bodies: Array<{query:string;page:number}> = [];
    const fetcher: typeof fetch = async (_url,init) => {
      const body=JSON.parse(String(init?.body)) as {query:string;page:number};bodies.push(body);
      return response([{id:body.query==='first'?body.page:100+body.page,createTime:1_725_000_000_000}],20);
    };
    const result=await discoverNowcoderDirectedCandidates(fetcher,{queries:['first','second'],target:1,sort:'latest',maxPagesPerQuery:4,maxRequests:5},new Set(),new Date(NOW));
    expect(bodies.map(x=>[x.query,x.page])).toEqual([['first',1],['second',1],['first',2],['second',2],['first',3]]);
    expect(result.candidates).toHaveLength(5);
    expect(result.diagnostics.requests).toBe(5);
    expect(result.diagnostics.stops).toEqual([{query:'first',reason:'request_budget'},{query:'second',reason:'request_budget'}]);
    expect(result.diagnostics.pages[4]).toMatchObject({query:'first',page:3,totalPage:20});
  });

  it('continues beyond an all-known page, stops repeated pages, and preserves unknown-pagination results', async () => {
    const known='https://www.nowcoder.com/discuss/1';let calls=0;
    const result=await discoverNowcoderDirectedCandidates(async()=>{calls++;return response([{id:calls===1?1:2,createTime:1_725_000_000_000}],20)},
      {queries:['字节'],target:1,sort:'latest'},new Set([known]),new Date(NOW),new Map([[known,'local_pending']]));
    expect(calls).toBe(3);
    expect(result.candidates.map(x=>x.canonicalUrl)).toEqual(['https://www.nowcoder.com/discuss/2']);
    expect(result.diagnostics).toMatchObject({knownSourcesRemoved:1,knownSourceCounts:{local_pending:1},duplicateRecords:1,stops:[{query:'字节',reason:'repeated_page'}]});
    const missing=await discoverNowcoderDirectedCandidates(async()=>Response.json({success:true,code:0,data:{records:[{contentData:{id:3,createTime:1_725_000_000_000}}]}}),
      {queries:['字节'],target:1,sort:'latest'},new Set(),new Date(NOW));
    expect(missing.candidates).toHaveLength(1);
    expect(missing.diagnostics.stops).toEqual([{query:'字节',reason:'unknown_pagination'}]);
  });

  it('reports a verified zero-result response as empty rather than unavailable', async () => {
    const result = await discoverNowcoderDirectedCandidates(async () => response([], 0), {
      queries: ['dc-no-match-71fb'], target: 1, sort: 'latest',
    }, new Set(), new Date(NOW));
    expect(result.candidates).toEqual([]);
    expect(result.previewOnly).toEqual([]);
    expect(result.audit.sortVerified).toBe(true);
  });

  it('still rejects contradictory zero-page responses containing records', async () => {
    await expect(discoverNowcoderDirectedCandidates(async () => response([{id: 1, createTime: 1000}], 0), {
      queries: ['Agent'], target: 1, sort: 'latest',
    }, new Set(), new Date(NOW))).rejects.toThrow('无法验证最新排序');
  });

  it('uses the verified JSON latest order and preserves a real canonical detail URL', async () => {
    const bodies: unknown[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as unknown);
      const body = JSON.parse(String(init?.body)) as { page: number };
      return response(body.page === 1
        ? [{ id: 991, url: '/feed/main/detail/opaque-real-id', createTime: 1_725_000_000_000 }]
        : [{ id: 992, url: 'https://www.nowcoder.com/feed/main/detail/page-two', createTime: 1_724_000_000_000 }], 2);
    });

    const result = await discoverNowcoderDirectedCandidates(fetcher, {
      queries: ['Agent 面经'], target: 2, sort: 'latest',
    }, new Set(), new Date('2026-08-30T00:00:00.000Z'));

    expect(bodies).toEqual([
      { type: 'post', query: 'Agent 面经', order: 'create', page: 1 },
      { type: 'post', query: 'Agent 面经', order: 'create', page: 2 },
    ]);
    expect(result.candidates.map(candidate => candidate.canonicalUrl)).toEqual([
      'https://www.nowcoder.com/feed/main/detail/opaque-real-id',
      'https://www.nowcoder.com/feed/main/detail/page-two',
    ]);
    expect(result.candidates[0]?.canonicalUrl).not.toContain('/discuss/991');
    expect(result.audit).toEqual({
      provider: 'nowcoder-json', requestedSort: 'latest', order: 'create', sortVerified: true,
      codexBrowserUse: false,
    });
  });

  it('merges duplicate URLs and sorts verified times globally with stable query/page/rank/url ties', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { query: string; page: number };
      if (body.query === 'first' && body.page === 1) return response([
        { id: 1, url: '/feed/main/detail/tie-b', createTime: 20_000 },
        { id: 2, url: '/feed/main/detail/duplicate', createTime: 10_000 },
      ], 2);
      if (body.query === 'first' && body.page === 2) return response([
        { id: 3, url: '/feed/main/detail/newest', createTime: 30_000 },
        { id: 4, url: '/feed/main/detail/duplicate', createTime: 25_000 },
      ], 2);
      if (body.query === 'second' && body.page === 1) return response([
        { id: 5, url: '/feed/main/detail/tie-a', createTime: 20_000 },
      ]);
      return response([]);
    });

    const result = await discoverNowcoderDirectedCandidates(fetcher, {
      queries: ['first', 'second'], target: 4, sort: 'latest',
    }, new Set(), new Date('2026-08-30T00:00:00.000Z'));

    expect(result.candidates.map(candidate => candidate.canonicalUrl)).toEqual([
      'https://www.nowcoder.com/feed/main/detail/newest',
      'https://www.nowcoder.com/feed/main/detail/duplicate',
      'https://www.nowcoder.com/feed/main/detail/tie-b',
      'https://www.nowcoder.com/feed/main/detail/tie-a',
    ]);
    expect(result.candidates.find(candidate => candidate.canonicalUrl.endsWith('/duplicate')))
      .toMatchObject({ matchedQueries: ['first'], page: 1, rank: 2 });
  });

  it('keeps records without a valid publish time preview-only and excludes known or non-detail URLs', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response([
      { id: 1, url: '/feed/main/detail/known', createTime: 1000 },
      { id: 2, url: '/feed/main/detail/no-time' },
      { id: 3, url: '/feed/main/detail/bad-time', createTime: 'not-a-time' },
      { id: 4, url: 'https://example.test/feed/main/detail/not-nowcoder', createTime: 1000 },
      { id: 5, url: '/search?query=Agent', createTime: 1000 },
    ]));

    const result = await discoverNowcoderDirectedCandidates(fetcher, {
      queries: ['Agent'], target: 1, sort: 'latest',
    }, new Set(['https://www.nowcoder.com/feed/main/detail/known']), new Date('2026-08-30T00:00:00.000Z'));

    expect(result.candidates).toEqual([]);
    expect(result.previewOnly.map(item => item.canonicalUrl)).toEqual([
      'https://www.nowcoder.com/feed/main/detail/no-time',
      'https://www.nowcoder.com/feed/main/detail/bad-time',
    ]);
  });

  it('rejects malformed JSON results without attempting an SSR search', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('<html>fallback</html>', { status: 503 }));

    await expect(discoverNowcoderDirectedCandidates(fetcher, {
      queries: ['Agent'], target: 1, sort: 'latest',
    }, new Set(), new Date('2026-08-30T00:00:00.000Z'))).rejects.toThrow('无法验证最新排序');

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls.every(([url]) => new URL(String(url)).hostname !== 'www.nowcoder.com')).toBe(true);
  });

  it('uses the first valid returned URL after invalid URL fields and times out injected fetchers that ignore abort', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const never = vi.fn<typeof fetch>(async (_url, init) => {
        signal = init?.signal ?? undefined;
        return await new Promise<Response>(() => undefined);
      });
      const pending = discoverNowcoderDirectedCandidates(never, {
        queries: ['Agent'], target: 1, sort: 'latest',
      }, new Set(), new Date(NOW));
      const rejected = expect(pending).rejects.toThrow('无法验证最新排序');
      await vi.advanceTimersByTimeAsync(8_000);
      await rejected;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    const fetcher = vi.fn<typeof fetch>(async () => response([{
      id: 42, url: 'https://example.test/not-nowcoder', detailUrl: '/feed/main/detail/valid-after-invalid', createTime: 1_725_000_000_000,
    }]));
    const result = await discoverNowcoderDirectedCandidates(fetcher, {
      queries: ['Agent'], target: 1, sort: 'latest',
    }, new Set(), new Date(NOW));
    expect(result.candidates[0]?.canonicalUrl).toBe('https://www.nowcoder.com/feed/main/detail/valid-after-invalid');
  });
});
