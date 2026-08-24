// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://wx.zsxq.com/group/48844584441158" }
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TOPIC_HOOK_FLAG,
  TOPIC_HOOK_VERSION,
  TOPIC_MESSAGE,
  TOPIC_REPLAY_REQUEST,
  TOPIC_STORE_KEY,
  TopicIndex,
  type TopicRecord,
} from '../../packages/extension/src/topicIndex.js';

interface Published {
  source: string;
  hookVersion: number;
  hookBuildId?: string;
  records: TopicRecord[];
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
  const store = window as unknown as Record<string, unknown>;
  delete store[TOPIC_HOOK_FLAG];
  // 留存集也挂在 window 上、跨实例共享，模拟「全新页面」时要一并清掉。
  delete store[TOPIC_STORE_KEY];
  delete store.__dataCollectorTopicState;
  delete store.__dataCollectorTopicTransport;
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
  vi.unstubAllGlobals();
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
    expect(published[0]?.hookVersion).toBe(TOPIC_HOOK_VERSION);
    expect(published[0]?.records[0]?.text).toContain('创业板已经跌破');
    expect(published[0]?.records[0]?.sourceBodyProven).toBe(true);
  });

  it('keeps source proof when fetch receives a Request object instead of a URL string', async () => {
    await loadInject(async () =>
      new Response(JSON.stringify(TOPICS_RESPONSE), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    await window.fetch(new Request('https://api.zsxq.com/v2/groups/1/topics?scope=digests'));
    await vi.waitFor(() => expect(published).toHaveLength(1));

    expect(published[0]?.records.every(record => record.sourceBodyProven === true)).toBe(true);
  });

  it('preserves an int64 topic id exactly when the raw JSON encoded it as a number', async () => {
    const exactId = '55522452154844124';
    const raw = '{"succeeded":true,"resp_data":{"topics":[{"topic_id":'
      + exactId
      + ',"talk":{"text":"超大帖子号必须逐位保持，不能在 JSON.parse 时悄悄改号。"}}]}}';
    await loadInject(async () =>
      new Response(raw, { headers: { 'content-type': 'application/json' } }),
    );

    await window.fetch('https://api.zsxq.com/v2/groups/1/topics');
    await vi.waitFor(() => expect(published).toHaveLength(1));

    expect(published[0]?.records[0]).toMatchObject({
      topicId: exactId,
      sourceBodyProven: true,
    });
  });

  it('preserves an int64 topic id from XHR responseType=json without changing the page response shape', async () => {
    const exactId = '55522452154844124';
    const raw = '{"succeeded":true,"resp_data":{"topics":[{"topic_id":'
      + exactId
      + ',"talk":{"text":"XHR JSON 的超大帖子号也必须逐位保持。"}}]}}';
    class FakeXMLHttpRequest extends EventTarget {
      private nativeType: XMLHttpRequestResponseType = '';
      private nativeText = '';
      readyState = 4;

      open(): void {}
      send(): void {
        this.nativeText = raw;
        this.dispatchEvent(new Event('load'));
      }
      get responseType(): XMLHttpRequestResponseType { return this.nativeType; }
      set responseType(value: XMLHttpRequestResponseType) { this.nativeType = value; }
      get response(): unknown {
        return this.nativeType === 'json' ? JSON.parse(this.nativeText) : this.nativeText;
      }
      get responseText(): string {
        if (this.nativeType === 'json') throw new DOMException('InvalidStateError', 'InvalidStateError');
        return this.nativeText;
      }
      getResponseHeader(name: string): string | null {
        return name.toLowerCase() === 'content-type' ? 'application/json' : null;
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest as unknown as typeof XMLHttpRequest);
    await loadInject(async () => new Response('{}'));

    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://api.zsxq.com/v2/groups/1/topics');
    xhr.responseType = 'json';
    xhr.send();
    await vi.waitFor(() => expect(published).toHaveLength(1));

    expect((xhr.response as { resp_data: { topics: Array<{ topic_id: number }> } })
      .resp_data.topics[0]?.topic_id).toBe(Number(exactId));
    expect(published[0]?.records[0]?.topicId).toBe(exactId);
  });

  it('keeps responseType=json response null until XHR reaches DONE', async () => {
    const raw = '{"succeeded":true,"resp_data":{"topics":[]}}';
    class StreamingXMLHttpRequest extends EventTarget {
      private nativeType: XMLHttpRequestResponseType = '';
      private nativeText = '';
      readyState = 0;

      open(): void { this.readyState = 1; }
      beginLoading(): void {
        this.nativeText = raw;
        this.readyState = 3;
        this.dispatchEvent(new Event('readystatechange'));
      }
      finish(): void {
        this.readyState = 4;
        this.dispatchEvent(new Event('readystatechange'));
        this.dispatchEvent(new Event('load'));
      }
      get responseType(): XMLHttpRequestResponseType { return this.nativeType; }
      set responseType(value: XMLHttpRequestResponseType) { this.nativeType = value; }
      get response(): unknown {
        if (this.nativeType !== 'json') return this.nativeText;
        return this.readyState === 4 ? JSON.parse(this.nativeText) : null;
      }
      get responseText(): string {
        if (this.nativeType === 'json') throw new DOMException('InvalidStateError', 'InvalidStateError');
        return this.nativeText;
      }
      getResponseHeader(): string { return 'application/json'; }
    }
    vi.stubGlobal('XMLHttpRequest', StreamingXMLHttpRequest as unknown as typeof XMLHttpRequest);
    await loadInject(async () => new Response('{}'));

    const xhr = new XMLHttpRequest() as XMLHttpRequest & StreamingXMLHttpRequest;
    xhr.open('GET', 'https://api.zsxq.com/v2/groups/1/topics');
    xhr.responseType = 'json';
    xhr.beginLoading();

    expect(xhr.readyState).toBe(3);
    expect(xhr.response).toBeNull();

    xhr.finish();
    expect(xhr.response).toMatchObject({ succeeded: true });
  });

  it('does not change the logical responseType when the native setter rejects an assignment', async () => {
    class ThrowingXMLHttpRequest extends EventTarget {
      private nativeType: XMLHttpRequestResponseType = '';
      readyState = 1;

      open(): void {}
      get responseType(): XMLHttpRequestResponseType { return this.nativeType; }
      set responseType(value: XMLHttpRequestResponseType) {
        if (value === 'text') throw new DOMException('InvalidStateError', 'InvalidStateError');
        this.nativeType = value;
      }
      get response(): unknown { return null; }
      get responseText(): string { return ''; }
      getResponseHeader(): string { return 'application/json'; }
    }
    vi.stubGlobal('XMLHttpRequest', ThrowingXMLHttpRequest as unknown as typeof XMLHttpRequest);
    await loadInject(async () => new Response('{}'));

    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://api.zsxq.com/v2/groups/1/topics');

    expect(() => { xhr.responseType = 'json'; }).toThrowError('InvalidStateError');
    expect(xhr.responseType).toBe('');
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

  it('A→B→C 只换当前 delegate/留存库，transport 不叠加且单次只由 C 处理', async () => {
    let body: unknown = TOPICS_RESPONSE;
    vi.stubGlobal('__BUILD_ID__', 'v0.4.29 · build-A');
    await loadInject(async () =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
    );
    const store = window as unknown as Record<string, unknown>;
    const wrapperA = window.fetch;
    const xhrOpenA = XMLHttpRequest.prototype.open;
    await window.fetch('https://api.zsxq.com/v2/groups/1/topics');
    await vi.waitFor(() => expect(published).toHaveLength(1));
    const retainedA = retainedRecords(store[TOPIC_STORE_KEY]);

    expect(store[TOPIC_HOOK_FLAG]).toMatchObject({
      version: TOPIC_HOOK_VERSION,
      buildId: 'v0.4.29 · build-A',
    });
    expect(published[0]).toMatchObject({
      hookVersion: TOPIC_HOOK_VERSION,
      hookBuildId: 'v0.4.29 · build-A',
    });

    // 扩展更新后协议版本没变，但 B 的 parser / 截断上限可能已不同。
    // transport 必须稳定不变，只原子替换它读取的 current delegate + Map。
    vi.stubGlobal('__BUILD_ID__', 'v0.4.29 · build-B');
    vi.resetModules();
    await import('../../packages/extension/src/inject.js');

    expect(window.fetch).toBe(wrapperA);
    expect(XMLHttpRequest.prototype.open).toBe(xhrOpenA);
    expect(store[TOPIC_HOOK_FLAG]).toMatchObject({
      version: TOPIC_HOOK_VERSION,
      buildId: 'v0.4.29 · build-B',
    });
    const retainedB = retainedRecords(store[TOPIC_STORE_KEY]);
    expect(retainedB).not.toBe(retainedA);
    expect(retainedB.size).toBe(0);

    vi.stubGlobal('__BUILD_ID__', 'v0.4.29 · build-C');
    vi.resetModules();
    await import('../../packages/extension/src/inject.js');
    expect(window.fetch).toBe(wrapperA);
    expect(XMLHttpRequest.prototype.open).toBe(xhrOpenA);
    expect(store[TOPIC_HOOK_FLAG]).toMatchObject({
      version: TOPIC_HOOK_VERSION,
      buildId: 'v0.4.29 · build-C',
    });
    const retainedC = retainedRecords(store[TOPIC_STORE_KEY]);
    expect(retainedC).not.toBe(retainedB);
    expect(retainedC.size).toBe(0);

    body = {
      resp_data: {
        topics: [{ topic_id: 544444444444444, talk: { text: 'C 构建捕获的完整正文。' } }],
      },
    };
    published.length = 0;
    await window.fetch('https://api.zsxq.com/v2/groups/1/topics?scope=digests');
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]).toMatchObject({
      hookBuildId: 'v0.4.29 · build-C',
      records: [expect.objectContaining({ topicId: '544444444444444' })],
    });
    expect(retainedA.size).toBe(2);
    expect(retainedB.size).toBe(0);
    expect(retainedC.size).toBe(1);

    published.length = 0;
    requestReplay('v0.4.29 · build-C');
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]).toMatchObject({
      hookVersion: TOPIC_HOOK_VERSION,
      hookBuildId: 'v0.4.29 · build-C',
    });
    expect(published[0]?.records.map(record => record.topicId)).toEqual(['544444444444444']);
  });

  it('升级时替换旧版钩子、丢弃旧留存，并为新记录带版本与截断证据', async () => {
    const oversized = '这是一篇超过上限的投资与企业经营长文。'.repeat(12_000);
    const response = {
      resp_data: { topics: [{ topic_id: 588888888888888, talk: { text: oversized } }] },
    };
    const legacyFetch = vi.fn(async () =>
      new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } }),
    ) as unknown as typeof fetch;
    const store = window as unknown as Record<string, unknown>;
    window.fetch = legacyFetch;
    store[TOPIC_HOOK_FLAG] = {
      version: TOPIC_HOOK_VERSION - 1,
      installed: true,
      observed: 1,
      jsonResponses: 1,
      withTopicId: 1,
      publishedRecords: 1,
      recent: [],
    };
    store[TOPIC_STORE_KEY] = new Map([[
      '588888888888888',
      {
        topicId: '588888888888888',
        text: oversized.slice(0, 2_000),
        fullText: oversized.slice(0, 200_000),
      },
    ]]);

    vi.resetModules();
    await import('../../packages/extension/src/inject.js');
    expect(window.fetch).not.toBe(legacyFetch);

    published.length = 0;
    requestReplay();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(published).toEqual([]);

    await window.fetch('https://api.zsxq.com/v2/groups/1/topics');
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]?.hookVersion).toBe(TOPIC_HOOK_VERSION);
    expect(published[0]?.records[0]).toMatchObject({
      topicId: '588888888888888',
      fullTextTruncated: true,
    });
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

