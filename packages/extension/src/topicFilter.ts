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
  strong: ['楼市', '房价', '学区房', '房地产市场', '二手房'],
  supporting: [
    '限购',
    '房产税',
    '土拍',
    '成交量',
    '新房',
    '开发商',
    '中介',
    '挂牌',
    '首付',
    '房贷利率',
    '公摊',
    '交房',
    '楼盘',
  ],
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
    '年龄',
    '身高',
  ],
};

export const EXCLUDE_RULES: readonly ExcludeRule[] = [
  IPO_RULE,
  REAL_ESTATE_RULE,
  DATING_RULE,
];

/**
 * 判断一段正文是否命中排除规则；命中返回规则，否则 undefined。
 * 判据：至少一个强信号，且命中的**不同**信号总数 ≥ 2。
 */
export function excludedBy(
  text: string,
  rules: readonly ExcludeRule[] = EXCLUDE_RULES,
): ExcludeRule | undefined {
  if (!text) return undefined;
  for (const rule of rules) {
    const strongHits = rule.strong.filter(marker => text.includes(marker));
    if (strongHits.length === 0) continue;
    const supportingHits = rule.supporting.filter(marker => text.includes(marker));
    // 「不同信号 ≥ 2」：同一个词出现多次不算多个信号。
    if (strongHits.length + supportingHits.length >= 2) return rule;
  }
  return undefined;
}
