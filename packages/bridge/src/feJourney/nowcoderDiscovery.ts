import { canonicalizeUrl } from '@data-collector/shared';
import { FE_JOURNEY_PRESET } from './preset.js';
import type { NowcoderCompany } from './nowcoderEvidence.js';

const DETAIL_PATH = /^\/(?:discuss\/\d+|feed\/main\/detail\/[A-Za-z0-9_-]+)\/?$/;
const JSON_SEARCH_URL = 'https://gw-c.nowcoder.com/api/sparta/pc/search';
const SEARCH_TIMEOUT_MS = 8_000;
const SEARCH_PAGE_LIMIT = 2;
const SEARCH_CONCURRENCY = 2;
const NOWCODER_COMPANIES: readonly NowcoderCompany[] = [
  'bytedance', 'tencent', 'alibaba', 'ant', 'other',
];

const COMPANY_SIGNALS: Readonly<Record<NowcoderCompany, RegExp>> = Object.freeze({
  bytedance: /字节跳动|字节|抖音|TikTok|火山引擎/iu,
  tencent: /腾讯|微信支付|微信|\bWXG\b|\bTEG\b/iu,
  alibaba: /阿里云|阿里巴巴|阿里|淘天|淘宝|天猫/iu,
  ant: /蚂蚁集团|蚂蚁|支付宝|Alipay/iu,
  other: /拼多多|PDD|小红书|REDnote|月之暗面|Moonshot|Kimi|百度|Baidu|华为|Huawei|快手|Kuaishou|OPPO|欧珀/iu,
});
const AGENT_SIGNALS = /Agent|智能体|AI\s*应用|AI\s*工程|大模型|RAG|MCP/iu;
const INTERVIEW_SIGNALS = /面经|面试|一面|二面|三面|四面|五面|终面|技术面|HR\s*面/iu;

interface SearchHit {
  url: string;
  title: string;
  content: string;
  createTime: number;
}

interface PooledSearchHit extends SearchHit {
  firstSeen: number;
  queryCompanies: Set<NowcoderCompany>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Discovery currently has no caller-level signal, but this helper preserves one if added to the
 * request init: external cancellation is forwarded into the timeout controller rather than
 * overwritten. The abort promise also makes the deadline work with injected test fetchers that
 * accept `signal` but do not implement its cancellation semantics.
 */
async function fetchWithTimeout(
  fetcher: typeof fetch,
  input: string | URL,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const externalSignal = init.signal;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = (): void => {
    rejectAbort(controller.signal.reason instanceof Error
      ? controller.signal.reason
      : new Error('牛客搜索请求已中止'));
  };
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const forwardExternalAbort = (): void => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) forwardExternalAbort();
  else externalSignal?.addEventListener('abort', forwardExternalAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error(`牛客搜索请求超时（${SEARCH_TIMEOUT_MS}ms）`)),
    SEARCH_TIMEOUT_MS,
  );

  try {
    return await Promise.race([
      Promise.resolve().then(() => fetcher(input, { ...init, signal: controller.signal })),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
    externalSignal?.removeEventListener('abort', forwardExternalAbort);
  }
}

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

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function searchJsonPage(
  fetcher: typeof fetch,
  query: string,
  page: number,
): Promise<{ hits: SearchHit[]; totalPage: number }> {
  const response = await fetchWithTimeout(fetcher, JSON_SEARCH_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'data-collector-fe-journey/1.0',
    },
    body: JSON.stringify({ type: 'post', query, order: 'create', page }),
  });
  if (!response.ok) throw new Error(`JSON API HTTP ${response.status}`);
  const payload = recordValue(await response.json());
  const data = recordValue(payload?.data);
  if (payload?.success !== true || payload.code !== 0 || !data || !Array.isArray(data.records)) {
    throw new Error('JSON API 返回格式异常');
  }
  const base = new URL('https://www.nowcoder.com/');
  const hits: SearchHit[] = [];
  for (const rawRecord of data.records) {
    const contentData = recordValue(recordValue(rawRecord)?.contentData);
    if (!contentData) continue;
    const id = typeof contentData.id === 'string' || typeof contentData.id === 'number'
      ? String(contentData.id)
      : '';
    const url = canonicalNowcoderDetail(`/discuss/${id}`, base);
    if (!url) continue;
    hits.push({
      url,
      title: stringValue(contentData.title),
      content: stringValue(contentData.content),
      createTime: typeof contentData.createTime === 'number' && Number.isFinite(contentData.createTime)
        ? contentData.createTime
        : 0,
    });
  }
  const totalPage = typeof data.totalPage === 'number' && Number.isSafeInteger(data.totalPage)
    ? Math.max(1, data.totalPage)
    : page;
  return { hits, totalPage };
}

