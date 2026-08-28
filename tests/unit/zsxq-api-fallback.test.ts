import { describe, expect, it, vi } from 'vitest';
import {
  collectZsxqApiOwnerPage,
  collectZsxqApiViews,
} from '../../packages/extension/src/zsxqApiFallback.js';

const GROUP_ID = '48844584441158';
const API = 'https://api.zsxq.com/v2';

function response(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function topic(
  topicId: string,
  createTime: string,
  text = `投资经营完整正文 ${topicId}`,
): Record<string, unknown> {
  return {
    topic_id: topicId,
    type: 'talk',
    create_time: createTime,
    talk: {
      text,
      owner: { user_id: '1001', name: '陈老师' },
    },
  };
}

function topicResponse(topics: readonly Record<string, unknown>[]): Response {
  return response(JSON.stringify({ succeeded: true, resp_data: { topics } }));
}

function groupResponse(): Response {
  return response('{"succeeded":true,"resp_data":{"group":{"owner":{"user_id":"1001","name":"陈老师"}}}}');
}

function menuResponse(): Response {
  return response('{"succeeded":true,"resp_data":{"menus":['
    + '{"title":"最新","preset":true,"preset_type":"all"},'
    + '{"title":"精华","preset":true,"preset_type":"digests"}'
    + '],"optional_menus":['
    + '{"title":"只看星主","preset":true,"preset_type":"by_owner"}'
    + ']}}');
}

describe('ZSXQ API fallback', () => {
  it('collects one proven owner page and returns a resumable cursor with dated business skips', async () => {
    const page = Array.from({ length: 20 }, (_, index) => topic(
      String(690_000_000_000_000_000n + BigInt(index)),
      new Date(Date.parse('2026-08-24T23:00:00.000Z') - index * 60 * 1_000).toISOString(),
      index === 0 ? '打新 新股 积极申购' : undefined,
    ));
    const requested: URL[] = [];
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      requested.push(url);
      if (url.href === `${API}/groups/${GROUP_ID}`) return groupResponse();
      if (url.href === `${API}/groups/${GROUP_ID}/menus`) return menuResponse();
      return topicResponse(page);
    };

    const result = await collectZsxqApiOwnerPage(GROUP_ID, {}, {
      fetcher,
      aduid: 'test-device',
      now: () => new Date('2026-08-25T00:00:00.000Z'),
      requestId: () => 'test-request',
    });

    expect(requested).toHaveLength(3);
    expect(requested[2]?.searchParams.get('scope')).toBe('by_owner');
    expect(result).toMatchObject({
      rawCount: 20,
      exhausted: false,
      nextCursor: '2026-08-24T22:40:59.999Z',
      context: { ownerId: '1001', ownerName: '陈老师', scope: 'by_owner' },
      newestObservedAt: '2026-08-24T23:00:00.000Z',
      oldestObservedAt: '2026-08-24T22:41:00.000Z',
    });
    expect(result.documents).toHaveLength(19);
    expect(result.businessSkips).toEqual([expect.objectContaining({
      publishedAt: '2026-08-24T23:00:00.000Z',
      reason: expect.stringContaining('打新内容'),
    })]);
    expect(result.pageKey).toMatch(/^start:/u);
  });

  it('replaces a three-dot feed preview with the signed topic-detail body before returning the page', async () => {
    const topicId = '690000000000000098';
    const preview = topic(
      topicId,
      '2026-08-19T23:00:00.000Z',
      '投资课程正文已经讲到现金流，关键的方法和结论还在后面...',
    );
    const full = topic(
      topicId,
      '2026-08-19T23:00:00.000Z',
      '投资课程正文已经讲到现金流，关键的方法和结论还在后面：先核对现金流，再结合估值和仓位做决策。',
    );
    const requested: string[] = [];
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      requested.push(url);
      if (url === `${API}/groups/${GROUP_ID}`) return groupResponse();
      if (url === `${API}/groups/${GROUP_ID}/menus`) return menuResponse();
      if (url === `${API}/topics/${topicId}`) {
        return response(JSON.stringify({ succeeded: true, resp_data: { topic: full } }));
      }
      return topicResponse([preview]);
    };

    const result = await collectZsxqApiOwnerPage(GROUP_ID, {}, {
      fetcher,
      aduid: 'test-device',
      requestId: () => 'test-request',
    });

    expect(requested).toContain(`${API}/topics/${topicId}`);
    expect(result.documents).toEqual([expect.objectContaining({
      truncated: false,
      text: expect.stringContaining('先核对现金流，再结合估值'),
    })]);
  });

  it('resolves a detail attachment by exact file id before proving the topic complete', async () => {
    const topicId = '22255848145158551';
    const fileId = '9223372036854775802';
    const createTime = '2026-05-13T23:00:00.000Z';
    const preview = topic(topicId, createTime, '沪深300所有公司的人均薪酬绝对数据，完整说明和附件在后面...');
    const full = topic(
      topicId,
      createTime,
      '沪深300所有公司的人均薪酬绝对数据。算法以支付给职工的现金和总人数计算，可供填报志愿、换行业与求职参考。',
    );
    (full.talk as Record<string, unknown>).files = [{
      file_id: fileId,
      name: '沪深300_2025年度平均薪酬.pdf',
      hash: 'sha256-placeholder',
      size: 12345,
      duration: 0,
      download_count: 8,
      create_time: createTime,
    }];
    const requested: string[] = [];
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      requested.push(url);
      if (url === `${API}/groups/${GROUP_ID}`) return groupResponse();
      if (url === `${API}/groups/${GROUP_ID}/menus`) return menuResponse();
      if (url === `${API}/topics/${topicId}`) {
        return response(JSON.stringify({ succeeded: true, resp_data: { topic: full } }));
      }
      if (url === `${API}/files/${fileId}/download_url`) {
        return response(JSON.stringify({
          succeeded: true,
          resp_data: { download_url: 'https://files.zsxq.com/沪深300_2025年度平均薪酬.pdf' },
        }));
      }
      return topicResponse([preview]);
    };

    const result = await collectZsxqApiOwnerPage(GROUP_ID, {}, {
      fetcher,
      aduid: 'test-device',
      requestId: () => 'test-request',
    });

    expect(requested).toContain(`${API}/files/${fileId}/download_url`);
    expect(result.documents).toEqual([expect.objectContaining({
      truncated: false,
      text: expect.stringContaining('填报志愿、换行业与求职参考'),
      html: expect.stringContaining('沪深300_2025年度平均薪酬.pdf'),
    })]);
  });

  it('preserves a signed talk.article descriptor and clears the intentional preview tail', async () => {
    const topicId = '55522281552252554';
    const createTime = '2026-04-05T02:01:00.000Z';
    const articleUrl = 'https://articles.zsxq.com/id_usrkt5tdw0go.html';
    const preview = topic(
      topicId,
      createTime,
      '中概股近期性价比分析\n近期中概迎来一波明显下跌，完整论证见关联长文...',
    );
    const full = structuredClone(preview);
    (full.talk as Record<string, unknown>).article = {
      article_id: 'usrkt5tdw0go',
      article_url: articleUrl,
      title: '中概股近期性价比分析',
    };
    const requested: string[] = [];
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      requested.push(url);
      if (url === `${API}/groups/${GROUP_ID}`) return groupResponse();
      if (url === `${API}/groups/${GROUP_ID}/menus`) return menuResponse();
      if (url === `${API}/topics/${topicId}`) {
        return response(JSON.stringify({ succeeded: true, resp_data: { topic: full } }));
      }
      return topicResponse([preview]);
    };

    const result = await collectZsxqApiOwnerPage(GROUP_ID, {}, {
      fetcher,
      aduid: 'test-device',
      requestId: () => 'test-request',
    });

    expect(requested).toContain(`${API}/topics/${topicId}`);
    expect(result.documents).toEqual([expect.objectContaining({
      truncated: false,
      html: expect.stringContaining(articleUrl),
    })]);
  });

  it('filters an explicit property-market preview before requesting topic detail', async () => {
    const topicId = '14422558414184542';
    const requested: string[] = [];
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      requested.push(url);
      if (url === `${API}/groups/${GROUP_ID}`) return groupResponse();
      if (url === `${API}/groups/${GROUP_ID}/menus`) return menuResponse();
      return topicResponse([topic(
        topicId,
        '2026-05-01T00:00:00.000Z',
        '2026一季度营收和利润数据统计结果（楼市触底确定性进一步增强） 正文预览...',
      )]);
    };

    const result = await collectZsxqApiOwnerPage(GROUP_ID, {}, {
      fetcher,
      aduid: 'test-device',
      requestId: () => 'test-request',
    });

    expect(requested).not.toContain(`${API}/topics/${topicId}`);
    expect(result.documents).toEqual([]);
    expect(result.businessSkips).toEqual([expect.objectContaining({
      reason: expect.stringContaining('楼市内容'),
    })]);
  });

  it('filters an irrelevant preview before requesting topic detail', async () => {
    const topicId = '690000000000000097';
    const requested: string[] = [];
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      requested.push(url);
      if (url === `${API}/groups/${GROUP_ID}`) return groupResponse();
      if (url === `${API}/groups/${GROUP_ID}/menus`) return menuResponse();
      return topicResponse([topic(
        topicId,
        '2026-08-19T22:00:00.000Z',
        '今天下雨了，大家周末愉快，评论区随便聊聊，后面的日常照片...',
      )]);
    };

    const result = await collectZsxqApiOwnerPage(GROUP_ID, {}, {
      fetcher,
      aduid: 'test-device',
      requestId: () => 'test-request',
    });

    expect(requested).not.toContain(`${API}/topics/${topicId}`);
    expect(result.documents).toEqual([]);
    expect(result.businessSkips).toEqual([expect.objectContaining({
      reason: '非投资创业主题',
    })]);
  });

  it('uses trusted owner context to fetch only the requested continuation page', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get('scope')).toBe('by_owner');
      expect(url.searchParams.get('end_time')).toBe('2026-08-20T00:00:00.000Z');
      return topicResponse([topic('690000000000000099', '2026-08-19T23:00:00.000Z')]);
    });

    const result = await collectZsxqApiOwnerPage(GROUP_ID, {
      cursor: '2026-08-20T00:00:00.000Z',
      context: { ownerId: '1001', ownerName: '陈老师', scope: 'by_owner' },
    }, {
      fetcher,
      aduid: 'test-device',
      requestId: () => 'test-request',
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ rawCount: 1, exhausted: true });
    expect(result.nextCursor).toBeUndefined();
  });

  it('fails closed when by_owner returns a non-owner topic', async () => {
    const member = topic('690000000000000199', '2026-08-19T23:00:00.000Z');
    (member.talk as Record<string, unknown>).owner = { user_id: '2002', name: '成员' };
    await expect(collectZsxqApiOwnerPage(GROUP_ID, {
      context: { ownerId: '1001', ownerName: '陈老师', scope: 'by_owner' },
    }, {
      fetcher: async () => topicResponse([member]),
      aduid: 'test-device',
      requestId: () => 'test-request',
    })).rejects.toThrow(/AUTHOR_IDENTITY_UNPROVEN.*690000000000000199/u);
  });

  it('collects and unions the three required views without reading the blank SPA DOM', async () => {
    const topic = String.raw`{
      "succeeded":true,
      "resp_data":{"topics":[{
        "topic_id":9223372036854775807,
        "type":"talk",
        "create_time":"2026-08-24T02:00:00.000Z",
        "talk":{"text":"陈老师关于投资创业与经营复盘的完整正文。","owner":{"user_id":1001,"name":"陈老师"}}
      }]}
    }`;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      expect(init?.credentials).toBe('include');
      expect(headers.get('X-Aduid')).toBe('test-device');
      expect(headers.get('X-Version')).toBe('2.96.0');
      expect(headers.get('X-Request-Id')).toBe('test-request');
      expect(headers.get('X-Signature')).toMatch(/^[a-f0-9]{40}$/u);
      if (url === `${API}/groups/${GROUP_ID}`) {
        return response('{"succeeded":true,"resp_data":{"group":{"owner":{"user_id":1001,"name":"陈老师"}}}}');
      }
      if (url === `${API}/groups/${GROUP_ID}/menus`) {
        return response('{"succeeded":true,"resp_data":{"menus":['
          + '{"title":"最新","preset":true,"preset_type":"all"},'
          + '{"title":"精华","preset":true,"preset_type":"digests"},'
          + '{"title":"只看星主","preset":true,"preset_type":"by_owner"}'
          + ']}}');
      }
      if (url === `${API}/groups/${GROUP_ID}/topics/sticky?count=3`) {
        return topicResponse([]);
      }
      if (url.startsWith(`${API}/groups/${GROUP_ID}/topics?`)) return response(topic);
      return response('{"code":404,"succeeded":false}', 404);
    });

    const collection = await collectZsxqApiViews(GROUP_ID, {
      fetcher,
      aduid: 'test-device',
      now: () => new Date('2026-08-25T00:00:00.000Z'),
      requestId: () => 'test-request',
    });

    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(collection.businessSkips).toEqual([]);
    expect(collection.coverage).toEqual({
      '视图:最新': 1,
      '视图:精华': 1,
      '视图:只看星主': 1,
      '发布日期:2026-08-24': 1,
    });
    expect(collection.documents).toHaveLength(1);
    expect(collection.documents[0]).toMatchObject({
      source: 'zsxq',
      canonicalUrl: `https://wx.zsxq.com/group/${GROUP_ID}/topic/9223372036854775807`,
      title: '陈老师关于投资创业与经营复盘的完整正文。',
      author: '陈老师',
      publishedAt: '2026-08-24T02:00:00.000Z',
      truncated: false,
      sourceMetadata: {
        authorRole: 'owner',
        topicId: '9223372036854775807',
        sourceBodyProven: true,
        sourceMediaProven: true,
        sourceCoversDom: true,
        viewLabels: '最新、精华、只看星主',
        extractionMode: 'signed-api-fallback',
      },
    });
  });

  it('exhausts every recent view page and includes the separate sticky feed', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => topic(
      String(700_000_000_000_000_000n + BigInt(index)),
      new Date(Date.parse('2026-08-24T23:00:00.000Z') - index * 60 * 60 * 1_000).toISOString(),
      index < 2 ? '打新 新股 积极申购' : undefined,
    ));
    const secondPageTopic = topic(
      '700000000000000020',
      '2026-08-24T03:00:00.000Z',
    );
    const stickyTopic = topic(
      '799999999999999999',
      '2026-08-24T22:30:00.000Z',
    );
    const requested: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requested.push(url);
      if (url.href === `${API}/groups/${GROUP_ID}`) {
        return response('{"succeeded":true,"resp_data":{"group":{"owner":{"user_id":"1001","name":"陈老师"}}}}');
      }
      if (url.href === `${API}/groups/${GROUP_ID}/menus`) {
        return response('{"succeeded":true,"resp_data":{"menus":['
          + '{"title":"最新","preset":true,"preset_type":"all"},'
          + '{"title":"精华","preset":true,"preset_type":"digests"}'
          + '],"optional_menus":['
          + '{"title":"只看星主","preset":true,"preset_type":"by_owner"}'
          + ']}}');
      }
      if (url.pathname.endsWith('/topics/sticky')) return topicResponse([stickyTopic]);
      if (url.pathname.endsWith('/topics')) {
        return url.searchParams.has('end_time')
          ? topicResponse([secondPageTopic])
          : topicResponse(firstPage);
      }
      return response('{"code":404,"succeeded":false}', 404);
    });

    const collection = await collectZsxqApiViews(GROUP_ID, {
      fetcher,
      aduid: 'test-device',
      now: () => new Date('2026-08-25T00:00:00.000Z'),
      requestId: () => 'test-request',
    });

    expect(fetcher).toHaveBeenCalledTimes(9);
    const pagedRequests = requested.filter(url => url.pathname.endsWith('/topics'));
    expect(pagedRequests).toHaveLength(6);
    for (const scope of ['all', 'digests', 'by_owner']) {
      const requests = pagedRequests.filter(url => url.searchParams.get('scope') === scope);
      expect(requests).toHaveLength(2);
      expect(requests[1]?.searchParams.get('end_time')).toBe('2026-08-24T03:59:59.999Z');
    }
    expect(collection.businessSkips).toHaveLength(2);
    expect(collection.documents).toHaveLength(20);
    expect(collection.documents.find(item => item.sourceMetadata?.topicId === '799999999999999999'))
      .toMatchObject({ sourceMetadata: { viewLabels: '最新' }, truncated: false });
    expect(collection.documents.find(item => item.sourceMetadata?.topicId === '700000000000000020'))
      .toMatchObject({ sourceMetadata: { viewLabels: '最新、精华、只看星主' } });
  });

  it('stops at twenty documents per view and does not let old sticky topics displace newer posts', async () => {
    const scopeBase: Record<string, bigint> = {
      all: 710_000_000_000_000_000n,
      digests: 720_000_000_000_000_000n,
      by_owner: 730_000_000_000_000_000n,
    };
    const sticky = Array.from({ length: 3 }, (_, index) => topic(
      String(790_000_000_000_000_000n + BigInt(index)),
      new Date(Date.parse('2026-08-01T00:00:00.000Z') - index * 1_000).toISOString(),
    ));
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.href === `${API}/groups/${GROUP_ID}`) return groupResponse();
      if (url.href === `${API}/groups/${GROUP_ID}/menus`) return menuResponse();
      if (url.pathname.endsWith('/topics/sticky')) return topicResponse(sticky);
      const base = scopeBase[url.searchParams.get('scope') ?? ''];
      if (base !== undefined) {
        return topicResponse(Array.from({ length: 20 }, (_, index) => topic(
          String(base + BigInt(index)),
          new Date(Date.parse('2026-08-24T23:00:00.000Z') - index * 60 * 60 * 1_000).toISOString(),
        )));
      }
      return response('{"code":404,"succeeded":false}', 404);
    });

    const collection = await collectZsxqApiViews(GROUP_ID, {
      fetcher,
      aduid: 'test-device',
      now: () => new Date('2026-08-25T00:00:00.000Z'),
      requestId: () => 'test-request',
    });

    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(collection.documents).toHaveLength(60);
    expect(collection.documents.some(document =>
      String(document.sourceMetadata?.topicId).startsWith('79'))).toBe(false);
  });

  it('fails closed after twelve full pages instead of returning a partial view', async () => {
    const pageByScope = new Map<string, number>();
    const scopeOffset: Record<string, bigint> = {
      all: 0n,
      digests: 10_000_000n,
      by_owner: 20_000_000n,
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.href === `${API}/groups/${GROUP_ID}`) return groupResponse();
      if (url.href === `${API}/groups/${GROUP_ID}/menus`) return menuResponse();
      if (url.pathname.endsWith('/topics/sticky')) return topicResponse([]);
      const scope = url.searchParams.get('scope') ?? '';
      const page = pageByScope.get(scope) ?? 0;
      pageByScope.set(scope, page + 1);
      const offset = scopeOffset[scope] ?? 0n;
      return topicResponse(Array.from({ length: 20 }, (_, index) => {
        const position = page * 20 + index;
        return topic(
          String(740_000_000_000_000_000n + offset + BigInt(position)),
          new Date(Date.parse('2026-08-24T23:00:00.000Z') - position * 10 * 60 * 1_000).toISOString(),
          '打新 新股 积极申购',
        );
      }));
    });

    await expect(collectZsxqApiViews(GROUP_ID, {
      fetcher,
      aduid: 'test-device',
      now: () => new Date('2026-08-25T00:00:00.000Z'),
      requestId: () => 'test-request',
    })).rejects.toThrow(/CONTENT_COVERAGE_INCOMPLETE.*ZSXQ_API_PAGE_LIMIT.*12/u);
    const pageCounts = [...pageByScope.values()];
    expect(Math.max(...pageCounts)).toBe(12);
    expect(pageCounts.every(count => count <= 12)).toBe(true);
  });

  it('allows the twelfth page to fill each view without requesting a thirteenth', async () => {
    const pageByScope = new Map<string, number>();
    const scopeOffset: Record<string, bigint> = {
      all: 0n,
      digests: 10_000_000n,
      by_owner: 20_000_000n,
    };
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.href === `${API}/groups/${GROUP_ID}`) return groupResponse();
      if (url.href === `${API}/groups/${GROUP_ID}/menus`) return menuResponse();
      if (url.pathname.endsWith('/topics/sticky')) return topicResponse([]);
      const scope = url.searchParams.get('scope') ?? '';
      const page = pageByScope.get(scope) ?? 0;
      pageByScope.set(scope, page + 1);
      const offset = scopeOffset[scope] ?? 0n;
      return topicResponse(Array.from({ length: 20 }, (_, index) => {
        const position = page * 20 + index;
        const retained = page === 11 ? index < 9 : index === 0;
        return topic(
          String(741_000_000_000_000_000n + offset + BigInt(position)),
          new Date(Date.parse('2026-08-24T23:00:00.000Z') - position * 10 * 60 * 1_000)
            .toISOString(),
          retained ? undefined : '打新 新股 积极申购',
        );
      }));
    };

    const collection = await collectZsxqApiViews(GROUP_ID, {
      fetcher,
      aduid: 'test-device',
      now: () => new Date('2026-08-25T00:00:00.000Z'),
      requestId: () => 'test-request',
    });

    expect([...pageByScope.values()]).toEqual([12, 12, 12]);
    expect(collection.documents).toHaveLength(60);
  });

  it('treats a full page crossing the lookback cutoff as proven exhaustion', async () => {
    const pageByScope = new Map<string, number>();
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.href === `${API}/groups/${GROUP_ID}`) return groupResponse();
      if (url.href === `${API}/groups/${GROUP_ID}/menus`) return menuResponse();
      if (url.pathname.endsWith('/topics/sticky')) return topicResponse([]);
      const scope = url.searchParams.get('scope') ?? '';
      const page = pageByScope.get(scope) ?? 0;
      pageByScope.set(scope, page + 1);
      return topicResponse(Array.from({ length: 20 }, (_, index) => topic(
        String(742_000_000_000_000_000n
          + BigInt(scope === 'all' ? 0 : scope === 'digests' ? 100 : 200)
          + BigInt(index)),
        new Date(Date.parse('2026-08-11T00:00:00.000Z') - index * 3 * 60 * 60 * 1_000)
          .toISOString(),
        index === 0 ? undefined : '打新 新股 积极申购',
      )));
    };

    const collection = await collectZsxqApiViews(GROUP_ID, {
      fetcher,
      aduid: 'test-device',
      now: () => new Date('2026-08-25T00:00:00.000Z'),
      requestId: () => 'test-request',
    });

    expect([...pageByScope.values()]).toEqual([1, 1, 1]);
    expect(collection.documents).toHaveLength(3);
  });

  it('rejects a repeated short page instead of mistaking it for source exhaustion', async () => {
    const repeated = Array.from({ length: 20 }, (_, index) => topic(
      String(760_000_000_000_000_000n + BigInt(index)),
      new Date(Date.parse('2026-08-24T23:00:00.000Z') - index * 60 * 1_000).toISOString(),
      '打新 新股 积极申购',
    ));
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.href === `${API}/groups/${GROUP_ID}`) return groupResponse();
      if (url.href === `${API}/groups/${GROUP_ID}/menus`) return menuResponse();
      if (url.pathname.endsWith('/topics/sticky')) return topicResponse([]);
      return topicResponse(url.searchParams.has('end_time') ? repeated.slice(0, 19) : repeated);
    };

    await expect(collectZsxqApiViews(GROUP_ID, {
      fetcher,
      aduid: 'test-device',
      now: () => new Date('2026-08-25T00:00:00.000Z'),
      requestId: () => 'test-request',
    })).rejects.toThrow(/CONTENT_COVERAGE_INCOMPLETE.*ZSXQ_API_CURSOR_UNPROVEN/u);
  });

  it('validates a later page cursor before accepting the document that fills the quota', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => topic(
      String(765_000_000_000_000_000n + BigInt(index)),
      new Date(Date.parse('2026-08-24T23:00:00.000Z') - index * 60 * 60 * 1_000).toISOString(),
      index === 0 ? '打新 新股 积极申购' : undefined,
    ));
    const secondIds: Record<string, string> = {
      all: '765000000000000020',
      digests: '765000000000000021',
      by_owner: '765000000000000022',
    };
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.href === `${API}/groups/${GROUP_ID}`) return groupResponse();
      if (url.href === `${API}/groups/${GROUP_ID}/menus`) return menuResponse();
      if (url.pathname.endsWith('/topics/sticky')) return topicResponse([]);
      if (!url.searchParams.has('end_time')) return topicResponse(firstPage);
      const scope = url.searchParams.get('scope') ?? '';
      return topicResponse([topic(
        secondIds[scope]!,
        scope === 'all' ? '2026-08-24T22:30:00.000Z' : '2026-08-24T03:00:00.000Z',
      )]);
    };

    await expect(collectZsxqApiViews(GROUP_ID, {
      fetcher,
      aduid: 'test-device',
      now: () => new Date('2026-08-25T00:00:00.000Z'),
      requestId: () => 'test-request',
    })).rejects.toThrow(/CONTENT_COVERAGE_INCOMPLETE.*ZSXQ_API_CURSOR_UNPROVEN/u);
  });

  it('validates first-page ordering even when that page already fills the quota', async () => {
    const unordered = Array.from({ length: 20 }, (_, index) => topic(
      String(766_000_000_000_000_000n + BigInt(index)),
      new Date(Date.parse('2026-08-24T23:00:00.000Z') - index * 60 * 60 * 1_000).toISOString(),
    ));
    unordered[19] = topic(
      '766000000000000019',
      '2026-08-24T22:30:00.000Z',
    );
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.href === `${API}/groups/${GROUP_ID}`) return groupResponse();
      if (url.href === `${API}/groups/${GROUP_ID}/menus`) return menuResponse();
      if (url.pathname.endsWith('/topics/sticky')) return topicResponse([]);
      return topicResponse(unordered);
    };

    await expect(collectZsxqApiViews(GROUP_ID, {
      fetcher,
      aduid: 'test-device',
      now: () => new Date('2026-08-25T00:00:00.000Z'),
      requestId: () => 'test-request',
    })).rejects.toThrow(/CONTENT_COVERAGE_INCOMPLETE.*ZSXQ_API_ORDER_UNPROVEN/u);
  });

  it('rejects an invalid owner scope instead of silently collecting the wrong view', async () => {
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url === `${API}/groups/${GROUP_ID}`) return groupResponse();
      if (url === `${API}/groups/${GROUP_ID}/menus`) {
        return response('{"succeeded":true,"resp_data":{"menus":['
          + '{"title":"最新","preset":true,"preset_type":"all"},'
          + '{"title":"精华","preset":true,"preset_type":"digests"},'
          + '{"title":"只看星主","preset":true,"preset_type":"owner"}'
          + ']}}');
      }
      return topicResponse([]);
    };

    await expect(collectZsxqApiViews(GROUP_ID, {
      fetcher,
      aduid: 'test-device',
      requestId: () => 'test-request',
    })).rejects.toThrow(/ZSXQ_API_VIEW_UNPROVEN.*by_owner.*owner/u);
  });

  it('fails closed when a topic has no exact publication time for pagination and filtering', async () => {
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.href === `${API}/groups/${GROUP_ID}`) return groupResponse();
      if (url.href === `${API}/groups/${GROUP_ID}/menus`) return menuResponse();
      if (url.pathname.endsWith('/topics/sticky')) return topicResponse([]);
      return topicResponse([{
        topic_id: '770000000000000001',
        type: 'talk',
        create_time: 'not-a-time',
        talk: { text: '投资经营正文', owner: { user_id: '1001' } },
      }]);
    };

    await expect(collectZsxqApiViews(GROUP_ID, {
      fetcher,
      aduid: 'test-device',
      requestId: () => 'test-request',
    })).rejects.toThrow(/CONTENT_COVERAGE_INCOMPLETE.*ZSXQ_API_PUBLISHED_AT_UNPROVEN.*770000000000000001/u);
  });

  it('keeps a business skip sticky when only a richer cross-view copy proves it', async () => {
    const topicId = '775000000000000001';
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.href === `${API}/groups/${GROUP_ID}`) return groupResponse();
      if (url.href === `${API}/groups/${GROUP_ID}/menus`) return menuResponse();
      if (url.pathname.endsWith('/topics/sticky')) return topicResponse([]);
      const text = url.searchParams.get('scope') === 'all'
        ? '打新观察'
        : '打新观察：新股积极申购';
      return topicResponse([topic(topicId, '2026-08-24T12:00:00.000Z', text)]);
    };

    const collection = await collectZsxqApiViews(GROUP_ID, {
      fetcher,
      aduid: 'test-device',
      now: () => new Date('2026-08-25T00:00:00.000Z'),
      requestId: () => 'test-request',
    });

    expect(collection.documents).toEqual([]);
    expect(collection.businessSkips).toEqual([
      expect.objectContaining({
        url: `https://wx.zsxq.com/group/${GROUP_ID}/topic/${topicId}`,
        reason: expect.stringContaining('打新内容'),
      }),
    ]);
  });

  it('filters a skipped sticky copy before it can displace a retained latest post', async () => {
    const stickyTopicId = '775500000000000000';
    const latestTopics = Array.from({ length: 20 }, (_, index) => topic(
      String(775_500_000_000_000_100n + BigInt(index)),
      new Date(Date.parse('2026-08-24T22:00:00.000Z') - index * 60 * 1_000).toISOString(),
    ));
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.href === `${API}/groups/${GROUP_ID}`) return groupResponse();
      if (url.href === `${API}/groups/${GROUP_ID}/menus`) return menuResponse();
      if (url.pathname.endsWith('/topics/sticky')) {
        return topicResponse([topic(
          stickyTopicId,
          '2026-08-24T23:00:00.000Z',
          '打新观察',
        )]);
      }
      if (url.searchParams.get('scope') === 'all') return topicResponse(latestTopics);
      if (url.searchParams.get('scope') === 'digests') {
        return topicResponse([topic(
          stickyTopicId,
          '2026-08-24T23:00:00.000Z',
          '打新观察：新股积极申购',
        )]);
      }
      return topicResponse([]);
    };

    const collection = await collectZsxqApiViews(GROUP_ID, {
      fetcher,
      aduid: 'test-device',
      now: () => new Date('2026-08-25T00:00:00.000Z'),
      requestId: () => 'test-request',
    });

    expect(collection.documents).toHaveLength(20);
    expect(collection.documents.some(document =>
      document.sourceMetadata?.topicId === stickyTopicId)).toBe(false);
    expect(collection.documents.some(document =>
      document.sourceMetadata?.topicId === '775500000000000119')).toBe(true);
  });

  it('resumes a capped view when a later cross-view business skip removes one document', async () => {
    const sharedTopicId = '776000000000000000';
    const firstPage = Array.from({ length: 20 }, (_, index) => topic(
      String(776_000_000_000_000_000n + BigInt(index)),
      new Date(Date.parse('2026-08-24T23:00:00.000Z') - index * 60 * 60 * 1_000).toISOString(),
      index === 0 ? '打新观察' : undefined,
    ));
    const allRequests: URL[] = [];
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.href === `${API}/groups/${GROUP_ID}`) return groupResponse();
      if (url.href === `${API}/groups/${GROUP_ID}/menus`) return menuResponse();
      if (url.pathname.endsWith('/topics/sticky')) return topicResponse([]);
      const scope = url.searchParams.get('scope');
      if (scope === 'all') {
        allRequests.push(url);
        return url.searchParams.has('end_time')
          ? topicResponse([topic('776000000000000020', '2026-08-24T03:00:00.000Z')])
          : topicResponse(firstPage);
      }
      if (scope === 'digests') {
        return topicResponse([topic(
          sharedTopicId,
          '2026-08-24T23:00:00.000Z',
          '打新观察：新股积极申购',
        )]);
      }
      return topicResponse([]);
    };

    const collection = await collectZsxqApiViews(GROUP_ID, {
      fetcher,
      aduid: 'test-device',
      now: () => new Date('2026-08-25T00:00:00.000Z'),
      requestId: () => 'test-request',
    });

    expect(allRequests).toHaveLength(2);
    expect(allRequests[1]?.searchParams.get('end_time')).toBe('2026-08-24T03:59:59.999Z');
    expect(collection.documents).toHaveLength(20);
    expect(collection.documents.some(document =>
      document.sourceMetadata?.topicId === sharedTopicId)).toBe(false);
    expect(collection.documents.some(document =>
      document.sourceMetadata?.topicId === '776000000000000020')).toBe(true);
  });

  it('keeps richer and incomplete observations outside another view top twenty', async () => {
    const targetId = '776500000000000000';
    const taintedId = '776500000000000001';
    const shortText = '投资经营短正文';
    const richText = `${shortText}，这是已核验的完整尾段`;
    const taintedText = '投资经营风险正文';
    const latest = Array.from({ length: 20 }, (_, index) => topic(
      index === 18
        ? targetId
        : index === 19 ? taintedId : String(776_500_000_000_000_100n + BigInt(index)),
      new Date(Date.parse('2026-08-24T22:58:00.000Z') - index * 60 * 1_000).toISOString(),
      index === 18 ? shortText : index === 19 ? taintedText : undefined,
    ));
    const digestFirstPage = Array.from({ length: 20 }, (_, index) => topic(
      String(776_500_000_000_001_000n + BigInt(index)),
      new Date(Date.parse('2026-08-24T23:30:00.000Z') - index * 60 * 1_000).toISOString(),
      index === 0 ? '打新 新股 积极申购' : undefined,
    ));
    const digestSecondPage = [
      topic('776500000000002000', '2026-08-24T23:10:00.000Z'),
      topic(targetId, '2026-08-24T22:40:00.000Z', richText),
      {
        ...topic(
          taintedId,
          '2026-08-24T22:39:00.000Z',
          `${taintedText}，这份副本无法证明全文`,
        ),
        talk: {
          text: `${taintedText}，这份副本无法证明全文`,
          owner: { user_id: '1001', name: '陈老师' },
          media_component: { opaque_id: 'future-media' },
        },
      },
      ...Array.from({ length: 17 }, (_, index) => topic(
        String(776_500_000_000_002_100n + BigInt(index)),
        new Date(Date.parse('2026-08-24T22:38:00.000Z') - index * 60 * 1_000).toISOString(),
      )),
    ];
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.href === `${API}/groups/${GROUP_ID}`) return groupResponse();
      if (url.href === `${API}/groups/${GROUP_ID}/menus`) return menuResponse();
      if (url.pathname.endsWith('/topics/sticky')) return topicResponse([]);
      const scope = url.searchParams.get('scope');
      if (scope === 'all') return topicResponse(latest);
      if (scope === 'digests') {
        return topicResponse(url.searchParams.has('end_time')
          ? digestSecondPage
          : digestFirstPage);
      }
      return topicResponse([]);
    };

    const collection = await collectZsxqApiViews(GROUP_ID, {
      fetcher,
      aduid: 'test-device',
      now: () => new Date('2026-08-25T00:00:00.000Z'),
      requestId: () => 'test-request',
    });

    expect(collection.documents.find(document =>
      document.sourceMetadata?.topicId === targetId)).toMatchObject({
      text: richText,
      truncated: false,
    });
    expect(collection.documents.find(document =>
      document.sourceMetadata?.topicId === taintedId)).toMatchObject({
      text: `${taintedText}，这份副本无法证明全文`,
      truncated: true,
      sourceMetadata: { sourceMediaIssues: 'field:media_component:object-opaque_id' },
    });
  });

  it('rejects a normal page that exceeds the requested twenty raw topics', async () => {
    const overfull = Array.from({ length: 21 }, (_, index) => topic(
      String(777_000_000_000_000_000n + BigInt(index)),
      new Date(Date.parse('2026-08-24T23:00:00.000Z') - index * 60 * 1_000).toISOString(),
    ));
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.href === `${API}/groups/${GROUP_ID}`) return groupResponse();
      if (url.href === `${API}/groups/${GROUP_ID}/menus`) return menuResponse();
      if (url.pathname.endsWith('/topics/sticky')) return topicResponse([]);
      return topicResponse(overfull);
    };

    await expect(collectZsxqApiViews(GROUP_ID, {
      fetcher,
      aduid: 'test-device',
      now: () => new Date('2026-08-25T00:00:00.000Z'),
      requestId: () => 'test-request',
    })).rejects.toThrow(/CONTENT_COVERAGE_INCOMPLETE.*ZSXQ_API_RESPONSE_INVALID.*21.*20/u);
  });

  it('rejects a sticky response that exceeds the requested three topics', async () => {
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.href === `${API}/groups/${GROUP_ID}`) return groupResponse();
      if (url.href === `${API}/groups/${GROUP_ID}/menus`) return menuResponse();
      if (url.pathname.endsWith('/topics/sticky')) {
        return topicResponse(Array.from({ length: 4 }, (_, index) => topic(
          String(778_000_000_000_000_000n + BigInt(index)),
          new Date(Date.parse('2026-08-24T23:00:00.000Z') - index * 1_000).toISOString(),
        )));
      }
      return topicResponse([]);
    };

    await expect(collectZsxqApiViews(GROUP_ID, {
      fetcher,
      aduid: 'test-device',
      requestId: () => 'test-request',
    })).rejects.toThrow(/CONTENT_COVERAGE_INCOMPLETE.*ZSXQ_API_RESPONSE_INVALID.*4.*3/u);
  });

  it('fails closed before the signed fallback exceeds its message character budget', async () => {
    const largeText = `投资经营${'长'.repeat(100_000)}`;
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.href === `${API}/groups/${GROUP_ID}`) return groupResponse();
      if (url.href === `${API}/groups/${GROUP_ID}/menus`) return menuResponse();
      if (url.pathname.endsWith('/topics/sticky')) return topicResponse([]);
      if (url.searchParams.get('scope') !== 'all') return topicResponse([]);
      return topicResponse(Array.from({ length: 11 }, (_, index) => topic(
        String(779_000_000_000_000_000n + BigInt(index)),
        new Date(Date.parse('2026-08-24T23:00:00.000Z') - index * 60 * 1_000).toISOString(),
        `${largeText}${index}`,
      )));
    };

    await expect(collectZsxqApiViews(GROUP_ID, {
      fetcher,
      aduid: 'test-device',
      now: () => new Date('2026-08-25T00:00:00.000Z'),
      requestId: () => 'test-request',
    })).rejects.toThrow(/CONTENT_COVERAGE_INCOMPLETE.*ZSXQ_API_PAYLOAD_LIMIT.*2000000/u);
  });

  it('fails closed when a successful topic page contains an unconvertible entry', async () => {
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.href === `${API}/groups/${GROUP_ID}`) {
        return response('{"succeeded":true,"resp_data":{"group":{"owner":{"user_id":"1001"}}}}');
      }
      if (url.href === `${API}/groups/${GROUP_ID}/menus`) {
        return response('{"succeeded":true,"resp_data":{"menus":['
          + '{"title":"最新","preset":true,"preset_type":"all"},'
          + '{"title":"精华","preset":true,"preset_type":"digests"},'
          + '{"title":"只看星主","preset":true,"preset_type":"by_owner"}'
          + ']}}');
      }
      if (url.pathname.endsWith('/topics/sticky')) return topicResponse([]);
      return topicResponse([{
        topic_id: '700000000000000001',
        type: 'talk',
        create_time: '2026-08-24T23:00:00.000Z',
        talk: { owner: { user_id: '1001' } },
      }]);
    };

    await expect(collectZsxqApiViews(GROUP_ID, {
      fetcher,
      aduid: 'test-device',
      requestId: () => 'test-request',
    })).rejects.toThrow(/ZSXQ_API_TOPIC_UNPROVEN.*700000000000000001/u);
  });

  it('does not guess a scope when a required server menu is missing', async () => {
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url === `${API}/groups/${GROUP_ID}`) {
        return response('{"succeeded":true,"resp_data":{"group":{"owner":{"user_id":"1001"}}}}');
      }
      if (url === `${API}/groups/${GROUP_ID}/menus`) {
        return response('{"succeeded":true,"resp_data":{"menus":['
          + '{"title":"最新","preset":true,"preset_type":"all"},'
          + '{"title":"精华","preset":true,"preset_type":"digests"}'
          + ']}}');
      }
      return topicResponse([]);
    };

    await expect(collectZsxqApiViews(GROUP_ID, {
      fetcher,
      aduid: 'test-device',
      requestId: () => 'test-request',
    })).rejects.toThrow(/ZSXQ_API_VIEW_UNPROVEN.*只看星主/u);
  });

  it('fails closed when the authenticated API session is unavailable', async () => {
    await expect(collectZsxqApiViews(GROUP_ID, {
      fetcher: async () => response('{"code":401,"succeeded":false}', 401),
      aduid: 'test-device',
      requestId: () => 'test-request',
    })).rejects.toThrow(/AUTH_REQUIRED/u);
  });

  it('keeps a permission code actionable instead of hiding it as a generic fallback failure', async () => {
    await expect(collectZsxqApiViews(GROUP_ID, {
      fetcher: async () => response(
        '{"code":1030,"succeeded":false,"info":"当前账号无权访问该星球"}',
      ),
      aduid: 'test-device',
      requestId: () => 'test-request',
    })).rejects.toThrow(/AUTH_REQUIRED.*1030.*无权访问/u);
  });

  it('classifies a non-JSON forbidden response before treating it as a parse failure', async () => {
    await expect(collectZsxqApiViews(GROUP_ID, {
      fetcher: async () => new Response('<html>forbidden</html>', { status: 403 }),
      aduid: 'test-device',
      requestId: () => 'test-request',
    })).rejects.toThrow(/AUTH_REQUIRED.*HTTP 403/u);
  });

  it('surfaces signature rejection with the exact server code', async () => {
    await expect(collectZsxqApiViews(GROUP_ID, {
      fetcher: async () => response(
        '{"code":1059,"succeeded":false,"info":"X-Signature 校验失败"}',
      ),
      aduid: 'test-device',
      requestId: () => 'test-request',
    })).rejects.toThrow(/ZSXQ_API_SIGNATURE_INVALID.*1059.*X-Signature/u);
  });
});
