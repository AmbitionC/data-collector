import {
  mergeZsxqDocumentCopies,
  unionZsxqViewDocuments,
  zsxqDateRangeSchema,
  type CollectedDocument,
  type ZsxqDateRange,
  type ZsxqPlanView,
} from '@data-collector/shared';
import {
  createTimeOf,
  harvestTopics,
  inlineMarkupToHtml,
  parseTopicJson,
  preferredTopicRecord,
  stripInlineMarkup,
  sourceAssetsOf,
  TOPIC_MESSAGE_CHARACTER_LIMIT,
  type TopicRecord,
} from './topicIndex.js';
import { advertisementIn } from './adFilter.js';
import { excludedBy, isLifeTeacherInterest } from './topicFilter.js';
import { buildDocument } from './extractors/common.js';
import type { ZsxqOwnerComment, ZsxqOwnerComments } from './zsxqOwnerComments.js';
export { appendZsxqOwnerComments } from './zsxqOwnerComments.js';

/** The web client returns nested replies inline; page root comments with its observed cursor. */
export async function collectZsxqApiOwnerComments(
  groupId: string,
  topicId: string,
  dependencies: ZsxqApiFallbackDependencies,
): Promise<ZsxqOwnerComments> {
  function invalid(part: string, detail: string): never {
    throw new Error(`ZSXQ_COMMENTS_${part}_UNPROVEN：${detail}`);
  }
  if (!/^\d{6,25}$/u.test(groupId) || !/^\d{15,25}$/u.test(topicId)) invalid('PARENT', '原帖编号无效');
  const common = { fetcher: dependencies.fetcher ?? fetch.bind(globalThis),
    requestId: dependencies.requestId ?? (() => crypto.randomUUID()), aduid: dependencies.aduid };
  const group = responseData(await apiGet(`${API_ROOT}/groups/${groupId}`, common))?.group;
  if (!isRecord(group) || identifier(group.group_id ?? group.groupId) !== groupId) invalid('GROUP', '星球身份不一致');
  const owner = isRecord(group.owner) ? group.owner : undefined;
  const ownerId = owner ? identifier(owner.user_id ?? owner.userId) : undefined;
  if (!ownerId) invalid('OWNER', '缺少可核验星主账号');
  const topic = responseData(await apiGet(`${API_ROOT}/topics/${topicId}`, common))?.topic;
  if (!isRecord(topic) || identifier(topic.topic_id ?? topic.topicId) !== topicId
    || !isRecord(topic.group) || identifier(topic.group.group_id ?? topic.group.groupId) !== groupId) invalid('PARENT', '原帖身份不一致');
  const result: ZsxqOwnerComments = { groupId, topicId, ownerId,
    ownerName: nameOf(owner) ?? '陈老师', collectedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    pagesFetched: 0, exhausted: false, unavailableReplyCount: 0, comments: [] };
  const seen = new Map<string, string>();
  const rootIds = new Set<string>();
  let cursor: string | undefined;
  const identity = (value: unknown): { node: Record<string, unknown>; id: string; ownerId: string; time: string } => {
    if (!isRecord(value)) invalid('BODY', '评论不是对象');
    const id = identifier(value.comment_id);
    const author = isRecord(value.owner) ? identifier(value.owner.user_id) : undefined;
    const time = typeof value.create_time === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(value.create_time)
      && Number.isFinite(Date.parse(value.create_time)) ? value.create_time : undefined;
    if (!id || !/^\d{15,25}$/u.test(id) || !author || !time) invalid('IDENTITY', '评论编号、作者或时间无法核验');
    return { node: value, id, ownerId: author, time };
  };
  for (let page = 0; page < MAX_VIEW_PAGES; page += 1) {
    const url = new URL(`${API_ROOT}/topics/${topicId}/comments`);
    url.searchParams.set('sort', 'asc'); url.searchParams.set('count', '30'); url.searchParams.set('with_sticky', 'true');
    if (cursor) url.searchParams.set('begin_time', cursor);
    const data = responseData(await apiGet(url.href, common));
    if (!data || !Array.isArray(data.comments) || data.comments.length > 30) invalid('BODY', '评论分页结构无效');
    result.pagesFetched += 1;
    let previousTime = cursor ? Date.parse(cursor) : -Infinity;
    let newRoots = 0;
    let lastTime: string | undefined;
    for (const value of data.comments) {
      const root = identity(value);
      if (root.node.sticky !== true) {
        if (Date.parse(root.time) < previousTime) invalid('CURSOR', '评论未按创建时间正序返回');
        previousTime = Date.parse(root.time); lastTime = root.time;
      }
      const newRoot = !rootIds.has(root.id);
      if (newRoot) { rootIds.add(root.id); newRoots += 1; }
      const nested = root.node.replied_comments ?? [];
      if (!Array.isArray(nested) || nested.length > 2_000) invalid('BODY', '嵌套回复结构无效');
      const replyCount = root.node.replies_count ?? 0;
      if (typeof replyCount !== 'number' || !Number.isSafeInteger(replyCount) || replyCount < 0) invalid('BODY', '回复计数无效');
      if (newRoot) result.unavailableReplyCount += Math.max(0, replyCount - nested.length);
      const thread = [root, ...nested.map(identity)];
      for (const [position, candidate] of thread.entries()) {
        if (candidate !== root && identifier(candidate.node.parent_comment_id) !== root.id) invalid('PARENT', '嵌套回复不属于该评论');
        const text = candidate.node.text ?? '';
        if (typeof text !== 'string' || text.length > 200_000) invalid('BODY', '评论正文无效或过长');
        const fingerprint = JSON.stringify([candidate.ownerId, candidate.time, text,
          ...['parent_comment_id', 'images', 'files', 'attachments', 'audio', 'audios', 'video', 'videos', 'article']
            .map(key => candidate.node[key])]);
        const old = seen.get(candidate.id);
        if (old !== undefined && old !== fingerprint) invalid('CONFLICT', '同一评论编号返回不同正文');
        if (old !== undefined) continue;
        seen.set(candidate.id, fingerprint);
        if (candidate.ownerId !== ownerId) continue;
        const rootText = root.node.text ?? '';
        if (typeof rootText !== 'string') invalid('BODY', '评论上下文无效');
        const assets = sourceAssetsOf({ talk: candidate.node });
        const replieeId = isRecord(candidate.node.repliee) ? identifier(candidate.node.repliee.user_id) : undefined;
        // The API identifies the replied-to user, not a unique nested comment. Retain all of
        // that user's earlier visible questions plus the root instead of guessing one.
        const contextNodes = candidate === root ? [] : thread.slice(0, position).filter((entry, index) =>
          index === 0 || replieeId === undefined || entry.ownerId === replieeId);
        const contextAssets = contextNodes.map(entry => sourceAssetsOf({ talk: entry.node }));
        if (!assets.proven || contextAssets.some(a => !a.proven)) invalid('MEDIA', '评论或上下文资源未能完整解析');
        if (!stripInlineMarkup(text).trim() && assets.images.length === 0 && assets.attachments.length === 0) {
          invalid('BODY', '星主评论没有可归档正文或资源');
        }
        const comment: ZsxqOwnerComment = {
          id: candidate.id, rootId: root.id, publishedAt: new Date(candidate.time).toISOString(), text,
          contextText: candidate === root ? '' : rootText,
          contextAuthor: nameOf(root.node.owner) ?? '成员',
          contextComments: contextNodes.map(entry => {
            const contextText = entry.node.text ?? '';
            if (typeof contextText !== 'string' || contextText.length > 200_000) invalid('BODY', '嵌套提问正文无法核验');
            return { id: entry.id, author: nameOf(entry.node.owner) ?? '成员',
              publishedAt: new Date(entry.time).toISOString(), text: contextText };
          }),
          ...(nameOf(candidate.node.repliee) ? { replyTo: nameOf(candidate.node.repliee)! } : {}),
          images: [...assets.images, ...contextAssets.flatMap(a => a.images)],
          attachments: [...assets.attachments, ...contextAssets.flatMap(a => a.attachments)],
        };
        result.comments.push(comment);
      }
    }
    if (JSON.stringify(result).length > TOPIC_MESSAGE_CHARACTER_LIMIT) invalid('PAYLOAD', '评论超过安全上限');
    if (data.comments.length < 30) { result.exhausted = true; return result; }
    if (!newRoots || !lastTime || (cursor && Date.parse(lastTime) <= Date.parse(cursor))) invalid('CURSOR', '评论游标未前进');
    cursor = lastTime;
  }
  return invalid('LIMIT', '评论达到分页安全上限，未证明耗尽');
}

