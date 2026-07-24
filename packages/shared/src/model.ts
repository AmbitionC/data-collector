export const SOURCES = ['wechat', 'zsxq', 'nowcoder'] as const;
export type Source = (typeof SOURCES)[number];

export const CONTENT_KINDS = ['article', 'post', 'question', 'answer'] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

export interface CollectedImage {
  url: string;
  alt?: string;
}

export interface CollectedDocument {
  schemaVersion: 1;
  source: Source;
  kind: ContentKind;
  url: string;
  canonicalUrl: string;
  title: string;
  author?: string;
  publishedAt?: string;
  collectedAt: string;
  html: string;
  text: string;
  images: CollectedImage[];
  suggestedCategory?: string;
  suggestedTags?: string[];
  userCategory?: string;
  userTags?: string[];
  sourceMetadata?: Record<string, string | number | boolean | null>;
}

export const JOB_STATUSES = [
  'queued',
  'dispatched',
  'collecting',
  'saved',
  'needs_attention',
  'failed',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobRecord {
  id: string;
  url: string;
  requestedBy: 'codex' | 'cli' | 'extension';
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  outputPath?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface WsEnvelope<TType extends string = string, TPayload = unknown> {
  protocolVersion: 1;
  type: TType;
  requestId: string;
  timestamp: string;
  payload: TPayload;
}
