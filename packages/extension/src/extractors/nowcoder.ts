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

// 顺序：feed/main/detail 的真实正文容器优先，其后是讨论区/其它页型与通用兜底。
const CONTENT_SELECTORS = [
  '.feed-content-text',
  '.post-topic-des',
  '.nc-post-content',
  '.js-post-content',
  '.feed-content-detail',
  '.discuss-main',
  '[class*="feed-content"]',
  '[class*="post-content"]',
  'article',
];

// feed/main/detail 的图片画廊与正文是兄弟节点，采集时并入正文一起提取。
const GALLERY_SELECTORS = ['.feed-img', '[class*="feed-img"]', '.feed-content-imgs'];

const AUTHOR_SELECTORS = [
  '.user-nickname .name-text',
  '.name-text',
  '.js-nc-wrap-link .name',
  '.feed-nickname',
  '.author-name',
  '.nc-user-name',
  '[class*="nickname"]',
  '[class*="author-name"]',
];

const TIME_SELECTORS = [
  '.time-text',
  'time',
  '.post-time',
  '.feed-time',
  '[class*="post-time"]',
];

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

/**
 * 牛客时间戳常见三种：ISO / `YYYY-MM-DD HH:MM` / 当年帖子的 `MM-DD HH:MM`（无年份）。
 * 前两种交给通用解析；最后一种按采集年份补齐，若补出的时间明显晚于当下则回退到上一年
 *（跨年边界，例如 12 月的帖子在次年 1 月采集）。
 */
function nowcoderPublishedAt(raw: string, datetime: string | null, nowIso: string): string | undefined {
  // 有 ISO datetime 属性时优先用它。
  if (datetime && datetime.includes('T')) {
    const exact = parsePublishedAt(raw, datetime);
    if (exact) return exact;
  }
  // 当年 `MM-DD HH:MM`（无年份）先于通用解析处理——通用解析会把它误判成含糊日期。
  const match = raw.match(/^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (match) {
    const [, month, day, hour, minute] = match;
    const now = new Date(nowIso);
    const build = (year: number): Date =>
      new Date(
        `${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}T${hour!.padStart(2, '0')}:${minute}:00+08:00`,
      );
    let date = build(now.getUTCFullYear());
    if (Number.isNaN(date.getTime())) return undefined;
    if (date.getTime() > now.getTime() + 2 * 86_400_000) date = build(now.getUTCFullYear() - 1);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  // 其它格式（ISO / `YYYY-MM-DD HH:MM` / 中文日期）交给通用解析。
  return parsePublishedAt(raw, datetime);
}

/** 若正文命中语义容器，且同一区块存在图片画廊（feed/main/detail 中与正文并列），并入一起提取。 */
function withGallery(document: Document, content: Element): Element {
  const region = content.closest('section, article') ?? content.parentElement;
  const gallery = region ? firstWithin(region, GALLERY_SELECTORS) : null;
  if (!gallery || gallery === content || content.contains(gallery)) return content;
  const combined = document.createElement('div');
  combined.append(content.cloneNode(true));
  combined.append(gallery.cloneNode(true));
  return combined;
}

export function extractNowcoder(document: Document, url: URL, now: Clock) {
  if (LOGIN_SELECTORS.some(selector => document.querySelector(selector))) {
    throw new ExtractionError('AUTH_REQUIRED', '请先登录牛客网，再打开需要保存的面经详情页');
  }

  const primary = firstWithin(document, CONTENT_SELECTORS);
  const content = primary ? withGallery(document, primary) : scoredFallback(document);
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
  const publishedAt = nowcoderPublishedAt(
    elementText(time),
    time?.getAttribute('datetime') ?? null,
    now(),
  );
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