const API_ROOT = 'https://api.zsxq.com/v2';
const WEB_ROOT = 'https://wx.zsxq.com/group';
const X_VERSION = '2.96.0';
const REQUIRED_VIEWS: readonly ZsxqPlanView[] = ['最新', '精华', '只看星主'];
const TOPIC_PAGE_SIZE = 20;
const STICKY_TOPIC_COUNT = 3;
const PLAN_LOOKBACK_MS = 15 * 24 * 60 * 60 * 1_000;
const PLAN_ITEMS_PER_VIEW = 20;
const MAX_VIEW_PAGES = 12;
const MAX_TOPIC_FILES = 20;
const API_TRANSPORT_TIMEOUT_MS = 10_000;
const API_TRANSPORT_ATTEMPTS = 3;
const DETAIL_BODY_KEYS = ['talk', 'article', 'question', 'answer', 'task', 'solution'] as const;
const EXPECTED_SCOPES: Record<ZsxqPlanView, string> = {
  最新: 'all',
  精华: 'digests',
  只看星主: 'by_owner',
};

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ZsxqApiFallbackDependencies {
  fetcher?: Fetcher;
  aduid: string;
  now?: () => Date;
  requestId?: () => string;
  /** Detached HTML parsing root. Browser callers use the current content document. */
  domDocument?: Document;
  dateRange?: ZsxqDateRange;
}

export interface ZsxqApiCollection {
  documents: CollectedDocument[];
  businessSkips: Array<{ url: string; reason: string }>;
  coverage: Record<string, number>;
}

export interface ZsxqOwnerApiContext {
  ownerId: string;
  ownerName?: string;
  scope: 'by_owner';
}

export interface ZsxqOwnerPageRequest {
  cursor?: string;
  context?: ZsxqOwnerApiContext;
}

export interface ZsxqOwnerPage {
  documents: CollectedDocument[];
  businessSkips: Array<{ url: string; reason: string; publishedAt: string }>;
  rawCount: number;
  pageKey: string;
  nextCursor?: string;
  exhausted: boolean;
  newestObservedAt?: string;
  oldestObservedAt?: string;
  context: ZsxqOwnerApiContext;
}

/** Read one authenticated detail without relying on the SPA's DOM layout or scanning feeds. */
export async function collectZsxqApiTopic(
  groupId: string,
  topicId: string,
  dependencies: ZsxqApiFallbackDependencies,
): Promise<CollectedDocument> {
  if (!/^\d{6,25}$/u.test(groupId) || !/^\d{15,25}$/u.test(topicId)) {
    throw coverageError('ZSXQ_API_TOPIC_UNPROVEN', '单条详情缺少有效的星球或帖子编号');
  }
  const common = {
    fetcher: dependencies.fetcher ?? fetch.bind(globalThis),
    requestId: dependencies.requestId ?? (() => crypto.randomUUID()),
    aduid: dependencies.aduid,
  };
  const groupPayload = await apiGet(`${API_ROOT}/groups/${groupId}`, common);
  const group = responseData(groupPayload)?.group;
  if (!isRecord(group) || identifier(group.group_id ?? group.groupId) !== groupId) {
    throw coverageError('ZSXQ_API_GROUP_UNPROVEN', '单条详情接口未证明目标星球身份');
  }
  const owner = isRecord(group.owner) ? group.owner : undefined;
  const ownerId = owner ? identifier(owner.user_id ?? owner.userId) : undefined;
  if (!owner || !ownerId) throw new Error('AUTHOR_IDENTITY_UNPROVEN：缺少可核验星主身份');
  const payload = await apiGet(`${API_ROOT}/topics/${topicId}`, common);
  const data = responseData(payload);
  const topic = isRecord(data?.topic)
    ? data.topic : data && identifier(data.topic_id ?? data.topicId) ? data : undefined;
  const topicGroup = topic && isRecord(topic.group) ? topic.group : undefined;
  if (!topic || identifier(topic.topic_id ?? topic.topicId) !== topicId
    || !topicGroup || identifier(topicGroup.group_id ?? topicGroup.groupId) !== groupId) {
    throw coverageError('ZSXQ_API_TOPIC_UNPROVEN', '单条详情接口返回了不同帖子或星球');
  }
  const author = topicOwner(topic);
  if (!author || identifier(author.user_id ?? author.userId) !== ownerId) {
    throw new Error('AUTHOR_IDENTITY_UNPROVEN：单条详情未证明为星主发布');
  }
  const createTime = createTimeOf(topic);
  if (!createTime) throw coverageError('ZSXQ_API_PUBLISHED_AT_UNPROVEN', '单条详情缺少可核验发布时间');
  const hydrated = await hydrateTopicFileUrls(payload, topicId, common);
  const document = ownerDetailDocument(groupId, topicId, hydrated, owner,
    (dependencies.now ?? (() => new Date()))().toISOString(), createTime);
  const sourceMetadata: NonNullable<CollectedDocument['sourceMetadata']> = {
    ...document.sourceMetadata, apiTopicDetail: true,
  };
  delete sourceMetadata.viewLabels;
  return { ...document, sourceMetadata };
}

function shanghaiPublicationDay(publishedAt: string | undefined): string | undefined {
  if (!publishedAt || !Number.isFinite(Date.parse(publishedAt))) return undefined;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(publishedAt));
}

