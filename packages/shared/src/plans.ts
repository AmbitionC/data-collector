import { z } from 'zod';
import type { CollectedDocument, CollectedImage } from './model.js';

export const COLLECTION_PLAN_IDS = ['zsxq-chen-teacher', 'nowcoder-agent-market'] as const;
export type CollectionPlanId = (typeof COLLECTION_PLAN_IDS)[number];

export const COLLECTION_PLAN_TRIGGERS = ['manual', 'scheduled'] as const;
export type CollectionPlanTrigger = (typeof COLLECTION_PLAN_TRIGGERS)[number];

/** Bridge 每次下发固定计划时生成的不可猜测尝试令牌。 */
export const collectionPlanAttemptSchema = z.string().regex(/^[a-f0-9]{16}$/);
export type CollectionPlanAttempt = z.infer<typeof collectionPlanAttemptSchema>;

export const BATCH_STATUSES = [
  'running',
  'completed',
  'completed_with_attention',
  'failed',
] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export const ZSXQ_PLAN_VIEWS = ['最新', '精华', '只看星主'] as const;
export type ZsxqPlanView = (typeof ZSXQ_PLAN_VIEWS)[number];

export const ZSXQ_COLLECTION_MODES = ['daily-ledger', 'owner-history'] as const;
export type ZsxqCollectionMode = (typeof ZSXQ_COLLECTION_MODES)[number];

export const ZSXQ_OWNER_ITEM_OUTCOMES = ['exact', 'semantic', 'saved', 'repaired'] as const;
export type ZsxqOwnerItemOutcome = (typeof ZSXQ_OWNER_ITEM_OUTCOMES)[number];

/** 正文无关的逐 topic 映射证据，供历史验收对本机完整索引做精确对账。 */
export interface ZsxqOwnerItemFact {
  url: string;
  day: string;
  outcome: ZsxqOwnerItemOutcome;
  mappedUrl: string;
}

export interface ZsxqDayDraft {
  day: string;
  rawOwnerCount: number;
  qualifyingCount: number;
  filteredCount: number;
  exactDuplicateCount: number;
  semanticDuplicateCount: number;
  knownCompleteCount: number;
  repairCount: number;
  candidateCount: number;
  savedCount: number;
  failedCount: number;
  crossedDayBoundary: boolean;
  itemFacts?: ZsxqOwnerItemFact[];
}

export interface ZsxqOwnerCheckpoint {
  mode: ZsxqCollectionMode;
  cursor?: string;
  pagesFetched: number;
  newestObservedAt?: string;
  oldestObservedAt?: string;
  exhausted: boolean;
}

export interface ZsxqOwnerAudit {
  mode: ZsxqCollectionMode;
  pagesFetched: number;
  observed: number;
  qualifying: number;
  exactDuplicates: number;
  semanticDuplicates: number;
  filtered: number;
  knownComplete: number;
  repaired: number;
  saved: number;
  failed: number;
  newestObservedAt?: string;
  oldestObservedAt?: string;
  exhausted: boolean;
  safetyCapReached: boolean;
  completedDays: number;
  emptyDays: number;
  failedDays: number;
}

export interface CollectionPlanRejection {
  url: string;
  reason: string;
  /** Machine-readable evidence for failures that need repair; business skips omit it. */
  evidence?: string;
}

export const collectionPlanRejectionSchema = z.object({
  url: z.string().url().max(4096),
  reason: z.string().trim().min(1).max(100),
  evidence: z.string().trim().min(1).max(500).optional(),
}).strict();

export interface ZsxqViewDocuments {
  label: ZsxqPlanView;
  documents: readonly CollectedDocument[];
}

export interface ZsxqDocumentMergeResult {
  document: CollectedDocument;
  /** 同一规范 URL 下出现互不相容的正文或帖子号，调用方必须按覆盖风险处理。 */
  conflict?: 'body' | 'identity';
}

