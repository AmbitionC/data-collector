import {
  ZSXQ_PLAN_VIEWS,
  type CollectedDocument,
  type ZsxqPlanView,
} from '@data-collector/shared';
import {
  COLLECTED_ATTRIBUTE,
  KEY_ATTRIBUTE,
  listBodyText,
  ExtractionError,
  extractDocument,
  extractList,
  isZsxqExpandControl,
  pendingTopicCount,
  ZSXQ_EXPAND_CONTROL_SELECTOR,
  zsxqExpandLabel,
} from './extractors/index.js';
import {
  TOPIC_HOOK_BUILD_ID,
  TOPIC_HOOK_VERSION,
  TOPIC_REPLAY_REQUEST,
  TOPIC_STATS,
  TOPIC_STATS_REQUEST,
  TopicIndex,
  type HookStats,
  topicRecordsFromMessage,
} from './topicIndex.js';
import { commercialSignals } from './adFilter.js';
import {
  CONTENT_BUILD_ID,
  CONTENT_API_COLLECT_REQUEST,
  CONTENT_DIAGNOSE_REQUEST,
  CONTENT_DOCUMENT_REQUEST,
  CONTENT_ADVANCE_REQUEST,
  CONTENT_FOCUS_LAST_REQUEST,
  CONTENT_HIGHLIGHT_REQUEST,
  CONTENT_HOOK_STATS_REQUEST,
  CONTENT_ITEM_DIAGNOSE_REQUEST,
  CONTENT_REFRESH_TOPICS_REQUEST,
  CONTENT_RESTORE_REQUEST,
  CONTENT_SELECT_VIEW_REQUEST,
  CONTENT_EXTRACTION_PROTOCOL,
  CONTENT_LIST_REQUEST,
  isCurrentContentRequest,
} from './contentProtocol.js';
import { collectZsxqApiViews } from './zsxqApiFallback.js';

/**
 * 帖子号索引。帖子号不在 DOM 上，只能从应用自己的接口响应里取（见 inject.ts）。
 * 主世界脚本捕获后 postMessage 过来，这里累积成「正文 → 帖子号」的对照表。
 */
const topics = new TopicIndex();
/**
 * `TopicIndex.hasSourceBody()` 在同 topic 出现冲突时会 fail-closed 返回 false；
 * 这里额外记住“确实见过来源正文”，才能区分尚未观测与已知媒体不可证。
 */
const observedSourceBodyTopics = new Set<string>();
/** 主世界钩子最近一次上报的运行统计（诊断用）。 */
let hookStats: HookStats | undefined;
window.addEventListener('message', event => {
  if (event.source !== window) return;
  const data = event.data as {
    source?: unknown;
    hookVersion?: unknown;
    hookBuildId?: unknown;
    records?: unknown;
    stats?: unknown;
  };
  if (data?.source === TOPIC_STATS) {
    const candidate = data.stats as HookStats | undefined;
    if (
      data.hookVersion === TOPIC_HOOK_VERSION
      && data.hookBuildId === TOPIC_HOOK_BUILD_ID
      && candidate?.version === TOPIC_HOOK_VERSION
      && candidate.buildId === TOPIC_HOOK_BUILD_ID
    ) {
      hookStats = candidate;
    }
    return;
  }
  const records = topicRecordsFromMessage(data);
  if (records) {
    topics.add(records);
    for (const record of records) {
      if (record.sourceBodyProven === true) observedSourceBodyTopics.add(record.topicId);
    }
  }
});

/**
 * 向主世界钩子要回它留存的全部帖子号。
 *
 * TopicIndex 是模块级变量，内容脚本一被重注入（扩展更新、自愈注入）就清零；
 * 而页面上的老帖子还在、它们的接口响应不会重来。不要这一次，那些帖子就永远
 * 对不上号——实测正是「40 条里 20 条对得上、20 条对不上」的成因。
 * 钩子那边按帖子号去重留着，这里要回来即可；钩子是旧版没有这个能力也不会出错。
 */
function requestReplay(): void {
  window.postMessage({
    source: TOPIC_REPLAY_REQUEST,
    hookVersion: TOPIC_HOOK_VERSION,
    hookBuildId: TOPIC_HOOK_BUILD_ID,
  }, window.location.origin);
}

/**
 * 问主世界钩子要一份运行统计。
 *
 * 拿不到（超时）本身就是结论：**钩子没在跑**。这是「已捕获 0 个」最重要的一种成因，
 * 光看帖子号条数分不出来——之前就是因此反复猜。
 */
function requestHookStats(timeoutMs = 400): Promise<HookStats> {
  hookStats = undefined;
  window.postMessage({
    source: TOPIC_STATS_REQUEST,
    hookVersion: TOPIC_HOOK_VERSION,
    hookBuildId: TOPIC_HOOK_BUILD_ID,
  }, window.location.origin);
  return new Promise(resolve => {
    const started = Date.now();
    const poll = () => {
      if (hookStats) return resolve(hookStats);
      if (Date.now() - started >= timeoutMs) {
        resolve({
          installed: false,
          observed: 0,
          jsonResponses: 0,
          withTopicId: 0,
          publishedRecords: 0,
          recent: [],
        });
        return;
      }
      setTimeout(poll, 40);
    };
    poll();
  });
}

interface ExtractMessage {
  type:
    | 'extract.document'
    | 'extract.list'
    | typeof CONTENT_DOCUMENT_REQUEST
    | typeof CONTENT_LIST_REQUEST
    | typeof CONTENT_SELECT_VIEW_REQUEST
    | typeof CONTENT_API_COLLECT_REQUEST
    | typeof CONTENT_RESTORE_REQUEST
    | typeof CONTENT_ADVANCE_REQUEST
    | typeof CONTENT_REFRESH_TOPICS_REQUEST
    | typeof CONTENT_DIAGNOSE_REQUEST
    | typeof CONTENT_HIGHLIGHT_REQUEST
    | typeof CONTENT_ITEM_DIAGNOSE_REQUEST
    | typeof CONTENT_HOOK_STATS_REQUEST
    | typeof CONTENT_FOCUS_LAST_REQUEST
    | 'list.advance'
    | 'list.diagnose'
    | 'list.restore'
    | 'list.highlight'
    | 'list.itemDiagnose'
    | 'list.hookStats'
    | 'list.refreshTopics'
    | 'list.focusLast'
    | 'list.selectView'
    | 'list.apiCollect';
  /** list.highlight：要滚过去并高亮的那一条。 */
  key?: string;
  label?: ZsxqPlanView;
  overrides?: {
    userCategory?: string;
    userTags?: string[];
  };
}

/**
 * 提取前先点开正文的「展开全文」，否则折叠的帖子只能采到截断的正文。
 * 只点文案精确匹配且可见的控件，避免误触评论区/推荐位；列表页一屏 20+ 条，上限放宽。
 * 返回每个点击目标的正文探针——点过以后必须实际观察到正文增长并稳定，
 * 不能把“click 没抛错 / 控件消失”误当成展开成功。
 */
interface ExpansionProbe {
  scope: Element;
  owner: Element;
  baseline: number;
  ownerBaseline: number;
}

interface ExpansionValidation {
  unconfirmedOwners: ReadonlyMap<Element, number>;
  /** 控件消失、正文增长且稳定满窗口的 owner；这是独立于 API 的完成证明。 */
  confirmedOwners: ReadonlySet<Element>;
  /** 探针节点被 SPA 整块替换后无法证明新节点就是已完整展开的同一篇，整次提取保守拒绝。 */
  failClosedAll: boolean;
}

/**
 * 点击后 8 秒没观察到增长只是“尚未证明”，不是正文确定被裁剪的正向证据。
 * 保留真实控件/API 上限产生的 true；已核验来源正文则是独立完成证明；其余转 unknown，
 * 让后台继续有界采样，若后续始终没有 false，最终仍会 fail-closed。
 */
function withUnconfirmedExpansion(document: CollectedDocument): CollectedDocument {
  if (document.truncated === true) return document;
  if (
    document.truncated === false
    && document.sourceMetadata?.sourceBodyProven === true
  ) return document;
  const result: CollectedDocument = {
    ...document,
    sourceMetadata: {
      ...(document.sourceMetadata ?? {}),
      expansionUnconfirmed: true,
    },
  };
  delete result.truncated;
  return result;
}

function withConfirmedExpansion(document: CollectedDocument): CollectedDocument {
  // 来源上限/仍在的真实控件是正向截断证据，点击增长不能洗掉。
  if (document.truncated === true) return document;
  return {
    ...document,
    truncated: false,
    sourceMetadata: {
      ...(document.sourceMetadata ?? {}),
      expansionConfirmed: true,
    },
  };
}

function normalizedTextLength(value: string): number {
  return value.replace(/\s+/g, '').length;
}

/** 去掉展开控件自身文案后量正文，避免按钮消失造成“先缩短再增长”的假象。 */
function expansionTextLength(root: Element): number {
  const clone = root.cloneNode(true) as Element;
  for (const candidate of clone.querySelectorAll(ZSXQ_EXPAND_CONTROL_SELECTOR)) {
    if (isZsxqExpandControl(candidate)) candidate.remove();
  }
  return normalizedTextLength(clone.textContent ?? '');
}

