import { describe, expect, it } from 'vitest';
import {
  excludedBy,
  isLifeTeacherInterest,
} from '../../packages/extension/src/topicFilter.js';

/** 用户实际给出的打新帖原文。 */
const IPO_POST = `明日沪深新股，展芯股份，半导体赛道，建议积极申购，我的操作，申购展芯股份。

评级建议等级：
1  积极申购，我认为不会破发，可申购。

2  谨慎申购，破发风险较小，不能忍受破发的同学可不申购，我个人根据大数原则和高概率原则会申购。

3  放弃申购，破发风险适中或较大。

注意，沪深新股和北交所新股打新规则不一样，沪深新股主要依靠市值打新，无需现金，靠摇号中签。`;

describe('选题过滤', () => {
  it('认出打新帖', () => {
    expect(excludedBy(IPO_POST)?.label).toBe('打新内容');
  });

  it('认出更短的打新帖', () => {
    expect(excludedBy('今天有两只新股，都建议积极申购，破发概率不大。')?.label).toBe('打新内容');
    expect(excludedBy('明日打新提醒：北交所一只，谨慎申购。')?.label).toBe('打新内容');
  });

  it('不误伤只是顺口提一句的正常投资分析', () => {
    // 单个信号一律不算——判错会把用户真正想看的内容悄悄扔掉。
    expect(excludedBy('创业板跌破 60 日线，仓位要降下来，注意回撤控制。')).toBeUndefined();
    expect(excludedBy('这家公司上市当天破发，说明市场情绪已经很差了。')).toBeUndefined();
    expect(excludedBy('新股上市首日的表现，往往反映当下的风险偏好。')).toBeUndefined();
    expect(excludedBy('这个策略中签率不高，但期望值为正。')).toBeUndefined();
  });

  it('空文本与无关文本不命中', () => {
    expect(excludedBy('')).toBeUndefined();
    expect(excludedBy('聊聊长期主义和复利。')).toBeUndefined();
  });
});

describe('关注主题前置判断', () => {
  it('覆盖投资、财富、职场、认知与教育五类', () => {
    for (const text of [
      '创业板估值和仓位复盘',
      '家庭资产与保险配置',
      '中年职场转型的方法',
      '把模糊恐惧改写成决策边界',
      '孩子择校与学习规划',
    ]) expect(isLifeTeacherInterest(text)).toBe(true);
  });

  it('社群闲聊和日常通知不进入正文补全', () => {
    expect(isLifeTeacherInterest('今天下雨了，大家周末愉快，评论区随便聊聊。')).toBe(false);
  });
});

describe('楼市与相亲', () => {
  it('以楼市行情为主题的帖子跳过', () => {
    expect(excludedBy(
      '聊聊最近的楼市：一线城市二手房挂牌量创新高，房价还在阴跌，限购放开也没托住成交量。',
    )?.label).toBe('楼市内容');
  });

  it('讲投资顺带提一句房子的帖子照收', () => {
    // 用户原话：排除的是「以楼市行情/政策/房价走势为主题」的帖子；
    // 主线是投资、只是顺带提到房产的仍然要留下。
    expect(excludedBy(
      '资产配置里最容易被忽略的是负债端：背着高利率的房贷去加杠杆买股票，本质是双重风险敞口。',
    )).toBeUndefined();
    expect(excludedBy('买房这件事我一直觉得要算清楚机会成本，别只看月供。')).toBeUndefined();
  });

  it('相亲帖跳过，但比喻用法不误伤', () => {
    expect(excludedBy(
      '帮星友发个相亲信息：女方 29 岁，本地有房，希望男方身高 175 以上，有意向可以见面聊。',
    )?.label).toBe('相亲情感内容');
    // 「像相亲一样挑股票」这种比喻只有一个信号，不该被当成相亲帖。
    expect(excludedBy('选股就像相亲，第一眼看不上的后面基本也不会看上。')).toBeUndefined();
  });

  it('短列表预览只露出明确标题时也能前置过滤', () => {
    expect(excludedBy('本周楼市分析 本期先看北京的成交和库存。')?.label).toBe('楼市内容');
    expect(excludedBy('北京跌涨比数据：周六 8.97，后续不再追踪。')?.label).toBe('楼市内容');
    expect(excludedBy('发相亲帖了，相亲帖有特别的标签。')?.label).toBe('相亲情感内容');
    expect(excludedBy('入群必看 欢迎加入星球，建议先看精华和只看星主。')?.label)
      .toBe('社群管理内容');
  });

  it('促销正文要过滤，但广告识别方法本身保留', () => {
    expect(excludedBy(
      '财新春节优惠活动已经开放，以下是购买链接和专属福利，购买时记得勾选立减。',
    )?.label).toBe('推广/带货内容');
    expect(excludedBy(
      '说下我对微信情感专栏付费的看法，文末会给付费专栏链接和续费优惠券。',
    )?.label).toBe('推广/带货内容');
    expect(excludedBy(
      '公众号广告的分辨方法：标题有作者名的是正文，只有公众号名的通常是广告。',
    )).toBeUndefined();
  });

  it('三条规则各自独立，互不干扰', () => {
    expect(excludedBy('打新这事儿，破发之后我就不参与了。')?.label).toBe('打新内容');
    expect(excludedBy('今天聊聊可转债的下修博弈，条款是关键。')).toBeUndefined();
  });
});

