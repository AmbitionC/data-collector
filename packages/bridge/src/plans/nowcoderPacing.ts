import sanitizeHtml from 'sanitize-html';

export type NowcoderCollectionStopCode = 'RATE_LIMITED' | 'AUTH_REQUIRED' | 'CAPTCHA_REQUIRED';

export class NowcoderCollectionStopError extends Error {
  constructor(public readonly code: NowcoderCollectionStopCode, message: string) {
    super(message);
    this.name = 'NowcoderCollectionStopError';
  }
}

export interface NowcoderPacingOptions {
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  intervalMs?: number;
}

/** One instance belongs to one exact review batch and is shared by search and detail dispatch. */
export class NowcoderRequestPacer {
  private readonly now: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly intervalMs: number;
  private tail: Promise<void> = Promise.resolve();
  private lastStart: number | undefined;
  private stopError: NowcoderCollectionStopError | undefined;

  constructor(options: NowcoderPacingOptions = {}) {
    this.now = options.now ?? Date.now;
    this.delay = options.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.intervalMs = options.intervalMs ?? 2000;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs < 2000) {
      throw new Error('牛客请求间隔必须至少为 2000ms');
    }
  }

  run<T>(operation: () => Promise<T>, guard?: () => boolean | void): Promise<T> {
    const pending = this.tail.then(async () => {
      const assertAllowed = (): void => {
        if (this.stopError) throw this.stopError;
        if (guard?.() === false) throw new Error('牛客采集已停止，不再发送请求');
      };
      assertAllowed();
      if (this.lastStart !== undefined) {
        const wait = Math.max(0, this.lastStart + this.intervalMs - this.now());
        if (wait > 0) await this.delay(wait);
      }
      assertAllowed();
      this.lastStart = this.now();
      try {
        return await operation();
      } catch (error) {
        if (error instanceof NowcoderCollectionStopError) this.stop(error);
        throw error;
      }
    });
    // A failure releases the queue; explicit access challenges remain latched by assertAllowed.
    this.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  stop(error: NowcoderCollectionStopError): void {
    this.stopError ??= error;
  }

  stopped(): NowcoderCollectionStopError | undefined {
    return this.stopError;
  }
}

const MAX_RESPONSE_BYTES = 256 * 1024;
const RESPONSE_READ_TIMEOUT_MS = 8000;
const CAPTCHA_WIDGETS = new Set([
  'captcha-modal', 'nc-captcha-modal', 'captcha-container', 'captcha',
  'geetest_panel', 'geetest_widget', 'yidun_panel', 'verify-dialog',
]);
const LOGIN_WIDGETS = new Set(['login-modal', 'nc-login-modal', 'login-container']);
const VERIFICATION_TITLE = /^(?:安全验证|人机验证|访问验证|请完成验证|滑动验证|Access Verification|Security Verification)(?:\s*[-_|｜]\s*牛客(?:网)?)?$/iu;

function stopError(code: NowcoderCollectionStopCode): NowcoderCollectionStopError {
  const message = code === 'RATE_LIMITED'
    ? '牛客访问过于频繁，本批次已停止；请稍后人工确认再重试'
    : code === 'CAPTCHA_REQUIRED'
      ? '牛客要求完成验证码，本批次已停止；请在浏览器人工处理后重试'
      : '牛客要求登录或拒绝访问，本批次已停止；请在浏览器人工确认后重试';
  return new NowcoderCollectionStopError(code, message);
}

