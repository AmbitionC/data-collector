import { describe, expect, it } from 'vitest';
import { excludedBy } from '../../packages/extension/src/topicFilter.js';

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

  it('三条规则各自独立，互不干扰', () => {
    expect(excludedBy('打新这事儿，破发之后我就不参与了。')?.label).toBe('打新内容');
    expect(excludedBy('今天聊聊可转债的下修博弈，条款是关键。')).toBeUndefined();
  });
});
