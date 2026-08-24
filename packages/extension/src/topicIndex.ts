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
/** 主世界钩子与隔离世界消息的完整性协议版本。 */
export const TOPIC_HOOK_VERSION = 5;
/**
 * 主世界钩子必须与产物的**精确构建**绑定。
 *
 * 只看协议版本不够：同一版本号的两个 dirty bundle 也可能带着不同的
 * parser、留存上限和完整性语义。esbuild 会把 `__BUILD_ID__` 直接烙进 content / inject
 * 两份 bundle；源码测试没有打包宏时使用明确的「开发构建」。
 */
export const TOPIC_HOOK_BUILD_ID =
  typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : '开发构建';

/**
 * 主世界补丁的防重标记（挂在页面 window 上）。
 *
 * manifest 会在 document_start 声明式注入一次，扩展更新后后台还会对已打开的标签页
 * 补注入一次；同一页打两遍补丁会把已包装的 fetch 再包一层，每条响应重复上报。
 * 常量放这里而不是 inject.ts —— inject.ts 是经典脚本，**一个 export 都不能有**，
 * 而测试需要在用例之间清掉这个标记。
 */
export const TOPIC_HOOK_FLAG = '__dataCollectorTopicHook';
/** 稳定 transport 只安装一次，每次构建更新只替换这个当前状态。 */
export const TOPIC_STATE_KEY = '__dataCollectorTopicState';
/** 构建无关的 fetch/XHR/message transport 标记。 */
export const TOPIC_TRANSPORT_KEY = '__dataCollectorTopicTransport';

/**
 * 留存帖子号的仓库，挂在页面 window 上。
 *
 * **必须跨模块实例共享**：扩展更新 / 自愈注入会让页面里同时存在好几份 inject.js
 * 实例，各存各的就等于没存。挂在 window 上，谁来都接着同一份用。
 */
export const TOPIC_STORE_KEY = '__dataCollectorTopicStore';

/**
 * 隔离世界 → 主世界：把你攒下的帖子号**全部重放一遍**。
 *
 * 主世界钩子活在页面里，扩展重载不影响它；但内容脚本会被销毁重注入，
 * TopicIndex 是它的模块级变量，一重注入就清零。页面上的老帖子还在，
 * 它们的接口响应却是几小时前的事，不会再来一次——于是「一半能对上、一半对不上」。
 * 钩子替内容脚本把帖子号留着，重注入后要回来即可。
 */
export const TOPIC_REPLAY_REQUEST = 'data-collector:topics:replay?';

/** 隔离世界 → 主世界：要一份钩子的运行统计。 */
export const TOPIC_STATS_REQUEST = 'data-collector:topics:stats?';
/** 主世界 → 隔离世界：钩子的运行统计。 */
export const TOPIC_STATS = 'data-collector:topics:stats';

/**
 * 主世界钩子的运行统计。
 *
 * 「已捕获帖子号 0 个」有三种完全不同的成因，光看这一个数字分不出来，
 * 只能来回猜（已经绕了好几轮）：
 * - `installed: false` → 钩子压根没跑，是注入的问题；
 * - `installed: true` 但 `observed: 0` → 钩子在跑，但页面这段时间一个请求都没发
 *   （列表已经加载完，滚动也带不出新请求）——切一次分类即可；
 * - `jsonResponses > 0` 但 `withTopicId: 0` → 站点接口结构变了，得改解析。
 */
export interface HookStats {
  /** 缺失表示扩展升级前留在页面主世界的旧钩子。 */
  version?: number;
  /** 缺失表示旧构建；只有与当前 bundle 精确相同才能信任。 */
  buildId?: string;
  installed: boolean;
  /** 钩子替内容脚本留存的帖子号条数（重注入后可整批要回来）。 */
  retained?: number;
  /** 页面里跑的是更早构建留下的钩子：它在工作，但计数取不到（都是 0，别当真）。 */
  legacy?: boolean;
  /** 钩子装上的时刻（页面时间轴上的毫秒数）。 */
  installedAt?: number;
  /** 旁观到的请求总数。 */
  observed: number;
  /** 其中被当作 JSON 解析的响应数。 */
  jsonResponses: number;
  /** 其中确实解析出帖子号的响应数。 */
  withTopicId: number;
  /** 累计上报的帖子号条数。 */
  publishedRecords: number;
  /** 最近若干次响应的概况（**不含查询串**，只留路径与体量）。 */
  recent: {
    path: string;
    contentType: string;
    bytes: number;
    topicIds: number;
    /** 没解析出帖子号时，留一小段响应开头，用于判断接口结构。 */
    head?: string;
  }[];
}

export interface TopicRecordImage {
  /** 归档优先使用的最高质量地址（通常是 original）。 */
  url: string;
  /** 同一张图在列表/详情 DOM 中可能使用 large/thumbnail 等地址；只用于同图身份核验。 */
  aliases?: string[];
  alt?: string;
}

export interface TopicRecordAttachment {
  url: string;
  title?: string;
}

export interface TopicRecord {
  topicId: string;
  /**
   * 该帖的正文文本，**保持接口返回的原样**（只做长度截断）。
   *
   * 刻意不在这里归一化：归一化后就再也看不出接口到底给了什么形状，
   * 而「对不上号」的排查恰恰全靠这个。归一化交给 TopicIndex 内部做。
   */
  text: string;
  /**
   * 组成正文的各段（问答帖就是「问题」「回答」两段）。
   *
   * 必须分开索引：页面上问和答是两个独立的块，取到的往往只是其中一段；
   * 而拼接后的整段里，问与答之间的边界在页面上可能夹着「提问 / 回答」这类标签，
   * 两边就都不是对方的连续子串了。分段索引后，任意一段能对上即可。
   */
  parts?: string[];
  /**
   * 接口给的发布时间（已转成 ISO）。
   *
   * 这是发布时间**唯一可靠的来源**：页面上那行字是渲染出来的，老帖写成
   * 「23年06月18日」这种两位数年份，甚至「3天前」；而接口里是完整时间戳。
   * 对上号之后直接用它，不必再去解析页面上的字。
   */
  createTime?: string;
  /**
   * 接口给的**完整**正文（未按对号需要截断，仅有一个防爆上限）。
   *
   * 页面上的正文可能是折叠的——站点的「展开全部」没点开、或点了没生效，
   * 采到的就是半篇。接口这份从来不折叠，是补齐正文的兜底来源。
   * 只有当它确实比 `text` 长时才留，短帖不重复占内存。
   */
  fullText?: string;
  /**
   * `fullText` 是否触及防爆上限。当前钩子显式给 true/false；
   * 缺失只能视为旧协议的未知状态。
   */
  fullTextTruncated?: boolean;
  /**
   * 这份正文是否来自已核验的帖子正文端点与直接 topic schema。
   *
   * `fullTextTruncated:false` 只说明遍历没有撞到本地上限，绝不代表来源给的是全文；
   * 任意接口里的标题、评论、引用摘要仍可用于身份诊断，但不能证明正文完整。
   */
  sourceBodyProven?: boolean;
  /** 已核验正文对象中的图片/附件字段均已识别并留存；false 代表只能证明文字。 */
  sourceMediaProven?: boolean;
  /** 来源正文中的原始图片；折叠 DOM 尚未挂载尾图时由这里恢复。 */
  images?: TopicRecordImage[];
  /** 来源正文中的附件链接；没有可下载 URL 的 opaque 文件对象会让媒体证明失败。 */
  attachments?: TopicRecordAttachment[];
  /** 该帖对象的顶层字段名，诊断时用来看接口结构（不含字段值）。 */
  keys?: string[];
}