function expandCollapsedContent(limit: number): ExpansionProbe[] {
  const candidates = [...document.querySelectorAll<HTMLElement>(ZSXQ_EXPAND_CONTROL_SELECTOR)].filter(
    element =>
      isZsxqExpandControl(element)
      && (element.offsetParent !== null || element.offsetHeight !== 0),
  );
  /*
   * 每处只点**最内层**那一个。
   *
   * 展开控件在站点上是包了一层的（`<div><span>展开全部</span></div>`），
   * 两层的 textContent 都等于「展开全部」，逐个点等于对同一个开关点了两次——
   * 第二次把刚展开的又收了回去，采到的还是截断正文。
   * 实测就是这个症状：入库正文末尾还留着「展开全部」四个字，用户要的后半段根本没采到。
   */
  const targets = candidates.filter(
    element => !candidates.some(other => other !== element && element.contains(other)),
  );
  const probes: ExpansionProbe[] = [];
  for (const element of targets) {
    if (probes.length >= limit) break;
    const scope = element.closest(
      '.talk-content-container, .q-content-container, .answer-content-container, article, .topic-container',
    ) ?? element.parentElement ?? document.body;
    const owner = element.closest('.topic-container') ?? document.body;
    try {
      const baseline = expansionTextLength(scope);
      const ownerBaseline = expansionTextLength(owner);
      element.click();
      probes.push({ scope, owner, baseline, ownerBaseline });
    } catch {
      // 忽略不可点击的元素。
    }
  }
  return probes;
}

/**
 * 等 SPA 真正把正文尾部挂进 DOM，并保持一段足够长的稳定窗口。超时仍没增长的 owner
 * 会交给提取结果强制标 truncated，Bridge 因而拒绝落盘。
 */
function waitForExpandedContent(
  probes: readonly ExpansionProbe[],
  timeoutMs = 8_000,
  intervalMs = 100,
  stabilityMs = 1_500,
): Promise<ExpansionValidation> {
  if (probes.length === 0) {
    return Promise.resolve({
      unconfirmedOwners: new Map(),
      confirmedOwners: new Set(),
      failClosedAll: false,
    });
  }
  const started = Date.now();
  const pending = new Set(probes);
  const observed = new Map<ExpansionProbe, { length: number; changedAt: number }>();
  return new Promise(resolve => {
    const poll = () => {
      for (const probe of pending) {
        if (!probe.scope.isConnected) continue;
        const length = expansionTextLength(probe.scope);
        if (length <= probe.baseline) continue;
        const previous = observed.get(probe);
        const changedAt = previous?.length === length ? previous.changedAt : Date.now();
        observed.set(probe, { length, changedAt });
        const controlRemains = [...probe.scope.querySelectorAll(ZSXQ_EXPAND_CONTROL_SELECTOR)]
          .some(isZsxqExpandControl);
        if (!controlRemains && Date.now() - changedAt >= stabilityMs) pending.delete(probe);
      }
      if (pending.size === 0) {
        return resolve({
          unconfirmedOwners: new Map(),
          confirmedOwners: new Set(probes.map(probe => probe.owner)),
          failClosedAll: false,
        });
      }
      if (Date.now() - started >= timeoutMs) {
        const unconfirmed = new Map<Element, number>();
        let failClosedAll = false;
        for (const probe of pending) {
          // React/Vue 可能在点击后 replace 整个 topic；旧节点上的 Map key 此时不能
          // 和新提取节点对应。没有稳定 topic revision 可证明完整，只能整轮 fail-closed。
          if (!probe.scope.isConnected || !probe.owner.isConnected || probe.owner === document.body) {
            failClosedAll = true;
          }
          unconfirmed.set(
            probe.owner,
            Math.max(unconfirmed.get(probe.owner) ?? 0, probe.ownerBaseline),
          );
        }
        const unconfirmedOwnerSet = new Set([...pending].map(probe => probe.owner));
        return resolve({
          unconfirmedOwners: unconfirmed,
          confirmedOwners: new Set(
            probes
              .filter(probe => !unconfirmedOwnerSet.has(probe.owner))
              .map(probe => probe.owner),
          ),
          failClosedAll,
        });
      }
      setTimeout(poll, intervalMs);
    };
    poll();
  });
}

/** 已处理标记绑定的帖子号；与正文签名一起防止虚拟列表复用节点时继承旧标记。 */
const COLLECTED_TOPIC_ID_ATTRIBUTE = 'data-dc-collected-topic-id';
const TOPIC_ID_PATTERN = /^\d{15,25}$/;
const TOPIC_BODY_SELECTOR = [
  '.talk-content-container',
  '.article-content-container',
  '.q-content-container',
  '.answer-content-container',
].join(', ');

interface ProcessedTopicBinding {
  container: Element;
  /** 由接口正文对号或容器根节点 data-topic-id 证明，绝不从任意后代 URL 猜。 */
  topicId: string;
  /** 提取当时的语义正文+正文块资产修订；纯图片帖也能可靠绑定。 */
  revision: string;
}

/** 上一轮列表提取覆盖到的帖子节点，等 list.advance 时统一打标记。 */
let lastListContainers: ProcessedTopicBinding[] = [];
/** DOM 节点上的属性供选择器使用；精确正文留在内存里，避免把整篇内容塞进属性。 */
const processedTopicBindings = new WeakMap<Element, ProcessedTopicBinding>();

function semanticBody(container: Element): string | undefined {
  const body = listBodyText(container).replace(/\s+/g, ' ').trim();
  return body || undefined;
}

interface ContentObservation {
  generation: number;
  revision: number;
  content: string;
}

/**
 * key 属于 DOM 属性，虚拟列表复用节点时不会变；observation 同时绑定节点实例与语义正文。
 * API 身份只是迟到而 DOM/body 未变时 id 保持稳定，节点复用或正文变化都会生成新 revision。
 */
const contentObservations = new WeakMap<Element, ContentObservation>();
let nextObservationGeneration = 1;

function contentObservationId(container: Element): string {
  const content = semanticContentRevision(container) ?? '';
  let observation = contentObservations.get(container);
  if (!observation) {
    observation = {
      generation: nextObservationGeneration,
      revision: 0,
      content,
    };
    nextObservationGeneration += 1;
    contentObservations.set(container, observation);
  } else if (observation.content !== content) {
    observation.content = content;
    observation.revision += 1;
  }
  return `generation-${observation.generation}:revision-${observation.revision}`;
}

function topicIdFromUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const match = new URL(rawUrl, location.href).pathname.match(/^\/group\/\d+\/topic\/(\d{15,25})\/?$/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function entryTopicId(entry: {
  document?: CollectedDocument;
  url?: string;
}): string | undefined {
  const metadataId = entry.document?.sourceMetadata?.topicId;
  if (typeof metadataId === 'string' && TOPIC_ID_PATTERN.test(metadataId)) return metadataId;
  return topicIdFromUrl(entry.document?.canonicalUrl ?? entry.url);
}

/**
 * 当前节点的可证明身份。多个独立证据互相冲突时不挑一个猜，而是显式报 conflict。
 * 正文候选与列表提取保持同一语义边界：整段、各正文块、最后才是整个帖子节点。
 */
function currentTopicProof(container: Element): { topicId?: string; conflict: boolean } {
  const ids = new Set<string>();
  let ambiguous = false;
  const direct = container.getAttribute('data-topic-id');
  if (direct && TOPIC_ID_PATTERN.test(direct)) ids.add(direct);

  const found = [...container.querySelectorAll(TOPIC_BODY_SELECTOR)];
  const blocks = found.filter(
    node => !found.some(other => other !== node && other.contains(node)),
  );
  const candidates = [
    listBodyText(container),
    ...blocks.map(block => block.textContent ?? ''),
    container.textContent ?? '',
  ];
  for (const candidate of new Set(candidates.filter(Boolean))) {
    const evidence = topics.identityEvidence(candidate);
    if (evidence.status === 'ambiguous') ambiguous = true;
    if (evidence.status === 'unique' && TOPIC_ID_PATTERN.test(evidence.topicId)) {
      ids.add(evidence.topicId);
    }
  }
  const imageUrls = found.flatMap(block => (
    [...block.querySelectorAll<HTMLImageElement>('img')]
      .map(image => image.getAttribute('data-src') ?? image.getAttribute('src') ?? '')
      .filter(Boolean)
  ));
  const imageEvidence = topics.findByImageUrls(imageUrls);
  if (imageEvidence.status === 'ambiguous') ambiguous = true;
  if (imageEvidence.status === 'unique' && TOPIC_ID_PATTERN.test(imageEvidence.topicId)) {
    ids.add(imageEvidence.topicId);
  }
  // 一个更强的唯一候选（例如问答里的回答块、或根节点 data-topic-id）可以消解
  // 另一个宽候选的歧义；没有任何唯一证据时，歧义必须显式传给标记门禁。
  if (ids.size !== 1) return { conflict: ids.size > 1 || ambiguous };
  const topicId = ids.values().next().value;
  return typeof topicId === 'string' ? { topicId, conflict: false } : { conflict: false };
}

interface ConfirmedExpansionProof {
  /** 证明只属于当时的 exact SPA URL，包括 query/hash。 */
  url: string;
  /** URL 与 owner 身份不冲突后得到的帖子号。 */
  topicId: string;
  /** 节点代际 + 语义正文 revision；内容变过再变回也不会复活。 */
  observationId: string;
  /** 来源媒体证明/资源集的精确修订。 */
  sourceMediaRevision: string;
  /** 展开后 DOM 中的媒体节点实例及属性修订。 */
  domMediaRevision: readonly DomMediaRevision[];
}

interface DomMediaRevision {
  node: Element;
  revision: string;
}

/**
 * 已成功展开的证明需要跨 content request 保留：后续稳定帧已经没有按钮，
 * 如果只保存在当次 run() 里，第二帧就会被误判成“无完成证明”。
 * Map 使我们能在每轮删除已断连 owner；页面内条目数有界，且断连记录会立即清理。
 */
const confirmedExpansionProofs = new Map<Element, ConfirmedExpansionProof>();

const BODY_MEDIA_SELECTOR = [
  'img',
  'video',
  'audio',
  'source',
  'a[href]',
  '[src]',
  '[srcset]',
  '[data-src]',
  '[data-url]',
  '[data-href]',
].join(', ');
const BODY_MEDIA_ATTRIBUTES = [
  'src',
  'srcset',
  'href',
  'poster',
  'data-src',
  'data-url',
  'data-href',
  'download',
  'alt',
  'title',
  'aria-label',
] as const;

interface MediaNodeObservation {
  generation: number;
  revision: number;
  attributes: readonly (string | null)[];
}

const mediaNodeObservations = new WeakMap<Element, MediaNodeObservation>();
let nextMediaNodeGeneration = 1;

function mediaNodeRevision(node: Element): string {
  const attributes = BODY_MEDIA_ATTRIBUTES.map(attribute => node.getAttribute(attribute));
  let observation = mediaNodeObservations.get(node);
  if (!observation) {
    observation = {
      generation: nextMediaNodeGeneration,
      revision: 0,
      attributes,
    };
    nextMediaNodeGeneration += 1;
    mediaNodeObservations.set(node, observation);
  } else if (
    observation.attributes.length !== attributes.length
    || attributes.some((value, index) => value !== observation?.attributes[index])
  ) {
    observation.attributes = attributes;
    observation.revision += 1;
  }
  return `generation-${observation.generation}:revision-${observation.revision}`;
}

function sourceMediaRevision(topicId: string): string {
  return JSON.stringify({
    observedSourceBody: observedSourceBodyTopics.has(topicId),
    proven: topics.sourceMediaProvenOf(topicId),
    images: topics.sourceImagesOf(topicId).map(image => [image.url, image.alt ?? null]),
    attachments: topics.sourceAttachmentsOf(topicId)
      .map(attachment => [attachment.url, attachment.title ?? null]),
  });
}

function domMediaRevision(owner: Element): readonly DomMediaRevision[] {
  const roots = [...owner.querySelectorAll(TOPIC_BODY_SELECTOR)];
  const nodes = new Set<Element>();
  for (const root of roots) {
    if (root.matches(BODY_MEDIA_SELECTOR)) nodes.add(root);
    for (const node of root.querySelectorAll(BODY_MEDIA_SELECTOR)) nodes.add(node);
  }
  return [...nodes].map(node => ({
    node,
    revision: mediaNodeRevision(node),
  }));
}

function sameDomMediaRevision(
  owner: Element,
  previous: readonly DomMediaRevision[],
): boolean {
  const current = domMediaRevision(owner);
  return current.length === previous.length
    && current.every((revision, index) => (
      revision.node === previous[index]?.node
      && revision.revision === previous[index]?.revision
    ));
}

/**
 * 已处理绑定与翻页耗尽观察的语义修订。只看正文块，不把作者头像/评论图混进来；
 * 同时不保存 DOM 节点代际，因为这里关心的是内容是否变了。
 */
function semanticContentRevision(container: Element): string | undefined {
  const body = semanticBody(container) ?? '';
  const assets = domMediaRevision(container).map(revision => (
    `${revision.node.tagName}:${revision.revision}`
  ));
  if (!body && assets.length === 0) return undefined;
  return JSON.stringify([body, assets]);
}

function visibleExpansionControlWithin(owner: Element): boolean {
  return [...owner.querySelectorAll<HTMLElement>(ZSXQ_EXPAND_CONTROL_SELECTOR)].some(
    control =>
      isZsxqExpandControl(control)
      && (control.offsetParent !== null || control.offsetHeight !== 0),
  );
}

/**
 * 展开证明的帖子号只能来自“正文 ↔ TopicIndex”的独立唯一匹配。
 * URL 和 `data-topic-id` 都可能在 SPA 切帖时先变，它们只能检查一致性，
 * 绝不能单独把尚未换掉的旧 DOM 正文证成新帖。
 */
function expansionBodyTopicId(owner: Element): string | undefined {
  const found = [...owner.querySelectorAll(TOPIC_BODY_SELECTOR)];
  const blocks = found.filter(
    node => !found.some(other => other !== node && other.contains(node)),
  );
  const candidates = [
    listBodyText(owner),
    ...blocks.map(block => block.textContent ?? ''),
  ];
  const ids = new Set<string>();
  for (const candidate of new Set(candidates.filter(Boolean))) {
    const evidence = topics.identityEvidence(candidate);
    if (evidence.status === 'unique' && TOPIC_ID_PATTERN.test(evidence.topicId)) {
      ids.add(evidence.topicId);
    }
  }
  if (ids.size !== 1) return undefined;
  const topicId = ids.values().next().value;
  return typeof topicId === 'string' ? topicId : undefined;
}

/** URL/root 身份只做交叉校验；列表页没有 URL topic id 时仍必须有正文匹配。 */
function expansionTopicId(owner: Element): string | undefined {
  const bodyTopicId = expansionBodyTopicId(owner);
  if (!bodyTopicId) return undefined;
  if (topics.sourceBodyConflicted(bodyTopicId)) return undefined;
  const urlTopicId = topicIdFromUrl(location.href);
  if (urlTopicId && urlTopicId !== bodyTopicId) return undefined;
  const directTopicId = owner.getAttribute('data-topic-id');
  if (
    directTopicId
    && TOPIC_ID_PATTERN.test(directTopicId)
    && directTopicId !== bodyTopicId
  ) return undefined;
  return bodyTopicId;
}

function rememberConfirmedExpansion(owner: Element): boolean {
  const topicId = expansionTopicId(owner);
  const sourceBodyObserved = Boolean(topicId && observedSourceBodyTopics.has(topicId));
  if (
    !owner.isConnected
    || !topicId
    || !semanticBody(owner)
    || visibleExpansionControlWithin(owner)
    // UI 增长只证明文字；来源已明确媒体不可证时绝不强制 false。
    || (sourceBodyObserved && !topics.sourceMediaProvenOf(topicId))
  ) {
    confirmedExpansionProofs.delete(owner);
    return false;
  }
  confirmedExpansionProofs.set(owner, {
    url: location.href,
    topicId,
    observationId: contentObservationId(owner),
    sourceMediaRevision: sourceMediaRevision(topicId),
    domMediaRevision: domMediaRevision(owner),
  });
  return true;
}

/**
 * 任一绑定条件变化就永久删除旧证明，不做“恢复原值后复活”的弱缓存。
 * 折叠控件要在 click 前检查，因为点击后 SPA 可能先把它移除。
 */
function pruneConfirmedExpansionProofs(): void {
  for (const [owner, proof] of confirmedExpansionProofs) {
    const topicId = owner.isConnected ? expansionTopicId(owner) : undefined;
    const valid = owner.isConnected
      && proof.url === location.href
      && topicId === proof.topicId
      && contentObservationId(owner) === proof.observationId
      && sourceMediaRevision(proof.topicId) === proof.sourceMediaRevision
      && sameDomMediaRevision(owner, proof.domMediaRevision)
      && !visibleExpansionControlWithin(owner);
    if (!valid) confirmedExpansionProofs.delete(owner);
  }
}

function hasConfirmedExpansion(owner: Element): boolean {
  const proof = confirmedExpansionProofs.get(owner);
  return proof !== undefined && !topics.sourceBodyConflicted(proof.topicId);
}

/**
 * `.topic-container` 也会出现在菜单/侧栏。详情页 owner 必须从带语义正文的容器中选，
 * 优先 URL 帖子号精确命中；多个无法消歧时退回 body，让证明门禁 fail-closed。
 */
function detailExpansionOwner(): Element {
  const candidates = [...document.querySelectorAll('.topic-container')].filter(
    candidate => candidate.querySelector(TOPIC_BODY_SELECTOR) !== null,
  );
  const targetTopicId = topicIdFromUrl(location.href);
  const exact = targetTopicId
    ? candidates.filter(candidate => candidate.getAttribute('data-topic-id') === targetTopicId)
    : [];
  if (exact.length === 1) return exact[0]!;
  if (candidates.length === 1) return candidates[0]!;
  return document.body;
}

function clearProcessedMark(container: Element): void {
  container.removeAttribute(COLLECTED_ATTRIBUTE);
  container.removeAttribute(COLLECTED_TOPIC_ID_ATTRIBUTE);
  // key 也属于旧帖；留着会让侧栏里的 B 继续复用 A 的定位身份。
  container.removeAttribute(KEY_ATTRIBUTE);
  processedTopicBindings.delete(container);
}

/**
 * 虚拟列表会原地复用 `.topic-container`。只有“正文仍相同且身份不冲突”才能沿用旧标记：
 * - 正文变化：立即解除，即便新帖的接口记录尚未到，也先让它进入 pending/retryable；
 * - 正文相同、当前暂无身份证据：保留，避免因瞬时证据缺失重复采同一帖；
 * - 当前身份与旧身份不同或证据冲突：解除，绝不让 B 继承 A。
 */
function reconcileProcessedMarks(): number {
  let cleared = 0;
  for (const container of document.querySelectorAll(`[${COLLECTED_ATTRIBUTE}]`)) {
    const binding = processedTopicBindings.get(container);
    const storedTopicId = container.getAttribute(COLLECTED_TOPIC_ID_ATTRIBUTE);
    const proof = currentTopicProof(container);
    const revision = semanticContentRevision(container);
    // 扩展上下文重建后可能只剩 DOM 属性、内存里的完整正文绑定已经丢失；这种标记
    // 无法证明仍属于当前节点，必须 fail-open 重新审计，最多重复，绝不能静默漏帖。
    const stale = !binding
      || revision !== binding.revision
        || (Boolean(storedTopicId) && storedTopicId !== binding.topicId)
        || proof.conflict
        || (proof.topicId !== undefined && proof.topicId !== binding.topicId);
    if (!stale) continue;
    clearProcessedMark(container);
    cleared += 1;
  }
  return cleared;
}

function currentPendingTopicCount(): number {
  reconcileProcessedMarks();
  return pendingTopicCount(document);
}

/**
 * 给已处理的帖子打个**不可见**的标记，下一轮就不会重复提取它们。
 *
 * 早先的实现顺手把它们 display:none 收起（想压缩页面高度好触发懒加载），
 * 但那会让用户没法肉眼核对采到的内容对不对——验证阶段这是硬伤。
 * 加载下一批改为纯靠滚动到底触发站点自己的懒加载，页面外观一动不动。
 */
function markProcessed(): number {
  let marked = 0;
  for (const binding of lastListContainers) {
    const { container } = binding;
    if (!container.isConnected || container.hasAttribute(COLLECTED_ATTRIBUTE)) continue;
    // 提取与推进之间节点也可能已被复用；不把 A 的身份贴到已经变成 B 的 DOM 上。
    const proof = currentTopicProof(container);
    if (
      semanticContentRevision(container) !== binding.revision
      || proof.conflict
      || (proof.topicId !== undefined && proof.topicId !== binding.topicId)
    ) continue;
    container.setAttribute(COLLECTED_ATTRIBUTE, '1');
    container.setAttribute(COLLECTED_TOPIC_ID_ATTRIBUTE, binding.topicId);
    processedTopicBindings.set(container, binding);
    marked += 1;
  }
  lastListContainers = [];
  return marked;
}

/** 清掉所有处理标记，让整页重新可采（顺带擦掉早期版本残留的 display:none）。 */
function clearMarks(): number {
  const marked = [...document.querySelectorAll<HTMLElement>(`[${COLLECTED_ATTRIBUTE}]`)];
  for (const container of marked) {
    container.removeAttribute(COLLECTED_ATTRIBUTE);
    container.removeAttribute(COLLECTED_TOPIC_ID_ATTRIBUTE);
    container.style.removeProperty('display');
    processedTopicBindings.delete(container);
  }
  lastListContainers = [];
  return marked.length;
}

const HIGHLIGHT_STYLE_ID = 'data-collector-highlight-style';
const HIGHLIGHT_CLASS = 'data-collector-highlight';

/** 侧栏点某一条时，把页面滚到它那儿并高亮出来，方便逐条核对。 */
function highlightEntry(key: string): { found: boolean } {
  // 逐个比对而不是拼选择器：key 里可能有冒号、点号这类在选择器里有含义的字符，
  // 拼串既要转义又容易出错，扫一遍最稳。
  const target = [...document.querySelectorAll<HTMLElement>(`[${KEY_ATTRIBUTE}]`)]
    .find(node => node.getAttribute(KEY_ATTRIBUTE) === key);
  if (!target) return { found: false };
  if (!document.getElementById(HIGHLIGHT_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = HIGHLIGHT_STYLE_ID;
    style.textContent = `.${HIGHLIGHT_CLASS}{outline:3px solid #f54e00!important;`
      + 'outline-offset:4px;border-radius:8px;transition:outline-color 200ms ease}';
    document.head.append(style);
  }
  for (const previous of document.querySelectorAll(`.${HIGHLIGHT_CLASS}`)) {
    previous.classList.remove(HIGHLIGHT_CLASS);
  }
  target.classList.add(HIGHLIGHT_CLASS);
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return { found: true };
}

/**
 * 信息流滚动在哪个元素上。
 *
 * 不能只认「computed overflow 是 auto/scroll」：站点也可能靠 body / documentElement
 * 滚动，或者用别的方式撑出滚动区。挑不对就等于没滚，懒加载永远不触发——
 * 实测每一轮都是「新增待采 0 条」，正是卡在这里。
 * 因此按可靠性依次收集候选，实际滚动时**验证 scrollTop 真的动了**。
 */
function scrollCandidates(): HTMLElement[] {
  const candidates: HTMLElement[] = [];
  const push = (element: Element | null | undefined) => {
    if (!(element instanceof HTMLElement)) return;
    if (candidates.includes(element)) return;
    if (element.scrollHeight > element.clientHeight + 40) candidates.push(element);
  };
  const anchor = document.querySelector(`[${COLLECTED_ATTRIBUTE}]`)
    ?? document.querySelector('.topic-container');
  // 先从帖子往上找带滚动样式的祖先（最可能是那个内部滚动容器）。
  for (let element = anchor?.parentElement; element; element = element.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(element).overflowY)) push(element);
  }
  // 再退回文档级滚动，以及不看样式、只看「能不能滚」的祖先。
  push(document.scrollingElement as HTMLElement | null);
  push(document.documentElement);
  push(document.body);
  for (let element = anchor?.parentElement; element; element = element.parentElement) push(element);
  return candidates;
}

