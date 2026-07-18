import sanitizeHtml from 'sanitize-html';

const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'del', 's',
  'a', 'img', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'figure', 'figcaption',
];

function safeAbsoluteUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function sanitizeCollectedHtml(html: string, baseUrl: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ['href', 'title'],
      img: ['src', 'alt', 'title'],
      code: ['class'],
      th: ['colspan', 'rowspan'],
      td: ['colspan', 'rowspan'],
    },
    allowedSchemes: ['http', 'https'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    transformTags: {
      a: (tagName, attributes) => {
        const href = safeAbsoluteUrl(attributes.href, baseUrl);
        return {
          tagName,
          attribs: { ...attributes, ...(href ? { href } : {}) },
        };
      },
      img: (tagName, attributes) => {
        const src = safeAbsoluteUrl(attributes.src, baseUrl);
        return {
          tagName,
          attribs: { ...attributes, ...(src ? { src } : {}) },
        };
      },
    },
  });
}
