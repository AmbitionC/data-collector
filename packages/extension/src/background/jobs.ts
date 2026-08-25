import {
  canonicalizeUrl,
  mergeZsxqDocumentCopies,
  parseSupportedUrl,
  unionZsxqViewDocuments,
  ZSXQ_COMPLETE_CONTENT_CAPABILITY,
  ZSXQ_PLAN_VIEWS,
  type CollectedDocument,
  type CollectionPlanAttempt,
  type CollectionPlanRejection,
  type CollectionPlanId,
  type ZsxqPlanView,
} from '@data-collector/shared';
import { linkedArticleUrl } from '../extractors/index.js';
import type { HookStats } from '../topicIndex.js';
import type { OwnedTabPurpose } from './ownedTabs.js';
import { RemoteJobScheduler } from './remoteJobScheduler.js';
import type { ZsxqApiCollection } from '../zsxqApiFallback.js';
import {
  CONTENT_BUILD_ID,
  CONTENT_EXTRACTION_PROTOCOL,
  contentRequestType,
} from '../contentProtocol.js';

export interface BrowserTab {
  id?: number;
  url?: string;
  status?: string;
}

/** 列表页一轮里的一条帖子（内容脚本已剥掉无法跨消息边界传递的 DOM 节点）。 */
export interface ListItem {
  /** 稳定标识，侧栏点它就能滚回页面上的那一条并高亮。 */
  key: string;
  /** 当前 content bundle 对 DOM 节点实例 + 语义正文 revision 的精确绑定。 */
  observationId?: string;
  title: string;
  document?: CollectedDocument;
  /** 无法采集的原因。 */
  reason?: string;
  /** 有自身 URL 的业务过滤可审计且不阻断；缺省按覆盖风险 fail-closed。 */
  skipKind?: 'coverage-risk' | 'business-filter';
  /** 业务过滤项仍保留规范 URL，供固定计划逐条审计与跨视图去重。 */
  url?: string;
}

export interface ListPayload {
  items: ListItem[];
  skipped: number;
  total: number;
  /** 已捕获到的帖子号条数；为 0 说明还没截到应用的接口响应。 */
  captured?: number;
}

interface ZsxqPlanExtractionAudit {
  businessSkips: Map<string, { reason: string; url?: string }>;
}

/**
 * ZSXQ 的 SPA 正文会在首帧“看似完整”后继续增长。完整证明必须从最后一次正文变化起，
 * 连续观察满 24 秒；最多取 11 帧（约 44.5 秒），持续增长则 fail-closed。
 */
const ZSXQ_STABLE_FOR_MS = 24_000;
const ZSXQ_MIN_STABILITY_SAMPLES = 8;
const ZSXQ_MAX_STABILITY_SAMPLES = 11;

function zsxqSampleDelayMs(attempt: number): number {
  return attempt > 0 ? 600 + attempt * 700 : 0;
}

/** `collectedAt` 每次提取天然变化，不属于页面语义；其余正文与身份字段变化都重启稳定窗口。 */
function zsxqDocumentSignature(document: CollectedDocument): string {
  return JSON.stringify([
    document.canonicalUrl,
    document.title,
    document.author ?? null,
    document.publishedAt ?? null,
    document.questioner ?? null,
    document.text,
    document.html,
    document.images,
    document.sourceMetadata?.authorRole ?? null,
  ]);
}

function businessSkipReason(reason: string | undefined): string {
  if (reason?.includes('按选题偏好')) return '选题偏好过滤';
  if (reason?.includes('按硬证据')) return '硬证据广告过滤';
  return '内容脚本业务过滤';
}

function mergeStableListDocuments(items: readonly ListItem[]): {
  items: ListItem[];
  collapsedDocuments: number;
} {
  const merged: ListItem[] = [];
  const byCanonicalUrl = new Map<string, number>();
  const conflictUrls = new Set<string>();
  let collapsedDocuments = 0;
  for (const item of items) {
    const document = item.document;
    if (!document) {
      merged.push(item);
      continue;
    }
    const existingIndex = byCanonicalUrl.get(document.canonicalUrl);
    if (existingIndex === undefined) {
      byCanonicalUrl.set(document.canonicalUrl, merged.length);
      merged.push(item);
      continue;
    }
    collapsedDocuments += 1;
    const existing = merged[existingIndex]!;
    const existingDocument = existing.document!;
    const result = mergeZsxqDocumentCopies(existingDocument, document);
    merged[existingIndex] = {
      ...existing,
      title: result.document.title,
      document: result.document,
    };
    if (!result.conflict || conflictUrls.has(document.canonicalUrl)) continue;
    conflictUrls.add(document.canonicalUrl);
    merged.push({
      key: `${existing.key}:content-conflict`,
      title: result.document.title,
      url: document.canonicalUrl,
      skipKind: 'coverage-risk',
      reason: result.conflict === 'identity'
        ? '同一规范 URL 出现互相冲突的帖子身份，无法证明对应的是同一帖。'
        : '同一规范 URL 出现互不兼容的正文，无法证明哪一份属于该帖。',
    });
  }
  return { items: merged, collapsedDocuments };
}

/** URL 身份只在双方都能按支持站点规则解析并规范化后精确相等时成立。 */
function sameCanonicalUrl(candidate: string, expected: string): boolean {
  try {
    return canonicalizeUrl(parseSupportedUrl(candidate)).href
      === canonicalizeUrl(parseSupportedUrl(expected)).href;
  } catch {
    return false;
  }
}

const HTML_RESOURCE_TAG = /<(?:a|img|video|audio|source|track|iframe|embed|object)\b[^>]*>/giu;
const HTML_RESOURCE_ATTRIBUTE = /\s(href|src|data-src|data|poster|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu;

function normalizedDocumentAssetUrl(value: string, base: string): string | undefined {
  try {
    const url = new URL(value.replaceAll('&amp;', '&'), base);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * 详情完整证明只能清除与列表资产集合一致的观察；虚拟列表复用时，正文已经切到 B，
 * 但图片/长文链接仍可能属于 A。这里同时核对归档图片数组和正文内所有链接/图片 URL。
 */
function zsxqDocumentAssetUrls(document: CollectedDocument): Set<string> {
  const urls = new Set<string>();
  for (const image of document.images) {
    const normalized = normalizedDocumentAssetUrl(image.url, document.canonicalUrl);
    if (normalized) urls.add(normalized);
  }
  for (const tag of document.html.match(HTML_RESOURCE_TAG) ?? []) {
    const name = /^<([a-z]+)/iu.exec(tag)?.[1]?.toLowerCase();
    const attributes = new Map<string, string>();
    HTML_RESOURCE_ATTRIBUTE.lastIndex = 0;
    for (const match of tag.matchAll(HTML_RESOURCE_ATTRIBUTE)) {
      const attribute = match[1]?.toLowerCase();
      const value = match[2] ?? match[3] ?? match[4];
      if (attribute && value !== undefined && !attributes.has(attribute)) {
        attributes.set(attribute, value);
      }
    }
    const candidates: string[] = [];
    if (name === 'a') {
      candidates.push(attributes.get('href') ?? '');
    } else if (name === 'img') {
      candidates.push(attributes.get('data-src') ?? attributes.get('src') ?? '');
    } else if (name === 'object') {
      candidates.push(attributes.get('data') ?? '');
    } else {
      candidates.push(attributes.get('src') ?? '', attributes.get('poster') ?? '');
    }
    for (const value of (attributes.get('srcset') ?? '').split(',')) {
      candidates.push(value.trim().split(/\s+/u)[0] ?? '');
    }
    for (const candidate of candidates) {
      if (candidate) {
        const normalized = normalizedDocumentAssetUrl(candidate, document.canonicalUrl);
        if (normalized) urls.add(normalized);
      }
    }
  }
  return urls;
}

function sameUrlSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every(url => right.has(url));
}

function hasAuthoritativeSourceMedia(document: CollectedDocument): boolean {
  return document.sourceMetadata?.sourceMediaProven === true
    && document.sourceMetadata.sourceCoversDom === true;
}

/** Fail-closed 结果不能继续跟随任何一侧未经证明的资源链接。 */
function withoutUnprovenHtmlAssets(html: string): string {
  return html
    .replace(/<(video|audio|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, '')
    .replace(/<(?:img|video|audio|source|track|iframe|embed|object)\b[^>]*>/giu, '')
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/giu, '$1');
}

/** 逐条结果：侧栏的「本轮明细」列表就是它，用户据此逐条核对。 */
export interface BatchItem {
  key: string;
  title: string;
  status: 'saved' | 'skipped' | 'failed';
  /** 跳过 / 失败的原因。 */
  reason?: string;
  url?: string;
}

export type ExtractionResponse = (
  | { ok: true; document: CollectedDocument }
  | { ok: true; list: ListPayload }
  | { ok: true; advance: { collapsed: number; loaded: number; uncertain?: boolean; scroll?: string } }
  | { ok: true; diagnostics: string }
  | { ok: true; highlight: { found: boolean } }
  | { ok: true; hook: HookStats }
  | { ok: true; refresh: { toggled: boolean; category?: string } }
  | { ok: true; selected: { label: ZsxqPlanView; topicIds: string[] } }
  | { ok: true; apiCollection: ZsxqApiCollection }
  | { ok: false; error: { code: string; message: string } }
) & {
  /** 旧内容脚本没有这两个字段；生产采集必须验证它们。 */
  contentProtocol?: string;
  contentBuildId?: string;
};

export interface TabsApi {
  create(input: { url: string; active: boolean; purpose?: OwnedTabPurpose }): Promise<BrowserTab>;
  remove(id: number): Promise<void>;
  /** Reload is reserved for a newly-created fixed-plan tab whose SPA never mounted. */
  reload(id: number): Promise<void>;
  update(id: number, input: { active: boolean }): Promise<void>;
  /** 将一个登录页交给用户；实现会从自动清理集合移除，并替换上一个登录提示页。 */
  handoff(id: number, url: string): Promise<void>;
  query(input?: unknown): Promise<BrowserTab[]>;
  sendMessage(id: number, message: unknown): Promise<ExtractionResponse>;
  /**
   * 把内容脚本注入到已打开的标签页。
   *
   * 绝不能改用「重新加载页面」来自愈：知识星球的分类（精华 / 最新）是应用内状态，
   * 刷新会退回默认的「最新」，用户在精华页发起的采集就采成了别的内容。
   * 注入不动页面状态。
   */
  inject(id: number): Promise<void>;
}

export interface BridgeClient {
  send(type: string, requestId: string, payload: unknown): void;
  createJob(
    url: string,
    overrides?: {
      userCategory?: string;
      userTags?: string[];
      sinks?: string[];
      batchId?: string;
      planId?: CollectionPlanId;
      attempt?: CollectionPlanAttempt;
    },
  ): Promise<{ id: string }>;
  /** 只有 Bridge 已落地 sink 并持久化任务终态后才会完成。 */
  waitForJobTerminal(
    jobId: string,
    attempt?: CollectionPlanAttempt,
    timeoutMs?: number,
  ): Promise<void>;
}

interface PayloadMap {
  document: CollectedDocument;
  list: ListPayload;
  /** scroll：这一轮到底滚了哪个元素、位移多少，写进运行记录用。 */
  advance: { collapsed: number; loaded: number; uncertain?: boolean; scroll?: string };
  diagnostics: string;
  highlight: { found: boolean };
  hook: HookStats;
  refresh: { toggled: boolean; category?: string };
  selected: { label: ZsxqPlanView; topicIds: string[] };
  apiCollection: ZsxqApiCollection;
}

const TRANSIENT_TAB_ERROR = /Tabs cannot be edited right now|tab.*(?:temporarily|busy)|No tab with id/i;
const TAB_RETRY_DELAYS = [1_000, 3_000, 9_000] as const;

export async function retryTransientTabOperation<T>(
  operation: () => Promise<T>,
  wait: (milliseconds: number) => Promise<void>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= TAB_RETRY_DELAYS.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!TRANSIENT_TAB_ERROR.test(message) || attempt === TAB_RETRY_DELAYS.length) throw error;
      await wait(TAB_RETRY_DELAYS[attempt]!);
    }
  }
  throw lastError;
}

