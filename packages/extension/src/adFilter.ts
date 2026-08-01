/**
 * 广告甄别：靠**外链**，不靠语气。
 *
 * 星球「精华」里混着带货帖。判据必须是硬证据——语气这种东西谁都能踩中：
 * 一篇正经的券商费率科普和一篇拿返佣的开户推广，用词几乎一模一样，
 * 按「限时 / 名额 / 扫码」这类词去判，迟早把博主自己的干货扔掉。
 *
 * 分销链接骗不了人。CPS（Cost Per Sale）是按成交结算的分销体系，链接里带着
 * 商品号和渠道号，专门用来追踪这一单是谁带来的。实机抓到的原样：
 *
 *   https://cps.qixin19.com/apps/cps/zyt1106596/product/detail
 *     ?prodId=105222&planId=130748&tenantId=0&createTime=1767002448963
 *
 * 主机名带 `cps.`、路径带 `/cps/`、查询串同时有 prodId / planId / tenantId——
 * 三重佐证，不是碰巧。
 *
 * 和选题过滤一样守两条：**绝不静默**（照样进明细，原因写明是哪个域名），
 * **宁可漏判不可误判**（只认硬信号，语气一概不作数）。
 */

/** 博主自己的地盘，永远不算广告。 */
const OWN_HOSTS = ['zsxq.com', 'weixin.qq.com', 'qq.com'];

/**
 * 分销参数。要**同时出现两个以上**才算数——单独一个 `channelId` 可能只是普通埋点，
 * 而 `prodId` + `planId` + `tenantId` 一起出现，只可能是带货落地页。
 */
const COMMERCIAL_PARAMS = [
  'prodid',
  'planid',
  'tenantid',
  'agentid',
  'invitecode',
  'sharecode',
  'shareid',
  'channelid',
  'distributorid',
  'cpsid',
  'unionid',
];

/** 电商商品页：出现在知识星球的帖子里，基本只有带货一种解释。 */
const SHOP_HOSTS = ['taobao.com', 'tmall.com', 'jd.com', 'pinduoduo.com', 'yangkeduo.com'];

export interface AdMatch {
  label: string;
  /** 判成广告的依据，逐条如实列出（域名 + 命中的信号）。 */
  hits: string[];
}

function isOwnHost(host: string): boolean {
  return OWN_HOSTS.some(own => host === own || host.endsWith(`.${own}`));
}

/** 一条链接的带货信号；没有信号返回空数组。 */
export function commercialSignals(raw: string): string[] {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return [];
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return [];
  const host = url.hostname.toLowerCase();
  if (isOwnHost(host)) return [];

  const hits: string[] = [];
  if (/(^|\.)cps\./.test(host) || /\/cps\//i.test(url.pathname)) hits.push('CPS 分销路径');
  if (SHOP_HOSTS.some(shop => host === shop || host.endsWith(`.${shop}`))) hits.push('电商商品页');
  const params = new Set([...url.searchParams.keys()].map(key => key.toLowerCase()));
  const matched = COMMERCIAL_PARAMS.filter(name => params.has(name));
  if (matched.length >= 2) hits.push(`分销参数 ${matched.join('、')}`);
  return hits;
}

/**
 * 这条帖子里有没有带货链接。
 * 命中即返回，并把域名和依据一并带出——用户要能自己复核判得对不对。
 */
export function advertisementIn(links: readonly string[]): AdMatch | undefined {
  for (const link of links) {
    const hits = commercialSignals(link);
    if (hits.length === 0) continue;
    let host = link;
    try {
      host = new URL(link).hostname;
    } catch {
      // 取不到主机名就把原链接截一段带出去，总比什么都不说强。
      host = link.slice(0, 60);
    }
    return { label: '推广/带货内容', hits: [host, ...hits] };
  }
  return undefined;
}