/**
 * 主世界的监听要求 `event.source === window`（防别的 iframe 伪造）。
 * jsdom 的 postMessage 不带 source，真实浏览器带——按生产前提派发，
 * 而不是为了测试放宽生产代码的校验。
 */
function requestReplay(hookBuildId = '开发构建'): void {
  window.dispatchEvent(new MessageEvent('message', {
    source: window,
    origin: window.location.origin,
    data: { source: TOPIC_REPLAY_REQUEST, hookVersion: TOPIC_HOOK_VERSION, hookBuildId },
  }));
}

function retainedRecords(value: unknown): Map<string, unknown> {
  const records = (value as { records?: unknown } | undefined)?.records;
  if (!(records instanceof Map)) throw new Error('测试前提失败：钩子留存库不是 Map');
  return records;
}

describe('内容脚本被重注入后，帖子号必须还在', () => {
  it('钩子留存帖子号，收到重放请求时整批交还', async () => {
    // 实测现场：hook.publishedRecords = 201，而内容脚本里 capturedTopics 只有 20。
    // 钩子活在页面里、扩展重载不影响它；内容脚本却会被销毁重注入，索引跟着清零。
    // 页面上的老帖子还在，它们的接口响应不会重来 —— 于是一半对得上、一半对不上。
    await loadInject(async () =>
      new Response(JSON.stringify(TOPICS_RESPONSE), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    await window.fetch('https://api.zsxq.com/v2/groups/1/topics?scope=digests');
    await vi.waitFor(() => expect(published).toHaveLength(1));
    const firstBatch = published[0]!.records.map(record => record.topicId);
    expect(firstBatch).toHaveLength(2);

    // 模拟内容脚本重注入：它把之前收到的都丢了，于是要一次重放。
    published.length = 0;
    requestReplay();

    await vi.waitFor(() => expect(published.length).toBeGreaterThan(0));
    const replayed = published.flatMap(message => message.records.map(record => record.topicId));
    expect(replayed.sort()).toEqual(firstBatch.sort());
  });

  it('同一条帖子重复出现时只留最长的那份正文，不会无限堆积', async () => {
    // 注意不能中途重新赋值 window.fetch——那会把补丁本身覆盖掉。
    let body: unknown = {
      resp_data: { topics: [{ topic_id: 511000000000000, talk: { text: '短的正文，长度刚好够用来对号。' } }] },
    };
    await loadInject(async () =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
    );
    await window.fetch('https://api.zsxq.com/v2/groups/1/topics');
    await vi.waitFor(() => expect(published).toHaveLength(1));

    // 同一条帖子第二次出现，这次正文更全（页面展开后接口给了完整版）。
    body = {
      resp_data: {
        topics: [{ topic_id: 511000000000000, talk: { text: '短的正文，长度刚好够用来对号。后面还有更完整的一大段内容。' } }],
      },
    };
    await window.fetch('https://api.zsxq.com/v2/groups/1/topics');
    await vi.waitFor(() => expect(published).toHaveLength(2));

    published.length = 0;
    requestReplay();
    await vi.waitFor(() => expect(published.length).toBeGreaterThan(0));

    const records = published.flatMap(message => message.records);
    expect(records).toHaveLength(1);
    expect(records[0]?.text).toContain('后面还有更完整的一大段内容');
  });

  it.each([
    {
      label: '正文',
      first: { talk: { text: '第一份已核验来源正文，不能被同号的另一份内容覆盖。' } },
      second: { talk: { text: '第二份已核验来源正文，和第一份完全不兼容。' } },
      third: { talk: { text: '第三份同号来源也不得让冲突留存历史无限增长。' } },
    },
    {
      label: '完整媒体集',
      first: {
        talk: {
          text: '两份来源的正文相同，但完整媒体集冲突时也必须拒绝猜测。',
          images: [{ original: 'https://images.zsxq.com/a.png' }],
        },
      },
      second: {
        talk: {
          text: '两份来源的正文相同，但完整媒体集冲突时也必须拒绝猜测。',
          images: [{ original: 'https://images.zsxq.com/b.png' }],
        },
      },
      third: {
        talk: {
          text: '两份来源的正文相同，但完整媒体集冲突时也必须拒绝猜测。',
          images: [{ original: 'https://images.zsxq.com/c.png' }],
        },
      },
    },
  ])('重放仍保留同 topic 的$label冲突见证', async ({ first, second, third }) => {
    const topicId = '513000000000000';
    let body: unknown = {
      succeeded: true,
      resp_data: { topics: [{ topic_id: topicId, ...first }] },
    };
    await loadInject(async () =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
    );
    await window.fetch('https://api.zsxq.com/v2/groups/1/topics');
    await vi.waitFor(() => expect(published).toHaveLength(1));

    body = {
      succeeded: true,
      resp_data: { topics: [{ topic_id: topicId, ...second }] },
    };
    await window.fetch('https://api.zsxq.com/v2/groups/1/topics');
    await vi.waitFor(() => expect(published).toHaveLength(2));

    body = {
      succeeded: true,
      resp_data: { topics: [{ topic_id: topicId, ...third }] },
    };
    await window.fetch('https://api.zsxq.com/v2/groups/1/topics');
    await vi.waitFor(() => expect(published).toHaveLength(3));

    const liveIndex = new TopicIndex();
    liveIndex.add(published.flatMap(message => message.records));
    expect(liveIndex.sourceBodyConflicted(topicId)).toBe(true);

    published.length = 0;
    requestReplay();
    await vi.waitFor(() => expect(published.length).toBeGreaterThan(0));
    const replayed = published.flatMap(message => message.records);
    const rebuiltIndex = new TopicIndex();
    rebuiltIndex.add(replayed);

    expect(replayed.filter(record => record.topicId === topicId)).toHaveLength(2);
    expect(rebuiltIndex.sourceBodyConflicted(topicId)).toBe(true);
  });

  it('重放不得用后续副本洗掉已观测的媒体不完整风险', async () => {
    const topicId = '514000000000000';
    const text = '正文始终相同，但第一份来源含有无法留存下载地址的 opaque 文件。';
    let body: unknown = {
      succeeded: true,
      resp_data: {
        topics: [{ topic_id: topicId, talk: { text, files: [{ name: 'opaque.pdf' }] } }],
      },
    };
    await loadInject(async () =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
    );
    await window.fetch('https://api.zsxq.com/v2/groups/1/topics');
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]?.records[0]?.sourceMediaProven).toBe(false);

    body = {
      succeeded: true,
      resp_data: { topics: [{ topic_id: topicId, talk: { text } }] },
    };
    await window.fetch('https://api.zsxq.com/v2/groups/1/topics');
    await vi.waitFor(() => expect(published).toHaveLength(2));

    published.length = 0;
    requestReplay();
    await vi.waitFor(() => expect(published.length).toBeGreaterThan(0));
    const replayed = published.flatMap(message => message.records);

    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({ topicId, sourceMediaProven: false });
  });

  it('留存库满后仍处理已留存 topic 的后续冲突证据', async () => {
    const topicId = '515000000000000';
    const firstText = '已在有界留存库里的第一份完整来源正文。';
    const secondText = '留存库即使已满，也必须看见同号后续冲突正文。';
    const body = {
      succeeded: true,
      resp_data: {
        topics: [
          { topic_id: '516000000000000', talk: { text: '超出留存上限的新 topic 可以跳过。' } },
          { topic_id: topicId, talk: { text: secondText } },
        ],
      },
    };
    await loadInject(async () =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
    );
    const retained = retainedRecords(
      (window as unknown as Record<string, unknown>)[TOPIC_STORE_KEY],
    ) as Map<string, TopicRecord>;
    retained.set(topicId, {
      topicId,
      text: firstText,
      fullTextTruncated: false,
      sourceBodyProven: true,
      sourceMediaProven: true,
    });
    for (let index = 0; retained.size < 800; index += 1) {
      const fillerId = String(600000000000000 + index);
      retained.set(fillerId, {
        topicId: fillerId,
        text: `留存上限占位记录 ${index}`,
        fullTextTruncated: false,
        sourceBodyProven: false,
        sourceMediaProven: false,
      });
    }

    await window.fetch('https://api.zsxq.com/v2/groups/1/topics');
    await vi.waitFor(() => expect(published).toHaveLength(1));
    published.length = 0;
    requestReplay();
    await vi.waitFor(() => expect(published.length).toBeGreaterThan(0));
    const replayed = published.flatMap(message => message.records);
    const rebuiltIndex = new TopicIndex();
    rebuiltIndex.add(replayed);

    expect(replayed.some(record => record.topicId === '516000000000000')).toBe(false);
    expect(replayed.filter(record => record.topicId === topicId)).toHaveLength(2);
    expect(rebuiltIndex.sourceBodyConflicted(topicId)).toBe(true);
  });

  it('两份长正文的对号文本都触及 2000 字时仍留真正更长的全文', async () => {
    const prefix = '这是同一条投资与企业经营长文的公共正文。'.repeat(150);
    const first = `${prefix}${'第一版尾部。'.repeat(80)}`;
    const second = `${first}${'第二版新增的完整尾部。'.repeat(120)}`;
    let body: unknown = {
      resp_data: { topics: [{ topic_id: 512000000000000, talk: { text: first } }] },
    };
    await loadInject(async () =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
    );
    await window.fetch('https://api.zsxq.com/v2/groups/1/topics');
    await vi.waitFor(() => expect(published).toHaveLength(1));

    body = { resp_data: { topics: [{ topic_id: 512000000000000, talk: { text: second } }] } };
    await window.fetch('https://api.zsxq.com/v2/groups/1/topics');
    await vi.waitFor(() => expect(published).toHaveLength(2));
    published.length = 0;
    requestReplay();
    await vi.waitFor(() => expect(published.length).toBeGreaterThan(0));

    const records = published.flatMap(message => message.records);
    expect(first.length).toBeGreaterThan(2_000);
    expect(records).toHaveLength(1);
    expect(records[0]?.fullText).toBe(second);
  });
});
