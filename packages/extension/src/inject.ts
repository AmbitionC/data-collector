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
  TOPIC_HOOK_BUILD_ID,
  TOPIC_HOOK_VERSION,
  TOPIC_MESSAGE,
  TOPIC_REPLAY_REQUEST,
  TOPIC_STATS,
  TOPIC_STATS_REQUEST,
  TOPIC_STATE_KEY,
  TOPIC_STORE_KEY,
  TOPIC_TRANSPORT_KEY,
  TopicIndex,
  harvestTopics,
  parseTopicJson,
  type HookStats,
  type TopicRecord,
  preferredTopicRecord,
  topicRecordMessageBatches,
} from './topicIndex.js';

// 本文件**不能导出任何东西**：内容脚本按经典脚本执行，打包产物里留下 export 会
// 直接语法错误，整个补丁一行都不会跑（这个坑已经踩过一次，靠 e2e 才发现）。

/** 最近响应概况保留几条：够判断接口结构，又不至于把整页内容塞进剪贴板。 */
const RECENT_LIMIT = 12;
/** 没解析出帖子号时留多长的响应开头，用于看接口结构。 */
const HEAD_LIMIT = 200;

/**
 * 钩子替内容脚本留存的帖子号。
 *
 * 内容脚本一被重注入（扩展更新、自愈注入）就丢掉全部索引，而页面上的老帖子还在、
 * 它们的接口响应不会重来——不留一份的话，那些帖子从此永远对不上号。
 * 正常重复按帖子号去重留 preferred 副本；已确认冲突的帖子额外留一条见证。
 * 两者都按 topic 数设硬上限，不会随同一 topic 的版本数无限增长。
 */
const store = window as unknown as Record<string, unknown>;
const existingState = store[TOPIC_STATE_KEY];
const currentHook = isHookState(existingState)
  && existingState.hookVersion === TOPIC_HOOK_VERSION
  && existingState.hookBuildId === TOPIC_HOOK_BUILD_ID;
const retained = currentHook ? existingState.records : new Map<string, TopicRecord>();
/**
 * 每个已冲突 topic 只多留一条见证，和 retained 里的冻结副本组成最早的冲突对。
 * TopicIndex 的冲突是粘性的；保住这一对就足以让内容脚本重建后恢复 fail-closed，
 * 同时把最坏内存限制在每 topic 两条，而不是保留无限版本历史。
 */
const conflictWitnesses = currentHook
  ? existingState.conflictWitnesses
  : new Map<string, TopicRecord>();
const stats: HookStats = currentHook ? existingState.stats : {
  version: TOPIC_HOOK_VERSION,
  buildId: TOPIC_HOOK_BUILD_ID,
  installed: true,
  installedAt: Math.round(performance.now()),
  observed: 0,
  jsonResponses: 0,
  withTopicId: 0,
  publishedRecords: 0,
  recent: [],
};
/** 留存上限：够覆盖一次长会话翻过的所有帖子，又不至于把内存吃光。 */
const RETAIN_LIMIT = 800;

function remember(records: readonly TopicRecord[]): void {
  for (const record of records) {
    const previous = retained.get(record.topicId);
    if (!previous) {
      // 新 topic 超限只跳过自己；同批后面可能是已留存 topic 的冲突/风险升级，
      // 用 return 会让这些粘性安全证据在内容脚本重建后丢失。
      if (retained.size >= RETAIN_LIMIT) continue;
      retained.set(record.topicId, record);
      continue;
    }
    // 冲突在 TopicIndex 中一旦出现就不会自行消失。冻结最早的一对见证，既不会被
    // 后续 preferred 副本洗掉，也不会因同 topic 反复更新而无限增长。
    if (conflictWitnesses.has(record.topicId)) continue;
    const preferred = preferredTopicRecord(previous, record);
    if (sourceRecordsConflict(previous, record)) {
      if (sourceRecordsConflict(preferred, previous)) {
        retained.set(record.topicId, preferred);
        conflictWitnesses.set(record.topicId, previous);
      } else if (sourceRecordsConflict(preferred, record)) {
        retained.set(record.topicId, preferred);
        conflictWitnesses.set(record.topicId, record);
      } else {
        // preferred 未来若改变合并语义，仍以原始冲突对 fail-closed，绝不丢证明。
        retained.set(record.topicId, previous);
        conflictWitnesses.set(record.topicId, record);
      }
      continue;
    }
    if (preferred === previous) continue;
    retained.set(record.topicId, preferred);
  }
}

