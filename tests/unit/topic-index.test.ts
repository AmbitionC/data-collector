import { describe, expect, it } from 'vitest';
import {
  TopicIndex,
  harvestTopics,
  normalizeForMatch,
} from '../../packages/extension/src/topicIndex.js';

describe('harvestTopics', () => {
  it('finds topic ids at any depth without assuming the response schema', () => {
    // 不写死接口结构：只认「对象里有 topic_id」，字段调整了也不会立刻失效。
    const payload = {
      succeeded: true,
      resp_data: {
        topics: [
          { topic_id: 511111111111111, talk: { text: '创业板已经跌破 60 日线，仓位要降下来' } },
          { topic_id: '522222222222222', article: { title: '关于长期投资的一点想法' } },
        ],
      },
    };

    const records = harvestTopics(payload);

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ topicId: '511111111111111' });
    expect(records[0]?.text).toContain('创业板已经跌破');
    expect(records[1]).toMatchObject({ topicId: '522222222222222' });
    expect(records[1]?.text).toContain('长期投资');
  });

  it('handles a flat array and a differently named wrapper', () => {
    const records = harvestTopics([
      { data: { topic_id: 700000000000001, question: { text: '怎么看当前的估值水平' } } },
    ]);

    expect(records).toEqual([
      expect.objectContaining({ topicId: '700000000000001' }),
    ]);
  });

  it('ignores objects without a usable topic id', () => {
    expect(harvestTopics({ topic_id: 'not-a-number', text: '正文正文正文' })).toEqual([]);
    expect(harvestTopics({ user_id: 123, text: '正文正文正文' })).toEqual([]);
    expect(harvestTopics('plain string')).toEqual([]);
  });

  it('survives cyclic structures and stops at the record cap', () => {
    const node: Record<string, unknown> = { topic_id: 1234567890123456, text: '循环引用测试正文' };
    node.self = node;

    expect(() => harvestTopics(node)).not.toThrow();
    expect(harvestTopics(node)).toHaveLength(1);

    const many = Array.from({ length: 50 }, (_, index) => ({
      topic_id: 500000000000000 + index,
      text: `第 ${index} 条帖子的正文内容`,
    }));
    expect(harvestTopics(many, 10)).toHaveLength(10);
  });
});

describe('TopicIndex', () => {
  it('matches a post back to its topic id by body text', () => {
    const index = new TopicIndex();
    index.add(harvestTopics({
      topics: [
        { topic_id: 511111111111111, talk: { text: '创业板已经跌破 60 日线，仓位要降下来' } },
        { topic_id: 522222222222222, talk: { text: '关于长期投资的一点想法，先说结论' } },
      ],
    }));

    expect(index.size).toBe(2);
    expect(index.find('创业板已经跌破 60 日线，仓位要降下来')).toBe('511111111111111');
    expect(index.find('关于长期投资的一点想法，先说结论')).toBe('522222222222222');
  });

  it('matches despite whitespace and trailing UI text on the page', () => {
    const index = new TopicIndex();
    index.add([{ topicId: '5333', text: '创业板已经跌破60日线仓位要降下来' }]);

    // 页面上的正文会带换行、缩进，还可能跟着「展开」「点赞」这类控件文案。
    expect(index.find('  创业板已经跌破 60 日线，\n  仓位要降下来  展开 点赞 12')).toBe('5333');
  });

  it('returns undefined instead of guessing when nothing matches', () => {
    const index = new TopicIndex();
    index.add([{ topicId: '5333', text: '完全不相干的另一条帖子正文' }]);

    // 宁可如实跳过，也不能猜一个 id —— 猜错会把两条内容写到同一个文件上。
    expect(index.find('创业板已经跌破 60 日线')).toBeUndefined();
    expect(index.find('')).toBeUndefined();
  });

  it('counts each topic once even when the same response arrives twice', () => {
    const index = new TopicIndex();
    const records = [{ topicId: '5333', text: '同一条帖子重复出现在两次响应里' }];
    index.add(records);
    index.add(records);

    expect(index.size).toBe(1);
  });
});

describe('normalizeForMatch', () => {
  it('strips every kind of whitespace and truncates', () => {
    expect(normalizeForMatch(' 创业板 已经\n跌破 ', 6)).toBe('创业板已经跌');
    expect(normalizeForMatch('   ')).toBe('');
  });
});

