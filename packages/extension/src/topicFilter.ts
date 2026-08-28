/**
 * 选题过滤：有些内容用户明确不看，采了只是给知识库添噪声。
 * 目前内置：打新、楼市、相亲。
 *
 * 两条原则：
 * - **宁可漏判，不可误判**。判错会把用户真正想要的内容悄悄扔掉，比多收一条严重得多。
 *   因此要求「强信号 + 至少两个不同信号」才排除，单独出现一个词一律不算。
 * - **绝不静默**。被排除的条目照样出现在「本轮明细」里，状态是已跳过、原因写明是哪一类，
 *   用户随时能看到自己漏掉了什么。
 */

export interface ExcludeRule {
  id: string;
  /** 给用户看的原因，如「打新内容」。 */
  label: string;
  /** 强信号：必须至少命中一个，光有弱信号不算。 */
  strong: readonly string[];
  /** 辅助信号：与强信号一起满足「不同信号 ≥ 2」才排除。 */
  supporting: readonly string[];
  /** 标题/开头命中即足够明确的短语，不要求第二个信号。 */
  standalone?: readonly string[];
}

/**
 * 打新（新股申购）。用户明确说这类不做记录。
 * 强信号是这类帖子的固定说法；「破发 / 中签 / 市值打新」等只作辅助，
 * 因为一篇正常的投资分析也可能顺口提一句。
 */
export const IPO_RULE: ExcludeRule = {
  id: 'ipo',
  label: '打新内容',
  strong: ['打新', '新股', '申购'],
  supporting: [
    '破发',
    '中签',
    '积极申购',
    '谨慎申购',
    '放弃申购',
    '北交所',
    '沪深新股',
    '市值打新',
    '评级建议等级',
  ],
};

/**
 * 楼市 / 房地产行情。用户明确不看这一类。
 *
 * 强信号刻意选「房价 / 楼市 / 学区房」这种**以楼市本身为主题**才会出现的词，
 * 不放「房子 / 房贷 / 买房」——一篇讲资产配置或家庭财务的正经帖子随口提一句很正常，
 * 那类要留下（用户原话：排除的是以楼市行情 / 政策 / 房价走势为主题的帖子）。
 */
export const REAL_ESTATE_RULE: ExcludeRule = {
  id: 'real-estate',
  label: '楼市内容',
  strong: ['楼市', '房价', '学区房', '房地产', '二手房'],
  supporting: [
    '限购',
    '房产税',
    '土拍',
    // 「成交量」「挂牌」都拿掉了：股市帖里它们是高频词（成交量放大、新三板挂牌），
    // 拿它们当楼市的佐证，等于给每一篇股市帖都递了半个信号。
    '新房',
    '开发商',
    '首付',
    '房贷利率',
    '公摊',
    '交房',
    '楼盘',
    '房产中介',
    '土地出让',
  ],
  standalone: ['本周楼市分析', '楼市最新动态', '北京跌涨比数据', '深圳跌涨比数据'],
};

/**
 * 相亲 / 情感话题。星球「精华」里混着不少，用户明确不看。
 * 「相亲」这个词本身指向性够强，但仍按同一条判据要求第二个信号，避免误伤
 * 「像相亲一样挑股票」这类比喻用法。
 */
export const DATING_RULE: ExcludeRule = {
  id: 'dating',
  label: '相亲情感内容',
  strong: ['相亲', '婚恋', '找对象', '择偶'],
  supporting: [
    '情感课',
    '相亲对象',
    '介绍对象',
    '男方',
    '女方',
    '彩礼',
    '嫁',
    '娶',
    '谈恋爱',
    '处对象',
    '条件不错',
    '见面聊',
    '单身',
    '脱单',
    // 「年龄」「身高」拿掉了：养老保险、寿险测算这类帖子满篇都是年龄，
    // 给它们递一个佐证信号，只要正文里出现一次比喻性的「相亲」就会被误杀。
  ],
  standalone: ['相亲帖'],
};

/** 只排除明确销售/导流正文；讲“如何识别广告”的方法文没有购买信号，会保留。 */
export const PROMOTION_RULE: ExcludeRule = {
  id: 'promotion',
  label: '推广/带货内容',
  strong: ['优惠活动', '购买链接', '专属福利', '付费专栏'],
  supporting: ['购买', '价格', '优惠券', '渠道价', '人工开通', '兑换码', '续费'],
};