/** 已经滚到底了吗（留 4px 容差，避免亚像素误差把「到底」判成「还没到」）。 */
function atBottom(element: HTMLElement): boolean {
  return element.scrollTop + element.clientHeight >= element.scrollHeight - 4;
}

/**
 * 把视口移到「已处理区域的末尾」——也就是上一批采到的最后一条。
 *
 * 两个作用：
 * - 批量结束后用户一眼看到采到哪儿了，不用自己找；
 * - 「继续采下一批」时从这里往下滚，而不是从视口当前所在的位置。
 *   页面很长（40 条帖子几万像素），从头滚几千像素根本到不了底，
 *   懒加载自然永远不触发——实测每轮都是「新增待采 0 条」，正是这个原因。
 */
function scrollToFrontier(): boolean {
  const processed = [...document.querySelectorAll<HTMLElement>(`[${COLLECTED_ATTRIBUTE}]`)];
  const last = processed[processed.length - 1] ?? lastListContainers[lastListContainers.length - 1];
  if (!(last instanceof HTMLElement)) return false;
  try {
    last.scrollIntoView({ block: 'end' });
    return true;
  } catch {
    return false;
  }
}

/** 元素的可读描述，写进运行记录用（不含正文，只有结构信息）。 */
function describe(element: HTMLElement | undefined): string {
  if (!element) return '(无)';
  const className = String(element.className || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
  return className ? `${element.tagName.toLowerCase()}.${className}` : element.tagName.toLowerCase();
}

/** 人不会一秒滚好几次、也不会瞬移到底：随机化的间隔与步长。 */
function humanPause(min: number, max: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, min + Math.random() * (max - min)));
}

/**
 * 像人一样往下滚：分几次、每次滚不到一屏、间隔随机。
 * 早先是「每 500 毫秒瞬移到底」，那个节奏机器味太重，容易触发风控。
 *
 * 返回这一轮到底滚动了什么、动没动——**滚没滚动必须能被观测到**，
 * 否则「新增待采 0 条」既可能是到底了，也可能是压根没滚，根本分不清。
 */
/** 把已加载内容的最后一条送进视野——这是「翻到末尾」最不挑实现的办法。 */
function jumpToLastPost(): void {
  try {
    const posts = document.querySelectorAll('.topic-container');
    (posts[posts.length - 1] as HTMLElement | undefined)?.scrollIntoView?.({ block: 'end' });
  } catch {
    // 环境不支持就算了，调用方照常观察帖子数有没有变化。
  }
}

/**
 * 往下翻到已加载内容的末尾。
 *
 * **不「爬」页面**：40 条帖子的信息流有几万像素高，按每次半屏小步滚要几十步、几十秒，
 * 实际结果是滚了一万多像素就收手，离底还远，懒加载自然不触发（实测就是这样）。
 * 真人也不会一格一格挪——他直接甩到末尾。所以先把最后一条送进视野（一步到位），
 * 再在底部附近做几次小幅滚动把懒加载顶出来。
 *
 * 「拟人」真正要防的是**请求节奏**：随机停顿、不连续猛刷，这两点都保留着；
 * 滚动本身在触底之前不产生任何请求。
 */