describe('接口正文与页面文本对不上号的真实形态', () => {
  // 「20 条只对上 4 条」的现场：星球的接口正文不是纯文本，话题标签 / @提及 / 外链
  // 都是内联标记，页面上却渲染成可见文字。开头第一个字就不一样，只比前缀必然全跳过。
  it('话题标签还原成页面上看到的样子', () => {
    const index = new TopicIndex();
    index.add([
      {
        topicId: '511111111111111',
        text: '<e type="hashtag" hid="48844584441158" title="%23%E6%8A%95%E8%B5%84%E7%AC%94%E8%AE%B0%23" />'
          + '创业板已经跌破 60 日线，仓位要主动降下来，别等到被动割肉。',
      },
    ]);

    // 页面上这条显示为「#投资笔记#创业板已经跌破…」。
    expect(index.find('#投资笔记#创业板已经跌破 60 日线，仓位要主动降下来，别等到被动割肉。'))
      .toBe('511111111111111');
  });

  it('开头完全不同，但正文中段有足够长的共同片段时仍能对上', () => {
    const index = new TopicIndex();
    index.add([
      {
        topicId: '522222222222222',
        text: '【每周复盘】本周市场情绪修复，成交量回到万亿以上，但结构分化依然明显，'
          + '消费和医药继续磨底，我的应对是不加不减，等右侧信号。',
      },
    ]);

    // 页面把开头的栏目标记单独渲染在别处，正文从第二句开始。
    expect(index.find('本周市场情绪修复，成交量回到万亿以上，但结构分化依然明显，消费和医药继续磨底'))
      .toBe('522222222222222');
  });

  it('长帖 + 接口开头多一段：两边截同一长度就永远比不出来（回归）', () => {
    // 这是「20 条只对上 4 条」的真正主因。
    // 曾经 needle 和 haystack 都截到 240 字：接口那侧开头多了一段，它保留的正文
    // 就比页面那侧短一截，两边互相都不可能包含 —— 于是所有超过 240 字的长帖全跳过。
    const body = '关于长期投资的一点想法。'.repeat(40); // 远超 240 字
    const index = new TopicIndex();
    index.add([{ topicId: '588888888888888', text: `【本周复盘】${body}` }]);

    // 页面上标题渲染在别处，正文从 body 开头起。
    expect(index.find(body)).toBe('588888888888888');
  });

  it('反向也成立：页面那侧开头多一段时同样对得上', () => {
    const body = '仓位管理的三条纪律，逐条说明。'.repeat(40);
    const index = new TopicIndex();
    index.add([{ topicId: '599999999999999', text: body }]);

    expect(index.find(`星主推荐 ${body}`)).toBe('599999999999999');
  });

  it('长帖被折叠、页面只显示前半截，照样对得上', () => {
    const index = new TopicIndex();
    const full = '关于长期投资的一点想法，先说结论：大多数人亏在频繁交易上，而不是选错了标的。'
      + '下面从三个角度展开说明，第一是交易成本，第二是情绪损耗，第三是复利被打断。';
    index.add([{ topicId: '533333333333333', text: full }]);

    expect(index.find(`${full.slice(0, 40)}…展开`)).toBe('533333333333333');
  });

  it('共同片段指向多条时宁可跳过也不猜', () => {
    // 误配比漏配严重得多：猜错会让两条内容写到同一个文件上，直接覆盖。
    const shared = '本周市场情绪修复成交量回到万亿以上结构分化依然明显消费和医药继续磨底';
    const index = new TopicIndex();
    index.add([
      { topicId: '544444444444444', text: `甲的转发：${shared}` },
      { topicId: '555555555555555', text: `乙的转发：${shared}` },
    ]);

    expect(index.find(shared)).toBeUndefined();
  });

  it('只差一个字的两条帖子绝不互相冒充', () => {
    // 回归：曾经放宽成「共有一段足够长的文字就算同一条」，结果接口里没有的
    // 「第三条…」被判成了「第二条…」，两条内容会写进同一个文件直接覆盖。
    // 只容忍截断和外围文案，**不容忍任何一个字的差异**。
    const index = new TopicIndex();
    index.add([{ topicId: '577777777777777', text: '第二条帖子的正文内容，同样足够长以便通过长度校验。' }]);

    expect(index.find('第二条帖子的正文内容，同样足够长以便通过长度校验。')).toBe('577777777777777');
    expect(index.find('第三条帖子的正文内容，同样足够长以便通过长度校验。')).toBeUndefined();
  });

  it('毫无关系的两条帖子不会被硬凑到一起', () => {
    const index = new TopicIndex();
    index.add([{ topicId: '566666666666666', text: '今天聊聊可转债的下修博弈，条款是关键，别只看溢价率。' }]);

    expect(index.find('周末带孩子去了趟博物馆，顺便聊聊教育投入的边际效用。')).toBeUndefined();
  });
});

describe('取证：这一条为什么没对上', () => {
  it('把页面文本、接口原文、归一化结果和最长共同片段一并摆出来', () => {
    // 靠猜已经绕了太多圈：证据包必须能一眼区分「接口没返回这条」
    // 「内联标记没还原干净」「字段顺序不同」三种成因。
    const index = new TopicIndex();
    index.add([
      {
        topicId: '511111111111111',
        text: '<e type="hashtag" title="%23%E6%8A%95%E8%B5%84%23" />创业板已经跌破 60 日线，仓位要降。',
        keys: ['topic_id', 'talk', 'likes_count'],
      },
      { topicId: '522222222222222', text: '完全无关的一条：周末带孩子去了趟博物馆。' },
    ]);

    const report = index.diagnose('创业板已经跌破 60 日线，仓位要降。');

    expect(report.pageNormalized).toContain('创业板已经跌破60日线');
    // 最像的排在最前，并且**保留接口原文**——能看出内联标记长什么样。
    expect(report.candidates[0]?.topicId).toBe('511111111111111');
    expect(report.candidates[0]?.rawApiText).toContain('<e type="hashtag"');
    expect(report.candidates[0]?.apiKeys).toEqual(['topic_id', 'talk', 'likes_count']);
    expect(report.candidates[0]!.overlap).toBeGreaterThan(report.candidates[1]!.overlap);
  });

  it('索引为空时给出空候选，而不是抛错', () => {
    // 「一个帖子号都没截到」是最常见的成因，取证本身绝不能在这时崩掉。
    expect(new TopicIndex().diagnose('随便一段正文')).toEqual({
      pageNormalized: '随便一段正文',
      candidates: [],
    });
  });

  it('接口原文原样保留，不在采集阶段就被归一化抹掉', () => {
    const raw = '<e type="hashtag" title="%23投资%23" />正文正文正文正文正文正文正文正文';
    const harvested = harvestTopics({ topic_id: 511, talk: { text: raw } });

    expect(harvested[0]?.text).toContain('<e type="hashtag"');
    expect(harvested[0]?.keys).toContain('topic_id');
  });
});
