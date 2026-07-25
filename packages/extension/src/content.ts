import type { CollectedDocument } from '@data-collector/shared';
import { ExtractionError, extractDocument } from './extractors/index.js';

interface ExtractMessage {
  type: 'extract.document';
  overrides?: {
    userCategory?: string;
    userTags?: string[];
  };
}

/** 折叠正文的展开控件文案（精确匹配，避免误点「查看更多评论」「更多优质内容」）。 */
const EXPAND_LABELS = new Set(['展开', '展开全文', '展开全部', '全文', '阅读全文', '显示全部']);

/**
 * 提取前先点开正文的「展开全文」，否则折叠的帖子只能采到截断的正文。
 * 只点文案精确匹配且可见的控件，最多 20 个，避免误触评论区/推荐位。
 * 返回是否点过——点过需要等框架完成重渲染再读 DOM。
 */
function expandCollapsedContent(): boolean {
  let clicked = 0;
  for (const element of document.querySelectorAll<HTMLElement>('button, a, span, div')) {
    if (clicked >= 20) break;
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

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const request = message as Partial<ExtractMessage>;
  if (request.type !== 'extract.document') return false;

  const run = (): void => {
    try {
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
  if (expandCollapsedContent()) {
    setTimeout(run, 350);
    return true;
  }
  run();
  return false;
});
