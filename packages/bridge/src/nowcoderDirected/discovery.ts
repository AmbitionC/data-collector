import {
  nowcoderSearchRequestSchema, stableContentId,
  type NowcoderSearchCandidate, type NowcoderSearchRequest, type NowcoderSearchDiagnostics,
} from '@data-collector/shared';
import { canonicalNowcoderDetailUrl, normalizeNowcoderSearchRecord, objectRecord,
  type NormalizedNowcoderSearchRecord } from '../feJourney/nowcoderSearchRecord.js';
const JSON_SEARCH_URL = 'https://gw-c.nowcoder.com/api/sparta/pc/search';
const QUERY_CONCURRENCY = 2;
const SEARCH_TIMEOUT_MS = 8_000;
export interface NowcoderDirectedSearchAudit {
  provider: 'nowcoder-json'; requestedSort: 'latest'; order: 'create'; sortVerified: true; codexBrowserUse: false;
}
export interface NowcoderDirectedPreviewOnlyCandidate {
  canonicalUrl: string; query: string; page: number; rank: number; title?: string;
  reason: 'missing_published_at' | 'invalid_published_at';
}
export interface NowcoderDirectedDiscoveryResult {
  candidates: NowcoderSearchCandidate[]; previewOnly: NowcoderDirectedPreviewOnlyCandidate[];
  audit: NowcoderDirectedSearchAudit; diagnostics: NowcoderSearchDiagnostics;
}
interface ParsedHit extends NormalizedNowcoderSearchRecord {
  query: string; queryIndex: number; page: number; rank: number;
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


async function searchJsonPage(fetcher: typeof fetch, query: string, queryIndex: number, page: number) {
  let response: Response;
  try {
    response = await fetchWithTimeout(fetcher, JSON_SEARCH_URL, {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'post', query, order: 'create', page }),
    });
  } catch (error) {
    throw new Error(`无法验证最新排序：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`无法验证最新排序：JSON API HTTP ${response.status}`);
  let payload: Record<string, unknown> | undefined;
  try { payload = objectRecord(await response.json()); }
  catch { throw new Error('无法验证最新排序：JSON API 返回格式异常'); }
  const data = objectRecord(payload?.data);
  if (payload?.success !== true || payload.code !== 0 || !data || !Array.isArray(data.records)
    || (data.totalPage !== undefined && (!Number.isSafeInteger(data.totalPage) || Number(data.totalPage) < 0))
    || (data.totalPage === 0 && data.records.length !== 0)) {
    throw new Error('无法验证最新排序：JSON API 返回格式异常');
  }
  const hits: ParsedHit[] = [];
  const skipped: Record<string, number> = {};
  const add = (reason: string): void => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
  for (const [index, raw] of data.records.entries()) {
    const parsed = normalizeNowcoderSearchRecord(raw);
    if ('reason' in parsed) { add(parsed.reason); continue; }
    if (index >= 100) { add('rank_out_of_range'); continue; }
    if (parsed.hit.dateReason) add(parsed.hit.dateReason);
    hits.push({ ...parsed.hit, query, queryIndex, page, rank: index + 1 });
  }
  return { hits, skipped, rawRecords: data.records.length,
    totalPage: typeof data.totalPage === 'number' ? data.totalPage : undefined,
    total: typeof data.total === 'number' && Number.isSafeInteger(data.total) && data.total >= 0 ? data.total : undefined };
}
function originOrder(left: ParsedHit, right: ParsedHit): number {
  return left.queryIndex - right.queryIndex || left.page - right.page || left.rank - right.rank
    || left.canonicalUrl.localeCompare(right.canonicalUrl);
}
/** Bounded breadth-first pages: visit each keyword once before spending refill requests. No retries or SSR fallback. */
export async function discoverNowcoderDirectedCandidates(
  fetcher: typeof fetch, rawRequest: NowcoderSearchRequest, knownUrls: ReadonlySet<string>, _now: Date,
  knownSourceReasons: ReadonlyMap<string, string> = new Map(),
): Promise<NowcoderDirectedDiscoveryResult> {
  const request = nowcoderSearchRequestSchema.parse(rawRequest);
  const known = new Set([...knownUrls].map(canonicalNowcoderDetailUrl).filter((x): x is string => !!x));
  const maxPagesPerQuery = request.maxPagesPerQuery ?? 4;
  const maxRequests = request.maxRequests ?? 24;
  const diagnostics: NowcoderSearchDiagnostics = {
    maxPagesPerQuery, maxRequests, requests: 0, rawRecords: 0, parsedRecords: 0, duplicateRecords: 0,
    knownSourcesRemoved: 0, retainedCandidates: 0, reviewOnlyCandidates: 0,
    skippedCounts: {}, knownSourceCounts: {}, pages: [], stops: [],
  };
  const states = request.queries.map((query, queryIndex) => ({query, queryIndex, stopped: false, signatures: new Set<string>()}));
  const stop = (state: typeof states[number], reason: NowcoderSearchDiagnostics['stops'][number]['reason']): void => {
    if (!state.stopped) diagnostics.stops.push({ query: state.query, reason });
    state.stopped = true;
  };
  const hits: ParsedHit[] = [];
  for (let page = 1; page <= maxPagesPerQuery; page++) {
    const open = states.filter(state => !state.stopped);
    for (let index = 0; index < open.length && diagnostics.requests < maxRequests; index += QUERY_CONCURRENCY) {
      const group = open.slice(index, index + Math.min(QUERY_CONCURRENCY, maxRequests - diagnostics.requests));
      diagnostics.requests += group.length;
      const responses = await Promise.all(group.map(async state => ({state,
        found: await searchJsonPage(fetcher, state.query, state.queryIndex, page)})));
      for (const {state, found} of responses) {
        diagnostics.rawRecords += found.rawRecords;
        diagnostics.parsedRecords += found.hits.length;
        for (const [reason, count] of Object.entries(found.skipped)) {
          diagnostics.skippedCounts[reason] = (diagnostics.skippedCounts[reason] ?? 0) + count;
        }
        diagnostics.pages.push({ query: state.query, page, rawRecords: found.rawRecords,
          parsedRecords: found.hits.length, ...(found.total !== undefined ? {total: found.total} : {}),
          ...(found.totalPage !== undefined ? {totalPage: found.totalPage} : {}) });
        hits.push(...found.hits);
        const signature = [...new Set(found.hits.map(hit => hit.canonicalUrl))].sort().join('\n');
        if (found.rawRecords === 0) stop(state, 'empty_page');
        else if (signature && state.signatures.has(signature)) stop(state, 'repeated_page');
        else if (found.totalPage === undefined) stop(state, 'unknown_pagination');
        else if (page >= found.totalPage) stop(state, 'end_of_results');
        else if (page === maxPagesPerQuery) stop(state, 'page_limit');
        if (signature) state.signatures.add(signature);
      }
    }
    if (diagnostics.requests === maxRequests) {
      for (const state of states) if (!state.stopped) stop(state, 'request_budget');
      break;
    }
  }
  const deliverable = new Map<string, ParsedHit>();
  const previews = new Map<string, ParsedHit>();
  const unique = new Set(hits.map(hit => hit.canonicalUrl));
  diagnostics.duplicateRecords = hits.length - unique.size;
  for (const url of unique) if (known.has(url)) {
    diagnostics.knownSourcesRemoved++;
    const reason = knownSourceReasons.get(url) ?? 'known_source';
    diagnostics.knownSourceCounts[reason] = (diagnostics.knownSourceCounts[reason] ?? 0) + 1;
  }
  for (const hit of hits) {
    if (known.has(hit.canonicalUrl)) continue;
    if (!hit.publishedAt) {
      const existing = previews.get(hit.canonicalUrl);
      if (!existing || originOrder(hit, existing) < 0) previews.set(hit.canonicalUrl, hit);
      continue;
    }
    const existing = deliverable.get(hit.canonicalUrl);
    if (!existing) deliverable.set(hit.canonicalUrl, hit);
    else if (hit.publishedAt > (existing.publishedAt ?? '') || originOrder(hit, existing) < 0) {
      deliverable.set(hit.canonicalUrl, { ...hit, query: existing.query, queryIndex: existing.queryIndex,
        page: existing.page, rank: existing.rank });
    }
  }
  const candidates = [...deliverable.values()]
    .sort((left, right) => (right.publishedAt ?? '').localeCompare(left.publishedAt ?? '') || originOrder(left, right))
    .map(hit => ({ id: stableContentId(hit.canonicalUrl), canonicalUrl: hit.canonicalUrl, contentType: 'post' as const,
      matchedQueries: [...new Set(hits.filter(other => other.canonicalUrl === hit.canonicalUrl).map(other => other.query))],
      page: hit.page, rank: hit.rank, publishedAt: hit.publishedAt!, title: hit.title,
      snippet: hit.snippet, sourceRecordType: hit.sourceRecordType }));
  const previewOnly = [...previews.values()].filter(hit => !deliverable.has(hit.canonicalUrl)).sort(originOrder)
    .map(hit => ({ canonicalUrl: hit.canonicalUrl, query: hit.query, page: hit.page, rank: hit.rank,
      title: hit.title, reason: hit.dateReason! }));
  diagnostics.retainedCandidates = candidates.length;
  diagnostics.reviewOnlyCandidates = previewOnly.length;
  return { candidates, previewOnly, diagnostics,
    audit: { provider: 'nowcoder-json', requestedSort: 'latest', order: 'create', sortVerified: true, codexBrowserUse: false } };
}
