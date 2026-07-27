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
  /** 该帖的正文文本（用于和页面上的节点对上号）。 */
  text: string;
}

/**
 * 文本归一：去掉空白和标点，只留前若干字符。
 *
 * 接口里的正文和页面上渲染出来的未必逐字一致（换行、缩进、零宽字符、
 * 标点全半角差异都可能出现），去掉这些噪声再比才对得上。
 * 保留的仍是 24 个实义字符，撞车风险可以忽略。
 */
export function normalizeForMatch(value: string, length = 24): string {
  return value
    .replace(/\s+/g, '')
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/[\u3000-\u303f\uff00-\uff65!-/:-@[-`{-~]/g, '')
    .slice(0, length);
}

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
      const text = normalizeForMatch(textOf(node), 40);
      if (text) found.push({ topicId: String(rawId), text });
    }
    for (const value of Object.values(node)) queue.push(value);
  }
  return found;
}

/**
 * 文本 → 帖子号。同一条帖子可能在多次响应里重复出现，后到的覆盖先到的没有坏处。
 * 匹配用「归一化后的前缀」而不是全等：页面上的正文可能被折叠、带上「展开」等附加文案。
 */
export class TopicIndex {
  private readonly byText = new Map<string, string>();
  private count = 0;

  /** 已收录的帖子数（诊断用：为 0 说明一次接口响应都没捕获到）。 */
  get size(): number {
    return this.count;
  }

  add(records: readonly TopicRecord[]): void {
    for (const record of records) {
      const key = normalizeForMatch(record.text);
      if (!key) continue;
      if (!this.byText.has(key)) this.count += 1;
      this.byText.set(key, record.topicId);
    }
  }

  /** 用页面节点的正文找回帖子号；找不到返回 undefined（该条如实计入跳过）。 */
  find(text: string): string | undefined {
    const key = normalizeForMatch(text);
    if (!key) return undefined;
    const exact = this.byText.get(key);
    if (exact) return exact;
    // 页面正文与接口正文可能一长一短（折叠、外围文案），互为前缀或包含即认为是同一条。
    // 比的是 24 个实义字符，误配概率可以忽略；对不上就返回 undefined，绝不猜。
    for (const [candidate, topicId] of this.byText) {
      if (candidate.startsWith(key) || key.startsWith(candidate)) return topicId;
      if (key.includes(candidate) || candidate.includes(key)) return topicId;
    }
    return undefined;
  }
}