async function scrollLikeHuman(
  nudges = 3,
): Promise<{ host: string; moved: number; bottom: boolean }> {
  // 候选过多时逐个试会把一次翻页拖到几十秒；前四个已覆盖滚动祖先和文档回退。
  const candidates = scrollCandidates().slice(0, 4);
  // 每个候选滚动前的位置：位移要把 jumpToLastPost 那一下也算进去。
  const startTops = candidates.map(candidate => candidate.scrollTop);

  jumpToLastPost();
  await humanPause(450, 900);

  /*
   * **逐个候选试，直到真有一个动了。**
   *
   * 原先只认 `candidates[0]`，而 `body` 常常满足「scrollHeight > clientHeight」
   * 却根本推不动（真正的滚动容器在内层）。于是每一轮都是
   * 「目标 body，位移 0px，推不动任何元素」，翻页彻底停摆——实测踩到过：
   * 采完一屏就收工，后面的帖子永远够不着。
   * scrollCandidates 本来就按可靠性收集了一串候选，这里必须把它们用上。
   */
  const tried: string[] = [];
  for (const [index, host] of candidates.entries()) {
    // 到不了底就自己补到底：有的实现里 scrollIntoView 只把元素带到视口内。
    for (let nudge = 0; nudge < nudges; nudge += 1) {
      if (atBottom(host)) break;
      const previous = host.scrollTop;
      host.scrollTop = previous + Math.max(host.clientHeight, 400);
      if (host.scrollTop === previous) break;
      await humanPause(450, 1_100);
    }
    const moved = host.scrollTop - (startTops[index] ?? 0);
    // 位移为 0 但已经到底也算数：scrollToFrontier 那一下可能已经把它带到了末尾。
    if (moved !== 0 || atBottom(host)) {
      return { host: describe(host), moved, bottom: atBottom(host) };
    }
    tried.push(describe(host));
  }

  // 一个都推不动：把试过哪些如实带回去，否则只剩「推不动任何元素」六个字没法排查。
  return { host: tried.length > 0 ? `试过 ${tried.join('、')}` : '(无候选)', moved: 0, bottom: false };
}

/**
 * `loaded: 0` 是整个批次的终止证明，不能用一次短轮询猜出来。
 *
 * 列表滚到底以后，知识星球的 Angular/懒加载可能要 5–10 秒才挂新节点；之前只等
 * 约 2.5–4.7 秒，就会把“请求还在路上”误报成“已经到底”，后续帖子静默漏采。
 * 这里把 DOM topic、待采数、TopicIndex 和已处理标记一起纳入状态；只有最后一次变化后
 * 连续 24 秒都不动，才允许返回真正的零。总观察窗口仍有界，持续抖动时返回 uncertain，
 * 由后台继续采样，绝不把未证明的状态冒充耗尽。
 */
const ADVANCE_EXHAUSTION_STABILITY_MS = 24_000;
const ADVANCE_EXHAUSTION_TIMEOUT_MS = 44_500;
const ADVANCE_EXHAUSTION_POLL_MS = 250;

interface AdvanceExhaustionTracker {
  sample(): number;
  /** 主动滚动刚触发了潜在懒加载请求；稳定窗口必须从这次触发之后重新计算。 */
  touch(): void;
  wait(): Promise<{ loaded: number; exhausted: boolean }>;
  stop(): void;
}

function advanceStateSignature(pending: number): string {
  const topicState = [...document.querySelectorAll<HTMLElement>('.topic-container')]
    .map((container, index) => {
      const revision = semanticContentRevision(container) ?? '';
      return [
        index,
        container.dataset.topicId ?? '',
        container.getAttribute(COLLECTED_ATTRIBUTE) ?? '',
        container.getAttribute(COLLECTED_TOPIC_ID_ATTRIBUTE) ?? '',
        revision.length,
        revision.slice(0, 120),
        revision.slice(-240),
      ];
    });
  // 同一帖子随后补到 TopicIndex 的新正文段也属于身份状态变化。samples 按实际索引
  // 证据展开；给每个 topic 留足多段额度，同时设置一个小批次下限。
  const indexState = topics.samples(Math.max(64, topics.size * 8));
  return JSON.stringify([pending, topics.size, indexState, topicState]);
}

function trackAdvanceExhaustion(): AdvanceExhaustionTracker {
  const startedAt = Date.now();
  let lastChangedAt = startedAt;
  let pending = currentPendingTopicCount();
  let signature = advanceStateSignature(pending);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const sample = (): number => {
    if (stopped) return pending;
    pending = currentPendingTopicCount();
    const next = advanceStateSignature(pending);
    if (next !== signature) {
      signature = next;
      lastChangedAt = Date.now();
    }
    return pending;
  };

  const touch = (): void => {
    if (!stopped) lastChangedAt = Date.now();
  };

  const observer = new MutationObserver(records => {
    if (stopped) return;
    // 任何 topic 子树变化都可能是正文/骨架屏/虚拟节点的下一阶段。即使摘要签名
    // 恰巧相同也保守重置稳定窗口，避免同长度替换被哈希/摘要碰撞漏掉。
    const touchedTopic = records.some(record => {
      const target = record.target instanceof Element
        ? record.target
        : record.target.parentElement;
      return target?.matches('.topic-container') === true
        || Boolean(target?.closest('.topic-container'));
    });
    if (touchedTopic) lastChangedAt = Date.now();
    sample();
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      'class',
      'data-topic-id',
      COLLECTED_ATTRIBUTE,
      COLLECTED_TOPIC_ID_ATTRIBUTE,
    ],
  });

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    if (timer !== undefined) clearTimeout(timer);
  };

  const wait = (): Promise<{ loaded: number; exhausted: boolean }> => new Promise(resolve => {
    const poll = () => {
      const loaded = sample();
      const now = Date.now();
      if (loaded > 0) {
        resolve({ loaded, exhausted: false });
        return;
      }
      if (now - lastChangedAt >= ADVANCE_EXHAUSTION_STABILITY_MS) {
        resolve({ loaded: 0, exhausted: true });
        return;
      }
      if (now - startedAt >= ADVANCE_EXHAUSTION_TIMEOUT_MS) {
        resolve({ loaded: 0, exhausted: false });
        return;
      }
      timer = setTimeout(poll, ADVANCE_EXHAUSTION_POLL_MS);
    };
    poll();
  });

  return { sample, touch, wait, stop };
}

/**
 * 推进到下一批：给已处理的帖子打上不可见标记 → 拟人滚动触发懒加载 → 等新帖子出现。
 * 返回新加载出的待采条数；为 0 表示已经到底（批量采集据此收尾）。
 */
async function advanceList(): Promise<{
  collapsed: number;
  loaded: number;
  /** true 表示有界窗口内仍有状态变化，不能把 loaded=0 当作“已经到底”。 */
  uncertain?: boolean;
  /** 滚动实况，写进运行记录：到底滚的哪个元素、滚了多少、帖子数变没变。 */
  scroll?: string;
}> {
  const collapsed = markProcessed();
  // 节点可能在上一轮打标后被虚拟列表原地换成新帖；滚动和计数前先解除过期标记。
  reconcileProcessedMarks();
  const exhaustion = trackAdvanceExhaustion();
  const before = document.querySelectorAll('.topic-container').length;
  const trace: string[] = [];
  try {
    // **先回到上一批的末尾**再往下滚。页面很长（40 条帖子几万像素），
    // 从视口当前位置滚几千像素根本到不了底，懒加载永远不触发。
    if (scrollToFrontier()) {
      trace.push('先回到上一批采到的最后一条');
      exhaustion.touch();
    }
    await humanPause(400, 800);

    // 「到底」才是懒加载真正会触发的地方。滚动阶段一旦看见待采节点立即返回；
    // 没看见也不能就地判停，下面还要完成连续 24 秒的耗尽证明。
    for (let round = 0; round < 2; round += 1) {
      const { host, moved, bottom } = await scrollLikeHuman().catch(
        () => ({ host: '(滚动失败)', moved: 0, bottom: false }),
      );
      // scrollLikeHuman 最后一小步可能刚发出懒加载请求；24 秒必须从这次触发完成后算，
      // 不能把前面拟人滚动消耗的时间偷算进“无变化”窗口。
      exhaustion.touch();
      await humanPause(900, 1_800);
      const after = document.querySelectorAll('.topic-container').length;
      const loaded = exhaustion.sample();
      trace.push(
        `第${round + 1}次滚动：目标 ${host}，位移 ${moved}px，`
        + `${bottom ? '已到底' : '未到底'}，帖子 ${before}→${after}，待采 ${loaded}`,
      );
      if (loaded > 0) return { collapsed, loaded, scroll: trace.join('；') };
      if (bottom) {
        trace.push('已到底，继续观察懒加载与身份状态');
        break;
      }
      if (moved === 0) {
        trace.push('推不动任何元素，继续观察是否有延迟内容');
        break;
      }
    }

    const terminal = await exhaustion.wait();
    if (terminal.loaded > 0) {
      trace.push(`稳定观察期内等到新内容：待采 ${terminal.loaded}`);
      return { collapsed, loaded: terminal.loaded, scroll: trace.join('；') };
    }
    if (!terminal.exhausted) {
      trace.push('44.5 秒有界观察内列表状态仍在变化，耗尽尚未证明');
      return { collapsed, loaded: 0, uncertain: true, scroll: trace.join('；') };
    }
    trace.push('最后一次列表/身份/标记变化后连续稳定 24 秒，本页确认采完');
    return { collapsed, loaded: 0, scroll: trace.join('；') };
  } finally {
    exhaustion.stop();
  }
}

/**
 * 分类标签栏（最新 / 精华 / 只看星主 / 问答…）。真实结构见诊断样本：
 * `<app-menu><div class="menu-container"><div class="item ng-star-inserted actived">精华</div>…`
 */
const MENU_ITEM = '.menu-container .item';
// Edge 的知识星球冷启动会先进入通用壳页，真实 group SPA/分类栏在慢机器上可能
// 30 秒后才挂载。这里仍保持有界等待，但不能早于浏览器实际冷启动窗口失败。
const PLAN_MENU_RENDER_TIMEOUT_MS = 45_000;
const MENU_ACTIVE = 'actived';

