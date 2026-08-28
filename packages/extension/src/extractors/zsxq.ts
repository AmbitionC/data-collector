import { isListPage } from '@data-collector/shared';
import {
  inlineMarkupToHtml,
  normalizeForMatch,
  stripInlineMarkup,
  type TopicRecordAttachment,
  type TopicRecordImage,
  type TopicIndex,
} from '../topicIndex.js';
import { advertisementIn } from '../adFilter.js';
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
  '.answer-content-container',
];

/**
 * 作者名。**绝不放裸 `.name`**——星球上点赞列表的容器正好是 `div.name`，
 * 而 `.author-name` / `.user-name` 在这个站点根本不存在，于是每条的作者
 * 都抓成了「百事可乐、何猪猪、The bright*、…」这串点赞的人名（实测三条全中）。
 * 归档到 life-teachers 时作者是用来定博主的，抓错会直接串档。
 *
 * 真实结构（实机诊断）：
 *   <div class="author"><img class="avatar">
 *     <div class="info"><div class="role owner">陈老师</div>
 *                       <div class="date"> 2026-05-01 22:19 </div></div></div>
 */
const AUTHOR_SELECTORS = [
  '.author .role',
  '.author .name',
  '.author .nickname',
  '.author-name',
  '.user-name',
  '.nickname',
];
/** 发布时间。`.author .date` 是星球的真实位置，原先一个都没命中（只是被接口时间兜住了）。 */
const TIME_SELECTORS = [
  'time',
  '.create-time',
  '.author .date',
  '.date',
  '.time',
  '[class*="create-time"]',
];

function firstWithin(root: ParentNode, selectors: string[]): Element | null {
  for (const selector of selectors) {
    const element = root.querySelector(selector);
    if (element) return element;
  }
  return null;
}

function authorRoleOf(container: Element): 'owner' | 'member' | undefined {
  const role = container.querySelector('.author .role');
  if (!role) return undefined;
  if (role.classList.contains('owner')) return 'owner';
  if (role.classList.contains('member')) return 'member';
  return undefined;
}

function activeViewOf(document: Document): string | undefined {
  const active = document.querySelector('.menu-container .item.actived');
  const label = elementText(active);
  return label || undefined;
}

/**
 * 一条帖子里的全部正文块。
 *
 * 问答帖有**两块**（问题、回答），而且两块可能分别使用
 * `.q-content-container` 与 `.talk-content-container`。必须一次取齐所有语义选择器，
 * 再按 DOM 顺序归档；逐个选择器命中即返回会稳定丢掉其中一半。
 * 不能用裸 `.content` 兜底：评论和推荐也使用这个通用类名；没有语义容器时应 fail-closed。
 * 语义容器仍可能互相嵌套，重叠组只保留最外层，避免正文重复。
 */
function contentBlocks(container: Element): Element[] {
  const found = [...container.querySelectorAll(CONTENT_SELECTORS.join(', '))];
  // querySelectorAll(selector-list) 天然按 DOM 顺序返回；嵌套的只留最外层：
  // 语义容器嵌套时只保留最外层，避免同一段正文归档两次。
  return found.filter(node => !found.some(other => other !== node && other.contains(node)));
}

/**
 * 把多个正文块合成一个**游离**的元素供归档使用。
 *
 * 用克隆拼装，**绝不改动页面本身**：用户正在肉眼核对采到的内容。
 * 只有一块时直接返回那一块，不做无谓包装。
 */
function contentRoot(document: Document, blocks: Element[]): Element | undefined {
  if (blocks.length === 0) return undefined;
  if (blocks.length === 1) return blocks[0]!;
  const merged = document.createElement('div');
  for (const block of blocks) merged.append(block.cloneNode(true));
  return merged;
}

function sourceImageVariantUrls(image: TopicRecordImage): readonly string[] {
  return [image.url, ...(image.aliases ?? [])];
}

/**
 * 归档用的正文：页面那份被折叠截断时，用接口那份补齐。
 *
 * 这里的 apiText 已经靠 topicId / 正文匹配严格对到同一篇；因此只要接口正文更长，
 * 多出的哪怕只是短尾巴也必须采用。旧的“15% 且至少 120 字”余量会稳定丢掉
 * 1–119 字结尾，而正文容器本身并不包含赞、评论等外围文案。
 *
 * 补齐时图片要从页面那份搬过来：接口正文里图片只是占位标记，真地址在 DOM 上。
 * 全程只操作**克隆**，绝不改动页面本身——用户正在肉眼核对。
 */
export function completeContent(
  document: Document,
  domContent: Element,
  apiText: string | undefined,
  sourceCoversDom = false,
  sourceImages: readonly TopicRecordImage[] = [],
  sourceAttachments: readonly TopicRecordAttachment[] = [],
  sourceMediaProven = false,
): Element {
  const domText = elementText(domContent);
  if (apiText === undefined) return domContent;
  const apiLength = stripInlineMarkup(apiText).replace(/\s+/g, '').length;
  const domLength = domText.replace(/\s+/g, '').length;
  const apiContent = document.createElement('div');
  apiContent.innerHTML = inlineMarkupToHtml(apiText);

  for (const image of sourceImages) {
    const variants = new Set(sourceImageVariantUrls(image));
    const matching = [...apiContent.querySelectorAll<HTMLImageElement>('img[src]')]
      .filter(candidate => variants.has(candidate.src));
    const element = matching.shift() ?? document.createElement('img');
    // DOM/API 可能渲染 large/thumbnail；归档始终收敛到来源声明的最高质量 original。
    element.src = image.url;
    if (image.alt) element.alt = image.alt;
    for (const duplicate of matching) duplicate.remove();
    if (!element.parentElement) apiContent.append(element);
  }
  for (const attachment of sourceAttachments) {
    if ([...apiContent.querySelectorAll<HTMLAnchorElement>('a[href]')]
      .some(candidate => candidate.href === attachment.url)) continue;
    const element = document.createElement('a');
    element.href = attachment.url;
    element.textContent = attachment.title ?? '附件';
    apiContent.append(element);
  }

  if (sourceCoversDom || apiLength > domLength) {
    // 来源正文覆盖当前 DOM 且资源 schema 也已证明时，来源就是权威副本；绝不能再把
    // 虚拟列表上一帖残留的 DOM 图片/链接无条件粘回去。
    if (sourceCoversDom && sourceMediaProven) return apiContent;
    // 未证明媒体 schema 的兼容旧路径仍保留 DOM 资源，但上游只能标 unknown。
    for (const image of domContent.querySelectorAll('img')) {
      apiContent.append(image.cloneNode(true));
    }
    return withMissingLinkedArticleUrls(document, apiContent, domContent);
  }

  // 可见文字相等并不代表结构等价：DOM 的 web-card 可能只渲染标题、不带 href，
  // API 同一段 `<e type="web">` 却是发现并补取链接长文的唯一入口。保留较丰富 DOM，
  // 只以空导航节点补上 exact article URL，既不重复标题文字，也不丢 DOM 排版/图片。
  return withMissingLinkedArticleUrls(document, domContent, apiContent);
}