function addPublicationCoverage(
  coverage: Record<string, number>,
  documents: readonly CollectedDocument[],
): void {
  for (const document of documents) {
    const day = shanghaiPublicationDay(document.publishedAt);
    if (!day) continue;
    const key = `发布日期:${day}`;
    coverage[key] = (coverage[key] ?? 0) + 1;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function identifier(value: unknown): string | undefined {
  if (typeof value === 'string' && /^\d+$/u.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

function nameOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const name = value.name;
  return typeof name === 'string' && name.trim() ? name.trim() : undefined;
}

async function sha1Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function signedHeaders(url: string, aduid: string, requestId: string): Promise<Headers> {
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  return new Headers({
    'X-Aduid': aduid,
    'X-Request-Id': requestId,
    'X-Signature': await sha1Hex(`${url} ${timestamp} ${requestId}`),
    'X-Timestamp': timestamp,
    'X-Version': X_VERSION,
  });
}

const MEMBER_ACCESS_ERROR_CODES = new Set([
  '401', '403',
  '1005', '1008', '1009', '1015',
  '1030', '1036', '1037',
]);

function serverCode(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const code = payload.code;
  if (typeof code === 'string' && code.trim()) return code.trim();
  if (typeof code === 'number' && Number.isSafeInteger(code)) return String(code);
  return undefined;
}

function serverDetail(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  for (const key of ['info', 'message', 'msg', 'error'] as const) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 500);
    if (!isRecord(value)) continue;
    for (const nestedKey of ['info', 'message', 'msg'] as const) {
      const nested = value[nestedKey];
      if (typeof nested === 'string' && nested.trim()) return nested.trim().slice(0, 500);
    }
  }
  return undefined;
}

function failureEvidence(payload: unknown, status: number): string {
  const code = serverCode(payload);
  const detail = serverDetail(payload);
  return [
    `HTTP ${status}`,
    ...(code ? [`服务端 code ${code}`] : []),
    ...(detail ? [detail] : []),
  ].join('，');
}

function coverageError(code: string, message: string): Error {
  return new Error(`CONTENT_COVERAGE_INCOMPLETE（${code}）：${message}`);
}

async function apiGet(
  url: string,
  dependencies: Required<Pick<ZsxqApiFallbackDependencies, 'fetcher' | 'requestId'>>
    & Pick<ZsxqApiFallbackDependencies, 'aduid'>,
): Promise<unknown> {
  let response: Response | undefined;
  let body: string | undefined;
  let transportError: unknown;
  for (let attempt = 1; attempt <= API_TRANSPORT_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TRANSPORT_TIMEOUT_MS);
    try {
      response = await dependencies.fetcher(url, {
        credentials: 'include',
        headers: await signedHeaders(url, dependencies.aduid, dependencies.requestId()),
        signal: controller.signal,
      });
      body = await response.text();
      transportError = undefined;
      break;
    } catch (error) {
      transportError = error;
    } finally {
      clearTimeout(timeout);
    }
  }
  if (!response || body === undefined) {
    const detail = transportError instanceof Error ? transportError.message : String(transportError);
    throw new Error(
      `ZSXQ_API_FALLBACK_FAILED：知识星球接口请求失败（已重试 ${API_TRANSPORT_ATTEMPTS} 次）：${detail}`,
    );
  }
  let payload: unknown;
  try {
    payload = parseTopicJson(body);
  } catch {
    if (response.status === 401 || response.status === 403) {
      throw new Error(`AUTH_REQUIRED：知识星球登录或成员访问不可用（HTTP ${response.status}）`);
    }
    throw new Error(`ZSXQ_API_FALLBACK_FAILED：知识星球接口返回了非 JSON 内容（HTTP ${response.status}）`);
  }
  const code = serverCode(payload);
  const evidence = failureEvidence(payload, response.status);
  if (code === '1059') {
    throw new Error(`ZSXQ_API_SIGNATURE_INVALID：知识星球接口签名校验失败（${evidence}）`);
  }
  if (
    response.status === 401
    || response.status === 403
    || (code !== undefined && MEMBER_ACCESS_ERROR_CODES.has(code))
  ) {
    throw new Error(`AUTH_REQUIRED：知识星球登录或成员访问不可用（${evidence}）`);
  }
  if (!response.ok || !isRecord(payload) || payload.succeeded !== true) {
    throw new Error(`ZSXQ_API_FALLBACK_FAILED：知识星球接口拒绝请求（${evidence}）`);
  }
  return payload;
}

function responseData(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined;
  return isRecord(payload.resp_data) ? payload.resp_data : undefined;
}

function linkedArticleIdentity(rawUrl: string): { articleId: string; url: URL } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw coverageError('ZSXQ_API_ARTICLE_ID_UNPROVEN', '关联长文地址不是有效 URL');
  }
  const match = /^\/id_([A-Za-z0-9_-]{1,128})\.html$/u.exec(url.pathname);
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'articles.zsxq.com'
    || url.port !== ''
    || url.username !== ''
    || url.password !== ''
    || !match?.[1]
  ) {
    throw coverageError(
      'ZSXQ_API_ARTICLE_ID_UNPROVEN',
      `关联长文地址不符合知识星球文章格式：${rawUrl.slice(0, 300)}`,
    );
  }
  url.search = '';
  url.hash = '';
  return { articleId: match[1], url };
}

/**
 * Reads one linked long-form article from the same signed endpoint used by ZSXQ's web app.
 * This runs inside a ZSXQ content script, so cookies stay in the browser and are never exported.
 */
export async function collectZsxqApiArticle(
  rawArticleUrl: string,
  dependencies: ZsxqApiFallbackDependencies,
): Promise<CollectedDocument> {
  const { articleId, url } = linkedArticleIdentity(rawArticleUrl);
  const fetcher = dependencies.fetcher ?? fetch.bind(globalThis);
  const requestId = dependencies.requestId ?? (() => crypto.randomUUID());
  const payload = await apiGet(`${API_ROOT}/articles/${articleId}`, {
    fetcher,
    requestId,
    aduid: dependencies.aduid,
  });
  const data = responseData(payload);
  if (!data) {
    throw coverageError('ZSXQ_API_ARTICLE_INVALID', `文章 ${articleId} 未返回 resp_data`);
  }
  const explicitId = data.article_id ?? data.articleId;
  if (
    explicitId !== undefined
    && (typeof explicitId !== 'string'
      || explicitId.replace(/^id_/u, '') !== articleId)
  ) {
    throw coverageError(
      'ZSXQ_API_ARTICLE_CONFLICT',
      `文章接口返回的 article_id 与请求的 ${articleId} 不一致`,
    );
  }
  const title = typeof data.title === 'string' ? data.title.trim() : '';
  const content = typeof data.content === 'string' ? data.content : '';
  if (!title || !content.trim()) {
    throw coverageError(
      'ZSXQ_API_ARTICLE_INVALID',
      `文章 ${articleId} 缺少可核验标题或正文`,
    );
  }
  if (content.length > TOPIC_MESSAGE_CHARACTER_LIMIT) {
    throw coverageError(
      'ZSXQ_API_PAYLOAD_LIMIT',
      `文章 ${articleId} 正文超过 ${TOPIC_MESSAGE_CHARACTER_LIMIT} 字符安全上限`,
    );
  }
  const domDocument = dependencies.domDocument ?? globalThis.document;
  if (!domDocument) {
    throw coverageError('ZSXQ_API_ARTICLE_INVALID', `文章 ${articleId} 缺少安全 HTML 解析环境`);
  }
  const container = domDocument.createElement('article');
  container.innerHTML = content;
  const rawImageCount = container.querySelectorAll('img').length;
  const collectedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const document = buildDocument({
    source: 'zsxq',
    kind: 'article',
    title,
    content: container,
    url,
    now: () => collectedAt,
    truncated: false,
    sourceMetadata: {
      articleId,
      sourceBodyProven: true,
      sourceMediaProven: true,
      sourceCoversDom: true,
      extractionMode: 'signed-article-api',
    },
  });
  if (!document.text.trim()) {
    throw coverageError('ZSXQ_API_ARTICLE_INVALID', `文章 ${articleId} 清理后正文为空`);
  }
  if (document.images.length !== rawImageCount) {
    throw coverageError(
      'ZSXQ_API_ARTICLE_MEDIA_UNPROVEN',
      `文章 ${articleId} 的 ${rawImageCount} 张图片中只有 ${document.images.length} 张可核验`,
    );
  }
  return document;
}

function safeDownloadUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Topic detail responses expose attachment metadata but deliberately omit the downloadable URL.
 * Resolve only file objects reachable through the expected topic body; comments and quoted topics
 * must never cause unrelated authenticated file requests.
 */
async function hydrateTopicFileUrls(
  payload: unknown,
  topicId: string,
  dependencies: Required<Pick<ZsxqApiFallbackDependencies, 'fetcher' | 'requestId'>>
    & Pick<ZsxqApiFallbackDependencies, 'aduid'>,
): Promise<unknown> {
  const cloned: unknown = structuredClone(payload);
  const data = responseData(cloned);
  const topic = isRecord(data?.topic)
    ? data.topic
    : data && identifier(data.topic_id ?? data.topicId) ? data : undefined;
  if (!topic || identifier(topic.topic_id ?? topic.topicId) !== topicId) return cloned;

  const filesById = new Map<string, Record<string, unknown>[]>();
  let visited = 0;
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || visited >= 500) return;
    visited += 1;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    for (const key of ['files', 'attachments'] as const) {
      if (!Array.isArray(value[key])) continue;
      for (const rawFile of value[key]) {
        if (!isRecord(rawFile)) continue;
        const alreadyResolved = [
          rawFile.download_url, rawFile.downloadUrl, rawFile.file_url, rawFile.fileUrl,
          rawFile.url, rawFile.href,
        ].some(candidate => safeDownloadUrl(candidate) !== undefined);
        if (alreadyResolved) continue;
        const fileId = identifier(rawFile.file_id ?? rawFile.fileId);
        if (!fileId) {
          throw coverageError(
            'ZSXQ_API_FILE_UNPROVEN',
            `帖子 ${topicId} 的附件缺少可核验 file_id`,
          );
        }
        const copies = filesById.get(fileId) ?? [];
        copies.push(rawFile);
        filesById.set(fileId, copies);
      }
    }
    for (const key of ['text', 'content', ...DETAIL_BODY_KEYS] as const) {
      if (key in value) visit(value[key], depth + 1);
    }
  };
  for (const key of DETAIL_BODY_KEYS) {
    if (key in topic) visit(topic[key], 0);
  }
  if (filesById.size > MAX_TOPIC_FILES) {
    throw coverageError(
      'ZSXQ_API_FILE_UNPROVEN',
      `帖子 ${topicId} 包含 ${filesById.size} 个待解析附件，超过安全上限 ${MAX_TOPIC_FILES}`,
    );
  }

  await Promise.all([...filesById].map(async ([fileId, files]) => {
    const filePayload = await apiGet(
      `${API_ROOT}/files/${fileId}/download_url`,
      dependencies,
    );
    const downloadUrl = safeDownloadUrl(responseData(filePayload)?.download_url);
    if (!downloadUrl) {
      throw coverageError(
        'ZSXQ_API_FILE_UNPROVEN',
        `帖子 ${topicId} 的附件 ${fileId} 未返回有效下载地址`,
      );
    }
    for (const file of files) file.download_url = downloadUrl;
  }));
  return cloned;
}

function topicNodes(
  payload: unknown,
  feed: string,
  maximumTopics: number,
): Record<string, unknown>[] {
  const topics = responseData(payload)?.topics;
  if (!Array.isArray(topics)) {
    throw coverageError('ZSXQ_API_RESPONSE_INVALID', `${feed}未返回 topics 数组`);
  }
  if (topics.length > maximumTopics) {
    throw coverageError(
      'ZSXQ_API_RESPONSE_INVALID',
      `${feed}返回 ${topics.length} 条 topic，超过请求的 ${maximumTopics} 条`,
    );
  }
  return topics.map((topic, index) => {
    if (!isRecord(topic)) {
      throw coverageError('ZSXQ_API_RESPONSE_INVALID', `${feed}第 ${index + 1} 条 topic 不是对象`);
    }
    return topic;
  });
}

function topicOwner(topic: Record<string, unknown>): Record<string, unknown> | undefined {
  const type = typeof topic.type === 'string' ? topic.type : '';
  if (type === 'q&a' || type === 'qa' || type === 'question') {
    const answer = isRecord(topic.answer) ? topic.answer : undefined;
    const question = isRecord(topic.question) ? topic.question : undefined;
    const answeredOwner = answer && isRecord(answer.owner) ? answer.owner : undefined;
    return answeredOwner ?? (question && isRecord(question.owner) ? question.owner : undefined);
  }
  const component = isRecord(topic[type]) ? topic[type] : undefined;
  if (component && isRecord(component.owner)) return component.owner;
  return isRecord(topic.owner) ? topic.owner : undefined;
}

