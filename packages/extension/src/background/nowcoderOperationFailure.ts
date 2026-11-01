import type { NowcoderOperationFailure } from '@data-collector/shared';

// Exceptions stay in the authenticated private operation journal, not in UI copy.
// Remove credentials and URL queries before they cross the extension boundary.
export function sanitizeOperationError(error: unknown): NowcoderOperationFailure['error'] {
  const read = (key: string) => {
    try {
      const value = error && typeof error === 'object' ? (error as Record<string, unknown>)[key] : undefined;
      return typeof value === 'string' ? value : undefined;
    } catch { return undefined; }
  };
  const redact = (value: string, limit: number) => value
    .replace(/https?:\/\/[^\s"'<>]+/giu, value => {
      try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); }
      catch { return '[URL]'; }
    })
    .replace(/(\b(?:(?:set-)?cookie|(?:proxy-)?authorization)["']?\s*[:=]\s*)[^\r\n]+/giu, '$1[REDACTED]')
    .replace(/(\b(?:authorization|proxy-authorization|password|passwd|access[_-]?token|refresh[_-]?token|token|api[_-]?key|client[_-]?secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/giu, '$1[REDACTED]')
    .replace(/\bBearer\s+[^\s"',;}\]]+/giu, 'Bearer [REDACTED]')
    .slice(0, limit);
  let fallback = 'Unknown failure';
  try { if (typeof error === 'string') fallback = error; } catch { /* Keep a safe fallback. */ }
  const name = read('name') || 'Error', message = read('message') || fallback, stack = read('stack');
  return { name: redact(name, 120) || 'Error', message: redact(message, 1000) || 'Unknown failure', ...(stack ? { stack: redact(stack, 4000) } : {}) };
}