/**
 * 无 data-topic-id 的详情容器必须与 URL 对应的来源正文兼容。
 * 允许 DOM 是 API 正文的同起点首段（SPA 尚未挂尾段），但不允许 DOM 更长或无关；
 * 一旦通过，归档仍以来源正文为主，避免把上一页残留 DOM 挂到新 URL 上。
 */
function detailDomMatchesSourceBody(content: Element, sourceBody: string): boolean {
  const clone = content.cloneNode(true) as Element;
  // 提问者标签是页面渲染元信息，接口正文只含问题/回答本身；不剥掉会让合法问答
  // 永远与来源正文“不兼容”。提问者另由 questioner 字段保留。
  for (const label of clone.querySelectorAll('.question-owner')) label.remove();
  for (const candidate of clone.querySelectorAll(ZSXQ_EXPAND_CONTROL_SELECTOR)) {
    if (isZsxqBodyUiControl(candidate)) candidate.remove();
  }
  const dom = normalizeForMatch(elementText(clone), 200_000);
  const source = normalizeForMatch(sourceBody, 200_000);
  if (!dom || !source) return dom === source;
  // 完整相等本身就是精确证据，短帖不受前缀推断的最短长度限制。
  if (dom === source) return true;
  return dom.length >= 20 && source.startsWith(dom);
}

function canonicalBodyAssetUrl(value: string, base: string): string | undefined {
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

/** 当前 DOM 只能缺少尚未挂载的来源资源，不能多出来源没有的上一帖图片/链接。 */
function sourceAssetsCoverDom(
  content: Element,
  sourceBody: string,
  sourceImages: readonly TopicRecordImage[],
  sourceAttachments: readonly TopicRecordAttachment[],
): boolean {
  const base = content.ownerDocument.baseURI;
  const expected = new Set<string>();
  for (const image of sourceImages) {
    for (const variant of sourceImageVariantUrls(image)) {
      const url = canonicalBodyAssetUrl(variant, base);
      if (url) expected.add(url);
    }
  }
  for (const attachment of sourceAttachments) {
    const url = canonicalBodyAssetUrl(attachment.url, base);
    if (url) expected.add(url);
  }
  const api = content.ownerDocument.createElement('div');
  api.innerHTML = inlineMarkupToHtml(sourceBody);
  for (const candidate of api.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const url = canonicalBodyAssetUrl(candidate.getAttribute('href') ?? '', base);
    if (url) expected.add(url);
  }

  const observed: string[] = [];
  const rememberObserved = (raw: string): void => {
    if (!raw.trim()) return;
    const url = canonicalBodyAssetUrl(raw, base);
    if (url) observed.push(url);
  };
  const rememberSrcset = (raw: string): void => {
    for (const candidate of raw.split(',')) {
      const value = candidate.trim().split(/\s+/u)[0];
      if (value) rememberObserved(value);
    }
  };
  for (const image of content.querySelectorAll<HTMLImageElement>('img')) {
    const raw = image.getAttribute('data-src') ?? image.getAttribute('src') ?? '';
    rememberObserved(raw);
    rememberSrcset(image.getAttribute('srcset') ?? '');
  }
  for (const anchor of content.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    rememberObserved(anchor.getAttribute('href') ?? '');
  }
  for (const media of content.querySelectorAll<HTMLElement>(
    'video, audio, source, track, iframe, embed',
  )) {
    rememberObserved(media.getAttribute('src') ?? '');
    rememberSrcset(media.getAttribute('srcset') ?? '');
    rememberObserved(media.getAttribute('poster') ?? '');
  }
  for (const object of content.querySelectorAll<HTMLElement>('object[data]')) {
    rememberObserved(object.getAttribute('data') ?? '');
  }
  return observed.every(url => expected.has(url));
}

function linkedArticleUrlsIn(root: Element): Set<string> {
  const urls = new Set<string>();
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const normalized = normalizedLinkedArticleHref(anchor.getAttribute('href') ?? '');
    if (normalized) urls.add(normalized);
  }
  return urls;
}

function withMissingLinkedArticleUrls(
  document: Document,
  primary: Element,
  secondary: Element,
): Element {
  const present = linkedArticleUrlsIn(primary);
  const missing = [...linkedArticleUrlsIn(secondary)].filter(url => !present.has(url));
  if (missing.length === 0) return primary;
  const merged = primary.cloneNode(true) as Element;
  for (const url of missing) {
    const anchor = document.createElement('a');
    anchor.setAttribute('href', url);
    // URL 是恢复链路的结构证据；可见标题已经存在于 primary，空节点避免正文重复。
    merged.append(anchor);
  }
  return merged;
}

/**
 * 页面上的交互文案，绝不该进归档正文。
 *
 * 实测 77 条里 64 条（83%）末尾挂着「展开全部」「收起」。它们是控件的字，
 * 不是作者写的内容，下游还得再洗一遍。
 */
