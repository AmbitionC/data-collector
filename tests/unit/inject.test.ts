// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://wx.zsxq.com/group/48844584441158" }
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOPIC_HOOK_FLAG, TOPIC_MESSAGE } from '../../packages/extension/src/topicIndex.js';

interface Published {
  source: string;
  records: { topicId: string; text: string }[];
}

const TOPICS_RESPONSE = {
  succeeded: true,
  resp_data: {
    topics: [
      { topic_id: 511111111111111, talk: { text: '创业板已经跌破 60 日线，仓位要降下来' } },
      { topic_id: 522222222222222, talk: { text: '关于长期投资的一点想法，先说结论' } },
    ],
  },
};

let published: Published[];
let originalFetch: typeof fetch;
let originalOpen: typeof XMLHttpRequest.prototype.open;
let collect: (event: MessageEvent) => void;

/**
 * 主世界脚本只在导入时打补丁一次，每个用例都还原成未打补丁的状态。
 * 防重标记挂在 window 上、跨用例存活，不清掉的话第二个用例根本不会打补丁。
 */
async function loadInject(fetchImplementation: typeof fetch): Promise<void> {
  window.fetch = fetchImplementation;
  delete (window as unknown as Record<string, unknown>)[TOPIC_HOOK_FLAG];
  vi.resetModules();
  await import('../../packages/extension/src/inject.js');
}

beforeEach(() => {
  published = [];
  originalFetch = window.fetch;
  originalOpen = XMLHttpRequest.prototype.open;
  collect = event => {
    const data = event.data as Published | undefined;
    if (data?.source === TOPIC_MESSAGE) published.push(data);
  };
  window.addEventListener('message', collect);
});

afterEach(() => {
  // 监听器必须摘掉：上一个用例迟到的发布会串进下一个用例的断言。
  window.removeEventListener('message', collect);
  window.fetch = originalFetch;
  XMLHttpRequest.prototype.open = originalOpen;
  vi.restoreAllMocks();
});

describe('main-world topic capture', () => {
  it('harvests topic ids from a JSON response the app itself fetched', async () => {
    await loadInject(async () =>
      new Response(JSON.stringify(TOPICS_RESPONSE), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    );

    await window.fetch('https://api.zsxq.com/v2/groups/1/topics?scope=digests');
    await vi.waitFor(() => expect(published).toHaveLength(1));

    expect(published[0]?.records.map(record => record.topicId))
      .toEqual(['511111111111111', '522222222222222']);
    expect(published[0]?.records[0]?.text).toContain('创业板已经跌破');
  });

  it('leaves the response body intact for the page that asked for it', async () => {
    await loadInject(async () =>
      new Response(JSON.stringify(TOPICS_RESPONSE), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    // 必须 clone 后再读：直接消费响应体会让应用自己拿不到数据，页面就白屏了。
    const response = await window.fetch('https://api.zsxq.com/v2/groups/1/topics');
    await expect(response.json()).resolves.toMatchObject({ succeeded: true });
    // 等这次旁观读取跑完，免得它迟到并串进下一个用例。
    await vi.waitFor(() => expect(published).toHaveLength(1));
  });

  it('ignores non-JSON responses and never throws into the page', async () => {
    await loadInject(async () =>
      new Response('<html>not json</html>', { headers: { 'content-type': 'text/html' } }),
    );

    await expect(window.fetch('https://wx.zsxq.com/')).resolves.toBeInstanceOf(Response);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(published).toEqual([]);
  });

  it('does not swallow a failed request', async () => {
    await loadInject(async () => { throw new TypeError('Failed to fetch'); });

    // 旁观不能改变页面自己的行为：失败还是要照常抛给调用方。
    await expect(window.fetch('https://api.zsxq.com/v2/groups/1/topics'))
      .rejects.toThrow('Failed to fetch');
  });

  it('只打一次补丁，重复注入不会把响应上报两遍', async () => {
    // manifest 在 document_start 注入一次，扩展更新后后台还会对已打开的标签页补注入
    // 一次。没有防重标记的话，第二次会把已包装的 fetch 再包一层，每条响应重复上报。
    await loadInject(async () =>
      new Response(JSON.stringify(TOPICS_RESPONSE), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    const patchedOnce = window.fetch;
    // 第二次注入：不清标记，模拟真实的重复注入。
    vi.resetModules();
    await import('../../packages/extension/src/inject.js');
    expect(window.fetch).toBe(patchedOnce);

    await window.fetch('https://api.zsxq.com/v2/groups/1/topics?scope=digests');
    await vi.waitFor(() => expect(published).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(published).toHaveLength(1);
  });

  it('publishes nothing when the payload has no topic ids', async () => {
    await loadInject(async () =>
      new Response(JSON.stringify({ resp_data: { user: { name: '重远' } } }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    await window.fetch('https://api.zsxq.com/v2/users/self');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(published).toEqual([]);
  });
});
