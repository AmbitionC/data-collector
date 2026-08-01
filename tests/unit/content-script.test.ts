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
    items: { key: string; title: string; document?: { canonicalUrl: string }; reason?: string }[];
    skipped: number;
    total: number;
    captured: number;
  };
}

interface AdvanceResponse {
  ok: true;
  advance: { collapsed: number; loaded: number; scroll?: string };
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

/**
 * 把假时钟推到某个 promise 落定为止。
 *
 * 拟人滚动的节奏是随机的（每轮 2–4 次滚动、每次间隔 450–1100ms，轮间还有 900–1800ms），
 * 三轮最坏要将近 19 秒。推一个固定时长（原先是 13 秒）必然偶发失败——实测已经飘红过一次。
 * 上限只是防死循环，正常路径远远推不到。
 */
async function settle<T>(pending: Promise<T>, limitMs = 60_000): Promise<T> {
  let done = false;
  const tracked = pending.then(
    value => { done = true; return value; },
    error => { done = true; throw error; },
  );
  for (let elapsed = 0; !done && elapsed < limitMs; elapsed += 500) {
    await vi.advanceTimersByTimeAsync(500);
  }
  return tracked;
}

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
    expect(response.list.items.flatMap(item => item.document?.canonicalUrl ?? [])).toEqual([
      'https://wx.zsxq.com/group/48844584441158/topic/511111111111111',
      'https://wx.zsxq.com/group/48844584441158/topic/522222222222222',
    ]);
    // 每条都带 key 和标题，侧栏明细列表点它能滚回页面上的那一条。
    expect(response.list.items.every(item => item.key && item.title)).toBe(true);
    expect(response.list.skipped).toBe(1);
    // 捕获到的帖子号条数要如实回报：为 0 时失败原因得说得具体。
    expect(response.list.captured).toBe(2);
    // DOM 节点无法跨消息边界传递，必须留在内容脚本里。
    expect(JSON.stringify(response.list)).not.toContain('topic-container');
  });

  it('reports zero captured topics when the app never answered an API call', async () => {
    const response = await ask<ListResponse>({ type: 'extract.list' });

    expect(response.list.captured).toBe(0);
    // 没有帖子号就一条都不入库，绝不用列表页地址凑数。
    expect(response.list.items.every(item => item.document === undefined)).toBe(true);
    expect(response.list.skipped).toBe(3);
  });

  it('marks handled posts without ever hiding them from the user', async () => {
    await ask<ListResponse>({ type: 'extract.list' });
    vi.useFakeTimers();

    const advance = settle(ask<AdvanceResponse>({ type: 'list.advance' }));

    expect((await advance).advance).toMatchObject({ collapsed: 3, loaded: 0 });
    const marked = [...document.querySelectorAll<HTMLElement>('.topic-container')].filter(
      node => node.hasAttribute('data-dc-collected'),
    );
    // 打标记是为了下一轮不重复提取；但**绝不能改变页面外观**——
    // 用户正在肉眼核对采到的内容对不对，把帖子藏起来是硬伤。
    expect(marked).toHaveLength(3);
    expect(marked.every(node => node.style.display === '')).toBe(true);
  });

  it('reports newly loaded posts so the batch keeps going', async () => {
    await ask<ListResponse>({ type: 'extract.list' });
    vi.useFakeTimers();

    const advance = ask<AdvanceResponse>({ type: 'list.advance' });
    // 懒加载在滚动之后补进来一条新帖子。
    const fresh = document.createElement('div');
    fresh.className = 'topic-container';
    document.querySelector('.main-content-container')!.append(fresh);
    // 滚动节奏是随机化的（拟人），推到它自己收工为止。
    expect((await settle(advance)).advance).toMatchObject({ loaded: 1 });
  });

  it('scrollIntoView 不生效时靠一屏一屏的补滚推进，不瞬移', async () => {
    // 有的环境里 scrollIntoView 只是把元素带进视口、甚至完全不动，
    // 这时靠补滚推进——但每次只补一屏，不一把跳到底。
    await ask<ListResponse>({ type: 'extract.list' });
    const host = document.querySelector<HTMLElement>('.main-content-container')!;
    let scrollTop = 0;
    const steps: number[] = [];
    Object.defineProperty(host, 'scrollHeight', { value: 10_000, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 800, configurable: true });
    Object.defineProperty(host, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { steps.push(value - scrollTop); scrollTop = value; },
    });

    vi.useFakeTimers();
    const advance = await settle(ask<AdvanceResponse>({ type: 'list.advance' }));

    expect(steps.length).toBeGreaterThan(1);
    // 每次补滚不超过一屏——不是「一步瞬移到底」那种机器动作。
    expect(steps.every(step => step > 0 && step <= 800)).toBe(true);
    // 滚动实况要能被观测到：只报「新增 0 条」时分不清是到底了还是压根没滚。
    expect(advance.advance.scroll).toContain('main-content-container');
    expect(advance.advance.scroll).toMatch(/位移 \d+px/);
  });

  it('几万像素高的页面也能到底：甩到末尾，而不是一格一格爬', async () => {
    // 40 条帖子的信息流有几万像素高。按半屏小步滚要几十步几十秒，
    // 实测只滚了一万多像素就收手，离底还远，懒加载自然不触发——
    // 用户看到「滚动到底也没有加载新内容」，而页面其实压根没到底。
    await ask<ListResponse>({ type: 'extract.list' });
    const host = document.querySelector<HTMLElement>('.main-content-container')!;
    let scrollTop = 0;
    const HEIGHT = 40_000;
    const VIEWPORT = 800;
    Object.defineProperty(host, 'scrollHeight', { value: HEIGHT, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: VIEWPORT, configurable: true });
    Object.defineProperty(host, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = Math.max(0, Math.min(value, HEIGHT - VIEWPORT)); },
    });
    // 真实浏览器里，把最后一条送进视野就等于滚到了内容末尾。
    const posts = [...document.querySelectorAll<HTMLElement>('.topic-container')];
    const focused: number[] = [];
    posts.forEach((node, index) => {
      node.scrollIntoView = () => {
        focused.push(index);
        if (index === posts.length - 1) scrollTop = HEIGHT - VIEWPORT;
      };
    });

    vi.useFakeTimers();
    const advance = await settle(ask<AdvanceResponse>({ type: 'list.advance' }));

    // 先回到上一批采到的最后一条（用户据此看到进度），再甩到内容末尾。
    expect(advance.advance.scroll).toContain('先回到上一批采到的最后一条');
    expect(focused).toContain(posts.length - 1);
    expect(scrollTop).toBe(HEIGHT - VIEWPORT);
    expect(advance.advance.scroll).toContain('已到底');
  });

  it('停在最后一条上，好让用户看到采到哪儿了', async () => {
    await ask<ListResponse>({ type: 'extract.list' });
    vi.useFakeTimers();
    await settle(ask<AdvanceResponse>({ type: 'list.advance' }));
    vi.useRealTimers();

    const marked = [...document.querySelectorAll<HTMLElement>('[data-dc-collected]')];
    const last = marked[marked.length - 1]!;
    let focused = false;
    last.scrollIntoView = () => { focused = true; };

    const response = await ask<{ ok: true; highlight: { found: boolean } }>({
      type: 'list.focusLast',
    });

    expect(response.highlight.found).toBe(true);
    expect(focused).toBe(true);
  });

  it('推不动任何元素时如实记下来，而不是假装滚过了', async () => {
    // 站点换了滚动实现、或候选都挑错时，必须留下证据——
    // 每一轮都是「新增待采 0 条」却看不出为什么，正是之前排查不动的原因。
    await ask<ListResponse>({ type: 'extract.list' });
    vi.useFakeTimers();

    const advance = await settle(ask<AdvanceResponse>({ type: 'list.advance' }));

    expect(advance.advance.scroll).toContain('位移 0px');
    expect(advance.advance.loaded).toBe(0);
  });

  it('skips posts that were handled in an earlier round', async () => {
    await ask<ListResponse>({ type: 'extract.list' });
    vi.useFakeTimers();
    await settle(ask<AdvanceResponse>({ type: 'list.advance' }));
    vi.useRealTimers();

    const second = await ask<ListResponse>({ type: 'extract.list' });

    expect(second.list.items).toEqual([]);
    expect(second.list.total).toBe(0);
  });

  it('clears the marks so a fresh batch sees the whole page again', async () => {
    await ask<ListResponse>({ type: 'extract.list' });
    vi.useFakeTimers();
    await settle(ask<AdvanceResponse>({ type: 'list.advance' }));
    vi.useRealTimers();
    expect(document.querySelectorAll('[data-dc-collected]')).toHaveLength(3);

    const restored = await ask<AdvanceResponse>({ type: 'list.restore' });

    expect(restored.advance.collapsed).toBe(3);
    expect(document.querySelectorAll('[data-dc-collected]')).toHaveLength(0);
    const second = await ask<ListResponse>({ type: 'extract.list' });
    expect(second.list.total).toBe(3);
  });

  it('scrolls to a post and outlines it when the side panel asks', async () => {
    const first = await ask<ListResponse>({ type: 'extract.list' });
    const key = first.list.items[0]!.key;
    const target = document.querySelector<HTMLElement>(`[data-dc-key="${key}"]`)!;
    let scrolled = false;
    target.scrollIntoView = () => { scrolled = true; };

    const response = await ask<{ ok: true; highlight: { found: boolean } }>({
      type: 'list.highlight',
      key,
    });

    expect(response.highlight.found).toBe(true);
    expect(scrolled).toBe(true);
    expect(target.classList.contains('data-collector-highlight')).toBe(true);

    // 找不到的 key 要如实说没找到，而不是假装成功。
    const missing = await ask<{ ok: true; highlight: { found: boolean } }>({
      type: 'list.highlight',
      key: 'nope',
    });
    expect(missing.highlight.found).toBe(false);
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
