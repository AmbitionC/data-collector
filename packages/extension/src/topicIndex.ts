/**
 * 帖子号索引：知识星球把帖子号留在组件状态里，DOM 上一个都没有
 * （实测：无 <a>、无 data-*、整棵子树没有 15 位以上数字）。
 * 唯一还能拿到身份的地方，是应用**自己**发出的接口响应。
 *
 * 这里定义与页面无关的纯逻辑，好让它能被单测覆盖：
 * - harvestTopics：从任意形状的 JSON 里挖出 { topicId, text } 记录；
 * - TopicIndex：按正文文本把 DOM 节点对回帖子号。
 *
 * 不假设接口的具体 schema —— 只认「对象里有 topic_id」这一条，
 * 这样接口字段调整了也不会立刻失效（上一次照着猜的结构改，已经错过一轮）。
 */

/**
 * 主世界脚本 → 隔离世界内容脚本的消息标识。
 *
 * 放在这个无副作用的模块里，是因为内容脚本不能从 inject.ts 引它：
 * 那样 esbuild 会把打补丁的代码一并打进 content.js，而 inject.js 里会留下
 * `export {...}` —— 内容脚本按经典脚本执行，带 export 会直接语法错误、整个文件不运行。
 */
export const TOPIC_MESSAGE = 'data-collector:topics';

/**
 * 主世界补丁的防重标记（挂在页面 window 上）。
 *
 * manifest 会在 document_start 声明式注入一次，扩展更新后后台还会对已打开的标签页
 * 补注入一次；同一页打两遍补丁会把已包装的 fetch 再包一层，每条响应重复上报。
 * 常量放这里而不是 inject.ts —— inject.ts 是经典脚本，**一个 export 都不能有**，
 * 而测试需要在用例之间清掉这个标记。
 */
export const TOPIC_HOOK_FLAG = '__dataCollectorTopicHook';

export interface TopicRecord {
  topicId: string;
  /**
   * 该帖的正文文本，**保持接口返回的原样**（只做长度截断）。
   *
   * 刻意不在这里归一化：归一化后就再也看不出接口到底给了什么形状，
   * 而「对不上号」的排查恰恰全靠这个。归一化交给 TopicIndex 内部做。
   */
  text: string;
  /** 该帖对象的顶层字段名，诊断时用来看接口结构（不含字段值）。 */
  keys?: string[];
}

/**
 * 去掉知识星球正文里的内联标记，换回它在页面上**显示出来的**样子。
 *
 * 接口返回的 `talk.text` 不是纯文本，话题标签、@提及、外链都是内联标记，形如
 * `<e type="hashtag" hid="123" title="%23投资%23" />`；页面上渲染出来的却是「#投资#」。
 * 不还原的话，凡是以话题标签开头的帖子（星球里非常常见）在接口侧的开头是
 * `etypehashtaghid…`，和页面文本从第一个字就对不上——这正是「20 条只对上 4 条」的成因。
 */
export function stripInlineMarkup(value: string): string {
  return value
    // 带 title 的内联标记：把 title 里被 URL 编码的可见文字换回来。
    .replace(/<[^>]*\btitle="([^"]*)"[^>]*>/g, (_match, title: string) => decodePercent(title))
    // 其余标记整块丢掉（表情、图片占位之类，页面上不是文字）。
    .replace(/<[^>]*>/g, ' ');
}

function decodePercent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // 半截的百分号编码不该让整条记录作废。
    return value;
  }
}

/**
 * 文本归一：去掉内联标记、空白和标点，只留前若干字符。
 *
 * 接口里的正文和页面上渲染出来的未必逐字一致（换行、缩进、零宽字符、
 * 标点全半角差异都可能出现），去掉这些噪声再比才对得上。
 */