/** 与内容脚本 TopicIndex 使用同一判定，避免留存层另造一套“兼容”语义。 */
function sourceRecordsConflict(previous: TopicRecord, candidate: TopicRecord): boolean {
  if (
    previous.topicId !== candidate.topicId
    || previous.sourceBodyProven !== true
    || candidate.sourceBodyProven !== true
  ) return false;
  const index = new TopicIndex();
  index.add([previous, candidate]);
  return index.sourceBodyConflicted(previous.topicId);
}

function publish(records: TopicRecord[]): number {
  const batches = topicRecordMessageBatches(records);
  const safeRecords = batches.flat();
  if (!safeRecords.length) return 0;
  stats.publishedRecords += safeRecords.length;
  remember(safeRecords);
  for (const batch of batches) {
    window.postMessage({
      source: TOPIC_MESSAGE,
      hookVersion: TOPIC_HOOK_VERSION,
      hookBuildId: TOPIC_HOOK_BUILD_ID,
      records: batch,
    }, window.location.origin);
  }
  return safeRecords.length;
}

/** 把留存的帖子号交还内容脚本，同时按条数和总字符预算分批。 */
function replay(): void {
  const records: TopicRecord[] = [];
  for (const [topicId, record] of retained) {
    records.push(record);
    const witness = conflictWitnesses.get(topicId);
    if (witness) records.push(witness);
  }
  for (const batch of topicRecordMessageBatches(records)) {
    window.postMessage({
      source: TOPIC_MESSAGE,
      hookVersion: TOPIC_HOOK_VERSION,
      hookBuildId: TOPIC_HOOK_BUILD_ID,
      records: batch,
    }, window.location.origin);
  }
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

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  // Request#toString() 是 "[object Request]"，会让已知正文端点退化成未知来源。
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  const url = (input as { url?: unknown }).url;
  return typeof url === 'string' ? url : String(input);
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
    const records = harvestTopics(parseTopicJson(body), 400, { responsePath: path });
    const published = publish(records);
    if (published > 0) stats.withTopicId += 1;
    note(path, contentType, body, published);
  } catch {
    // 不是 JSON 就算了。
    note(path, contentType, body, 0);
  }
}

function absorbJson(payload: unknown, path: string, contentType: string): void {
  stats.observed += 1;
  stats.jsonResponses += 1;
  try {
    const records = harvestTopics(payload, 400, { responsePath: path });
    const published = publish(records);
    if (published > 0) stats.withTopicId += 1;
    const preview = JSON.stringify(payload ?? '').slice(0, 1_000);
    note(path, contentType, preview, published);
  } catch {
    note(path, contentType, '', 0);
  }
}

const state: HookState = currentHook ? existingState : {
  hookVersion: TOPIC_HOOK_VERSION,
  hookBuildId: TOPIC_HOOK_BUILD_ID,
  stats,
  records: retained,
  conflictWitnesses,
  absorb,
  absorbJson,
  replay,
};

// `TOPIC_STATE_KEY` 是 transport 每次响应时唯一读取的 current delegate。
// JS 同一任务内的这组赋值不会被网络回调插入，新构建不会暴露半更新状态。
store[TOPIC_STATE_KEY] = state;
store[TOPIC_STORE_KEY] = {
  hookVersion: state.hookVersion,
  hookBuildId: state.hookBuildId,
  records: state.records,
} satisfies TopicStore;
store[TOPIC_HOOK_FLAG] = state.stats;

ensureTransport();

/**
 * fetch/XHR 运输层与具体构建解析语义分离。它只安装一次，响应到达时再读
 * `TOPIC_STATE_KEY` 下的当前 delegate。A→B→C 更新因此不会叠 wrapper，也不会继续写 A/B Map。
 * 首次部署到已存在历史 wrapper 的老页面时无法拆掉闭包，只会在它外面增加这一层；
 * 从此所有新构建都复用同一 transport。
 */
