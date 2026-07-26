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
