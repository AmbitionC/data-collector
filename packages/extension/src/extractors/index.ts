import {
  descriptorForHost,
  parseSupportedUrl,
  type CollectedDocument,
  type Source,
} from '@data-collector/shared';
import { ExtractionError, type Clock } from './types.js';
import { extractNowcoder } from './nowcoder.js';
import { extractWechat } from './wechat.js';
import { extractZsxq } from './zsxq.js';

export { ExtractionError } from './types.js';

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
      return extractZsxq(document, url, now);
    case 'nowcoder':
      return extractNowcoder(document, url, now);
  }
}