function ensureTransport(): void {
  const installed = store[TOPIC_TRANSPORT_KEY];
  if (isInstalledTransport(installed)) return;

  const transport: TopicTransport = { version: 2 };
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    const fetchWrapper = function stableTopicFetch(
      this: unknown,
      ...args: Parameters<typeof fetch>
    ) {
      const result = originalFetch.apply(this as never, args);
      let requested = '(无法解析的地址)';
      try {
        requested = safePath(requestUrl(args[0]));
      } catch {
        // 旁观逻辑绝不得改变页面自己的 fetch 结果。
      }
      void result.then(response => {
        const type = response.headers.get('content-type') ?? '';
        if (!type.includes('json')) {
          currentStateFor(transport)?.absorb('', requested, type);
          return;
        }
        // 必须 clone：直接读会把响应体消费掉，页面自己就拿不到了。
        return response.clone().text().then(body => {
          currentStateFor(transport)?.absorb(body, requested, type);
        });
      }).catch(() => undefined);
      return result;
    } as typeof fetch;
    transport.fetchWrapper = fetchWrapper;
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  if (typeof originalOpen === 'function') {
    const paths = new WeakMap<XMLHttpRequest, string>();
    const observed = new WeakSet<XMLHttpRequest>();
    const losslessJson = new WeakMap<XMLHttpRequest, LosslessXhrJsonState>();
    const responseTypeDescriptor = inheritedDescriptor(XMLHttpRequest.prototype, 'responseType');
    const responseDescriptor = inheritedDescriptor(XMLHttpRequest.prototype, 'response');
    const responseTextDescriptor = inheritedDescriptor(XMLHttpRequest.prototype, 'responseText');

    const nativeResponseText = (xhr: XMLHttpRequest): string | undefined => {
      try {
        const value = responseTextDescriptor?.get?.call(xhr);
        return typeof value === 'string' ? value : undefined;
      } catch {
        return undefined;
      }
    };

    const prepareLosslessJson = (xhr: XMLHttpRequest, path: string): void => {
      const eligible = /^https:\/\/api\.zsxq\.com\/v2\/(?:groups\/\d+\/topics|topics\/\d+)\/?$/u
        .test(path);
      const existing = losslessJson.get(xhr);
      if (existing) {
        existing.eligible = eligible;
        existing.requestedType = responseTypeDescriptor?.get?.call(xhr) as XMLHttpRequestResponseType;
        delete existing.parsedRaw;
        delete existing.parsed;
        return;
      }
      if (
        !eligible
        || typeof responseTypeDescriptor?.get !== 'function'
        || typeof responseTypeDescriptor.set !== 'function'
        || typeof responseDescriptor?.get !== 'function'
        || typeof responseTextDescriptor?.get !== 'function'
      ) return;
      const state: LosslessXhrJsonState = {
        eligible: true,
        requestedType: responseTypeDescriptor.get.call(xhr) as XMLHttpRequestResponseType,
      };
      try {
        Object.defineProperties(xhr, {
          responseType: {
            configurable: true,
            get() {
              return state.eligible
                ? state.requestedType
                : responseTypeDescriptor.get!.call(xhr);
            },
            set(value: XMLHttpRequestResponseType) {
              responseTypeDescriptor.set!.call(xhr, state.eligible && value === 'json' ? 'text' : value);
              // 原生 setter 可能因时机/同步 XHR 拒绝赋值；只有它成功后才提交逻辑状态，
              // 否则页面 catch 后再读 responseType 会看到一个从未真正生效的值。
              state.requestedType = value;
              delete state.parsedRaw;
              delete state.parsed;
            },
          },
          response: {
            configurable: true,
            get() {
              if (!state.eligible || state.requestedType !== 'json') {
                return responseDescriptor.get!.call(xhr);
              }
              // 原生 responseType=json 在 DONE 前恒为 null。底层改成 text 只为旁观原始
              // int64，绝不能因此把 LOADING 阶段已经可解析的半途响应提前暴露给页面。
              if (xhr.readyState !== 4) return null;
              const raw = nativeResponseText(xhr);
              if (raw === undefined || raw.length === 0) return null;
              if (state.parsedRaw !== raw) {
                state.parsedRaw = raw;
                try {
                  // 页面仍看见原生 JSON.parse 的普通 number/string 形状；只有旁观副本保留 int64。
                  state.parsed = JSON.parse(raw);
                } catch {
                  state.parsed = null;
                }
              }
              return state.parsed;
            },
          },
          responseText: {
            configurable: true,
            get() {
              if (state.eligible && state.requestedType === 'json') {
                throw new DOMException(
                  'The value is only accessible if the object responseType is empty or text',
                  'InvalidStateError',
                );
              }
              return responseTextDescriptor.get!.call(xhr);
            },
          },
        });
        losslessJson.set(xhr, state);
      } catch {
        // 某些浏览器若不允许实例级 accessor，继续 fail-closed；绝不发布已四舍五入的 id。
      }
    };
    const xhrOpenWrapper = function stableTopicOpen(
      this: XMLHttpRequest,
      ...args: Parameters<XMLHttpRequest['open']>
    ) {
      const path = safePath(String(args[1] ?? ''));
      paths.set(this, path);
      if (!observed.has(this)) {
        observed.add(this);
        this.addEventListener('load', () => {
          const active = currentStateFor(transport);
          if (!active) return;
          try {
            const type = this.getResponseHeader('content-type') ?? '';
            const path = paths.get(this) ?? '(无法解析的地址)';
            if (this.responseType === '' || this.responseType === 'text') {
              active.absorb(this.responseText, path, type);
            } else if (this.responseType === 'json') {
              const raw = losslessJson.has(this) ? nativeResponseText(this) : undefined;
              if (raw !== undefined) active.absorb(raw, path, type);
              else active.absorbJson(this.response, path, type);
            } else {
              active.absorb('', path, type);
            }
          } catch {
            // 读不到响应体就跳过。
          }
        });
      }
      const result = originalOpen.apply(this, args);
      prepareLosslessJson(this, path);
      return result;
    } as typeof XMLHttpRequest.prototype.open;
    transport.xhrOpenWrapper = xhrOpenWrapper;
  }

  // 先准备完整 token，再一次发布为当前 transport。旧 transport 的回调会因 token 不同立即失效。
  store[TOPIC_TRANSPORT_KEY] = transport;
  if (transport.fetchWrapper) window.fetch = transport.fetchWrapper;
  if (transport.xhrOpenWrapper) XMLHttpRequest.prototype.open = transport.xhrOpenWrapper;

  window.addEventListener('message', event => {
    if (event.source !== window || store[TOPIC_TRANSPORT_KEY] !== transport) return;
    const active = currentStateFor(transport);
    if (!active) return;
    try {
      const request = event.data as {
        source?: unknown;
        hookVersion?: unknown;
        hookBuildId?: unknown;
      };
      if (
        request?.hookVersion !== active.hookVersion
        || request.hookBuildId !== active.hookBuildId
      ) return;
      if (request.source === TOPIC_REPLAY_REQUEST) {
        active.replay();
        return;
      }
      if (request.source !== TOPIC_STATS_REQUEST) return;
      active.stats.retained = active.records.size;
      window.postMessage({
        source: TOPIC_STATS,
        hookVersion: active.hookVersion,
        hookBuildId: active.hookBuildId,
        stats: active.stats,
      }, window.location.origin);
    } catch {
      // 同页消息不可信；畸形 getter/Proxy 只能被忽略。
    }
  });
}

