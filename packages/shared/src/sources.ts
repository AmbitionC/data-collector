import type { ContentKind, Source } from './model.js';

/**
 * 来源描述符：一个来源的声明式定义，作为 URL 校验、规范化、协议校验、
 * 本机库目录与收件箱目录命名、以及提取器分派的单一真相源。
 *
 * 新增一个来源 = 在 SOURCE_REGISTRY 里加一条描述符 + 在扩展侧写一个提取器，
 * 不再需要在 model / url / protocol / extractors 四处分别改硬编码。
 */
export interface SourceDescriptor {
  /** 来源标识，与 SOURCES 一致。 */
  readonly id: Source;
  /** 展示名，同时用作本机库与收件箱的目录名（如“微信公众号”）。 */
  readonly label: string;
  /** 判断某主机名（已小写）是否属于该来源。 */
  matchHost(host: string): boolean;
  /**
   * 规范化 URL 时保留的查询参数（其余全部丢弃）。
   * 空数组表示该来源的身份在 path 段中（如牛客的帖子 id），只保留路径。
   */
  readonly identityParams: readonly string[];
  /** 该来源允许的内容类型。 */
  readonly kinds: readonly ContentKind[];
  /** 缺省内容类型。 */
  readonly defaultKind: ContentKind;
}

const WECHAT_HOST = 'mp.weixin.qq.com';
const ZSXQ_HOST = 'wx.zsxq.com';
const NOWCODER_HOST = 'www.nowcoder.com';

/**
 * 来源注册表。键必须覆盖 SOURCES 的每一项（编译期强制）。
 */
export const SOURCE_REGISTRY: Record<Source, SourceDescriptor> = {
  wechat: {
    id: 'wechat',
    label: '微信公众号',
    matchHost: host => host === WECHAT_HOST,
    identityParams: ['__biz', 'mid', 'idx', 'sn', 'chksm'],
    kinds: ['article'],
    defaultKind: 'article',
  },
  zsxq: {
    id: 'zsxq',
    label: '知识星球',
    matchHost: host => host === ZSXQ_HOST || host.endsWith('.zsxq.com'),
    identityParams: ['topic_id', 'group_id', 'article_id', 'question_id', 'answer_id'],
    kinds: ['article', 'post', 'question', 'answer'],
    defaultKind: 'post',
  },
  nowcoder: {
    id: 'nowcoder',
    label: '牛客网',
    matchHost: host =>
      host === NOWCODER_HOST || host === 'nowcoder.com' || host.endsWith('.nowcoder.com'),
    // 牛客面经身份在 path（/discuss/<id>、/feed/main/detail/<id>），查询参数全为跟踪参数。
    identityParams: [],
    kinds: ['post'],
    defaultKind: 'post',
  },
};

/**
 * 页面是否是「一屏多条」的列表 / 信息流（当前只有知识星球是这种形态）。
 *
 * 列表页不能当成一篇存档（会把 21 条帖子糊成一条），只能批量拆成多条各自入库；
 * 这是「单页保存」与「批量保存」分流的唯一判据，扩展、侧栏、提取器都用它。
 */
export function isListPage(url: URL): boolean {
  const descriptor = descriptorForHost(url.hostname);
  if (descriptor?.id !== 'zsxq') return false;
  // 详情页形如 /group/<群号>/topic/<帖子号>；分组 / 分类 / 精华页没有 /topic/ 段。
  return !/\/topic\/[^/]+/.test(url.pathname);
}

/**
 * 该页面是否需要主世界的帖子号钩子（inject.js）。
 *
 * 只有知识星球把帖子号藏在自己的接口响应里（DOM 上完全找不到），所以也只有它需要
 * MAIN world 补丁。其余来源一律不注入，注入面保持最小 —— manifest 里的声明式注入
 * 和后台补注入必须用同一条判据，否则两边会漂移。
 */
export function needsTopicHook(url: URL): boolean {
  return descriptorForHost(url.hostname)?.id === 'zsxq';
}

/** 按主机名查找来源描述符；找不到返回 undefined。 */
export function descriptorForHost(host: string): SourceDescriptor | undefined {
  const lower = host.toLowerCase();
  for (const descriptor of Object.values(SOURCE_REGISTRY)) {
    if (descriptor.matchHost(lower)) return descriptor;
  }
  return undefined;
}

/** 按来源标识取描述符。 */
export function descriptorFor(source: Source): SourceDescriptor {
  return SOURCE_REGISTRY[source];
}