/** 按请求类型取出应答载荷；字段对不上说明页面里的内容脚本还是旧版本。 */
function payloadOf<K extends keyof PayloadMap>(
  response: ExtractionResponse,
  key: K,
): PayloadMap[K] {
  const value = (response as Record<string, unknown>)[key];
  if (value === undefined) throw new Error('页面脚本与扩展版本不一致，请刷新本页后重试');
  return value as PayloadMap[K];
}

/**
 * 批量采集的终态。**「结束」不等于「完成」**：异常中止、一条没采到、全部跳过
 * 都必须和正常跑完区分开，否则侧栏会把失败汇报成成功（见 docs/sidepanel-states.md）。
 */
export type BatchPhase =
  | 'running'
  | 'done'
  | 'capped'
  | 'stopped'
  | 'empty'
  | 'skipped_all'
  | 'failed';

/** 批量采集记录：既是实时进度，也是终态与失败原因的唯一真相源。 */
export interface BatchProgress {
  /** 触发批量采集的列表页地址（侧栏只在同一页面展示这份进度）。 */
  url: string;
  collected: number;
  skipped: number;
  failed: number;
  rounds: number;
  phase: BatchPhase;
  /** 失败原因（phase 为 failed 时必有），直接展示给用户。 */
  error?: string;
  /** 失败分类，决定侧栏给哪种出路按钮（如 CONTENT_SCRIPT_MISSING → 刷新页面并重试）。 */
  code?: string;
  /** 最后一次进度更新时刻；Service Worker 中途被回收时，侧栏据此判定这批已经断了。 */
  updatedAt: number;
  /**
   * 排查用的运行记录：每一轮看到多少、采了多少、滚动有没有加载出新内容。
   * 批量是个多轮的长流程，出问题时没有这个就只能靠猜。
   */
  log: string[];
}

export interface JobRunnerOptions {
  tabs: TabsApi;
  bridge: BridgeClient;
  waitForTabComplete: (tabId: number, timeoutMs?: number) => Promise<void>;
  /** 可注入的延时（测试用）；缺省用 setTimeout。 */
  delay?: (ms: number) => Promise<void>;
  /** 生产环境开启：拒绝仍在应答但不具备当前完整性协议的旧内容脚本。 */
  requireContentProtocol?: boolean;
  /** 当前后台 bundle 的 build-id；设置后要求内容脚本来自完全相同的 bundle。 */
  expectedContentBuildId?: string;
  /** 批量采集的进度回调（写入 storage 供侧栏轮询）。 */
  reportBatch?: (progress: BatchProgress) => void;
  /** 逐条结果回调（写入 storage 供侧栏的「本轮明细」列表使用）。 */
  reportItems?: (items: BatchItem[]) => void;
  /**
   * 本机库里已有内容的规范地址。
   *
   * **本机库是唯一的去重依据**，可采集端原先根本不知道库里有什么——
   * 页面上的「已处理」标记只活在那一个没刷新过的标签页里，刷新一次、
   * 扩展重载一次就清零，于是整屏又从头采一遍（实测：同一批 topic id 采了四轮）。
   * 目标条数也因此被旧内容吃满，永远推进不到新帖子。
   *
   * 取不到时按空集合处理：宁可重复采一遍，也不能因为查不到库就不采。
   */
  knownUrls?: () => Promise<ReadonlySet<string>>;
  /**
   * 本机库逐 URL 的正文完整状态；`undefined` 表示旧目录尚未记录，需要一次性修复。
   * 固定计划优先使用它，避免完整长文每天重抓，同时允许修复历史半篇内容。
   */
  knownContent?: () => Promise<ReadonlyMap<string, boolean | undefined> | undefined>;
}

/** 内容脚本在标签页 complete 后可能仍未注册消息监听，这类错误可短暂重试。 */
function isContentScriptNotReady(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Receiving end does not exist|Could not establish connection/i.test(message);
}

function isContentScriptOutdated(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /CONTENT_SCRIPT_OUTDATED/u.test(message);
}

function isBlankZsxqPlanShell(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /页面上找不到「最新」标签（分类栏尚未渲染）/u.test(message);
}

function isZsxqPlanDomCoverageIncomplete(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /CONTENT_COVERAGE_INCOMPLETE/u.test(message);
}

function zsxqIncompleteEvidence(
  before: CollectedDocument,
  after: CollectedDocument,
): string {
  const metadata = after.sourceMetadata ?? before.sourceMetadata ?? {};
  return [
    `sourceBodyProven=${String(metadata.sourceBodyProven)}`,
    `sourceMediaProven=${String(metadata.sourceMediaProven)}`,
    `sourceCoversDom=${String(metadata.sourceCoversDom)}`,
    `extractionMode=${String(metadata.extractionMode)}`,
    `textLength=${after.text.length}`,
    `images=${after.images.length}`,
    `linkedArticle=${String(linkedArticleUrl(after.html) !== undefined)}`,
    `truncatedBefore=${String(before.truncated === true)}`,
    `truncatedAfter=${String(after.truncated === true)}`,
  ].join('; ');
}

export interface CaptureOverrides {
  userCategory?: string;
  userTags?: string[];
  /** 用户为本次采集选定的落地去向（sink id）；缺省按来源默认路由。 */
  sinks?: string[];
}

/** 旧目录里的 `true` 没有协议证明，必须按未知处理并让日常计划自愈重采。 */
export function trustedZsxqContentCompleteness(entry: {
  contentComplete?: unknown;
  contentCompletenessVersion?: unknown;
}): boolean | undefined {
  if (entry.contentComplete === false) return false;
  if (
    entry.contentComplete === true
    && entry.contentCompletenessVersion === ZSXQ_COMPLETE_CONTENT_CAPABILITY
  ) return true;
  return undefined;
}

const ZSXQ_PLAN_ITEMS_PER_VIEW = 20;
const ZSXQ_PLAN_MAX_ROUNDS = 12;
// 内容侧最长会用 44.5 秒证明列表耗尽；给消息派发/事件循环留下足够余量，不能让
// background 的超时先抢跑，把一个合法的稳定性证明误报成页面脚本失联。
const CONTENT_SCRIPT_REQUEST_TIMEOUT_MS = 60_000;
const CURRENT_PAGE_NEEDS_ATTENTION = new Set(['AUTH_REQUIRED', 'UNSUPPORTED_LAYOUT']);

function lifeTeacherCategory(document: CollectedDocument): string {
  const categoryOf = (text: string): string | undefined => {
    // “管理”单字会误伤“基金管理费”；职场只认明确语境。
    if (/职场|职业|求职|升职|团队管理|企业管理|人员管理/u.test(text)) return '职场';
    if (/财富|资产|现金流|保险|养老/u.test(text)) return '财富';
    if (/投资|创业|商业模式|经营/u.test(text)) return '投资';
    if (/认知|决策|思维|复盘/u.test(text)) return '认知';
    if (/教育|学校|择校|学习/u.test(text)) return '教育';
    return undefined;
  };
  // 标题表达主问题，优先级高于正文里顺带提到的词。
  return categoryOf(document.title) ?? categoryOf(document.text) ?? '其他';
}

export class JobRunner {
  private readonly remoteScheduler = new RemoteJobScheduler(2);
  private batchStopped = false;

  constructor(private readonly options: JobRunnerOptions) {}

  /** requireContentProtocol=false 只用于旧单测/兼容路径；生产请求名必须绑定精确 bundle。 */
  private contentMessageType(legacyType: string): string {
    return this.options.requireContentProtocol
      ? contentRequestType(
          legacyType,
          this.options.expectedContentBuildId ?? CONTENT_BUILD_ID,
        )
      : legacyType;
  }

  /**
   * 所有知识星球任务只有在正文显式完整时才能进入 Bridge 的整理阶段。
   * 扩展自己先回报可见的 needs_attention；Bridge 仍保留同样的 sink 前硬门禁。
   */
  private sendDocumentResult(requestId: string, document: CollectedDocument): boolean {
    if (document.source === 'zsxq' && document.truncated !== false) {
      this.options.bridge.send('job.error', requestId, {
        code: 'INCOMPLETE_CONTENT',
        message: '知识星球正文补取后仍不完整，已拒绝入库和交付',
        needsAttention: true,
      });
      return false;
    }
    const attestedDocument = document.source === 'zsxq' && this.options.requireContentProtocol
      ? {
          ...document,
          sourceMetadata: {
            ...(document.sourceMetadata ?? {}),
            contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
            ...(this.options.expectedContentBuildId
              ? { contentCompletenessBuildId: this.options.expectedContentBuildId }
              : {}),
          },
        }
      : document;
    this.options.bridge.send('job.result', requestId, { document: attestedDocument });
    return true;
  }

