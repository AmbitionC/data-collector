import {
  unionZsxqViewDocuments,
  type CollectedDocument,
  type ZsxqPlanView,
} from '@data-collector/shared';
import {
  harvestTopics,
  inlineMarkupToHtml,
  parseTopicJson,
  stripInlineMarkup,
  type TopicRecord,
} from './topicIndex.js';
import { advertisementIn } from './adFilter.js';
import { excludedBy } from './topicFilter.js';

const API_ROOT = 'https://api.zsxq.com/v2';
const WEB_ROOT = 'https://wx.zsxq.com/group';
const X_VERSION = '2.96.0';
const REQUIRED_VIEWS: readonly ZsxqPlanView[] = ['最新', '精华', '只看星主'];
const DEFAULT_SCOPES: Record<ZsxqPlanView, string> = {
  最新: 'all',
  精华: 'digests',
  只看星主: 'owner',
};

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ZsxqApiFallbackDependencies {
  fetcher?: Fetcher;
  aduid: string;
  now?: () => Date;
  requestId?: () => string;
}

export interface ZsxqApiCollection {
  documents: CollectedDocument[];
  businessSkips: Array<{ url: string; reason: string }>;
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

async function apiGet(
  url: string,
  dependencies: Required<Pick<ZsxqApiFallbackDependencies, 'fetcher' | 'requestId'>>
    & Pick<ZsxqApiFallbackDependencies, 'aduid'>,
): Promise<unknown> {
  let response: Response;
  try {
    response = await dependencies.fetcher(url, {
      credentials: 'include',
      headers: await signedHeaders(url, dependencies.aduid, dependencies.requestId()),
    });
  } catch (error) {
    throw new Error(`ZSXQ_API_FALLBACK_FAILED：知识星球接口请求失败：${error instanceof Error ? error.message : error}`);
  }
  const body = await response.text();
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

function topicNodes(payload: unknown): Record<string, unknown>[] {
  const topics = responseData(payload)?.topics;
  return Array.isArray(topics) ? topics.filter(isRecord) : [];
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
      sourceCoversDom: true,
      viewLabels: view,
      extractionMode: 'signed-api-fallback',
    },
  };
}

function viewScopes(payload: unknown): Record<ZsxqPlanView, string> {
  const scopes = { ...DEFAULT_SCOPES };
  const menus = responseData(payload)?.menus;
  if (!Array.isArray(menus)) return scopes;
  for (const menu of menus) {
    if (!isRecord(menu)) continue;
    const title = typeof menu.title === 'string'
      ? menu.title.replace(/^[\s#]+|[\s#]+$/gu, '')
      : '';
    if (!REQUIRED_VIEWS.includes(title as ZsxqPlanView)) continue;
    if (menu.preset !== true || typeof menu.preset_type !== 'string') continue;
    scopes[title as ZsxqPlanView] = menu.preset_type;
  }
  return scopes;
}

/**
 * Fixed-plan fallback for the rare case where the ZSXQ Angular shell stays blank.
 * It performs the same signed, credentialed GETs as the page app, never reads or exports cookies.
 */
export async function collectZsxqApiViews(
  groupId: string,
  dependencies: ZsxqApiFallbackDependencies,
): Promise<ZsxqApiCollection> {
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
  const collectedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const businessSkips = new Map<string, { url: string; reason: string }>();
  const byView = await Promise.all(REQUIRED_VIEWS.map(async view => {
    const url = new URL(`${API_ROOT}/groups/${groupId}/topics`);
    url.searchParams.set('scope', scopes[view]);
    url.searchParams.set('count', '20');
    const payload = await apiGet(url.href, common);
    const records = new Map(harvestTopics(payload, 40, {
      responsePath: `${API_ROOT}/groups/${groupId}/topics`,
    }).map(record => [record.topicId, record]));
    const documents = topicNodes(payload).flatMap(topic => {
      const topicId = identifier(topic.topic_id ?? topic.topicId);
      const record = topicId ? records.get(topicId) : undefined;
      if (!record) return [];
      const document = documentFromTopic(groupId, view, topic, record, groupOwner, collectedAt);
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
    return { label: view, documents };
  }));
  return {
    documents: unionZsxqViewDocuments(byView),
    businessSkips: [...businessSkips.values()],
  };
}