async function searchSsrPage(fetcher: typeof fetch, query: string): Promise<SearchHit[]> {
  const searchUrl = new URL('https://www.nowcoder.com/search');
  searchUrl.searchParams.set('query', query);
  searchUrl.searchParams.set('type', 'post');
  const response = await fetchWithTimeout(fetcher, searchUrl, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': 'data-collector-fe-journey/1.0',
    },
  });
  if (!response.ok) throw new Error(`牛客搜索请求失败（${query}）：HTTP ${response.status}`);
  const html = await response.text();
  const hits: SearchHit[] = [];
  for (const match of html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)) {
    const raw = match[1];
    if (!raw) continue;
    const canonical = canonicalNowcoderDetail(raw, searchUrl);
    if (canonical) hits.push({ url: canonical, title: '', content: '', createTime: 0 });
  }
  return hits;
}

async function searchDetailHits(fetcher: typeof fetch, query: string): Promise<SearchHit[]> {
  const apiHits: SearchHit[] = [];
  try {
    for (let page = 1; page <= SEARCH_PAGE_LIMIT; page += 1) {
      const result = await searchJsonPage(fetcher, query, page);
      apiHits.push(...result.hits);
      if (result.hits.length === 0 || page >= result.totalPage) break;
    }
    return apiHits;
  } catch (apiError) {
    try {
      return [...apiHits, ...await searchSsrPage(fetcher, query)];
    } catch (ssrError) {
      throw new Error(
        `牛客搜索请求失败（${query}）：API ${errorMessage(apiError)}；SSR ${errorMessage(ssrError)}`,
      );
    }
  }
}

async function searchPair<T extends { query: string }>(
  fetcher: typeof fetch,
  items: readonly T[],
): Promise<Array<{ item: T; hits: SearchHit[] }>> {
  if (items.length > SEARCH_CONCURRENCY) throw new Error('牛客搜索并发批次超过上限');
  return await Promise.all(items.map(async item => ({
    item,
    hits: await searchDetailHits(fetcher, item.query),
  })));
}

function mergeSearchHit(existing: PooledSearchHit, incoming: SearchHit): void {
  if (incoming.title.length > existing.title.length) existing.title = incoming.title;
  if (incoming.content.length > existing.content.length) existing.content = incoming.content;
  existing.createTime = Math.max(existing.createTime, incoming.createTime);
}

function hitText(hit: SearchHit): string {
  return `${hit.title}\n${hit.content}`;
}

function matchingCompanies(text: string): NowcoderCompany[] {
  return NOWCODER_COMPANIES.filter(company => COMPANY_SIGNALS[company].test(text));
}

function relevanceScore(hit: SearchHit, company: NowcoderCompany): number {
  const titleMatches = matchingCompanies(hit.title);
  const bodyMatches = matchingCompanies(hit.content);
  const text = hitText(hit);
  let score = titleMatches.includes(company) ? 12 : bodyMatches.includes(company) ? 5 : 0;
  if (titleMatches.length > 0 && !titleMatches.includes(company)) score -= 12;
  else if (bodyMatches.length > 0 && !bodyMatches.includes(company)) score -= 5;
  if (AGENT_SIGNALS.test(text)) score += 4;
  if (INTERVIEW_SIGNALS.test(text)) score += 2;
  return score;
}

function qualifiedRelevance(hit: SearchHit, company: NowcoderCompany): boolean {
  const companyMatched = COMPANY_SIGNALS[company].test(hit.title)
    || COMPANY_SIGNALS[company].test(hit.content);
  const text = hitText(hit);
  return companyMatched && AGENT_SIGNALS.test(text) && INTERVIEW_SIGNALS.test(text);
}