/** 群规、入群欢迎与功能说明没有长期知识价值。 */
export const COMMUNITY_ADMIN_RULE: ExcludeRule = {
  id: 'community-admin',
  label: '社群管理内容',
  strong: ['入群必看', '星球使用指南'],
  supporting: ['加入星球', '精华', '只看星主', '提问功能', '续费'],
  standalone: ['入群必看'],
};

export const EXCLUDE_RULES: readonly ExcludeRule[] = [
  IPO_RULE,
  REAL_ESTATE_RULE,
  DATING_RULE,
  PROMOTION_RULE,
  COMMUNITY_ADMIN_RULE,
];

/**
 * 用户选定的 A 范围：投资、财富、职场/商业、认知与教育。
 *
 * 这只用于决定是否值得打开昂贵的详情页，不替代后续完整正文上的同一判断。列表预览
 * 通常已经包含标题和首段；完全没有任何领域信号时，前置跳过能避免为日常闲聊等待正文。
 */
const LIFE_TEACHER_INTEREST = /投资|股票|股市|A股|港股|美股|基金|ETF|指数|估值|仓位|财报|ROE|市盈率|市净率|银行股|券商|医药|中概股|美债|国债|黄金|牛市|熊市|创业板|上证|沪深|科创|板块|套利|财富|资产|现金流|保险|养老|负债|贷款|债务|财务自由|职业|职场|工作|求职|创业|商业|经营|公司|企业|副业|AI|DeepSeek|认知|决策|思维|复盘|人生|方法论|教育|学校|择校|学习/u;

export function isLifeTeacherInterest(text: string): boolean {
  return LIFE_TEACHER_INTEREST.test(text);
}

export interface ExcludeMatch extends ExcludeRule {
  /**
   * 到底是哪几个词让它被判成这一类。
   *
   * 必须报出来：明细里只写「楼市内容」，误伤时根本无从下手——
   * 「香港保险」被判成楼市、「沪深300 中证500 数据统计」也被判成楼市，
   * 光看标签只能干瞪眼。把命中的词摆出来，一眼就知道该收紧哪一条。
   */
  hits: string[];
}

/**
 * 「主线」的判定窗口：正文开头这么多字。
 *
 * 星球的帖子基本都在开头就把话题立起来（首句往往就是标题：「本周楼市分析…」）。
 * 而一篇三千字的投资长文，正文深处顺口提一句「房价」「首付」再正常不过——
 * 只看「出现过没有」，这类帖子就会被整篇扔掉。实测误伤三条：
 *   香港保险（命中 房价、首付）、沪深300 薪酬统计（命中 楼市）、
 *   问减仓计划（命中 打新、北交所）——三条的信号全在正文深处。
 */
const LEAD_WINDOW = 150;

/**
 * 判断一段正文是否命中排除规则；命中返回规则（含命中的信号词），否则 undefined。
 *
 * 判据三条，缺一不可：
 * 1. 至少一个强信号；
 * 2. 命中的**不同**信号总数 ≥ 2（同一个词出现多次只算一个）；
 * 3. **强信号必须出现在开头的主线窗口里**——排除的是以该话题为主线的帖子，
 *    不是提到该词的帖子。
 *
 * 第 3 条会带来漏判（开头讲故事、中段才转到楼市的帖子会留下来），这是**有意的**：
 * 判错会把用户真正想要的内容悄悄扔掉，比多收一条严重得多。
 */
export function excludedBy(
  text: string,
  rules: readonly ExcludeRule[] = EXCLUDE_RULES,
): ExcludeMatch | undefined {
  if (!text) return undefined;
  const lead = text.slice(0, LEAD_WINDOW);
  for (const rule of rules) {
    const standaloneHits = (rule.standalone ?? []).filter(marker => lead.includes(marker));
    if (standaloneHits.length > 0) {
      const allHits = [
        ...standaloneHits,
        ...rule.strong.filter(marker => text.includes(marker)),
        ...rule.supporting.filter(marker => text.includes(marker)),
      ];
      return { ...rule, hits: [...new Set(allHits)] };
    }
    const strongHits = rule.strong.filter(marker => text.includes(marker));
    if (strongHits.length === 0) continue;
    // 主线判定：强信号得在开头露面，否则只是正文里顺口提了一句。
    if (!rule.strong.some(marker => lead.includes(marker))) continue;
    const supportingHits = rule.supporting.filter(marker => text.includes(marker));
    if (strongHits.length + supportingHits.length >= 2) {
      return { ...rule, hits: [...strongHits, ...supportingHits] };
    }
  }
  return undefined;
}
