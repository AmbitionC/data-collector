// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://wx.zsxq.com/group/48844584441158" }
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TOPIC_HOOK_VERSION,
  TOPIC_MESSAGE,
} from '../../packages/extension/src/topicIndex.js';
import {
  CONTENT_ADVANCE_REQUEST,
  CONTENT_BUILD_ID,
  CONTENT_DIAGNOSE_REQUEST,
  CONTENT_DOCUMENT_REQUEST,
  CONTENT_EXTRACTION_PROTOCOL,
  CONTENT_FOCUS_LAST_REQUEST,
  CONTENT_HIGHLIGHT_REQUEST,
  CONTENT_HOOK_STATS_REQUEST,
  CONTENT_ITEM_DIAGNOSE_REQUEST,
  CONTENT_LIST_REQUEST,
  CONTENT_REFRESH_TOPICS_REQUEST,
  CONTENT_RESTORE_REQUEST,
  CONTENT_SELECT_VIEW_REQUEST,
  contentRequestType,
} from '../../packages/extension/src/contentProtocol.js';

type Listener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean;

interface ListResponse {
  ok: true;
  list: {
    items: {
      key: string;
      observationId?: string;
      title: string;
      document?: {
        canonicalUrl: string;
        text?: string;
        truncated?: boolean;
        sourceMetadata?: Record<string, string | number | boolean | null>;
      };
      reason?: string;
    }[];
    skipped: number;
    total: number;
    captured: number;
  };
}

interface AdvanceResponse {
  ok: true;
  advance: { collapsed: number; loaded: number; uncertain?: boolean; scroll?: string };
}

interface ViewResponse {
  ok: true;
  selected: { label: '最新' | '精华' | '只看星主'; topicIds: string[] };
}

interface DocumentResponse {
  ok: true;
  document: {
    html: string;
    text: string;
    truncated?: boolean;
    sourceMetadata?: Record<string, string | number | boolean | null>;
  };
}

interface ExtractionErrorResponse {
  ok: false;
  error: { code: string; message: string };
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
        hookVersion: TOPIC_HOOK_VERSION,
        hookBuildId: '开发构建',
        records: [
          { topicId: '511111111111111', text: '第一条帖子的正文内容，足够长以便通过长度校验判断。', fullTextTruncated: false, sourceBodyProven: true, sourceMediaProven: true },
          { topicId: '522222222222222', text: '第二条帖子的正文内容，同样足够长以便通过长度校验。', fullTextTruncated: false, sourceBodyProven: true, sourceMediaProven: true },
        ],
      },
    }),
  );
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function feedEveryFixtureTopic(): Promise<void> {
  await feedTopics();
  window.dispatchEvent(
    new MessageEvent('message', {
      source: window,
      origin: window.location.origin,
      data: {
        source: TOPIC_MESSAGE,
        hookVersion: TOPIC_HOOK_VERSION,
        hookBuildId: '开发构建',
        records: [{
          topicId: '533333333333333',
          text: '第三条帖子的正文内容，同样足够长以便通过长度校验。',
          fullTextTruncated: false,
          sourceBodyProven: true,
          sourceMediaProven: true,
        }],
      },
    }),
  );
  await Promise.resolve();
}

async function feedExactDetailTopic(
  topicId: string,
  text: string,
  fullText = text,
  fullTextTruncated = false,
  sourceBodyProven = true,
  sourceMediaProven = sourceBodyProven,
): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', {
    source: window,
    origin: window.location.origin,
    data: {
      source: TOPIC_MESSAGE,
      hookVersion: TOPIC_HOOK_VERSION,
      hookBuildId: CONTENT_BUILD_ID,
      records: [{
        topicId,
        text,
        fullText,
        fullTextTruncated,
        sourceBodyProven,
        sourceMediaProven,
      }],
    },
  }));
  await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(async () => {
  history.replaceState({}, '', '/group/48844584441158');
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
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // document.body 这个元素**跨用例复用**（beforeEach 只换 innerHTML）。
  // 谁给它打了滚动相关的桩，不还原就会泄漏到后面的用例里，把别人的候选顺序搅乱。
  for (const property of ['scrollHeight', 'clientHeight', 'scrollTop']) {
    if (Object.getOwnPropertyDescriptor(document.body, property)) {
      delete (document.body as unknown as Record<string, unknown>)[property];
    }
  }
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

async function feedExpansionIdentity(topicId: string, text: string): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', {
    source: window,
    origin: window.location.origin,
    data: {
      source: TOPIC_MESSAGE,
      hookVersion: TOPIC_HOOK_VERSION,
      hookBuildId: CONTENT_BUILD_ID,
      records: [{
        topicId,
        text,
        fullTextTruncated: false,
        sourceBodyProven: false,
        sourceMediaProven: false,
      }],
    },
  }));
  // dispatchEvent 同步执行 TopicIndex 入库；只让出一个 microtask，不依赖真/假时钟。
  await Promise.resolve();
}

async function feedExpansionSource(
  topicId: string,
  text: string,
  sourceMediaProven: boolean,
): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', {
    source: window,
    origin: window.location.origin,
    data: {
      source: TOPIC_MESSAGE,
      hookVersion: TOPIC_HOOK_VERSION,
      hookBuildId: CONTENT_BUILD_ID,
      records: [{
        topicId,
        text,
        fullTextTruncated: false,
        sourceBodyProven: true,
        sourceMediaProven,
      }],
    },
  }));
  await Promise.resolve();
}

async function feedImageOnlyTopic(topicId: string, imageUrl: string, alt: string): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', {
    source: window,
    origin: window.location.origin,
    data: {
      source: TOPIC_MESSAGE,
      hookVersion: TOPIC_HOOK_VERSION,
      hookBuildId: CONTENT_BUILD_ID,
      records: [{
        topicId,
        text: '',
        fullTextTruncated: false,
        sourceBodyProven: true,
        sourceMediaProven: true,
        images: [{ url: imageUrl, alt }],
      }],
    },
  }));
  await Promise.resolve();
}

async function confirmPersistentExpansionFixture(topicId: string): Promise<{
  content: Element;
  expandedHtml: string;
  owner: Element;
  originalUrl: string;
}> {
  const preview = '这是用于验证展开证明生命周期的详情页首段。';
  const tail = '这是通过真实 DOM 增长和稳定窗口验证的完整尾段。'.repeat(8);
  history.replaceState({}, '', `/group/48844584441158/topic/${topicId}`);
  document.body.innerHTML = `
    <div class="topic-container" data-topic-id="${topicId}">
      <div class="talk-content-container"><div class="content">
        ${preview}<button class="showAll">展开全部</button>
      </div></div>
    </div>`;
  for (const element of document.querySelectorAll('*')) {
    Object.defineProperty(element, 'offsetHeight', { value: 20, configurable: true });
  }
  const owner = document.querySelector('.topic-container')!;
  const content = document.querySelector('.content')!;
  document.querySelector('.showAll')!.addEventListener('click', event => {
    (event.currentTarget as Element).remove();
    setTimeout(() => content.append(tail), 500);
  });
  await feedExpansionIdentity(topicId, `${preview}${tail}`);
  vi.useFakeTimers();

  const confirmed = await settle(ask<DocumentResponse>({ type: CONTENT_DOCUMENT_REQUEST }));
  expect(confirmed).toMatchObject({
    ok: true,
    document: {
      truncated: false,
      sourceMetadata: { expansionConfirmed: true },
    },
  });
  return {
    content,
    expandedHtml: content.innerHTML,
    owner,
    originalUrl: location.href,
  };
}