function questionerOf(topic: Record<string, unknown>): string | undefined {
  const question = isRecord(topic.question) ? topic.question : undefined;
  return question && isRecord(question.owner) ? nameOf(question.owner) : undefined;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function documentFromTopic(
  groupId: string,
  view: ZsxqPlanView,
  topic: Record<string, unknown>,
  record: TopicRecord,
  groupOwner: Record<string, unknown>,
  collectedAt: string,
): CollectedDocument {
  const rawBody = record.fullText ?? record.text;
  const text = stripInlineMarkup(rawBody).replace(/\n{3,}/gu, '\n\n').trim();
  const firstLine = text.split(/\n/u).map(line => line.trim()).find(Boolean) ?? '';
  const topicId = record.topicId;
  const canonicalUrl = `${WEB_ROOT}/${groupId}/topic/${topicId}`;
  const owner = topicOwner(topic);
  const authorId = owner ? identifier(owner.user_id ?? owner.userId) : undefined;
  const groupOwnerId = identifier(groupOwner.user_id ?? groupOwner.userId);
  const images = (record.images ?? []).map(image => ({
    url: image.url,
    ...(image.alt ? { alt: image.alt } : {}),
  }));
  const mediaHtml = [
    ...images.map(image => `<p><img src="${escapeHtml(image.url)}"${image.alt ? ` alt="${escapeHtml(image.alt)}"` : ''}></p>`),
    ...(record.attachments ?? []).map(attachment =>
      `<p><a href="${escapeHtml(attachment.url)}">${escapeHtml(attachment.title ?? attachment.url)}</a></p>`),
  ].join('');
  const sourceComplete = record.sourceBodyProven === true
    && record.sourceMediaProven === true
    && record.fullTextTruncated === false;
  return {
    schemaVersion: 1,
    source: 'zsxq',
    kind: 'post',
    url: canonicalUrl,
    canonicalUrl,
    title: firstLine.slice(0, 120) || `知识星球帖子 ${topicId.slice(-6)}`,
    ...(nameOf(owner) ?? nameOf(groupOwner) ? { author: nameOf(owner) ?? nameOf(groupOwner)! } : {}),
    ...(record.createTime ? { publishedAt: record.createTime } : {}),
    collectedAt,
    html: inlineMarkupToHtml(rawBody) + mediaHtml,
    text,
    images,
    truncated: !sourceComplete,
    ...(questionerOf(topic) ? { questioner: questionerOf(topic)! } : {}),
    sourceMetadata: {
      ...(authorId && groupOwnerId ? { authorRole: authorId === groupOwnerId ? 'owner' : 'member' } : {}),
      topicId,
      sourceBodyProven: record.sourceBodyProven === true,
      sourceMediaProven: record.sourceMediaProven === true,
      ...(record.sourceMediaIssues && record.sourceMediaIssues.length > 0
        ? { sourceMediaIssues: record.sourceMediaIssues.join(',') }
        : {}),
      sourceCoversDom: true,
      viewLabels: view,
      extractionMode: 'signed-api-fallback',
    },
  };
}

function viewScopes(payload: unknown): Record<ZsxqPlanView, string> {
  const scopes = new Map<ZsxqPlanView, string>();
  const data = responseData(payload);
  const menus = data?.menus;
  if (!Array.isArray(menus)) {
    throw coverageError('ZSXQ_API_VIEW_UNPROVEN', '知识星球接口未返回 menus 数组');
  }
  const optionalMenus = data?.optional_menus;
  if (optionalMenus !== undefined && !Array.isArray(optionalMenus)) {
    throw coverageError('ZSXQ_API_VIEW_UNPROVEN', '知识星球接口的 optional_menus 不是数组');
  }
  for (const menu of [...menus, ...(optionalMenus ?? [])]) {
    if (!isRecord(menu)) continue;
    const title = typeof menu.title === 'string'
      ? menu.title.replace(/^[\s#]+|[\s#]+$/gu, '')
      : '';
    if (!REQUIRED_VIEWS.includes(title as ZsxqPlanView)) continue;
    if (menu.preset !== true || typeof menu.preset_type !== 'string') continue;
    const scope = menu.preset_type.trim();
    if (!scope) continue;
    const view = title as ZsxqPlanView;
    const previous = scopes.get(view);
    if (previous && previous !== scope) {
      throw coverageError('ZSXQ_API_VIEW_UNPROVEN', `${view}菜单返回了冲突的 scope`);
    }
    scopes.set(view, scope);
  }
  const missing = REQUIRED_VIEWS.filter(view => !scopes.has(view));
  if (missing.length > 0) {
    throw coverageError('ZSXQ_API_VIEW_UNPROVEN', `知识星球接口缺少必需菜单：${missing.join('、')}`);
  }
  for (const view of REQUIRED_VIEWS) {
    const actual = scopes.get(view)!;
    if (actual !== EXPECTED_SCOPES[view]) {
      throw coverageError(
        'ZSXQ_API_VIEW_UNPROVEN',
        `${view}菜单 scope 应为 ${EXPECTED_SCOPES[view]}，实际为 ${actual}`,
      );
    }
  }
  return {
    最新: scopes.get('最新')!,
    精华: scopes.get('精华')!,
    只看星主: scopes.get('只看星主')!,
  };
}

function provenOwnerScope(payload: unknown): 'by_owner' {
  const data = responseData(payload);
  const menus = data?.menus;
  const optionalMenus = data?.optional_menus;
  if (!Array.isArray(menus) || (optionalMenus !== undefined && !Array.isArray(optionalMenus))) {
    throw coverageError('ZSXQ_API_VIEW_UNPROVEN', '知识星球接口未返回可核验菜单');
  }
  const scopes = new Set<string>();
  for (const menu of [...menus, ...(optionalMenus ?? [])]) {
    if (!isRecord(menu)) continue;
    const title = typeof menu.title === 'string'
      ? menu.title.replace(/^[\s#]+|[\s#]+$/gu, '')
      : '';
    if (title !== '只看星主' || menu.preset !== true || typeof menu.preset_type !== 'string') {
      continue;
    }
    scopes.add(menu.preset_type.trim());
  }
  if (scopes.size !== 1 || !scopes.has('by_owner')) {
    throw coverageError(
      'ZSXQ_API_VIEW_UNPROVEN',
      `只看星主菜单 scope 应为 by_owner，实际为 ${[...scopes].join('、') || '缺失'}`,
    );
  }
  return 'by_owner';
}

function ownerPageDocument(
  groupId: string,
  topic: Record<string, unknown>,
  groupOwner: Record<string, unknown>,
  collectedAt: string,
  feed: string,
  index: number,
): { topicId: string; createTime: string; document: CollectedDocument } {
  const topicId = identifier(topic.topic_id ?? topic.topicId);
  let record: TopicRecord | undefined;
  if (topicId) {
    const responsePath = `${API_ROOT}/groups/${groupId}/topics`;
    const directPayload = { succeeded: true, resp_data: { topics: [topic] } };
    for (const candidate of harvestTopics(directPayload, 40, { responsePath })) {
      if (candidate.topicId !== topicId) continue;
      record = preferredTopicRecord(record, candidate);
    }
  }
  if (!topicId || !record) {
    throw coverageError(
      'ZSXQ_API_TOPIC_UNPROVEN',
      `${feed}第 ${index + 1} 条 topic${topicId ? `（${topicId}）` : ''}无法形成可核验正文记录`,
    );
  }
  const createTime = createTimeOf(topic);
  if (!createTime) {
    throw coverageError(
      'ZSXQ_API_PUBLISHED_AT_UNPROVEN',
      `${feed}帖子 ${topicId} 缺少可核验发布时间`,
    );
  }
  const document = documentFromTopic(
    groupId,
    '只看星主',
    topic,
    { ...record, createTime },
    groupOwner,
    collectedAt,
  );
  if (document.sourceMetadata?.authorRole !== 'owner') {
    throw new Error(
      `AUTHOR_IDENTITY_UNPROVEN：${feed}帖子 ${topicId} 未证明为星主发布`,
    );
  }
  return { topicId, createTime, document };
}

function ownerDetailDocument(
  groupId: string,
  topicId: string,
  payload: unknown,
  groupOwner: Record<string, unknown>,
  collectedAt: string,
  expectedCreateTime: string,
): CollectedDocument {
  const data = responseData(payload);
  const topic = isRecord(data?.topic)
    ? data.topic
    : data && identifier(data.topic_id ?? data.topicId) ? data : undefined;
  if (!topic || identifier(topic.topic_id ?? topic.topicId) !== topicId) {
    throw coverageError(
      'ZSXQ_API_TOPIC_UNPROVEN',
      `帖子详情接口未返回预期 topic ${topicId}`,
    );
  }
  const responsePath = `${API_ROOT}/topics/${topicId}`;
  let record: TopicRecord | undefined;
  for (const candidate of harvestTopics(payload, 40, { responsePath })) {
    if (candidate.topicId !== topicId) continue;
    record = preferredTopicRecord(record, candidate);
  }
  const createTime = createTimeOf(topic);
  if (!record || !createTime || createTime !== expectedCreateTime) {
    throw coverageError(
      'ZSXQ_API_TOPIC_CONFLICT',
      `帖子详情 ${topicId} 的正文或发布时间与列表不一致`,
    );
  }
  const document = documentFromTopic(
    groupId,
    '只看星主',
    topic,
    { ...record, createTime },
    groupOwner,
    collectedAt,
  );
  if (document.sourceMetadata?.authorRole !== 'owner') {
    throw new Error(`AUTHOR_IDENTITY_UNPROVEN：帖子详情 ${topicId} 未证明为星主发布`);
  }
  return document;
}

/**
 * Fetches exactly one signed `by_owner` page. The caller persists the returned
 * cursor only after all jobs derived from this page have reached a terminal state.
 */
export async function collectZsxqApiOwnerPage(
  groupId: string,
  request: ZsxqOwnerPageRequest,
  dependencies: ZsxqApiFallbackDependencies,
): Promise<ZsxqOwnerPage> {
  const fetcher = dependencies.fetcher ?? fetch.bind(globalThis);
  const requestId = dependencies.requestId ?? (() => crypto.randomUUID());
  const common = { fetcher, requestId, aduid: dependencies.aduid };
  let context = request.context;
  if (!context) {
    const [groupPayload, menuPayload] = await Promise.all([
      apiGet(`${API_ROOT}/groups/${groupId}`, common),
      apiGet(`${API_ROOT}/groups/${groupId}/menus`, common),
    ]);
    const group = responseData(groupPayload)?.group;
    const groupOwner = isRecord(group) && isRecord(group.owner) ? group.owner : undefined;
    const ownerId = groupOwner ? identifier(groupOwner.user_id ?? groupOwner.userId) : undefined;
    if (!groupOwner || !ownerId) {
      throw new Error('AUTHOR_IDENTITY_UNPROVEN：知识星球接口未返回可核验的星主身份');
    }
    context = {
      ownerId,
      ...(nameOf(groupOwner) ? { ownerName: nameOf(groupOwner)! } : {}),
      scope: provenOwnerScope(menuPayload),
    };
  }
  if (context.scope !== 'by_owner' || !/^\d+$/u.test(context.ownerId)) {
    throw coverageError('ZSXQ_API_VIEW_UNPROVEN', '续传的只看星主上下文无效');
  }
  if (request.cursor && !Number.isFinite(Date.parse(request.cursor))) {
    throw coverageError('ZSXQ_API_CURSOR_UNPROVEN', '只看星主续传游标不是有效时间');
  }

  const responsePath = `${API_ROOT}/groups/${groupId}/topics`;
  const url = new URL(responsePath);
  url.searchParams.set('scope', context.scope);
  url.searchParams.set('count', String(TOPIC_PAGE_SIZE));
  if (request.cursor) url.searchParams.set('end_time', request.cursor);
  const payload = await apiGet(url.href, common);
  const topics = topicNodes(payload, '「只看星主」分页', TOPIC_PAGE_SIZE);
  const owner = {
    user_id: context.ownerId,
    ...(context.ownerName ? { name: context.ownerName } : {}),
  };
  const collectedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const verified = topics.map((topic, index) =>
    ownerPageDocument(groupId, topic, owner, collectedAt, '「只看星主」分页', index));
  const ids = verified.map(item => item.topicId);
  if (new Set(ids).size !== ids.length) {
    throw coverageError('ZSXQ_API_CURSOR_UNPROVEN', '只看星主单页返回了重复 topic_id');
  }
  const times = verified.map(item => Date.parse(item.createTime));
  for (let index = 1; index < times.length; index += 1) {
    if (times[index]! > times[index - 1]!) {
      throw coverageError('ZSXQ_API_ORDER_UNPROVEN', '只看星主分页未按发布时间倒序返回');
    }
  }
  if (request.cursor && times.some(time => time > Date.parse(request.cursor!))) {
    throw coverageError('ZSXQ_API_CURSOR_UNPROVEN', '只看星主分页未遵守 end_time 游标');
  }

  const documents: CollectedDocument[] = [];
  const businessSkips: ZsxqOwnerPage['businessSkips'] = [];
  for (const item of verified) {
    let document = item.document;
    let excluded = excludedBy(document.text);
    let links = [...document.html.matchAll(/\bhref="([^"]+)"/giu)].map(match => match[1]!);
    let advertisement = advertisementIn(links);
    let relevant = isLifeTeacherInterest(`${document.title}\n${document.text}`);
    // The feed can return only a `...` preview while claiming a structurally valid body. Prefer the
    // signed detail endpoint; the background DOM detail collector remains a fail-closed fallback.
    if (!excluded && !advertisement && relevant && document.truncated === true) {
      const rawDetailPayload = await apiGet(`${API_ROOT}/topics/${item.topicId}`, common);
      const detailPayload = await hydrateTopicFileUrls(
        rawDetailPayload,
        item.topicId,
        common,
      );
      const detail = ownerDetailDocument(
        groupId,
        item.topicId,
        detailPayload,
        owner,
        collectedAt,
        item.createTime,
      );
      // Same signed topic id, publication time and owner have already been proven above. The feed
      // preview can contain a duplicated title after `...`, so ordinary prefix merging is not a
      // valid identity check here; the detail representation is authoritative for this topic.
      document = detail;
      excluded = excludedBy(document.text);
      links = [...document.html.matchAll(/\bhref="([^"]+)"/giu)].map(match => match[1]!);
      advertisement = advertisementIn(links);
      relevant = isLifeTeacherInterest(`${document.title}\n${document.text}`);
    }
    const reason = excluded
      ? `${excluded.label}（按选题偏好跳过，命中：${excluded.hits.join('、')}）`
      : advertisement
        ? `${advertisement.label}（按硬证据跳过，依据：${advertisement.hits.join('；')}）`
        : !relevant ? '非投资创业主题' : undefined;
    if (reason) {
      businessSkips.push({
        url: document.canonicalUrl,
        reason,
        publishedAt: item.createTime,
      });
    } else {
      documents.push(document);
    }
  }
  if (JSON.stringify({ documents, businessSkips }).length > TOPIC_MESSAGE_CHARACTER_LIMIT) {
    throw coverageError(
      'ZSXQ_API_PAYLOAD_LIMIT',
      `单页已核验内容超过 ${TOPIC_MESSAGE_CHARACTER_LIMIT} 字符安全上限`,
    );
  }

  const exhausted = verified.length < TOPIC_PAGE_SIZE;
  const newestObservedAt = verified.at(0)?.createTime;
  const oldestObservedAt = verified.at(-1)?.createTime;
  const nextCursor = !exhausted && oldestObservedAt
    ? new Date(Date.parse(oldestObservedAt) - 1).toISOString()
    : undefined;
  if (request.cursor && nextCursor && Date.parse(nextCursor) >= Date.parse(request.cursor)) {
    throw coverageError('ZSXQ_API_CURSOR_UNPROVEN', '只看星主分页游标没有前进');
  }
  return {
    documents,
    businessSkips,
    rawCount: verified.length,
    pageKey: `${request.cursor ?? 'start'}:${ids.join(',')}`,
    ...(nextCursor ? { nextCursor } : {}),
    exhausted,
    ...(newestObservedAt ? { newestObservedAt } : {}),
    ...(oldestObservedAt ? { oldestObservedAt } : {}),
    context,
  };
}

/**
 * Fixed-plan fallback for the rare case where the ZSXQ Angular shell stays blank.
 * It performs the same signed, credentialed GETs as the page app, never reads or exports cookies.
 */
export async function collectZsxqApiViews(
  groupId: string,
  dependencies: ZsxqApiFallbackDependencies,
): Promise<ZsxqApiCollection> {
  const dateRange = dependencies.dateRange ? zsxqDateRangeSchema.parse(dependencies.dateRange) : undefined;
  const fetcher = dependencies.fetcher ?? fetch.bind(globalThis);
  const requestId = dependencies.requestId ?? (() => crypto.randomUUID());
  const common = { fetcher, requestId, aduid: dependencies.aduid };
  const [groupPayload, menuPayload] = await Promise.all([
    apiGet(`${API_ROOT}/groups/${groupId}`, common),
    apiGet(`${API_ROOT}/groups/${groupId}/menus`, common),
  ]);
  const group = responseData(groupPayload)?.group;
  const groupOwner = isRecord(group) && isRecord(group.owner) ? group.owner : undefined;
  if (!groupOwner || !identifier(groupOwner.user_id ?? groupOwner.userId)) {
    throw new Error('AUTHOR_IDENTITY_UNPROVEN：知识星球接口未返回可核验的星主身份');
  }
  const scopes = viewScopes(menuPayload);
  const referenceNow = (dependencies.now ?? (() => new Date()))();
  const collectedAt = referenceNow.toISOString();
  const cutoff = dateRange
    ? Date.parse(`${dateRange.since}T00:00:00+08:00`)
    : referenceNow.getTime() - PLAN_LOOKBACK_MS;
  const endExclusive = dateRange ? Date.parse(`${dateRange.until}T00:00:00+08:00`) + 86_400_000 : Infinity;
  const businessSkips = new Map<string, { url: string; reason: string }>();
  const observations = new Map<string, CollectedDocument>();
  let observationCharacters = 0;
  const observe = (document: CollectedDocument, feed: string): void => {
    const existing = observations.get(document.canonicalUrl);
    if (!existing) {
      observationCharacters += JSON.stringify(document).length;
      if (observationCharacters > TOPIC_MESSAGE_CHARACTER_LIMIT) {
        throw coverageError(
          'ZSXQ_API_PAYLOAD_LIMIT',
          `已核验内容超过 ${TOPIC_MESSAGE_CHARACTER_LIMIT} 字符安全上限`,
        );
      }
      observations.set(document.canonicalUrl, document);
      return;
    }
    if (
      existing.publishedAt !== document.publishedAt
      || existing.sourceMetadata?.authorRole !== document.sourceMetadata?.authorRole
    ) {
      throw coverageError(
        'ZSXQ_API_TOPIC_CONFLICT',
        `${feed}帖子 ${document.sourceMetadata?.topicId ?? document.canonicalUrl} 的身份或发布时间冲突`,
      );
    }
    const merged = mergeZsxqDocumentCopies(existing, document);
    if (merged.conflict) {
      throw coverageError(
        'ZSXQ_API_TOPIC_CONFLICT',
        `${feed}帖子 ${document.sourceMetadata?.topicId ?? document.canonicalUrl} 的正文或资源冲突`,
      );
    }
    observationCharacters += JSON.stringify(merged.document).length - JSON.stringify(existing).length;
    if (observationCharacters > TOPIC_MESSAGE_CHARACTER_LIMIT) {
      throw coverageError(
        'ZSXQ_API_PAYLOAD_LIMIT',
        `已核验内容超过 ${TOPIC_MESSAGE_CHARACTER_LIMIT} 字符安全上限`,
      );
    }
    observations.set(document.canonicalUrl, merged.document);
  };
  const documentsFromPayload = (
    payload: unknown,
    view: ZsxqPlanView,
    responsePath: string,
    feed: string,
    maximumTopics: number,
  ): {
    documents: CollectedDocument[];
    entries: Array<{ topicId: string; createTime: string }>;
  } => {
    const topics = topicNodes(payload, feed, maximumTopics);
    const verified = topics.map((topic, index) => {
      const topicId = identifier(topic.topic_id ?? topic.topicId);
      let record: TopicRecord | undefined;
      if (topicId) {
        const directPayload = { succeeded: true, resp_data: { topics: [topic] } };
        for (const candidate of harvestTopics(directPayload, 40, { responsePath })) {
          if (candidate.topicId !== topicId) continue;
          record = preferredTopicRecord(record, candidate);
        }
      }
      if (!topicId || !record) {
        throw coverageError(
          'ZSXQ_API_TOPIC_UNPROVEN',
          `${feed}第 ${index + 1} 条 topic`
          + `${topicId ? `（${topicId}）` : ''}无法形成可核验正文记录`,
        );
      }
      const createTime = createTimeOf(topic);
      if (!createTime) {
        throw coverageError(
          'ZSXQ_API_PUBLISHED_AT_UNPROVEN',
          `${feed}帖子 ${topicId} 缺少可核验发布时间`,
        );
      }
      const document = documentFromTopic(
        groupId,
        view,
        topic,
        { ...record, createTime },
        groupOwner,
        collectedAt,
      );
      if (
        document.sourceMetadata?.authorRole !== 'owner'
        && document.sourceMetadata?.authorRole !== 'member'
      ) {
        throw new Error(
          `AUTHOR_IDENTITY_UNPROVEN：${feed}帖子 ${topicId} 未返回可核验作者身份`,
        );
      }
      observe(document, feed);
      return { topicId, createTime, document };
    });
    const documents = verified.flatMap(({ document }) => {
      const time = Date.parse(document.publishedAt!);
      if (dateRange && (time < cutoff || time >= endExclusive)) return [];
      const excluded = excludedBy(document.text);
      if (excluded) {
        businessSkips.set(document.canonicalUrl, {
          url: document.canonicalUrl,
          reason: `${excluded.label}（按选题偏好跳过，命中：${excluded.hits.join('、')}）`,
        });
        return [];
      }
      const links = [...document.html.matchAll(/\bhref="([^"]+)"/giu)].map(match => match[1]!);
      const advertisement = advertisementIn(links);
      if (advertisement) {
        businessSkips.set(document.canonicalUrl, {
          url: document.canonicalUrl,
          reason: `${advertisement.label}（按硬证据跳过，依据：${advertisement.hits.join('；')}）`,
        });
        return [];
      }
      return [document];
    });
    return {
      documents,
      entries: verified.map(({ topicId, createTime }) => ({ topicId, createTime })),
    };
  };

  const addDocuments = (
    destination: Map<string, CollectedDocument>,
    documents: readonly CollectedDocument[],
  ): void => {
    for (const document of documents) {
      const existing = destination.get(document.canonicalUrl);
      destination.set(
        document.canonicalUrl,
        existing ? mergeZsxqDocumentCopies(existing, document).document : document,
      );
    }
  };

  interface ViewState {
    label: ZsxqPlanView;
    documents: Map<string, CollectedDocument>;
    seenRawIds: Set<string>;
    pagesFetched: number;
    endTime?: string;
    exhausted: boolean;
  }

  const responsePath = `${API_ROOT}/groups/${groupId}/topics`;
  const states: ViewState[] = REQUIRED_VIEWS.map(label => ({
    label,
    documents: new Map(),
    seenRawIds: new Set(),
    pagesFetched: 0,
    // Start historical windows at their upper bound instead of spending the page budget on newer posts.
    ...(dateRange ? { endTime: new Date(endExclusive).toISOString() } : {}),
    exhausted: false,
  }));
  const pruneBusinessSkips = (): void => {
    for (const state of states) {
      for (const skippedUrl of businessSkips.keys()) state.documents.delete(skippedUrl);
    }
  };

  const stickyPath = `${API_ROOT}/groups/${groupId}/topics/sticky`;
  const stickyUrl = new URL(stickyPath);
  stickyUrl.searchParams.set('count', String(STICKY_TOPIC_COUNT));
  const stickyPayload = await apiGet(stickyUrl.href, common);
  const sticky = documentsFromPayload(
    stickyPayload,
    '最新',
    stickyPath,
    '「最新」置顶列表',
    STICKY_TOPIC_COUNT,
  );

  while (true) {
    pruneBusinessSkips();
    const activeStates = states.filter(state =>
      !state.exhausted && (dateRange !== undefined || state.documents.size < PLAN_ITEMS_PER_VIEW));
    if (activeStates.length === 0) break;
    const pageLimited = activeStates.find(state => state.pagesFetched >= MAX_VIEW_PAGES);
    if (pageLimited) {
      throw coverageError(
        'ZSXQ_API_PAGE_LIMIT',
        `「${pageLimited.label}」已翻满 ${MAX_VIEW_PAGES} 页，尚未证明`
        + (dateRange ? `${dateRange.since} 至 ${dateRange.until} 范围已经耗尽` : '最近 15 天内容已经耗尽'),
      );
    }
    const pages = await Promise.all(activeStates.map(async state => {
      const url = new URL(responsePath);
      url.searchParams.set('scope', scopes[state.label]);
      url.searchParams.set('count', String(TOPIC_PAGE_SIZE));
      if (state.endTime) url.searchParams.set('end_time', state.endTime);
      return { state, payload: await apiGet(url.href, common) };
    }));

    for (const { state, payload } of pages) {
      const pageNumber = state.pagesFetched + 1;
      const feed = `「${state.label}」第 ${pageNumber} 页`;
      const converted = documentsFromPayload(
        payload,
        state.label,
        responsePath,
        feed,
        TOPIC_PAGE_SIZE,
      );
      let newRawIds = 0;
      for (const entry of converted.entries) {
        if (state.seenRawIds.has(entry.topicId)) continue;
        state.seenRawIds.add(entry.topicId);
        newRawIds += 1;
      }
      addDocuments(state.documents, converted.documents);
      const times = converted.entries.map(entry => Date.parse(entry.createTime));
      for (let index = 1; index < times.length; index += 1) {
        if (times[index]! > times[index - 1]!) {
          throw coverageError(
            'ZSXQ_API_ORDER_UNPROVEN',
            `${feed}未按发布时间倒序返回`,
          );
        }
      }
      if (state.endTime && times.some(time => time > Date.parse(state.endTime!))) {
        throw coverageError(
          'ZSXQ_API_CURSOR_UNPROVEN',
          `${feed}未遵守 end_time 游标`,
        );
      }
      if (converted.entries.length > 0 && newRawIds === 0) {
        throw coverageError(
          'ZSXQ_API_CURSOR_UNPROVEN',
          `${feed}没有出现新的 topic_id`,
        );
      }
      state.pagesFetched = pageNumber;
      if (converted.entries.length < TOPIC_PAGE_SIZE) {
        state.exhausted = true;
        continue;
      }
      const oldestTime = times.at(-1)!;
      if (dateRange ? oldestTime < cutoff : oldestTime <= cutoff) {
        state.exhausted = true;
        continue;
      }
      // Overlap the last millisecond even if the server treats end_time as exclusive.
      // Deduplicate overlap; unchanged cursor/no new IDs must fail closed.
      const nextEndTime = new Date(oldestTime + (dateRange ? 1 : -1)).toISOString();
      if (nextEndTime === state.endTime) {
        throw coverageError(
          'ZSXQ_API_CURSOR_UNPROVEN',
          `「${state.label}」分页游标没有前进`,
        );
      }
      state.endTime = nextEndTime;
    }
    pruneBusinessSkips();
  }

  const richestObservation = (document: CollectedDocument): CollectedDocument =>
    observations.get(document.canonicalUrl) ?? document;
  const byView = states.map(state => ({
    label: state.label,
    documents: [...state.documents.values()]
      .slice(0, dateRange ? undefined : PLAN_ITEMS_PER_VIEW)
      .map(richestObservation),
  }));
  const latest = byView.find(view => view.label === '最新');
  if (!latest) {
    throw coverageError('ZSXQ_API_VIEW_UNPROVEN', '未生成「最新」视图');
  }
  latest.documents = unionZsxqViewDocuments([{
    label: '最新',
    documents: [
      ...sticky.documents
        .filter(document => !businessSkips.has(document.canonicalUrl))
        .map(richestObservation),
      ...latest.documents,
    ],
  }])
    .sort((left, right) => (right.publishedAt ?? '').localeCompare(left.publishedAt ?? ''))
    .slice(0, dateRange ? undefined : PLAN_ITEMS_PER_VIEW);
  const documents = unionZsxqViewDocuments(byView)
    .filter(document => !businessSkips.has(document.canonicalUrl));
  const coverage: Record<string, number> = Object.fromEntries(states.map(state => {
    const ids = state.label === '最新'
      ? new Set([...state.seenRawIds, ...sticky.entries.map(entry => entry.topicId)])
      : state.seenRawIds;
    return [`视图:${state.label}`, ids.size];
  }));
  addPublicationCoverage(coverage, documents);
  if (dateRange) {
    for (const state of states) {
      coverage[`分页:${state.label}`] = state.pagesFetched;
      coverage[`日期范围已核验:${state.label}`] = state.exhausted ? 1 : 0;
    }
  }
  return {
    documents,
    businessSkips: [...businessSkips.values()],
    coverage,
  };
}