/** 同一 topic 多次出现时保留可用于归档的正文最丰富版本，而不是只比较 2000 字对号片段。 */
export function preferredTopicRecord(
  previous: TopicRecord | undefined,
  candidate: TopicRecord,
): TopicRecord {
  if (!previous) return candidate;
  const previousSourceProven = previous.sourceBodyProven === true;
  const candidateSourceProven = candidate.sourceBodyProven === true;
  // 来源已证明的正文必须留给重放与归档；任意接口里更长的同号摘要/引用不能继承
  // 这份证明，也不能在扩展重注入时把它从单条留存槽里挤掉。
  if (previousSourceProven !== candidateSourceProven) {
    return candidateSourceProven ? candidate : previous;
  }
  const previousLength = (previous.fullText ?? previous.text).length;
  const candidateLength = (candidate.fullText ?? candidate.text).length;
  let richer = candidateLength > previousLength ? candidate : previous;
  if (
    candidateLength === previousLength
    && previous.sourceMediaProven === candidate.sourceMediaProven
    && topicRecordMediaRichness(candidate) > topicRecordMediaRichness(previous)
  ) {
    richer = candidate;
  }
  if (
    candidateLength === previousLength
    && previous.sourceMediaProven !== candidate.sourceMediaProven
  ) {
    // source-proven 的 false 表示确实看见了当前构建无法留存的媒体，而不是“较弱副本”。
    // 等长时直接保留带风险的那份，既让 retained/replay 粘住风险，也尽量保留诊断现场。
    richer = candidate.sourceMediaProven === false ? candidate : previous;
  }
  // true 是“确实撞过截断上限”的正向证据；false 只表示另一次响应没撞本地上限，
  // 不能证明来源没有给摘要/字段子集，更不能让较短副本把已知尾部洗掉。
  const mediaIncomplete = previousSourceProven
    && candidateSourceProven
    && (
      previous.sourceMediaProven === false
      || candidate.sourceMediaProven === false
    );
  const withStickyMedia = (selected: TopicRecord): TopicRecord => {
    const sticky = mediaIncomplete && selected.sourceMediaProven !== false
      ? { ...selected, sourceMediaProven: false }
      : selected;
    return withCompatibleSourceImages(previous, candidate, sticky);
  };
  if (previous.fullTextTruncated === true || candidate.fullTextTruncated === true) {
    return withStickyMedia(
      richer.fullTextTruncated === true ? richer : { ...richer, fullTextTruncated: true },
    );
  }
  const previousComplete = previous.fullTextTruncated === false;
  const candidateComplete = candidate.fullTextTruncated === false;
  // 没有正向截断证据时，当前协议副本优先于旧协议未知副本。
  if (previousComplete !== candidateComplete) {
    return withStickyMedia(candidateComplete ? candidate : previous);
  }
  return withStickyMedia(richer);
}

function topicRecordMediaRichness(record: TopicRecord): number {
  return (record.images ?? []).reduce(
    (total, image) => total + 1 + (image.aliases?.length ?? 0),
    0,
  ) + (record.attachments?.length ?? 0);
}

export const TOPIC_MESSAGE_RECORD_LIMIT = 400;
export const TOPIC_MESSAGE_CHARACTER_LIMIT = 2_000_000;
const TOPIC_ID_PATTERN = /^\d{15,25}$/;
const MESSAGE_TEXT_LIMIT = 2_000;
const MESSAGE_FULL_TEXT_LIMIT = 200_000;
const MESSAGE_PART_LIMIT = 256;
const MESSAGE_IMAGE_LIMIT = 30;
const MESSAGE_IMAGE_ALIAS_LIMIT = 16;
const MESSAGE_ATTACHMENT_LIMIT = 100;
const MESSAGE_URL_LENGTH_LIMIT = 4_096;
const MESSAGE_ASSET_LABEL_LIMIT = 500;
const MESSAGE_KEY_LIMIT = 24;
const MESSAGE_KEY_LENGTH_LIMIT = 128;
const MESSAGE_TIME_LENGTH_LIMIT = 64;

interface SanitizedTopicRecord {
  record: TopicRecord;
  characters: number;
}

/**
 * `postMessage` 同页可写，build id 只是路由栅栏，不是身份认证。
 * 因此所有记录在进入常驻 TopicIndex 前都必须做 schema+内存预算校验，
 * 并且只返回可信字段的脱离副本。
 */
function sanitizeTopicRecord(value: unknown): SanitizedTopicRecord | undefined {
  if (!isRecord(value) || Array.isArray(value)) return undefined;
  const topicId = value.topicId;
  const text = value.text;
  if (typeof topicId !== 'string' || !TOPIC_ID_PATTERN.test(topicId)) return undefined;
  if (
    typeof text !== 'string'
    || text.length > MESSAGE_TEXT_LIMIT
  ) return undefined;

  let characters = topicId.length + text.length;
  const record: TopicRecord = { topicId, text };

  const partsValue = value.parts;
  if (partsValue !== undefined) {
    if (!Array.isArray(partsValue) || partsValue.length > MESSAGE_PART_LIMIT) return undefined;
    const parts: string[] = [];
    for (const part of partsValue) {
      if (
        typeof part !== 'string'
        || part.length === 0
        || part.length > MESSAGE_TEXT_LIMIT
        || part.trim().length === 0
      ) return undefined;
      characters += part.length;
      parts.push(part);
    }
    record.parts = parts;
  }

  const createTime = value.createTime;
  if (createTime !== undefined) {
    if (
      typeof createTime !== 'string'
      || createTime.length === 0
      || createTime.length > MESSAGE_TIME_LENGTH_LIMIT
    ) return undefined;
    const parsed = new Date(createTime);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== createTime) return undefined;
    characters += createTime.length;
    record.createTime = createTime;
  }

  const fullText = value.fullText;
  if (fullText !== undefined) {
    if (
      typeof fullText !== 'string'
      || fullText.length === 0
      || fullText.length > MESSAGE_FULL_TEXT_LIMIT
      || fullText.trim().length === 0
    ) return undefined;
    characters += fullText.length;
    record.fullText = fullText;
  }

  const fullTextTruncated = value.fullTextTruncated;
  // 当前 producer 对每条记录都显式给 true/false；缺失只能来自旧构建或同页伪造消息。
  // undefined 不能被下游解释成“未撞上限”，否则无来源证明的 fullText 会被当完整正文。
  if (typeof fullTextTruncated !== 'boolean') return undefined;
  record.fullTextTruncated = fullTextTruncated;

  const sourceBodyProven = value.sourceBodyProven;
  // producer 对身份型与正文型记录都显式给布尔值；缺失/字符串值一律拒绝，避免旧构建
  // 或页面同源伪消息把“未标注”偷换成完整正文。
  if (typeof sourceBodyProven !== 'boolean') return undefined;
  record.sourceBodyProven = sourceBodyProven;

  const sourceMediaProven = value.sourceMediaProven;
  if (typeof sourceMediaProven !== 'boolean') return undefined;
  record.sourceMediaProven = sourceMediaProven;

  const imagesValue = value.images;
  if (imagesValue !== undefined) {
    if (!Array.isArray(imagesValue) || imagesValue.length > MESSAGE_IMAGE_LIMIT) return undefined;
    const images: TopicRecordImage[] = [];
    for (const image of imagesValue) {
      if (!isRecord(image) || Array.isArray(image)) return undefined;
      const url = image.url;
      const alt = image.alt;
      if (typeof url !== 'string' || !isSafeAssetUrl(url)) return undefined;
      if (alt !== undefined && (
        typeof alt !== 'string'
        || alt.length === 0
        || alt.length > MESSAGE_ASSET_LABEL_LIMIT
      )) return undefined;
      const aliasesValue = image.aliases;
      let aliases: string[] | undefined;
      if (aliasesValue !== undefined) {
        if (
          !Array.isArray(aliasesValue)
          || aliasesValue.length === 0
          || aliasesValue.length > MESSAGE_IMAGE_ALIAS_LIMIT
        ) return undefined;
        aliases = [];
        const seen = new Set([url]);
        for (const alias of aliasesValue) {
          if (
            typeof alias !== 'string'
            || !isSafeAssetUrl(alias)
            || seen.has(alias)
          ) return undefined;
          seen.add(alias);
          characters += alias.length;
          aliases.push(alias);
        }
      }
      characters += url.length + (typeof alt === 'string' ? alt.length : 0);
      images.push({
        url,
        ...(aliases ? { aliases } : {}),
        ...(typeof alt === 'string' ? { alt } : {}),
      });
    }
    record.images = images;
  }

  const attachmentsValue = value.attachments;
  if (attachmentsValue !== undefined) {
    if (
      !Array.isArray(attachmentsValue)
      || attachmentsValue.length > MESSAGE_ATTACHMENT_LIMIT
    ) return undefined;
    const attachments: TopicRecordAttachment[] = [];
    for (const attachment of attachmentsValue) {
      if (!isRecord(attachment) || Array.isArray(attachment)) return undefined;
      const url = attachment.url;
      const title = attachment.title;
      if (typeof url !== 'string' || !isSafeAssetUrl(url)) return undefined;
      if (title !== undefined && (
        typeof title !== 'string'
        || title.length === 0
        || title.length > MESSAGE_ASSET_LABEL_LIMIT
      )) return undefined;
      characters += url.length + (typeof title === 'string' ? title.length : 0);
      attachments.push({ url, ...(typeof title === 'string' ? { title } : {}) });
    }
    record.attachments = attachments;
  }

  const keysValue = value.keys;
  if (keysValue !== undefined) {
    if (!Array.isArray(keysValue) || keysValue.length > MESSAGE_KEY_LIMIT) return undefined;
    const keys: string[] = [];
    for (const key of keysValue) {
      if (
        typeof key !== 'string'
        || key.length === 0
        || key.length > MESSAGE_KEY_LENGTH_LIMIT
      ) return undefined;
      characters += key.length;
      keys.push(key);
    }
    record.keys = keys;
  }
  if (
    text.trim().length === 0
    && (record.images?.length ?? 0) === 0
    && (record.attachments?.length ?? 0) === 0
  ) return undefined;
  return { record, characters };
}

