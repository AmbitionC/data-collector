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

  it('refuses to save a list page as one document', async () => {
    const response = await ask<{ ok: false; error: { code: string; message: string } }>({
      type: 'extract.document',
    });

    expect(response.ok).toBe(false);
    expect(response.error.code).toBe('UNSUPPORTED_LAYOUT');
    expect(response.error.message).toContain('批量保存');
  });
});
