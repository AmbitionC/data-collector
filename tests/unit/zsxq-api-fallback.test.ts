import { describe, expect, it, vi } from 'vitest';
import { collectZsxqApiViews } from '../../packages/extension/src/zsxqApiFallback.js';

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

describe('ZSXQ API fallback', () => {
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
