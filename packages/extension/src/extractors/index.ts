import {
  descriptorForHost,
  parseSupportedUrl,
  type CollectedDocument,
  type Source,
} from '@data-collector/shared';
import type { TopicIndex } from '../topicIndex.js';
import { ExtractionError, type Clock } from './types.js';
import { extractNowcoder } from './nowcoder.js';
import { extractWechat } from './wechat.js';
import {
  extractZsxq,
  extractZsxqArticle,
  extractZsxqList,
  isZsxqArticle,
  type ListExtraction,
} from './zsxq.js';

export { ExtractionError } from './types.js';
export {
  COLLECTED_ATTRIBUTE,
  ZSXQ_EXPAND_CONTROL_SELECTOR,
  KEY_ATTRIBUTE,
  isZsxqExpandControl,
  isZsxqArticle,
  linkedArticleUrl,
  listBodyText,
  pendingTopicCount,
  zsxqExpandLabel,
} from './zsxq.js';
export type { ListEntry, ListExtraction } from './zsxq.js';

/** 列表页批量提取（当前仅知识星球有列表形态）。 */
export function extractList(
  document: Document,
  rawUrl: string,
  topics?: TopicIndex,
  now: Clock = () => new Date().toISOString(),
): ListExtraction {
  let url: URL;
  try {
    url = parseSupportedUrl(rawUrl);
  } catch {
    throw new ExtractionError('UNSUPPORTED_URL', UNSUPPORTED_MESSAGE);
  }
  if (detectSource(url) !== 'zsxq') {
    throw new ExtractionError('UNSUPPORTED_LAYOUT', '当前来源不支持列表页批量采集');
  }
  return extractZsxqList(document, url, now, topics);
}

const UNSUPPORTED_MESSAGE = '当前页面不是微信公众号、知识星球或牛客网内容';

export function detectSource(url: URL): Source {
  const descriptor = descriptorForHost(url.hostname);
  if (!descriptor) throw new ExtractionError('UNSUPPORTED_URL', UNSUPPORTED_MESSAGE);
  return descriptor.id;
}

export function extractDocument(
  document: Document,
  rawUrl: string,
  now: Clock = () => new Date().toISOString(),
  topics?: TopicIndex,
  requireZsxqTopicEvidence = false,
): CollectedDocument {
  let url: URL;
  try {
    url = parseSupportedUrl(rawUrl);
  } catch {
    throw new ExtractionError('UNSUPPORTED_URL', UNSUPPORTED_MESSAGE);
  }
  switch (detectSource(url)) {
    case 'wechat':
      return extractWechat(document, url, now);
    case 'zsxq':
      // 长文页是独立形态：帖子在信息流里只有导语，正文在 articles.zsxq.com 上。
      return isZsxqArticle(url)
        ? extractZsxqArticle(document, url, now)
        : extractZsxq(document, url, now, topics, requireZsxqTopicEvidence);
    case 'nowcoder':
      return extractNowcoder(document, url, now);
    case 'github':
      throw new ExtractionError('UNSUPPORTED_LAYOUT', 'GitHub 项目由 fe-journey 定时任务采集');
  }
}