function bestCompany(hit: PooledSearchHit): NowcoderCompany {
  const titleMatches = matchingCompanies(hit.title);
  const bodyMatches = matchingCompanies(hit.content);
  const explicit = titleMatches.length > 0 ? titleMatches : bodyMatches;
  const choices = explicit.length > 0 ? explicit : [...hit.queryCompanies];
  return choices.sort((left, right) => {
    const scoreDifference = relevanceScore(hit, right) - relevanceScore(hit, left);
    return scoreDifference || NOWCODER_COMPANIES.indexOf(left) - NOWCODER_COMPANIES.indexOf(right);
  })[0] ?? 'bytedance';
}

export interface NowcoderDiscoveryCandidate {
  url: string;
  queryCompany: NowcoderCompany;
}

/** 为每日计划发现带查询公司证据的候选；汇总全部固定查询后再按相关性与时间取每公司前 15。 */
export async function discoverNowcoderPlanCandidates(
  fetcher: typeof fetch,
  knownUrls: ReadonlySet<string>,
): Promise<NowcoderDiscoveryCandidate[]> {
  const known = normalizedKnownUrls(knownUrls);
  const pool = new Map<string, PooledSearchHit>();
  let firstSeen = 0;
  const items = FE_JOURNEY_PRESET.nowcoder.companyQueries;
  for (let index = 0; index < items.length; index += SEARCH_CONCURRENCY) {
    const pair = items.slice(index, index + SEARCH_CONCURRENCY);
    for (const { item, hits } of await searchPair(fetcher, pair)) {
      const company = item.company as NowcoderCompany;
      for (const hit of hits) {
        if (known.has(hit.url)) continue;
        const existing = pool.get(hit.url);
        if (existing) {
          existing.queryCompanies.add(company);
          mergeSearchHit(existing, hit);
          continue;
        }
        pool.set(hit.url, {
          ...hit,
          firstSeen: firstSeen++,
          queryCompanies: new Set([company]),
        });
      }
    }
  }

  const grouped = new Map<NowcoderCompany, PooledSearchHit[]>(
    NOWCODER_COMPANIES.map(company => [company, []]),
  );
  for (const hit of pool.values()) grouped.get(bestCompany(hit))?.push(hit);

  return NOWCODER_COMPANIES.flatMap(company => (grouped.get(company) ?? [])
    .sort((left, right) => (
      Number(qualifiedRelevance(right, company)) - Number(qualifiedRelevance(left, company))
      || (qualifiedRelevance(left, company) ? right.createTime - left.createTime : 0)
      || relevanceScore(right, company) - relevanceScore(left, company)
      || right.createTime - left.createTime
      || left.firstSeen - right.firstSeen
      || left.url.localeCompare(right.url)
    ))
    .slice(0, FE_JOURNEY_PRESET.nowcoder.planPerCompanyDiscoveryLimit)
    .map(hit => ({ url: hit.url, queryCompany: company })))
    .slice(0, FE_JOURNEY_PRESET.nowcoder.planDiscoveryLimit);
}

/** 从固定牛客公开搜索页发现详情地址；不接受外部主机或可编辑查询。 */
export async function discoverNowcoderUrls(
  fetcher: typeof fetch,
  knownUrls: ReadonlySet<string>,
): Promise<string[]> {
  const known = normalizedKnownUrls(knownUrls);
  const discovered: string[] = [];
  const seen = new Set(known);

  const queries = FE_JOURNEY_PRESET.nowcoder.queries.map(query => ({ query }));
  for (let index = 0; index < queries.length; index += SEARCH_CONCURRENCY) {
    const pair = queries.slice(index, index + SEARCH_CONCURRENCY);
    for (const { hits } of await searchPair(fetcher, pair)) {
      for (const hit of hits) {
        if (seen.has(hit.url)) continue;
        seen.add(hit.url);
        discovered.push(hit.url);
        if (discovered.length >= FE_JOURNEY_PRESET.nowcoder.maxPerRun) return discovered;
      }
    }
  }

  return discovered;
}
