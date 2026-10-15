import { canonicalizeUrl } from '@data-collector/shared';

const DETAIL_PATH = /^\/(?:discuss\/\d+|feed\/main\/detail\/[A-Za-z0-9_-]+)\/?$/u;
export function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
export function canonicalNowcoderDetailUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const url = new URL(value.replaceAll('&amp;', '&'), 'https://www.nowcoder.com/');
    if (url.protocol !== 'https:' || !['www.nowcoder.com', 'nowcoder.com'].includes(url.hostname)
      || !DETAIL_PATH.test(url.pathname)) return undefined;
    url.hostname = 'www.nowcoder.com';
    return canonicalizeUrl(url).href;
  } catch { return undefined; }
}
export type SearchRecordReason = 'unsupported_record' | 'invalid_url';
export interface NormalizedNowcoderSearchRecord {
  canonicalUrl: string;
  sourceRecordType: 'content' | 'moment';
  title: string;
  snippet: string;
  publishedAt?: string;
  dateReason?: 'missing_published_at' | 'invalid_published_at';
}
function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.replace(/<[^>]*>/gu, '').slice(0, limit) : '';
}
/** Both official search record variants use the same strict detail URL and date checks. */
export function normalizeNowcoderSearchRecord(raw: unknown):
  | { hit: NormalizedNowcoderSearchRecord }
  | { reason: SearchRecordReason } {
  const root = objectRecord(raw);
  const content = objectRecord(root?.contentData);
  const moment = objectRecord(root?.momentData);
  const data = content ?? moment;
  if (!data) return { reason: 'unsupported_record' };
  const sourceRecordType = content ? 'content' : 'moment';
  const values = [data.url, data.detailUrl, data.detailURL, data.link, data.contentUrl,
    data.contentURL, data.targetUrl, data.targetURL];
  let canonicalUrl = values.map(canonicalNowcoderDetailUrl).find(Boolean);
  // A returned external/invalid URL is not authority to manufacture another URL.
  if (!canonicalUrl && !values.some(value => typeof value === 'string')) {
    canonicalUrl = sourceRecordType === 'moment'
      ? (typeof data.uuid === 'string' ? canonicalNowcoderDetailUrl(`/feed/main/detail/${data.uuid}`) : undefined)
      : (typeof data.id === 'string' || (typeof data.id === 'number' && Number.isSafeInteger(data.id))
          ? canonicalNowcoderDetailUrl(`/discuss/${data.id}`) : undefined);
  }
  if (!canonicalUrl) return { reason: 'invalid_url' };
  // Do not promote showTime/editTime (activity times) into publication evidence.
  const rawDate = data.createTime ?? data.createdAt ?? data.publishTime ?? data.publishedAt;
  let dateReason: NormalizedNowcoderSearchRecord['dateReason'];
  let publishedAt: string | undefined;
  if (rawDate === undefined || rawDate === null || rawDate === '') dateReason = 'missing_published_at';
  else {
    const number = typeof rawDate === 'number' ? rawDate : typeof rawDate === 'string' ? Number(rawDate) : NaN;
    const date = new Date(number < 100_000_000_000 ? number * 1_000 : number);
    if (!Number.isFinite(number) || number <= 0 || Number.isNaN(date.getTime())) dateReason = 'invalid_published_at';
    else publishedAt = date.toISOString();
  }
  return { hit: { canonicalUrl, sourceRecordType, title: text(data.title, 640),
    snippet: text(data.content, 1_600), ...(publishedAt ? { publishedAt } : {}),
    ...(dateReason ? { dateReason } : {}) } };
}