const UI_NOISE = /(^|\n)\s*(展开全部|展开全文|收起|阅读全文|显示全部|全文)\s*(?=\n|$)/g;
const TRUNCATION_CONTROL_LABELS = new Set([
  '展开', '展开全部', '展开全文', '全文', '阅读全文', '显示全部',
]);
const BODY_UI_CONTROL_LABELS = new Set([...TRUNCATION_CONTROL_LABELS, '收起']);
export const ZSXQ_EXPAND_CONTROL_SELECTOR = 'button, [role="button"], a, span, div, p, em, i';

/** 点击器与完整性门禁共用同一套文案归一，避免「点了却不检查」的漂移。 */
export function zsxqExpandLabel(element: Element): string {
  return (element.textContent ?? '')
    .replace(/^[\s.。·・…]+/u, '')
    .replace(/[\s.。·・…]+$/u, '');
}

function normalizedLinkedArticleHref(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
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

function isLinkedArticleHref(value: string): boolean {
  return normalizedLinkedArticleHref(value) !== undefined;
}

function isLinkedArticleNavigation(element: Element): boolean {
  // 带显式展开语义的节点本身就是控件。即使它内部恰好包着长文链接，也不能把
  // 外层控件当作“纯布局包装”豁免，否则尚未展开的正文会被误报为完整。
  if (element.matches('button, [role="button"], [aria-expanded], [aria-controls]')) {
    return false;
  }

  const anchor = element.closest('a[href]');
  if (anchor && isLinkedArticleHref(anchor.getAttribute('href') ?? '')) return true;

  /*
   * 真实页面会在长文链接外再套纯布局节点：
   * `<div><a href="..."><span>全文</span></a></div>`。span / a 能靠 closest 豁免，
   * 外层 div 却没有 anchor 祖先，而且 textContent 仍恰好是“全文”，此前会被误判为
   * 展开控件。只有“至少包含一个合法长文链接，且移除这些链接后不剩任何可见文字”
   * 才把包装节点也视为导航；夹带真正按钮或其他文案的容器不会被放行。
   */
  const clone = element.cloneNode(true) as Element;
  let linked = 0;
  for (const candidate of clone.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (!isLinkedArticleHref(candidate.getAttribute('href') ?? '')) continue;
    linked += 1;
    candidate.remove();
  }
  return linked > 0 && elementText(clone).trim().length === 0;
}

/** 合法长文链接是导航，不是 DOM 展开控件；其可见文案可能是“全文/阅读全文/展开全文”等。 */
export function isZsxqExpandControl(element: Element): boolean {
  const label = zsxqExpandLabel(element);
  if (!TRUNCATION_CONTROL_LABELS.has(label)) return false;
  return !isLinkedArticleNavigation(element);
}

/** 展开后的“收起”仍是 UI 噪声，但不是正文被截断的证据。 */
function isZsxqBodyUiControl(element: Element): boolean {
  const label = zsxqExpandLabel(element);
  if (!BODY_UI_CONTROL_LABELS.has(label)) return false;
  return !isLinkedArticleNavigation(element);
}

/** 页面仍有可展开控件就说明当前 DOM 不是可归档全文；长文链接本身的“全文”不算。 */
export function hasTruncationControl(content: Element): boolean {
  const candidates = [
    ...(content.matches(ZSXQ_EXPAND_CONTROL_SELECTOR) ? [content] : []),
    ...content.querySelectorAll(ZSXQ_EXPAND_CONTROL_SELECTOR),
  ];
  for (const candidate of candidates) {
    if (isZsxqExpandControl(candidate)) return true;
  }
  // 兜底正则用于“控件文案没有独立节点”的页面，但合法长文导航也可能正好位于正文末尾。
  // 在克隆上移除这些导航后再判，避免 fallback 把刚刚豁免的链接重新判回截断。
  const withoutArticleLinks = content.cloneNode(true) as Element;
  for (const anchor of withoutArticleLinks.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (isLinkedArticleHref(anchor.getAttribute('href') ?? '')) anchor.remove();
  }
  return /(?:展开|展开全部|展开全文|阅读全文|显示全部)\s*$/u.test(
    elementText(withoutArticleLinks),
  );
}

/** 归档正文里剔掉 UI 文案；只去整行，正文里正常出现的这些词不动。 */
export function stripUiNoise(value: string): string {
  return value.replace(UI_NOISE, '$1').replace(/\n{3,}/g, '\n\n').trim();
}

/** 这是不是一篇知识星球长文（帖子正文常常只是导语 + 指向它的链接）。 */
export function isZsxqArticle(url: URL): boolean {
  return url.hostname === 'articles.zsxq.com' && /\/id_[A-Za-z0-9]+/.test(url.pathname);
}

/** 从帖子正文里找出它引用的长文地址；没有就返回 undefined。 */
export function linkedArticleUrl(html: string): string | undefined {
  return /https:\/\/articles\.zsxq\.com\/id_[A-Za-z0-9]+\.html/.exec(html)?.[0];
}

/** 详情页地址形如 /group/<群号>/topic/<帖子号>；列表/分类/精华页没有 /topic/ 段。 */
export function isTopicDetail(url: URL): boolean {
  return !isListPage(url);
}

/**
 * 星球动态多数没有标题。用正文首句兜底，保证归档条目有可读标题
 * （站点 <title> 恒为「<星球名>-知识星球」，不能当文章标题用）。
 */
/**
 * 从一段正文里取一个能用的标题。
 *
 * 两个实测缺陷都出在这儿：
 * - **`---` 被吞进标题**（1/77）。原帖正文里有 `------------------` 分隔线，
 *   截前 N 字就把它带进了标题；下游按 `split('---')` 切 frontmatter 会切错位置，
 *   整条元信息落进正文——归档侧真踩到过，那条的 date 直接读不出来。
 * - **标题是半句话**（53/77）。按 `。！？` 切完还硬截 60 字，
 *   得到「…问是应该割肉等下轮牛市来临买宽」这种断句。
 *
 * 所以：先剥掉 Markdown 结构字符，再按句子边界取，宁可短也不留半个词。
 */
export function titleFromText(body: string): string {
  const stripped = body
    // 分隔线整行去掉（--- === ___ ***），它们不是标题的一部分。
    .replace(/(^|\n)\s*[-=_*]{3,}\s*(?=\n|$)/g, '$1')
    // 行首的 Markdown 结构字符也剥掉。
    .replace(/(^|\n)\s*[#>|]+\s*/g, '$1');
  // **先按行 / 句切，再归一空白。** 反过来的话换行先被压成空格，
  // 整段就变成了一句，标题会把正文第二段也吞进来。
  const sentence = stripped
    .split(/[。！？!?\n]/)
    .map(part => cleanText(part))
    .find(part => part.length >= 4);
  const candidate = sentence ?? cleanText(stripped);
  if (!candidate) return '';
  if (candidate.length <= 48) return candidate;
  // 超长再截，但**切在标点上**，不留半个词组；实在找不到才硬截。
  const head = candidate.slice(0, 48);
  const cut = Math.max(head.lastIndexOf('，'), head.lastIndexOf('、'), head.lastIndexOf('；'), head.lastIndexOf(' '));
  return cut >= 16 ? head.slice(0, cut) : head;
}

function deriveTitle(content: Element, document: Document): string {
  const explicit = elementText(firstWithin(content, ['h1', 'h2', '.title', '[class*="title"]']));
  if (explicit) return titleFromText(explicit);
  const body = stripUiNoise(elementText(content));
  return titleFromText(body) || cleanText(document.title);
}

/**
 * 从列表页的一条帖子节点里找出它自己的详情 URL。
 *
 * 列表页批量采集必须拿到**每条帖子各自的 URL** —— 稳定内容 ID 由规范 URL 派生，
 * 若都用列表页 URL，21 条帖子会算出同一个 ID 而相互覆盖，最后只剩 1 条。
 *
 * 实测这个站点的 DOM 上**没有**帖子号：没有 <a>、没有 data-*、整棵子树找不到长数字。
 * 因此主要来源是 topicIndex（旁观应用自己的接口响应得到的「正文 → 帖子号」对照表）；
 * 任意后代链接/长数字不能当本帖身份：正文可能引用另一帖，评论和作者组件也有长 ID。
 * 只有严格正文索引，或容器自身语义明确的 `data-topic-id`，才能作为本帖证据。
 */
export function topicUrlOf(
  container: Element,
  pageUrl: URL,
  topics?: TopicIndex,
  /**
   * 用来和接口响应对号的候选正文，按可靠度从高到低依次尝试；缺省用整个节点的文本。
   * 之所以是多个：问答帖的问与答在页面上是分开的块，得一块块试才对得上。
   */
  bodyText?: string | readonly string[],
): URL | undefined {
  const groupId = pageUrl.pathname.match(/\/group\/(\d+)/)?.[1];
  if (!groupId) return undefined;
  const directTopicId = container.getAttribute('data-topic-id');
  const validDirectTopicId = directTopicId && /^\d{15,25}$/.test(directTopicId)
    ? directTopicId
    : undefined;

  // 主路径：用正文把这条帖子对回接口响应里的 topic_id。逐个候选试，第一个对上就用它。
  const candidates = bodyText === undefined
    ? [container.textContent ?? '']
    : typeof bodyText === 'string' ? [bodyText] : [...bodyText];
  for (const candidate of candidates) {
    const fromIndex = topics?.find(candidate);
    if (fromIndex) {
      // 虚拟列表会先把根 id 切到 B、稍后才把 A 的正文换掉；两份显式身份冲突时
      // 当前帧不可归档，也不能先按 A 的正文替 B 做业务过滤。
      if (validDirectTopicId && validDirectTopicId !== fromIndex) return undefined;
      return new URL(`/group/${groupId}/topic/${fromIndex}`, pageUrl);
    }
  }
  // 图片-only 身份也只能看正文块；评论头像/评论配图命中另一帖 source image 不能认号。
  const imageUrls = contentBlocks(container)
    .flatMap(block => [...block.querySelectorAll<HTMLImageElement>('img')])
    .map(image => image.getAttribute('data-src') ?? image.getAttribute('src') ?? '')
    .map(value => canonicalBodyAssetUrl(value, pageUrl.href))
    .filter((value): value is string => value !== undefined);
  const fromImages = topics?.findByImageUrls(imageUrls);
  if (fromImages?.status === 'unique') {
    if (validDirectTopicId && validDirectTopicId !== fromImages.topicId) return undefined;
    return new URL(`/group/${groupId}/topic/${fromImages.topicId}`, pageUrl);
  }
  if (fromImages?.status === 'ambiguous') return undefined;
  // 若站点未来把本帖 id 明确放在帖子根节点上，可作为保守兜底；绝不扫描后代。
  if (validDirectTopicId) {
    return new URL(`/group/${groupId}/topic/${validDirectTopicId}`, pageUrl);
  }
  return undefined;
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
  /** 已能确定自身 URL 的业务过滤项仍要跨边界保留，供固定计划审计。 */
  url?: string;
  /** DOM/API 仍可能补齐；推进列表时不能把该节点永久标成已处理。 */
  retryable?: boolean;
}

export interface ListExtraction {
  entries: ListEntry[];
  /** 无法确定各自 URL 而被跳过的条数（用于如实告知用户，而不是静默少采）。 */
  skipped: number;
  total: number;
}

/**
 * 一条帖子在页面上**用于对号的正文文本**（不含作者名、时间、点赞数等外围文案）。
 * 诊断要拿它和接口正文摆在一起比，所以必须和 extractZsxqList 走同一条取文路径，
 * 否则比的是另一段文字，看着「明明一样」却对不上。
 */
export function listBodyText(container: Element): string {
  const blocks = contentBlocks(container);
  return blocks.map(block => elementText(block)).join(' ');
}

/**
 * 用来和接口正文对号的候选文本，从最可靠到最兜底。
 *
 * 问答帖单独一块块地试很关键：页面上问与答之间夹着「提问 / 回答」这类标签，
 * 拼起来的整段就不再是接口正文的连续子串了，只有单独一段才对得上。
 */
function matchTexts(container: Element, blocks: Element[]): string[] {
  const texts = [
    blocks.map(block => elementText(block)).join(' '),
    ...blocks.map(block => elementText(block)),
    elementText(container),
  ];
  return [...new Set(texts.filter(Boolean))];
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
    // 问答帖有「问题」「回答」两块正文：两块都要归档（丢掉回答等于丢掉一半内容），
    // 对号时也要一块块单独试。
    const blocks = contentBlocks(container);
    if (blocks.length === 0) {
      skipped += 1;
      entries.push({
        container,
        key,
        title: titleFromText(elementText(container)) || '（无法识别正文）',
        reason: '未识别到这条帖子的正文结构，页面可能已改版；为避免把作者、评论和操作栏冒充完整正文，本条已跳过。',
        retryable: true,
      });
      continue;
    }
    const content = contentRoot(document, blocks)!;
    const text = listBodyText(container);
    let title = deriveTitle(blocks[0] ?? content, document);
    // 用正文（而不是整个节点）去对号：整个节点还带着作者名、时间、点赞数这些外围文案。
    const topicUrl = topicUrlOf(container, url, topics, matchTexts(container, blocks));
    if (!topicUrl) {
      skipped += 1;
      // 没有本帖身份时，任何选题/广告命中都不能算“可审计的业务排除”：正文可能属于另一条，
      // 也没有规范 URL 可供复核。保留为 retryable，等 API topic id 到达后再做终局判断。
      entries.push({
        container,
        key,
        title,
        reason: '这条帖子的编号没截到（编号只出现在站点接口响应里，不在页面上），'
          + '所以无法确定它自己的网址，只能跳过。多半是它在插件启动前就已经加载在页面上了；'
          + '把分类切走再切回来，让站点重新请求一次即可。',
        retryable: true,
      });
      continue;
    }
    const topicId = topicUrl.pathname.match(/\/topic\/(\d+)/)?.[1];
    if (topicId && topics?.sourceBodyConflicted(topicId)) {
      skipped += 1;
      entries.push({
        container,
        key,
        title,
        url: topicUrl.href,
        reason: '同一帖子编号捕获到互不兼容的来源正文或资源版本，无法证明当前版本；将刷新后重试。',
        retryable: true,
      });
      continue;
    }
    const sourceBody = topicId ? topics?.sourceBodyOf(topicId) : undefined;
    const sourceBodyProven = Boolean(topicId && topics?.hasSourceBody(topicId));
    const sourceMediaProven = Boolean(topicId && topics?.sourceMediaProvenOf(topicId));
    const sourceImages = topicId ? topics?.sourceImagesOf(topicId) ?? [] : [];
    const sourceAttachments = topicId ? topics?.sourceAttachmentsOf(topicId) ?? [] : [];
    const sourceBodyCoversDom = sourceBody !== undefined
      && detailDomMatchesSourceBody(content, sourceBody);
    const sourceCoversDom = sourceBodyCoversDom && (
      !sourceMediaProven
      || sourceAssetsCoverDom(content, sourceBody, sourceImages, sourceAttachments)
    );
    if (sourceBodyProven && !sourceCoversDom) {
      skipped += 1;
      entries.push({
        container,
        key,
        title,
        url: topicUrl.href,
        reason: '帖子根编号与当前 DOM 正文/资源尚未同步，可能仍是虚拟列表上一帖残留；将继续等待。',
        retryable: true,
      });
      continue;
    }
    const sourceContentProven = sourceBodyProven && sourceCoversDom && sourceMediaProven;
    if ((!text || text.length < 20) && !sourceContentProven) {
      skipped += 1;
      entries.push({
        container,
        key,
        title: title || '（空内容）',
        url: topicUrl.href,
        reason: '正文太短或为空，且当前来源尚未证明所有正文组件与媒体都已完整',
        retryable: true,
      });
      continue;
    }
    title = title
      || sourceImages.find(image => image.alt)?.alt
      || sourceAttachments.find(attachment => attachment.title)?.title
      || `图片/附件内容 ${topicId?.slice(-6) ?? ''}`.trim();
    // 选题过滤：用户明确不看的类别（如打新）不入库，但**照样出现在明细里**，
    // 状态是已跳过、原因写明类别——绝不静默丢弃。
    const excluded = excludedBy(text);
    if (excluded) {
      skipped += 1;
      entries.push({
        container,
        key,
        title,
        ...(topicUrl ? { url: topicUrl.href } : {}),
        // 命中的词一并报出来：误伤时不报就只能靠猜（「香港保险」被判成楼市那次就卡在这）。
        reason: `${excluded.label}（按选题偏好跳过，命中：${excluded.hits.join('、')}）`,
      });
      continue;
    }
    // 带货帖：精华里混着分销推广（实测抓到过 cps.qixin19.com 的保险分销落地页）。
    // 只认外链这种硬证据，不按语气判——正经的费率科普和拿返佣的推广用词几乎一样。
    const advertisement = advertisementIn(
      [...container.querySelectorAll('a[href]')].map(anchor => anchor.getAttribute('href') ?? ''),
    );
    if (advertisement) {
      skipped += 1;
      entries.push({
        container,
        key,
        title,
        ...(topicUrl ? { url: topicUrl.href } : {}),
        reason: `${advertisement.label}（按硬证据跳过，依据：${advertisement.hits.join('；')}）`,
      });
      continue;
    }
    const time = firstWithin(container, TIME_SELECTORS);
    const author = elementText(firstWithin(container, AUTHOR_SELECTORS));
    // 发布时间优先用接口给的完整时间戳：页面上那行字是渲染结果，老帖写成
    // 「23年06月18日」甚至「3天前」，解析不出来就只能退回采集时间——
    // 实测一篇 2023-06-18 的帖子被记成了采集当天的 2026-08-01。
    // 既然已经靠接口响应对上了帖子号，同一条记录里的发布时间当然也该用上。
    const publishedAt =
      (topicId ? topics?.publishedAtOf(topicId) : undefined)
      ?? parsePublishedAt(elementText(time), time?.getAttribute('datetime'));
    // 页面上的正文可能还是折叠的（「展开全部」没点开、或点了没生效）。
    // 接口那份从来不折叠——既然已经靠它对上了帖子号，正文不全时就用它补齐，
    // 绝不把半篇当完整内容存下去（实测：入库正文末尾还挂着「展开全部」四个字）。
    const archived = completeContent(
      document,
      content,
      sourceBody,
      sourceCoversDom,
      sourceImages,
      sourceAttachments,
      sourceMediaProven,
    );
    // 正文里还挂着「展开全部」= 这一条**确定是截断的**。如实标出来，
    // 让归档侧读字段跳过，而不是靠字数猜（实测字数启发式误报率 78%）。
    const sourceBodyTruncated = Boolean(topicId && topics?.sourceBodyTruncatedOf(topicId));
    const visibleControl = hasTruncationControl(archived);
    const truncated = sourceBodyTruncated || visibleControl
      ? true
      : sourceContentProven ? false : undefined;
    // 问答帖的提问者：`<div class="question-owner"><span>依依</span> 提问：</div>`
    const questioner = elementText(container.querySelector('.question-owner span'));
    const authorRole = authorRoleOf(container);
    const viewLabel = activeViewOf(document);
    entries.push({
      container,
      key,
      title,
      document: buildDocument({
        source: 'zsxq',
        kind: 'post',
        title,
        content: archived,
        url: topicUrl,
        now,
        ...(author ? { author } : {}),
        ...(publishedAt ? { publishedAt } : {}),
        ...(truncated !== undefined ? { truncated } : {}),
        ...(questioner ? { questioner } : {}),
        sourceMetadata: {
          ...(authorRole ? { authorRole } : {}),
          ...(topicId ? { topicId } : {}),
          sourceBodyProven,
          sourceMediaProven,
          sourceCoversDom,
          ...(viewLabel ? { viewLabels: viewLabel } : {}),
        },
      }),
    });
  }
  return { entries, skipped, total: containers.length };
}

/** 长文页的强语义正文容器；命中任一时绝不再看裸 `.content` 或密度兜底。 */
const ARTICLE_STRONG_SELECTORS = [
  '.article-content',
  '.article-container .content',
  '.article-container article',
  'app-article article',
  'main article',
  'body > article',
  'app-article .content',
  '.rich_media_content',
];
/** 裸 `.content` 只能说明“可能是内容”，无法排除推荐、评论等页面区域。 */
const ARTICLE_WEAK_SELECTORS = ['.content'];
const ARTICLE_ROOT_SELECTOR = 'app-article, article, main, .article-container, .rich_media_content';
/** 这些区域即使复用正文类名，也明确不是当前 URL 的可见主体。 */
const ARTICLE_NON_BODY_SELECTOR = [
  'aside',
  'nav',
  'footer',
  '[hidden]',
  '[aria-hidden="true"]',
  '[role="complementary"]',
  '[role="navigation"]',
  '[class*="recommend" i]',
  '[class*="related" i]',
  '[class*="comment" i]',
  '[style*="display:none" i]',
  '[style*="display: none" i]',
].join(', ');

function articleElementHidden(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  try {
    const style = view.getComputedStyle(element);
    return style.display === 'none'
      || style.visibility === 'hidden'
      || style.visibility === 'collapse'
      || style.contentVisibility === 'hidden'
      || style.opacity === '0';
  } catch {
    return false;
  }
}

/** 候选自身可见不够；旧 SPA pane 常由祖先 class 在样式表里隐藏。 */
function articleCandidateVisible(element: Element): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.matches(ARTICLE_NON_BODY_SELECTOR) || articleElementHidden(current)) return false;
  }
  return true;
}