/** 主世界发布/重放时按同一入口预算分批，保证自己不会生成下游必拒的巨型消息。 */
export function topicRecordMessageBatches(values: readonly TopicRecord[]): TopicRecord[][] {
  const batches: TopicRecord[][] = [];
  let batch: TopicRecord[] = [];
  let characters = 0;
  for (const value of values) {
    const sanitized = sanitizeTopicRecord(value);
    if (!sanitized || sanitized.characters > TOPIC_MESSAGE_CHARACTER_LIMIT) continue;
    if (
      batch.length >= TOPIC_MESSAGE_RECORD_LIMIT
      || (batch.length > 0 && characters + sanitized.characters > TOPIC_MESSAGE_CHARACTER_LIMIT)
    ) {
      batches.push(batch);
      batch = [];
      characters = 0;
    }
    batch.push(sanitized.record);
    characters += sanitized.characters;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/** 只接受当前精确构建的主世界钩子；旧 wrapper 消息一律丢弃。 */
export function topicRecordsFromMessage(
  value: unknown,
  expectedBuildId = TOPIC_HOOK_BUILD_ID,
): TopicRecord[] | undefined {
  try {
    if (typeof value !== 'object' || value === null) return undefined;
    const message = value as {
      source?: unknown;
      hookVersion?: unknown;
      hookBuildId?: unknown;
      records?: unknown;
    };
    if (
      message.source !== TOPIC_MESSAGE
      || message.hookVersion !== TOPIC_HOOK_VERSION
      || message.hookBuildId !== expectedBuildId
      || !Array.isArray(message.records)
      || message.records.length === 0
      || message.records.length > TOPIC_MESSAGE_RECORD_LIMIT
    ) return undefined;

    const records: TopicRecord[] = [];
    let characters = 0;
    for (const value of message.records) {
      const sanitized = sanitizeTopicRecord(value);
      if (!sanitized) return undefined;
      characters += sanitized.characters;
      if (characters > TOPIC_MESSAGE_CHARACTER_LIMIT) return undefined;
      records.push(sanitized.record);
    }
    return records;
  } catch {
    // Proxy/getter 等异常输入也只能拒绝，不能把内容脚本打崩。
    return undefined;
  }
}

/**
 * 从接口节点里取发布时间。
 *
 * 必须自带 4 位年份才认：`new Date` 对残缺输入不会失败，只会悄悄补出 2001 年
 *（见 extractors/common.ts 里那段）。这里宁可返回 undefined 让上游退回采集时间。
 */
export function createTimeOf(node: Record<string, unknown>): string | undefined {
  const raw = node.create_time ?? node.createTime;
  if (typeof raw !== 'string' || !/(?:19|20)\d{2}/.test(raw)) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
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

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * 把接口正文渲染成可归档的 HTML。
 *
 * 和 stripInlineMarkup 的分工：那个是给「对号」用的，只要能比对的纯文本；
 * 这里是正文要落盘，**外链必须留住**——星球的长文帖正文里就是一个
 * `<e type="web" href="…" title="…"/>` 指向 articles.zsxq.com，
 * 丢了它归档出来就只剩一句导语，读的人再也找不到原文。
 */
export function inlineMarkupToHtml(value: string): string {
  const attributeOf = (raw: string, name: string): string | undefined => {
    const match = new RegExp(`\\b${name}="([^"]*)"`).exec(raw);
    return match ? decodePercent(match[1] ?? '') : undefined;
  };
  /**
   * 逐段扫描：标记之外的文本转义，标记本身换成真标签。
   * 不能「先整体转义再还原」——那样正文里本来就有的 `<` 也会被一起还原成标签边界。
   */
  const inline = (segment: string): string => {
    let out = '';
    let cursor = 0;
    // 紧跟 `<` 的必须是字母，否则 `if a < b && b > c` 里的 `< b && b >`
    // 会被当成一个标记整段吞掉，正文平白少一截。
    for (const match of segment.matchAll(/<\/?[a-zA-Z][^>]*>/g)) {
      out += escapeHtml(segment.slice(cursor, match.index));
      const tag = match[0];
      const href = attributeOf(tag, 'href');
      const title = attributeOf(tag, 'title') ?? '';
      out += href ? `<a href="${escapeHtml(href)}">${escapeHtml(title || href)}</a>` : escapeHtml(title);
      cursor = match.index + tag.length;
    }
    return out + escapeHtml(segment.slice(cursor));
  };
  return value
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => `<p>${inline(line)}</p>`)
    .join('');
}

function decodePercent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // 半截的百分号编码不该让整条记录作废。
    return value;
  }
}

