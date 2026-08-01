import type { CollectedDocument } from '@data-collector/shared';
import {
  COLLECTED_ATTRIBUTE,
  KEY_ATTRIBUTE,
  listBodyText,
  ExtractionError,
  extractDocument,
  extractList,
  pendingTopicCount,
} from './extractors/index.js';
import {
  TOPIC_MESSAGE,
  TOPIC_REPLAY_REQUEST,
  TOPIC_STATS,
  TOPIC_STATS_REQUEST,
  TopicIndex,
  type HookStats,
  type TopicRecord,
} from './topicIndex.js';

/**
 * 帖子号索引。帖子号不在 DOM 上，只能从应用自己的接口响应里取（见 inject.ts）。
 * 主世界脚本捕获后 postMessage 过来，这里累积成「正文 → 帖子号」的对照表。
 */
const topics = new TopicIndex();
/** 主世界钩子最近一次上报的运行统计（诊断用）。 */
let hookStats: HookStats | undefined;
window.addEventListener('message', event => {
  if (event.source !== window) return;
  const data = event.data as { source?: unknown; records?: unknown; stats?: unknown };
  if (data?.source === TOPIC_STATS) {
    hookStats = data.stats as HookStats;
    return;
  }
  if (data?.source !== TOPIC_MESSAGE || !Array.isArray(data.records)) return;
  topics.add(data.records as TopicRecord[]);
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
  window.postMessage({ source: TOPIC_REPLAY_REQUEST }, window.location.origin);
}

/**
 * 问主世界钩子要一份运行统计。
 *
 * 拿不到（超时）本身就是结论：**钩子没在跑**。这是「已捕获 0 个」最重要的一种成因，
 * 光看帖子号条数分不出来——之前就是因此反复猜。
 */
function requestHookStats(timeoutMs = 400): Promise<HookStats> {
  hookStats = undefined;
  window.postMessage({ source: TOPIC_STATS_REQUEST }, window.location.origin);
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
    | 'list.advance'
    | 'list.diagnose'
    | 'list.restore'
    | 'list.highlight'
    | 'list.itemDiagnose'
    | 'list.hookStats'
    | 'list.refreshTopics'
    | 'list.focusLast';
  /** list.highlight：要滚过去并高亮的那一条。 */
  key?: string;
  overrides?: {
    userCategory?: string;
    userTags?: string[];
  };
}

/** 折叠正文的展开控件文案（精确匹配，避免误点「查看更多评论」「更多优质内容」）。 */
const EXPAND_LABELS = new Set(['展开', '展开全文', '展开全部', '全文', '阅读全文', '显示全部']);

/**
 * 控件文案归一：去掉两端的空白和省略号。
 *
 * 站点上折叠处渲染出来的是 `...展开全部`——省略号和文案常常在同一个元素里。
 * 按原文精确匹配就一个都命中不了，点击逻辑等于从没生效过。
 * 只剥两端的省略号，正文里带省略号的句子（`仅供参考...`）照样不会被误当成控件。
 */
function expandLabelOf(element: Element): string {
  return (element.textContent ?? '').replace(/^[\s.。·・…]+/u, '').replace(/[\s.。·・…]+$/u, '');
}

/**
 * 提取前先点开正文的「展开全文」，否则折叠的帖子只能采到截断的正文。
 * 只点文案精确匹配且可见的控件，避免误触评论区/推荐位；列表页一屏 20+ 条，上限放宽。
 * 返回是否点过——点过需要等框架完成重渲染再读 DOM。
 */
function expandCollapsedContent(limit: number): boolean {
  const candidates = [...document.querySelectorAll<HTMLElement>('button, a, span, div, p, em, i')].filter(
    element =>
      EXPAND_LABELS.has(expandLabelOf(element))
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
  let clicked = 0;
  for (const element of targets) {
    if (clicked >= limit) break;
    try {
      element.click();
      clicked += 1;
    } catch {
      // 忽略不可点击的元素。
    }
  }
  return clicked > 0;
}

/** 上一轮列表提取覆盖到的帖子节点，等 list.advance 时统一打标记。 */
let lastListContainers: Element[] = [];

/**
 * 给已处理的帖子打个**不可见**的标记，下一轮就不会重复提取它们。
 *
 * 早先的实现顺手把它们 display:none 收起（想压缩页面高度好触发懒加载），
 * 但那会让用户没法肉眼核对采到的内容对不对——验证阶段这是硬伤。
 * 加载下一批改为纯靠滚动到底触发站点自己的懒加载，页面外观一动不动。
 */
function markProcessed(): number {
  let marked = 0;
  for (const container of lastListContainers) {
    if (!container.isConnected || container.hasAttribute(COLLECTED_ATTRIBUTE)) continue;
    container.setAttribute(COLLECTED_ATTRIBUTE, '1');
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
    container.style.removeProperty('display');
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
  const candidates = scrollCandidates();
  const host = candidates[0];
  const before = host?.scrollTop ?? 0;

  jumpToLastPost();
  await humanPause(450, 900);

  // 到不了底就自己补到底：有的实现里 scrollIntoView 只把元素带到视口内。
  for (let nudge = 0; nudge < nudges; nudge += 1) {
    if (!host || atBottom(host)) break;
    const step = Math.max(host.clientHeight, 400);
    const previous = host.scrollTop;
    host.scrollTop = previous + step;
    if (host.scrollTop === previous) break;
    await humanPause(450, 1_100);
  }

  const moved = host ? host.scrollTop - before : 0;
  return { host: describe(host), moved, bottom: Boolean(host && atBottom(host)) };
}

/**
 * 推进到下一批：给已处理的帖子打上不可见标记 → 拟人滚动触发懒加载 → 等新帖子出现。
 * 返回新加载出的待采条数；为 0 表示已经到底（批量采集据此收尾）。
 */
async function advanceList(): Promise<{
  collapsed: number;
  loaded: number;
  /** 滚动实况，写进运行记录：到底滚的哪个元素、滚了多少、帖子数变没变。 */
  scroll?: string;
}> {
  const collapsed = markProcessed();
  const before = document.querySelectorAll('.topic-container').length;
  const trace: string[] = [];
  // **先回到上一批的末尾**再往下滚。页面很长（40 条帖子几万像素），
  // 从视口当前位置滚几千像素根本到不了底，懒加载永远不触发。
  if (scrollToFrontier()) trace.push('先回到上一批采到的最后一条');
  await humanPause(400, 800);

  // 「到底」才是懒加载真正会触发的地方，所以判停条件是**滚到底且没有新内容**，
  // 而不是「滚了固定几下」。步数上限只是防死循环。
  for (let round = 0; round < 6; round += 1) {
    const { host, moved, bottom } = await scrollLikeHuman().catch(
      () => ({ host: '(滚动失败)', moved: 0, bottom: false }),
    );
    await humanPause(900, 1_800);
    const after = document.querySelectorAll('.topic-container').length;
    const loaded = pendingTopicCount(document);
    trace.push(
      `第${round + 1}次滚动：目标 ${host}，位移 ${moved}px，`
      + `${bottom ? '已到底' : '未到底'}，帖子 ${before}→${after}，待采 ${loaded}`,
    );
    if (loaded > 0) return { collapsed, loaded, scroll: trace.join('；') };
    // 到底了还等不到新内容，再多给一次机会（懒加载有网络往返），仍然没有就收工。
    if (bottom) {
      await humanPause(1_200, 2_000);
      const settled = pendingTopicCount(document);
      if (settled > 0) {
        trace.push(`到底后等到新内容：待采 ${settled}`);
        return { collapsed, loaded: settled, scroll: trace.join('；') };
      }
      trace.push('已到底且等不到新内容，本页采完');
      break;
    }
    if (moved === 0) {
      trace.push('推不动任何元素，停止翻页');
      break;
    }
  }
  return { collapsed, loaded: 0, scroll: trace.join('；') };
}

/**
 * 分类标签栏（最新 / 精华 / 只看星主 / 问答…）。真实结构见诊断样本：
 * `<app-menu><div class="menu-container"><div class="item ng-star-inserted actived">精华</div>…`
 */
const MENU_ITEM = '.menu-container .item';
const MENU_ACTIVE = 'actived';

function menuLabels(): { labels: string[]; active?: string } {
  const items = [...document.querySelectorAll<HTMLElement>(MENU_ITEM)];
  const labels = items.map(item => (item.textContent ?? '').trim()).filter(Boolean);
  const active = items.find(item => item.classList.contains(MENU_ACTIVE));
  return { labels, ...(active ? { active: (active.textContent ?? '').trim() } : {}) };
}

/** 按文案重新查找并点击：Angular 切换分类时会重建这些节点，旧引用点不动。 */
function clickMenu(label: string): boolean {
  const target = [...document.querySelectorAll<HTMLElement>(MENU_ITEM)]
    .find(item => (item.textContent ?? '').trim() === label);
  if (!target) return false;
  target.click();
  return true;
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
      diagnosticsVersion: 7,
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
      diagnosticsVersion: 7,
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
          normalized: expandLabelOf(element),
          matched: EXPAND_LABELS.has(expandLabelOf(element)),
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

const alreadyRegistered = Boolean(
  (globalThis as unknown as Record<string, unknown>)[READY_FLAG],
);
(globalThis as unknown as Record<string, unknown>)[READY_FLAG] = true;

if (!alreadyRegistered) chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const request = message as Partial<ExtractMessage>;
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
    request.type !== 'list.focusLast'
  ) {
    return false;
  }

  if (request.type === 'list.refreshTopics') {
    void refreshTopicFeed().then(
      refresh => sendResponse({ ok: true, refresh }),
      () => sendResponse({ ok: true, refresh: { toggled: false } }),
    );
    return true;
  }

  if (request.type === 'list.hookStats') {
    void requestHookStats().then(hook => sendResponse({ ok: true, hook }));
    return true;
  }

  if (request.type === 'list.itemDiagnose') {
    void itemDiagnostics(String(request.key ?? '')).then(diagnostics =>
      sendResponse({ ok: true, diagnostics }),
    );
    return true;
  }

  if (request.type === 'list.diagnose') {
    void listDiagnostics().then(diagnostics => sendResponse({ ok: true, diagnostics }));
    return true;
  }

  if (request.type === 'list.focusLast') {
    // 批量结束后把视口停在采到的最后一条上，用户一眼看到进度到哪儿了。
    sendResponse({ ok: true, highlight: { found: scrollToFrontier() } });
    return false;
  }

  if (request.type === 'list.restore') {
    // mark=true 是反过来用：把本屏**标记为已处理**（采够目标条数收工时用），
    // 否则「继续采下一批」上来滚一下就又把同一屏提取一遍，永远原地打转。
    const marked = (request as { mark?: boolean }).mark === true;
    sendResponse({ ok: true, advance: { collapsed: marked ? markProcessed() : clearMarks(), loaded: 0 } });
    return false;
  }

  if (request.type === 'list.highlight') {
    sendResponse({ ok: true, highlight: highlightEntry(String(request.key ?? '')) });
    return false;
  }

  if (request.type === 'list.advance') {
    void advanceList().then(
      result => sendResponse({ ok: true, advance: result }),
      error =>
        sendResponse({
          ok: false,
          error: {
            code: 'COLLECTION_FAILED',
            message: error instanceof Error ? error.message : '翻页失败',
          },
        }),
    );
    return true;
  }

  const wantsList = request.type === 'extract.list';

  const run = (): void => {
    try {
      if (wantsList) {
        const { entries, skipped, total } = extractList(document, location.href, topics);
        // 节点留在内容脚本里（无法跨消息边界传递），等 list.advance 时统一打标记。
        lastListContainers = entries.map(entry => entry.container);
        console.info(
          `[data-collector] 本轮提取：待采 ${total} 条，可入库 ${total - skipped} 条，`
          + `跳过 ${skipped} 条，已捕获帖子号 ${topics.size} 个`,
        );
        sendResponse({
          ok: true,
          list: {
            // 捕获到的帖子号条数一并回报：为 0 时失败原因要说得具体，不能只说「适配问题」。
            captured: topics.size,
            skipped,
            total,
            items: entries.map(entry => ({
              key: entry.key,
              title: entry.title,
              ...(entry.document ? { document: entry.document } : {}),
              ...(entry.reason ? { reason: entry.reason } : {}),
            })),
          },
        });
        return;
      }
      const extracted = extractDocument(document, location.href);
      const result: CollectedDocument = {
        ...extracted,
        ...(request.overrides?.userCategory
          ? { userCategory: request.overrides.userCategory }
          : {}),
        ...(request.overrides?.userTags ? { userTags: request.overrides.userTags } : {}),
      };
      sendResponse({ ok: true, document: result });
    } catch (error) {
      sendResponse({
        ok: false,
        error: {
          code: error instanceof ExtractionError ? error.code : 'COLLECTION_FAILED',
          message: error instanceof Error ? error.message : '页面采集失败',
        },
      });
    }
  };

  // 展开后要让框架完成重渲染再读 DOM；没有可展开内容时同步返回。
  if (expandCollapsedContent(wantsList ? 40 : 20)) {
    setTimeout(run, wantsList ? 600 : 350);
    return true;
  }
  run();
  return false;
});