/**
 * 强正文根内也可能嵌着推荐、评论或隐藏旧快照。在克隆上删除它们，
 * 绝不改用户正在查看的页面；原节点和克隆按前序一一对应。
 */
function sanitizedArticleBlock(block: Element): Element {
  const clone = block.cloneNode(true) as Element;
  const originals = [block, ...block.querySelectorAll('*')];
  const clones = [clone, ...clone.querySelectorAll('*')];
  for (let index = 1; index < originals.length; index += 1) {
    const original = originals[index]!;
    if (!original.matches(ARTICLE_NON_BODY_SELECTOR) && !articleElementHidden(original)) continue;
    clones[index]?.remove();
  }
  return clone;
}

/**
 * 从同一可靠性层级里挑正文。
 *
 * - DOM 祖先/后代或文本包含的是同一份正文的重复表示，只留信息更完整的一份；
 * - 同一文章根下、命中同一选择器的并列块有明确“分章节渲染”证据，按 DOM 顺序合并；
 * - 其它候选可能是“摘要 + 正文”或隐藏的旧版本，只选文字最丰富的一组。
 */
function articleContentForSelectors(
  document: Document,
  selectors: readonly string[],
): { content: Element; ambiguous: boolean; selector: string } | undefined {
  const found = [...document.querySelectorAll(selectors.join(', '))]
    .filter(articleCandidateVisible);
  const outermost = found.filter(
    node => !found.some(other => other !== node && other.contains(node)),
  );
  const sanitized = new Map(outermost.map(node => [node, sanitizedArticleBlock(node)]));
  const normalized = new Map(
    outermost.map(node => [
      node,
      stripUiNoise(elementText(sanitized.get(node)!)).replace(/\s+/g, ''),
    ]),
  );
  const distinct = outermost.filter((node) => {
    const text = normalized.get(node) ?? '';
    if (!text) return false;
    return !outermost.some((other) => {
      if (other === node) return false;
      const otherText = normalized.get(other) ?? '';
      return otherText.length > text.length && otherText.includes(text);
    });
  });

  const groups: Array<{
    scope: Element | null;
    selector: string;
    blocks: Element[];
  }> = [];
  for (const block of distinct) {
    const selector = selectors.find(candidate => block.matches(candidate))!;
    const root = block.closest(ARTICLE_ROOT_SELECTOR);
    const parent = block.parentElement;
    // 未知文章根下的同类直接兄弟仍是明确的分块证据；但 body/html 太宽，不能据此拼全页。
    const scope = root
      ?? (parent && parent.tagName !== 'BODY' && parent.tagName !== 'HTML' ? parent : null);
    const group = scope
      ? groups.find(candidate => candidate.scope === scope && candidate.selector === selector)
      : undefined;
    const cleanBlock = sanitized.get(block)!;
    if (group) group.blocks.push(cleanBlock);
    else groups.push({ scope, selector, blocks: [cleanBlock] });
  }

  let richest: Element | undefined;
  let richestLength = 0;
  let richestSelector: string | undefined;
  for (const group of groups) {
    const content = contentRoot(document, group.blocks)!;
    const length = stripUiNoise(elementText(content)).replace(/\s+/g, '').length;
    if (length > richestLength) {
      richest = content;
      richestLength = length;
      richestSelector = group.selector;
    }
  }
  return richest && richestSelector
    ? { content: richest, ambiguous: groups.length > 1, selector: richestSelector }
    : undefined;
}

