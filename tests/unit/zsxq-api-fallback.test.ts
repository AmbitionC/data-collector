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
          + '{"title":"只看星主","preset":true,"preset_type":"owner"}'
          + ']}}');
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

    expect(fetcher).toHaveBeenCalledTimes(5);
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

  it('fails closed when the authenticated API session is unavailable', async () => {
    await expect(collectZsxqApiViews(GROUP_ID, {
      fetcher: async () => response('{"code":401,"succeeded":false}', 401),
      aduid: 'test-device',
      requestId: () => 'test-request',
    })).rejects.toThrow(/AUTH_REQUIRED/u);
  });
});
