import { describe, expect, it } from 'vitest';
import { advertisementIn, commercialSignals } from '../../packages/extension/src/adFilter.js';

/** 实机抓到的那条分销链接（0.3.9 诊断里的 anchors，一字未改）。 */
const CPS_LINK =
  'https://cps.qixin19.com/apps/cps/zyt1106596/product/detail'
  + '?prodId=105222&planId=130748&tenantId=0&createTime=1767002448963';

describe('广告甄别：只认外链这种硬证据', () => {
  it('认出实机抓到的那条保险分销链接，并说清依据', () => {
    const signals = commercialSignals(CPS_LINK);
    // 主机名带 cps.、路径带 /cps/、查询串三个分销参数——三重佐证。
    expect(signals).toContain('CPS 分销路径');
    expect(signals.some(hit => hit.includes('prodid'))).toBe(true);

    const match = advertisementIn(['https://images.zsxq.com/a.jpg', CPS_LINK]);
    expect(match?.label).toBe('推广/带货内容');
    expect(match?.hits[0]).toBe('cps.qixin19.com');
  });

  it('博主自己的地盘永远不算广告', () => {
    // 长文帖的正文主体就是一个 articles.zsxq.com 链接，判成广告等于把干货全扔了。
    for (const link of [
      'https://articles.zsxq.com/id_i9g8xrwktrlb.html',
      'https://wx.zsxq.com/group/48844584441158/topic/55522458588252220',
      'https://images.zsxq.com/chart.png',
      'https://mp.weixin.qq.com/s/uW5gUigjslVY24YmCYhg0g',
    ]) {
      expect(commercialSignals(link)).toEqual([]);
    }
    expect(advertisementIn(['https://articles.zsxq.com/id_x.html'])).toBeUndefined();
  });

  it('普通外链不算广告——引用一份研报、一个数据源都很正常', () => {
    for (const link of [
      'https://www.stats.gov.cn/sj/zxfb/202601/t20260118_1234567.html',
      'https://finance.sina.com.cn/stock/2026-01-18/doc-abc.shtml',
      'https://www.example.com/report?id=42',
    ]) {
      expect(commercialSignals(link)).toEqual([]);
    }
  });

  it('单独一个渠道参数不算数，凑够两个才算', () => {
    // channelId 这种埋点到处都是，单独出现判成广告必然误伤。
    expect(commercialSignals('https://shop.example.com/p/1?channelId=9')).toEqual([]);
    expect(commercialSignals('https://shop.example.com/p/1?channelId=9&shareId=7'))
      .toContain('分销参数 shareid、channelid');
  });

  it('电商商品页出现在星球帖子里，基本只有带货一种解释', () => {
    expect(commercialSignals('https://item.taobao.com/item.htm?id=123')).toContain('电商商品页');
    expect(commercialSignals('https://item.jd.com/100012043978.html')).toContain('电商商品页');
  });

  it('非 http 链接与畸形链接一律不判，绝不因为它炸掉整条采集', () => {
    for (const link of ['javascript:void(0)', 'mailto:a@b.com', '不是个链接', '']) {
      expect(commercialSignals(link)).toEqual([]);
    }
    expect(advertisementIn(['', '不是个链接'])).toBeUndefined();
  });
});
