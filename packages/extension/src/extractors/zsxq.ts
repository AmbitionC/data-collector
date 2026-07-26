import { isListPage } from '@data-collector/shared';
import type { TopicIndex } from '../topicIndex.js';
import { excludedBy } from '../topicFilter.js';
import { buildDocument, cleanText, elementText, parsePublishedAt } from './common.js';
import { ExtractionError, type Clock } from './types.js';

const LOGIN_SELECTORS = [
  '.login-container',
  '.login-page',
  'app-login',
  'form[action*="login"]',
];

/** 真实 DOM（Angular）：每条帖子是一个 .topic-container；详情页只有一个，列表页有多个。 */
const TOPIC_CONTAINER = '.topic-container';

/**
 * 已处理过的帖子标记。只是个不可见的属性——**绝不改变页面外观**：
 * 用户要肉眼核对采到的内容对不对，把帖子藏起来会直接妨碍验证。
 * 加载下一批靠的是滚动到底触发站点自己的懒加载，不需要靠隐藏来压缩页面高度。
 */
export const COLLECTED_ATTRIBUTE = 'data-dc-collected';

/** 稳定标识：贴在节点上，供侧栏点击某条时滚回页面并高亮它。 */
export const KEY_ATTRIBUTE = 'data-dc-key';

/**
 * `.topic-container` 不全是帖子：分类标签栏（最新 / 精华 / 只看星主…）也用同一个类名，
 * 里面装的是 <app-menu>。不排掉的话它会被当成一篇「帖子」参与统计甚至入库。
 */
function isPost(container: Element): boolean {
  return !container.querySelector('app-menu, .menu-container');
}

/** 尚未采集的帖子节点（已打标记的跳过，避免同一条重复入库）。 */
function pendingContainers(document: Document): Element[] {
  return [
    ...document.querySelectorAll(`${TOPIC_CONTAINER}:not([${COLLECTED_ATTRIBUTE}])`),
  ].filter(isPost);
}

/** 剩余待采条数：批量采集用它判断滚动之后有没有加载出新内容。 */
export function pendingTopicCount(document: Document): number {
  return pendingContainers(document).length;
}

/** 正文容器（按可靠性排序）。评论区在 .topic-container 内、正文容器外，取正文容器可天然排除评论。 */
const CONTENT_SELECTORS = [
  '.talk-content-container',
  '.article-content-container',
  '.q-content-container',
  '.content',
];

const AUTHOR_SELECTORS = ['.author-name', '.user-name', '.name', '.nickname'];
const TIME_SELECTORS = ['time', '.create-time', '.time', '[class*="create-time"]'];

function firstWithin(root: ParentNode, selectors: string[]): Element | null {
  for (const selector of selectors) {
    const element = root.querySelector(selector);
    if (element) return element;
  }
  return null;
}

/** 详情页地址形如 /group/<群号>/topic/<帖子号>；列表/分类/精华页没有 /topic/ 段。 */
export function isTopicDetail(url: URL): boolean {
  return !isListPage(url);
}

/**
 * 星球动态多数没有标题。用正文首句兜底，保证归档条目有可读标题
 * （站点 <title> 恒为「<星球名>-知识星球」，不能当文章标题用）。
 */
function deriveTitle(content: Element, document: Document): string {
  const explicit = elementText(firstWithin(content, ['h1', 'h2', '.title', '[class*="title"]']));
  if (explicit) return explicit.slice(0, 80);
  const body = elementText(content);
  if (body) {
    const firstSentence = body
      .split(/[。！？!?\n]/)
      .map(part => cleanText(part))
      .find(part => part.length >= 4);
    return (firstSentence ?? body).slice(0, 60);
  }
  return cleanText(document.title);
}

/**
 * 从列表页的一条帖子节点里找出它自己的详情 URL。
 *
 * 列表页批量采集必须拿到**每条帖子各自的 URL** —— 稳定内容 ID 由规范 URL 派生，
 * 若都用列表页 URL，21 条帖子会算出同一个 ID 而相互覆盖，最后只剩 1 条。
 *
 * 实测这个站点的 DOM 上**没有**帖子号：没有 <a>、没有 data-*、整棵子树找不到长数字。
 * 因此主要来源是 topicIndex（旁观应用自己的接口响应得到的「正文 → 帖子号」对照表）；
 * DOM 上的链接/属性仍然照查一遍，将来页面结构变了也能直接用上。
 */
export function topicUrlOf(
  container: Element,
  pageUrl: URL,
  topics?: TopicIndex,
  /** 正文文本（不含作者名等外围文案），用来和接口响应对号；缺省用整个节点的文本。 */
  bodyText?: string,
): URL | undefined {
  const link = container.querySelector<HTMLAnchorElement>('a[href*="/topic/"]');
  const href = link?.getAttribute('href');
  if (href) {
    try {
      const resolved = new URL(href, pageUrl);
      if (isTopicDetail(resolved)) return resolved;
    } catch {
      // 继续尝试其它策略。
    }
  }

  const groupId = pageUrl.pathname.match(/\/group\/(\d+)/)?.[1];
  if (!groupId) return undefined;

  // 兜底：万一哪天页面把 id 放回了 DOM（长数字串最像帖子号）。
  const candidates = [container, ...container.querySelectorAll('*')];
  for (const element of candidates.slice(0, 200)) {
    for (const attribute of element.getAttributeNames()) {
      if (!/^(id|data-|ng-reflect-)/.test(attribute)) continue;
      const topicId = (element.getAttribute(attribute) ?? '').match(/\b(\d{15,25})\b/)?.[1];
      if (topicId) return new URL(`/group/${groupId}/topic/${topicId}`, pageUrl);
    }
  }

  // 主路径：用正文把这条帖子对回接口响应里的 topic_id。
  const fromIndex = topics?.find(bodyText ?? container.textContent ?? '');
  return fromIndex ? new URL(`/group/${groupId}/topic/${fromIndex}`, pageUrl) : undefined;
}

