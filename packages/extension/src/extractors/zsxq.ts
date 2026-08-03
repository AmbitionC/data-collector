import { isListPage } from '@data-collector/shared';
import { inlineMarkupToHtml, stripInlineMarkup, type TopicIndex } from '../topicIndex.js';
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
  '.content',
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

/**
 * 一条帖子里的全部正文块。
 *
 * 问答帖有**两块**（问题、回答），只取第一块会有两个后果：归档时丢掉回答，
 * 对号时也只拿着半段去比。按选择器分组取，同一组内全取，避免 `.content` 这类
 * 宽泛选择器把外层容器和内层正文重复算两次。
 */
function contentBlocks(container: Element): Element[] {
  for (const selector of CONTENT_SELECTORS) {
    const found = [...container.querySelectorAll(selector)];
    // 嵌套的只留最外层：`.talk-content-container .content` 会命中两次同一段文字。
    const outermost = found.filter(node => !found.some(other => other !== node && other.contains(node)));
    if (outermost.length > 0) return outermost;
  }
  return [];
}

/**
 * 把多个正文块合成一个**游离**的元素供归档使用。
 *
 * 用克隆拼装，**绝不改动页面本身**：用户正在肉眼核对采到的内容。
 * 只有一块时直接返回那一块，不做无谓包装。
 */
function contentRoot(document: Document, blocks: Element[], container: Element): Element {
  if (blocks.length === 0) return container;
  if (blocks.length === 1) return blocks[0]!;
  const merged = document.createElement('div');
  for (const block of blocks) merged.append(block.cloneNode(true));
  return merged;
}

/**
 * 归档用的正文：页面那份被折叠截断时，用接口那份补齐。
 *
 * 判据是长度——接口正文明显更长，就说明页面上还是折叠态。留一点余量（15% 且至少 120 字），
 * 免得因为页面多了「赞」「评论」这类零星文案就误判。
 *
 * 补齐时图片要从页面那份搬过来：接口正文里图片只是占位标记，真地址在 DOM 上。
 * 全程只操作**克隆**，绝不改动页面本身——用户正在肉眼核对。
 */
export function completeContent(
  document: Document,
  domContent: Element,
  apiText: string | undefined,
): Element {
  const domText = elementText(domContent);
  if (!apiText) return domContent;
  const apiLength = stripInlineMarkup(apiText).replace(/\s+/g, '').length;
  const domLength = domText.replace(/\s+/g, '').length;
  if (apiLength < domLength * 1.15 || apiLength < domLength + 120) return domContent;

  const merged = document.createElement('div');
  merged.innerHTML = inlineMarkupToHtml(apiText);
  for (const image of domContent.querySelectorAll('img')) merged.append(image.cloneNode(true));
  return merged;
}

/**
 * 页面上的交互文案，绝不该进归档正文。
 *
 * 实测 77 条里 64 条（83%）末尾挂着「展开全部」「收起」。它们是控件的字，
 * 不是作者写的内容，下游还得再洗一遍。
 */
