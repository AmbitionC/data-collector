import type { CollectedDocument } from '@data-collector/shared';
import {
  COLLECTED_ATTRIBUTE,
  KEY_ATTRIBUTE,
  ExtractionError,
  extractDocument,
  extractList,
  pendingTopicCount,
} from './extractors/index.js';
import { TOPIC_MESSAGE, TopicIndex, type TopicRecord } from './topicIndex.js';

/**
 * 帖子号索引。帖子号不在 DOM 上，只能从应用自己的接口响应里取（见 inject.ts）。
 * 主世界脚本捕获后 postMessage 过来，这里累积成「正文 → 帖子号」的对照表。
 */
const topics = new TopicIndex();
window.addEventListener('message', event => {
  if (event.source !== window) return;
  const data = event.data as { source?: unknown; records?: unknown };
  if (data?.source !== TOPIC_MESSAGE || !Array.isArray(data.records)) return;
  topics.add(data.records as TopicRecord[]);
});

interface ExtractMessage {
  type:
    | 'extract.document'
    | 'extract.list'
    | 'list.advance'
    | 'list.diagnose'
    | 'list.restore'
    | 'list.highlight';
  /** list.highlight：要滚过去并高亮的那一条。 */
  key?: string;
  overrides?: {
    userCategory?: string;
    userTags?: string[];
  };
}

/** 折叠正文的展开控件文案（精确匹配，避免误点「查看更多评论」「更多优质内容」）。 */
const EXPAND_LABELS = new Set(['展开', '展开全文', '展开全部', '全文', '阅读全文', '显示全部']);

/**
 * 提取前先点开正文的「展开全文」，否则折叠的帖子只能采到截断的正文。
 * 只点文案精确匹配且可见的控件，避免误触评论区/推荐位；列表页一屏 20+ 条，上限放宽。
 * 返回是否点过——点过需要等框架完成重渲染再读 DOM。
 */
function expandCollapsedContent(limit: number): boolean {
  let clicked = 0;
  for (const element of document.querySelectorAll<HTMLElement>('button, a, span, div')) {
    if (clicked >= limit) break;
    const label = (element.textContent ?? '').trim();
    if (!EXPAND_LABELS.has(label)) continue;
    if (!element.offsetParent && element.offsetHeight === 0) continue;
    try {
      element.click();
      clicked += 1;
    } catch {
      // 忽略不可点击的元素。
    }
  }
  return clicked > 0;
}

/** 上一轮列表提取覆盖到的帖子节点，等 list.advance 时统一打标记。 */
let lastListContainers: Element[] = [];

/**
 * 给已处理的帖子打个**不可见**的标记，下一轮就不会重复提取它们。
 *
 * 早先的实现顺手把它们 display:none 收起（想压缩页面高度好触发懒加载），
 * 但那会让用户没法肉眼核对采到的内容对不对——验证阶段这是硬伤。
 * 加载下一批改为纯靠滚动到底触发站点自己的懒加载，页面外观一动不动。
 */
function markProcessed(): number {
  let marked = 0;
  for (const container of lastListContainers) {
    if (!container.isConnected || container.hasAttribute(COLLECTED_ATTRIBUTE)) continue;
    container.setAttribute(COLLECTED_ATTRIBUTE, '1');
    marked += 1;
  }
  lastListContainers = [];
  return marked;
}

/** 清掉所有处理标记，让整页重新可采（顺带擦掉早期版本残留的 display:none）。 */
function clearMarks(): number {
  const marked = [...document.querySelectorAll<HTMLElement>(`[${COLLECTED_ATTRIBUTE}]`)];
  for (const container of marked) {
    container.removeAttribute(COLLECTED_ATTRIBUTE);
    container.style.removeProperty('display');
  }
  lastListContainers = [];
  return marked.length;
}

const HIGHLIGHT_STYLE_ID = 'data-collector-highlight-style';
const HIGHLIGHT_CLASS = 'data-collector-highlight';

