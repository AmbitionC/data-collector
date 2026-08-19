import { canonicalizeUrl } from '@data-collector/shared';
import { FE_JOURNEY_PRESET } from './preset.js';

const DETAIL_PATH = /^\/(?:discuss\/\d+|feed\/main\/detail\/\d+)\/?$/;

function canonicalNowcoderDetail(raw: string, base: URL): string | undefined {
  try {
    const url = new URL(raw.replaceAll('&amp;', '&'), base);
    if (url.protocol !== 'https:') return undefined;
    if (url.hostname !== 'www.nowcoder.com' && url.hostname !== 'nowcoder.com') return undefined;
    if (!DETAIL_PATH.test(url.pathname)) return undefined;
    url.hostname = 'www.nowcoder.com';
    return canonicalizeUrl(url).href;
  } catch {
    return undefined;
  }
}

function normalizedKnownUrls(knownUrls: ReadonlySet<string>): Set<string> {
  const normalized = new Set<string>();
  for (const raw of knownUrls) {
    const url = canonicalNowcoderDetail(raw, new URL('https://www.nowcoder.com/'));
    if (url) normalized.add(url);
  }
  return normalized;
}

/** 从固定牛客公开搜索页发现详情地址；不接受外部主机或可编辑查询。 */
export async function discoverNowcoderUrls(
  fetcher: typeof fetch,
  knownUrls: ReadonlySet<string>,
): Promise<string[]> {
  const known = normalizedKnownUrls(knownUrls);
  const discovered: string[] = [];
  const seen = new Set(known);

  for (const query of FE_JOURNEY_PRESET.nowcoder.queries) {
    const searchUrl = new URL('https://www.nowcoder.com/search');
    searchUrl.searchParams.set('query', query);
    searchUrl.searchParams.set('type', 'post');
    const response = await fetcher(searchUrl, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'data-collector-fe-journey/1.0',
      },
    });
    if (!response.ok) {
      throw new Error(`牛客搜索请求失败（${query}）：HTTP ${response.status}`);
    }
    const html = await response.text();
    for (const match of html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)) {
      const raw = match[1];
      if (!raw) continue;
      const canonical = canonicalNowcoderDetail(raw, searchUrl);
      if (!canonical || seen.has(canonical)) continue;
      seen.add(canonical);
      discovered.push(canonical);
      if (discovered.length >= FE_JOURNEY_PRESET.nowcoder.maxPerRun) return discovered;
    }
  }

  return discovered;
}