function isSafeAssetUrl(value: string): boolean {
  if (value.length === 0 || value.length > MESSAGE_URL_LENGTH_LIMIT) return false;
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
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

/** 诊断最长共同片段时最多比较多少字，避免一次诊断阻塞页面。 */
const MATCH_TEXT_LIMIT = 240;
/**
 * 常驻身份索引的正文长度。完整正文只在候选 key 已经命中后按需读取，避免每条记录
 * 常驻一份额外的 20 万字归一化副本。
 */
const HAYSTACK_LIMIT = 2_000;
/** 保留的接口原文长度上限；诊断展示时再截短。 */
const RAW_TEXT_LIMIT = HAYSTACK_LIMIT;
/**
 * 归档用全文的长度上限。
 *
 * 和对号用的 RAW_TEXT_LIMIT 是两回事：那个只要够定位，这个是真要落盘的正文。
 * 留个上限纯粹是防爆——页面上可能留存上百条，每条都不设限会把内存吃掉。
 */
const FULL_TEXT_LIMIT = 200_000;
const SOURCE_IMAGE_LIMIT = 30;
const SOURCE_ATTACHMENT_LIMIT = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 把一个帖子对象里能当正文的字段拼起来（talk/article/question 各有各的字段名）。 */
/** 正文的各段（问答帖会得到「问题」「回答」两段），顺序即接口给出的顺序。 */
const BODY_PART_LIMIT = 256;
const BODY_NODE_LIMIT = 1_024;
const BODY_DEPTH_LIMIT = 12;
const TOPIC_BODY_KEYS = ['talk', 'article', 'question', 'answer', 'task', 'solution'] as const;

function partsOf(node: Record<string, unknown>): { parts: string[]; truncated: boolean } {
  const parts: string[] = [];
  let visited = 0;
  let truncated = false;
  const visit = (value: unknown, depth: number): void => {
    if (depth > BODY_DEPTH_LIMIT || visited >= BODY_NODE_LIMIT || parts.length >= BODY_PART_LIMIT) {
      truncated = true;
      return;
    }
    visited += 1;
    if (typeof value === 'string') {
      // “是。”、“会。”这类短回答也是作者正文；长度阈值会静默删掉它们。
      // 这里只丢纯空白，正文长度门禁由最终文档层处理。
      if (value.trim().length > 0) parts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    for (const key of ['text', 'title', 'content', ...TOPIC_BODY_KEYS]) {
      if (key in value) visit(value[key], depth + 1);
    }
  };
  visit(node, 0);
  return { parts, truncated };
}

export interface TopicHarvestContext {
  /** 已去掉查询串的响应绝对路径，由主世界 transport 旁观所得。 */
  responsePath: string;
}

const GROUP_TOPICS_RESPONSE = /^https:\/\/api\.zsxq\.com\/v2\/groups\/\d+\/topics\/?$/u;
const TOPIC_DETAIL_RESPONSE = /^https:\/\/api\.zsxq\.com\/v2\/topics\/\d+\/?$/u;

/** 标题本身不是正文；只认已知正文容器里的 text/content。 */
function hasBodyBearingValue(value: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (typeof value === 'string') return normalizeForMatch(value).length > 0;
  if (Array.isArray(value)) return value.some(item => hasBodyBearingValue(item, depth + 1));
  if (!isRecord(value)) return false;
  for (const key of ['text', 'content']) {
    if (key in value && hasBodyBearingValue(value[key], depth + 1)) return true;
  }
  // 问答正文可能继续包在 question/answer/talk/article 中；仍不遍历 owner/comment/quote。
  for (const key of TOPIC_BODY_KEYS) {
    if (key in value && hasBodyBearingValue(value[key], depth + 1)) return true;
  }
  return false;
}

/**
 * “出现过一段正文”不等于“这个复合帖子对象已经完整”。问答/任务型端点可能先返回
 * question/task，稍后才补 answer/solution；缺任一组件时只能用于身份匹配，不能证明全文。
 */
function sourceBodySchemaComplete(candidate: Record<string, unknown>): boolean {
  const componentHasContent = (key: typeof TOPIC_BODY_KEYS[number]): boolean => {
    if (!(key in candidate)) return false;
    if (hasBodyBearingValue(candidate[key])) return true;
    const assets = sourceAssetsOf({ [key]: candidate[key] });
    return assets.proven && (assets.images.length > 0 || assets.attachments.length > 0);
  };
  const declaredType = typeof candidate.type === 'string'
    ? candidate.type.trim().toLowerCase().replace(/[\s_-]+/gu, '')
    : undefined;
  if (declaredType) {
    if (declaredType === 'talk') return componentHasContent('talk');
    if (declaredType === 'article') return componentHasContent('article');
    if (['qa', 'q&a', 'question'].includes(declaredType)) {
      return componentHasContent('question') && componentHasContent('answer');
    }
    if (declaredType === 'task') return componentHasContent('task');
    if (declaredType === 'solution') return componentHasContent('solution');
    // 新 topic 类型不能偷继承“某一已知 text 字段完整”的证明。
    return false;
  }
  const hasQuestionShape = 'question' in candidate || 'answer' in candidate;
  if (hasQuestionShape && !(
    componentHasContent('question')
    && componentHasContent('answer')
  )) return false;

  const hasTaskShape = 'task' in candidate || 'solution' in candidate;
  if ('task' in candidate && !componentHasContent('task')) return false;
  if ('solution' in candidate && !componentHasContent('solution')) return false;

  const hasStandaloneBody = (['talk', 'article'] as const).some(componentHasContent);
  return hasStandaloneBody || hasQuestionShape || hasTaskShape;
}

interface SourceAssets {
  images: TopicRecordImage[];
  attachments: TopicRecordAttachment[];
  proven: boolean;
}

/**
 * 原生 JSON.parse 会在我们看见值之前把 int64 topic_id 四舍五入。这里只重写 JSON 对象里
 * 精确名为 topic_id/topicId 的整数 token 为字符串，其他字节原样交回 JSON.parse；因此既
 * 保留精确身份，也不会把正文字符串里看起来像 JSON 的片段误改掉。
 */
export function parseTopicJson(body: string): unknown {
  let rewritten = '';
  let copiedUntil = 0;
  let cursor = 0;
  while (cursor < body.length) {
    if (body[cursor] !== '"') {
      cursor += 1;
      continue;
    }
    const tokenStart = cursor;
    cursor += 1;
    let escaped = false;
    while (cursor < body.length) {
      const character = body[cursor]!;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') break;
      cursor += 1;
    }
    if (cursor >= body.length) break;
    const tokenEnd = cursor + 1;
    let key: unknown;
    try {
      key = JSON.parse(body.slice(tokenStart, tokenEnd));
    } catch {
      cursor = tokenEnd;
      continue;
    }
    cursor = tokenEnd;
    if (key !== 'topic_id' && key !== 'topicId') continue;
    let colon = cursor;
    while (/\s/u.test(body[colon] ?? '')) colon += 1;
    if (body[colon] !== ':') continue;
    let numberStart = colon + 1;
    while (/\s/u.test(body[numberStart] ?? '')) numberStart += 1;
    const number = /^(?:0|[1-9]\d*)/u.exec(body.slice(numberStart))?.[0];
    if (!number) continue;
    const numberEnd = numberStart + number.length;
    if (!/[\s,}\]]/u.test(body[numberEnd] ?? '')) continue;
    rewritten += body.slice(copiedUntil, numberStart) + JSON.stringify(number);
    copiedUntil = numberEnd;
    cursor = numberEnd;
  }
  return JSON.parse(rewritten + body.slice(copiedUntil));
}

function normalizedAssetUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const candidate = value.startsWith('//') ? `https:${value}` : value;
  if (!isSafeAssetUrl(candidate)) return undefined;
  try {
    const url = new URL(candidate);
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

function assetLabel(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (
      typeof candidate === 'string'
      && candidate.trim().length > 0
      && candidate.length <= MESSAGE_ASSET_LABEL_LIMIT
    ) return candidate.trim();
  }
  return undefined;
}

/**
 * 同一张图片会同时给 original/large/thumbnail，列表 DOM 往往不用 original。
 * 顺序就是归档质量优先级；其余地址必须留作 exact identity aliases。
 */
const IMAGE_URL_KEYS = [
  'original', 'large', 'thumbnail', 'url', 'src', 'download_url', 'downloadUrl',
] as const;

function imageUrlsOf(value: unknown, depth = 0): string[] {
  if (depth > 3) return [];
  const direct = normalizedAssetUrl(value);
  if (direct) return [direct];
  if (!isRecord(value) || Array.isArray(value)) return [];
  const urls = new Set<string>();
  for (const key of IMAGE_URL_KEYS) {
    if (!(key in value)) continue;
    for (const nested of imageUrlsOf(value[key], depth + 1)) urls.add(nested);
  }
  return [...urls];
}

function attachmentUrlOf(value: unknown, depth = 0): string | undefined {
  if (depth > 3) return undefined;
  const direct = normalizedAssetUrl(value);
  if (direct) return direct;
  if (!isRecord(value) || Array.isArray(value)) return undefined;
  for (const key of [
    'download_url', 'downloadUrl', 'file_url', 'fileUrl', 'url', 'href', 'file',
  ]) {
    if (!(key in value)) continue;
    const nested = attachmentUrlOf(value[key], depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

/** 只遍历已知正文分支；评论/引用/作者头像绝不能混进当前帖资源。 */
function sourceAssetsOf(candidate: Record<string, unknown>): SourceAssets {
  const images = new Map<string, TopicRecordImage>();
  const attachments = new Map<string, TopicRecordAttachment>();
  let proven = true;
  let visited = 0;
  const opaqueInlineImages: Array<string | undefined> = [];
  const opaqueInlineFiles: Array<string | undefined> = [];
  const structuredImageIds = new Set<string>();
  const structuredFileIds = new Set<string>();
  let structuredImageCount = 0;
  let structuredFileCount = 0;

  const idsOf = (value: unknown): string[] => {
    if (!isRecord(value) || Array.isArray(value)) return [];
    const ids: string[] = [];
    for (const key of [
      'image_id', 'imageId', 'file_id', 'fileId', 'video_id', 'videoId',
      'audio_id', 'audioId', 'media_id', 'mediaId', 'id',
    ]) {
      const candidate = value[key];
      if (typeof candidate === 'string' || (typeof candidate === 'number' && Number.isSafeInteger(candidate))) {
        ids.push(String(candidate));
      }
    }
    return ids;
  };

  const rememberInlineAssets = (text: string): void => {
    const textOnlyTypes = new Set([
      'at', 'mention', 'user', 'topic', 'hashtag', 'emoji', 'br',
    ]);
    const imageTypes = new Set(['image', 'img', 'photo']);
    const attachmentTypes = new Set([
      'file', 'attachment', 'audio', 'voice', 'video', 'media', 'web', 'link',
    ]);
    const unsupportedComponentTypes = new Set(['card', 'poll']);
    for (const match of text.matchAll(/<[^>]*\btype="([^"]+)"[^>]*>/giu)) {
      const tag = match[0];
      const type = match[1]?.trim().toLowerCase();
      if (!type || textOnlyTypes.has(type)) continue;
      if (
        unsupportedComponentTypes.has(type)
        || (!imageTypes.has(type) && !attachmentTypes.has(type))
      ) {
        proven = false;
        continue;
      }
      const rawUrl = /\b(?:src|href|url)="([^"]+)"/iu.exec(tag)?.[1];
      const url = normalizedAssetUrl(rawUrl ? decodePercent(rawUrl) : undefined);
      if (!url) {
        // 另有结构化 images/files/audio/video 数组时，opaque inline 占位由数组承载；
        // 最终统一核对数量与 ID。
        const rawId = /\b(?:image_id|file_id|video_id|audio_id|media_id|id)="([^"]+)"/iu.exec(tag)?.[1];
        const id = rawId ? decodePercent(rawId) : undefined;
        if (imageTypes.has(type)) opaqueInlineImages.push(id);
        else opaqueInlineFiles.push(id);
        continue;
      }
      const titleRaw = /\btitle="([^"]*)"/iu.exec(tag)?.[1];
      const title = titleRaw ? decodePercent(titleRaw).trim() : undefined;
      if (imageTypes.has(type)) {
        images.set(url, { url, ...(title ? { alt: title } : {}) });
      } else {
        attachments.set(url, { url, ...(title ? { title } : {}) });
      }
    }
  };

  const visit = (value: unknown, depth: number): void => {
    if (depth > BODY_DEPTH_LIMIT || visited >= BODY_NODE_LIMIT) {
      proven = false;
      return;
    }
    visited += 1;
    if (typeof value === 'string') {
      rememberInlineAssets(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!isRecord(value)) return;

    if ('images' in value) {
      const rawImages = value.images;
      if (!Array.isArray(rawImages)) proven = false;
      else for (const rawImage of rawImages) {
        const allUrls = imageUrlsOf(rawImage);
        const retainedUrls = allUrls.slice(0, MESSAGE_IMAGE_ALIAS_LIMIT + 1);
        const [url, ...aliases] = retainedUrls;
        if (!url || images.size >= SOURCE_IMAGE_LIMIT) {
          proven = false;
          continue;
        }
        if (allUrls.length > retainedUrls.length) proven = false;
        const alt = isRecord(rawImage)
          ? assetLabel(rawImage, ['alt', 'name', 'title', 'file_name', 'fileName'])
          : undefined;
        images.set(url, {
          url,
          ...(aliases.length > 0 ? { aliases } : {}),
          ...(alt ? { alt } : {}),
        });
        structuredImageCount += 1;
        for (const id of idsOf(rawImage)) structuredImageIds.add(id);
      }
    }

    if ('files' in value || 'attachments' in value) {
      for (const key of ['files', 'attachments'] as const) {
        if (!(key in value)) continue;
        const rawFiles = value[key];
        if (!Array.isArray(rawFiles)) {
          proven = false;
          continue;
        }
        for (const rawFile of rawFiles) {
          const url = attachmentUrlOf(rawFile);
          if (!url || attachments.size >= SOURCE_ATTACHMENT_LIMIT) {
            proven = false;
            continue;
          }
          const title = isRecord(rawFile)
            ? assetLabel(rawFile, ['name', 'title', 'file_name', 'fileName'])
            : undefined;
          attachments.set(url, { url, ...(title ? { title } : {}) });
          structuredFileCount += 1;
          for (const id of idsOf(rawFile)) structuredFileIds.add(id);
        }
      }
    }

    for (const key of ['audio', 'audios', 'video', 'videos'] as const) {
      if (!(key in value)) continue;
      const rawMedia = Array.isArray(value[key]) ? value[key] : [value[key]];
      for (const rawItem of rawMedia) {
        const url = attachmentUrlOf(rawItem);
        if (!url || attachments.size >= SOURCE_ATTACHMENT_LIMIT) {
          proven = false;
          continue;
        }
        const title = isRecord(rawItem)
          ? assetLabel(rawItem, ['name', 'title', 'file_name', 'fileName'])
          : undefined;
        attachments.set(url, {
          url,
          title: title ?? (key.startsWith('audio') ? '音频' : '视频'),
        });
        structuredFileCount += 1;
        for (const id of idsOf(rawItem)) structuredFileIds.add(id);
      }
    }

    const recognized = new Set([
      'text', 'title', 'content', ...TOPIC_BODY_KEYS,
      'images', 'files', 'attachments', 'audio', 'audios', 'video', 'videos',
    ]);
    for (const [key, nested] of Object.entries(value)) {
      if (recognized.has(key)) continue;
      if (!/(?:media|component|attachment|file|image|audio|video|voice|poll|card)/iu.test(key)) {
        continue;
      }
      // image_count/file_size/video_duration 等只是已知资源的数值元数据；它们本身不是
      // 另一份尚未解析的媒体节点。其它未知标量（尤其 *_id/*_url）和复合值都必须拒绝证明。
      const normalizedKey = key.replace(/[^a-z0-9]/giu, '').toLowerCase();
      if (
        /(?:count|size|width|height|duration|length|bytes|bitrate)$/u.test(normalizedKey)
        && !isRecord(nested)
        && !Array.isArray(nested)
      ) {
        continue;
      }
      if (nested !== null && nested !== undefined) proven = false;
    }

    for (const key of ['text', 'content', ...TOPIC_BODY_KEYS]) {
      if (key in value) visit(value[key], depth + 1);
    }
  };

  visit(candidate, 0);
  if (
    opaqueInlineImages.length > structuredImageCount
    || opaqueInlineImages.some(id => id !== undefined && !structuredImageIds.has(id))
  ) {
    proven = false;
  }
  if (
    opaqueInlineFiles.length > structuredFileCount
    || opaqueInlineFiles.some(id => id !== undefined && !structuredFileIds.has(id))
  ) {
    proven = false;
  }
  return { images: [...images.values()], attachments: [...attachments.values()], proven };
}

