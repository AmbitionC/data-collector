import { buildDocument, elementText, parsePublishedAt } from './common.js';
import { ExtractionError, type Clock } from './types.js';

const LOGIN_SELECTORS = [
  '.login-modal',
  '.nc-login-modal',
  '[class*="login-container"]',
  'form[action*="login"]',
];

const TITLE_SELECTORS = [
  '.post-title',
  '.discuss-title',
  '[class*="post-title"]',
  '[class*="discuss-title"]',
  'h1',
];

const CONTENT_SELECTORS = [
  '.post-topic-des',
  '.nc-post-content',
  '.js-post-content',
  '.feed-content-detail',
  '.feed-content',
  '.discuss-main',
  '[class*="post-content"]',
  'article',
];

const AUTHOR_SELECTORS = [
  '.js-nc-wrap-link .name',
  '.feed-nickname',
  '.author-name',
  '.nc-user-name',
  '[class*="nickname"]',
  '[class*="author-name"]',
];

const TIME_SELECTORS = ['time', '.post-time', '.feed-time', '[class*="post-time"]'];

function firstWithin(root: ParentNode, selectors: string[]): Element | null {
  for (const selector of selectors) {
    const element = root.querySelector(selector);
    if (element) return element;
  }
  return null;
}

function isHidden(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    if (
      current.hasAttribute('hidden') ||
      current.getAttribute('aria-hidden') === 'true' ||
      /display\s*:\s*none|visibility\s*:\s*hidden/i.test(current.getAttribute('style') ?? '')
    ) return true;
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (style?.display === 'none' || style?.visibility === 'hidden') return true;
    current = current.parentElement;
  }
  return false;
}

function visibleText(element: Element): string {
  const walker = element.ownerDocument.createTreeWalker(element, 4);
  const parts: string[] = [];
  let node = walker.nextNode();
  while (node) {
    const parent = node.parentElement;
    if (parent && !isHidden(parent)) parts.push(node.textContent ?? '');
    node = walker.nextNode();
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * 语义选择器全部落空时，在正文块里挑一个唯一高置信度的候选（导航/评论/侧栏比重高的块降权）。
 * 只有当最高分明显领先次高分时才采用，避免误选。
 */
function scoredFallback(document: Document): Element | null {
  const candidates = [...document.querySelectorAll('main, article, section, div')]
    .filter(element => !isHidden(element))
    .map(element => {
      const text = visibleText(element);
      const paragraphs = element.querySelectorAll('p').length;
      const linkElements = [...element.querySelectorAll('a')].filter(link => !isHidden(link));
      const linkTextLength = linkElements.reduce((total, link) => total + visibleText(link).length, 0);
      const navigationRatio = linkTextLength / Math.max(1, text.length);
      const heading = element.querySelector('h1, h2, [role="heading"]');
      const directHeading = heading?.parentElement === element;
      const controls = element.querySelectorAll('button, input, textarea, select').length;
      const paragraphDensity = text.length / Math.max(1, paragraphs);
      const score =
        Math.min(text.length, 5_000) +
        paragraphs * 120 +
        Math.min(paragraphDensity, 160) +
        (directHeading ? 260 : heading ? 60 : 0) -
        linkTextLength * 2 -
        linkElements.length * 30 -
        navigationRatio * 400 -
        controls * 50;
      return { element, text, score };
    })
    .filter(candidate => candidate.text.length >= 80)
    .sort((a, b) => b.score - a.score);

  if (!candidates[0]) return null;
  if (candidates[1] && candidates[0].score < candidates[1].score * 1.15) return null;
  return candidates[0].element;
}

export function extractNowcoder(document: Document, url: URL, now: Clock) {
  if (LOGIN_SELECTORS.some(selector => document.querySelector(selector))) {
    throw new ExtractionError('AUTH_REQUIRED', '请先登录牛客网，再打开需要保存的面经详情页');
  }

  const content = firstWithin(document, CONTENT_SELECTORS) ?? scoredFallback(document);
  const title =
    elementText(firstWithin(document, TITLE_SELECTORS)) ||
    elementText(document.querySelector('title'));

  if (!content || !title || elementText(content).length < 40) {
    throw new ExtractionError(
      'UNSUPPORTED_LAYOUT',
      '请在牛客网打开一篇面经或讨论的详情页后重试',
    );
  }

  const time = firstWithin(document, TIME_SELECTORS);
  const author = elementText(firstWithin(document, AUTHOR_SELECTORS));
  const publishedAt = parsePublishedAt(elementText(time), time?.getAttribute('datetime'));
  return buildDocument({
    source: 'nowcoder',
    kind: 'post',
    title,
    content,
    url,
    now,
    ...(author ? { author } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  });
}
