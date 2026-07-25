// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://wx.zsxq.com/group/48844584441158" }
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean;

interface ListResponse {
  ok: true;
  list: { documents: { canonicalUrl: string }[]; skipped: number; total: number };
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
    const response = await ask<ListResponse>({ type: 'extract.list' });

    expect(response.ok).toBe(true);
    expect(response.list.documents.map(item => item.canonicalUrl)).toEqual([
      'https://wx.zsxq.com/group/48844584441158/topic/511111111111111',
      'https://wx.zsxq.com/group/48844584441158/topic/522222222222222',
    ]);
    expect(response.list.skipped).toBe(1);
    // DOM 节点无法跨消息边界传递，必须留在内容脚本里。
    expect(response.list).not.toHaveProperty('containers');
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
    expect(collapsed).toHaveLength(4);
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
    expect(document.querySelectorAll('[data-dc-collected]')).toHaveLength(4);

    const restored = await ask<AdvanceResponse>({ type: 'list.restore' });

    expect(restored.advance.collapsed).toBe(4);
    expect(document.querySelectorAll('[data-dc-collected]')).toHaveLength(0);
    // 还原后再提取，帖子重新可见可采。
    expect(
      [...document.querySelectorAll<HTMLElement>('.topic-container')]
        .every(node => node.style.display !== 'none'),
    ).toBe(true);
    const second = await ask<ListResponse>({ type: 'extract.list' });
    expect(second.list.total).toBe(4);
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
    expect(sample.textSample).toContain('第二条帖子');
    expect(sample.topicCount).toBe(4);
    // 结构本身最能说明问题。
    expect(sample.htmlHead).toContain('topic-container');
  });

  it('surfaces any long numeric attribute anywhere in the subtree as a topic-id candidate', async () => {
    const response = await ask<{ ok: true; diagnostics: string }>({ type: 'list.diagnose' });
    const sample = JSON.parse(response.diagnostics) as {
      longNumbers: { name: string; value: string }[];
    };

    // fixture 第二条把帖子号放在 data-topic-id 上；扫描不限定属性名。
    expect(sample.longNumbers.some(entry => entry.value.includes('522222222222222'))).toBe(true);
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