/**
 * 正文密度兜底：选择器全落空时，挑文字最多的那个块。
 *
 * 长文页是个 Angular 单页应用，类名随时可能变。与其某天悄悄采到空正文，
 * 不如按「谁的字最多」兜住——排除 body/html 本身，避免把整页导航也算进来。
 */
function densestBlock(document: Document): Element | undefined {
  let best: Element | undefined;
  let bestLength = 0;
  for (const element of document.querySelectorAll('div, section, article, main')) {
    // 只看直接文字量，套娃的外层容器不会因为包着正文就胜出。
    const length = elementText(element).length;
    if (length > bestLength && length >= 200) {
      // 已有更内层的候选就不要外层了（外层必然更长）。
      if (best && element.contains(best)) continue;
      best = element;
      bestLength = length;
    }
  }
  return best;
}

/**
 * 知识星球长文页（`articles.zsxq.com/id_xxx.html`）。
 *
 * **这是正文的真正所在。** 星球的长文帖在信息流里只有一段导语加一个链接，
 * 实测 77 条投递里 54 条（70%）是这种形态，其中 43 条正文不足 400 字——
 * 归档侧拿到的基本是个空壳。
 *
 * 页面本身是 Angular 单页应用：直接 curl 只能拿到 `<app-root></app-root>`，
 * 它的接口 `api.zsxq.com/v2/articles/<id>` 又要登录态（401）。
 * 所以只能在**浏览器里**取——用户的会话在那儿。
 */
