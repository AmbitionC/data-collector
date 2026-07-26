// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://wx.zsxq.com/group/48844584441158" }
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOPIC_MESSAGE } from '../../packages/extension/src/topicIndex.js';

type Listener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean;

interface ListResponse {
  ok: true;
  list: {
    documents: { canonicalUrl: string }[];
    skipped: number;
    total: number;
    captured: number;
  };
}

interface AdvanceResponse {
  ok: true;
  advance: { collapsed: number; loaded: number };
}

let listener: Listener;

async function loadContentScript(): Promise<void> {
  const listeners: Listener[] = [];
  vi.stubGlobal('chrome', {
    runtime: { onMessage: { addListener: (fn: Listener) => listeners.push(fn) } },
  });
  // 脚本用一个全局标记防止重复注册（补注入时同一页可能已经注入过）。
  // 浏览器里每次页面加载都是全新的隔离世界，这里要手动还原成那个前提。
  delete (globalThis as unknown as Record<string, unknown>).__dataCollectorContentReady;
  vi.resetModules();
  await import('../../packages/extension/src/content.js');
  listener = listeners[0]!;
}

function ask<T>(message: unknown): Promise<T> {
  return new Promise<T>(resolve => {
    listener(message, {}, response => resolve(response as T));
  });
}

/**
 * 模拟主世界脚本送来的帖子号（DOM 上没有帖子号，只能从应用自己的接口响应里取）。
 * 前两条能对上号，第三条对不上——对不上就如实跳过。
 */
