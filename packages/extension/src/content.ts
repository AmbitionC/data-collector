import type { CollectedDocument } from '@data-collector/shared';
import {
  COLLECTED_ATTRIBUTE,
  ExtractionError,
  extractDocument,
  extractList,
  pendingTopicCount,
} from './extractors/index.js';

interface ExtractMessage {
  type: 'extract.document' | 'extract.list' | 'list.advance';
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

/** 上一轮列表提取覆盖到的帖子节点，等 list.advance 时统一收起。 */
let lastListContainers: Element[] = [];

/**
 * 把已处理的帖子从版面上收起（而不是 remove）：
 * Angular 仍持有这些节点的视图引用，直接摘除可能让框架后续更新时报错；
 * 收起同样能让页面高度回落，滚动就能触发「加载下一批」。
 */
function collapseProcessed(): number {
  let collapsed = 0;
  for (const container of lastListContainers) {
    if (!container.isConnected || container.hasAttribute(COLLECTED_ATTRIBUTE)) continue;
    container.setAttribute(COLLECTED_ATTRIBUTE, '1');
    (container as HTMLElement).style.display = 'none';
    collapsed += 1;
  }
  lastListContainers = [];
  return collapsed;
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
  const collapsed = collapseProcessed();
  scrollToBottom();
  for (let waited = 0; waited < 6_000; waited += 400) {
    await new Promise(resolve => setTimeout(resolve, 400));
    const loaded = pendingTopicCount(document);
    if (loaded > 0) return { collapsed, loaded };
    // 懒加载可能要求再触一次底部。
    scrollToBottom();
  }
  return { collapsed, loaded: 0 };
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const request = message as Partial<ExtractMessage>;
  if (
    request.type !== 'extract.document' &&
    request.type !== 'extract.list' &&
    request.type !== 'list.advance'
  ) {
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
        const { containers, ...list } = extractList(document, location.href);
        // 节点留在内容脚本里（无法跨消息边界传递），等 list.advance 时统一收起。
        lastListContainers = containers;
        sendResponse({ ok: true, list });
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