  /**
   * 列表也是 SPA：首帧即使已有 topic id、正文非空且 `truncated:false`，尾段仍可能
   * 在数秒后继续挂载。固定采集与侧栏批量共用同一稳定窗口，避免其中一条路径回退成半篇。
   */
  private async extractStableList(tabId: number): Promise<ExtractionResponse> {
    interface StableItem {
      order: number;
      latest: ListItem;
      richest?: CollectedDocument;
      tainted: boolean;
      stableSignature: string | undefined;
      stableForMs: number;
      seenInLastSample: boolean;
      /** 一旦绑定规范 URL，DOM key 后续被虚拟列表复用时不得把另一帖并进来。 */
      canonicalUrl?: string;
      /** 无 URL 阶段只能凭 content 端的节点 generation + 正文 revision 绑定跨帧身份。 */
      observationId?: string;
    }
    const states = new Map<string, StableItem>();
    const aliases = new Map<string, StableItem>();
    let order = 0;
    let lastResponse: Extract<ExtractionResponse, { ok: true }> | undefined;
    let maximumTotal = 0;
    let maximumCaptured = 0;
    let samples = 0;
    let emptyStableForMs = 0;
    let emptyInPreviousSample = false;
    for (let attempt = 0; attempt < ZSXQ_MAX_STABILITY_SAMPLES; attempt += 1) {
      const delayMs = zsxqSampleDelayMs(attempt);
      if (delayMs > 0) await this.wait(delayMs);
      const response = await this.ask(tabId, {
        type: this.contentMessageType('extract.list'),
      });
      if (!response.ok) return response;
      samples += 1;
      lastResponse = response;
      const list = payloadOf(response, 'list');
      const emptyNow = list.total === 0 && list.items.length === 0;
      emptyStableForMs = emptyNow && emptyInPreviousSample
        ? emptyStableForMs + delayMs
        : 0;
      emptyInPreviousSample = emptyNow;
      maximumTotal = Math.max(maximumTotal, list.total);
      maximumCaptured = Math.max(maximumCaptured, list.captured ?? 0);
      for (const state of states.values()) state.seenInLastSample = false;
      for (const item of list.items) {
        // DOM key 会在虚拟列表节点回收后变化；规范 URL / topic id 才是跨帧主身份。
        // key 仍用于把“首帧没 URL → 后续对上 topic id”的同一节点串起来。
        const canonicalUrl = item.document?.canonicalUrl ?? item.url;
        const keyAlias = item.key ? `key:${item.key}` : undefined;
        const urlAlias = canonicalUrl ? `url:${canonicalUrl}` : undefined;
        const key = urlAlias ?? keyAlias;
        if (!key) continue;
        const urlState = urlAlias ? aliases.get(urlAlias) : undefined;
        const keyState = keyAlias ? aliases.get(keyAlias) : undefined;
        const keyIdentityMatches = keyState
          && (
            canonicalUrl && keyState.canonicalUrl
              ? keyState.canonicalUrl === canonicalUrl
              : !this.options.requireContentProtocol
                || (
                  item.observationId !== undefined
                  && keyState.observationId === item.observationId
                )
          );
        // 同一帧里两个不同节点若被错误对成同一 URL，必须保留两条供上层审计；
        // 只有上一帧节点消失、这一帧新 key 出现时，URL alias 才代表虚拟 DOM 重建。
        let state = keyIdentityMatches
          ? keyState
          : urlState && !urlState.seenInLastSample
            ? urlState
            : undefined;
        if (!state) {
          state = {
            order,
            latest: item,
            tainted: false,
            stableSignature: undefined,
            stableForMs: 0,
            seenInLastSample: true,
            ...(canonicalUrl ? { canonicalUrl } : {}),
            ...(item.observationId ? { observationId: item.observationId } : {}),
          };
          order += 1;
          states.set(`${key}#${state.order}`, state);
        }
        if (canonicalUrl && !state.canonicalUrl) state.canonicalUrl = canonicalUrl;
        if (item.observationId) state.observationId = item.observationId;
        if (keyAlias) aliases.set(keyAlias, state);
        if (urlAlias && !aliases.has(urlAlias)) aliases.set(urlAlias, state);
        state.latest = item;
        state.seenInLastSample = true;
        const document = item.document;
        if (!document) {
          const businessSignature = item.skipKind === 'business-filter' && canonicalUrl
            ? JSON.stringify([canonicalUrl, item.title, item.reason ?? null])
            : undefined;
          if (businessSignature && businessSignature === state.stableSignature) {
            state.stableForMs += delayMs;
          } else {
            state.stableSignature = businessSignature;
            state.stableForMs = 0;
          }
          continue;
        }
        if (document.truncated === true) state.tainted = true;
        if (!state.richest) {
          state.richest = document;
        } else {
          const merged = mergeZsxqDocumentCopies(state.richest, document);
          state.richest = merged.document;
          if (merged.conflict) state.tainted = true;
        }
        const signature = zsxqDocumentSignature(document);
        const isCurrentRichest = document.truncated === false
          && document.text === state.richest.text;
        if (isCurrentRichest && signature === state.stableSignature) {
          state.stableForMs += delayMs;
        } else {
          state.stableSignature = isCurrentRichest ? signature : undefined;
          state.stableForMs = 0;
        }
      }
      for (const state of states.values()) {
        if (state.seenInLastSample) continue;
        state.stableSignature = undefined;
        state.stableForMs = 0;
      }
      if (
        samples >= ZSXQ_MIN_STABILITY_SAMPLES
        && (
          states.size === 0
            ? maximumTotal === 0 && emptyStableForMs >= ZSXQ_STABLE_FOR_MS
            : [...states.values()].every(state => {
                if (!state.seenInLastSample) return false;
                if (!state.richest) {
                  return state.latest.skipKind === 'business-filter'
                    && state.stableForMs >= ZSXQ_STABLE_FOR_MS;
                }
                if (state.tainted) return true;
                const latest = state.latest.document;
                return latest?.truncated === false
                  && latest.text === state.richest.text
                  && state.stableForMs >= ZSXQ_STABLE_FOR_MS;
              })
        )
      ) break;
    }
    if (!lastResponse) throw new Error('CONTENT_EMPTY：未取得知识星球列表稳定样本');
    const stableItems = [...states.values()]
      .sort((left, right) => left.order - right.order)
      .map(state => {
        if (!state.richest) {
          const businessComplete = state.latest.skipKind === 'business-filter'
            && state.seenInLastSample
            && state.stableForMs >= ZSXQ_STABLE_FOR_MS;
          return businessComplete
            ? state.latest
            : { ...state.latest, skipKind: 'coverage-risk' as const };
        }
        const latest = state.latest.document;
        const complete = !state.tainted
          && latest?.truncated === false
          && latest.text === state.richest.text
          && state.seenInLastSample
          && state.stableForMs >= ZSXQ_STABLE_FOR_MS;
        return {
          ...state.latest,
          document: { ...state.richest, truncated: !complete },
        };
      });
    const { items, collapsedDocuments } = mergeStableListDocuments(stableItems);
    return {
      ...lastResponse,
      list: {
        items,
        skipped: items.filter(item => !item.document).length,
        total: Math.max(items.length, maximumTotal - collapsedDocuments),
        captured: maximumCaptured,
      },
    };
  }

  /** 先完成三个视图的只读提取与 URL 合并，再把结果交给调用方创建保存任务。 */
  async collectZsxqPlanViews(
    tabId: number,
    views: readonly ZsxqPlanView[] = ZSXQ_PLAN_VIEWS,
    audit?: ZsxqPlanExtractionAudit,
  ): Promise<CollectedDocument[]> {
    const byView: Array<{ label: ZsxqPlanView; documents: CollectedDocument[] }> = [];
    for (const label of views) {
      const documents: CollectedDocument[] = [];
      const viewUrls = new Set<string>();
      let refreshedFeed = false;
      const selected = await this.ask(tabId, {
        type: this.contentMessageType('list.selectView'),
        label,
      });
      if (!selected.ok) throw new Error(`${selected.error.code}: ${selected.error.message}`);
      payloadOf(selected, 'selected');
      await this.ask(tabId, {
        type: this.contentMessageType('list.restore'),
      }).catch(() => undefined);
      for (
        let round = 0;
        round < ZSXQ_PLAN_MAX_ROUNDS && viewUrls.size < ZSXQ_PLAN_ITEMS_PER_VIEW;
        round += 1
      ) {
        const extracted = await this.extractStableList(tabId);
        if (!extracted.ok) throw new Error(`${extracted.error.code}: ${extracted.error.message}`);
        const list = payloadOf(extracted, 'list');
        const unresolved = list.items.filter(item => !item.document);
        const coverageRisks = unresolved.filter(item => item.skipKind !== 'business-filter');
        const hiddenRisks = Math.max(
          0,
          list.skipped - unresolved.length,
          list.total - list.items.length,
        );
        const riskCount = coverageRisks.length + hiddenRisks;
        if (list.total > 0 && riskCount > 0) {
          if (!refreshedFeed) {
            refreshedFeed = true;
            const refresh = await this.ask(tabId, {
              type: this.contentMessageType('list.refreshTopics'),
            })
              .then(response => (response.ok
                ? payloadOf(response, 'refresh')
                : { toggled: false }))
              .catch(() => ({ toggled: false as boolean }));
            if (refresh.toggled) {
              round -= 1;
              continue;
            }
          }
          const reasons = [...new Set(coverageRisks
            .map(item => item.reason?.trim())
            .filter((reason): reason is string => Boolean(reason)))]
            .slice(0, 3)
            .join('；');
          throw new Error(
            `CONTENT_COVERAGE_INCOMPLETE：知识星球必采视图「${label}」本轮可见 ${list.total} 条，`
            + `其中 ${riskCount} 条无法形成可验证文档`
            + `${reasons ? `（${reasons}）` : ''}，已取满 ${ZSXQ_MAX_STABILITY_SAMPLES} 个有界样本仍未恢复`,
          );
        }
        for (const item of list.items) {
          if (item.document || item.skipKind !== 'business-filter') continue;
          const reason = businessSkipReason(item.reason);
          const key = item.url ?? `${label}:${item.key}`;
          audit?.businessSkips.set(key, {
            reason,
            ...(item.url ? { url: item.url } : {}),
          });
        }
        for (const item of list.items) {
          if (!item.document) continue;
          if (viewUrls.has(item.document.canonicalUrl)) continue;
          documents.push(item.document);
          viewUrls.add(item.document.canonicalUrl);
          if (viewUrls.size >= ZSXQ_PLAN_ITEMS_PER_VIEW) break;
        }
        if (viewUrls.size >= ZSXQ_PLAN_ITEMS_PER_VIEW) break;
        const advanced = await this.ask(tabId, {
          type: this.contentMessageType('list.advance'),
        });
        if (!advanced.ok) throw new Error(advanced.error.message);
        const outcome = payloadOf(advanced, 'advance');
        if (outcome.uncertain === true) {
          throw new Error(
            `CONTENT_ADVANCE_UNCERTAIN：知识星球必采视图「${label}」在有界观察内仍在变化，`
            + '无法证明已经加载完所有帖子，已停止防止漏采',
          );
        }
        if (outcome.loaded === 0) break;
        if (round === ZSXQ_PLAN_MAX_ROUNDS - 1) {
          throw new Error(
            `CONTENT_COVERAGE_INCOMPLETE：知识星球必采视图「${label}」已提取 ${ZSXQ_PLAN_MAX_ROUNDS} 轮，`
            + `第 ${ZSXQ_PLAN_MAX_ROUNDS} 次翻页仍加载出 ${outcome.loaded} 条，且尚未取满每视图 `
            + `${ZSXQ_PLAN_ITEMS_PER_VIEW} 条；无法证明该视图已经耗尽，已停止防止漏采`,
          );
        }
      }
      byView.push({ label, documents });
    }
    const merged = new Map(
      unionZsxqViewDocuments(byView).map(document => [document.canonicalUrl, document]),
    );
    const selected: CollectedDocument[] = [];
    const selectedUrls = new Set<string>();
    const maxDepth = Math.max(0, ...byView.map(view => view.documents.length));
    for (let index = 0; index < maxDepth && selected.length < 60; index += 1) {
      for (const view of byView) {
        const url = view.documents[index]?.canonicalUrl;
        if (!url || selectedUrls.has(url)) continue;
        selectedUrls.add(url);
        selected.push(merged.get(url)!);
        if (selected.length >= 60) break;
      }
    }
    return selected;
  }

