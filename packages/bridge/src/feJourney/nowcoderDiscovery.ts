import { canonicalizeUrl } from '@data-collector/shared';
import { FE_JOURNEY_PRESET } from './preset.js';
import type { NowcoderCompany } from './nowcoderEvidence.js';

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

async function searchDetailUrls(fetcher: typeof fetch, query: string): Promise<string[]> {
  const searchUrl = new URL('https://www.nowcoder.com/search');
  searchUrl.searchParams.set('query', query);
  searchUrl.searchParams.set('type', 'post');
  const response = await fetcher(searchUrl, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': 'data-collector-fe-journey/1.0',
    },
  });
  if (!response.ok) throw new Error(`牛客搜索请求失败（${query}）：HTTP ${response.status}`);
  const html = await response.text();
  const urls: string[] = [];
  for (const match of html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)) {
    const raw = match[1];
    if (!raw) continue;
    const canonical = canonicalNowcoderDetail(raw, searchUrl);
    if (canonical) urls.push(canonical);
  }
  return urls;
}

export interface NowcoderDiscoveryCandidate {
  url: string;
  queryCompany: NowcoderCompany;
}

/** 为每日计划发现带查询公司证据的候选；每家公司最多保留 15 条，不跨公司补位。 */
export async function discoverNowcoderPlanCandidates(
  fetcher: typeof fetch,
  knownUrls: ReadonlySet<string>,
): Promise<NowcoderDiscoveryCandidate[]> {
  const known = normalizedKnownUrls(knownUrls);
  const seen = new Set(known);
  const perCompany = new Map<NowcoderCompany, number>();
  const candidates: NowcoderDiscoveryCandidate[] = [];
  for (const item of FE_JOURNEY_PRESET.nowcoder.companyQueries) {
    if (candidates.length >= FE_JOURNEY_PRESET.nowcoder.planDiscoveryLimit) break;
    const company = item.company as NowcoderCompany;
    if ((perCompany.get(company) ?? 0) >= FE_JOURNEY_PRESET.nowcoder.planPerCompanyDiscoveryLimit) {
      continue;
    }
    for (const url of await searchDetailUrls(fetcher, item.query)) {
      if (seen.has(url)) continue;
      if ((perCompany.get(company) ?? 0) >= FE_JOURNEY_PRESET.nowcoder.planPerCompanyDiscoveryLimit) {
        break;
      }
      seen.add(url);
      candidates.push({ url, queryCompany: company });
      perCompany.set(company, (perCompany.get(company) ?? 0) + 1);
      if (candidates.length >= FE_JOURNEY_PRESET.nowcoder.planDiscoveryLimit) break;
    }
  }
  return candidates;
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
    for (const canonical of await searchDetailUrls(fetcher, query)) {
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      discovered.push(canonical);
      if (discovered.length >= FE_JOURNEY_PRESET.nowcoder.maxPerRun) return discovered;
    }
  }

  return discovered;
}