describe('content script list collection', () => {
  it('ignores another exact build request instead of letting an old listener answer first', () => {
    const sendResponse = vi.fn();
    const foreignRequest = contentRequestType(
      'list.advance',
      `${CONTENT_BUILD_ID}-foreign`,
    );

    expect(foreignRequest).not.toBe(CONTENT_ADVANCE_REQUEST);
    expect(listener({ type: foreignRequest }, {}, sendResponse)).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('attests every current extraction and control response, including errors', async () => {
    vi.useFakeTimers();
    const requests = [
      { type: CONTENT_DOCUMENT_REQUEST },
      { type: CONTENT_LIST_REQUEST },
      // 缺 label 刻意走 error 分支；错误响应也必须能证明来自当前 bundle。
      { type: CONTENT_SELECT_VIEW_REQUEST },
      { type: CONTENT_RESTORE_REQUEST },
      { type: CONTENT_ADVANCE_REQUEST },
      { type: CONTENT_REFRESH_TOPICS_REQUEST },
      { type: CONTENT_DIAGNOSE_REQUEST },
      { type: CONTENT_HIGHLIGHT_REQUEST, key: 'missing' },
      { type: CONTENT_ITEM_DIAGNOSE_REQUEST, key: 'missing' },
      { type: CONTENT_HOOK_STATS_REQUEST },
      { type: CONTENT_FOCUS_LAST_REQUEST },
    ];

    for (const request of requests) {
      const response = await settle(ask<Record<string, unknown>>(request));
      expect(response).toMatchObject({
        contentProtocol: CONTENT_EXTRACTION_PROTOCOL,
        contentBuildId: CONTENT_BUILD_ID,
      });
    }
  });

  it('keeps an observation id only while the exact DOM generation and semantic body stay unchanged', async () => {
    document.body.innerHTML = `
      <div class="main-content-container">
        <div class="topic-container" data-topic-id="699999999999991">
          <div class="author"><div class="role owner">陈老师</div></div>
          <div class="talk-content-container">这是第一版完整语义正文，长度足够用于建立稳定观察身份。</div>
        </div>
      </div>`;

    const first = await ask<ListResponse>({ type: CONTENT_LIST_REQUEST });
    const second = await ask<ListResponse>({ type: CONTENT_LIST_REQUEST });
    const firstObservation = first.list.items[0]?.observationId;
    expect(firstObservation).toBeTruthy();
    expect(second.list.items[0]?.observationId).toBe(firstObservation);

    const container = document.querySelector<HTMLElement>('.topic-container')!;
    container.querySelector('.talk-content-container')!.textContent =
      '同一个虚拟节点现在承载另一版正文，revision 必须变化，不能把两帖合并。';
    const changed = await ask<ListResponse>({ type: CONTENT_LIST_REQUEST });
    expect(changed.list.items[0]?.observationId).not.toBe(firstObservation);

    const replacement = container.cloneNode(true) as HTMLElement;
    container.replaceWith(replacement);
    const replaced = await ask<ListResponse>({ type: CONTENT_LIST_REQUEST });
    expect(replaced.list.items[0]?.key).toBe(changed.list.items[0]?.key);
    expect(replaced.list.items[0]?.observationId).not.toBe(changed.list.items[0]?.observationId);
  });

  it('selects an exact plan view and responds only after the active label and topic set change', async () => {
    const html = await readFile(join(import.meta.dirname, '..', 'fixtures', 'zsxq-three-views.html'), 'utf8');
    document.body.innerHTML = new RegExp('<body>([\\s\\S]*)</body>').exec(html)![1]!;
    const clicked: string[] = [];
    for (const item of document.querySelectorAll<HTMLElement>('.menu-container .item')) {
      item.addEventListener('click', () => {
        clicked.push((item.textContent ?? '').trim());
        setTimeout(() => {
          for (const candidate of document.querySelectorAll('.menu-container .item')) {
            candidate.classList.toggle('actived', candidate === item);
          }
          document.querySelector('#feed')!.innerHTML = `
            <div class="topic-container" data-topic-id="633333333333333">
              <div class="author"><div class="role owner">陈老师</div></div>
              <div class="talk-content-container">精华视图切换后的稳定帖子正文，长度足够采集。</div>
            </div>`;
        }, 120);
      });
    }
    vi.useFakeTimers();

    const pending = ask<ViewResponse>({ type: 'list.selectView', label: '精华' });
    await vi.advanceTimersByTimeAsync(100);
    let settledEarly = false;
    void pending.then(() => { settledEarly = true; });
    await Promise.resolve();
    expect(settledEarly).toBe(false);
    const response = await settle(pending);

    expect(clicked).toEqual(['精华']);
    expect(response.selected).toEqual({ label: '精华', topicIds: ['633333333333333'] });
  });

  it('waits through a full stability window after a view switch has updated the DOM', async () => {
    const html = await readFile(join(import.meta.dirname, '..', 'fixtures', 'zsxq-three-views.html'), 'utf8');
    document.body.innerHTML = new RegExp('<body>([\\s\\S]*)</body>').exec(html)![1]!;
    for (const item of document.querySelectorAll<HTMLElement>('.menu-container .item')) {
      item.addEventListener('click', () => {
        for (const candidate of document.querySelectorAll('.menu-container .item')) {
          candidate.classList.toggle('actived', candidate === item);
        }
        document.querySelector('#feed')!.innerHTML = `
          <div class="topic-container" data-topic-id="655555555555555">
            <div class="talk-content-container">后台标签切换后由 DOM 变化直接确认。</div>
          </div>`;
      });
    }
    vi.useFakeTimers();
    const response = await settle(ask<ViewResponse>({ type: 'list.selectView', label: '精华' }));

    expect(response.selected).toEqual({ label: '精华', topicIds: ['655555555555555'] });
  });

  it('recognizes a changed view when real topic DOM has no topic ids', async () => {
    const html = await readFile(join(import.meta.dirname, '..', 'fixtures', 'zsxq-three-views.html'), 'utf8');
    document.body.innerHTML = new RegExp('<body>([\\s\\S]*)</body>').exec(html)![1]!;
    for (const container of document.querySelectorAll<HTMLElement>('.topic-container')) {
      delete container.dataset.topicId;
    }
    for (const item of document.querySelectorAll<HTMLElement>('.menu-container .item')) {
      item.addEventListener('click', () => {
        for (const candidate of document.querySelectorAll('.menu-container .item')) {
          candidate.classList.toggle('actived', candidate === item);
        }
        document.querySelector('#feed')!.innerHTML = `
          <div class="topic-container">
            <div class="talk-content-container">真实页面没有帖子号，但精华正文已经换成另一批。</div>
          </div>`;
      });
    }
    vi.useFakeTimers();

    const response = await settle(ask<ViewResponse>({ type: 'list.selectView', label: '精华' }));

    expect(response.selected).toEqual({ label: '精华', topicIds: [] });
  });

  it('waits for the SPA menu to render before selecting the initial plan view', async () => {
    document.body.innerHTML = '<main id="app-shell"></main>';
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    setTimeout(() => {
      document.querySelector('#app-shell')!.innerHTML = `
        <app-menu>
          <div class="menu-container">
            <div class="item ng-star-inserted actived">最新</div>
            <div class="item ng-star-inserted">精华</div>
            <div class="item ng-star-inserted">只看星主</div>
          </div>
        </app-menu>
        <div class="topic-container" data-topic-id="644444444444444">
          <div class="talk-content-container">SPA 延迟渲染后的知识星球帖子。</div>
        </div>`;
    }, 300);

    const pending = ask<ViewResponse>({ type: 'list.selectView', label: '最新' });
    const response = await settle(pending);

    expect(response.selected).toEqual({ label: '最新', topicIds: ['644444444444444'] });
    expect(timeoutSpy.mock.calls.some(([, milliseconds]) => milliseconds === 10_000)).toBe(true);
  });

  it('does not accept an already-active view until its delayed topic body is stable', async () => {
    document.body.innerHTML = `
      <app-menu><div class="menu-container">
        <div class="item actived">最新</div>
        <div class="item">精华</div>
        <div class="item">只看星主</div>
      </div></app-menu>
      <div id="feed"></div>`;
    vi.useFakeTimers();
    setTimeout(() => {
      document.querySelector('#feed')!.innerHTML = `
        <div class="topic-container" data-topic-id="677777777777777">
          <div class="talk-content-container">四秒后才挂载、随后保持稳定的完整帖子正文。</div>
        </div>`;
    }, 4_000);

    const pending = ask<ViewResponse>({ type: 'list.selectView', label: '最新' });
    await vi.advanceTimersByTimeAsync(3_500);
    let settledEarly = false;
    void pending.then(() => { settledEarly = true; });
    await Promise.resolve();
    expect(settledEarly).toBe(false);

    const response = await settle(pending);

    expect(response.selected).toEqual({ label: '最新', topicIds: ['677777777777777'] });
  });

  it('keeps observing an active view when a late SPA tail arrives inside the stability window', async () => {
    document.body.innerHTML = `
      <app-menu><div class="menu-container">
        <div class="item actived">最新</div>
        <div class="item">精华</div>
        <div class="item">只看星主</div>
      </div></app-menu>
      <div class="topic-container" data-topic-id="688888888888888">
        <div class="talk-content-container">先渲染的正文开头。</div>
      </div>`;
    vi.useFakeTimers();

    const pending = ask<ViewResponse>({ type: 'list.selectView', label: '最新' });
    await vi.advanceTimersByTimeAsync(7_000);
    let settledEarly = false;
    void pending.then(() => { settledEarly = true; });
    await Promise.resolve();
    expect(settledEarly).toBe(false);

    document.querySelector('.talk-content-container')!.append(' 七秒后才补上的正文尾段。');
    const response = await settle(pending, 40_000);

    expect(response.selected).toEqual({ label: '最新', topicIds: ['688888888888888'] });
  });

  it('resets view stability when only text after the first 240 characters keeps growing', async () => {
    document.body.innerHTML = `
      <app-menu><div class="menu-container">
        <div class="item actived">最新</div>
        <div class="item">精华</div>
        <div class="item">只看星主</div>
      </div></app-menu>
      <div class="topic-container" data-topic-id="688888888888889">
        <div class="talk-content-container">${'首段正文'.repeat(80)}</div>
      </div>`;
    vi.useFakeTimers();

    const pending = ask<ViewResponse>({ type: 'list.selectView', label: '最新' });
    await vi.advanceTimersByTimeAsync(8_000);
    document.querySelector('.talk-content-container')!.append(' 八秒后继续增长的正文尾段。');
    await vi.advanceTimersByTimeAsync(7_000);
    document.querySelector('.talk-content-container')!.append(' 十五秒后仍在增长的最终结论。');
    await vi.advanceTimersByTimeAsync(10_000);
    let settledEarly = false;
    void pending.then(() => { settledEarly = true; });
    await Promise.resolve();
    expect(settledEarly).toBe(false);

    const response = await settle(pending, 40_000);
    expect(response.selected.topicIds).toEqual(['688888888888889']);
  });

  it('does not accept a view while any visible topic is still only a skeleton', async () => {
    document.body.innerHTML = `
      <app-menu><div class="menu-container">
        <div class="item actived">最新</div>
        <div class="item">精华</div>
        <div class="item">只看星主</div>
      </div></app-menu>
      <div class="topic-container" data-topic-id="699999999999991">
        <div class="talk-content-container">第一条已经渲染出足够长的帖子正文。</div>
      </div>
      <div class="topic-container" data-topic-id="699999999999992">
        <div class="loading-skeleton"></div>
      </div>`;
    vi.useFakeTimers();

    const pending = ask<ViewResponse>({ type: 'list.selectView', label: '最新' });
    await vi.advanceTimersByTimeAsync(9_000);
    let settledEarly = false;
    void pending.then(() => { settledEarly = true; });
    await Promise.resolve();
    expect(settledEarly).toBe(false);

    document.querySelector('.loading-skeleton')!.outerHTML =
      '<div class="talk-content-container">第二条稍后才渲染出的完整帖子正文。</div>';
    const response = await settle(pending, 40_000);

    expect(response.selected.topicIds).toEqual([
      '699999999999991',
      '699999999999992',
    ]);
  });

  it('never marks a skeleton as processed before its body can be retried', async () => {
    document.body.innerHTML = `
      <div class="topic-container" id="ready-topic" data-topic-id="699999999999993">
        <div class="talk-content-container">已经完整渲染、可以安全标记为处理过的帖子正文。</div>
      </div>
      <div class="topic-container" id="skeleton-topic">
        <div class="loading-skeleton"></div>
      </div>`;

    const extracted = await ask<ListResponse>({ type: 'extract.list' });
    expect(extracted.list.total).toBe(2);
    expect(extracted.list.items[1]?.reason).toContain('正文结构');

    const marked = await ask<AdvanceResponse>({ type: 'list.restore', mark: true });

    expect(marked.advance.collapsed).toBe(1);
    expect(document.querySelector('#ready-topic')?.getAttribute('data-dc-collected')).toBe('1');
    expect(document.querySelector('#skeleton-topic')?.hasAttribute('data-dc-collected')).toBe(false);
  });

  it('retries the same rendered topic when its API identity arrives after the first extraction', async () => {
    const body = '帖子正文已经渲染完成，但接口里的 topic id 会稍后才到达。';
    document.body.innerHTML = `
      <div class="topic-container" id="late-identity">
        <div class="talk-content-container">${body}</div>
      </div>`;

    const first = await ask<ListResponse>({ type: 'extract.list' });
    expect(first.list.items[0]?.document).toBeUndefined();
    const marked = await ask<AdvanceResponse>({ type: 'list.restore', mark: true });
    expect(marked.advance.collapsed).toBe(0);
    expect(document.querySelector('#late-identity')?.hasAttribute('data-dc-collected')).toBe(false);

    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: window.location.origin,
      data: {
        source: TOPIC_MESSAGE,
        hookVersion: TOPIC_HOOK_VERSION,
        hookBuildId: '开发构建',
        records: [{
          topicId: '699999999999994',
          text: body,
          fullTextTruncated: false,
          sourceBodyProven: true,
          sourceMediaProven: true,
        }],
      },
    }));
    await new Promise(resolve => setTimeout(resolve, 0));

    const retried = await ask<ListResponse>({ type: 'extract.list' });
    expect(retried.list.items[0]?.document?.canonicalUrl).toBe(
      'https://wx.zsxq.com/group/48844584441158/topic/699999999999994',
    );
  });

  it('丢弃同协议版本的旧构建消息，只接受当前精确构建', async () => {
    const body = '这条帖子的身份只能由当前构建的主世界钩子证明。';
    document.body.innerHTML = `
      <div class="topic-container">
        <div class="talk-content-container">${body}</div>
      </div>`;
    const publish = (hookBuildId: string, topicId: string) => {
      window.dispatchEvent(new MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
          source: TOPIC_MESSAGE,
          hookVersion: TOPIC_HOOK_VERSION,
          hookBuildId,
          records: [{
            topicId,
            text: body,
            fullTextTruncated: false,
            sourceBodyProven: true,
            sourceMediaProven: true,
          }],
        },
      }));
    };

    publish('v0.4.29 · stale-build', '688888888888881');
    await new Promise(resolve => setTimeout(resolve, 0));
    const stale = await ask<ListResponse>({ type: 'extract.list' });
    expect(stale.list.items[0]?.document).toBeUndefined();
    expect(stale.list.items[0]?.reason).toContain('编号没截到');

    publish('开发构建', '688888888888882');
    await new Promise(resolve => setTimeout(resolve, 0));
    const current = await ask<ListResponse>({ type: 'extract.list' });
    expect(current.list.items[0]?.document?.canonicalUrl).toContain('/topic/688888888888882');
  });

  it('统计请求与应答都绑定当前精确构建', async () => {
    const postMessage = vi.spyOn(window, 'postMessage');
    const response = ask<{ ok: true; hook: { buildId?: string } }>({ type: 'list.hookStats' });
    let settled = false;
    void response.then(() => { settled = true; });

    expect(postMessage).toHaveBeenCalledWith({
      source: 'data-collector:topics:stats?',
      hookVersion: TOPIC_HOOK_VERSION,
      hookBuildId: '开发构建',
    }, window.location.origin);

    const stats = (buildId: string) => ({
      version: TOPIC_HOOK_VERSION,
      buildId,
      installed: true,
      observed: 1,
      jsonResponses: 1,
      withTopicId: 1,
      publishedRecords: 1,
      recent: [],
    });
    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: window.location.origin,
      data: {
        source: 'data-collector:topics:stats',
        hookVersion: TOPIC_HOOK_VERSION,
        hookBuildId: 'v0.4.29 · stale-build',
        stats: stats('v0.4.29 · stale-build'),
      },
    }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: window.location.origin,
      data: {
        source: 'data-collector:topics:stats',
        hookVersion: TOPIC_HOOK_VERSION,
        hookBuildId: '开发构建',
        stats: stats('开发构建'),
      },
    }));

    await expect(response).resolves.toEqual({ ok: true, hook: expect.objectContaining({
      buildId: '开发构建',
    }) });
  });

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

  it('点得开真实站点那个 <p class="showAll"> 展开全部 </p>', async () => {
    // 站点上的真实结构（取自实机诊断）：控件是 <p class="showAll"> 展开全部 </p>，
    // 而 0.3.8 的候选选择器只有 button/a/span/div —— **p 不在里面**，
    // 点击逻辑压根没执行过，采到的一直是折叠的半篇。
    document.body.innerHTML = `
      <div class="topic-container">
        <div class="talk-content-container">
          <div class="content">第一条帖子的正文内容，足够长以便通过长度校验判断。</div>
          <p class="showAll"> 展开全部 </p>
        </div>
      </div>`;
    // jsdom 里 offsetParent 恒为 null、offsetHeight 恒为 0，可见性判断会把所有元素都跳过；
    // 真实浏览器里它们是可见的。不补这一步，测的就不是同一件事（这里真踩过一次）。
    for (const element of document.querySelectorAll('*')) {
      Object.defineProperty(element, 'offsetHeight', { value: 20, configurable: true });
    }
    const content = document.querySelector('.content') as HTMLElement;
    let expanded = false;
    (document.querySelector('.showAll') as HTMLElement).addEventListener('click', () => {
      expanded = !expanded;
      content.textContent = expanded
        ? '第一条帖子的正文内容，足够长以便通过长度校验判断。后半段在这里，只有展开后才看得到。'
        : '第一条帖子的正文内容，足够长以便通过长度校验判断。';
    });

    await feedTopics();
    // 展开后要等框架重渲染（内容脚本里是 600ms），用假时钟推过去。
    vi.useFakeTimers();
    await settle(ask<ListResponse>({ type: 'extract.list' }));

    expect(expanded).toBe(true);
    expect(content.textContent).toContain('只有展开后才看得到');
  });

  it('waits for delayed SPA expansion instead of reading after a fixed 350ms', async () => {
    history.replaceState({}, '', '/group/48844584441158/topic/599999999999999');
    document.body.innerHTML = `
      <div class="topic-container">
        <div class="author"><div class="info"><div class="role owner">陈老师</div></div></div>
        <div class="talk-content-container"><div class="content">
          这是足够长的投资复盘导语，点击以后正文尾部会由 SPA 延迟挂载。
          <button class="showAll">展开全部</button>
        </div></div>
      </div>`;
    for (const element of document.querySelectorAll('*')) {
      Object.defineProperty(element, 'offsetHeight', { value: 20, configurable: true });
    }
    const content = document.querySelector('.content')!;
    document.querySelector('.showAll')!.addEventListener('click', event => {
      (event.currentTarget as Element).remove();
      setTimeout(() => {
        content.append('这里是延迟一秒才真正挂载的完整正文尾部和最终结论。');
      }, 1_000);
    });
    await feedExactDetailTopic(
      '599999999999999',
      '这是足够长的投资复盘导语，点击以后正文尾部会由 SPA 延迟挂载。',
      '这是足够长的投资复盘导语，点击以后正文尾部会由 SPA 延迟挂载。'
        + '这里是延迟一秒才真正挂载的完整正文尾部和最终结论。',
    );
    vi.useFakeTimers();

    const response = await settle(ask<DocumentResponse>({ type: CONTENT_DOCUMENT_REQUEST }));

    expect(response.document.text).toContain('延迟一秒才真正挂载');
    expect(response.document.truncated).toBe(false);
  });

  it('accepts a current-build detail after independently confirmed expansion without API source proof', async () => {
    const topicId = '599999999999984';
    const preview = '这是详情页已经渲染的投资复盘首段，点击后会稳定挂载全部尾段。';
    const tail = '这是通过展开控件实际增长并稳定确认的完整正文尾部与最终结论。'.repeat(8);
    history.replaceState({}, '', `/group/48844584441158/topic/${topicId}`);
    document.body.innerHTML = `
      <div class="topic-container" data-topic-id="${topicId}">
        <div class="talk-content-container"><div class="content">
          ${preview}<button class="showAll">展开全部</button>
        </div></div>
      </div>`;
    for (const element of document.querySelectorAll('*')) {
      Object.defineProperty(element, 'offsetHeight', { value: 20, configurable: true });
    }
    const content = document.querySelector('.content')!;
    document.querySelector('.showAll')!.addEventListener('click', event => {
      (event.currentTarget as Element).remove();
      setTimeout(() => content.append(tail), 500);
    });
    await feedExpansionIdentity(topicId, `${preview}${tail}`);
    vi.useFakeTimers();

    const response = await settle(ask<DocumentResponse>({ type: CONTENT_DOCUMENT_REQUEST }));

    expect(response.document.text).toContain(tail);
    expect(response.document.truncated).toBe(false);
    expect(response.document.sourceMetadata?.expansionConfirmed).toBe(true);
  });

  it('keeps an independently confirmed expansion valid for the next current-build request', async () => {
    const topicId = '599999999999983';
    const preview = '这是详情页已经渲染的投资复盘首段，点击后会稳定挂载全部尾段。';
    const tail = '这是已经通过真实 DOM 增长证明完整的正文尾部与最终结论。'.repeat(8);
    history.replaceState({}, '', `/group/48844584441158/topic/${topicId}`);
    document.body.innerHTML = `
      <div class="topic-container" data-topic-id="${topicId}">
        <div class="talk-content-container"><div class="content">
          ${preview}<button class="showAll">展开全部</button>
        </div></div>
      </div>`;
    for (const element of document.querySelectorAll('*')) {
      Object.defineProperty(element, 'offsetHeight', { value: 20, configurable: true });
    }
    const content = document.querySelector('.content')!;
    document.querySelector('.showAll')!.addEventListener('click', event => {
      (event.currentTarget as Element).remove();
      setTimeout(() => content.append(tail), 500);
    });
    await feedExpansionIdentity(topicId, `${preview}${tail}`);
    vi.useFakeTimers();

    const first = await settle(ask<DocumentResponse>({ type: CONTENT_DOCUMENT_REQUEST }));
    const laterSamples: DocumentResponse[] = [];
    for (let sample = 0; sample < 11; sample += 1) {
      laterSamples.push(await settle(ask<DocumentResponse>({ type: CONTENT_DOCUMENT_REQUEST })));
    }

    expect(first.document.truncated).toBe(false);
    expect(laterSamples).toHaveLength(11);
    for (const sample of laterSamples) {
      expect(sample).toMatchObject({
        ok: true,
        document: {
          truncated: false,
          sourceMetadata: { expansionConfirmed: true },
        },
      });
      expect(sample.document.text).toContain(tail);
    }
  });

  it('binds expansion proof to the semantic detail owner instead of a preceding menu container', async () => {
    const topicId = '599999999999976';
    const preview = '这是实际详情帖的稳定首段，页面前面还有同名菜单容器。';
    const tail = '这是真实展开后稳定挂载的完整正文尾段。'.repeat(8);
    history.replaceState({}, '', `/group/48844584441158/topic/${topicId}`);
    document.body.innerHTML = `
      <nav class="topic-container"><span>菜单里的话题入口</span></nav>
      <main class="topic-container" data-topic-id="${topicId}">
        <div class="talk-content-container"><div class="content">
          ${preview}<button class="showAll">展开全部</button>
        </div></div>
      </main>`;
    for (const element of document.querySelectorAll('*')) {
      Object.defineProperty(element, 'offsetHeight', { value: 20, configurable: true });
    }
    const content = document.querySelector('main .content')!;
    document.querySelector('main .showAll')!.addEventListener('click', event => {
      (event.currentTarget as Element).remove();
      setTimeout(() => content.append(tail), 500);
    });
    await feedExpansionIdentity(topicId, `${preview}${tail}`);
    vi.useFakeTimers();

    const first = await settle(ask<DocumentResponse | ExtractionErrorResponse>({
      type: CONTENT_DOCUMENT_REQUEST,
    }));
    const second = await settle(ask<DocumentResponse | ExtractionErrorResponse>({
      type: CONTENT_DOCUMENT_REQUEST,
    }));

    expect(first).toMatchObject({ ok: true, document: { truncated: false } });
    expect('document' in first ? first.document.text : '').toContain(tail);
    expect(second).toMatchObject({
      ok: true,
      document: {
        truncated: false,
        sourceMetadata: { expansionConfirmed: true },
      },
    });
  });

  it('does not certify stale unmarked A as URL topic B after expanding A', async () => {
    const staleTopicId = '599999999999975';
    const targetTopicId = '599999999999974';
    const preview = '这是旧帖 A 仍然留在 SPA 详情容器里的投资复盘首段。';
    const tail = '这是点开后才挂载的旧帖 A 完整尾段，绝不能归给 URL 中的 B。'.repeat(8);
    history.replaceState({}, '', `/group/48844584441158/topic/${targetTopicId}`);
    document.body.innerHTML = `
      <div class="topic-container">
        <div class="talk-content-container"><div class="content">
          ${preview}<button class="showAll">展开全部</button>
        </div></div>
      </div>`;
    for (const element of document.querySelectorAll('*')) {
      Object.defineProperty(element, 'offsetHeight', { value: 20, configurable: true });
    }
    const content = document.querySelector('.content')!;
    document.querySelector('.showAll')!.addEventListener('click', event => {
      (event.currentTarget as Element).remove();
      setTimeout(() => content.append(tail), 500);
    });
    await feedExpansionIdentity(staleTopicId, `${preview}${tail}`);
    vi.useFakeTimers();

    const response = await settle(ask<DocumentResponse | ExtractionErrorResponse>({
      type: CONTENT_DOCUMENT_REQUEST,
    }));

    expect(response).toMatchObject({ ok: false, error: { code: 'CONTENT_EMPTY' } });
  });

  it('does not certify body A when the root topic id switches to B before the body', async () => {
    const staleTopicId = '599999999999973';
    const targetTopicId = '599999999999972';
    const preview = '这是虚拟详情节点仍然渲染的旧帖 A 正文首段。';
    const tail = '这是旧帖 A 展开后的完整尾段，根节点的帖子号却已经先切成 B。'.repeat(8);
    history.replaceState({}, '', `/group/48844584441158/topic/${targetTopicId}`);
    document.body.innerHTML = `
      <div class="topic-container" data-topic-id="${targetTopicId}">
        <div class="talk-content-container"><div class="content">
          ${preview}<button class="showAll">展开全部</button>
        </div></div>
      </div>`;
    for (const element of document.querySelectorAll('*')) {
      Object.defineProperty(element, 'offsetHeight', { value: 20, configurable: true });
    }
    const content = document.querySelector('.content')!;
    document.querySelector('.showAll')!.addEventListener('click', event => {
      (event.currentTarget as Element).remove();
      setTimeout(() => content.append(tail), 500);
    });
    await feedExpansionIdentity(staleTopicId, `${preview}${tail}`);
    vi.useFakeTimers();

    const response = await settle(ask<DocumentResponse | ExtractionErrorResponse>({
      type: CONTENT_DOCUMENT_REQUEST,
    }));

    expect(response).toMatchObject({ ok: false, error: { code: 'CONTENT_EMPTY' } });
  });

  it('does not let confirmed text expansion clear unknown opaque source media', async () => {
    const topicId = '599999999999971';
    const preview = '这是已知存在 opaque 媒体组件的详情帖文字首段。';
    const tail = '这是点击后已经稳定挂载的全部文字尾段，但媒体仍无法证明完整。'.repeat(8);
    history.replaceState({}, '', `/group/48844584441158/topic/${topicId}`);
    document.body.innerHTML = `
      <div class="topic-container" data-topic-id="${topicId}">
        <div class="talk-content-container"><div class="content">
          ${preview}<button class="showAll">展开全部</button>
        </div></div>
      </div>`;
    for (const element of document.querySelectorAll('*')) {
      Object.defineProperty(element, 'offsetHeight', { value: 20, configurable: true });
    }
    const content = document.querySelector('.content')!;
    document.querySelector('.showAll')!.addEventListener('click', event => {
      (event.currentTarget as Element).remove();
      setTimeout(() => content.append(tail), 500);
    });
    await feedExpansionSource(topicId, `${preview}${tail}`, false);
    vi.useFakeTimers();

    const first = await settle(ask<DocumentResponse>({ type: CONTENT_DOCUMENT_REQUEST }));
    const second = await settle(ask<DocumentResponse>({ type: CONTENT_DOCUMENT_REQUEST }));

    for (const response of [first, second]) {
      expect(response.document.truncated).toBeUndefined();
      expect(response.document.sourceMetadata?.sourceMediaProven).toBe(false);
      expect(response.document.sourceMetadata).not.toHaveProperty('expansionConfirmed');
    }
  });

  it('invalidates a persisted text expansion when a later source media revision is opaque', async () => {
    const topicId = '599999999999970';
    const fixture = await confirmPersistentExpansionFixture(topicId);
    const expandedText = fixture.content.textContent?.replace(/\s+/gu, ' ').trim() ?? '';
    await feedExpansionSource(topicId, expandedText, false);

    const response = await settle(ask<DocumentResponse>({ type: CONTENT_DOCUMENT_REQUEST }));

    expect(response.document.truncated).toBeUndefined();
    expect(response.document.sourceMetadata?.sourceMediaProven).toBe(false);
    expect(response.document.sourceMetadata).not.toHaveProperty('expansionConfirmed');
  });

  it('does not resurrect a text expansion proof after the DOM media revision changes', async () => {
    const fixture = await confirmPersistentExpansionFixture('599999999999969');
    const lateImage = document.createElement('img');
    lateImage.src = 'https://images.example/late-media-revision.png';
    fixture.content.append(lateImage);

    const changed = await settle(ask<DocumentResponse | ExtractionErrorResponse>({
      type: CONTENT_DOCUMENT_REQUEST,
    }));
    lateImage.remove();
    const restored = await settle(ask<DocumentResponse | ExtractionErrorResponse>({
      type: CONTENT_DOCUMENT_REQUEST,
    }));

    expect(changed).toMatchObject({ ok: false, error: { code: 'CONTENT_EMPTY' } });
    expect(restored).toMatchObject({ ok: false, error: { code: 'CONTENT_EMPTY' } });
  });

  it('keeps a shared owner unknown unless every expand probe is confirmed', async () => {
    const topicId = '599999999999968';
    const firstPreview = '这是同一帖子里第一个可展开正文块的稳定首段。';
    const firstTail = '这是第一个正文块已稳定增长的完整尾段。'.repeat(6);
    const secondPreview = '这是同一帖子里第二个正文块，控件只消失但正文没有增长。';
    history.replaceState({}, '', `/group/48844584441158/topic/${topicId}`);
    document.body.innerHTML = `
      <div class="topic-container" data-topic-id="${topicId}">
        <div class="talk-content-container"><div class="first-content">
          ${firstPreview}<button class="showAll first-control">展开全部</button>
        </div></div>
        <div class="answer-content-container"><div class="second-content">
          ${secondPreview}<button class="showAll second-control">展开全部</button>
        </div></div>
      </div>`;
    for (const element of document.querySelectorAll('*')) {
      Object.defineProperty(element, 'offsetHeight', { value: 20, configurable: true });
    }
    const firstContent = document.querySelector('.first-content')!;
    document.querySelector('.first-control')!.addEventListener('click', event => {
      (event.currentTarget as Element).remove();
      setTimeout(() => firstContent.append(firstTail), 500);
    });
    document.querySelector('.second-control')!.addEventListener('click', event => {
      (event.currentTarget as Element).remove();
    });
    await feedExpansionIdentity(topicId, `${firstPreview}${firstTail}${secondPreview}`);
    vi.useFakeTimers();

    const first = await settle(ask<DocumentResponse>({ type: 'extract.document' }));
    const second = await settle(ask<DocumentResponse>({ type: 'extract.document' }));

    expect(first.document.truncated).toBeUndefined();
    expect(first.document.sourceMetadata?.expansionUnconfirmed).toBe(true);
    expect(second.document.truncated).toBeUndefined();
    expect(second.document.sourceMetadata).not.toHaveProperty('expansionConfirmed');
  });

  it('marks an image-only item and clears the binding when its semantic asset is reused', async () => {
    const firstTopicId = '599999999999967';
    const secondTopicId = '599999999999966';
    const firstImage = 'https://images.example/image-only-first.png';
    const secondImage = 'https://images.example/image-only-second.png';
    document.body.innerHTML = `
      <div class="main-content-container">
        <div class="topic-container" id="image-only-reused">
          <div class="talk-content-container"><img src="${firstImage}"></div>
        </div>
      </div>`;
    await feedImageOnlyTopic(firstTopicId, firstImage, '第一条纯图片内容');

    const first = await ask<ListResponse>({ type: CONTENT_LIST_REQUEST });
    expect(first.list.items[0]?.document?.canonicalUrl).toContain(`/topic/${firstTopicId}`);
    const marked = await ask<AdvanceResponse>({ type: CONTENT_RESTORE_REQUEST, mark: true });
    expect(marked.advance.collapsed).toBe(1);
    expect(document.querySelector('#image-only-reused')?.hasAttribute('data-dc-collected')).toBe(true);

    const image = document.querySelector<HTMLImageElement>('#image-only-reused img')!;
    image.src = secondImage;
    await feedImageOnlyTopic(secondTopicId, secondImage, '第二条纯图片内容');
    const reused = await ask<ListResponse>({ type: CONTENT_LIST_REQUEST });

    expect(document.querySelector('#image-only-reused')?.hasAttribute('data-dc-collected')).toBe(false);
    expect(reused.list.items[0]?.document?.canonicalUrl).toContain(`/topic/${secondTopicId}`);
  });

  it('never reuses a persisted expansion proof after the topic source body conflicts', async () => {
    const topicId = '599999999999965';
    const fixture = await confirmPersistentExpansionFixture(topicId);
    const expandedText = fixture.content.textContent?.replace(/\s+/gu, ' ').trim() ?? '';
    await feedExpansionSource(topicId, expandedText, true);
    await feedExpansionSource(
      topicId,
      '同一帖子号后到了一份互不兼容的来源正文与媒体版本。'.repeat(8),
      true,
    );

    const conflicted = await settle(ask<DocumentResponse | ExtractionErrorResponse>({
      type: CONTENT_DOCUMENT_REQUEST,
    }));

    expect(conflicted).toMatchObject({ ok: false, error: { code: 'CONTENT_EMPTY' } });
  });

  it('invalidates an expansion proof permanently when the current URL changes', async () => {
    const fixture = await confirmPersistentExpansionFixture('599999999999982');
    history.replaceState({}, '', `${location.pathname}?view=changed`);

    const changed = await settle(ask<DocumentResponse | ExtractionErrorResponse>({
      type: CONTENT_DOCUMENT_REQUEST,
    }));
    history.replaceState({}, '', fixture.originalUrl);
    const restored = await settle(ask<DocumentResponse | ExtractionErrorResponse>({
      type: CONTENT_DOCUMENT_REQUEST,
    }));

    expect(changed).toMatchObject({ ok: false, error: { code: 'CONTENT_EMPTY' } });
    expect(restored).toMatchObject({ ok: false, error: { code: 'CONTENT_EMPTY' } });
  });

  it('does not resurrect an expansion proof after its owner topic changes and changes back', async () => {
    const topicId = '599999999999981';
    const fixture = await confirmPersistentExpansionFixture(topicId);
    fixture.owner.setAttribute('data-topic-id', '599999999999980');

    const changed = await settle(ask<DocumentResponse | ExtractionErrorResponse>({
      type: CONTENT_DOCUMENT_REQUEST,
    }));
    fixture.owner.setAttribute('data-topic-id', topicId);
    const restored = await settle(ask<DocumentResponse | ExtractionErrorResponse>({
      type: CONTENT_DOCUMENT_REQUEST,
    }));

    expect(changed).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_LAYOUT' } });
    expect(restored).toMatchObject({ ok: false, error: { code: 'CONTENT_EMPTY' } });
  });

  it('does not resurrect an expansion proof after the semantic body revision changes and changes back', async () => {
    const fixture = await confirmPersistentExpansionFixture('599999999999979');
    fixture.content.append('这是 SPA 后续覆盖的新正文修订。');

    const changed = await settle(ask<DocumentResponse | ExtractionErrorResponse>({
      type: CONTENT_DOCUMENT_REQUEST,
    }));
    fixture.content.innerHTML = fixture.expandedHtml;
    const restored = await settle(ask<DocumentResponse | ExtractionErrorResponse>({
      type: CONTENT_DOCUMENT_REQUEST,
    }));

    expect(changed).toMatchObject({ ok: false, error: { code: 'CONTENT_EMPTY' } });
    expect(restored).toMatchObject({ ok: false, error: { code: 'CONTENT_EMPTY' } });
  });

  it('invalidates an expansion proof when its owner disconnects even if that same node is reattached', async () => {
    const fixture = await confirmPersistentExpansionFixture('599999999999978');
    const replacement = fixture.owner.cloneNode(true) as Element;
    fixture.owner.replaceWith(replacement);

    const disconnected = await settle(ask<DocumentResponse | ExtractionErrorResponse>({
      type: CONTENT_DOCUMENT_REQUEST,
    }));
    replacement.replaceWith(fixture.owner);
    const reattached = await settle(ask<DocumentResponse | ExtractionErrorResponse>({
      type: CONTENT_DOCUMENT_REQUEST,
    }));

    expect(disconnected).toMatchObject({ ok: false, error: { code: 'CONTENT_EMPTY' } });
    expect(reattached).toMatchObject({ ok: false, error: { code: 'CONTENT_EMPTY' } });
  });

  it('invalidates an expansion proof when a fold control reappears', async () => {
    const fixture = await confirmPersistentExpansionFixture('599999999999977');
    const control = document.createElement('button');
    control.className = 'showAll';
    control.textContent = '展开全部';
    Object.defineProperty(control, 'offsetHeight', { value: 20, configurable: true });
    control.addEventListener('click', () => control.remove());
    fixture.content.append(control);

    const reappeared = await settle(ask<DocumentResponse | ExtractionErrorResponse>({
      type: 'extract.document',
    }));
    const afterward = await settle(ask<DocumentResponse | ExtractionErrorResponse>({
      type: CONTENT_DOCUMENT_REQUEST,
    }));

    expect(reappeared).toMatchObject({
      ok: true,
      document: {
        sourceMetadata: { expansionUnconfirmed: true },
      },
    });
    expect('document' in reappeared ? reappeared.document.truncated : true).toBeUndefined();
    expect(afterward).toMatchObject({ ok: false, error: { code: 'CONTENT_EMPTY' } });
  });

  it('uses the exact topic API full text on a detail page even when the stable DOM has no expand control', async () => {
    const topicId = '599999999999998';
    const preview = '这是详情页已经稳定渲染的投资复盘首段，但页面没有展示任何展开按钮。';
    const apiTail = '这是接口已经返回、而 DOM 永远没有挂载的完整正文尾段与最终经营结论。'.repeat(8);
    const articleUrl = 'https://articles.zsxq.com/id_ApiDetail123.html';
    history.replaceState({}, '', `/group/48844584441158/topic/${topicId}`);
    document.body.innerHTML = `
      <div class="topic-container" data-topic-id="${topicId}">
        <div class="author"><div class="info"><div class="role owner">陈老师</div></div></div>
        <div class="talk-content-container"><div class="content">${preview}</div></div>
      </div>`;
    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: window.location.origin,
      data: {
        source: TOPIC_MESSAGE,
        hookVersion: TOPIC_HOOK_VERSION,
        hookBuildId: CONTENT_BUILD_ID,
        records: [{
          topicId,
          text: preview,
          fullText: `${preview}${apiTail}\n<e type="web" href="${encodeURIComponent(articleUrl)}" title="%E5%85%A8%E6%96%87" />`,
          fullTextTruncated: false,
          sourceBodyProven: true,
          sourceMediaProven: true,
        }],
      },
    }));

    const response = await ask<DocumentResponse>({ type: CONTENT_DOCUMENT_REQUEST });

    expect(response.document.text).toContain(apiTail);
    expect(response.document.html).toContain(articleUrl);
    expect(response.document.truncated).toBe(false);
  });

  it('keeps exact source-proven API completion when a detail expand click produces no DOM growth', async () => {
    const topicId = '599999999999992';
    const preview = '这是详情页折叠的投资复盘导语，展开按钮点击后没有产生任何 DOM 增长。';
    const apiTail = '这是已知正文端点直接返回的完整尾段与最终经营结论。'.repeat(12);
    history.replaceState({}, '', `/group/48844584441158/topic/${topicId}`);
    document.body.innerHTML = `
      <div class="topic-container" data-topic-id="${topicId}">
        <div class="author"><div class="info"><div class="role owner">陈老师</div></div></div>
        <div class="talk-content-container"><div class="content">
          ${preview}<button class="showAll">展开全部</button>
        </div></div>
      </div>`;
    for (const element of document.querySelectorAll('*')) {
      Object.defineProperty(element, 'offsetHeight', { value: 20, configurable: true });
    }
    document.querySelector('.showAll')!.addEventListener('click', event => {
      (event.currentTarget as Element).remove();
    });
    await feedExactDetailTopic(topicId, preview, `${preview}${apiTail}`, false, true);
    vi.useFakeTimers();

    const response = await settle(ask<DocumentResponse>({ type: CONTENT_DOCUMENT_REQUEST }));

    expect(response.document.text).toContain(apiTail);
    expect(response.document.truncated).toBe(false);
    expect(response.document.sourceMetadata?.sourceBodyProven).toBe(true);
  });

  it('does not accept a same-id title or summary record as current-build detail body proof', async () => {
    const topicId = '599999999999991';
    const preview = '旧标签页稳定留下来的首段恰好等于摘要，但摘要并不能证明后文不存在。';
    history.replaceState({}, '', `/group/48844584441158/topic/${topicId}`);
    document.body.innerHTML = `
      <div class="topic-container" data-topic-id="${topicId}">
        <div class="author"><div class="info"><div class="role owner">陈老师</div></div></div>
        <div class="talk-content-container"><div class="content">${preview}</div></div>
      </div>`;
    await feedExactDetailTopic(topicId, preview, preview, false, false);

    const response = await ask<{
      ok: false;
      error: { code: string; message: string };
    }>({ type: CONTENT_DOCUMENT_REQUEST });

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'CONTENT_EMPTY', message: expect.stringContaining('正文来源') },
    });
  });

  it('keeps exact source-proven API completion for a list item after its expand click stalls', async () => {
    const topicId = '599999999999990';
    const preview = '这是列表页折叠的投资创业导语，按钮点击失败但接口已经给出全量正文。';
    const apiTail = '这是列表帖子已证明的完整尾段和最终结论。'.repeat(12);
    document.body.innerHTML = `
      <div class="topic-container" data-topic-id="${topicId}">
        <div class="author"><div class="info"><div class="role owner">陈老师</div></div></div>
        <div class="talk-content-container"><div class="content">
          ${preview}<button class="showAll">展开全部</button>
        </div></div>
      </div>`;
    for (const element of document.querySelectorAll('*')) {
      Object.defineProperty(element, 'offsetHeight', { value: 20, configurable: true });
    }
    document.querySelector('.showAll')!.addEventListener('click', event => {
      (event.currentTarget as Element).remove();
    });
    await feedExactDetailTopic(topicId, preview, `${preview}${apiTail}`, false, true);
    vi.useFakeTimers();

    const response = await settle(ask<ListResponse>({ type: CONTENT_LIST_REQUEST }));
    const item = response.list.items.find(candidate => candidate.document?.canonicalUrl.endsWith(topicId));

    expect(item?.document?.text).toContain(apiTail);
    expect(item?.document?.truncated).toBe(false);
    expect(item?.document?.sourceMetadata?.sourceBodyProven).toBe(true);
  });

  it('preserves an exact API article href when the detail DOM renders only equal visible card text', async () => {
    const topicId = '599999999999993';
    const intro = '这是一段投资创业长文导语。';
    const articleTitle = '经营现金流完整复盘';
    const articleUrl = 'https://articles.zsxq.com/id_EqualDetail123.html';
    history.replaceState({}, '', `/group/48844584441158/topic/${topicId}`);
    document.body.innerHTML = `
      <div class="topic-container" data-topic-id="${topicId}">
        <div class="author"><div class="info"><div class="role owner">陈老师</div></div></div>
        <div class="talk-content-container"><div class="content">
          <p>${intro}</p><div class="web-card">${articleTitle}</div>
        </div></div>
      </div>`;
    await feedExactDetailTopic(
      topicId,
      `${intro}${articleTitle}`,
      `${intro}\n<e type="web" href="${encodeURIComponent(articleUrl)}" title="${encodeURIComponent(articleTitle)}" />`,
    );

    const response = await ask<DocumentResponse>({ type: CONTENT_DOCUMENT_REQUEST });

    expect(response.document.html).toContain(articleUrl);
    expect(response.document.text.replace(/\s+/gu, '')).toBe(`${intro}${articleTitle}`);
    expect(response.document.truncated).toBe(false);
  });

  it('keeps an exact detail API truncation signal sticky after using its richer text', async () => {
    const topicId = '599999999999997';
    const preview = '这是没有展开控件的详情首段，但接口留存本身已经触及全文上限。';
    const apiTail = '接口虽返回了更长正文，仍不能证明上限之后没有遗漏。'.repeat(8);
    history.replaceState({}, '', `/group/48844584441158/topic/${topicId}`);
    document.body.innerHTML = `
      <div class="topic-container" data-topic-id="${topicId}">
        <div class="author"><div class="info"><div class="role owner">陈老师</div></div></div>
        <div class="talk-content-container"><div class="content">${preview}</div></div>
      </div>`;
    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: window.location.origin,
      data: {
        source: TOPIC_MESSAGE,
        hookVersion: TOPIC_HOOK_VERSION,
        hookBuildId: CONTENT_BUILD_ID,
        records: [{
          topicId,
          text: preview,
          fullText: `${preview}${apiTail}`,
          fullTextTruncated: true,
          sourceBodyProven: true,
          sourceMediaProven: true,
        }],
      },
    }));

    const response = await ask<DocumentResponse>({ type: CONTENT_DOCUMENT_REQUEST });

    expect(response.document.text).toContain(apiTail);
    expect(response.document.truncated).toBe(true);
  });

  it('never merges detail API full text whose topic id differs from the URL target', async () => {
    const targetTopicId = '599999999999996';
    const otherTopicId = '599999999999995';
    const preview = '目标详情页只有这一段自己的正文，长度足够且没有展开控件。';
    const otherTail = '这是另一篇帖子的接口正文，绝不能串入目标详情。'.repeat(8);
    history.replaceState({}, '', `/group/48844584441158/topic/${targetTopicId}`);
    document.body.innerHTML = `
      <div class="topic-container" data-topic-id="${targetTopicId}">
        <div class="author"><div class="info"><div class="role owner">陈老师</div></div></div>
        <div class="talk-content-container"><div class="content">${preview}</div></div>
      </div>`;
    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: window.location.origin,
      data: {
        source: TOPIC_MESSAGE,
        hookVersion: TOPIC_HOOK_VERSION,
        hookBuildId: CONTENT_BUILD_ID,
        records: [{
          topicId: otherTopicId,
          text: preview,
          fullText: `${preview}${otherTail}`,
          fullTextTruncated: false,
          sourceBodyProven: true,
          sourceMediaProven: true,
        }],
      },
    }));

    const response = await ask<{
      ok: false;
      error: { code: string; message: string };
    }>({ type: CONTENT_DOCUMENT_REQUEST });

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'CONTENT_EMPTY', message: expect.stringContaining('当前构建') },
    });
    expect(JSON.stringify(response)).not.toContain(otherTail);
  });

  it('rejects an unmarked stale detail DOM even when the target URL API body is source-proven', async () => {
    const targetTopicId = '599999999999989';
    const targetBody = '这是目标帖子 B 的完整投资与经营正文，接口已按 URL 精确捕获。';
    const staleBody = '这是 SPA 上一篇帖子 A 残留的无标记正文，内容更长但绝不能挂到 B 的地址。'.repeat(12);
    history.replaceState({}, '', `/group/48844584441158/topic/${targetTopicId}`);
    document.body.innerHTML = `
      <div class="topic-container">
        <div class="author"><div class="info"><div class="role owner">陈老师</div></div></div>
        <div class="talk-content-container"><div class="content">${staleBody}</div></div>
      </div>`;
    await feedExactDetailTopic(targetTopicId, targetBody, targetBody, false, true);

    const response = await ask<{
      ok: false;
      error: { code: string; message: string };
    }>({ type: CONTENT_DOCUMENT_REQUEST });

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'CONTENT_EMPTY', message: expect.stringContaining('DOM 正文') },
    });
    expect(JSON.stringify(response)).not.toContain(staleBody.slice(0, 40));
  });

  it('does not trust a matching data-topic-id while that container still holds stale body assets', async () => {
    const targetTopicId = '599999999999986';
    const targetBody = '这是目标帖子 B 的完整正文，来源接口已经给出最终投资结论。';
    const staleBody = '这是上一帖子 A 的旧正文，属性先切换了但正文和长文卡片还没重绘。'.repeat(8);
    const staleArticle = 'https://articles.zsxq.com/id_StaleAssetA.html';
    history.replaceState({}, '', `/group/48844584441158/topic/${targetTopicId}`);
    document.body.innerHTML = `
      <div class="topic-container" data-topic-id="${targetTopicId}">
        <div class="talk-content-container"><div class="content">
          ${staleBody}<a href="${staleArticle}">全文</a>
        </div></div>
      </div>`;
    await feedExactDetailTopic(targetTopicId, targetBody, targetBody, false, true);

    const response = await ask<{ ok: false; error: { code: string } }>({
      type: CONTENT_DOCUMENT_REQUEST,
    });

    expect(response).toMatchObject({ ok: false, error: { code: 'CONTENT_EMPTY' } });
    expect(JSON.stringify(response)).not.toContain(staleArticle);
  });

  it('accepts an unmarked short detail only when it exactly equals the source-proven body', async () => {
    const topicId = '599999999999988';
    const shortBody = '短帖正文完全相等，刚好满足二十个汉字校验。';
    expect(shortBody.length).toBeGreaterThanOrEqual(20);
    expect(shortBody.length).toBeLessThan(24);
    history.replaceState({}, '', `/group/48844584441158/topic/${topicId}`);
    document.body.innerHTML = `
      <div class="topic-container">
        <div class="talk-content-container"><div class="content">${shortBody}</div></div>
      </div>`;
    await feedExactDetailTopic(topicId, shortBody, shortBody, false, true);

    const response = await ask<DocumentResponse>({ type: CONTENT_DOCUMENT_REQUEST });

    expect(response.document.text).toContain(shortBody);
    expect(response.document.truncated).toBe(false);
  });

  it('matches source-proven Q&A after removing the rendered questioner label and keeps a short answer', async () => {
    const topicId = '599999999999985';
    const question = '这个创业项目现在已经满足继续投入资源和扩大验证范围的全部条件了吗？';
    const answer = '是。';
    history.replaceState({}, '', `/group/48844584441158/topic/${topicId}`);
    document.body.innerHTML = `
      <div class="topic-container" data-topic-id="${topicId}">
        <div class="q-content-container"><div class="content">
          <div class="question-owner"><span>创业者甲</span> 提问：</div>${question}
        </div></div>
        <div class="answer-content-container"><div class="content">${answer}</div></div>
      </div>`;
    await feedExactDetailTopic(
      topicId,
      question,
      `${question}\n\n${answer}`,
      false,
      true,
    );

    const response = await ask<DocumentResponse>({ type: CONTENT_DOCUMENT_REQUEST });

    expect(response.document.text).toContain(question);
    expect(response.document.text).toContain(answer);
    expect(response.document.truncated).toBe(false);
  });

  it('does not accept a short unmarked DOM merely because it prefixes the target source body', async () => {
    const topicId = '599999999999987';
    const shortPrefix = '短帖首段只有二十个汉字，不能凭前缀认定。';
    expect(shortPrefix.length).toBeGreaterThanOrEqual(20);
    expect(shortPrefix.length).toBeLessThan(24);
    history.replaceState({}, '', `/group/48844584441158/topic/${topicId}`);
    document.body.innerHTML = `
      <div class="topic-container">
        <div class="talk-content-container"><div class="content">${shortPrefix}</div></div>
      </div>`;
    await feedExactDetailTopic(
      topicId,
      shortPrefix,
      `${shortPrefix}接口里还有另一篇内容的尾段，不能因短公共前缀串帖。`,
      false,
      true,
    );

    const response = await ask<{ ok: false; error: { code: string } }>({
      type: CONTENT_DOCUMENT_REQUEST,
    });

    expect(response).toMatchObject({ ok: false, error: { code: 'CONTENT_EMPTY' } });
  });

  it('does not certify a current-build topic detail when its exact API record is still missing', async () => {
    const topicId = '599999999999994';
    const preview = '旧标签页只留下了稳定首段且没有展开控件，新构建不能据此证明全文。';
    history.replaceState({}, '', `/group/48844584441158/topic/${topicId}`);
    document.body.innerHTML = `
      <div class="topic-container" data-topic-id="${topicId}">
        <div class="author"><div class="info"><div class="role owner">陈老师</div></div></div>
        <div class="talk-content-container"><div class="content">${preview}</div></div>
      </div>`;

    const response = await ask<{
      ok: false;
      error: { code: string; message: string };
    }>({ type: CONTENT_DOCUMENT_REQUEST });

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'CONTENT_EMPTY',
        message: expect.stringContaining('当前构建'),
      },
    });
  });

  it('keeps a stalled expansion unknown instead of manufacturing positive truncation evidence', async () => {
    history.replaceState({}, '', '/group/48844584441158/topic/588888888888888');
    document.body.innerHTML = `
      <div class="topic-container">
        <div class="author"><div class="info"><div class="role owner">陈老师</div></div></div>
        <div class="talk-content-container"><div class="content">
          这是足够长的投资复盘导语，但这次展开请求失败，后半段始终没有出现。
          <button class="showAll">展开全部</button>
        </div></div>
      </div>`;
    for (const element of document.querySelectorAll('*')) {
      Object.defineProperty(element, 'offsetHeight', { value: 20, configurable: true });
    }
    document.querySelector('.showAll')!.addEventListener('click', event => {
      (event.currentTarget as Element).remove();
    });
    vi.useFakeTimers();

    const response = await settle(ask<DocumentResponse>({ type: 'extract.document' }));

    expect(response.document.truncated).toBeUndefined();
    expect(response.document.sourceMetadata?.expansionUnconfirmed).toBe(true);
  });

  it('keeps replacement-after-click unknown so the bounded background window fails closed', async () => {
    history.replaceState({}, '', '/group/48844584441158/topic/577777777777777');
    document.body.innerHTML = `
      <div class="topic-container">
        <div class="author"><div class="info"><div class="role owner">陈老师</div></div></div>
        <div class="talk-content-container"><div class="content">
          这是足够长的投资复盘导语，但 SPA 重绘以后仍然只留下不完整的正文。
          <button class="showAll">展开全部</button>
        </div></div>
      </div>`;
    for (const element of document.querySelectorAll('*')) {
      Object.defineProperty(element, 'offsetHeight', { value: 20, configurable: true });
    }
    const oldTopic = document.querySelector('.topic-container')!;
    document.querySelector('.showAll')!.addEventListener('click', () => {
      const replacement = document.createElement('div');
      replacement.className = 'topic-container';
      replacement.innerHTML = `
        <div class="author"><div class="info"><div class="role owner">陈老师</div></div></div>
        <div class="talk-content-container"><div class="content">
          这是足够长的投资复盘导语，但 SPA 重绘以后仍然只留下不完整的正文。
        </div></div>`;
      oldTopic.replaceWith(replacement);
    });
    vi.useFakeTimers();

    const response = await settle(ask<DocumentResponse>({ type: 'extract.document' }));

    expect(response.document.truncated).toBeUndefined();
    expect(response.document.sourceMetadata?.expansionUnconfirmed).toBe(true);
  });

  it('waits through staged SPA rendering until the full expanded tail stays stable', async () => {
    history.replaceState({}, '', '/group/48844584441158/topic/566666666666666');
    document.body.innerHTML = `
      <div class="topic-container">
        <div class="author"><div class="info"><div class="role owner">陈老师</div></div></div>
        <div class="talk-content-container"><div class="content">
          这是足够长的投资复盘导语，正文会分两段异步挂载。
          <button class="showAll">展开全部</button>
        </div></div>
      </div>`;
    for (const element of document.querySelectorAll('*')) {
      Object.defineProperty(element, 'offsetHeight', { value: 20, configurable: true });
    }
    const content = document.querySelector('.content')!;
    document.querySelector('.showAll')!.addEventListener('click', event => {
      (event.currentTarget as Element).remove();
      setTimeout(() => content.append('这是先到的正文中段。'), 300);
      setTimeout(() => content.append('这是稍后才到的完整正文尾部与最终结论。'), 1_200);
    });
    await feedExpansionIdentity(
      '566666666666666',
      '这是足够长的投资复盘导语，正文会分两段异步挂载。'
        + '这是先到的正文中段。'
        + '这是稍后才到的完整正文尾部与最终结论。',
    );
    vi.useFakeTimers();

    const response = await settle(ask<DocumentResponse>({ type: 'extract.document' }));

    expect(response.document.text).toContain('稍后才到的完整正文尾部');
    expect(response.document.truncated).toBe(false);
  });

  it('keeps a slowly growing but never-stable expansion unknown at the probe timeout', async () => {
    history.replaceState({}, '', '/group/48844584441158/topic/555555555555555');
    document.body.innerHTML = `
      <div class="topic-container">
        <div class="author"><div class="info"><div class="role owner">陈老师</div></div></div>
        <div class="talk-content-container"><div class="content">
          这是点击前的投资复盘导语，后续只会缓慢返回一部分正文。
          <button class="showAll">展开全部</button>
        </div></div>
      </div>`;
    for (const element of document.querySelectorAll('*')) {
      Object.defineProperty(element, 'offsetHeight', { value: 20, configurable: true });
    }
    const content = document.querySelector('.content')!;
    document.querySelector('.showAll')!.addEventListener('click', event => {
      (event.currentTarget as Element).remove();
      for (let index = 1; index <= 15; index += 1) {
        setTimeout(() => content.append(`未完成分段${index}。`), index * 500);
      }
    });
    vi.useFakeTimers();

    const response = await settle(ask<DocumentResponse>({ type: 'extract.document' }));

    expect(response.document.text).toContain('未完成分段15');
    expect(response.document.truncated).toBeUndefined();
    expect(response.document.sourceMetadata?.expansionUnconfirmed).toBe(true);
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
    await feedEveryFixtureTopic();
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

  it('revisits a virtual-list node when its proven topic identity changes', async () => {
    const firstBody = '虚拟列表里的第一条帖子正文，长度足够并且会先被完整提取。';
    const secondBody = '同一个节点稍后承载第二条帖子正文，身份已由接口明确证明。';
    document.body.innerHTML = `
      <div class="main-content-container">
        <div class="topic-container" id="reused-topic">
          <div class="talk-content-container"><div class="content">${firstBody}</div></div>
        </div>
      </div>`;
    const publish = (topicId: string, text: string) => {
      window.dispatchEvent(new MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
          source: TOPIC_MESSAGE,
          hookVersion: TOPIC_HOOK_VERSION,
          hookBuildId: '开发构建',
          records: [{
            topicId,
            text,
            fullTextTruncated: false,
            sourceBodyProven: true,
            sourceMediaProven: true,
          }],
        },
      }));
    };

    publish('611111111111111', firstBody);
    await new Promise(resolve => setTimeout(resolve, 0));
    const first = await ask<ListResponse>({ type: 'extract.list' });
    const firstKey = first.list.items[0]!.key;
    expect(first.list.items[0]?.document?.canonicalUrl).toBe(
      'https://wx.zsxq.com/group/48844584441158/topic/611111111111111',
    );
    const marked = await ask<AdvanceResponse>({ type: 'list.restore', mark: true });
    expect(marked.advance.collapsed).toBe(1);

    const reused = document.querySelector<HTMLElement>('#reused-topic')!;
    expect(reused.hasAttribute('data-dc-collected')).toBe(true);
    reused.querySelector('.content')!.textContent = secondBody;

    vi.useFakeTimers();
    const advance = await settle(ask<AdvanceResponse>({ type: 'list.advance' }));
    vi.useRealTimers();

    expect(advance.advance).toMatchObject({ collapsed: 0, loaded: 1 });
    expect(reused.hasAttribute('data-dc-collected')).toBe(false);
    const awaitingIdentity = await ask<ListResponse>({ type: 'extract.list' });
    expect(awaitingIdentity.list.items[0]?.document).toBeUndefined();
    expect(awaitingIdentity.list.items[0]?.reason).toContain('编号没截到');
    expect(awaitingIdentity.list.items[0]?.key).not.toBe(firstKey);

    publish('622222222222222', secondBody);
    await new Promise(resolve => setTimeout(resolve, 0));
    const second = await ask<ListResponse>({ type: 'extract.list' });
    expect(second.list.items[0]?.document?.canonicalUrl).toBe(
      'https://wx.zsxq.com/group/48844584441158/topic/622222222222222',
    );
    expect(second.list.items[0]?.key).not.toBe(firstKey);
  });

  it('keeps the mark when the same body remains but its identity evidence disappears', async () => {
    document.body.innerHTML = `
      <div class="main-content-container">
        <div class="topic-container" id="same-topic" data-topic-id="633333333333333">
          <div class="talk-content-container">
            <div class="content">同一条帖子的语义正文始终没有变化，身份属性只是被框架暂时移除。</div>
          </div>
        </div>
      </div>`;

    const first = await ask<ListResponse>({ type: 'extract.list' });
    expect(first.list.items[0]?.document?.canonicalUrl).toContain('/topic/633333333333333');
    await ask<AdvanceResponse>({ type: 'list.restore', mark: true });
    const same = document.querySelector<HTMLElement>('#same-topic')!;
    same.removeAttribute('data-topic-id');

    vi.useFakeTimers();
    const advance = await settle(ask<AdvanceResponse>({ type: 'list.advance' }));
    vi.useRealTimers();

    expect(advance.advance.loaded).toBe(0);
    expect(same.hasAttribute('data-dc-collected')).toBe(true);
    const repeated = await ask<ListResponse>({ type: 'extract.list' });
    expect(repeated.list.total).toBe(0);
  });

  it('does not trust a DOM mark that has no body binding in the current script', async () => {
    document.body.innerHTML = `
      <div class="topic-container" id="orphan-mark"
           data-topic-id="666666666666666"
           data-dc-collected="1"
           data-dc-collected-topic-id="666666666666666">
        <div class="talk-content-container">
          <div class="content">扩展上下文重建后，旧 DOM 标记没有可核验的正文绑定，不能永久跳过。</div>
        </div>
      </div>`;

    const extracted = await ask<ListResponse>({ type: 'extract.list' });

    expect(extracted.list.total).toBe(1);
    expect(extracted.list.items[0]?.document?.canonicalUrl).toContain('/topic/666666666666666');
    expect(document.querySelector('#orphan-mark')?.hasAttribute('data-dc-collected')).toBe(false);
  });

  it('revisits identical text when the API proves two different topic identities', async () => {
    const repeatedBody = '这是一则可能被原样重复发布的公告，正文完全相同但帖子号明确不同。';
    document.body.innerHTML = `
      <div class="main-content-container">
        <div class="topic-container" id="duplicate-announcement">
          <div class="talk-content-container"><div class="content">${repeatedBody}</div></div>
        </div>
      </div>`;
    const publish = (topicId: string) => {
      window.dispatchEvent(new MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
          source: TOPIC_MESSAGE,
          hookVersion: TOPIC_HOOK_VERSION,
          hookBuildId: '开发构建',
          records: [{
            topicId,
            text: repeatedBody,
            fullTextTruncated: false,
            sourceBodyProven: true,
            sourceMediaProven: true,
          }],
        },
      }));
    };

    publish('644444444444444');
    await new Promise(resolve => setTimeout(resolve, 0));
    const first = await ask<ListResponse>({ type: 'extract.list' });
    expect(first.list.items[0]?.document?.canonicalUrl).toContain('/topic/644444444444444');
    await ask<AdvanceResponse>({ type: 'list.restore', mark: true });

    // 虚拟节点切到正文完全相同的 B；接口帖子号是区分它们的唯一可靠证据。
    publish('655555555555555');
    await new Promise(resolve => setTimeout(resolve, 0));
    vi.useFakeTimers();
    const advance = await settle(ask<AdvanceResponse>({ type: 'list.advance' }));
    vi.useRealTimers();

    expect(advance.advance.loaded).toBe(1);
    expect(document.querySelector('#duplicate-announcement')?.hasAttribute('data-dc-collected')).toBe(false);
    const ambiguous = await ask<ListResponse>({ type: 'extract.list' });
    expect(ambiguous.list.items[0]?.document).toBeUndefined();
    expect(ambiguous.list.items[0]?.reason).toContain('编号没截到');
  });

  it('resets exhaustion when a second API identity arrives at eight seconds without a DOM mutation', async () => {
    const repeatedBody = '同一段公告正文由虚拟列表节点复用，八秒后接口才证明它可能已经换成另一帖。';
    document.body.innerHTML = `
      <div class="main-content-container">
        <div class="topic-container" id="api-late-identity">
          <div class="talk-content-container"><div class="content">${repeatedBody}</div></div>
        </div>
      </div>`;
    const publish = (topicId: string) => {
      window.dispatchEvent(new MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
          source: TOPIC_MESSAGE,
          hookVersion: TOPIC_HOOK_VERSION,
          hookBuildId: '开发构建',
          records: [{
            topicId,
            text: repeatedBody,
            fullTextTruncated: false,
            sourceBodyProven: true,
            sourceMediaProven: true,
          }],
        },
      }));
    };

    publish('688888888888881');
    await new Promise(resolve => setTimeout(resolve, 0));
    const first = await ask<ListResponse>({ type: CONTENT_LIST_REQUEST });
    expect(first.list.items[0]?.document?.canonicalUrl).toContain('/topic/688888888888881');
    await ask<AdvanceResponse>({ type: 'list.restore', mark: true });

    vi.useFakeTimers();
    let settledEarly = false;
    const advance = ask<AdvanceResponse>({ type: CONTENT_ADVANCE_REQUEST }).then(response => {
      settledEarly = true;
      return response;
    });
    setTimeout(() => publish('688888888888882'), 8_000);

    await vi.advanceTimersByTimeAsync(7_500);
    expect(settledEarly).toBe(false);
    const response = await settle(advance);

    expect(response.advance.loaded).toBe(1);
    expect(document.querySelector('#api-late-identity')?.hasAttribute('data-dc-collected')).toBe(false);
    const ambiguous = await ask<ListResponse>({ type: CONTENT_LIST_REQUEST });
    expect(ambiguous.list.items[0]?.document).toBeUndefined();
    expect(ambiguous.list.items[0]?.reason).toContain('编号没截到');
  });

  it('第一个候选推不动时换下一个，不是直接放弃翻页', async () => {
    // 实测症状：「目标 body，位移 0px，未到底，推不动任何元素，停止翻页」——
    // body 满足 scrollHeight > clientHeight 所以进了候选，却根本推不动
    //（真正的滚动容器在内层）。原先只认 candidates[0]，于是翻页彻底停摆。
    const flow = document.querySelector('.main-content-container') as HTMLElement;
    // body 是个「看着能滚、其实推不动」的假候选。
    Object.defineProperty(document.body, 'scrollHeight', { value: 9000, configurable: true });
    Object.defineProperty(document.body, 'clientHeight', { value: 800, configurable: true });
    Object.defineProperty(document.body, 'scrollTop', {
      get: () => 0, set: () => undefined, configurable: true,
    });
    // 内层容器才是真的滚动容器。
    let inner = 0;
    Object.defineProperty(flow, 'scrollHeight', { value: 9000, configurable: true });
    Object.defineProperty(flow, 'clientHeight', { value: 800, configurable: true });
    Object.defineProperty(flow, 'scrollTop', {
      get: () => inner, set: (value: number) => { inner = value; }, configurable: true,
    });

    await feedEveryFixtureTopic();
    await ask<ListResponse>({ type: 'extract.list' });
    vi.useFakeTimers();
    const advance = await settle(ask<AdvanceResponse>({ type: 'list.advance' }));

    expect(advance.advance.scroll).not.toContain('推不动任何元素');
    expect(inner).toBeGreaterThan(0);
  });

  it('reports newly loaded posts so the batch keeps going', async () => {
    await feedEveryFixtureTopic();
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

  it('does not declare continuation exhausted before a complete topic lazy-loads at eight seconds', async () => {
    await feedEveryFixtureTopic();
    await ask<ListResponse>({ type: CONTENT_LIST_REQUEST });
    vi.useFakeTimers();

    let settledEarly = false;
    const advance = ask<AdvanceResponse>({ type: CONTENT_ADVANCE_REQUEST }).then(response => {
      settledEarly = true;
      return response;
    });
    setTimeout(() => {
      const fresh = document.createElement('div');
      fresh.className = 'topic-container';
      fresh.dataset.topicId = '677777777777778';
      fresh.innerHTML = `
        <div class="author"><div class="role owner">陈老师</div></div>
        <div class="talk-content-container">
          八秒后 Angular 才挂载的下一页完整帖子正文，身份和正文都已经得到证明。
        </div>`;
      document.querySelector('.main-content-container')!.append(fresh);
    }, 8_000);

    await vi.advanceTimersByTimeAsync(7_500);
    expect(settledEarly).toBe(false);

    const response = await settle(advance);
    expect(response.advance).toMatchObject({ collapsed: 3, loaded: 1 });
    const continuation = await ask<ListResponse>({ type: CONTENT_LIST_REQUEST });
    expect(continuation.list.items.map(item => item.document?.canonicalUrl)).toEqual([
      'https://wx.zsxq.com/group/48844584441158/topic/677777777777778',
    ]);
  });

  it('scrollIntoView 不生效时靠一屏一屏的补滚推进，不瞬移', async () => {
    // 有的环境里 scrollIntoView 只是把元素带进视口、甚至完全不动，
    // 这时靠补滚推进——但每次只补一屏，不一把跳到底。
    await feedEveryFixtureTopic();
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
    await feedEveryFixtureTopic();
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
    await feedEveryFixtureTopic();
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
    await feedEveryFixtureTopic();
    await ask<ListResponse>({ type: 'extract.list' });
    vi.useFakeTimers();

    const advance = await settle(ask<AdvanceResponse>({ type: 'list.advance' }));

    expect(advance.advance.scroll).toContain('位移 0px');
    expect(advance.advance.loaded).toBe(0);
  });

  it('懒加载始终没返回时从最后一次滚动触发后连续稳定 24 秒才确认耗尽', async () => {
    await feedEveryFixtureTopic();
    await ask<ListResponse>({ type: 'extract.list' });
    const host = document.querySelector<HTMLElement>('.main-content-container')!;
    let scrollTop = 0;
    Object.defineProperty(host, 'scrollHeight', { value: 1_000_000, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 800, configurable: true });
    Object.defineProperty(host, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; },
    });
    vi.spyOn(Math, 'random').mockReturnValue(1);
    vi.useFakeTimers();
    let settled = false;
    const pending = ask<AdvanceResponse>({ type: 'list.advance' }).then(result => {
      settled = true;
      return result;
    });

    // Math.random=1 会让最后一次可能触发懒加载的 scrollLikeHuman 在入口后约 1.7 秒完成；
    // 若错误地从函数入口计时，24 秒就会提前返回。25 秒时仍应处于最后触发后的稳定观察窗。
    await vi.advanceTimersByTimeAsync(25_000);

    expect(settled).toBe(false);
    const response = await settle(pending, 50_000);
    expect(response.advance).toMatchObject({ loaded: 0 });
    expect(response.advance.uncertain).toBeUndefined();
    expect(response.advance.scroll).toContain('连续稳定 24 秒');
  });

  it('returns uncertain at the bounded cap when TopicIndex keeps changing without a pending DOM node', async () => {
    await feedEveryFixtureTopic();
    await ask<ListResponse>({ type: CONTENT_LIST_REQUEST });
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1);

    const publishUnrelated = (index: number) => {
      window.dispatchEvent(new MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
          source: TOPIC_MESSAGE,
          hookVersion: TOPIC_HOOK_VERSION,
          hookBuildId: '开发构建',
          records: [{
            topicId: `79999999999999${index}`,
            text: `接口在有界观察期内继续发布与当前 DOM 无关的身份状态变化 ${index}。`,
            fullTextTruncated: false,
            sourceBodyProven: false,
            sourceMediaProven: false,
          }],
        },
      }));
    };
    for (const [index, at] of [8_000, 16_000, 24_000, 32_000, 40_000].entries()) {
      setTimeout(() => publishUnrelated(index), at);
    }

    const response = await settle(
      ask<AdvanceResponse>({ type: CONTENT_ADVANCE_REQUEST }),
      60_000,
    );

    expect(response.advance).toMatchObject({ collapsed: 3, loaded: 0, uncertain: true });
    expect(response.advance.scroll).toContain('44.5 秒有界观察内列表状态仍在变化');
  });

  it('skips posts that were handled in an earlier round', async () => {
    await feedEveryFixtureTopic();
    await ask<ListResponse>({ type: 'extract.list' });
    vi.useFakeTimers();
    await settle(ask<AdvanceResponse>({ type: 'list.advance' }));
    vi.useRealTimers();

    const second = await ask<ListResponse>({ type: 'extract.list' });

    expect(second.list.items).toEqual([]);
    expect(second.list.total).toBe(0);
  });

  it('clears the marks so a fresh batch sees the whole page again', async () => {
    await feedEveryFixtureTopic();
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
