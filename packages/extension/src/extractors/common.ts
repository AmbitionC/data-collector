import {
  canonicalizeUrl,
  type CollectedDocument,
  type CollectedImage,
} from '@data-collector/shared';
import type { BuildDocumentInput } from './types.js';

export function cleanText(value: string | null | undefined): string {
  return (value ?? '').replace(/[\s\u00a0]+/g, ' ').trim();
}

export function elementText(element: Element | null): string {
  return cleanText(element?.textContent);
}

export function normalizeContent(content: Element, baseUrl: URL): {
  element: Element;
  images: CollectedImage[];
} {
  const clone = content.cloneNode(true) as Element;
  const images: CollectedImage[] = [];

  for (const image of clone.querySelectorAll('img')) {
    const width = Number(image.getAttribute('width') ?? 0);
    const height = Number(image.getAttribute('height') ?? 0);
    const rawUrl = image.getAttribute('data-src') || image.getAttribute('src') || '';
    const isTracker =
      (width > 0 && width <= 2) ||
      (height > 0 && height <= 2) ||
      /(?:qrcode|report|trace|pixel)/i.test(rawUrl);

    if (!rawUrl || isTracker) {
      image.remove();
      continue;
    }

    try {
      const absolute = new URL(rawUrl, baseUrl).href;
      if (!absolute.startsWith('https://') && !absolute.startsWith('http://')) {
        image.remove();
        continue;
      }
      image.setAttribute('src', absolute);
      image.removeAttribute('data-src');
      const alt = cleanText(image.getAttribute('alt'));
      images.push({ url: absolute, ...(alt ? { alt } : {}) });
    } catch {
      image.remove();
    }
  }

  for (const node of clone.querySelectorAll('script, style, noscript, form, iframe')) {
    node.remove();
  }
  return { element: clone, images };
}

export function buildDocument(input: BuildDocumentInput): CollectedDocument {
  const normalized = normalizeContent(input.content, input.url);
  const text = elementText(normalized.element);
  return {
    schemaVersion: 1,
    source: input.source,
    kind: input.kind,
    url: input.url.href,
    canonicalUrl: canonicalizeUrl(input.url).href,
    title: cleanText(input.title),
    collectedAt: input.now(),
    html: normalized.element.innerHTML,
    text,
    images: normalized.images,
    ...(input.author ? { author: cleanText(input.author) } : {}),
    ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
    ...(input.sourceMetadata ? { sourceMetadata: input.sourceMetadata } : {}),
  };
}

export function parsePublishedAt(raw: string, datetime?: string | null): string | undefined {
  const candidate = cleanText(datetime) || cleanText(raw);
  if (!candidate) return undefined;

  if (candidate.includes('T')) {
    const exact = new Date(candidate);
    return Number.isNaN(exact.getTime()) ? undefined : exact.toISOString();
  }

  const chinese = candidate.match(
    /^(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?/,
  );
  const normalized = chinese
    ? `${chinese[1]}-${chinese[2]?.padStart(2, '0')}-${chinese[3]?.padStart(2, '0')}T${(chinese[4] ?? '00').padStart(2, '0')}:${chinese[5] ?? '00'}:00+08:00`
    : candidate;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