function menuLabels(): { labels: string[]; active?: string } {
  const items = [...document.querySelectorAll<HTMLElement>(MENU_ITEM)];
  const labels = items.map(item => (item.textContent ?? '').trim()).filter(Boolean);
  const active = items.find(item => item.classList.contains(MENU_ACTIVE));
  return { labels, ...(active ? { active: (active.textContent ?? '').trim() } : {}) };
}

function isPublicJoinPage(): boolean {
  if (document.querySelector('.topic-container')) return false;
  const hasJoinControl = [...document.querySelectorAll<HTMLElement>('button, a, [role="button"]')]
    .some(element => (element.textContent ?? '').trim() === '加入星球');
  return hasJoinControl && (document.body.textContent ?? '').includes('星球介绍');
}

function zsxqAduid(): string {
  const key = 'XAduid';
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(key, created);
    return created;
  } catch {
    // The site app uses the same per-browser pseudonymous ID. If storage is unavailable, a
    // request-scoped value still lets the API return an explicit auth/error result safely.
    return crypto.randomUUID();
  }
}

/** 按文案重新查找并点击：Angular 切换分类时会重建这些节点，旧引用点不动。 */
function clickMenu(label: string): boolean {
  const target = [...document.querySelectorAll<HTMLElement>(MENU_ITEM)]
    .find(item => (item.textContent ?? '').trim() === label);
  if (!target) return false;
  target.click();
  return true;
}

function observeDocumentUntil<T>(
  read: () => T | undefined,
  timeoutMs: number,
  timeoutError: () => Error,
): Promise<T> {
  const initial = read();
  if (initial !== undefined) return Promise.resolve(initial);
  return new Promise<T>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => {
      const value = read();
      if (value === undefined) return;
      observer.disconnect();
      if (timeout !== undefined) clearTimeout(timeout);
      resolve(value);
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'data-topic-id'],
    });
    // 只作异常布局的最终诊断；正常路径由 DOM 变化直接唤醒，不依赖后台页计时器。
    timeout = setTimeout(() => {
      observer.disconnect();
      reject(timeoutError());
    }, timeoutMs);
  });
}

async function waitForMenu(label: ZsxqPlanView): Promise<void> {
  await observeDocumentUntil(
    () => menuLabels().labels.includes(label) ? true : undefined,
    PLAN_MENU_RENDER_TIMEOUT_MS,
    () => {
      if (isPublicJoinPage()) {
        return new ExtractionError(
          'AUTH_REQUIRED',
          '知识星球当前显示“加入星球”公开介绍页；请在 Edge 中恢复该星球的成员访问后重试',
        );
      }
      const observed = menuLabels().labels;
      const detail = observed.length > 0 ? `（当前看到：${observed.join('、')}）` : '（分类栏尚未渲染）';
      return new ExtractionError('UNSUPPORTED_LAYOUT', `页面上找不到「${label}」标签${detail}`);
    },
  );
}

function visibleTopicIds(): string[] {
  const ids = new Set<string>();
  for (const container of document.querySelectorAll<HTMLElement>('.topic-container')) {
    const direct = container.dataset.topicId;
    if (direct) ids.add(direct);
    const linked = container.querySelector<HTMLAnchorElement>('a[href*="/topic/"]')
      ?.getAttribute('href')?.match(/\/topic\/(\d+)/)?.[1];
    if (linked) ids.add(linked);
  }
  return [...ids].sort();
}

/**
 * 真实知识星球 DOM 不暴露帖子号；视图是否换批要看节点正文，而不是 topic id。
 * 只取前 20 条，但每条同时记录归一化长度、开头与尾部。SPA 通常只在末尾追加正文；
 * 若只看前 240 字，尾部持续增长也会被误判成“已稳定”。长度+尾部能让稳定计时正确重置。
 */
function visibleTopicSignature(): string {
  const topics = [...document.querySelectorAll<HTMLElement>('.topic-container')]
    .filter(topic => !topic.querySelector('app-menu, .menu-container'))
    .slice(0, 20);
  return `${topics.length}:` + topics
    .map((topic, index) => {
      const text = (topic.textContent ?? '').replace(/\s+/g, ' ').trim();
      const identity = topic.dataset.topicId ?? topic.getAttribute(KEY_ATTRIBUTE) ?? String(index);
      return `${identity}:${text.length}:${text.slice(0, 120)}:${text.slice(-240)}`;
    })
    .join('\n---\n');
}

function stablePlanView(
  label: ZsxqPlanView,
  previousSignature?: string,
  timeoutMs = 40_000,
  stabilityMs = 24_000,
): Promise<{ label: ZsxqPlanView; topicIds: string[] }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let lastSignature: string | undefined;
    let changedAt = started;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => check());
    const cleanup = () => {
      observer.disconnect();
      if (timer !== undefined) clearTimeout(timer);
    };
    const check = () => {
      const active = menuLabels().active === label;
      const signature = visibleTopicSignature();
      const visibleTopics = [...document.querySelectorAll<HTMLElement>('.topic-container')]
        .filter(topic => !topic.querySelector('app-menu, .menu-container'));
      const allBodiesReady = visibleTopics.length > 0 && visibleTopics.every(topic => {
        const body = topic.querySelector(
          '.talk-content-container, .article-content-container, .q-content-container, .answer-content-container',
        );
        return body !== null && (body.textContent ?? '').trim().length > 0;
      });
      const ready = active
        && allBodiesReady
        && (previousSignature === undefined || signature !== previousSignature);
      if (!ready) {
        lastSignature = undefined;
        changedAt = Date.now();
      } else if (signature !== lastSignature) {
        lastSignature = signature;
        changedAt = Date.now();
      } else if (Date.now() - changedAt >= stabilityMs) {
        cleanup();
        resolve({ label, topicIds: visibleTopicIds() });
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        cleanup();
        reject(new ExtractionError(
          'CONTENT_EMPTY',
          `「${label}」视图的帖子正文未在 ${Math.round(timeoutMs / 1_000)} 秒内稳定渲染`,
        ));
        return;
      }
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(check, 250);
    };
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'data-topic-id'],
    });
    check();
  });
}

/** 精确切换固定视图，并由 Angular 的 DOM 变化确认激活态与帖子集合已经更新。 */
async function selectPlanView(label: ZsxqPlanView): Promise<{ label: ZsxqPlanView; topicIds: string[] }> {
  if (!ZSXQ_PLAN_VIEWS.includes(label)) {
    throw new ExtractionError('UNSUPPORTED_LAYOUT', `不支持的知识星球视图：${label}`);
  }
  await waitForMenu(label);
  const before = visibleTopicSignature();
  const alreadyActive = menuLabels().active === label;
  if (!alreadyActive && !clickMenu(label)) {
    throw new ExtractionError('UNSUPPORTED_LAYOUT', `页面上找不到「${label}」标签`);
  }
  return stablePlanView(label, alreadyActive ? undefined : before);
}

/**
 * 让站点重新请求一次列表，好让主世界钩子截到帖子号。
 *
 * 帖子号只存在于接口响应里。页面若是更早之前加载好的（内容都在，滚动也带不出新请求），
 * 那次响应早就错过了，光重试永远没用——这正是「已捕获 0 个」最常见的成因。
 *
 * 做法是**切走分类再切回来**：这是用户本来就得手动做的那一步，由插件代劳。
 * 绝不用刷新页面代替：刷新会把「精华」退回「最新」，采到的就不是用户要的内容。
 * 无论中途出什么岔子，都必须切回原来的分类。
 */
async function refreshTopicFeed(): Promise<{ toggled: boolean; category?: string }> {
  const { labels, active } = menuLabels();
  if (!active) return { toggled: false };
  const other = labels.find(label => label !== active);
  if (!other) return { toggled: false };
  try {
    if (!clickMenu(other)) return { toggled: false };
    await humanPause(700, 1_200);
    return { toggled: true, category: active };
  } finally {
    // 必须回到用户原来所在的分类，否则等于替他换了内容。
    clickMenu(active);
    await humanPause(900, 1_500);
  }
}

/**
 * 单条帖子的「为什么没对上号」证据包。
 *
 * 整页诊断给的是页面结构，回答不了「这一条到底差在哪」。用户点某条跳过的帖子时
 * 复制这份，把页面文本和接口原文摆在一起——不猜，看证据。
 */
async function itemDiagnostics(key: string): Promise<string> {
  const hook = await requestHookStats();
  const container = [...document.querySelectorAll(`[${KEY_ATTRIBUTE}]`)]
    .find(node => node.getAttribute(KEY_ATTRIBUTE) === key);
  if (!container) {
    return JSON.stringify(
      { note: '这一条已经不在页面上了（站点可能已回收该节点）', key, url: location.href, hook },
      null,
      2,
    );
  }
  const body = listBodyText(container);
  return JSON.stringify(
    {
      hook,
      diagnosticsVersion: 8,
      kind: 'item',
      // 构建版本随证据一起走：不然还得先花一轮确认用户跑的是哪一版。
      build: typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : '开发构建',
      url: location.href,
      key,
      // 页面上有多少条 vs 截到多少个帖子号。两者差距很大 = 接口那边压根没给全，
      // 差距不大却对不上 = 文本对号的问题。先看这两个数再看下面的候选。
      pageTopics: document.querySelectorAll('.topic-container').length,
      capturedTopics: topics.size,
      matched: Boolean(topics.find(body)),
      pageText: body.replace(/\s+/g, ' ').slice(0, 400),
      ...topics.diagnose(body),
    },
    null,
    2,
  );
}