async function feedTopics(): Promise<void> {
  // 内容脚本只认「来自本窗口」的消息（防止别的 iframe 伪造）。jsdom 的
  // window.postMessage 不会带上 source，这里直接派发一个带 source 的事件，
  // 以便按生产环境的真实前提测试，而不是为测试放宽生产代码的校验。
  window.dispatchEvent(
    new MessageEvent('message', {
      source: window,
      origin: window.location.origin,
      data: {
        source: TOPIC_MESSAGE,
        records: [
          { topicId: '511111111111111', text: '第一条帖子的正文内容，足够长以便通过长度校验判断。' },
          { topicId: '522222222222222', text: '第二条帖子的正文内容，同样足够长以便通过长度校验。' },
        ],
      },
    }),
  );
  await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(async () => {
  const html = await readFile(
    join(import.meta.dirname, '..', 'fixtures', 'zsxq-list.html'),
    'utf8',
  );
  document.body.innerHTML = new RegExp('<body>([\\s\\S]*)</body>').exec(html)![1]!;
  // jsdom 没有实现滚动，这里只关心「有没有被调用」以外的行为。
  window.scrollTo = () => undefined;
  await loadContentScript();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('content script list collection', () => {
  it('registers only one message listener even if injected twice', async () => {
    const listeners: Listener[] = [];
    vi.stubGlobal('chrome', {
      runtime: { onMessage: { addListener: (fn: Listener) => listeners.push(fn) } },
    });
    vi.resetModules();
    // 补注入时同一页可能已经声明式注入过：注册两个监听会对同一条消息应答两次。
    await import('../../packages/extension/src/content.js');
    expect(listeners).toHaveLength(0);
  });

  it('returns one document per post and keeps DOM nodes on this side of the message boundary', async () => {
    await feedTopics();

    const response = await ask<ListResponse>({ type: 'extract.list' });

    expect(response.ok).toBe(true);
    expect(response.list.documents.map(item => item.canonicalUrl)).toEqual([
      'https://wx.zsxq.com/group/48844584441158/topic/511111111111111',
      'https://wx.zsxq.com/group/48844584441158/topic/522222222222222',
    ]);
    expect(response.list.skipped).toBe(1);
    // 捕获到的帖子号条数要如实回报：为 0 时失败原因得说得具体。
    expect(response.list.captured).toBe(2);
    // DOM 节点无法跨消息边界传递，必须留在内容脚本里。
    expect(response.list).not.toHaveProperty('containers');
  });

  it('reports zero captured topics when the app never answered an API call', async () => {
    const response = await ask<ListResponse>({ type: 'extract.list' });

    expect(response.list.captured).toBe(0);
    // 没有帖子号就一条都不入库，绝不用列表页地址凑数。
    expect(response.list.documents).toEqual([]);
    expect(response.list.skipped).toBe(3);
  });

  it('collapses every post it has already handled so scrolling can load the next batch', async () => {
    await ask<ListResponse>({ type: 'extract.list' });
    vi.useFakeTimers();

    const advance = ask<AdvanceResponse>({ type: 'list.advance' });
    await vi.advanceTimersByTimeAsync(7_000);

    expect((await advance).advance).toEqual({ collapsed: 3, loaded: 0 });
    // 采到的和跳过的都要收起：跳过的留在页面上会被下一轮反复重新提取，批量永远推进不下去。
    const collapsed = [...document.querySelectorAll<HTMLElement>('.topic-container')].filter(
      node => node.hasAttribute('data-dc-collected'),
    );
    expect(collapsed).toHaveLength(3);
    expect(collapsed.every(node => node.style.display === 'none')).toBe(true);
  });

  it('reports newly loaded posts so the batch keeps going', async () => {
    await ask<ListResponse>({ type: 'extract.list' });
    vi.useFakeTimers();

    const advance = ask<AdvanceResponse>({ type: 'list.advance' });
    // 懒加载在滚动之后补进来一条新帖子。
    const fresh = document.createElement('div');
    fresh.className = 'topic-container';
    document.querySelector('.main-content-container')!.append(fresh);
    await vi.advanceTimersByTimeAsync(500);

    expect((await advance).advance).toMatchObject({ loaded: 1 });
  });

  it('skips posts that were collapsed in an earlier round', async () => {
    await ask<ListResponse>({ type: 'extract.list' });
    vi.useFakeTimers();
    const advance = ask<AdvanceResponse>({ type: 'list.advance' });
    await vi.advanceTimersByTimeAsync(7_000);
    await advance;
    vi.useRealTimers();

    const second = await ask<ListResponse>({ type: 'extract.list' });

    expect(second.list.documents).toEqual([]);
    expect(second.list.total).toBe(0);
  });

  it('puts every collapsed post back so the page never silently loses a screenful', async () => {
    await ask<ListResponse>({ type: 'extract.list' });
    vi.useFakeTimers();
    const advance = ask<AdvanceResponse>({ type: 'list.advance' });
    await vi.advanceTimersByTimeAsync(7_000);
    await advance;
    vi.useRealTimers();
    expect(document.querySelectorAll('[data-dc-collected]')).toHaveLength(3);

    const restored = await ask<AdvanceResponse>({ type: 'list.restore' });

    expect(restored.advance.collapsed).toBe(3);
    expect(document.querySelectorAll('[data-dc-collected]')).toHaveLength(0);
    // 还原后再提取，帖子重新可见可采。
    expect(
      [...document.querySelectorAll<HTMLElement>('.topic-container')]
        .every(node => node.style.display !== 'none'),
    ).toBe(true);
    const second = await ask<ListResponse>({ type: 'extract.list' });
    expect(second.list.total).toBe(3);
  });

  it('samples a live post for diagnostics, not one that was already collapsed', async () => {
    // 折叠过的节点框架可能已经回收内容，拿它取样会得出「页面里什么都没有」的错误结论。
    const first = document.querySelector<HTMLElement>('.topic-container')!;
    first.setAttribute('data-dc-collected', '1');
    first.style.display = 'none';

    const response = await ask<{ ok: true; diagnostics: string }>({ type: 'list.diagnose' });
    const sample = JSON.parse(response.diagnostics) as {
      sampledCollapsed: boolean;
      textSample: string;
      topicCount: number;
      htmlHead: string;
    };

    expect(sample.sampledCollapsed).toBe(false);
    // 第一个 .topic-container 是分类标签栏（app-menu），不是帖子。
    expect(sample.textSample).toContain('第一条帖子');
    expect(sample.topicCount).toBe(4);
    // 结构本身最能说明问题。
    expect(sample.htmlHead).toContain('topic-container');
  });

  it('reports how many topic ids were captured so a dry index is diagnosable', async () => {
    const before = JSON.parse(
      (await ask<{ ok: true; diagnostics: string }>({ type: 'list.diagnose' })).diagnostics,
    ) as { capturedTopics: number };
    expect(before.capturedTopics).toBe(0);

    await feedTopics();

    const after = JSON.parse(
      (await ask<{ ok: true; diagnostics: string }>({ type: 'list.diagnose' })).diagnostics,
    ) as { capturedTopics: number };
    expect(after.capturedTopics).toBe(2);
  });

  it('refuses to save a list page as one document', async () => {
    const response = await ask<{ ok: false; error: { code: string; message: string } }>({
      type: 'extract.document',
    });

    expect(response.ok).toBe(false);
    expect(response.error.code).toBe('UNSUPPORTED_LAYOUT');
    expect(response.error.message).toContain('批量保存');
  });
});
