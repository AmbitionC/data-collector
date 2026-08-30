import {
  canonicalizeUrl,
  nowcoderSearchRequestSchema,
  stableContentId,
  type NowcoderSearchCandidate,
  type NowcoderSearchRequest,
} from '@data-collector/shared';

const JSON_SEARCH_URL = 'https://gw-c.nowcoder.com/api/sparta/pc/search';
const DETAIL_PATH = /^\/(?:discuss\/\d+|feed\/main\/detail\/[A-Za-z0-9_-]+)\/?$/u;
const QUERY_CONCURRENCY = 2;
const SEARCH_TIMEOUT_MS = 8_000;

export interface NowcoderDirectedSearchAudit {
  provider: 'nowcoder-json';
  requestedSort: 'latest';
  order: 'create';
  sortVerified: true;
  codexBrowserUse: false;
}

export interface NowcoderDirectedPreviewOnlyCandidate {
  canonicalUrl: string;
  query: string;
  page: number;
  rank: number;
  reason: 'missing_published_at' | 'invalid_published_at';
}

export interface NowcoderDirectedDiscoveryResult {
  candidates: NowcoderSearchCandidate[];
  previewOnly: NowcoderDirectedPreviewOnlyCandidate[];
  audit: NowcoderDirectedSearchAudit;
}

interface SearchRecord {
  id?: unknown;
  url?: unknown;
  detailUrl?: unknown;
  detailURL?: unknown;
  link?: unknown;
  contentUrl?: unknown;
  contentURL?: unknown;
  targetUrl?: unknown;
  targetURL?: unknown;
  createTime?: unknown;
  publishTime?: unknown;
  publishedAt?: unknown;
}

interface ParsedHit {
  canonicalUrl: string;
  query: string;
  queryIndex: number;
  page: number;
  rank: number;
  publishedAt?: string;
  previewReason?: NowcoderDirectedPreviewOnlyCandidate['reason'];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function canonicalDetailUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const url = new URL(value.replaceAll('&amp;', '&'), 'https://www.nowcoder.com/');
    if (url.protocol !== 'https:' || (url.hostname !== 'www.nowcoder.com' && url.hostname !== 'nowcoder.com')) {
      return undefined;
    }
    if (!DETAIL_PATH.test(url.pathname)) return undefined;
    url.hostname = 'www.nowcoder.com';
    return canonicalizeUrl(url).href;
  } catch {
    return undefined;
  }
}

function responseUrl(content: SearchRecord): string | undefined {
  const values = [content.url, content.detailUrl, content.detailURL, content.link, content.contentUrl,
    content.contentURL, content.targetUrl, content.targetURL];
  const returned = values.map(canonicalDetailUrl).find((value): value is string => value !== undefined);
  if (returned) return returned;
  if (values.some(value => typeof value === 'string')) return undefined;
  if (typeof content.id !== 'string' && typeof content.id !== 'number') return undefined;
  return canonicalDetailUrl(`/discuss/${content.id}`);
}