function topicIdOf(value: unknown): string | undefined {
  if (typeof value === 'string' && /^\d+$/u.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return undefined;
}

function sourceBodyNodes(
  payload: unknown,
  context: TopicHarvestContext | undefined,
): ReadonlySet<Record<string, unknown>> {
  const proven = new Set<Record<string, unknown>>();
  if (!context || !isRecord(payload)) return proven;
  if (payload.succeeded !== true) return proven;
  const responseData = isRecord(payload.resp_data)
    ? payload.resp_data
    : isRecord(payload.data) ? payload.data : undefined;
  if (!responseData) return proven;

  let directTopics: unknown[] = [];
  if (GROUP_TOPICS_RESPONSE.test(context.responsePath)) {
    directTopics = Array.isArray(responseData.topics) ? responseData.topics : [];
  } else if (TOPIC_DETAIL_RESPONSE.test(context.responsePath)) {
    directTopics = isRecord(responseData.topic)
      ? [responseData.topic]
      : ('topic_id' in responseData || 'topicId' in responseData) ? [responseData] : [];
  }
  for (const candidate of directTopics) {
    if (!isRecord(candidate)) continue;
    const rawId = candidate.topic_id ?? candidate.topicId;
    if (topicIdOf(rawId) && sourceBodySchemaComplete(candidate)) proven.add(candidate);
  }
  return proven;
}

/**
 * 深度遍历任意 JSON，收集所有带 topic_id 的对象。
 * 遍历有节点数上限，避免超大响应把内容脚本卡住。
 */
export function harvestTopics(
  payload: unknown,
  limit = 400,
  context?: TopicHarvestContext,
): TopicRecord[] {
  const found: TopicRecord[] = [];
  const provenBodyNodes = sourceBodyNodes(payload, context);
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

    const rawId = topicIdOf(node.topic_id ?? node.topicId);
    if (rawId) {
      // 必须留足长度：接口正文和页面文本常常**开头就不一样**，
      // 截太短等于把「整段包含」这条退路也砍掉了。
      const extractedBody = partsOf(node);
      const rawParts = extractedBody.parts;
      const parts = rawParts.map(part => part.slice(0, RAW_TEXT_LIMIT));
      const text = parts.join(' ').slice(0, RAW_TEXT_LIMIT);
      // 对号只需要前若干字，归档要的是全文，两者分开留。
      const rawFullText = rawParts.join('\n\n');
      const fullTextTruncated = extractedBody.truncated || rawFullText.length > FULL_TEXT_LIMIT;
      const fullText = rawFullText.slice(0, FULL_TEXT_LIMIT);
      const sourceBodyProven = provenBodyNodes.has(node);
      const assets = sourceBodyProven
        ? sourceAssetsOf(node)
        : { images: [], attachments: [], proven: false };
      if (
        normalizeForMatch(text)
        || assets.images.length > 0
        || assets.attachments.length > 0
      ) {
        const createTime = createTimeOf(node);
        found.push({
          topicId: rawId,
          text,
          parts,
          ...(createTime ? { createTime } : {}),
          ...(fullText.length > text.length ? { fullText } : {}),
          fullTextTruncated,
          sourceBodyProven,
          sourceMediaProven: sourceBodyProven && assets.proven,
          ...(assets.images.length > 0 ? { images: assets.images } : {}),
          ...(assets.attachments.length > 0 ? { attachments: assets.attachments } : {}),
          keys: Object.keys(node).slice(0, 24),
        });
      }
    }
    for (const value of Object.values(node)) queue.push(value);
  }
  return found;
}

/**
 * 允许凭明确折叠控件做「同起点截断」判断的最短长度。更短的套话不足以证明身份；
 * 完整相等不受这个限制。
 */
const MIN_CONTAINS = 20;

/**
 * 文本 → 帖子号。同一条帖子可能在多次响应里重复出现；不同帖子也可能共享同一个
 * 24 字前缀，所以索引必须保留全部候选，不能让后到的帖子覆盖先到的身份。
 *
 * 24 字只用于找到候选，绝不是身份结论。最终只认两类可证明证据：归一化正文完整相等；
 * 或页面明确带折叠控件时，控件前正文是接口正文的同起点前缀。任意标题、引用、转发前后缀
 * 都不算证据——未捕获的 B 完全可能引用已捕获 A 的全文，按普通包含会把 B 写到 A 的 URL。
 *
 * 仍有歧义（多条都包含得上）时返回 undefined，让该条如实计入「已跳过」。**绝不猜。**
 */
export type TopicIdentityEvidence =
  | { status: 'unique'; topicId: string }
  | { status: 'ambiguous' }
  | { status: 'none' };

function sourceRecordBody(record: TopicRecord): string {
  return normalizeForMatch(record.fullText ?? record.text, FULL_TEXT_LIMIT);
}

function imageVariantUrls(image: TopicRecordImage): Set<string> {
  return new Set([image.url, ...(image.aliases ?? [])]);
}

function sameSourceImages(
  left: readonly TopicRecordImage[],
  right: readonly TopicRecordImage[],
): boolean {
  if (left.length !== right.length) return false;
  const unmatched = new Set(right.map((_image, index) => index));
  for (const leftImage of left) {
    const leftUrls = imageVariantUrls(leftImage);
    const matches = [...unmatched].filter(index => (
      [...imageVariantUrls(right[index]!)].some(url => leftUrls.has(url))
    ));
    // 一个 URL 同时落到多张结构化图片也不能猜它们的对应关系。
    if (matches.length !== 1) return false;
    unmatched.delete(matches[0]!);
  }
  return unmatched.size === 0;
}