  async submitCollectedDocument(
    document: CollectedDocument,
    context: { batchId: string; planId: CollectionPlanId },
  ): Promise<string> {
    const job = await this.options.bridge.createJob(document.canonicalUrl, context);
    this.options.bridge.send('job.progress', job.id, { stage: 'collecting' });
    this.sendDocumentResult(job.id, await this.withLinkedArticle(document));
    return job.id;
  }

  async runZsxqCollectionPlan(
    batchId: string,
    attempt: CollectionPlanAttempt,
    reportPhase?: (result: {
      discovered: number;
      prepared: boolean;
      rejections?: Record<string, number>;
      rejectionDetails?: CollectionPlanRejection[];
    }) => Promise<void> | void,
    options: { force?: boolean } = {},
  ): Promise<{ discovered: number }> {
    const groupUrl = 'https://wx.zsxq.com/group/48844584441158';
    let tabId: number | undefined;
    let keepTab = false;
    try {
      const tab = await retryTransientTabOperation(
        () => this.options.tabs.create({ url: groupUrl, active: false, purpose: 'zsxq-plan' }),
        milliseconds => this.wait(milliseconds),
      );
      if (tab.id === undefined) throw new Error('浏览器未返回知识星球标签页 ID');
      tabId = tab.id;
      await this.options.waitForTabComplete(tabId, 30_000);
      const collectViews = () => retryTransientTabOperation(
        async () => {
          const audit: ZsxqPlanExtractionAudit = { businessSkips: new Map() };
          const documents = await this.collectZsxqPlanViews(tabId!, ZSXQ_PLAN_VIEWS, audit);
          return { documents, audit };
        },
        milliseconds => this.wait(milliseconds),
      );
      const collectApiViews = async (): Promise<Awaited<ReturnType<typeof collectViews>>> => {
        const fallback = await this.ask(tabId!, {
          type: this.contentMessageType('list.apiCollect'),
        });
        if (!fallback.ok) throw new Error(fallback.error.message);
        const collection = payloadOf(fallback, 'apiCollection');
        const audit: ZsxqPlanExtractionAudit = { businessSkips: new Map() };
        for (const item of collection.businessSkips) audit.businessSkips.set(item.url, item);
        return { documents: collection.documents, audit };
      };
      let extraction: Awaited<ReturnType<typeof collectViews>>;
      try {
        extraction = await collectViews();
      } catch (error) {
        if (isZsxqPlanDomCoverageIncomplete(error)) {
          extraction = await collectApiViews();
        } else {
          if (!isBlankZsxqPlanShell(error)) throw error;
          // This tab was created by the fixed plan and has not selected a view yet, so one bounded
          // reload is safe. User-owned ZSXQ tabs still use injection only and never lose their view.
          await this.options.tabs.reload(tabId);
          await this.options.waitForTabComplete(tabId, 30_000);
          try {
            extraction = await collectViews();
          } catch (reloadedError) {
            if (!isBlankZsxqPlanShell(reloadedError)) throw reloadedError;
            extraction = await collectApiViews();
          }
        }
      }
      const documents = extraction.documents;
      const documentUrls = new Set(documents.map(document => document.canonicalUrl));
      const businessSkips = [...extraction.audit.businessSkips.entries()]
        .filter(([key, item]) => !documentUrls.has(item.url ?? key))
        .map(([, item]) => item);
      const discovered = documents.length + businessSkips.length;
      if (discovered === 0) {
        throw new Error('CONTENT_EMPTY：知识星球三个视图均未采集到任何帖子，已停止防止假绿');
      }
      const now = Date.now();
      const cutoff = now - 15 * 24 * 60 * 60 * 1_000;
      let known: ReadonlySet<string> = new Set();
      let knownContent: ReadonlyMap<string, boolean | undefined> = new Map();
      let contentStatusesAvailable = false;
      if (this.options.knownContent) {
        try {
          const content = await this.options.knownContent();
          if (!content) {
            throw new Error('Bridge 未提供逐条正文完整状态');
          }
          contentStatusesAvailable = true;
          knownContent = content;
          known = new Set(content.keys());
        } catch (error) {
          throw new Error(
            `BRIDGE_UPDATE_REQUIRED：无法读取本机库正文完整状态，已停止知识星球计划，避免把历史半篇误当完整：${error instanceof Error ? error.message : error}`,
          );
        }
      } else {
        try {
          known = (await this.options.knownUrls?.()) ?? new Set();
        } catch {
          known = new Set();
        }
      }
      const relevant: CollectedDocument[] = [];
      const rejections: Record<string, number> = {};
      const rejectionDetails: CollectionPlanRejection[] = [];
      for (const item of businessSkips) {
        rejections[item.reason] = (rejections[item.reason] ?? 0) + 1;
        if (item.url) rejectionDetails.push({ url: item.url, reason: item.reason });
      }
      const reject = (
        document: CollectedDocument,
        reason: string,
        evidence?: string,
      ): void => {
        rejections[reason] = (rejections[reason] ?? 0) + 1;
        rejectionDetails.push({
          url: document.canonicalUrl,
          reason,
          ...(evidence ? { evidence } : {}),
        });
      };
      for (const document of documents) {
        const authorRole = document.sourceMetadata?.authorRole;
        if (authorRole !== 'owner' && authorRole !== 'member') {
          throw new Error(
            `AUTHOR_IDENTITY_UNPROVEN：无法证明知识星球帖子作者身份，已停止防止漏采星主内容：${document.canonicalUrl}`,
          );
        }
        if (authorRole === 'member') {
          reject(document, '非星主');
          continue;
        }
        const publishedAt = document.publishedAt ? Date.parse(document.publishedAt) : Number.NaN;
        if (!Number.isFinite(publishedAt)) {
          throw new Error(
            `PUBLISHED_AT_UNPROVEN：无法证明知识星球帖子发布时间，已停止防止漏采近15天内容：${document.canonicalUrl}`,
          );
        }
        if (publishedAt < cutoff || publishedAt > now) {
          reject(document, '超出15天');
          continue;
        }
        // 能读到完整状态时，只跳过明确完整项；未知/不完整的历史普通帖与长文都修复一次。
        // 老 Bridge 没有状态字段时退回旧语义：已知 URL 全部跳过，避免每天重复覆盖。
        if (
          options.force !== true
          &&
          known.has(document.canonicalUrl)
          && (!contentStatusesAvailable || knownContent.get(document.canonicalUrl) === true)
        ) {
          reject(document, '本机库已有');
          continue;
        }
        const completedDocument = await this.withLinkedArticle(document);
        // 主题判断必须看补齐后的正文：列表导语本身可能没有投资/创业关键词。
        if (!/投资|创业|商业模式|经营|财富|职业|职场|认知/u.test(
          `${completedDocument.title}\n${completedDocument.text}`,
        )) {
          reject(document, '非投资创业主题');
          continue;
        }
        if (completedDocument.truncated) {
          reject(document, '正文不完整', zsxqIncompleteEvidence(document, completedDocument));
          continue;
        }
        // 走到这里表示本轮已检查过所有明确截断信号；写成 false 让目录三态一次收敛为“完整”。
        relevant.push({ ...completedDocument, truncated: false });
      }
      relevant.sort((left, right) => (right.publishedAt ?? '').localeCompare(left.publishedAt ?? ''));
      relevant.splice(60);
      await reportPhase?.({
        discovered,
        prepared: false,
        rejections,
        rejectionDetails,
      });
      const staged: Array<{ id: string; document: CollectedDocument }> = [];
      for (const document of relevant) {
        const plannedDocument: CollectedDocument = {
          ...document,
          userCategory: lifeTeacherCategory(document),
          sourceMetadata: {
            ...(document.sourceMetadata ?? {}),
            planId: 'zsxq-chen-teacher',
            batchId,
            windowDays: '15',
          },
        };
        const job = await this.options.bridge.createJob(plannedDocument.canonicalUrl, {
          batchId,
          planId: 'zsxq-chen-teacher',
          attempt,
        });
        staged.push({ id: job.id, document: plannedDocument });
      }
      await reportPhase?.({
        discovered,
        prepared: true,
        rejections,
        rejectionDetails,
      });
      for (const item of staged) {
        this.options.bridge.send('job.progress', item.id, { stage: 'collecting' });
        this.sendDocumentResult(item.id, item.document);
      }
      return { discovered };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/AUTH_REQUIRED|登录/u.test(message)) {
        if (tabId !== undefined) await this.options.tabs.update(tabId, { active: true }).catch(() => undefined);
        if (tabId !== undefined) {
          await this.options.tabs.handoff(tabId, groupUrl);
          keepTab = true;
        }
      }
      throw error;
    } finally {
      if (tabId !== undefined && !keepTab) await this.options.tabs.remove(tabId).catch(() => undefined);
    }
  }

  private wait(ms: number): Promise<void> {
    return this.options.delay ? this.options.delay(ms) : new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 向内容脚本发消息；内容脚本尚未就绪时短暂重试（最多 4 次），
   * 并在中途补注入一次——插件更新后已打开的标签页里没有内容脚本，
   * 注入即可自愈，不必刷新页面（刷新会丢掉「精华」这类应用内分类状态）。
   */
  private async ask(tabId: number, message: unknown): Promise<ExtractionResponse> {
    let lastError: unknown;
    const requestType = typeof (message as { type?: unknown })?.type === 'string'
      ? (message as { type: string }).type
      : '未知请求';
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const rawResponse = await Promise.race([
            this.options.tabs.sendMessage(tabId, message),
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(
                () => reject(new Error(`页面交互「${requestType}」超时（60 秒）`)),
                CONTENT_SCRIPT_REQUEST_TIMEOUT_MS,
              );
            }),
          ]);
          if (typeof rawResponse !== 'object' || rawResponse === null) {
            throw new Error(
              'CONTENT_SCRIPT_OUTDATED：页面内容脚本未识别当前版本请求',
            );
          }
          const response = rawResponse as ExtractionResponse;
          if (
            this.options.requireContentProtocol
            && (
              response.contentProtocol !== CONTENT_EXTRACTION_PROTOCOL
              || response.contentBuildId
                !== (this.options.expectedContentBuildId ?? CONTENT_BUILD_ID)
            )
          ) {
            throw new Error(
              'CONTENT_SCRIPT_OUTDATED：页面仍在运行旧版内容脚本，无法证明正文完整性',
            );
          }
          return response;
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
        }
      } catch (error) {
        const recoverable = isContentScriptNotReady(error) || isContentScriptOutdated(error);
        if (!recoverable || attempt === 3) throw error;
        lastError = error;
        if (attempt === 0) {
          try {
            await this.options.tabs.inject(tabId);
          } catch {
            // 注入失败（如页面不在允许的站点）就按原来的重试节奏继续。
          }
        }
        await this.wait(150);
      }
    }
    throw lastError;
  }

  /**
   * 取当前页的正文；**渲染没跟上时要等**。
   *
   * 知识星球整站是单页应用：标签页 status 变成 complete 只代表 HTML 到了，
   * 正文还要等接口回来才渲染。原先一拿到 CONTENT_EMPTY 就当失败返回——
   * 批量采集不会踩到（那时页面早渲染好了），但**按 URL 单条采集必然 100% 撞上**，
   * 实测第一条就是这么失败的。
   *
   * 通常只重试 CONTENT_EMPTY。牛客详情页首屏会在正文挂载前短暂返回
   * UNSUPPORTED_LAYOUT，所以远程牛客任务也有限重试；AUTH_REQUIRED 再等没有意义。
   */
  private async extractWithRetry(
    tabId: number,
    overrides?: CaptureOverrides,
    retryUnsupportedLayout = false,
    stabilizeZsxq = false,
    maxAttempts = 5,
  ): Promise<ExtractionResponse> {
    let last: ExtractionResponse | undefined;
    let bestDocument: CollectedDocument | undefined;
    let stableSignature: string | undefined;
    let stableForMs = 0;
    let tainted = false;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const delayMs = zsxqSampleDelayMs(attempt);
      if (delayMs > 0) await this.wait(delayMs);
      const response = await this.ask(tabId, {
        type: this.contentMessageType('extract.document'),
        ...(overrides ? { overrides } : {}),
      });
      if (response.ok) {
        if (!stabilizeZsxq) return response;
        const candidate = payloadOf(response, 'document');
        if (candidate.truncated === true) tainted = true;
        if (!bestDocument || candidate.text.length >= bestDocument.text.length) {
          bestDocument = candidate;
        }
        // `truncated:false` 只说明这一帧没有看到折叠控件；SPA 可能刚挂首段。
        // 同一份最丰富正文必须从最后一次变化起连续稳定 24 秒，且任一正向截断证据都粘住。
        const signature = zsxqDocumentSignature(candidate);
        const canProveStable = !tainted
          && candidate.truncated === false
          && candidate.canonicalUrl === bestDocument?.canonicalUrl
          && candidate.text === bestDocument.text;
        if (canProveStable && signature === stableSignature) {
          stableForMs += delayMs;
        } else {
          stableSignature = canProveStable ? signature : undefined;
          stableForMs = 0;
        }
        if (canProveStable && stableForMs >= ZSXQ_STABLE_FOR_MS) return response;
        last = response;
        continue;
      }
      const retryable = response.error.code === 'CONTENT_EMPTY'
        || (retryUnsupportedLayout && response.error.code === 'UNSUPPORTED_LAYOUT');
      if (!retryable) return response;
      stableSignature = undefined;
      stableForMs = 0;
      last = response;
    }
    if (stabilizeZsxq && bestDocument) {
      return { ok: true, document: { ...bestDocument, truncated: true } };
    }
    return last as ExtractionResponse;
  }

  /**
   * 列表 API 命中本地全文上限、或展开未能证明完成时，改开该 topic 的详情页取稳定全文。
   * 详情正文必须显式完整、不短于列表正文且与其兼容，才足以清除列表上的瞬态风险。
   */
  private async withTopicDetail(document: CollectedDocument): Promise<CollectedDocument> {
    let tabId: number | undefined;
    try {
      const tab = await this.options.tabs.create({
        url: document.canonicalUrl,
        active: false,
        purpose: 'remote-job',
      });
      if (tab.id === undefined) return { ...document, truncated: true };
      tabId = tab.id;
      await this.options.waitForTabComplete(tabId, 30_000);
      const response = await this.extractWithRetry(
        tabId,
        undefined,
        false,
        true,
        ZSXQ_MAX_STABILITY_SAMPLES,
      );
      if (!response.ok) return { ...document, truncated: true };
      const detail = payloadOf(response, 'document');
      if (
        detail.source !== 'zsxq'
        || detail.canonicalUrl !== document.canonicalUrl
        || detail.truncated !== false
        || detail.text.length < document.text.length
      ) return { ...document, truncated: true };
      const comparison = mergeZsxqDocumentCopies(document, detail);
      if (comparison.conflict) return { ...document, truncated: true };
      const sourceMetadata = {
        ...(document.sourceMetadata ?? {}),
        ...(detail.sourceMetadata ?? {}),
      };
      const assetsAgree = sameUrlSet(
        zsxqDocumentAssetUrls(document),
        zsxqDocumentAssetUrls(detail),
      );
      if (!assetsAgree && !hasAuthoritativeSourceMedia(detail)) {
        // 等长正文 + 成功展开只能证明文字；若两视图的资源集合不同且接口未给出权威
        // 媒体清单，任何一侧都可能是虚拟节点残留。保留详情正文便于诊断，但移除所有
        // 可跟随资源并维持 incomplete，绝不打开或归档上一帖的图片/附件/长文。
        return {
          ...detail,
          html: withoutUnprovenHtmlAssets(detail.html),
          images: [],
          ...(detail.author
            ? { author: detail.author }
            : document.author ? { author: document.author } : {}),
          ...(detail.publishedAt
            ? { publishedAt: detail.publishedAt }
            : document.publishedAt ? { publishedAt: document.publishedAt } : {}),
          sourceMetadata,
          truncated: true,
        };
      }
      return {
        ...comparison.document,
        ...(detail.author
          ? { author: detail.author }
          : document.author ? { author: document.author } : {}),
        ...(detail.publishedAt
          ? { publishedAt: detail.publishedAt }
          : document.publishedAt ? { publishedAt: document.publishedAt } : {}),
        sourceMetadata,
        truncated: false,
      };
    } catch {
      return { ...document, truncated: true };
    } finally {
      if (tabId !== undefined) await this.options.tabs.remove(tabId).catch(() => undefined);
    }
  }

  /**
   * 帖子只是导语时，把它引用的长文正文取回来接上。
   *
   * 星球的长文帖在信息流里只有一段引子加一个 `articles.zsxq.com` 链接——实测 77 条
   * 投递里 54 条（70%）是这形态，其中 43 条正文不足 400 字，归档侧拿到的基本是空壳。
   * 长文页是单页应用，接口还要登录态，所以只能开一个后台标签页让内容脚本去读。
   *
   * 取不到就保留导语并标记为截断；Bridge 会在任何知识星球入库之前据此拒绝半篇内容。
   */
  private async withLinkedArticle(document: CollectedDocument): Promise<CollectedDocument> {
    if (document.source !== 'zsxq') return document;
    if (document.kind === 'article') {
      return { ...document, truncated: document.truncated === true };
    }
    // 列表首帧可能连长文 anchor 都还没挂出来。若列表已经给出截断正向证据，先恢复
    // 原帖详情，再以恢复后的 HTML 重新判断有没有链接长文；否则会把“详情完整但仍引用
    // 一篇长文”的帖子错当作已经全部补齐。
    const topicDocument = document.truncated === true
      ? await this.withTopicDetail(document)
      : document;
    const articleUrl = linkedArticleUrl(topicDocument.html);
    if (!articleUrl) {
      // Bridge 以显式 `false` 作为「已经新版完整性检查」的凭据。
      // 无长文链接时也必须收敛三态：保留明确 true，其余标记为完整。
      return { ...topicDocument, truncated: topicDocument.truncated === true };
    }
    // 长文页只能证明“链接出去的文章”完整，不能反证原帖自身没有残留折叠尾段。
    // 详情页仍不完整或取证失败时，后面即使拿到完整文章也只能保留正文，不能清除 taint。
    let tabId: number | undefined;
    try {
      const tab = await this.options.tabs.create({
        url: articleUrl,
        active: false,
        purpose: 'linked-article',
      });
      if (tab.id === undefined) return { ...document, truncated: true };
      tabId = tab.id;
      await this.options.waitForTabComplete(tabId, 30_000);
      /*
       * **轮询重试，别只等一次。**
       *
       * 长文页是单页应用，正文要等接口回来才渲染。原先固定等 1200ms 读一次，
       * 没渲染完就放弃——实测 121 条里有 6 条这么丢了。而拿那 6 个 URL 手动 curl，
       * 返回的是和成功那些**一模一样的 1437 字节壳**：不是页面形态不同、更不是权限，
       * 就是那一刻还没渲染完。它们在信息流里相邻，所以看着像「成对失败」。
       */
      /*
       * 等的总时长要够。实测按 URL 重采 42 条，仍有 9 条（21%）没能拿到长文——
       * 时间点散落在整轮里，不是集中在某一刻，是典型的「渲染没赶上」而非页面形态问题。
       * 固定总观察窗仍会被尾段晚增绕过：现在与列表/详情统一为“最后一次变化后连续
       * 24 秒”，最多 11 帧（约 44.5 秒）；到上限仍未稳定就保守标记不完整。
       */
      const response = await this.extractWithRetry(
        tabId,
        undefined,
        false,
        true,
        ZSXQ_MAX_STABILITY_SAMPLES,
      );
      if (response.ok) {
        const article = payloadOf(response, 'document');
        if (
          article.source !== 'zsxq'
          || article.kind !== 'article'
          || !sameCanonicalUrl(article.canonicalUrl, articleUrl)
          || article.truncated !== false
          || article.text.length <= topicDocument.text.length
        ) {
          return { ...topicDocument, truncated: true };
        }
        return {
          ...topicDocument,
          // 导语留着（有时交代了背景），长文正文接在后面。
          html: `${topicDocument.html}\n<hr />\n${article.html}`,
          text: `${topicDocument.text}\n\n${article.text}`,
          images: [...topicDocument.images, ...article.images],
          // 链接正文即使已经完整，也只能在原帖详情同时给出完整证明时清除列表 taint。
          // 详情失败时仍把取得的长文带回，便于诊断/重试，但最终状态必须保持 true。
          truncated: topicDocument.truncated === true,
        };
      }
      // 试满还是没拿到长文：如实标成截断，归档侧才知道这条不完整。
      return { ...topicDocument, truncated: true };
    } catch {
      return { ...topicDocument, truncated: true };
    } finally {
      if (tabId !== undefined) await this.options.tabs.remove(tabId).catch(() => undefined);
    }
  }

  async runRemoteJob(requestId: string, rawUrl: string, interactive = true): Promise<void> {
    return this.remoteScheduler.run(
      () => this.runRemoteJobNow(requestId, rawUrl, interactive),
      interactive ? 'interactive' : 'batch',
    );
  }

  private async runRemoteJobNow(requestId: string, rawUrl: string, interactive: boolean): Promise<void> {
    let tabId: number | undefined;
    let keepTab = false;
    try {
      const parsedUrl = parseSupportedUrl(rawUrl);
      const url = parsedUrl.href;
      const tab = await this.options.tabs.create({ url, active: false, purpose: 'remote-job' });
      if (tab.id === undefined) throw new Error('浏览器未返回新标签页 ID');
      tabId = tab.id;
      await this.options.waitForTabComplete(tabId, 30_000);
      this.options.bridge.send('job.progress', requestId, { stage: 'collecting' });
      const response = await this.extractWithRetry(
        tabId,
        undefined,
        parsedUrl.hostname === 'www.nowcoder.com',
        parsedUrl.hostname === 'wx.zsxq.com' || parsedUrl.hostname === 'articles.zsxq.com',
        parsedUrl.hostname === 'wx.zsxq.com' || parsedUrl.hostname === 'articles.zsxq.com'
          ? ZSXQ_MAX_STABILITY_SAMPLES
          : 5,
      );
      if (!response.ok) {
        const needsAttention = response.error.code === 'AUTH_REQUIRED';
        if (needsAttention && interactive) {
          await this.options.tabs.update(tabId, { active: true }).catch(() => undefined);
          await this.options.tabs.handoff(tabId, url);
          keepTab = true;
        }
        this.options.bridge.send('job.error', requestId, {
          code: response.error.code,
          message: response.error.message,
          needsAttention,
        });
        return;
      }
      // 单条采集同样要补长文：按 URL 定向重采（收件箱那 48 条）走的就是这条路。
      this.sendDocumentResult(
        requestId,
        await this.withLinkedArticle(payloadOf(response, 'document')),
      );
    } catch (error) {
      const outdated = isContentScriptOutdated(error);
      this.options.bridge.send('job.error', requestId, {
        code: outdated
          ? 'CONTENT_SCRIPT_OUTDATED'
          : error instanceof Error && error.message.includes('不支持的采集地址')
            ? 'UNSUPPORTED_URL'
            : 'COLLECTION_FAILED',
        message: error instanceof Error ? error.message : '浏览器采集失败',
        needsAttention: outdated,
      });
    } finally {
      if (tabId !== undefined && !keepTab) await this.options.tabs.remove(tabId).catch(() => undefined);
    }
  }

  async captureCurrent(overrides: CaptureOverrides = {}): Promise<string> {
    const [tab] = await this.options.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id === undefined || !tab.url) throw new Error('当前没有可采集的浏览器页面');
    const parsedUrl = parseSupportedUrl(tab.url);
    const url = parsedUrl.href;
    const job = await this.options.bridge.createJob(url, overrides);
    this.options.bridge.send('job.progress', job.id, { stage: 'collecting' });
    let response: ExtractionResponse;
    try {
      response = await this.extractWithRetry(
        tab.id,
        overrides,
        false,
        parsedUrl.hostname === 'wx.zsxq.com' || parsedUrl.hostname === 'articles.zsxq.com',
        parsedUrl.hostname === 'wx.zsxq.com' || parsedUrl.hostname === 'articles.zsxq.com'
          ? ZSXQ_MAX_STABILITY_SAMPLES
          : 5,
      );
    } catch (error) {
      // 内容脚本不在该标签页（常见于扩展刚安装/重载，而标签页是之前打开的）。
      // 必须显式回报，否则任务会永远停在 collecting，侧栏一直显示「清理正文」。
      const notReady = isContentScriptNotReady(error);
      const outdated = isContentScriptOutdated(error);
      this.options.bridge.send('job.error', job.id, {
        code: outdated
          ? 'CONTENT_SCRIPT_OUTDATED'
          : notReady ? 'CONTENT_SCRIPT_MISSING' : 'COLLECTION_FAILED',
        message: outdated
          ? '页面仍在运行旧版内容脚本，无法证明正文完整性。请确认扩展已重载后重试。'
          : notReady
          // 绝不建议刷新：刷新会把知识星球的「精华」退回「最新」，采到的就不是用户要的内容。
          // 自动补注入已经试过并失败，所以这里只剩「确认扩展启用后重试」这一条路。
          ? '页面脚本未就绪，且自动注入没有成功。请在 edge://extensions 确认 Data Collector 已启用后重试；不必刷新页面。'
          : error instanceof Error
            ? error.message
            : '浏览器采集失败',
        needsAttention: notReady || outdated,
      });
      return job.id;
    }
    if (!response.ok) {
      this.options.bridge.send('job.error', job.id, {
        code: response.error.code,
        message: response.error.message,
        needsAttention: CURRENT_PAGE_NEEDS_ATTENTION.has(response.error.code),
      });
      return job.id;
    }
    const document: CollectedDocument = {
      ...payloadOf(response, 'document'),
      ...(overrides.userCategory ? { userCategory: overrides.userCategory } : {}),
      ...(overrides.userTags ? { userTags: overrides.userTags } : {}),
    };
    // 当前页也可能只是长文导语；与远程单条/批量走同一补全与显式完整性路径。
    this.sendDocumentResult(job.id, await this.withLinkedArticle(document));
    return job.id;
  }

  /**
   * 列表 / 精华页批量采集：把当前页上的每条帖子各建一个任务入库。
   *
   * 每条帖子必须带自己的详情 URL —— 稳定内容 ID 由规范 URL 派生，
   * 都用列表页 URL 的话 21 条会算出同一个 ID 相互覆盖，最后只剩 1 条。
   *
   * 一轮 = 提取本屏 → 逐条入库 → 拟人滚动到底触发懒加载，把下一批带出来。
   * 处理过的帖子只打一个**不可见**的属性标记（绝不 display:none —— 用户要能肉眼核对
   * 采到的内容），下一轮靠这个标记跳过，不会把同一条重复提取。
   */
  /**
   * 批量收尾时把页面停在采到的最后一条上。
   *
   * 不停在那儿的话，用户看不到进度到哪儿了；更要命的是「继续采下一批」会从视口
   * 当前位置往下滚——页面有几万像素高，从中间滚几千像素永远到不了底，
   * 懒加载于是永远不触发，表现就是「滚动到底也没有加载新内容」而页面其实没到底。
   * 尽力而为，失败不影响任何结论。
   */
  private async focusLast(tabId: number): Promise<void> {
    await this.ask(tabId, { type: this.contentMessageType('list.focusLast') })
      .catch(() => undefined);
  }

  /** 用户点了「停止」：在条与条、轮与轮之间检查，尽快收尾并如实汇报已入库条数。 */
  stopBatch(): void {
    this.batchStopped = true;
  }

  /** 问页面里的主世界钩子要一份运行统计；拿不到就按「没在运行」处理。 */
  private async hookStats(tabId: number): Promise<HookStats> {
    const response = await this.ask(tabId, { type: this.contentMessageType('list.hookStats') })
      .catch(() => undefined);
    if (response?.ok) {
      try {
        return payloadOf(response, 'hook');
      } catch {
        // 页面里还是旧版内容脚本，答不上这个字段。
      }
    }
    return {
      installed: false,
      observed: 0,
      jsonResponses: 0,
      withTopicId: 0,
      publishedRecords: 0,
      recent: [],
    };
  }

  /**
   * 单条帖子的「为什么没对上号」证据包（页面文本 vs 接口原文）。
   * 整页诊断回答不了「这一条差在哪」，跳过的条目必须能单独取证。
   */
  async itemDiagnostics(key: string): Promise<string> {
    const [tab] = await this.options.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id === undefined) throw new Error('当前没有可采集的浏览器页面');
    const response = await this.ask(tab.id, {
      type: this.contentMessageType('list.itemDiagnose'),
      key,
    });
    if (!response.ok) throw new Error(response.error.message);
    return payloadOf(response, 'diagnostics');
  }

  /** 侧栏点某条时，让页面滚过去并高亮它，方便逐条核对采到的内容。 */
  async highlight(key: string): Promise<boolean> {
    const [tab] = await this.options.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id === undefined) return false;
    const response = await this.ask(tab.id, {
      type: this.contentMessageType('list.highlight'),
      key,
    }).catch(() => undefined);
    return Boolean(response?.ok && payloadOf(response, 'highlight').found);
  }

  /** 采不到各自链接时（E4），取一份页面结构样本供适配排查。 */
  async diagnoseList(): Promise<string> {
    const [tab] = await this.options.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id === undefined) throw new Error('当前没有可诊断的浏览器页面');
    const response = await this.ask(tab.id, {
      type: this.contentMessageType('list.diagnose'),
    });
    if (!response.ok) throw new Error(response.error.message);
    return payloadOf(response, 'diagnostics');
  }

  /**
   * 清空本机库之后，把页面上的「已处理」标记一并抹掉。
   *
   * 本机库是去重的唯一依据，页面标记只是「这一轮采过了，下一轮别重复」的临时状态。
   * 库都清空了，标记就是脏的：不抹掉，用户在同一个没刷新过的标签页里重采，
   * 这些帖子会被整批当成已采过跳过——看上去就像采集坏了。
   *
   * 失败不吭声是安全的：找不到页面、内容脚本不在，都意味着那份 DOM 早就没了，
   * 标记跟着一起没了，本来就无事可做。
   */
  async resetPageMarks(): Promise<void> {
    const [tab] = await this.options.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id === undefined) return;
    await this.restorePage(tab.id);
  }

  /**
   * 把页面还原成用户原本看到的样子（撤销所有折叠）。
   * 失败静默：还原只是善后，不该让它盖过真正的失败原因。
   */
  private async restorePage(tabId: number): Promise<void> {
    try {
      await this.options.tabs.sendMessage(tabId, {
        type: this.contentMessageType('list.restore'),
      });
    } catch {
      // 页面已关闭或脚本不在，无需处理。
    }
  }

  async captureList(
    overrides: CaptureOverrides = {},
    limits: {
      maxRounds?: number;
      /** 本次要采够多少条；采够即停，不需要用户盯着手动停。 */
      maxItems?: number;
      /**
       * 「连已入库的一起重采」。
       *
       * 平时本机库是去重依据，库里有的直接跳过。但采集器修好之后（比如补上了长文正文），
       * 库里那批是用旧逻辑采的，需要整体刷新一遍——这时才打开它。
       * 重采同一地址仍然只有一条（稳定内容 ID 幂等覆盖），但同步状态会回到未同步，
       * 于是只有**内容真的变了**的条目需要再推一次，不做重复动作。
       */
      refresh?: boolean;
      continuation?: boolean;
    } = {},
  ): Promise<BatchProgress> {
    const [tab] = await this.options.tabs.query({ active: true, lastFocusedWindow: true });
    // E10：连可采集的标签页都没有，写不出归属某页的记录，交给侧栏的本地粘性错误。
    if (tab?.id === undefined || !tab.url) throw new Error('当前没有可采集的浏览器页面');
    const tabId = tab.id;
    const maxRounds = limits.maxRounds ?? 12;
    const maxItems = limits.maxItems ?? 20;
    this.batchStopped = false;
    const progress: BatchProgress = {
      url: tab.url,
      collected: 0,
      skipped: 0,
      failed: 0,
      rounds: 0,
      phase: 'running',
      updatedAt: Date.now(),
      log: [],
    };
    const note = (line: string): void => {
      progress.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
      if (progress.log.length > 200) progress.log.shift();
      console.info(`[data-collector] ${line}`);
    };
    const report = () => {
      progress.updatedAt = Date.now();
      this.options.reportBatch?.({ ...progress });
      this.options.reportItems?.([...items]);
    };
    const fail = async (code: string, message: string): Promise<BatchProgress> => {
      // 一条都没采到就把页面还原：绝不能让用户的星球主页凭空少掉一屏内容。
      if (progress.collected === 0) await this.restorePage(tabId);
      progress.phase = 'failed';
      progress.code = code;
      progress.error = message;
      report();
      return { ...progress };
    };
    // 同一条在两轮里重复出现（列表刷新、置顶）时不重复建任务。
    const seen = new Set<string>();
    /*
     * 本机库里已经有的地址。取一次就够——一轮批量之内库不会被别人改。
     * 查不到（服务断了、接口变了）一律按空集合处理：宁可重复采一遍，
     * 也绝不能因为查库失败就把整批拦下。
     */
    let known: ReadonlySet<string> = new Set();
    try {
      known = (await this.options.knownUrls?.()) ?? new Set();
    } catch {
      known = new Set();
    }
    const items: BatchItem[] = [];
    /**
     * 计数一律从明细里数出来。
     *
     * 早先「已跳过」是在逐条循环**之前**按整屏一次性加上的，而解释这些跳过的行
     * 只在循环体内 push——采够条数或用户点停止时循环从中间断开，计数留着、行没了：
     * 面板说「已跳过 2」，点进明细却是「已跳过 0」，一行都没有。
     * 同源就不可能再漂。
     */
    const tally = () => {
      progress.collected = items.filter(item => item.status === 'saved').length;
      progress.skipped = items.filter(item => item.status === 'skipped').length;
      progress.failed = items.filter(item => item.status === 'failed').length;
    };
    report();

    if (limits.continuation) {
      // 「继续采下一批」：本屏都处理过了，得先滚动把下一页加载出来再提取，
      // 否则一上来就是「没有待采内容」。
      note('继续采下一批：先滚动加载下一页');
      let advanced: ExtractionResponse;
      try {
        advanced = await this.ask(tabId, {
          type: this.contentMessageType('list.advance'),
        });
      } catch (error) {
        return fail(
          'CONTENT_ADVANCE_FAILED',
          `无法确认续采是否已经加载完所有帖子：${error instanceof Error ? error.message : error}`,
        );
      }
      if (!advanced.ok) {
        return fail(
          'CONTENT_ADVANCE_FAILED',
          `无法确认续采是否已经加载完所有帖子：${advanced.error.message}`,
        );
      }
      const outcome = payloadOf(advanced, 'advance');
      const loaded = outcome.loaded;
      // 滚没滚动必须写下来：只报「新增 0 条」时，分不清是到底了还是压根没滚。
      if (outcome.scroll) note(outcome.scroll);
      note(`滚动后新加载出 ${loaded} 条待采内容`);
      if (outcome.uncertain === true) {
        return fail(
          'CONTENT_ADVANCE_UNCERTAIN',
          '列表在有界观察内仍在变化，无法证明已经加载完所有帖子；已停止续采以防漏采。',
        );
      }
      if (loaded === 0) {
        progress.phase = 'done';
        progress.error = '滚动到底也没有加载出新内容，本页应该已经采完了。';
        report();
        return { ...progress };
      }
    } else {
      // 新开一批：清掉上一批的处理标记，让整页重新可采。
      await this.restorePage(tabId);
      note('新的一批：已清除上一轮的处理标记');
    }

    let sawAnyPost = false;
    let captured = 0;
    // 明确业务过滤可以正常跳过；结构、身份或稳定性证明缺失是覆盖缺口。
    // 即使同屏另一条成功入库，也不能把这种混合批次报成完成。
    let coverageRiskCount = 0;
    /** 是否已经替用户切过一次分类来触发接口请求（最多一次）。 */
    let refreshedFeed = false;
    for (let round = 0; round < maxRounds; round += 1) {
      let response: ExtractionResponse;
      try {
        response = await this.extractStableList(tabId);
      } catch (error) {
        // E1：扩展刚安装/更新时，之前打开的标签页里没有内容脚本。
        if (isContentScriptNotReady(error)) {
          return await fail(
            'CONTENT_SCRIPT_MISSING',
            '页面脚本未就绪，且自动注入没有成功。请在插件管理页确认 Data Collector 已启用后重试。',
          );
        }
        return await fail(
          'COLLECTION_FAILED',
          error instanceof Error ? error.message : '读取本页帖子失败',
        );
      }
      if (!response.ok) {
        // E2 等提取器给出的明确原因（未登录、结构不支持）原样透传。
        return await fail(response.error.code, response.error.message);
      }
      const list = payloadOf(response, 'list');

      // 一个帖子号都没截到：页面多半是更早之前加载好的，那次接口响应已经错过。
      // 与其让用户自己去切分类，不如插件代劳一次——这是唯一能不刷新页面就
      // 让站点重新请求的办法（刷新会把「精华」退回「最新」）。只做一次，避免来回折腾。
      if (!refreshedFeed && (list.captured ?? 0) === 0 && list.total > 0) {
        refreshedFeed = true;
        note('本页一个帖子号都没截到：切走分类再切回来，让站点重新请求一次');
        // 全程尽力而为：这一步失败（页面里是旧版内容脚本、答不上这个字段等）
        // 绝不能把整批采集带下水——它只是个「省得用户自己动手」的便利。
        const refresh = await this.ask(tabId, {
          type: this.contentMessageType('list.refreshTopics'),
        })
          .then(response => (response.ok ? payloadOf(response, 'refresh') : { toggled: false }))
          .catch(() => ({ toggled: false as boolean, category: undefined }));
        if (refresh.toggled) {
          note(`已切走并切回「${refresh.category ?? '原分类'}」，重新提取本屏`);
          round -= 1; // 重跑这一轮（refreshedFeed 保证只会发生一次）
          continue;
        }
        note('页面上没找到分类切换控件，这一步跳过');
      }

      progress.rounds = round + 1;
      if (list.total > 0) sawAnyPost = true;
      captured = Math.max(captured, list.captured ?? 0);
      note(
        `第 ${round + 1} 轮：本屏待采 ${list.total} 条，其中 ${list.total - list.skipped} 条可入库，`
        + `已捕获帖子号 ${list.captured ?? 0} 个`,
      );

      for (const item of list.items) {
        if (this.batchStopped) break;
        if (progress.collected >= maxItems) break;
        if (!item.document) {
          if (item.skipKind !== 'business-filter') coverageRiskCount += 1;
          items.push({ key: item.key, title: item.title, status: 'skipped', ...(item.reason ? { reason: item.reason } : {}) });
          tally();
          continue;
        }
        const document = item.document;
        if (seen.has(document.canonicalUrl)) {
          // 本轮已经采过同一个地址：如实记一行，**绝不静默丢弃**。
          // 这种情况多半是有条帖子被对到了别人的帖子号上，正是最该让用户看见的。
          items.push({
            key: item.key,
            title: item.title,
            status: 'skipped',
            reason: '和本轮另一条算出了同一个地址，未重复入库',
          });
          tally();
          continue;
        }
        seen.add(document.canonicalUrl);
        // 本机库里已经有了就跳过，让目标条数只数**新内容**——
        // 否则刷新一次页面，整屏旧帖子又会把这一批吃满。
        if (!limits.refresh && known.has(document.canonicalUrl)) {
          items.push({
            key: item.key,
            title: item.title,
            status: 'skipped',
            reason: '已在本机库，未重复采集',
            url: document.canonicalUrl,
          });
          tally();
          continue;
        }
        const completed = await this.withLinkedArticle(document);
        if (completed.source === 'zsxq' && completed.truncated !== false) {
          items.push({
            key: item.key,
            title: item.title,
            status: 'failed',
            reason: '正文不完整，未入库',
            url: document.canonicalUrl,
          });
          tally();
          report();
          continue;
        }
        const saved = await this.saveCollected(completed, overrides);
        if (saved === 'ok') {
          items.push({ key: item.key, title: item.title, status: 'saved', url: document.canonicalUrl });
          tally();
        } else if (saved === 'bridge-down') {
          // E5：本机服务断了，后面每条都会失败，立刻收尾而不是刷一屏失败。
          note('本机服务无响应，提前收尾');
          return await fail('BRIDGE_UNAVAILABLE', '本机服务无响应，本批已中断。');
        } else {
          items.push({ key: item.key, title: item.title, status: 'failed', reason: '写入本机失败' });
          tally();
        }
        report();
        // 条与条之间留一点随机间隔：连续无间隔的请求最像脚本。
        if (progress.collected < maxItems) await this.wait(250 + Math.random() * 450);
      }

      if (this.batchStopped) {
        await this.focusLast(tabId);
        progress.phase = 'stopped';
        report();
        return { ...progress };
      }
      if (progress.collected >= maxItems) {
        // 采够目标条数就收工——这是正常完成，不是被截断。
        // **必须先把这一屏标记掉**：否则「继续采下一批」上来第一件事是滚动，
        // 而这一屏还都是「待采」状态，滚完立刻就有「新内容」，于是又把同一屏
        // 提取一遍——表现就是点了继续毫无进展，永远卡在原地。
        const marked = await this.ask(tabId, {
          type: this.contentMessageType('list.restore'),
          mark: true,
        })
          .then(response => (response.ok ? payloadOf(response, 'advance').collapsed : 0))
          .catch(() => 0);
        note(`已采够目标条数 ${maxItems} 条，收工（已标记本屏 ${marked} 条，续采从下一屏开始）`);
        await this.focusLast(tabId);
        progress.phase = coverageRiskCount > 0 ? 'failed' : 'capped';
        if (coverageRiskCount > 0) {
          progress.code = 'CONTENT_COVERAGE_INCOMPLETE';
          progress.error = `本轮虽已入库 ${progress.collected} 条，但另有 ${coverageRiskCount} 条可见帖子`
            + '无法形成可验证文档，本轮未全部完成。';
        }
        report();
        return { ...progress };
      }

      let advanced: ExtractionResponse;
      try {
        advanced = await this.ask(tabId, {
          type: this.contentMessageType('list.advance'),
        });
      } catch (error) {
        return fail(
          'CONTENT_ADVANCE_FAILED',
          `无法确认下一页是否已经加载完所有帖子：${error instanceof Error ? error.message : error}`,
        );
      }
      if (!advanced.ok) {
        return fail(
          'CONTENT_ADVANCE_FAILED',
          `无法确认下一页是否已经加载完所有帖子：${advanced.error.message}`,
        );
      }
      const nextPage = payloadOf(advanced, 'advance');
      const loaded = nextPage.loaded;
      if (nextPage.scroll) note(nextPage.scroll);
      note(`滚动加载下一页：新增待采 ${loaded} 条`);
      if (nextPage.uncertain === true) {
        return fail(
          'CONTENT_ADVANCE_UNCERTAIN',
          '列表在有界观察内仍在变化，无法证明已经加载完所有帖子；本轮已停止并标记失败。',
        );
      }
      if (loaded === 0) break;
      report();
    }

    // 零产出（没找到帖子 / 全部无法定位）同样要把页面还原。
    if (progress.collected === 0) await this.restorePage(tabId);
    else await this.focusLast(tabId);
    // E3 / E4：跑完了但没有产出，都不是「完成」。
    progress.phase = !sawAnyPost
      ? 'empty'
      // 一条都没入库、却有写入失败：这是失败，不是「完成」。
      // 之前 failed 完全没参与终态判定，全军覆没会渲染成绿色的「本轮批量归档完成」，
      // 说明文字还写着「内容已落到本机库」——那是假的。
      : progress.failed > 0 || (progress.collected > 0 && coverageRiskCount > 0)
        ? 'failed'
        : progress.collected === 0 && progress.skipped > 0
          ? 'skipped_all'
          : progress.rounds >= maxRounds && progress.collected >= maxItems
            ? 'capped'
            : 'done';
    if (progress.phase === 'failed') {
      const failedItems = items.filter(item => item.status === 'failed');
      const allIncomplete = failedItems.length > 0
        && failedItems.every(item => item.reason === '正文不完整，未入库');
      progress.error = coverageRiskCount > 0
        ? `本轮已入库 ${progress.collected} 条；另有 ${coverageRiskCount} 条可见帖子的结构、身份或完整性`
          + '无法证明，已停止假报全部完成。'
        : allIncomplete
        ? `本轮已入库 ${progress.collected} 条；另有 ${progress.failed} 条知识星球正文补取后仍不完整，已拒绝入库。`
        : progress.collected > 0
          ? `本轮已入库 ${progress.collected} 条，但仍有 ${progress.failed} 条写入失败，本轮未全部完成。`
          : `本轮 ${progress.failed} 条全部写入失败，一条都没入库。`
            + '多半是本机服务写不了知识库目录（磁盘满、目录被占用或权限变更）。';
      progress.code = coverageRiskCount > 0
        ? 'CONTENT_COVERAGE_INCOMPLETE'
        : allIncomplete
        ? 'INCOMPLETE_CONTENT'
        : progress.collected > 0
          ? 'PARTIAL_FAILURE'
          : 'ALL_WRITES_FAILED';
    }
    if (progress.phase === 'skipped_all') {
      // 区分两种「全部跳过」：还没截到接口响应（用户能自己解决），
      // 还是截到了但对不上号（需要我改适配）。
      if (captured === 0) {
        // 「一个都没截到」有三种完全不同的成因，直接问钩子要统计，
        // 把结论说死，而不是丢一段放之四海皆准的建议让用户自己试。
        const hook = await this.hookStats(tabId);
        progress.error = explainEmptyIndex(hook);
        progress.code = 'TOPIC_INDEX_EMPTY';
        note(
          `帖子号钩子：${hook.installed ? '在运行' : '未运行'}，`
          + `旁观请求 ${hook.observed} 次，其中 JSON 响应 ${hook.jsonResponses} 次，`
          + `含帖子号 ${hook.withTopicId} 次`,
        );
      } else {
        progress.error = `已获取 ${captured} 条帖子号，但和页面上的帖子对不上号。`
          + '请在「本轮明细」里点这些条目复制证据，或用「复制完整报告」发给开发者。';
        progress.code = 'TOPIC_INDEX_MISMATCH';
      }
    }
    report();
    return { ...progress };
  }

  /**
   * 已经提取好的一篇：建任务 → 直接回传结果（内容已在手，无需再开标签页）。
   * 区分「这一条不行」和「本机服务不行」：前者继续下一条，后者立刻收尾。
   */
  private async saveCollected(
    document: CollectedDocument,
    overrides: CaptureOverrides,
  ): Promise<'ok' | 'failed' | 'bridge-down'> {
    let job: { id: string };
    try {
      job = await this.options.bridge.createJob(document.canonicalUrl, overrides);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      // 只有「连不上 / 没授权」才是整条链路的问题，值得中断整批；
      // 服务端 5xx 更可能是这一条内容的问题，计入失败继续下一条。
      return /Failed to fetch|NetworkError|未连接|仍在自动连接|HTTP 40[13]/i.test(message)
        ? 'bridge-down'
        : 'failed';
    }
    try {
      this.options.bridge.send('job.progress', job.id, { stage: 'collecting' });
      this.sendDocumentResult(job.id, {
        ...document,
        ...(overrides.userCategory ? { userCategory: overrides.userCategory } : {}),
        ...(overrides.userTags ? { userTags: overrides.userTags } : {}),
      });
    } catch {
      // WebSocket 断了，后面每条都会一样失败。
      return 'bridge-down';
    }
    try {
      // job.result 只表示正文送进 Bridge；job.saved 才表示 sink 与 JobStore 都已落盘。
      // BridgeConnection 会缓存抢先到达的终态，并在 notice 丢失时查询 JobStore 兜底。
      await this.options.bridge.waitForJobTerminal(job.id);
      return 'ok';
    } catch {
      return 'failed';
    }
  }
}

