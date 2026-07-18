import { buildDocument, elementText, parsePublishedAt } from './common.js';
import { ExtractionError, type Clock } from './types.js';

export function extractWechat(document: Document, url: URL, now: Clock) {
  const content = document.querySelector('#js_content');
  const title =
    elementText(document.querySelector('#activity-name')) ||
    elementText(document.querySelector('h1')) ||
    elementText(document.querySelector('title'));

  if (!content || !title || elementText(content).length < 40) {
    throw new ExtractionError('CONTENT_EMPTY', '未找到可保存的公众号正文');
  }

  const time = document.querySelector('time#publish_time, #publish_time');
  const author = elementText(document.querySelector('#js_name'));
  const publishedAt = parsePublishedAt(elementText(time), time?.getAttribute('datetime'));
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