/** 同图多次响应可能各自只带部分 URL 规格；按选中记录顺序补齐，且不突破消息预算。 */
function withCompatibleSourceImages(
  previous: TopicRecord,
  candidate: TopicRecord,
  selected: TopicRecord,
): TopicRecord {
  if (
    previous.sourceMediaProven !== true
    || candidate.sourceMediaProven !== true
    || !sameSourceRecord(previous, candidate)
  ) return selected;
  const selectedImages = selected.images ?? [];
  if (selectedImages.length === 0) return selected;
  const sourceImageGroups = [previous.images ?? [], candidate.images ?? []];
  let changed = false;
  const images = selectedImages.map(image => {
    const variants = imageVariantUrls(image);
    const urls = [image.url, ...(image.aliases ?? [])];
    const seen = new Set(urls);
    let alt = image.alt;
    for (const sourceImages of sourceImageGroups) {
      const matches = sourceImages.filter(sourceImage => (
        [...imageVariantUrls(sourceImage)].some(url => variants.has(url))
      ));
      if (matches.length !== 1) continue;
      const companion = matches[0]!;
      for (const url of [companion.url, ...(companion.aliases ?? [])]) {
        if (seen.has(url) || urls.length >= MESSAGE_IMAGE_ALIAS_LIMIT + 1) continue;
        seen.add(url);
        variants.add(url);
        urls.push(url);
        changed = true;
      }
      if (!alt && companion.alt) {
        alt = companion.alt;
        changed = true;
      }
    }
    const [url, ...aliases] = urls;
    return {
      url: url!,
      ...(aliases.length > 0 ? { aliases } : {}),
      ...(alt ? { alt } : {}),
    };
  });
  return changed ? { ...selected, images } : selected;
}

function sameSourceAttachments(
  left: readonly TopicRecordAttachment[],
  right: readonly TopicRecordAttachment[],
): boolean {
  if (left.length !== right.length) return false;
  const leftUrls = left.map(attachment => attachment.url).sort();
  const rightUrls = right.map(attachment => attachment.url).sort();
  return leftUrls.every((url, index) => url === rightUrls[index]);
}

function sameSourceRecord(left: TopicRecord, right: TopicRecord): boolean {
  if (sourceRecordBody(left) !== sourceRecordBody(right)) return false;
  // 一份响应还不认识媒体、另一份已经完整解析时让后者升级证明；只有两份都自称完整却
  // 给出不同资源集合才是不可消解的版本冲突。
  if (left.sourceMediaProven === true && right.sourceMediaProven === true) {
    return sameSourceImages(left.images ?? [], right.images ?? [])
      && sameSourceAttachments(left.attachments ?? [], right.attachments ?? []);
  }
  return true;
}

