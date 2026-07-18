import { buildDocument, elementText, parsePublishedAt } from './common.js';
import { ExtractionError, type Clock } from './types.js';

function pageVariable(document: Document, name: 'msg_title' | 'nickname' | 'ct'): string {
  const pattern = new RegExp(`(?:var\\s+)?${name}\\s*=\\s*(["'])(.*?)\\1`);
  for (const script of document.querySelectorAll('script')) {
    const match = script.textContent?.match(pattern);
    if (match?.[2]) return match[2].replace(/\\([\\"'])/g, '$1').trim();
  }
  return '';
}

function epochSeconds(value: string): string | undefined {
  if (!/^\d{9,12}$/.test(value)) return undefined;
  const date = new Date(Number(value) * 1_000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function extractWechat(document: Document, url: URL, now: Clock) {
  const content = document.querySelector('#js_content');
  const title =
    elementText(document.querySelector('#activity-name')) ||
    elementText(document.querySelector('h1')) ||
    elementText(document.querySelector('title')) ||
    pageVariable(document, 'msg_title');

  if (!content || !title || elementText(content).length < 40) {
    throw new ExtractionError('CONTENT_EMPTY', '未找到可保存的公众号正文');
  }

  const time = document.querySelector('time#publish_time, #publish_time');
  const author = elementText(document.querySelector('#js_name')) || pageVariable(document, 'nickname');
  const publishedAt =
    parsePublishedAt(elementText(time), time?.getAttribute('datetime')) ||
    epochSeconds(pageVariable(document, 'ct'));
  return buildDocument({
    source: 'wechat',
    kind: 'article',
    title,
    content,
    url,
    now,
    ...(author ? { author } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  });
}