export function extractZsxqArticle(document: Document, url: URL, now: Clock) {
  if (LOGIN_SELECTORS.some(selector => document.querySelector(selector))) {
    throw new ExtractionError('AUTH_REQUIRED', '请先登录知识星球，再采集这篇长文');
  }
  const strongChoice = articleContentForSelectors(document, ARTICLE_STRONG_SELECTORS);
  const weakChoice = strongChoice
    ? undefined
    : articleContentForSelectors(document, ARTICLE_WEAK_SELECTORS);
  const densityChoice = strongChoice || weakChoice ? undefined : densestBlock(document);
  const content = strongChoice?.content ?? weakChoice?.content ?? densityChoice;
  if (!content) {
    throw new ExtractionError(
      'CONTENT_EMPTY',
      '长文正文还没渲染出来（这一页是单页应用，内容要等接口返回）。稍等片刻再试。',
    );
  }
  const rawText = elementText(content);
  const text = stripUiNoise(rawText);
  // 展开控件才是正文被截断的正向证据。裸 `.content`、密度兜底和歧义强候选
  // 都只能说明完整性未知；交给有界重试继续观察，最终仍会按不完整处理。
  const hasExpandControl = hasTruncationControl(content);
  const truncated = hasExpandControl
    ? true
    : strongChoice && !strongChoice.ambiguous
      ? false
      : undefined;
  if (text.length < 100) {
    throw new ExtractionError('CONTENT_EMPTY', '长文正文过短，多半是还没加载完');
  }
  const time = firstWithin(document, TIME_SELECTORS);
  const author = elementText(firstWithin(document, AUTHOR_SELECTORS));
  const publishedAt = parsePublishedAt(elementText(time), time?.getAttribute('datetime'));
  const titleElement = firstWithin(document, ['h1', 'h2', '.title']);
  const explicitTitle = elementText(titleElement);
  // 旧版长文页确实只给正文使用裸 `.content`。单帧仍不能证明完整，但“唯一正文候选 +
  // 明确标题/作者/发布时间”足以证明页面身份，允许后台在正文连续不变 24 秒后晋升。
  // 密度兜底、歧义候选、缺任一身份字段或出现展开控件时都不发这个凭据。
  const articleStableCandidate = Boolean(
    weakChoice
      && !weakChoice.ambiguous
      && !hasExpandControl
      && explicitTitle
      && author
      && publishedAt,
  );
  const articleLayoutMode = strongChoice ? 'strong' : weakChoice ? 'weak' : 'density';
  const articleLayoutSelector = strongChoice?.selector ?? weakChoice?.selector ?? 'density';
  return buildDocument({
    source: 'zsxq',
    kind: 'article',
    title: titleFromText(explicitTitle || text),
    content,
    url,
    now,
    ...(truncated === undefined ? {} : { truncated }),
    ...(author ? { author } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    sourceMetadata: {
      articleLayoutMode,
      articleLayoutSelector,
      articleLayoutAmbiguous: strongChoice?.ambiguous ?? weakChoice?.ambiguous ?? true,
      ...(articleStableCandidate ? { articleStableCandidate: true } : {}),
    },
  });
}

export function extractZsxq(
  document: Document,
  url: URL,
  now: Clock,
  topics?: TopicIndex,
  requireTopicEvidence = false,
) {
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

  const targetTopicId = url.pathname.match(/\/topic\/(\d+)/)?.[1];
  const semanticContainers = containers
    .filter(isPost)
    .filter(candidate => contentBlocks(candidate).length > 0);
  const explicitTopicId = (candidate: Element): string | undefined => {
    const value = candidate.getAttribute('data-topic-id');
    return value && /^\d{15,25}$/.test(value) ? value : undefined;
  };
  const exactMatches = targetTopicId
    ? semanticContainers.filter(candidate => explicitTopicId(candidate) === targetTopicId)
    : [];
  let container: Element;
  if (exactMatches.length === 1) {
    container = exactMatches[0]!;
  } else {
    const hasExplicitMismatch = semanticContainers.some(
      candidate => explicitTopicId(candidate) !== undefined,
    );
    if (exactMatches.length > 1 || hasExplicitMismatch || semanticContainers.length > 1) {
      throw new ExtractionError(
        'UNSUPPORTED_LAYOUT',
        '当前详情页同时存在多条帖子，无法证明哪个正文属于 URL 中的目标帖子身份；为避免串帖，本次未保存。',
      );
    }
    container = semanticContainers[0]
      ?? containers.filter(isPost)[0]
      ?? document.body;
  }
  const blocks = contentBlocks(container);
  const content = contentRoot(document, blocks);
  if (!content) {
    throw new ExtractionError(
      'UNSUPPORTED_LAYOUT',
      '未识别到帖子正文结构，页面可能已改版；为避免把作者、评论和操作栏冒充完整正文，本次未保存。',
    );
  }
  if (targetTopicId && topics?.sourceBodyConflicted(targetTopicId)) {
    throw new ExtractionError(
      'CONTENT_EMPTY',
      '同一帖子编号捕获到互不兼容的来源正文或资源版本，无法证明当前详情属于哪一版；将刷新后重试。',
    );
  }
  if (requireTopicEvidence && (!targetTopicId || !topics?.hasSourceBody(targetTopicId))) {
    throw new ExtractionError(
      'CONTENT_EMPTY',
      '当前构建尚未捕获该详情页经核验的精确正文来源记录，无法证明稳定 DOM 就是完整正文；将继续有界等待。',
    );
  }
  // 详情页 URL 已精确给出 topic id；主世界钩子若已经捕获同 id 的 API 全文，必须像
  // 列表路径一样用它补齐。DOM 可能永久只挂首段且没有展开控件，单看稳定 DOM 会把
  // 这种半篇误证为完整；API 留存上限也同样是正向截断证据。
  const sourceBody = targetTopicId ? topics?.sourceBodyOf(targetTopicId) : undefined;
  const sourceBodyProven = Boolean(targetTopicId && topics?.hasSourceBody(targetTopicId));
  const sourceImages = targetTopicId ? topics?.sourceImagesOf(targetTopicId) ?? [] : [];
  const sourceAttachments = targetTopicId ? topics?.sourceAttachmentsOf(targetTopicId) ?? [] : [];
  const sourceMediaProven = Boolean(targetTopicId && topics?.sourceMediaProvenOf(targetTopicId));
  const sourceBodyCoversDom = sourceBody !== undefined
    && detailDomMatchesSourceBody(content, sourceBody);
  const sourceCoversDom = sourceBodyCoversDom && (
    !sourceMediaProven
    || sourceAssetsCoverDom(content, sourceBody, sourceImages, sourceAttachments)
  );
  if (sourceBody !== undefined && !sourceCoversDom) {
    throw new ExtractionError(
      'CONTENT_EMPTY',
      '详情页当前 DOM 正文与 URL 对应来源正文不兼容，可能仍是上一帖残留；将继续等待页面切换完成。',
    );
  }
  const archived = completeContent(
    document,
    content,
    sourceBody,
    sourceCoversDom,
    sourceImages,
    sourceAttachments,
    sourceMediaProven,
  );
  const text = elementText(archived);
  const sourceContentProven = sourceBodyProven && sourceCoversDom && sourceMediaProven;
  if ((!text || text.length < 20) && !sourceContentProven) {
    throw new ExtractionError(
      'CONTENT_EMPTY',
      '未读到帖子正文：请确认页面已加载完成（必要时先点开「展开全文」）后重试',
    );
  }

  const time = firstWithin(container, TIME_SELECTORS);
  const author = elementText(firstWithin(container, AUTHOR_SELECTORS));
  const publishedAt = (targetTopicId ? topics?.publishedAtOf(targetTopicId) : undefined)
    ?? parsePublishedAt(elementText(time), time?.getAttribute('datetime'));
  // 截断标志和提问者：**单条采集这条路原先没设**，于是按 URL 重采出来的 48 条
  // 一个 truncated 都没有，归档侧只能回去靠字数猜。两条路径必须给同样的字段。
  const sourceBodyTruncated = Boolean(targetTopicId && topics?.sourceBodyTruncatedOf(targetTopicId));
  const visibleControl = hasTruncationControl(archived);
  const truncated = sourceBodyTruncated || visibleControl
    ? true
    : sourceContentProven ? false : undefined;
  const questioner = elementText(container.querySelector('.question-owner span'));
  const authorRole = authorRoleOf(container);
  return buildDocument({
    source: 'zsxq',
    kind: 'post',
    title: deriveTitle(archived, document)
      || sourceImages.find(image => image.alt)?.alt
      || sourceAttachments.find(attachment => attachment.title)?.title
      || `图片/附件内容 ${targetTopicId?.slice(-6) ?? ''}`.trim(),
    content: archived,
    url,
    now,
    ...(author ? { author } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(truncated !== undefined ? { truncated } : {}),
    ...(questioner ? { questioner } : {}),
    sourceMetadata: {
      ...(authorRole ? { authorRole } : {}),
      ...(targetTopicId ? { topicId: targetTopicId } : {}),
      sourceBodyProven,
      sourceMediaProven,
      sourceCoversDom,
    },
  });
}