const UI_NOISE = /(^|\n)\s*(展开全部|展开全文|收起|阅读全文|显示全部|全文)\s*(?=\n|$)/g;

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
 * DOM 上的链接/属性仍然照查一遍，将来页面结构变了也能直接用上。
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
  const elements = [container, ...container.querySelectorAll('*')];
  for (const element of elements.slice(0, 200)) {
    for (const attribute of element.getAttributeNames()) {
      if (!/^(id|data-|ng-reflect-)/.test(attribute)) continue;
      const topicId = (element.getAttribute(attribute) ?? '').match(/\b(\d{15,25})\b/)?.[1];
      if (topicId) return new URL(`/group/${groupId}/topic/${topicId}`, pageUrl);
    }
  }

  // 主路径：用正文把这条帖子对回接口响应里的 topic_id。逐个候选试，第一个对上就用它。
  const candidates = bodyText === undefined
    ? [container.textContent ?? '']
    : typeof bodyText === 'string' ? [bodyText] : [...bodyText];
  for (const candidate of candidates) {
    const fromIndex = topics?.find(candidate);
    if (fromIndex) return new URL(`/group/${groupId}/topic/${fromIndex}`, pageUrl);
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
  return blocks.length > 0
    ? blocks.map(block => elementText(block)).join(' ')
    : elementText(container);
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
    const content = contentRoot(document, blocks, container);
    const text = listBodyText(container);
    const title = deriveTitle(blocks[0] ?? content, document);
    // 用正文（而不是整个节点）去对号：整个节点还带着作者名、时间、点赞数这些外围文案。
    const topicUrl = topicUrlOf(container, url, topics, matchTexts(container, blocks));
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
      entries.push({
        container,
        key,
        title,
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
        reason: `${advertisement.label}（按硬证据跳过，依据：${advertisement.hits.join('；')}）`,
      });
      continue;
    }
    if (!topicUrl) {
      skipped += 1;
      // 说清是什么、为什么、怎么办——「没能对上帖子号」六个字用户根本无从下手。
      entries.push({
        container,
        key,
        title,
        reason: '这条帖子的编号没截到（编号只出现在站点接口响应里，不在页面上），'
          + '所以无法确定它自己的网址，只能跳过。多半是它在插件启动前就已经加载在页面上了；'
          + '把分类切走再切回来，让站点重新请求一次即可。',
      });
      continue;
    }
    const time = firstWithin(container, TIME_SELECTORS);
    const author = elementText(firstWithin(container, AUTHOR_SELECTORS));
    // 发布时间优先用接口给的完整时间戳：页面上那行字是渲染结果，老帖写成
    // 「23年06月18日」甚至「3天前」，解析不出来就只能退回采集时间——
    // 实测一篇 2023-06-18 的帖子被记成了采集当天的 2026-08-01。
    // 既然已经靠接口响应对上了帖子号，同一条记录里的发布时间当然也该用上。
    const topicId = topicUrl.pathname.match(/\/topic\/(\d+)/)?.[1];
    const publishedAt =
      (topicId ? topics?.publishedAtOf(topicId) : undefined)
      ?? parsePublishedAt(elementText(time), time?.getAttribute('datetime'));
    // 页面上的正文可能还是折叠的（「展开全部」没点开、或点了没生效）。
    // 接口那份从来不折叠——既然已经靠它对上了帖子号，正文不全时就用它补齐，
    // 绝不把半篇当完整内容存下去（实测：入库正文末尾还挂着「展开全部」四个字）。
    const archived = completeContent(
      document,
      content,
      topicId ? topics?.fullTextOf(topicId) : undefined,
    );
    // 正文里还挂着「展开全部」= 这一条**确定是截断的**。如实标出来，
    // 让归档侧读字段跳过，而不是靠字数猜（实测字数启发式误报率 78%）。
    const truncated = /展开全部|展开全文|阅读全文/.test(elementText(archived));
    // 问答帖的提问者：`<div class="question-owner"><span>依依</span> 提问：</div>`
    const questioner = elementText(container.querySelector('.question-owner span'));
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
        ...(truncated ? { truncated: true } : {}),
        ...(questioner ? { questioner } : {}),
      }),
    });
  }
  return { entries, skipped, total: containers.length };
}

/** 长文页的正文容器候选（Angular 应用，类名可能变，所以还留了兜底）。 */
const ARTICLE_SELECTORS = [
  '.article-content',
  '.article-container .content',
  'app-article .content',
  '.rich_media_content',
  'article',
  '.content',
];

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
  const content = firstWithin(document, ARTICLE_SELECTORS) ?? densestBlock(document);
  if (!content) {
    throw new ExtractionError(
      'CONTENT_EMPTY',
      '长文正文还没渲染出来（这一页是单页应用，内容要等接口返回）。稍等片刻再试。',
    );
  }
  const text = stripUiNoise(elementText(content));
  if (text.length < 100) {
    throw new ExtractionError('CONTENT_EMPTY', '长文正文过短，多半是还没加载完');
  }
  const time = firstWithin(document, TIME_SELECTORS);
  const author = elementText(firstWithin(document, AUTHOR_SELECTORS));
  const publishedAt = parsePublishedAt(elementText(time), time?.getAttribute('datetime'));
  return buildDocument({
    source: 'zsxq',
    kind: 'article',
    title: titleFromText(elementText(firstWithin(document, ['h1', 'h2', '.title'])) || text),
    content,
    url,
    now,
    ...(author ? { author } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  });
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
  // 截断标志和提问者：**单条采集这条路原先没设**，于是按 URL 重采出来的 48 条
  // 一个 truncated 都没有，归档侧只能回去靠字数猜。两条路径必须给同样的字段。
  const truncated = /展开全部|展开全文|阅读全文/.test(text);
  const questioner = elementText(container.querySelector('.question-owner span'));
  return buildDocument({
    source: 'zsxq',
    kind: 'post',
    title: deriveTitle(content, document),
    content,
    url,
    now,
    ...(author ? { author } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(questioner ? { questioner } : {}),
  });
}