function explicitJsonStop(payload: unknown): NowcoderCollectionStopError | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const value = payload as Record<string, unknown>;
  if (value.code === 429 || value.code === '429' || value.code === 'RATE_LIMITED') return stopError('RATE_LIMITED');
  if (value.code === 401 || value.code === 403 || value.code === '401' || value.code === '403'
    || value.code === 'AUTH_REQUIRED') return stopError('AUTH_REQUIRED');
  if (value.code === 'CAPTCHA_REQUIRED') return stopError('CAPTCHA_REQUIRED');
  // Unknown numeric codes are never assigned guessed meanings. Only explicit system messages count.
  const messages = [value.message, value.msg, value.error].filter(
    (message): message is string => typeof message === 'string' && message.length <= 200,
  );
  for (const message of messages) {
    const text = message.trim();
    if (/^(?:请(?:先)?登录|未登录|登录(?:已)?(?:失效|过期)|需要登录|login required)(?:[，,：:\s]|后|$)/iu.test(text)) return stopError('AUTH_REQUIRED');
    if (/^(?:请完成(?:验证码|安全|人机|滑动)?验证|验证码校验失败|captcha required)(?:[，,：:\s]|后|$)/iu.test(text)) return stopError('CAPTCHA_REQUIRED');
    if (/^(?:请求过于频繁|访问过于频繁|too many requests)(?:[，,：:\s]|后|$)/iu.test(text)) return stopError('RATE_LIMITED');
  }
  return undefined;
}

function visibleHtmlStop(html: string): NowcoderCollectionStopError | undefined {
  const visible = sanitizeHtml(html, {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, 'title', 'form', 'input', 'iframe'],
    allowedAttributes: { '*': ['class', 'id', 'style', 'hidden', 'aria-hidden', 'action', 'src', 'name'] },
    parseStyleAttributes: false,
    // Keep the boolean hidden attribute until exclusiveFilter sees the complete parent frame.
    nonBooleanAttributes: sanitizeHtml.defaults.nonBooleanAttributes.filter(attribute => attribute !== 'hidden'),
    exclusiveFilter: frame => Object.hasOwn(frame.attribs, 'hidden')
      || frame.attribs['aria-hidden'] === 'true'
      || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(frame.attribs.style ?? ''),
  });
  const title = visible.match(/<title\b[^>]*>([^<]*)<\/title>/iu)?.[1]?.trim();
  if (title && VERIFICATION_TITLE.test(title)) return stopError('CAPTCHA_REQUIRED');
  for (const match of visible.matchAll(/\b(?:class|id)="([^"]*)"/giu)) {
    const tokens = match[1]?.split(/\s+/u) ?? [];
    if (tokens.some(token => CAPTCHA_WIDGETS.has(token))) return stopError('CAPTCHA_REQUIRED');
    if (tokens.some(token => LOGIN_WIDGETS.has(token))) return stopError('AUTH_REQUIRED');
  }
  if (/<form\b[^>]*\baction="[^"]*(?:\/login(?:[/?#"]|$)|\/signin(?:[/?#"]|$))/iu.test(visible)) {
    return stopError('AUTH_REQUIRED');
  }
  return undefined;
}

async function boundedResponseText(response: Response): Promise<string> {
  const reader = response.clone().body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async (): Promise<string> => {
      while (bytes < MAX_RESPONSE_BYTES) {
        const part = await reader.read();
        if (part.done) break;
        const accepted = part.value.subarray(0, MAX_RESPONSE_BYTES - bytes);
        bytes += accepted.length;
        text += decoder.decode(accepted, { stream: true });
      }
      return text + decoder.decode();
    };
    return await Promise.race([
      read(),
      new Promise<string>(resolve => { timer = setTimeout(() => resolve(''), RESPONSE_READ_TIMEOUT_MS); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    // A cloned stream's cancel can wait for its sibling; do not await it or consume the real body.
    void reader.cancel().catch(() => undefined);
  }
}

/** Inspect a bounded clone before releasing a paced request; the caller still owns the real body. */
export async function detectNowcoderResponseStop(response: Response): Promise<NowcoderCollectionStopError | undefined> {
  if (response.status === 429) return stopError('RATE_LIMITED');
  if (response.status === 401 || response.status === 403) return stopError('AUTH_REQUIRED');
  if (response.url) {
    const pathname = new URL(response.url).pathname;
    if (/\/(?:login|signin)(?:\/|$)/iu.test(pathname)) return stopError('AUTH_REQUIRED');
    if (/\/(?:captcha|verify)(?:\/|$)/iu.test(pathname)) return stopError('CAPTCHA_REQUIRED');
  }
  const text = await boundedResponseText(response);
  if (text.trimStart().startsWith('{')) {
    try { return explicitJsonStop(JSON.parse(text)); } catch { return undefined; }
  }
  return visibleHtmlStop(text);
}