/**
 * 实机误伤：以下四条全部取自用户真实采集的报告（0.3.10 的跳过原因带了命中的词，
 * 才第一次看清是哪些信号在作祟）。先把它们写成用例，再动规则。
 */
describe('主线判定：排除的是以该话题为主线的帖子，不是提到该词的帖子', () => {
  it('香港保险讲杠杆，正文深处提了房价和首付 —— 不是楼市帖', () => {
    const post = '保险课程系列1——香港保险（3） 本期来聊香港储蓄险的杠杆玩法，'
      + '这类产品有个专门的名字，称为保费融资产品。这种玩法大概率可以在7年的周期实现套利。'
      + '我们先说清楚它的资金成本和收益结构，再看适合什么样的人。'.repeat(4)
      + '这个杠杆比例大致相当于买房时的首付比例，只不过标的不是房价而是保单现金价值。';
    expect(excludedBy(post)).toBeUndefined();
  });

  it('问减仓计划，正文深处提了打新和北交所 —— 不是打新帖', () => {
    const post = '依依 提问：陈老师最近市场波动很大，特别是科技板块，请问您最近有减仓的计划吗？'
      + '我的仓位比较重，想听听您的看法，毕竟这两年的波动确实比过去大不少。'.repeat(8)
      + '另外我平时也会顺手打新，北交所的也参与，不过占比很小。';
    expect(excludedBy(post)).toBeUndefined();
  });

  it('沪深300 数据统计，正文深处对比了楼市 —— 不是楼市帖', () => {
    const post = '5月1号我统计过沪深300和中证500的数据，但为了和过去六年做对比，'
      + '我剔除了部分并非六年都在清单上的数据。'.repeat(6)
      + '顺便提一句，同期的楼市成交也在走弱，房价还在磨底。';
    expect(excludedBy(post)).toBeUndefined();
  });

  it('股市帖里的「成交量」不再给楼市递信号', () => {
    // 成交量放大 / 挂牌都是股市高频词，拿它们当楼市佐证等于给每篇股市帖递半个信号。
    const post = '今天大盘成交量明显放大，创业板站上60日线。'.repeat(5)
      + '有人问房价什么时候见底，我不做这个判断。';
    expect(excludedBy(post)).toBeUndefined();
  });

  it('养老险测算满篇「年龄」，不该被相亲规则误杀', () => {
    const post = '保险课程系列2——国内养老险 最近很多人问起养老保险，本文做一个科普。'
      + '不同年龄的费率差异很大，年龄越大越贵。'.repeat(6)
      + '有人开玩笑说挑保险像相亲一样要货比三家。';
    expect(excludedBy(post)).toBeUndefined();
  });

  it('真的以楼市为主线的照旧拦下', () => {
    const post = '本周楼市分析 本期说一下房价触底特征，一般来说房价非跌即涨，'
      + '即使是底部盘整期，也是由小的跌涨周期组成的。从东京的经验看，'
      + '新房与二手房的价格差会先收敛，开发商的库存也会先见顶。';
    expect(excludedBy(post)?.label).toBe('楼市内容');
    expect(excludedBy(post)?.hits).toContain('楼市');
  });

  it('相亲实操方法论要拦下 —— 之前漏了', () => {
    // 用户明确说过这类不记录，但它一直被放行：标题里「相亲」出现两次也只算一个信号，
    // 而当时的佐证词一个都没命中。「情感课」是这位博主这类帖子的固定说法。
    const post = '情感课更新了一篇，讲相亲实操方法论的，主因之前在大家的有关情感的提问中'
      + '简单写过相亲实操方法论，但之前写的方法论的唯一缺点是不够体系化。';
    expect(excludedBy(post)?.label).toBe('相亲情感内容');
  });

  it('「背着房贷加杠杆买股票」主线是投资，必须留下', () => {
    const post = '有人背着房贷还要加杠杆买股票，我觉得这个风险敞口太大了。'
      + '先把负债结构理清楚，再谈仓位。'.repeat(5);
    expect(excludedBy(post)).toBeUndefined();
  });
});