/**
 * 诊断样本：帖子拿不到各自链接时，把页面结构导出来供适配排查。
 *
 * 取样必须挑**没被处理过**的帖子：站点可能已经回收了旧节点里的内容，
 * 拿它取样会得出「页面里什么都没有」的错误结论。
 */
async function listDiagnostics(): Promise<string> {
  const hook = await requestHookStats();
  const all = [...document.querySelectorAll('.topic-container')];
  // 取样必须挑一条**真帖子**：页面上分类标签栏（最新 / 精华 / …）也裹在 .topic-container 里，
  // 它排在最前面，按「第一个有文字的」去取就永远取到它——导出来的结构样本是那排菜单，
  // 真正要看的帖子结构一个字都看不到（已经因此空跑过一轮）。
  const looksLikePost = (node: Element) =>
    !node.querySelector('app-menu') && listBodyText(node).trim().length >= 20;
  const container =
    all.find(node => !node.hasAttribute(COLLECTED_ATTRIBUTE) && looksLikePost(node))
    ?? all.find(looksLikePost)
    ?? all.find(node => node.textContent?.trim())
    ?? all[0];
  if (!container) {
    return JSON.stringify(
      { url: location.href, note: '本页没有找到 .topic-container', hook },
      null,
      2,
    );
  }
  const attributes = (element: Element) =>
    element
      .getAttributeNames()
      .map(name => [name, (element.getAttribute(name) ?? '').slice(0, 160)] as const)
      .filter(([, value]) => value !== '');
  const ancestors: unknown[] = [];
  for (let node = container.parentElement, depth = 0; node && depth < 4; node = node.parentElement) {
    ancestors.push({ tag: node.tagName, class: node.className, attrs: attributes(node) });
    depth += 1;
  }
  const descendants = [...container.querySelectorAll('*')];
  // 长数字串（15 位以上）最像帖子号：不限定属性名，也不只看取样那一条——
  // 帖子号可能只出现在某些条目上，只扫一条容易得出「哪儿都没有」的错误结论。
  const longNumbers: unknown[] = [];
  for (const topic of all.slice(0, 5)) {
    for (const element of [topic, ...topic.querySelectorAll('*')]) {
      for (const [name, value] of attributes(element)) {
        if (/\b\d{15,25}\b/.test(value)) {
          longNumbers.push({ class: String(element.className).slice(0, 60), name, value });
        }
      }
    }
  }
  return JSON.stringify(
    {
      // 版本号：贴回来的样本能一眼看出跑的是哪一版插件，不用靠字段有无去猜。
      diagnosticsVersion: 8,
      build: typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : '开发构建',
      // 主世界钩子的运行统计。「已捕获 0 个」时**先看这一栏**：
      // installed=false → 钩子没跑；observed=0 → 页面这段时间没发请求；
      // jsonResponses>0 而 withTopicId=0 → 接口结构变了。
      hook,
      url: location.href,
      topicCount: all.length,
      // 为 0 说明一次接口响应都没捕获到——帖子号无从谈起，先滚动一屏或切一次分类。
      capturedTopics: topics.size,
      // 成对样本：接口那边归一化后是什么样、页面这边又是什么样。
      // 「对不上号」的排查全靠这两栏摆在一起看，只报一个总数根本定位不了。
      capturedSamples: topics.samples(4),
      // 分类标签栏：自动「切走再切回」这一步能不能做，取决于这里找不找得到。
      menu: menuLabels(),
      pageSamples: all.slice(0, 4).map(node => ({
        matched: Boolean(topics.find(listBodyText(node))),
        text: listBodyText(node).replace(/\s+/g, '').slice(0, 60),
      })),
      sampledCollapsed: container.hasAttribute(COLLECTED_ATTRIBUTE),
      /*
       * 全页外链普查：「精华里到底有多少广告」这个问题，一份报告就能答完。
       *
       * 按域名归并、标出哪些带带货信号（CPS 分销路径 / 电商商品页 / 分销参数）。
       * 只看被跳过的那几条不够——没被跳过的帖子里挂了什么链接，同样要看得见。
       */
      outboundHosts: (() => {
        const census = new Map<string, { count: number; signals: string[]; sample: string }>();
        for (const node of all) {
          for (const anchor of node.querySelectorAll('a[href]')) {
            const href = anchor.getAttribute('href') ?? '';
            if (!/^https?:/i.test(href)) continue;
            let host: string;
            try {
              host = new URL(href).hostname;
            } catch {
              continue;
            }
            const entry = census.get(host)
              ?? { count: 0, signals: commercialSignals(href), sample: href.slice(0, 120) };
            entry.count += 1;
            census.set(host, entry);
          }
        }
        return [...census.entries()]
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 12)
          .map(([host, info]) => ({
            host,
            count: info.count,
            commercial: info.signals.length > 0,
            ...(info.signals.length > 0 ? { signals: info.signals, sample: info.sample } : {}),
          }));
      })(),
      /*
       * 作者名到底挂在哪个元素上。
       *
       * 入库的 author 一直是「Simon、Todd、Fisheep…」这串点赞/已读的人名，
       * 而 htmlHead 被帖子上那张 base64 水印图整段吃掉，看不到作者那块的结构。
       * 这里把所有像作者名的元素连同它在容器里的位置摆出来，直接定位该用哪个选择器。
       */
      authorCandidates: [...container.querySelectorAll('[class*="name"],[class*="author"],[class*="nick"],[class*="user"]')]
        .slice(0, 10)
        .map(element => ({
          tag: element.tagName,
          class: String(element.className).slice(0, 60),
          text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
          /** 在容器全文里的起始位置：作者名应当靠最前面，点赞列表在很后面。 */
          at: (container.textContent ?? '').indexOf((element.textContent ?? '').trim().slice(0, 12)),
        })),
      /*
       * 展开控件长什么样。
       *
       * 「采到的还是截断正文」查了两轮都没查准，就是因为看不到这个控件的真实结构：
       * 文案是不是和省略号连在一起、挂在哪一层、点击响应在哪个元素上。
       * 这里把页面上所有含「展开」字样的元素原样导出来，一眼就能定位。
       */
      expandControls: [...document.querySelectorAll('*')]
        .filter(element => {
          const text = element.textContent ?? '';
          return text.length <= 40 && /展开|全文|显示全部/.test(text);
        })
        .filter((element, _index, list) => !list.some(other => other !== element && element.contains(other)))
        .slice(0, 6)
        .map(element => ({
          tag: element.tagName,
          label: JSON.stringify(element.textContent ?? ''),
          normalized: zsxqExpandLabel(element),
          matched: isZsxqExpandControl(element),
          html: element.outerHTML.slice(0, 200),
          parent: element.parentElement?.outerHTML.slice(0, 200) ?? '',
        })),
      textSample: (container.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
      anchors: [...container.querySelectorAll('a')]
        .map(anchor => anchor.getAttribute('href'))
        .slice(0, 12),
      // 有些站点把跳转挂在非 <a> 元素上。
      hrefLike: [...container.querySelectorAll('[href],[data-href],[data-url],[routerlink]')]
        .map(element => element.outerHTML.slice(0, 120))
        .slice(0, 8),
      containerAttrs: attributes(container),
      ancestors,
      longNumbers: longNumbers.slice(0, 20),
      descendantCount: descendants.length,
      // 结构本身最能说明问题；截断避免把整页正文倒出来。
      // 内联的 base64 图片要先剔掉再截断：帖子上那张水印图是 data:image/png;base64,
      // 一张就好几 KB，1200 字的预算全被它吃光，真正要看的结构一个字都露不出来。
      htmlHead: container.outerHTML
        .replace(/data:[^"')\s]{40,}/g, 'data:…(已省略)')
        .replace(/\s(style|srcset)="[^"]{120,}"/g, ' $1="…(已省略)"')
        .slice(0, 1200),
    },
    null,
    2,
  );
}

/**
 * 防重复注册：插件更新后我们会主动把这个脚本注入到已打开的标签页，
 * 而同一页可能已经声明式注入过一次——注册两个监听会对同一条消息应答两次。
 */
const READY_FLAG = '__dataCollectorContentReady';
// 刚（重）注入：先把钩子留存的帖子号要回来，否则页面上的老帖子永远对不上号。
requestReplay();

const registrationVersion = `${CONTENT_EXTRACTION_PROTOCOL}:${CONTENT_BUILD_ID}`;
const alreadyRegistered =
  (globalThis as unknown as Record<string, unknown>)[READY_FLAG] === registrationVersion;
(globalThis as unknown as Record<string, unknown>)[READY_FLAG] = registrationVersion;

if (!alreadyRegistered) chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const request = message as Partial<ExtractMessage>;
  const currentRequest = isCurrentContentRequest(request.type);
  if (
    request.type !== 'extract.document' &&
    request.type !== 'extract.list' &&
    request.type !== 'list.advance' &&
    request.type !== 'list.diagnose' &&
    request.type !== 'list.restore' &&
    request.type !== 'list.highlight' &&
    request.type !== 'list.itemDiagnose' &&
    request.type !== 'list.hookStats' &&
    request.type !== 'list.refreshTopics' &&
    request.type !== 'list.focusLast' &&
    request.type !== 'list.selectView' &&
    request.type !== 'list.apiCollect' &&
    !currentRequest
  ) {
    return false;
  }

  const respond = (response: Record<string, unknown>): void => {
    sendResponse(currentRequest
      ? {
          ...response,
          contentProtocol: CONTENT_EXTRACTION_PROTOCOL,
          contentBuildId: CONTENT_BUILD_ID,
        }
      : response);
  };

  if (request.type === 'list.apiCollect' || request.type === CONTENT_API_COLLECT_REQUEST) {
    const groupId = /\/group\/(\d+)/u.exec(location.pathname)?.[1];
    if (!groupId) {
      respond({
        ok: false,
        error: { code: 'UNSUPPORTED_LAYOUT', message: 'ZSXQ_API_FALLBACK_FAILED：当前地址没有星球编号' },
      });
      return false;
    }
    void collectZsxqApiViews(groupId, { aduid: zsxqAduid() }).then(
      apiCollection => respond({ ok: true, apiCollection }),
      error => {
        const message = error instanceof Error ? error.message : '知识星球接口兜底采集失败';
        respond({
          ok: false,
          error: {
            code: message.startsWith('AUTH_REQUIRED')
              ? 'AUTH_REQUIRED'
              : message.startsWith('AUTHOR_IDENTITY_UNPROVEN')
                ? 'AUTHOR_IDENTITY_UNPROVEN'
                : 'COLLECTION_FAILED',
            message,
          },
        });
      },
    );
    return true;
  }

  if (request.type === 'list.selectView' || request.type === CONTENT_SELECT_VIEW_REQUEST) {
    const label = request.label;
    if (!label || !ZSXQ_PLAN_VIEWS.includes(label)) {
      respond({ ok: false, error: { code: 'UNSUPPORTED_LAYOUT', message: '知识星球视图无效' } });
      return false;
    }
    void selectPlanView(label).then(
      selected => respond({ ok: true, selected }),
      error => respond({
        ok: false,
        error: {
          code: error instanceof ExtractionError ? error.code : 'COLLECTION_FAILED',
          message: error instanceof Error ? error.message : '切换知识星球视图失败',
        },
      }),
    );
    return true;
  }

  if (request.type === 'list.refreshTopics' || request.type === CONTENT_REFRESH_TOPICS_REQUEST) {
    void refreshTopicFeed().then(
      refresh => respond({ ok: true, refresh }),
      () => respond({ ok: true, refresh: { toggled: false } }),
    );
    return true;
  }

  if (request.type === 'list.hookStats' || request.type === CONTENT_HOOK_STATS_REQUEST) {
    void requestHookStats().then(hook => respond({ ok: true, hook }));
    return true;
  }

  if (request.type === 'list.itemDiagnose' || request.type === CONTENT_ITEM_DIAGNOSE_REQUEST) {
    void itemDiagnostics(String(request.key ?? '')).then(diagnostics =>
      respond({ ok: true, diagnostics }),
    );
    return true;
  }

  if (request.type === 'list.diagnose' || request.type === CONTENT_DIAGNOSE_REQUEST) {
    void listDiagnostics().then(diagnostics => respond({ ok: true, diagnostics }));
    return true;
  }

  if (request.type === 'list.focusLast' || request.type === CONTENT_FOCUS_LAST_REQUEST) {
    // 批量结束后把视口停在采到的最后一条上，用户一眼看到进度到哪儿了。
    respond({ ok: true, highlight: { found: scrollToFrontier() } });
    return false;
  }

  if (request.type === 'list.restore' || request.type === CONTENT_RESTORE_REQUEST) {
    // mark=true 是反过来用：把本屏**标记为已处理**（采够目标条数收工时用），
    // 否则「继续采下一批」上来滚一下就又把同一屏提取一遍，永远原地打转。
    const marked = (request as { mark?: boolean }).mark === true;
    respond({ ok: true, advance: { collapsed: marked ? markProcessed() : clearMarks(), loaded: 0 } });
    return false;
  }

  if (request.type === 'list.highlight' || request.type === CONTENT_HIGHLIGHT_REQUEST) {
    respond({ ok: true, highlight: highlightEntry(String(request.key ?? '')) });
    return false;
  }

  if (request.type === 'list.advance' || request.type === CONTENT_ADVANCE_REQUEST) {
    void advanceList().then(
      result => respond({ ok: true, advance: result }),
      error =>
        respond({
          ok: false,
          error: {
            code: 'COLLECTION_FAILED',
            message: error instanceof Error ? error.message : '翻页失败',
          },
        }),
    );
    return true;
  }

  const wantsList = request.type === 'extract.list' || request.type === CONTENT_LIST_REQUEST;
  const sendExtractionResponse = (response: Record<string, unknown>): void => {
    respond(response);
  };

  const run = (
    expansionValidation: ExpansionValidation = {
      unconfirmedOwners: new Map(),
      confirmedOwners: new Set(),
      failClosedAll: false,
    },
  ): void => {
    try {
      const { unconfirmedOwners, confirmedOwners, failClosedAll } = expansionValidation;
      for (const owner of unconfirmedOwners.keys()) confirmedExpansionProofs.delete(owner);
      for (const owner of confirmedOwners) {
        // 同 owner 可能有问/答多个探针；任一个 pending 都不能让其它探针代表整帖。
        if (!unconfirmedOwners.has(owner)) rememberConfirmedExpansion(owner);
      }
      if (wantsList) {
        // extractList 自身会按 data-dc-collected 排除节点；先解除虚拟列表遗留的旧帖标记，
        // 否则新帖连“待补 topic id”的 retryable 结果都没有机会产生。
        reconcileProcessedMarks();
        const { entries, skipped, total } = extractList(document, location.href, topics);
        // 节点留在内容脚本里（无法跨消息边界传递），等 list.advance 时统一打标记。
        // 骨架屏、短暂空正文、尚未取得 topic id 都可能在下一刻自愈；这类节点若现在
        // 打上“已处理”，后续正文即使渲染完成也永远不会再提取。只标记已经得到终局判定的条目。
        lastListContainers = entries.flatMap(entry => {
          if (entry.retryable === true) return [];
          const topicId = entryTopicId(entry);
          const revision = semanticContentRevision(entry.container);
          // 没有可证明 topic id 或语义内容就不能制造永久标记；纯图片帖以正文块资产修订绑定。
          return topicId && revision ? [{ container: entry.container, topicId, revision }] : [];
        });
        console.info(
          `[data-collector] 本轮提取：待采 ${total} 条，可入库 ${total - skipped} 条，`
          + `跳过 ${skipped} 条，已捕获帖子号 ${topics.size} 个`,
        );
        sendExtractionResponse({
          ok: true,
          list: {
            // 捕获到的帖子号条数一并回报：为 0 时失败原因要说得具体，不能只说「适配问题」。
            captured: topics.size,
            skipped,
            total,
            items: entries.map(entry => {
              const baseline = unconfirmedOwners.get(entry.container);
              const extracted = entry.document;
              // pending 表示在完整稳定窗口内始终没有得到完成证明；哪怕正文比点击前
              // 长了一点也可能只是流式首段，不能用“有增长”洗掉这个正向风险证据。
              const safeDocument = extracted && (failClosedAll || baseline !== undefined)
                ? withUnconfirmedExpansion(extracted)
                : extracted && hasConfirmedExpansion(entry.container)
                  ? withConfirmedExpansion(extracted)
                  : extracted;
              return {
                key: entry.key,
                observationId: contentObservationId(entry.container),
                title: entry.title,
                ...(safeDocument ? { document: safeDocument } : {}),
                ...(entry.reason ? { reason: entry.reason } : {}),
                ...(!safeDocument
                  ? {
                      // 业务排除只有在规范 URL 已证明时才可审计放行；缺 URL 一律是覆盖风险。
                      skipKind: entry.retryable === true || !entry.url
                        ? 'coverage-risk'
                        : 'business-filter',
                    }
                  : {}),
                ...(entry.url ? { url: entry.url } : {}),
              };
            }),
          },
        });
        return;
      }
      const detailOwner = detailExpansionOwner();
      const expansionConfirmed = hasConfirmedExpansion(detailOwner);
      const extracted = extractDocument(
        document,
        location.href,
        undefined,
        topics,
        currentRequest && !expansionConfirmed,
      );
      const baseline = unconfirmedOwners.get(detailOwner);
      const expansionSafe = failClosedAll || baseline !== undefined
        ? withUnconfirmedExpansion(extracted)
        : expansionConfirmed ? withConfirmedExpansion(extracted) : extracted;
      const result: CollectedDocument = {
        ...expansionSafe,
        ...(request.overrides?.userCategory
          ? { userCategory: request.overrides.userCategory }
          : {}),
        ...(request.overrides?.userTags ? { userTags: request.overrides.userTags } : {}),
      };
      sendExtractionResponse({ ok: true, document: result });
    } catch (error) {
      sendExtractionResponse({
        ok: false,
        error: {
          code: error instanceof ExtractionError ? error.code : 'COLLECTION_FAILED',
          message: error instanceof Error ? error.message : '页面采集失败',
        },
      });
    }
  };

  // 展开后要观察到正文实际增长并稳定；控件消失但正文没长，必须按截断拒绝。
  pruneConfirmedExpansionProofs();
  const expansionProbes = expandCollapsedContent(wantsList ? 40 : 20);
  if (expansionProbes.length > 0) {
    void waitForExpandedContent(expansionProbes).then(run);
    return true;
  }
  run();
  return false;
});
