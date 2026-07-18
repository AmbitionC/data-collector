import { buildDocument, elementText, parsePublishedAt } from './common.js';
import { ExtractionError, type Clock } from './types.js';

const LOGIN_SELECTORS = [
  '[data-testid="login"]',
  '.login-container',
  '.login-page',
  'form[action*="login"]',
];

const ARTICLE_CONTAINERS = [
  '[data-testid="article-detail"]',
  '.article-detail',
  '[data-testid="topic-detail"]',
  '.topic-detail',
];

const CONTENT_SELECTORS = [
  '[data-testid="article-content"]',
  '.article-content',
  '[data-testid="topic-content"]',
  '.topic-content',
  '.content',
];

function firstWithin(root: ParentNode, selectors: string[]): Element | null {
  for (const selector of selectors) {
    const element = root.querySelector(selector);
    if (element) return element;
  }
  return null;
}

function findTitle(root: ParentNode, document: Document): string {
  return (
    elementText(firstWithin(root, ['[data-testid="topic-title"]', '.article-title', 'h1'])) ||
    elementText(document.querySelector('h1')) ||
    elementText(document.querySelector('title'))
  );
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
  return parts.join(' ').replace(/[\s\u00a0]+/g, ' ').trim();
}

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

export function extractZsxq(document: Document, url: URL, now: Clock) {
  if (LOGIN_SELECTORS.some(selector => document.querySelector(selector))) {
    throw new ExtractionError('AUTH_REQUIRED', '请先登录知识星球，再打开需要保存的单条内容');
  }

  const question = firstWithin(document, [
    '[data-testid="question-detail"]',
    '.question-detail',
  ]);
  if (question) {
    const questionContent = firstWithin(question, ['.question-content']);
    const answers = [...question.querySelectorAll('.answer-content')];
    if (!questionContent) {
      throw new ExtractionError('CONTENT_EMPTY', '未找到问题正文');
    }
    const combined = document.createElement('div');
    combined.append(questionContent.cloneNode(true));
    for (const answer of answers) combined.append(answer.cloneNode(true));
    return buildDocument({
      source: 'zsxq',
      kind: 'question',
      title: findTitle(question, document),
      content: combined,
      url,
      now,
      author: elementText(firstWithin(question, ['[data-testid="author-name"]', '.author-name'])),
      sourceMetadata: { answerCount: answers.length },
    });
  }

  const detail = firstWithin(document, ARTICLE_CONTAINERS);
  const content = (detail && firstWithin(detail, CONTENT_SELECTORS)) || scoredFallback(document);
  const titleRoot = detail ?? content;
  const title = titleRoot ? findTitle(titleRoot, document) : '';
  if (!content || !title || elementText(content).length < 20) {
    throw new ExtractionError(
      'UNSUPPORTED_LAYOUT',
      '请在知识星球中打开一篇文章、动态或问答的详情页后重试',
    );
  }

  const time = (detail ?? content).querySelector('time');
  const author = elementText(
    firstWithin(detail ?? content, ['[data-testid="author-name"]', '.author-name', '.name']),
  );
  const publishedAt = parsePublishedAt(elementText(time), time?.getAttribute('datetime'));
  return buildDocument({
    source: 'zsxq',
    kind: detail?.matches('[data-testid="article-detail"], .article-detail') ? 'article' : 'post',
    title,
    content,
    url,
    now,
    ...(author ? { author } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  });
}
