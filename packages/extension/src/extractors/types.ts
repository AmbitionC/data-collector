import type { CollectedDocument, ContentKind, Source } from '@data-collector/shared';

export type Clock = () => string;

export type ExtractionErrorCode =
  | 'AUTH_REQUIRED'
  | 'CONTENT_EMPTY'
  | 'UNSUPPORTED_LAYOUT'
  | 'UNSUPPORTED_URL';

export class ExtractionError extends Error {
  constructor(
    public readonly code: ExtractionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExtractionError';
  }
}

export interface BuildDocumentInput {
  source: Source;
  kind: ContentKind;
  title: string;
  content: Element;
  url: URL;
  now: Clock;
  author?: string;
  publishedAt?: string;
  /** 正文确定是截断的（页面还挂着「展开全部」而全文没补上）。 */
  truncated?: boolean;
  /** 问答帖的提问者（author 是归属博主，两者不是一回事）。 */
  questioner?: string;
  sourceMetadata?: CollectedDocument['sourceMetadata'];
}