/** 本轮看到的一条帖子：能采的带上 document，不能采的带上原因。 */
export interface ListEntry {
  /** 页面节点，留在内容脚本里（无法跨消息边界传递）。 */
  container: Element;
  /** 稳定标识，侧栏用它点回页面上的这一条。 */
  key: string;
  /** 列表里显示用的标题（正文首句）。 */
  title: string;
  document?: ReturnType<typeof buildDocument>;
  /** 无法采集的原因，如实展示给用户。 */
  reason?: string;
}

export interface ListExtraction {
  entries: ListEntry[];
  /** 无法确定各自 URL 而被跳过的条数（用于如实告知用户，而不是静默少采）。 */
  skipped: number;
  total: number;
}

/**
 * 列表 / 精华页批量提取：把每个 .topic-container 当作独立一篇。
 * 只返回能确定自身 URL 的条目，其余计入 skipped。
 */
export function extractZsxqList(
  document: Document,
  url: URL,
  now: Clock,
  topics?: TopicIndex,
): ListExtraction {
  const containers = pendingContainers(document);
  const entries: ListEntry[] = [];
  let skipped = 0;

  for (const [index, container] of containers.entries()) {
    // 稳定 key：第一次见到就贴上，之后一直跟着这个节点走。
    let key = container.getAttribute(KEY_ATTRIBUTE);
    if (!key) {
      key = `t${now()}-${index}`;
      container.setAttribute(KEY_ATTRIBUTE, key);
    }
    const content = firstWithin(container, CONTENT_SELECTORS) ?? container;
    const text = elementText(content);
    const title = deriveTitle(content, document);
    // 用正文（而不是整个节点）去对号：整个节点还带着作者名、时间、点赞数这些外围文案。
    const topicUrl = topicUrlOf(container, url, topics, text);
    if (!text || text.length < 20) {
      skipped += 1;
      entries.push({ container, key, title: title || '（空内容）', reason: '正文太短或为空' });
      continue;
    }
    // 选题过滤：用户明确不看的类别（如打新）不入库，但**照样出现在明细里**，
    // 状态是已跳过、原因写明类别——绝不静默丢弃。
    const excluded = excludedBy(text);
    if (excluded) {
      skipped += 1;
      entries.push({ container, key, title, reason: `${excluded.label}（按选题偏好跳过）` });
      continue;
    }
    if (!topicUrl) {
      skipped += 1;
      entries.push({ container, key, title, reason: '没能对上帖子号，无法确定它自己的地址' });
      continue;
    }
    const time = firstWithin(container, TIME_SELECTORS);
    const author = elementText(firstWithin(container, AUTHOR_SELECTORS));
    const publishedAt = parsePublishedAt(elementText(time), time?.getAttribute('datetime'));
    entries.push({
      container,
      key,
      title,
      document: buildDocument({
        source: 'zsxq',
        kind: 'post',
        title,
        content,
        url: topicUrl,
        now,
        ...(author ? { author } : {}),
        ...(publishedAt ? { publishedAt } : {}),
      }),
    });
  }
  return { entries, skipped, total: containers.length };
}

export function extractZsxq(document: Document, url: URL, now: Clock) {
  if (LOGIN_SELECTORS.some(selector => document.querySelector(selector))) {
    throw new ExtractionError('AUTH_REQUIRED', '请先登录知识星球，再打开需要保存的单条内容');
  }

  const containers = [...document.querySelectorAll(TOPIC_CONTAINER)];

  // 列表 / 分类 / 精华页：页面上有多条帖子，绝不能把整个信息流当成一篇存下来。
  // 这类页面走「批量保存」（extractZsxqList）逐条拆开入库，单页保存在这里明确拒绝。
  if (!isTopicDetail(url)) {
    throw new ExtractionError(
      'UNSUPPORTED_LAYOUT',
      containers.length > 1
        ? `当前是列表页（本页有 ${containers.length} 条帖子）。请用「批量保存本页帖子」逐条入库，或点开单条详情页（地址形如 /topic/…）再保存。`
        : '请在知识星球中打开一篇帖子的详情页（地址形如 /topic/…）后重试',
    );
  }

  const container = containers[0] ?? document.body;
  const content = firstWithin(container, CONTENT_SELECTORS) ?? container;
  const text = elementText(content);
  if (!text || text.length < 20) {
    throw new ExtractionError(
      'CONTENT_EMPTY',
      '未读到帖子正文：请确认页面已加载完成（必要时先点开「展开全文」）后重试',
    );
  }

  const time = firstWithin(container, TIME_SELECTORS);
  const author = elementText(firstWithin(container, AUTHOR_SELECTORS));
  const publishedAt = parsePublishedAt(elementText(time), time?.getAttribute('datetime'));
  return buildDocument({
    source: 'zsxq',
    kind: 'post',
    title: deriveTitle(content, document),
    content,
    url,
    now,
    ...(author ? { author } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  });
}
