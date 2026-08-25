import {
  mergeZsxqDocumentCopies,
  unionZsxqViewDocuments,
  type CollectedDocument,
  type ZsxqPlanView,
} from '@data-collector/shared';
import {
  createTimeOf,
  harvestTopics,
  inlineMarkupToHtml,
  parseTopicJson,
  preferredTopicRecord,
  stripInlineMarkup,
  TOPIC_MESSAGE_CHARACTER_LIMIT,
  type TopicRecord,
} from './topicIndex.js';
import { advertisementIn } from './adFilter.js';
import { excludedBy } from './topicFilter.js';

const API_ROOT = 'https://api.zsxq.com/v2';
const WEB_ROOT = 'https://wx.zsxq.com/group';
const X_VERSION = '2.96.0';
const REQUIRED_VIEWS: readonly ZsxqPlanView[] = ['最新', '精华', '只看星主'];
const TOPIC_PAGE_SIZE = 20;
const STICKY_TOPIC_COUNT = 3;
const PLAN_LOOKBACK_MS = 15 * 24 * 60 * 60 * 1_000;
const PLAN_ITEMS_PER_VIEW = 20;
const MAX_VIEW_PAGES = 12;
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
}

export interface ZsxqApiCollection {
  documents: CollectedDocument[];
  businessSkips: Array<{ url: string; reason: string }>;
  coverage: Record<string, number>;
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
  const referenceNow = (dependencies.now ?? (() => new Date()))();
  const collectedAt = referenceNow.toISOString();
  const cutoff = referenceNow.getTime() - PLAN_LOOKBACK_MS;
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
      !state.exhausted && state.documents.size < PLAN_ITEMS_PER_VIEW);
    if (activeStates.length === 0) break;
    const pageLimited = activeStates.find(state => state.pagesFetched >= MAX_VIEW_PAGES);
    if (pageLimited) {
      throw coverageError(
        'ZSXQ_API_PAGE_LIMIT',
        `「${pageLimited.label}」已翻满 ${MAX_VIEW_PAGES} 页仍未取得 ${PLAN_ITEMS_PER_VIEW} 条可核验文档，`
        + '且尚未证明最近 15 天内容已经耗尽',
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
      if (oldestTime <= cutoff) {
        state.exhausted = true;
        continue;
      }
      const nextEndTime = new Date(oldestTime - 1).toISOString();
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
      .slice(0, PLAN_ITEMS_PER_VIEW)
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
    .slice(0, PLAN_ITEMS_PER_VIEW);
  const documents = unionZsxqViewDocuments(byView)
    .filter(document => !businessSkips.has(document.canonicalUrl));
  const coverage: Record<string, number> = Object.fromEntries(states.map(state => {
    const ids = state.label === '最新'
      ? new Set([...state.seenRawIds, ...sticky.entries.map(entry => entry.topicId)])
      : state.seenRawIds;
    return [`视图:${state.label}`, ids.size];
  }));
  addPublicationCoverage(coverage, documents);
  return {
    documents,
    businessSkips: [...businessSkips.values()],
    coverage,
  };
}