function currentStateFor(transport: TopicTransport): HookState | undefined {
  if (store[TOPIC_TRANSPORT_KEY] !== transport) return undefined;
  const candidate = store[TOPIC_STATE_KEY];
  return isHookState(candidate) ? candidate : undefined;
}

interface HookState {
  hookVersion: number;
  hookBuildId: string;
  stats: HookStats;
  records: Map<string, TopicRecord>;
  conflictWitnesses: Map<string, TopicRecord>;
  absorb(body: string, path: string, contentType: string): void;
  absorbJson(payload: unknown, path: string, contentType: string): void;
  replay(): void;
}

function isHookState(value: unknown): value is HookState {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<HookState>;
  return typeof candidate.hookVersion === 'number'
    && typeof candidate.hookBuildId === 'string'
    && typeof candidate.stats === 'object'
    && candidate.stats !== null
    && candidate.records instanceof Map
    && candidate.conflictWitnesses instanceof Map
    && typeof candidate.absorb === 'function'
    && typeof candidate.absorbJson === 'function'
    && typeof candidate.replay === 'function';
}

interface TopicTransport {
  version: 2;
  fetchWrapper?: typeof fetch;
  xhrOpenWrapper?: typeof XMLHttpRequest.prototype.open;
}

function isInstalledTransport(value: unknown): value is TopicTransport {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<TopicTransport>;
  return candidate.version === 2
    && (candidate.fetchWrapper === undefined || candidate.fetchWrapper === window.fetch)
    && (
      candidate.xhrOpenWrapper === undefined
      || candidate.xhrOpenWrapper === XMLHttpRequest.prototype.open
    );
}

interface LosslessXhrJsonState {
  eligible: boolean;
  requestedType: XMLHttpRequestResponseType;
  parsedRaw?: string;
  parsed?: unknown;
}

function inheritedDescriptor(
  value: object,
  name: PropertyKey,
): PropertyDescriptor | undefined {
  for (let current: object | null = value; current; current = Object.getPrototypeOf(current) as object | null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) return descriptor;
  }
  return undefined;
}

interface TopicStore {
  hookVersion: number;
  hookBuildId: string;
  records: Map<string, TopicRecord>;
}
