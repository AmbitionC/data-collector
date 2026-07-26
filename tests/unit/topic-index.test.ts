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
