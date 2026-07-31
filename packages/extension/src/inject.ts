/**
 * 页面主世界脚本：捕获知识星球应用自己发出的接口响应，取出每条帖子的 topic_id。
 *
 * 为什么需要它：帖子号完全不在 DOM 上（实测无链接、无 data-*、整棵子树没有长数字），
 * 而批量入库要求每条帖子带自己的地址，否则 21 条会算出同一个内容 ID 相互覆盖。
 * 应用自己的接口响应是唯一还能拿到身份的地方。
 *
 * 边界：
 * - 只**旁观**页面已经发出的请求，不额外发请求、不读 Cookie、不碰凭证；
 * - 只取 topic_id 和用于对号的正文文本，其余字段一律不外传；
 * - 只在知识星球域名下注入（manifest 里限定），结果通过 postMessage 交给隔离世界。
 */
import {
  TOPIC_HOOK_FLAG,
  TOPIC_MESSAGE,
  TOPIC_STATS,
  TOPIC_STATS_REQUEST,
  harvestTopics,
  type HookStats,
  type TopicRecord,
} from './topicIndex.js';

// 本文件**不能导出任何东西**：内容脚本按经典脚本执行，打包产物里留下 export 会
// 直接语法错误，整个补丁一行都不会跑（这个坑已经踩过一次，靠 e2e 才发现）。

/** 最近响应概况保留几条：够判断接口结构，又不至于把整页内容塞进剪贴板。 */
const RECENT_LIMIT = 12;
/** 没解析出帖子号时留多长的响应开头，用于看接口结构。 */
const HEAD_LIMIT = 200;

const stats: HookStats = {
  installed: true,
  observed: 0,
  jsonResponses: 0,
  withTopicId: 0,
  publishedRecords: 0,
  recent: [],
};

function publish(records: TopicRecord[]): void {
  if (!records.length) return;
  stats.publishedRecords += records.length;
  window.postMessage({ source: TOPIC_MESSAGE, records }, window.location.origin);
}

/** 只留来源与路径，**丢掉查询串**——里面可能带着会话相关的参数。 */
function safePath(input: string): string {
  try {
    const url = new URL(input, window.location.href);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '(无法解析的地址)';
  }
}

function note(path: string, contentType: string, body: string, topicIds: number): void {
  stats.recent.push({
    path,
    contentType,
    bytes: body.length,
    topicIds,
    // 有帖子号就说明这条没问题，不必留正文；没有才需要看看它长什么样。
    ...(topicIds === 0 ? { head: body.slice(0, HEAD_LIMIT) } : {}),
  });
  if (stats.recent.length > RECENT_LIMIT) stats.recent.shift();
}

function absorb(body: string, path: string, contentType: string): void {
  stats.observed += 1;
  // 只处理看起来像 JSON 的响应，避免在大段 HTML 上做无谓解析。
  if (!body || (body[0] !== '{' && body[0] !== '[')) {
    note(path, contentType, body ?? '', 0);
    return;
  }
  stats.jsonResponses += 1;
  try {
    const records = harvestTopics(JSON.parse(body));
    if (records.length > 0) stats.withTopicId += 1;
    note(path, contentType, body, records.length);
    publish(records);
  } catch {
    // 不是 JSON 就算了。
    note(path, contentType, body, 0);
  }
}

function patchFetch(): void {
  const original = window.fetch;
  if (typeof original !== 'function') return;
  window.fetch = function patched(this: unknown, ...args: Parameters<typeof fetch>) {
    const result = original.apply(this as never, args);
    const requested = safePath(
      typeof args[0] === 'string' ? args[0] : (args[0] as Request | URL).toString(),
    );
    void result
      .then(response => {
        // 必须 clone：直接读会把响应体消费掉，页面自己就拿不到了。
        const type = response.headers.get('content-type') ?? '';
        if (!type.includes('json')) {
          stats.observed += 1;
          note(requested, type, '', 0);
          return;
        }
        return response.clone().text().then(body => absorb(body, requested, type));
      })
      .catch(() => undefined);
    return result;
  } as typeof fetch;
}

function patchXhr(): void {
  const open = XMLHttpRequest.prototype.open;
  if (typeof open !== 'function') return;
  XMLHttpRequest.prototype.open = function patchedOpen(
    this: XMLHttpRequest,
    ...args: Parameters<XMLHttpRequest['open']>
  ) {
    const requested = safePath(String(args[1] ?? ''));
    this.addEventListener('load', () => {
      try {
        const type = this.getResponseHeader('content-type') ?? '';
        if (this.responseType === '' || this.responseType === 'text') {
          absorb(this.responseText, requested, type);
        } else if (this.responseType === 'json') {
          stats.observed += 1;
          stats.jsonResponses += 1;
          const records = harvestTopics(this.response);
          if (records.length > 0) stats.withTopicId += 1;
          note(requested, type, JSON.stringify(this.response ?? '').slice(0, 1_000), records.length);
          publish(records);
        } else {
          stats.observed += 1;
          note(requested, type, '', 0);
        }
      } catch {
        // 读不到响应体就跳过。
      }
    });
    return open.apply(this, args);
  } as typeof open;
}

const store = window as unknown as Record<string, unknown>;
const existing = store[TOPIC_HOOK_FLAG];

// 防重复打补丁，理由见 TOPIC_HOOK_FLAG。
if (!existing) {
  stats.installedAt = Math.round(performance.now());
  patchFetch();
  patchXhr();
}

/**
 * 把统计对象挂在标记位上（老版本挂的是 `true`）。
 *
 * 这样后注入的新版本能接手老版本留下的统计；接不到（老版本没留）就如实标 legacy，
 * 说明「钩子在跑，但它是旧版构建，计数拿不到」——绝不能因此报成「钩子没在运行」。
 */
const shared: HookStats = isHookStats(existing) ? existing : stats;
if (existing && !isHookStats(existing)) shared.legacy = true;
store[TOPIC_HOOK_FLAG] = shared;

/**
 * 应答统计查询。**必须无条件注册**，不能只在「这次真的打了补丁」时才注册——
 * 扩展更新后页面里留着的是老版本补丁，新注入的这份会跳过补丁流程；
 * 若连监听也一起跳过，隔离世界就问不到任何东西，于是把「钩子其实在跑」
 * 误报成「钩子没在运行」，把人引向完全错误的处置方向（实测踩过）。
 */
window.addEventListener('message', event => {
  if (event.source !== window) return;
  if ((event.data as { source?: unknown })?.source !== TOPIC_STATS_REQUEST) return;
  window.postMessage({ source: TOPIC_STATS, stats: shared }, window.location.origin);
});

function isHookStats(value: unknown): value is HookStats {
  return typeof value === 'object' && value !== null && 'observed' in value;
}
