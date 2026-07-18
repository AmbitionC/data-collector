import { parseSupportedUrl, type CollectedDocument, type Source } from '@data-collector/shared';
import { ExtractionError, type Clock } from './types.js';
import { extractWechat } from './wechat.js';
import { extractZsxq } from './zsxq.js';

export { ExtractionError } from './types.js';

export function detectSource(url: URL): Source {
  if (url.hostname === 'mp.weixin.qq.com') return 'wechat';
  if (url.hostname === 'wx.zsxq.com' || url.hostname.endsWith('.zsxq.com')) return 'zsxq';
  throw new ExtractionError('UNSUPPORTED_URL', '当前页面不是微信公众号或知识星球内容');
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
    throw new ExtractionError('UNSUPPORTED_URL', '当前页面不是微信公众号或知识星球内容');
  }
  return detectSource(url) === 'wechat'
    ? extractWechat(document, url, now)
    : extractZsxq(document, url, now);
}