async function fetchWithTimeout(fetcher: typeof fetch, input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = (): void => rejectAbort(controller.signal.reason instanceof Error
    ? controller.signal.reason
    : new Error('牛客搜索请求已中止'));
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`牛客搜索请求超时（${SEARCH_TIMEOUT_MS}ms）`)), SEARCH_TIMEOUT_MS);
  try {
    return await Promise.race([Promise.resolve().then(() => fetcher(input, { ...init, signal: controller.signal })), aborted]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

function parsePublishedAt(content: SearchRecord): { value?: string; reason?: NowcoderDirectedPreviewOnlyCandidate['reason'] } {
  const raw = content.createTime ?? content.publishTime ?? content.publishedAt;
  if (raw === undefined || raw === null || raw === '') return { reason: 'missing_published_at' };
  const number = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(number) || number <= 0) return { reason: 'invalid_published_at' };
  const milliseconds = number < 100_000_000_000 ? number * 1_000 : number;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return { reason: 'invalid_published_at' };
  return { value: date.toISOString() };
}

async function searchJsonPage(
  fetcher: typeof fetch,
  query: string,
  queryIndex: number,
  page: number,
): Promise<{ totalPage: number; hits: ParsedHit[] }> {
  let response: Response;
  try {
    response = await fetchWithTimeout(fetcher, JSON_SEARCH_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'post', query, order: 'create', page }),
    });
  } catch (error) {
    throw new Error(`无法验证最新排序：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`无法验证最新排序：JSON API HTTP ${response.status}`);
  let payload: Record<string, unknown> | undefined;
  try {
    payload = record(await response.json());
  } catch {
    throw new Error('无法验证最新排序：JSON API 返回格式异常');
  }
  const data = record(payload?.data);
  if (payload?.success !== true || payload.code !== 0 || !data || !Array.isArray(data.records)
    || typeof data.totalPage !== 'number' || !Number.isSafeInteger(data.totalPage) || data.totalPage < 1) {
    throw new Error('无法验证最新排序：JSON API 返回格式异常');
  }
  const hits: ParsedHit[] = [];
  for (const [index, raw] of data.records.entries()) {
    const content = record(record(raw)?.contentData) as SearchRecord | undefined;
    if (!content) continue;
    const canonicalUrl = responseUrl(content);
    if (!canonicalUrl) continue;
    const published = parsePublishedAt(content);
    hits.push({
      canonicalUrl,
      query,
      queryIndex,
      page,
      rank: index + 1,
      ...(published.value ? { publishedAt: published.value } : {}),
      ...(published.reason ? { previewReason: published.reason } : {}),
    });
  }
  return { totalPage: data.totalPage, hits };
}

async function searchQuery(
  fetcher: typeof fetch,
  query: string,
  queryIndex: number,
): Promise<ParsedHit[]> {
  const first = await searchJsonPage(fetcher, query, queryIndex, 1);
  if (first.totalPage < 2) return first.hits;
  const second = await searchJsonPage(fetcher, query, queryIndex, 2);
  return [...first.hits, ...second.hits];
}

function originOrder(left: ParsedHit, right: ParsedHit): number {
  return left.queryIndex - right.queryIndex
    || left.page - right.page
    || left.rank - right.rank
    || left.canonicalUrl.localeCompare(right.canonicalUrl);
}

/**
 * Directed previews intentionally consume only a complete, verified JSON `order=create` envelope.
 * They never borrow the fixed-plan SSR fallback because that page cannot prove latest ordering.
 */
export async function discoverNowcoderDirectedCandidates(
  fetcher: typeof fetch,
  rawRequest: NowcoderSearchRequest,
  knownUrls: ReadonlySet<string>,
  _now: Date,
): Promise<NowcoderDirectedDiscoveryResult> {
  const request = nowcoderSearchRequestSchema.parse(rawRequest);
  const known = new Set([...knownUrls].map(canonicalDetailUrl).filter((value): value is string => value !== undefined));
  const hits: ParsedHit[] = [];
  for (let index = 0; index < request.queries.length; index += QUERY_CONCURRENCY) {
    const group = request.queries.slice(index, index + QUERY_CONCURRENCY);
    const found = await Promise.all(group.map(async (query, offset) => await searchQuery(fetcher, query, index + offset)));
    hits.push(...found.flat());
  }

  const deliverable = new Map<string, ParsedHit>();
  const previews = new Map<string, ParsedHit>();
  for (const hit of hits) {
    if (known.has(hit.canonicalUrl)) continue;
    if (!hit.publishedAt) {
      const existing = previews.get(hit.canonicalUrl);
      if (!existing || originOrder(hit, existing) < 0) previews.set(hit.canonicalUrl, hit);
      continue;
    }
    const existing = deliverable.get(hit.canonicalUrl);
    if (!existing) {
      deliverable.set(hit.canonicalUrl, hit);
      continue;
    }
    if ((hit.publishedAt > (existing.publishedAt ?? '')) || originOrder(hit, existing) < 0) {
      deliverable.set(hit.canonicalUrl, { ...hit, query: existing.query, queryIndex: existing.queryIndex, page: existing.page, rank: existing.rank });
    }
  }

  const candidates = [...deliverable.values()]
    .sort((left, right) => (right.publishedAt ?? '').localeCompare(left.publishedAt ?? '') || originOrder(left, right))
    .map(hit => ({
      id: stableContentId(hit.canonicalUrl),
      canonicalUrl: hit.canonicalUrl,
      contentType: 'post' as const,
      matchedQueries: [...new Set(hits.filter(other => other.canonicalUrl === hit.canonicalUrl).map(other => other.query))],
      page: hit.page,
      rank: hit.rank,
      publishedAt: hit.publishedAt as string,
    }));
  const previewOnly = [...previews.values()]
    .filter(hit => !deliverable.has(hit.canonicalUrl))
    .sort(originOrder)
    .map(hit => ({
      canonicalUrl: hit.canonicalUrl,
      query: hit.query,
      page: hit.page,
      rank: hit.rank,
      reason: hit.previewReason as NowcoderDirectedPreviewOnlyCandidate['reason'],
    }));
  return {
    candidates,
    previewOnly,
    audit: { provider: 'nowcoder-json', requestedSort: 'latest', order: 'create', sortVerified: true, codexBrowserUse: false },
  };
}