/** 侧栏点某一条时，把页面滚到它那儿并高亮出来，方便逐条核对。 */
function highlightEntry(key: string): { found: boolean } {
  // 逐个比对而不是拼选择器：key 里可能有冒号、点号这类在选择器里有含义的字符，
  // 拼串既要转义又容易出错，扫一遍最稳。
  const target = [...document.querySelectorAll<HTMLElement>(`[${KEY_ATTRIBUTE}]`)]
    .find(node => node.getAttribute(KEY_ATTRIBUTE) === key);
  if (!target) return { found: false };
  if (!document.getElementById(HIGHLIGHT_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = HIGHLIGHT_STYLE_ID;
    style.textContent = `.${HIGHLIGHT_CLASS}{outline:3px solid #f54e00!important;`
      + 'outline-offset:4px;border-radius:8px;transition:outline-color 200ms ease}';
    document.head.append(style);
  }
  for (const previous of document.querySelectorAll(`.${HIGHLIGHT_CLASS}`)) {
    previous.classList.remove(HIGHLIGHT_CLASS);
  }
  target.classList.add(HIGHLIGHT_CLASS);
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return { found: true };
}

/** 信息流可能滚动在内部容器上，而不是窗口本身。 */
function scrollHost(): HTMLElement | undefined {
  const anchor = document.querySelector(`[${COLLECTED_ATTRIBUTE}]`) ?? document.querySelector('.topic-container');
  for (let element = anchor?.parentElement; element; element = element.parentElement) {
    const overflowY = getComputedStyle(element).overflowY;
    if (/(auto|scroll)/.test(overflowY) && element.scrollHeight > element.clientHeight + 40) {
      return element;
    }
  }
  return undefined;
}

function scrollToBottom(): void {
  const host = scrollHost();
  if (host) host.scrollTop = host.scrollHeight;
  window.scrollTo(0, document.documentElement.scrollHeight);
}

/**
 * 推进到下一批：收起已处理的帖子 → 滚到底触发懒加载 → 等新帖子出现。
 * 返回新加载出的待采条数；为 0 表示已经到底（批量采集据此收尾）。
 */
async function advanceList(): Promise<{ collapsed: number; loaded: number }> {
  const collapsed = markProcessed();
  const before = document.querySelectorAll('.topic-container').length;
  scrollToBottom();
  // 站点是「滚到底再加载一页」，加载要走网络，给足时间并反复触底。
  for (let waited = 0; waited < 12_000; waited += 500) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const loaded = pendingTopicCount(document);
    if (loaded > 0) {
      console.info(
        `[data-collector] 滚动加载出新内容：本页帖子 ${before} → `
        + `${document.querySelectorAll('.topic-container').length}，待采 ${loaded}`,
      );
      return { collapsed, loaded };
    }
    scrollToBottom();
  }
  console.info(`[data-collector] 滚动 12 秒没有加载出新内容，本页帖子仍为 ${before}`);
  return { collapsed, loaded: 0 };
}

/**
 * 诊断样本：帖子拿不到各自链接时，把页面结构导出来供适配排查。
 *
 * 取样必须挑**没被收起过**的帖子：收起的节点框架可能已经回收了内容，
 * 拿它取样会得出「页面里什么都没有」的错误结论。
 */