function normalizedZsxqBody(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

const ZSXQ_ARTICLE_ANCHOR = /<a\b[^>]*>/giu;
const ZSXQ_RESOURCE_TAG = /<(?:a|img|video|audio|source|track|iframe|embed|object)\b[^>]*>/giu;
const HTML_HREF_ATTRIBUTE = /(\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/iu;
const HTML_SRC_ATTRIBUTE = /(\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/iu;
const HTML_DATA_SRC_ATTRIBUTE = /(\s)data-src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/iu;
const HTML_SRCSET_ATTRIBUTE = /(\s)srcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/iu;
const HTML_POSTER_ATTRIBUTE = /(\s)poster\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/iu;
const HTML_DATA_ATTRIBUTE = /(\s)data\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/iu;

function decodeHtmlUrlAttribute(value: string): string {
  return value
    .replace(/&amp;/giu, '&')
    .replace(/&#x([0-9a-f]+);/giu, (_, digits: string) =>
      String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&#([0-9]+);/gu, (_, digits: string) =>
      String.fromCodePoint(Number.parseInt(digits, 10)));
}

function normalizedZsxqLinkedArticleUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(decodeHtmlUrlAttribute(value));
  } catch {
    return undefined;
  }
  if (
    url.protocol !== 'https:'
    || url.hostname.toLowerCase() !== 'articles.zsxq.com'
    || url.username
    || url.password
    || url.port
    || !/^\/id_[A-Za-z0-9]+\.html\/?$/u.test(url.pathname)
  ) return undefined;
  url.hostname = 'articles.zsxq.com';
  url.pathname = url.pathname.replace(/\/+$/u, '');
  url.search = '';
  url.hash = '';
  return url.href;
}

function hrefFromAnchorTag(tag: string): string | undefined {
  const match = HTML_HREF_ATTRIBUTE.exec(tag);
  return match?.[2] ?? match?.[3] ?? match?.[4];
}

function valueFromAttribute(tag: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(tag);
  return match?.[2] ?? match?.[3] ?? match?.[4];
}

function urlsFromSrcset(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map(candidate => candidate.trim().split(/\s+/u)[0])
    .filter((candidate): candidate is string => Boolean(candidate));
}

function normalizedZsxqResourceUrl(value: string, base: string): string | undefined {
  const article = normalizedZsxqLinkedArticleUrl(value);
  if (article) return article;
  try {
    const url = new URL(decodeHtmlUrlAttribute(value), base);
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:')
      || url.username
      || url.password
    ) return undefined;
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

type ZsxqResourceKind =
  | 'anchor'
  | 'image'
  | 'video'
  | 'audio'
  | 'source'
  | 'track'
  | 'iframe'
  | 'embed'
  | 'object'
  | 'poster';

interface ZsxqResourceReference {
  url: string;
  kind: ZsxqResourceKind;
}

/** 正文内所有可跟随资源；用于区分“后帧补齐”与虚拟节点粘入另一帖资源。 */
function zsxqDocumentResources(document: CollectedDocument): Map<string, ZsxqResourceReference> {
  const resources = new Map<string, ZsxqResourceReference>();
  const remember = (value: string | undefined, kind: ZsxqResourceKind): void => {
    const normalized = value
      ? normalizedZsxqResourceUrl(value, document.canonicalUrl)
      : undefined;
    if (normalized && !resources.has(normalized)) {
      resources.set(normalized, { url: normalized, kind });
    }
  };
  for (const image of document.images) remember(image.url, 'image');
  for (const match of document.html.matchAll(ZSXQ_RESOURCE_TAG)) {
    const tag = match[0];
    const name = /^<([a-z]+)/iu.exec(tag)?.[1]?.toLowerCase();
    if (name === 'a') {
      remember(hrefFromAnchorTag(tag), 'anchor');
    } else if (name === 'object') {
      remember(valueFromAttribute(tag, HTML_DATA_ATTRIBUTE), 'object');
    } else {
      const kind: ZsxqResourceKind = name === 'img'
        ? 'image'
        : name === 'video'
          ? 'video'
          : name === 'audio'
            ? 'audio'
            : name === 'source'
              ? 'source'
              : name === 'track'
                ? 'track'
                : name === 'iframe'
                  ? 'iframe'
                  : name === 'embed' ? 'embed' : 'anchor';
      // 懒加载图片的 src 常是透明占位图；与 extractor 一致，只认 data-src 优先。
      const src = name === 'img'
        ? valueFromAttribute(tag, HTML_DATA_SRC_ATTRIBUTE)
          ?? valueFromAttribute(tag, HTML_SRC_ATTRIBUTE)
        : valueFromAttribute(tag, HTML_SRC_ATTRIBUTE);
      remember(src, kind);
      if (name === 'video') {
        remember(valueFromAttribute(tag, HTML_POSTER_ATTRIBUTE), 'poster');
      }
      for (const candidate of urlsFromSrcset(valueFromAttribute(tag, HTML_SRCSET_ATTRIBUTE))) {
        remember(candidate, kind);
      }
    }
  }
  return resources;
}

function zsxqDocumentResourceUrls(document: CollectedDocument): Set<string> {
  return new Set(zsxqDocumentResources(document).keys());
}

function zsxqLinkedArticleUrls(html: string): Set<string> {
  const urls = new Set<string>();
  for (const match of html.matchAll(ZSXQ_ARTICLE_ANCHOR)) {
    const href = hrefFromAnchorTag(match[0]);
    const normalized = href ? normalizedZsxqLinkedArticleUrl(href) : undefined;
    if (normalized) urls.add(normalized);
  }
  return urls;
}

function normalizeZsxqLinkedArticleHrefs(html: string): string {
  return html.replace(ZSXQ_ARTICLE_ANCHOR, tag => {
    const href = hrefFromAnchorTag(tag);
    const normalized = href ? normalizedZsxqLinkedArticleUrl(href) : undefined;
    if (!normalized) return tag;
    return tag.replace(HTML_HREF_ATTRIBUTE, `$1href="${normalized}"`);
  });
}

function isUrlSubset(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return [...left].every(url => right.has(url));
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function mergeZsxqImages(
  primary: readonly CollectedImage[],
  secondary: readonly CollectedImage[],
): CollectedImage[] {
  const images = new Map<string, CollectedImage>();
  for (const image of [...primary, ...secondary]) {
    const existing = images.get(image.url);
    if (!existing) {
      images.set(image.url, image);
    } else if (!existing.alt && image.alt) {
      images.set(image.url, image);
    }
  }
  return [...images.values()];
}

function zsxqResourceHtml(resource: ZsxqResourceReference): string {
  const url = escapeHtmlAttribute(resource.url);
  if (resource.kind === 'image') return `<img src="${url}">`;
  if (resource.kind === 'video') return `<video controls src="${url}"></video>`;
  if (resource.kind === 'audio') return `<audio controls src="${url}"></audio>`;
  if (resource.kind === 'source') return `<source src="${url}">`;
  if (resource.kind === 'track') return `<track src="${url}">`;
  if (resource.kind === 'iframe') return `<iframe src="${url}"></iframe>`;
  if (resource.kind === 'embed') return `<embed src="${url}">`;
  if (resource.kind === 'object') return `<object data="${url}"></object>`;
  if (resource.kind === 'poster') return `<video poster="${url}"></video>`;
  // 空文案避免让合并后的 document.text 与 HTML 可见文字发生漂移。
  return `<a href="${url}"></a>`;
}

function mergeZsxqDocumentAssets(
  primary: CollectedDocument,
  secondary: CollectedDocument,
  linkedArticleUrls: ReadonlySet<string>,
): CollectedDocument {
  let html = normalizeZsxqLinkedArticleHrefs(primary.html);
  const presentLinks = zsxqLinkedArticleUrls(html);
  for (const url of linkedArticleUrls) {
    if (presentLinks.has(url)) continue;
    html += `\n<a href="${escapeHtmlAttribute(url)}">全文</a>`;
  }

  const images = mergeZsxqImages(primary.images, secondary.images);
  for (const image of images) {
    const escapedUrl = escapeHtmlAttribute(image.url);
    if (html.includes(image.url) || html.includes(escapedUrl)) continue;
    const alt = image.alt ? ` alt="${escapeHtmlAttribute(image.alt)}"` : '';
    html += `\n<img src="${escapedUrl}"${alt}>`;
  }
  const mergedView = { ...primary, html, images };
  const presentResources = zsxqDocumentResourceUrls(mergedView);
  for (const resource of zsxqDocumentResources(secondary).values()) {
    if (presentResources.has(resource.url)) continue;
    html += `\n${zsxqResourceHtml(resource)}`;
    presentResources.add(resource.url);
  }
  return { ...primary, html, images };
}

/** 同一帖的 SPA 尾段补齐只能在原正文末尾继续增长；两份互不包含的正文不能二选一猜。 */
function compatibleZsxqBodies(left: CollectedDocument, right: CollectedDocument): boolean {
  const leftBody = normalizedZsxqBody(left.text);
  const rightBody = normalizedZsxqBody(right.text);
  if (!leftBody || !rightBody) return leftBody === rightBody;
  if (leftBody === rightBody) return true;
  const [shorter, longer] = leftBody.length <= rightBody.length
    ? [leftBody, rightBody]
    : [rightBody, leftBody];
  return longer.startsWith(shorter);
}

function zsxqTopicIds(document: CollectedDocument): Set<string> {
  const ids = new Set<string>();
  try {
    const fromUrl = new URL(document.canonicalUrl).pathname.match(/\/topic\/([^/]+)\/?$/u)?.[1];
    if (fromUrl) ids.add(fromUrl);
  } catch {
    // canonical URL 的格式由更外层 schema 校验；这里仅做冲突探测。
  }
  const fromMetadata = document.sourceMetadata?.topicId;
  if (typeof fromMetadata === 'string' && fromMetadata.trim()) ids.add(fromMetadata.trim());
  return ids;
}

/**
 * 合并同一规范 URL 的观察：取更完整正文，但 `truncated:true` 永远粘住；
 * 正文/帖子号冲突时额外返回 conflict，并把结果强制标为不完整作为最后一道防线。
 */
export function mergeZsxqDocumentCopies(
  left: CollectedDocument,
  right: CollectedDocument,
): ZsxqDocumentMergeResult {
  const identityIds = new Set([...zsxqTopicIds(left), ...zsxqTopicIds(right)]);
  const identityConflict = left.canonicalUrl !== right.canonicalUrl || identityIds.size > 1;
  const compatibleBodies = compatibleZsxqBodies(left, right);
  const leftArticleUrls = zsxqLinkedArticleUrls(left.html);
  const rightArticleUrls = zsxqLinkedArticleUrls(right.html);
  const leftResourceUrls = zsxqDocumentResourceUrls(left);
  const rightResourceUrls = zsxqDocumentResourceUrls(right);
  const leftResourceSubset = isUrlSubset(leftResourceUrls, rightResourceUrls);
  const rightResourceSubset = isUrlSubset(rightResourceUrls, leftResourceUrls);
  const assetAuthority = (candidate: CollectedDocument): number =>
    candidate.sourceMetadata?.sourceMediaProven === true
      && candidate.sourceMetadata.sourceCoversDom === true ? 1 : 0;
  const leftAssetAuthority = assetAuthority(left);
  const rightAssetAuthority = assetAuthority(right);
  // 只有同等级证据才把互斥资源当冲突；来源权威副本必须能覆盖 unknown stale 资源。
  const resourceConflict = leftAssetAuthority === rightAssetAuthority
    && !leftResourceSubset
    && !rightResourceSubset;
  const bodyConflict = !compatibleBodies || resourceConflict;
  const leftHasStrictResourceSubset = leftResourceSubset
    && leftResourceUrls.size < rightResourceUrls.size;
  const leftTruncated = left.truncated === true;
  const rightTruncated = right.truncated === true;
  const completeness = (candidate: CollectedDocument): number =>
    candidate.truncated === false ? 1 : 0;
  let selected: CollectedDocument;
  if (leftTruncated || rightTruncated) {
    selected = right.text.length > left.text.length
      || (
        right.text.length === left.text.length
        && rightAssetAuthority > leftAssetAuthority
      )
      || (
        right.text.length === left.text.length
        && rightAssetAuthority === leftAssetAuthority
        && leftHasStrictResourceSubset
      )
      ? right
      : left;
  } else {
    const leftCompleteness = completeness(left);
    const rightCompleteness = completeness(right);
    selected = rightCompleteness > leftCompleteness
      || (rightCompleteness === leftCompleteness && right.text.length > left.text.length)
      || (
        rightCompleteness === leftCompleteness
        && right.text.length === left.text.length
        && rightAssetAuthority > leftAssetAuthority
      )
      || (
        rightCompleteness === leftCompleteness
        && right.text.length === left.text.length
        && rightAssetAuthority === leftAssetAuthority
        && leftHasStrictResourceSubset
      )
      ? right
      : left;
  }
  const conflict = identityConflict ? 'identity' : bodyConflict ? 'body' : undefined;
  const secondary = selected === left ? right : left;
  // 一份 source/API 或成功展开观察已经明确证明完整时，unknown 旧帧的正文资源
  // 不能再被 union 回来；虚拟列表可能在根 id 切到 B 后仍短暂保留 A 的资源。
  const mayMergeSecondaryAssets = !(
    (selected.truncated === false && secondary.truncated !== false)
    || assetAuthority(selected) > assetAuthority(secondary)
  );
  const merged = !conflict && compatibleBodies && mayMergeSecondaryAssets
    ? mergeZsxqDocumentAssets(
        selected,
        secondary,
        new Set([...leftArticleUrls, ...rightArticleUrls]),
      )
    : selected;
  return {
    document: leftTruncated || rightTruncated || conflict
      ? { ...merged, truncated: true }
      : merged,
    ...(conflict ? { conflict } : {}),
  };
}

/** 按固定视图顺序合并 topic；元数据保持协议允许的 primitive 字符串。 */
export function unionZsxqViewDocuments(views: readonly ZsxqViewDocuments[]): CollectedDocument[] {
  const union = new Map<string, { document: CollectedDocument; labels: Set<ZsxqPlanView> }>();
  for (const view of views) {
    for (const document of view.documents) {
      const existing = union.get(document.canonicalUrl);
      if (existing) {
        existing.labels.add(view.label);
        existing.document = mergeZsxqDocumentCopies(existing.document, document).document;
      }
      else union.set(document.canonicalUrl, { document, labels: new Set([view.label]) });
    }
  }
  return [...union.values()]
    .map(({ document, labels }) => ({
      ...document,
      sourceMetadata: {
        ...(document.sourceMetadata ?? {}),
        viewLabels: ZSXQ_PLAN_VIEWS.filter(label => labels.has(label)).join('、'),
      },
    }))
    .sort((left, right) => left.canonicalUrl.localeCompare(right.canonicalUrl));
}

export interface CollectionBatch {
  id: string;
  planId: CollectionPlanId;
  status: BatchStatus;
  startedAt: string;
  finishedAt?: string;
  discovered: number;
  accepted: number;
  saved: number;
  skipped: number;
  failed: number;
  needsAttention: number;
  /** 已成功同步到目标仓库收件箱的稳定内容 ID；下游只加工这里列出的本批内容。 */
  deliveryIds: string[];
  /** 手动补采不得占用当天的自动日任务；旧批次缺失时由服务按兼容规则推断。 */
  trigger?: CollectionPlanTrigger;
  /** 需要二次筛选的计划用持久状态保证 Bridge 重启后可续跑。 */
  selectionStatus?: 'collecting' | 'pending' | 'completed';
  /** 知识星球计划是否已创建完本轮全部子任务；旧运行中批次缺失时按未完成恢复。 */
  preparationStatus?: 'collecting' | 'completed';
  /** 当前知识星球 staging 尝试；重连时换新，旧轮结果与子任务必须拒绝。 */
  preparationAttempt?: CollectionPlanAttempt;
  /** 用户要求强制修复；重启/重连后仍要绕过旧库已完整判定重采。 */
  force?: boolean;
  /** 已分发的目标补齐轮数；旧批次没有该字段时仍按零轮兼容读取。 */
  rounds?: number;
  /** 知识星球逐日增量或显式历史审计模式。 */
  zsxqMode?: ZsxqCollectionMode;
  /** 只看星主分页、去重、过滤和逐日覆盖的结构化审计事实。 */
  ownerAudit?: ZsxqOwnerAudit;
  coverage?: Record<string, number>;
  /** 固定计划过滤原因的同源计数，便于审计为什么没入选。 */
  rejections?: Record<string, number>;
  /** 固定计划逐条过滤明细，保留 URL 与原因以便定位正文缺失。 */
  rejectionDetails?: CollectionPlanRejection[];
  error?: string;
}

const countSchema = z.number().int().min(0);
export const collectionPlanIdSchema = z.enum(COLLECTION_PLAN_IDS);
export const zsxqCollectionModeSchema = z.enum(ZSXQ_COLLECTION_MODES);
export const zsxqOwnerItemFactSchema = z.object({
  url: z.string().url().max(4096),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  outcome: z.enum(ZSXQ_OWNER_ITEM_OUTCOMES),
  mappedUrl: z.string().url().max(4096),
}).strict();
export const zsxqDayDraftSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  rawOwnerCount: countSchema,
  qualifyingCount: countSchema,
  filteredCount: countSchema,
  exactDuplicateCount: countSchema,
  semanticDuplicateCount: countSchema,
  knownCompleteCount: countSchema,
  repairCount: countSchema,
  candidateCount: countSchema,
  savedCount: countSchema,
  failedCount: countSchema,
  crossedDayBoundary: z.boolean(),
  itemFacts: z.array(zsxqOwnerItemFactSchema).max(10_000).optional(),
}).strict();
export const zsxqOwnerCheckpointSchema = z.object({
  mode: zsxqCollectionModeSchema,
  cursor: z.iso.datetime().optional(),
  pagesFetched: countSchema,
  newestObservedAt: z.iso.datetime().optional(),
  oldestObservedAt: z.iso.datetime().optional(),
  exhausted: z.boolean(),
}).strict();
export const zsxqOwnerAuditSchema = z.object({
  mode: zsxqCollectionModeSchema,
  pagesFetched: countSchema,
  observed: countSchema,
  qualifying: countSchema,
  exactDuplicates: countSchema,
  semanticDuplicates: countSchema,
  filtered: countSchema,
  knownComplete: countSchema,
  repaired: countSchema,
  saved: countSchema,
  failed: countSchema,
  newestObservedAt: z.iso.datetime().optional(),
  oldestObservedAt: z.iso.datetime().optional(),
  exhausted: z.boolean(),
  safetyCapReached: z.boolean(),
  completedDays: countSchema,
  emptyDays: countSchema,
  failedDays: countSchema,
}).strict();
export const collectionBatchSchema = z.object({
  id: z.string().trim().min(1).max(200),
  planId: collectionPlanIdSchema,
  status: z.enum(BATCH_STATUSES),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().optional(),
  discovered: countSchema,
  accepted: countSchema,
  saved: countSchema,
  skipped: countSchema,
  failed: countSchema,
  needsAttention: countSchema,
  deliveryIds: z.array(z.string().regex(/^[a-f0-9]{12}$/)).max(100).default([]),
  trigger: z.enum(COLLECTION_PLAN_TRIGGERS).optional(),
  selectionStatus: z.enum(['collecting', 'pending', 'completed']).optional(),
  preparationStatus: z.enum(['collecting', 'completed']).optional(),
  preparationAttempt: collectionPlanAttemptSchema.optional(),
  force: z.boolean().optional(),
  rounds: countSchema.optional(),
  zsxqMode: zsxqCollectionModeSchema.optional(),
  ownerAudit: zsxqOwnerAuditSchema.optional(),
  coverage: z.record(z.string().trim().min(1).max(100), countSchema).optional(),
  rejections: z.record(z.string().trim().min(1).max(100), countSchema).optional(),
  rejectionDetails: z.array(collectionPlanRejectionSchema).max(500).optional(),
  error: z.string().trim().min(1).max(2_000).optional(),
}).superRefine((batch, context) => {
  const terminal = batch.status !== 'running';
  if (terminal !== Boolean(batch.finishedAt)) {
    context.addIssue({
      code: 'custom',
      path: ['finishedAt'],
      message: terminal ? '终态批次必须有完成时间' : '运行中批次不能有完成时间',
    });
  }
  if (batch.accepted > batch.discovered) {
    context.addIssue({ code: 'custom', path: ['accepted'], message: '接受数不能超过发现数' });
  }
  const terminalCount = batch.saved + batch.skipped + batch.failed + batch.needsAttention;
  if (terminalCount > batch.discovered) {
    context.addIssue({ code: 'custom', path: ['discovered'], message: '结果数不能超过发现数' });
  }
  if (batch.zsxqMode && batch.planId !== 'zsxq-chen-teacher') {
    context.addIssue({
      code: 'custom',
      path: ['zsxqMode'],
      message: '只有知识星球计划支持逐日或历史模式',
    });
  }
  if (batch.ownerAudit && batch.ownerAudit.mode !== batch.zsxqMode) {
    context.addIssue({
      code: 'custom',
      path: ['ownerAudit', 'mode'],
      message: '只看星主审计模式必须与批次模式一致',
    });
  }
  if (batch.status === 'completed' && batch.zsxqMode === 'owner-history') {
    if (!batch.ownerAudit) {
      context.addIssue({
        code: 'custom',
        path: ['ownerAudit'],
        message: '历史审计完成批次必须包含审计事实',
      });
    } else if (
      batch.ownerAudit.exhausted !== true
      || batch.ownerAudit.safetyCapReached
      || batch.ownerAudit.failed > 0
      || batch.ownerAudit.failedDays > 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['ownerAudit'],
        message: '历史审计未证明安全耗尽，不能标记完成',
      });
    }
  }
});
