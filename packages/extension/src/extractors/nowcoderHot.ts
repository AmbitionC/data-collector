import { canonicalizeUrl, renderHotMaterial, type CollectedDocument, type NowcoderHotMaterial } from '@data-collector/shared';
import { parsePublishedAt } from './common.js';
import { ExtractionError, type Clock } from './types.js';

function visible(element: Element): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') return false;
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (style?.display === 'none' || style?.visibility === 'hidden') return false;
  }
  return true;
}

function text(element: Element | null): string {
  if (!element) return '';
  const walker = element.ownerDocument.createTreeWalker(element, 4);
  const parts: string[] = [];
  let node = walker.nextNode();
  while (node) {
    if (node.parentElement && visible(node.parentElement)
      && !node.parentElement.closest('script,style,.vue-ellipsis-placeholder-content,.vue-ellipsis-js-ellipsis,.vue-ellipsis-js-suffix')) {
      parts.push(node.textContent ?? '');
    }
    node = walker.nextNode();
  }
  return parts.join(' ').replace(/\s+/gu, ' ').trim();
}

function metric(card: Element, selector: string, icon: string): string | null {
  const direct = card.querySelector(selector);
  const iconElement = card.querySelector(`[aria-label="${icon}"]`);
  const value = text(direct ?? iconElement?.closest('.feed-interaction-data') ?? null);
  return /^\d+(?:\.\d+)?\s*(?:[wWkK万千])?$/u.test(value) ? value : null;
}

/** Grow only through ancestors belonging to this single observed post. */
function boundedCard(link: HTMLAnchorElement, listUrl: URL): Element {
  const known = link.closest('article, li, [class~="tw-px-5"][class~="tw-pt-5"], .feed-item, .discuss-item, [data-post-id]');
  let bounded: Element = link;
  for (let candidate = link.parentElement; candidate && !candidate.matches('body,html'); candidate = candidate.parentElement) {
    const posts = new Set<string>();
    for (const anchor of candidate.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      if (!visible(anchor)) continue;
      try {
        const url = new URL(anchor.getAttribute('href') ?? '', listUrl);
        if (url.protocol === 'https:' && (url.hostname === 'nowcoder.com' || url.hostname.endsWith('.nowcoder.com'))
          && /^\/(?:discuss\/[A-Za-z0-9_-]+|feed\/main\/detail\/[A-Za-z0-9_-]+)\/?$/u.test(url.pathname)) {
          posts.add(canonicalizeUrl(url).href);
        }
      } catch { /* An invalid neighboring link is not source evidence. */ }
    }
    if (posts.size !== 1) break;
    bounded = candidate;
    if (candidate === known || candidate.matches('section,main')) break;
  }
  return bounded;
}

/** Only links rendered in the accessible list; never navigates, fetches or invents post IDs. */
export function extractNowcoderHotList(document: Document, listUrl: URL, now: Clock): {
  documents: CollectedDocument[]; capped: boolean;
} {
  if (listUrl.protocol !== 'https:' || !(listUrl.hostname === 'nowcoder.com' || listUrl.hostname.endsWith('.nowcoder.com'))) {
    throw new ExtractionError('UNSUPPORTED_URL', '请在牛客热榜或讨论列表中读取热帖素材');
  }
  if (/^\/(?:discuss\/[^/]+|feed\/main\/detail\/[^/]+)/u.test(listUrl.pathname)) {
    throw new ExtractionError('UNSUPPORTED_LAYOUT', '请返回牛客热榜或讨论列表，再读取当前可见条目');
  }
  const documents = new Map<string, CollectedDocument>();
  const observedAt = now();
  // Prioritize explicit visible hot-list observations when the same post also appears in the feed.
  const links = [...document.querySelectorAll<HTMLAnchorElement>('.hotList a[href], [class*="hot-list"] a[href]'),
    ...document.querySelectorAll<HTMLAnchorElement>('a[href]')];
  for (const link of links) {
    if (!visible(link)) continue;
    let url: URL;
    try {
      url = new URL(link.getAttribute('href') ?? '', listUrl);
      if (url.protocol !== 'https:' || !(url.hostname === 'nowcoder.com' || url.hostname.endsWith('.nowcoder.com'))
        || !/^\/(?:discuss\/[A-Za-z0-9_-]+|feed\/main\/detail\/[A-Za-z0-9_-]+)\/?$/u.test(url.pathname)) continue;
      url = canonicalizeUrl(url);
    } catch { continue; }
    if (documents.has(url.href)) continue;
    const hot = link.closest('.hotList, [class*="hot-list"]');
    const card = hot ? link.closest('li') ?? link : boundedCard(link, listUrl);
    const titleNode = hot ? link.querySelector('.vue-ellipsis-js-content, .hot-title, [class*="title"]')
      : card.querySelector('h1 a, h2 a, h3 a, .post-title, .discuss-title, .feed-title');
    const title = text(titleNode ?? link).slice(0, 500);
    if (!title || /^(?:查看更多|阅读全文|详情)$/u.test(title)) continue;
    const time = card.querySelector('time, .show-time, .post-time, .feed-time');
    const publishedAtText = text(time).slice(0, 100) || null;
    // Edited/relative/month-day dates remain raw observations; never infer a publication year.
    const publishedAt = publishedAtText && !/编辑/u.test(publishedAtText)
      ? parsePublishedAt(publishedAtText, time?.getAttribute('datetime')) : undefined;
    const excerpt = hot ? '' : text(card.querySelector('.feed-text, .post-summary, .discuss-summary, p')).slice(0, 180);
    const heat = hot ? text(link.querySelector('.tw-text-right, .heat, [class*="heat"]')) : metric(card, '.heat', 'Redu');
    const material: NowcoderHotMaterial = {
      schemaVersion: 1, purpose: 'nowcoder-hot', visibility: 'private', verificationStatus: 'unverified',
      observation: {
        listUrl: listUrl.href, listTitle: document.title.trim().slice(0, 500),
        publishedAtText, observedAt,
        metrics: { heat: /^\d+(?:\.\d+)?\s*(?:[wWkK万千])?$/u.test(heat ?? '') ? heat : null,
          likes: metric(card, '.like-count', 'Dianzan'), comments: metric(card, '.comment-count', 'Pinglun'),
          views: metric(card, '.view-count', 'Liulan') },
      },
      evidence: { excerpt, attribution: 'source-quote' },
      editorial: { emotionTags: [], inspirationNote: '' }, screenshotPolicy: 'redact-before-public-use',
    };
    documents.set(url.href, {
      schemaVersion: 1, source: 'nowcoder', kind: 'post', url: url.href, canonicalUrl: url.href,
      title, collectedAt: observedAt, ...(publishedAt ? { publishedAt } : {}),
      images: [], text: excerpt, html: renderHotMaterial(material), operationMaterial: material,
    });
    if (documents.size > 60) break;
  }
  return { documents: [...documents.values()].slice(0, 60), capped: documents.size > 60 };
}