export function normalizeForMatch(value: string, length = 24): string {
  return stripInlineMarkup(value)
    .replace(/\s+/g, '')
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/[\u3000-\u303f\uff00-\uff65!-/:-@[-`{-~]/g, '')
    .slice(0, length);
}

/**
 * 「拿去找」的那段文字有多长（needle）。够长足以唯一定位，又不至于处处不匹配。
 */
const MATCH_TEXT_LIMIT = 240;
/**
 * 「被查找」的那段文字有多长（haystack）。**必须明显长于 needle。**
 *
 * 曾经两边都截到 240 字再判断「整段包含」——那样只要接口正文开头多一点点东西
 * （标题、引用块、标记残留），接口侧保留的正文就比页面侧短一截，两边互相都不可能包含，
 * 于是所有超过 240 字的帖子全都对不上（实测 20 条只对上 4 条，对上的那几条是开头
 * 恰好一模一样、走了前面的前缀路径）。needle 短、haystack 长，才有得比。
 */
const HAYSTACK_LIMIT = 2_000;
/** 保留的接口原文长度上限；诊断展示时再截短。 */
const RAW_TEXT_LIMIT = HAYSTACK_LIMIT;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 把一个帖子对象里能当正文的字段拼起来（talk/article/question 各有各的字段名）。 */
function textOf(node: Record<string, unknown>): string {
  const parts: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 3 || parts.length > 8) return;
    if (typeof value === 'string') {
      if (value.length >= 4) parts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 4)) visit(item, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    for (const key of ['text', 'title', 'content', 'talk', 'article', 'question', 'answer']) {
      if (key in value) visit(value[key], depth + 1);
    }
  };
  visit(node, 0);
  return parts.join(' ');
}

/**
 * 深度遍历任意 JSON，收集所有带 topic_id 的对象。
 * 遍历有节点数上限，避免超大响应把内容脚本卡住。
 */
export function harvestTopics(payload: unknown, limit = 400): TopicRecord[] {
  const found: TopicRecord[] = [];
  const seen = new Set<unknown>();
  const queue: unknown[] = [payload];
  let visited = 0;

  while (queue.length && visited < 5_000 && found.length < limit) {
    const node = queue.shift();
    visited += 1;
    if (Array.isArray(node)) {
      for (const item of node) queue.push(item);
      continue;
    }
    if (!isRecord(node) || seen.has(node)) continue;
    seen.add(node);

    const rawId = node.topic_id ?? node.topicId;
    if (typeof rawId === 'number' || (typeof rawId === 'string' && /^\d+$/.test(rawId))) {
      // 必须留足长度：接口正文和页面文本常常**开头就不一样**，
      // 截太短等于把「整段包含」这条退路也砍掉了。
      const text = textOf(node).slice(0, RAW_TEXT_LIMIT);
      if (normalizeForMatch(text)) {
        found.push({ topicId: String(rawId), text, keys: Object.keys(node).slice(0, 24) });
      }
    }
    for (const value of Object.values(node)) queue.push(value);
  }
  return found;
}

/**
 * 允许做「包含」判断的最短长度。归一化后已去掉空白标点，24 个实义字符是一整句话的量级；
 * 再短就可能是套话，包含关系不足以证明是同一条。
 */
const MIN_CONTAINS = 24;

/**
 * 文本 → 帖子号。同一条帖子可能在多次响应里重复出现，后到的覆盖先到的没有坏处。
 *
 * 为什么不能只比开头 24 个字：接口正文和页面文本经常**开头就不一样**——话题标签在
 * 接口里是内联标记（已由 stripInlineMarkup 还原）、引用块的位置也可能不同，
 * 页面上的正文有时是从帖子中段开始渲染的。只比截断后的前缀，结果是大部分帖子对不上号
 * （实测 20 条只对上 4 条）。
 *
 * 所以额外允许「整段包含」：两边的完整正文只要一方是另一方的**连续子串**，就是同一条。
 * 这条规则刻意选得很严——只容忍截断和外围文案，**不容忍任何一个字的差异**。
 * 曾经试过放宽成「共有一段足够长的文字」，结果「第三条…」被判成了「第二条…」
 * （两者只差一个字），两条内容会写进同一个文件——误配比漏配严重得多。
 *
 * 仍有歧义（多条都包含得上）时返回 undefined，让该条如实计入「已跳过」。**绝不猜。**
 */
export class TopicIndex {
  private readonly byText = new Map<string, string>();
  /** 完整正文 → 帖子号，用于「整段包含」这条退路。 */
  private readonly byFullText = new Map<string, string>();
  /** 帖子号 → 原始记录，只为诊断保留（find 不看它）。 */
  private readonly raw = new Map<string, TopicRecord>();
  private count = 0;

  /** 已收录的帖子数（诊断用：为 0 说明一次接口响应都没捕获到）。 */
  get size(): number {
    return this.count;
  }

  /**
   * 诊断样本：接口那边归一化后长什么样。
   * 对不上号时，把它和页面文本摆在一起看，一眼就知道是哪里对不上——
   * 光报一个「已捕获 N 个」根本没法定位。
   */
  samples(limit = 4): { topicId: string; normalized: string }[] {
    const out: { topicId: string; normalized: string }[] = [];
    for (const [normalized, topicId] of this.byText) {
      if (out.length >= limit) break;
      out.push({ topicId, normalized });
    }
    return out;
  }

  add(records: readonly TopicRecord[]): void {
    for (const record of records) {
      const haystack = normalizeForMatch(record.text, HAYSTACK_LIMIT);
      const key = haystack.slice(0, 24);
      if (!key) continue;
      if (!this.byText.has(key)) this.count += 1;
      this.byText.set(key, record.topicId);
      this.byFullText.set(haystack, record.topicId);
      this.raw.set(record.topicId, record);
    }
  }

  /**
   * 「这一条为什么没对上」的证据包。
   *
   * 不做任何猜测，只把双方摆出来：页面文本、接口原文（未归一化，能看出内联标记）、
   * 两者归一化后的样子，以及最长共同片段有多长。有了它就能一眼判断是
   * 「接口压根没返回这条」「标记没还原干净」还是「字段顺序不同」——
   * 靠猜已经绕了太多圈。
   */
  diagnose(text: string, limit = 5): {
    pageNormalized: string;
    candidates: {
      topicId: string;
      overlap: number;
      rawApiText: string;
      apiNormalized: string;
      apiKeys?: string[];
    }[];
  } {
    const page = normalizeForMatch(text, MATCH_TEXT_LIMIT);
    const scored = [...this.byFullText].map(([apiNormalized, topicId]) => {
      const record = this.raw.get(topicId);
      return {
        topicId,
        // 只在前 240 字上算，够看出问题，也不至于让一次点击卡住。
        overlap: longestCommonSubstring(page, apiNormalized.slice(0, MATCH_TEXT_LIMIT)),
        rawApiText: (record?.text ?? '').slice(0, 400),
        apiNormalized: apiNormalized.slice(0, MATCH_TEXT_LIMIT),
        ...(record?.keys ? { apiKeys: record.keys } : {}),
      };
    });
    scored.sort((a, b) => b.overlap - a.overlap);
    return { pageNormalized: page, candidates: scored.slice(0, limit) };
  }

  /** 用页面节点的正文找回帖子号；找不到返回 undefined（该条如实计入跳过）。 */
  find(text: string): string | undefined {
    const haystack = normalizeForMatch(text, HAYSTACK_LIMIT);
    const key = haystack.slice(0, 24);
    if (!key) return undefined;
    const exact = this.byText.get(key);
    if (exact) return exact;
    // 开头一致、一长一短（折叠、尾部多了「展开」之类）——同一条。
    for (const [candidate, topicId] of this.byText) {
      if (candidate.startsWith(key) || key.startsWith(candidate)) return topicId;
    }
    // 开头对不上：只认「一方的开头整段出现在另一方里」。
    // needle 取 240 字、haystack 留 2000 字，两边都截同一长度是比不出来的（见 HAYSTACK_LIMIT）。
    const needle = haystack.slice(0, MATCH_TEXT_LIMIT);
    if (needle.length < MIN_CONTAINS) return undefined;
    const hits = new Set<string>();
    for (const [candidate, topicId] of this.byFullText) {
      const candidateNeedle = candidate.slice(0, MATCH_TEXT_LIMIT);
      if (candidateNeedle.length < MIN_CONTAINS) continue;
      // 双向：页面正文出现在接口正文里（接口开头多了东西），
      // 或接口正文出现在页面正文里（页面开头多了东西）。仍然一个字都不容差。
      if (candidate.includes(needle) || haystack.includes(candidateNeedle)) hits.add(topicId);
      if (hits.size > 1) return undefined;
    }
    return hits.size === 1 ? [...hits][0] : undefined;
  }
}

/**
 * 最长共同子串的长度。只用于诊断排序，不参与 find 的判定——
 * 「有一段共同文字」不足以证明是同一条（只差一个字的两条帖子共同片段也很长）。
 */
function longestCommonSubstring(a: string, b: string): number {
  if (!a || !b) return 0;
  let best = 0;
  let previous = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Uint16Array(b.length + 1);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] !== b[j - 1]) continue;
      current[j] = (previous[j - 1] ?? 0) + 1;
      if (current[j]! > best) best = current[j]!;
    }
    previous = current;
  }
  return best;
}
