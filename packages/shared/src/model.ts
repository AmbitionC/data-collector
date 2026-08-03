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
  /**
   * 正文**确定是截断的**（页面上还挂着「展开全部」而全文没能补齐）。
   *
   * 归档侧必须靠字段判断、不能靠字数猜：实测新批次 <400 字的 27 条里只有 6 条是真截断，
   * 另外 21 条是原帖本来就短——字数启发式误报率 78%。
   */
  truncated?: boolean;
  /**
   * 问答帖的提问者。
   *
   * `author` 是这条内容的归属博主（星球里恒为星主），提问者是另一回事，
   * 不留下来就被抹掉了——实测 21 条问答帖全部丢失了提问人。
   */
  questioner?: string;
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