export class TopicIndex {
  private readonly byText = new Map<string, Set<string>>();
  private readonly byImageUrl = new Map<string, Set<string>>();
  /** 完整正文 → 帖子号候选，供诊断展示。 */
  private readonly byFullText = new Map<string, Set<string>>();
  /** 帖子号 → 所有可核对的较长正文证据，用于共同前缀后的严格消歧。 */
  private readonly evidenceByTopic = new Map<string, Set<string>>();
  /** 帖子号 → 原始记录，只为诊断保留（find 不看它）。 */
  private readonly raw = new Map<string, TopicRecord>();
  /** 帖子号 → 仅来自已核验正文端点/schema 的记录；归档完整性只能读这里。 */
  private readonly sourceBodies = new Map<string, TopicRecord>();
  /** 同一帖子号出现互不相同的“完整来源”时，不猜哪个版本当前有效。 */
  private readonly sourceBodyConflicts = new Set<string>();
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
    for (const [normalized, topicIds] of this.byText) {
      for (const topicId of topicIds) {
        if (out.length >= limit) return out;
        out.push({ topicId, normalized });
      }
    }
    return out;
  }

  /**
   * 对上号之后取这条帖子的发布时间（接口给的完整时间戳）。
   * 接口没给就返回 undefined，由调用方退回解析页面上那行字。
   */
  publishedAtOf(topicId: string): string | undefined {
    return this.raw.get(topicId)?.createTime;
  }

  /** 接口给的完整正文；短帖直接复用对号文本，长帖使用单独保留的全文。 */
  fullTextOf(topicId: string): string | undefined {
    const record = this.raw.get(topicId);
    return record?.fullText ?? record?.text;
  }

  /** 已核验来源的正文；任意接口中的同号标题/引用/评论摘要永远不会从这里返回。 */
  sourceBodyOf(topicId: string): string | undefined {
    if (this.sourceBodyConflicts.has(topicId)) return undefined;
    const record = this.sourceBodies.get(topicId);
    return record?.fullText ?? record?.text;
  }

  /** 已核验来源里的图片；只有正文版本无冲突时才可用于归档。 */
  sourceImagesOf(topicId: string): readonly TopicRecordImage[] {
    if (this.sourceBodyConflicts.has(topicId)) return [];
    return this.sourceBodies.get(topicId)?.images ?? [];
  }

  /** 已核验来源里的附件；opaque 文件对象不会从这里冒充已留存。 */
  sourceAttachmentsOf(topicId: string): readonly TopicRecordAttachment[] {
    if (this.sourceBodyConflicts.has(topicId)) return [];
    return this.sourceBodies.get(topicId)?.attachments ?? [];
  }

  sourceMediaProvenOf(topicId: string): boolean {
    return !this.sourceBodyConflicts.has(topicId)
      && this.sourceBodies.get(topicId)?.sourceMediaProven === true;
  }

  /** 当前精确 hook build 是否真的捕获过这个帖子号；详情页完整证明不能只靠稳定 DOM。 */
  has(topicId: string): boolean {
    return this.raw.has(topicId);
  }

  /** 当前精确 hook 是否从已知正文端点/schema 捕获过这篇帖子的直接正文对象。 */
  hasSourceBody(topicId: string): boolean {
    return this.sourceBodies.has(topicId) && !this.sourceBodyConflicts.has(topicId);
  }

  sourceBodyConflicted(topicId: string): boolean {
    return this.sourceBodyConflicts.has(topicId);
  }

  /** 接口全文是否因本地防爆上限而被裁剪。 */
  fullTextTruncatedOf(topicId: string): boolean {
    return this.raw.get(topicId)?.fullTextTruncated === true;
  }

  /** 已核验来源正文是否撞到本地留存/结构上限。 */
  sourceBodyTruncatedOf(topicId: string): boolean {
    return this.sourceBodies.get(topicId)?.fullTextTruncated === true;
  }

  add(records: readonly TopicRecord[]): void {
    for (const record of records) {
      const haystack = normalizeForMatch(record.text, HAYSTACK_LIMIT);
      const hasAssets = (record.images?.length ?? 0) > 0
        || (record.attachments?.length ?? 0) > 0;
      if (!haystack && !hasAssets) continue;
      if (!this.raw.has(record.topicId)) this.count += 1;
      // text、归档全文和问答各段都可能是页面实际渲染出来的那一块。全部保留为证据；
      // 相同 key / 相同正文下面记录候选集合，绝不按响应先后覆盖身份。
      const evidence = [record.text, ...(record.fullText ? [record.fullText] : []), ...(record.parts ?? [])];
      for (const value of evidence) {
        const normalized = normalizeForMatch(value, HAYSTACK_LIMIT);
        if (!normalized) continue;
        this.addCandidate(this.byFullText, normalized, record.topicId);
        this.addCandidate(this.evidenceByTopic, record.topicId, normalized);
        this.addCandidate(this.byText, normalized.slice(0, 24), record.topicId);
      }
      if (record.sourceBodyProven === true) {
        for (const image of record.images ?? []) {
          for (const url of [image.url, ...(image.aliases ?? [])]) {
            const normalized = normalizedAssetUrl(url);
            if (normalized) this.addCandidate(this.byImageUrl, normalized, record.topicId);
          }
        }
      }
      this.raw.set(record.topicId, preferredTopicRecord(this.raw.get(record.topicId), record));
      if (record.sourceBodyProven === true) {
        const previous = this.sourceBodies.get(record.topicId);
        if (previous && !sameSourceRecord(previous, record)) {
          this.sourceBodyConflicts.add(record.topicId);
        }
        this.sourceBodies.set(
          record.topicId,
          preferredTopicRecord(previous, record),
        );
      }
    }
  }

  private addCandidate(index: Map<string, Set<string>>, key: string, value: string): void {
    const candidates = index.get(key) ?? new Set<string>();
    candidates.add(value);
    index.set(key, candidates);
  }

  /**
   * key 命中后只凭可证明的正文证据消歧：完整相等，或明确折叠控件前的同起点前缀。
   * 普通连续包含不是证据——转发帖可以逐字引用另一篇全文。
   */
  private resolveByIdentityEvidence(
    text: string,
    topicIds: ReadonlySet<string>,
  ): TopicIdentityEvidence {
    // 平时索引仍只留 2000 字；候选 key 命中后才展开长正文做核对，既能看见
    // 2000 字之后的差异，也不让每条记录常驻一份额外的 20 万字索引。
    const haystack = normalizeForMatch(text, FULL_TEXT_LIMIT);
    const pageEvidence: { normalized: string; visiblyTruncated: boolean }[] = [
      { normalized: haystack, visiblyTruncated: false },
    ];
    // 多字控件本身足够明确，textContent 即使紧贴正文也可识别；单字“展开”和“全文”
    // 必须有空白/省略号/句号等 DOM 文本边界，不能把作者正文合法尾词直接删掉。
    const controlPatterns = [
      /(?:展开全部|展开全文|阅读全文|显示全部)(?:\s*点赞\s*\d*)?\s*$/u,
      /[.…。.!！?？·・\s]+(?:展开|全文)(?:\s*点赞\s*\d*)?\s*$/u,
    ];
    for (const pattern of controlPatterns) {
      const withoutControl = text.replace(pattern, '');
      if (withoutControl === text) continue;
      const normalized = normalizeForMatch(withoutControl, FULL_TEXT_LIMIT);
      if (normalized) pageEvidence.push({ normalized, visiblyTruncated: true });
    }
    let bestLength = 0;
    let bestTopicId: string | undefined;
    let tied = false;
    for (const topicId of topicIds) {
      let topicLength = 0;
      let exactText = false;
      const evidence = new Set(this.evidenceByTopic.get(topicId) ?? []);
      const record = this.raw.get(topicId);
      for (const value of record
        ? [record.text, ...(record.fullText ? [record.fullText] : []), ...(record.parts ?? [])]
        : []) {
        const normalized = normalizeForMatch(value, FULL_TEXT_LIMIT);
        if (normalized) evidence.add(normalized);
      }
      for (const candidate of evidence) {
        for (const page of pageEvidence) {
          if (candidate === page.normalized) {
            exactText = true;
            topicLength = Math.max(topicLength, page.normalized.length);
            continue;
          }
          if (!page.visiblyTruncated || !candidate.startsWith(page.normalized)) continue;
          topicLength = Math.max(topicLength, page.normalized.length);
        }
      }
      // 短文本不足以做“包含”推断，但完整相等仍是精确证据。
      if (topicLength < MIN_CONTAINS && !exactText) continue;
      if (topicLength > bestLength) {
        bestLength = topicLength;
        bestTopicId = topicId;
        tied = false;
      } else if (topicLength === bestLength) {
        tied = true;
      }
    }
    if (!bestTopicId) return { status: 'none' };
    return tied ? { status: 'ambiguous' } : { status: 'unique', topicId: bestTopicId };
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
    const scored = [...this.byFullText].flatMap(([apiNormalized, topicIds]) => (
      [...topicIds].map(topicId => {
        const record = this.raw.get(topicId);
        return {
          topicId,
          // 只在前 240 字上算，够看出问题，也不至于让一次点击卡住。
          overlap: longestCommonSubstring(page, apiNormalized.slice(0, MATCH_TEXT_LIMIT)),
          rawApiText: (record?.text ?? '').slice(0, 400),
          apiNormalized: apiNormalized.slice(0, MATCH_TEXT_LIMIT),
          ...(record?.keys ? { apiKeys: record.keys } : {}),
        };
      })
    ));
    scored.sort((a, b) => b.overlap - a.overlap);
    return { pageNormalized: page, candidates: scored.slice(0, limit) };
  }

  /**
   * 用页面正文核验 topic 身份，并保留“没有证据”与“证据有歧义”的区别。
   * 这个状态只供覆盖/标记门禁使用；判定规则与 find 完全相同，不新增任何宽松匹配。
   */
  identityEvidence(text: string): TopicIdentityEvidence {
    const lookupTexts = new Set([text]);
    for (const pattern of [
      /(?:展开全部|展开全文|阅读全文|显示全部)(?:\s*点赞\s*\d*)?\s*$/u,
      /[.…。.!！?？·・\s]+(?:展开|全文)(?:\s*点赞\s*\d*)?\s*$/u,
    ]) {
      const withoutControl = text.replace(pattern, '');
      if (withoutControl !== text) lookupTexts.add(withoutControl);
    }

    const hits = new Set<string>();
    for (const lookupText of lookupTexts) {
      const key = normalizeForMatch(lookupText, HAYSTACK_LIMIT).slice(0, 24);
      if (!key) continue;
      for (const topicId of this.byText.get(key) ?? []) hits.add(topicId);
      // 开头一致、一长一短（折叠、尾部多了控件）仍只收集候选；最终由完整正文
      // 核验并防歧义，绝不按插入顺序猜一个 id。
      for (const [candidate, topicIds] of this.byText) {
        if (!candidate.startsWith(key) && !key.startsWith(candidate)) continue;
        for (const topicId of topicIds) hits.add(topicId);
      }
    }
    return hits.size > 0
      ? this.resolveByIdentityEvidence(text, hits)
      : { status: 'none' };
  }

  /** 用页面节点的正文找回帖子号；找不到或有歧义都返回 undefined（绝不猜）。 */
  find(text: string): string | undefined {
    const evidence = this.identityEvidence(text);
    return evidence.status === 'unique' ? evidence.topicId : undefined;
  }

  /** 图片-only 帖没有可比正文；只凭已核验来源里的 exact 图片 URL，歧义时仍拒绝猜。 */
  findByImageUrls(values: readonly string[]): TopicIdentityEvidence {
    const hits = new Set<string>();
    for (const value of values) {
      const normalized = normalizedAssetUrl(value);
      if (!normalized) continue;
      for (const topicId of this.byImageUrl.get(normalized) ?? []) hits.add(topicId);
    }
    if (hits.size === 0) return { status: 'none' };
    if (hits.size > 1) return { status: 'ambiguous' };
    return { status: 'unique', topicId: [...hits][0]! };
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