/**
 * 「一个帖子号都没截到」到底是哪种情况——把结论说死。
 *
 * 之前只有一句放之四海皆准的「滚一屏或切一次分类」，用户照做也没用，
 * 因为真正的成因可能根本不是这个。三种成因给三种说法，各自对应能解决它的动作。
 */
export function explainEmptyIndex(hook: HookStats): string {
  if (!hook.installed) {
    return '页面里的帖子号钩子没有在运行，所以一条帖子号都截不到。'
      + '这通常发生在扩展刚更新、而本页是更新之前打开的。'
      + '请在 edge://extensions 确认 Data Collector 已启用，然后**新开一个知识星球标签页**再试'
      + '（本页不必刷新，刷新会把「精华」退回「最新」）。';
  }
  if (hook.observed === 0) {
    return '钩子在正常运行，但从它装上到现在，页面一个接口请求都没发出过——'
      + '本页的内容是更早之前加载好的，帖子号在那次响应里，已经错过了。'
      + '请把分类切走再切回来（会重新请求一次，且不会离开精华页），然后重试。';
  }
  if (hook.jsonResponses === 0) {
    return `钩子旁观到 ${hook.observed} 次请求，但没有一次是 JSON 响应，因而取不到帖子号。`
      + '请用「复制完整报告」把诊断发给开发者。';
  }
  return `钩子旁观到 ${hook.jsonResponses} 次 JSON 响应，但里面都没有帖子号——`
    + '站点的接口结构很可能变了，需要改适配。请用「复制完整报告」把诊断发给开发者。';
}
