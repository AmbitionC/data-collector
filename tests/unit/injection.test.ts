import { describe, expect, it } from 'vitest';
import {
  injectionPlan,
  isTopicHookHost,
} from '../../packages/extension/src/background/injection.js';

const LIST_URL = 'https://wx.zsxq.com/group/48844584441158';
const TOPIC_URL = 'https://wx.zsxq.com/topic/511111111111111';
const WECHAT_URL = 'https://mp.weixin.qq.com/s/abc';

describe('自愈注入清单', () => {
  it('星球页两个脚本都补，主世界钩子先留存再由内容脚本 replay', () => {
    // 这是本文件存在的理由：曾经只补 content.js，主世界钩子一次都没补过。
    // 结果是「装扩展之前就打开的标签页」永远捕获不到帖子号 → 批量必然全部跳过，
    // 而面板还在让用户滚动页面——钩子都不在，滚多久都等不到结果。
    expect(injectionPlan(LIST_URL)).toEqual([
      { files: ['inject.js'], world: 'MAIN', required: true },
      { files: ['content.js'], required: true },
    ]);
    // 帖子详情页同样靠 exact API 记录证明正文完整，不能只补 content。
    expect(injectionPlan(TOPIC_URL).map(step => step.files[0]))
      .toEqual(['inject.js', 'content.js']);
  });

  it('内容脚本和主世界钩子都是知识星球完整采集的必需项', () => {
    const [hook, content] = injectionPlan(LIST_URL);
    expect(hook?.required).toBe(true);
    expect(content?.required).toBe(true);
  });

  it('其它来源只补内容脚本，不往页面主世界塞东西', () => {
    // 注入面保持最小：只有知识星球把帖子号藏在接口响应里。
    expect(injectionPlan(WECHAT_URL)).toEqual([{ files: ['content.js'], required: true }]);
    expect(injectionPlan('https://www.nowcoder.com/discuss/123'))
      .toEqual([{ files: ['content.js'], required: true }]);
  });

  it('地址缺失或非法时按「不需要钩子」处理，绝不抛错', () => {
    // 标签页可能刚被关掉，chrome.tabs.get 拿不到 url —— 不能因此中断自愈。
    expect(injectionPlan(undefined)).toEqual([{ files: ['content.js'], required: true }]);
    expect(injectionPlan('看起来不像地址')).toEqual([{ files: ['content.js'], required: true }]);
    expect(isTopicHookHost('chrome://extensions')).toBe(false);
    expect(isTopicHookHost('')).toBe(false);
  });

  it('判定用主机名而非字符串包含，冒牌域名不放行', () => {
    expect(isTopicHookHost(LIST_URL)).toBe(true);
    expect(isTopicHookHost('https://wx.zsxq.com.evil.example/group/1')).toBe(false);
    expect(isTopicHookHost('https://evil.example/?u=wx.zsxq.com')).toBe(false);
  });
});
