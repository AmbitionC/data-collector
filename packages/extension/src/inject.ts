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
import { TOPIC_HOOK_FLAG, TOPIC_MESSAGE, harvestTopics, type TopicRecord } from './topicIndex.js';

// 本文件**不能导出任何东西**：内容脚本按经典脚本执行，打包产物里留下 export 会
// 直接语法错误，整个补丁一行都不会跑（这个坑已经踩过一次，靠 e2e 才发现）。

function publish(records: TopicRecord[]): void {
  if (!records.length) return;
  window.postMessage({ source: TOPIC_MESSAGE, records }, window.location.origin);
}

function absorb(body: string): void {
  // 只处理看起来像 JSON 的响应，避免在大段 HTML 上做无谓解析。
  if (!body || (body[0] !== '{' && body[0] !== '[')) return;
  try {
    publish(harvestTopics(JSON.parse(body)));
  } catch {
    // 不是 JSON 就算了。
  }
}

function patchFetch(): void {
  const original = window.fetch;
  if (typeof original !== 'function') return;
  window.fetch = function patched(this: unknown, ...args: Parameters<typeof fetch>) {
    const result = original.apply(this as never, args);
    void result
      .then(response => {
        // 必须 clone：直接读会把响应体消费掉，页面自己就拿不到了。
        const type = response.headers.get('content-type') ?? '';
        if (!type.includes('json')) return;
        return response.clone().text().then(absorb);
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
    this.addEventListener('load', () => {
      try {
        if (this.responseType === '' || this.responseType === 'text') absorb(this.responseText);
        else if (this.responseType === 'json') publish(harvestTopics(this.response));
      } catch {
        // 读不到响应体就跳过。
      }
    });
    return open.apply(this, args);
  } as typeof open;
}

// 防重复打补丁，理由见 TOPIC_HOOK_FLAG。
const store = window as unknown as Record<string, unknown>;
if (!store[TOPIC_HOOK_FLAG]) {
  store[TOPIC_HOOK_FLAG] = true;
  patchFetch();
  patchXhr();
}