function listDiagnostics(): string {
  const all = [...document.querySelectorAll('.topic-container')];
  const container =
    all.find(node => !node.hasAttribute(COLLECTED_ATTRIBUTE) && node.textContent?.trim())
    ?? all.find(node => node.textContent?.trim())
    ?? all[0];
  if (!container) {
    return JSON.stringify(
      { url: location.href, note: '本页没有找到 .topic-container' },
      null,
      2,
    );
  }
  const attributes = (element: Element) =>
    element
      .getAttributeNames()
      .map(name => [name, (element.getAttribute(name) ?? '').slice(0, 160)] as const)
      .filter(([, value]) => value !== '');
  const ancestors: unknown[] = [];
  for (let node = container.parentElement, depth = 0; node && depth < 4; node = node.parentElement) {
    ancestors.push({ tag: node.tagName, class: node.className, attrs: attributes(node) });
    depth += 1;
  }
  const descendants = [...container.querySelectorAll('*')];
  // 长数字串（15 位以上）最像帖子号：不限定属性名，也不只看取样那一条——
  // 帖子号可能只出现在某些条目上，只扫一条容易得出「哪儿都没有」的错误结论。
  const longNumbers: unknown[] = [];
  for (const topic of all.slice(0, 5)) {
    for (const element of [topic, ...topic.querySelectorAll('*')]) {
      for (const [name, value] of attributes(element)) {
        if (/\b\d{15,25}\b/.test(value)) {
          longNumbers.push({ class: String(element.className).slice(0, 60), name, value });
        }
      }
    }
  }
  return JSON.stringify(
    {
      // 版本号：贴回来的样本能一眼看出跑的是哪一版插件，不用靠字段有无去猜。
      diagnosticsVersion: 2,
      url: location.href,
      topicCount: all.length,
      // 为 0 说明一次接口响应都没捕获到——帖子号无从谈起，先滚动一屏或切一次分类。
      capturedTopics: topics.size,
      sampledCollapsed: container.hasAttribute(COLLECTED_ATTRIBUTE),
      textSample: (container.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
      anchors: [...container.querySelectorAll('a')]
        .map(anchor => anchor.getAttribute('href'))
        .slice(0, 12),
      // 有些站点把跳转挂在非 <a> 元素上。
      hrefLike: [...container.querySelectorAll('[href],[data-href],[data-url],[routerlink]')]
        .map(element => element.outerHTML.slice(0, 120))
        .slice(0, 8),
      containerAttrs: attributes(container),
      ancestors,
      longNumbers: longNumbers.slice(0, 20),
      descendantCount: descendants.length,
      // 结构本身最能说明问题；截断避免把整页正文倒出来。
      htmlHead: container.outerHTML.slice(0, 1200),
    },
    null,
    2,
  );
}

/**
 * 防重复注册：插件更新后我们会主动把这个脚本注入到已打开的标签页，
 * 而同一页可能已经声明式注入过一次——注册两个监听会对同一条消息应答两次。
 */
const READY_FLAG = '__dataCollectorContentReady';
const alreadyRegistered = Boolean(
  (globalThis as unknown as Record<string, unknown>)[READY_FLAG],
);
(globalThis as unknown as Record<string, unknown>)[READY_FLAG] = true;

if (!alreadyRegistered) chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const request = message as Partial<ExtractMessage>;
  if (
    request.type !== 'extract.document' &&
    request.type !== 'extract.list' &&
    request.type !== 'list.advance' &&
    request.type !== 'list.diagnose' &&
    request.type !== 'list.restore' &&
    request.type !== 'list.highlight'
  ) {
    return false;
  }

  if (request.type === 'list.diagnose') {
    sendResponse({ ok: true, diagnostics: listDiagnostics() });
    return false;
  }

  if (request.type === 'list.restore') {
    sendResponse({ ok: true, advance: { collapsed: clearMarks(), loaded: 0 } });
    return false;
  }

  if (request.type === 'list.highlight') {
    sendResponse({ ok: true, highlight: highlightEntry(String(request.key ?? '')) });
    return false;
  }

  if (request.type === 'list.advance') {
    void advanceList().then(
      result => sendResponse({ ok: true, advance: result }),
      error =>
        sendResponse({
          ok: false,
          error: {
            code: 'COLLECTION_FAILED',
            message: error instanceof Error ? error.message : '翻页失败',
          },
        }),
    );
    return true;
  }

  const wantsList = request.type === 'extract.list';

  const run = (): void => {
    try {
      if (wantsList) {
        const { entries, skipped, total } = extractList(document, location.href, topics);
        // 节点留在内容脚本里（无法跨消息边界传递），等 list.advance 时统一打标记。
        lastListContainers = entries.map(entry => entry.container);
        console.info(
          `[data-collector] 本轮提取：待采 ${total} 条，可入库 ${total - skipped} 条，`
          + `跳过 ${skipped} 条，已捕获帖子号 ${topics.size} 个`,
        );
        sendResponse({
          ok: true,
          list: {
            // 捕获到的帖子号条数一并回报：为 0 时失败原因要说得具体，不能只说「适配问题」。
            captured: topics.size,
            skipped,
            total,
            items: entries.map(entry => ({
              key: entry.key,
              title: entry.title,
              ...(entry.document ? { document: entry.document } : {}),
              ...(entry.reason ? { reason: entry.reason } : {}),
            })),
          },
        });
        return;
      }
      const extracted = extractDocument(document, location.href);
      const result: CollectedDocument = {
        ...extracted,
        ...(request.overrides?.userCategory
          ? { userCategory: request.overrides.userCategory }
          : {}),
        ...(request.overrides?.userTags ? { userTags: request.overrides.userTags } : {}),
      };
      sendResponse({ ok: true, document: result });
    } catch (error) {
      sendResponse({
        ok: false,
        error: {
          code: error instanceof ExtractionError ? error.code : 'COLLECTION_FAILED',
          message: error instanceof Error ? error.message : '页面采集失败',
        },
      });
    }
  };

  // 展开后要让框架完成重渲染再读 DOM；没有可展开内容时同步返回。
  if (expandCollapsedContent(wantsList ? 40 : 20)) {
    setTimeout(run, wantsList ? 600 : 350);
    return true;
  }
  run();
  return false;
});
