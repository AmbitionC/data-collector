import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const WECHAT_HOST = 'mp.weixin.qq.com';
const ZSXQ_HOST = 'wx.zsxq.com';
const WECHAT_IDENTITY_PARAMS = new Set(['__biz', 'mid', 'idx', 'sn', 'chksm']);
const ZSXQ_IDENTITY_PARAMS = new Set([
  'topic_id',
  'group_id',
  'article_id',
  'question_id',
  'answer_id',
]);

export function parseSupportedUrl(raw: string): URL {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const supportedHost =
      host === WECHAT_HOST || host === ZSXQ_HOST || host.endsWith('.zsxq.com');
    if (url.protocol !== 'https:' || !supportedHost) {
      throw new Error('unsupported');
    }
    url.hostname = host;
    return url;
  } catch {
    throw new Error('不支持的采集地址：仅支持微信公众号和知识星球 HTTPS 页面');
  }
}

export function canonicalizeUrl(input: URL): URL {
  const url = parseSupportedUrl(input.href);
  url.hash = '';
  const allowlist =
    url.hostname === WECHAT_HOST ? WECHAT_IDENTITY_PARAMS : ZSXQ_IDENTITY_PARAMS;
  const kept = [...url.searchParams.entries()]
    .filter(([key]) => allowlist.has(key))
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
  url.search = '';
  for (const [key, value] of kept) url.searchParams.append(key, value);
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

export function stableContentId(input: URL | string): string {
  const url = typeof input === 'string' ? parseSupportedUrl(input) : input;
  return bytesToHex(sha256(new TextEncoder().encode(canonicalizeUrl(url).href))).slice(
    0,
    12,
  );
}
