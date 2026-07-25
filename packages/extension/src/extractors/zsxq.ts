import { buildDocument, cleanText, elementText, parsePublishedAt } from './common.js';
import { ExtractionError, type Clock } from './types.js';

const LOGIN_SELECTORS = [
  '.login-container',
  '.login-page',
  'app-login',
  'form[action*="login"]',
];

/** 真实 DOM（Angular）：每条帖子是一个 .topic-container；详情页只有一个，列表页有多个。 */
const TOPIC_CONTAINER = '.topic-container';

/** 正文容器（按可靠性排序）。评论区在 .topic-container 内、正文容器外，取正文容器可天然排除评论。 */
const CONTENT_SELECTORS = [
  '.talk-content-container',
  '.article-content-container',
  '.q-content-container',
  '.content',
];

const AUTHOR_SELECTORS = ['.author-name', '.user-name', '.name', '.nickname'];
const TIME_SELECTORS = ['time', '.create-time', '.time', '[class*="create-time"]'];

function firstWithin(root: ParentNode, selectors: string[]): Element | null {
  for (const selector of selectors) {
    const element = root.querySelector(selector);
    if (element) return element;
  }
  return null;
}

/** 详情页地址形如 /group/<群号>/topic/<帖子号>；列表/分类/精华页没有 /topic/ 段。 */
export function isTopicDetail(url: URL): boolean {
  return /\/topic\/[^/]+/.test(url.pathname);
}

/**
 * 星球动态多数没有标题。用正文首句兜底，保证归档条目有可读标题
 * （站点 <title> 恒为「<星球名>-知识星球」，不能当文章标题用）。
 */
function deriveTitle(content: Element, document: Document): string {
  const explicit = elementText(firstWithin(content, ['h1', 'h2', '.title', '[class*="title"]']));
  if (explicit) return explicit.slice(0, 80);
  const body = elementText(content);
  if (body) {
    const firstSentence = body
      .split(/[。！？!?\n]/)
      .map(part => cleanText(part))
      .find(part => part.length >= 4);
    return (firstSentence ?? body).slice(0, 60);
  }
  return cleanText(document.title);
}

export function extractZsxq(document: Document, url: URL, now: Clock) {
  if (LOGIN_SELECTORS.some(selector => document.querySelector(selector))) {
    throw new ExtractionError('AUTH_REQUIRED', '请先登录知识星球，再打开需要保存的单条内容');
  }

  const containers = [...document.querySelectorAll(TOPIC_CONTAINER)];

  // 列表 / 分类 / 精华页：页面上有多条帖子，采集哪一条无法判断。
  // 绝不能把整个信息流当成一篇存下来，因此明确要求打开单条详情页。
  if (!isTopicDetail(url)) {
    throw new ExtractionError(
      'UNSUPPORTED_LAYOUT',
      containers.length > 1
        ? `当前是列表页（本页有 ${containers.length} 条帖子）。请点开某条帖子的详情页（地址形如 /topic/…）后再保存。`
        : '请在知识星球中打开一篇帖子的详情页（地址形如 /topic/…）后重试',
    );
  }

  const container = containers[0] ?? document.body;
  const content = firstWithin(container, CONTENT_SELECTORS) ?? container;
  const text = elementText(content);
  if (!text || text.length < 20) {
    throw new ExtractionError(
      'CONTENT_EMPTY',
      '未读到帖子正文：请确认页面已加载完成（必要时先点开「展开全文」）后重试',
    );
  }

  const time = firstWithin(container, TIME_SELECTORS);
  const author = elementText(firstWithin(container, AUTHOR_SELECTORS));
  const publishedAt = parsePublishedAt(elementText(time), time?.getAttribute('datetime'));
  return buildDocument({
    source: 'zsxq',
    kind: 'post',
    title: deriveTitle(content, document),
    content,
    url,
    now,
    ...(author ? { author } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  });
}
