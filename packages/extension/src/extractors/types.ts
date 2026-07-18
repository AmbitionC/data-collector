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
  sourceMetadata?: CollectedDocument['sourceMetadata'];
}
