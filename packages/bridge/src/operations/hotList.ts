import { stableContentId } from '@data-collector/shared';
import type { Candidate } from './autopilot.js';

/** Nowcoder's public site-wide hot list (top 10), with each post's creation time from its public detail API. */
const HOT = 'https://gw-c.nowcoder.com/api/sparta/hot-search/top-hot-pc';
const DETAIL = { discuss: 'https://gw-c.nowcoder.com/api/sparta/detail/content-data/detail/', feed: 'https://gw-c.nowcoder.com/api/sparta/detail/moment-data/detail/' };
interface HotItem { type: number; id: string; uuid?: string; title: string; hotValueFromDolphin?: number }
const json = async (url: string) => { const response = await fetch(url, { signal: AbortSignal.timeout(10_000) }); if (!response.ok) throw new Error(`${response.status}`); return response.json() as Promise<{ success?: boolean; data?: any }>; };

export function hotItemUrl(item: HotItem): { url: string; detail: string } | undefined {
  if (item.type === 0 && /^\d+$/u.test(item.id)) return { url: `https://www.nowcoder.com/discuss/${item.id}`, detail: `${DETAIL.discuss}${item.id}` };
  if (item.uuid && /^[0-9a-f]{32}$/u.test(item.uuid)) return { url: `https://www.nowcoder.com/feed/main/detail/${item.uuid}`, detail: `${DETAIL.feed}${item.uuid}` };
  return undefined;
}

export async function fetchHotList(): Promise<Candidate[]> {
  const items = ((await json(HOT)).data?.result ?? []) as HotItem[], out: Candidate[] = [];
  for (const item of items) {
    const where = hotItemUrl(item); if (!where) continue;
    const created = await json(where.detail).then(r => r.data?.createTime ?? r.data?.createdAt, () => undefined) as number | undefined;
    out.push({ sourceId: stableContentId(where.url), url: where.url, title: item.title, hot: item.hotValueFromDolphin ?? 1, ...(created ? { publishedAt: new Date(created).toISOString() } : {}) });
  }
  return out;
}
