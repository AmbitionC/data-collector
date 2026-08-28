import { describe, expect, it } from 'vitest';
import {
  TOPIC_HOOK_VERSION,
  inlineMarkupToHtml,
  TopicIndex,
  topicRecordsFromMessage,
  harvestTopics,
  normalizeForMatch,
  parseTopicJson,
  preferredTopicRecord,
} from '../../packages/extension/src/topicIndex.js';

describe('harvestTopics', () => {
  it('preserves every int64 identity field used to prove the topic and its owner', () => {
    const payload = parseTopicJson(String.raw`{
      "topic_id":9223372036854775807,
      "group_id":9223372036854775806,
      "menuId":9223372036854775805,
      "owner":{"user_id":9223372036854775804,"userId":9223372036854775803}
    }`) as {
      topic_id: unknown;
      group_id: unknown;
      menuId: unknown;
      owner: { user_id: unknown; userId: unknown };
    };

    expect(payload).toEqual({
      topic_id: '9223372036854775807',
      group_id: '9223372036854775806',
      menuId: '9223372036854775805',
      owner: {
        user_id: '9223372036854775804',
        userId: '9223372036854775803',
      },
    });
  });

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

  it('only marks direct body-bearing topics from a known topic endpoint as source-proven', () => {
    const directId = '511111111111111';
    const quotedId = '522222222222222';
    const payload = {
      succeeded: true,
      resp_data: {
        topics: [{
          topic_id: directId,
          talk: { text: '这是已知帖子列表端点直接返回的完整正文。' },
          quoted_topic: {
            topic_id: quotedId,
            title: '这里只是正文里引用的另一帖标题摘要',
          },
        }],
      },
    };

    const records = harvestTopics(payload, 400, {
      responsePath: 'https://api.zsxq.com/v2/groups/48844584441158/topics',
    });

    expect(records.find(record => record.topicId === directId)?.sourceBodyProven).toBe(true);
    expect(records.find(record => record.topicId === quotedId)?.sourceBodyProven).toBe(false);
  });

  it('treats the exact group sticky endpoint as a source-proven topic feed', () => {
    const [record] = harvestTopics({
      succeeded: true,
      resp_data: {
        topics: [{
          topic_id: '511111111111112',
          type: 'talk',
          talk: { text: '置顶接口直接返回的完整正文。' },
        }],
      },
    }, 400, {
      responsePath: 'https://api.zsxq.com/v2/groups/48844584441158/topics/sticky',
    });

    expect(record?.sourceBodyProven).toBe(true);
  });

  it('does not certify a failed topic response even when it echoes a body-shaped object', () => {
    const [record] = harvestTopics({
      succeeded: false,
      resp_data: {
        topics: [{
          topic_id: '544444444444444',
          talk: { text: '错误响应回显的正文形对象不能形成完整证明。' },
        }],
      },
    }, 400, {
      responsePath: 'https://api.zsxq.com/v2/groups/48844584441158/topics',
    });

    expect(record?.sourceBodyProven).toBe(false);
  });

  it('never turns an arbitrary same-id summary into source-complete body evidence', () => {
    const records = harvestTopics({
      topic_id: '533333333333333',
      title: '这里只有标题或列表摘要，并没有正文端点语义',
    });

    expect(records).toEqual([
      expect.objectContaining({
        topicId: '533333333333333',
        sourceBodyProven: false,
      }),
    ]);
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

  it('does not let two topics with the same 24-character key overwrite each other', () => {
    const index = new TopicIndex();
    const shared = '每周复盘先说结论当前仓位保持不变接下来分析三个行业的基本面变化';
    const bodyA = `${shared}第一条继续讨论消费行业的库存周期。`;
    const bodyB = `${shared}第二条继续讨论科技行业的资本开支。`;
    index.add([
      { topicId: 'topic-a', text: bodyA },
      { topicId: 'topic-b', text: bodyB },
    ]);

    expect(index.size).toBe(2);
    expect(index.find(bodyA)).toBe('topic-a');
    expect(index.find(bodyB)).toBe('topic-b');
    expect(index.find(shared)).toBeUndefined();
    expect(index.find(`${shared}第三条是页面里另一篇尚未截获的正文。`)).toBeUndefined();
  });

  it('exposes ambiguous identity evidence without weakening find', () => {
    const index = new TopicIndex();
    const body = '这是一则可能被原样重复发布的公告，正文完全相同但帖子号明确不同。';
    index.add([
      { topicId: 'topic-a', text: body },
      { topicId: 'topic-b', text: body },
    ]);

    expect(index.identityEvidence(body)).toEqual({ status: 'ambiguous' });
    expect(index.find(body)).toBeUndefined();
    expect(index.identityEvidence('完全不相关的页面正文')).toEqual({ status: 'none' });
  });

  it('does not map an uncaptured topic to the only captured topic sharing its short key', () => {
    const index = new TopicIndex();
    const shared = '每周复盘先说结论当前仓位保持不变接下来分析三个行业的基本面变化';
    const captured = `${shared}已捕获帖子继续讨论科技行业的资本开支。`;
    const missed = `${shared}未捕获帖子继续讨论消费行业的库存周期。`;
    index.add([{ topicId: 'captured-topic', text: captured }]);

    expect(index.find(captured)).toBe('captured-topic');
    expect(index.find(missed)).toBeUndefined();
  });

  it('does not infer a captured topic from one uncaptured short folded prefix', () => {
    const index = new TopicIndex();
    const foldedPrefix = '共同开场白只有二十字无法确认';
    index.add([{
      topicId: 'captured-long-topic',
      text: `${foldedPrefix}已捕获帖子后文讨论科技行业资本开支。`,
    }]);

    expect(index.find(foldedPrefix)).toBeUndefined();
  });

  it('does not map an uncaptured forwarding post to the captured post it quotes in full', () => {
    const index = new TopicIndex();
    const captured = '仓位管理有三条纪律，第一控制回撤，第二分散风险，第三定期复盘执行偏差。';
    index.add([{ topicId: 'captured-original', text: captured }]);

    expect(index.find(`星主转发：${captured}；我的观点完全不同，下面逐条说明。`)).toBeUndefined();
  });

  it('does not delete an authored 展开 or 全文 suffix without UI-separator evidence', () => {
    const index = new TopicIndex();
    const captured = '共同前缀之后这篇已捕获帖子在这里结束正文长度足够用于唯一身份核验';
    index.add([{ topicId: 'captured-without-suffix', text: captured }]);

    expect(index.find(`${captured}展开`)).toBeUndefined();
    expect(index.find(`${captured}全文`)).toBeUndefined();
  });

  it('uses fullText to resolve a shared short record only when containment is unique', () => {
    const index = new TopicIndex();
    // harvestTopics 的 text 最多 2000 字；真实的差异可能直到其后才出现在 fullText。
    const shared = '这是两条接口正文完全相同的共同开头'.repeat(160);
    const shortRecord = shared.slice(0, 2_000);
    const fullA = `${shared}甲帖后文只讨论现金流和股息率。`;
    const fullB = `${shared}乙帖后文只讨论研发投入和增长率。`;
    index.add([
      { topicId: 'full-a', text: shortRecord, fullText: fullA },
      { topicId: 'full-b', text: shortRecord, fullText: fullB },
    ]);

    expect(index.find(fullA)).toBe('full-a');
    expect(index.find(fullB)).toBe('full-b');
    expect(index.find(shortRecord)).toBeUndefined();
  });

  it('uses individual Q&A parts to resolve colliding main text without guessing', () => {
    const index = new TopicIndex();
    const shared = '两条问答拥有完全相同的问题开头只有回答后半段能够区分各自对应的帖子号';
    const answerA = `${shared}甲回答强调先控制回撤再考虑收益。`;
    const answerB = `${shared}乙回答强调先核对负债再配置资产。`;
    index.add([
      { topicId: 'part-a', text: shared, parts: [answerA] },
      { topicId: 'part-b', text: shared, parts: [answerB] },
    ]);

    expect(index.find(answerA)).toBe('part-a');
    expect(index.find(answerB)).toBe('part-b');
    expect(index.find(shared)).toBeUndefined();
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

  it('接口标题和页面正文分块时，用明确的正文 part 对上', () => {
    const index = new TopicIndex();
    const body = '本周市场情绪修复，成交量回到万亿以上，但结构分化依然明显，消费和医药继续磨底';
    index.add([
      {
        topicId: '522222222222222',
        text: `【每周复盘】${body}，我的应对是不加不减，等右侧信号。`,
        parts: ['【每周复盘】', body],
      },
    ]);

    expect(index.find(body)).toBe('522222222222222');
  });

  it('长帖 + 接口开头多一段：两边截同一长度就永远比不出来（回归）', () => {
    // 这是「20 条只对上 4 条」的真正主因。
    // 曾经 needle 和 haystack 都截到 240 字：接口那侧开头多了一段，它保留的正文
    // 就比页面那侧短一截，两边互相都不可能包含 —— 于是所有超过 240 字的长帖全跳过。
    const body = '关于长期投资的一点想法。'.repeat(40); // 远超 240 字
    const index = new TopicIndex();
    index.add([{ topicId: '588888888888888', text: `【本周复盘】${body}`, parts: [body] }]);

    // 页面上标题渲染在别处，正文从 body 开头起。
    expect(index.find(body)).toBe('588888888888888');
  });

  it('页面任意多出的前后文不能冒充可证明的同帖证据', () => {
    const body = '仓位管理的三条纪律，逐条说明。'.repeat(40);
    const index = new TopicIndex();
    index.add([{ topicId: '599999999999999', text: body }]);

    expect(index.find(`星主推荐 ${body} 我的不同观点如下。`)).toBeUndefined();
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

  it('折叠的短正文是多条的公共前缀时，宁可跳过也不认第一条', () => {
    // 复盘 / 周记类帖子常有相同开场白。折叠时页面上只渲染出开场白，
    // 它同时是好几条接口记录的前缀——按顺序返回第一条就等于猜，
    // 会把这条内容写到别人的地址上（红线：绝不猜帖子地址）。
    const index = new TopicIndex();
    index.add([
      { topicId: '511111111111111', text: '本周复盘：先说结论，仓位不动。下面展开讲三点，第一是估值。' },
      { topicId: '522222222222222', text: '本周复盘：先说结论，仓位不动。这周主要看了两个行业的财报。' },
    ]);

    // 页面上折叠着，只看得到公共开头。
    expect(index.find('本周复盘：先说结论，仓位不动。')).toBeUndefined();
    // 展开到能区分之后，照常对得上。
    expect(index.find('本周复盘：先说结论，仓位不动。这周主要看了两个行业的财报。'))
      .toBe('522222222222222');
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

describe('发布时间来自接口，而不是页面上那行字', () => {
  it('抓下 create_time，对上号后就能直接用', () => {
    // 页面上渲染的是「23年06月18日」这类写法，甚至「3天前」；接口里是完整时间戳。
    // 既然已经靠接口响应对上了帖子号，同一条记录里的发布时间当然也该用上。
    const records = harvestTopics({
      topics: [
        {
          topic_id: '814421825485112',
          create_time: '2023-06-18T20:14:55.123+0800',
          talk: { text: '这个是前面《小学鸡娃路线规划》这篇文章里提到的小学奥数的思维导图。' },
        },
      ],
    });
    expect(records[0]?.createTime).toBe('2023-06-18T12:14:55.123Z');

    const index = new TopicIndex();
    index.add(records);
    expect(index.publishedAtOf('814421825485112')).toBe('2023-06-18T12:14:55.123Z');
  });

  it('接口没给时间、或时间残缺时如实返回 undefined（绝不补出 2001 年）', () => {
    const records = harvestTopics({
      topics: [
        { topic_id: '111111111111111', create_time: '03-05', talk: { text: '缺年份的时间戳应当被拒掉。' } },
        { topic_id: '222222222222222', talk: { text: '这一条接口压根没给发布时间字段。' } },
      ],
    });
    expect(records[0]?.createTime).toBeUndefined();
    expect(records[1]?.createTime).toBeUndefined();
  });
});

describe('正文被折叠时用接口那份补齐', () => {
  it('留下接口的完整正文，且只在它确实更长时才留', () => {
    const long = '这是一篇很长的帖子。'.repeat(300);
    const [record] = harvestTopics({ topics: [{ topic_id: '901', talk: { text: long } }] });
    // 对号用的 text 截到 2000 字，归档用的 fullText 保住全文。
    expect(record?.text.length).toBe(2_000);
    expect(record?.fullText?.length).toBeGreaterThan(2_000);

    const [short] = harvestTopics({ topics: [{ topic_id: '902', talk: { text: '短帖不必重复留一份。' } }] });
    expect(short?.fullText).toBeUndefined();
  });

  it('records when the retained API body hit the defensive full-text limit', () => {
    const oversized = '这是一段需要完整归档的超长投资与经营正文。'.repeat(12_000);
    const [record] = harvestTopics({
      topics: [{ topic_id: '903', talk: { text: oversized } }],
    });

    expect(oversized.length).toBeGreaterThan(200_000);
    expect(record?.fullText).toHaveLength(200_000);
    expect(record?.fullTextTruncated).toBe(true);
  });

  it('preserves every API body segment instead of silently slicing arrays after four items', () => {
    const segments = Array.from(
      { length: 10 },
      (_, index) => ({ text: `第${index + 1}段投资经营正文，包含独立结论与行动建议。` }),
    );
    const [record] = harvestTopics({ topic_id: '9031', content: segments });

    expect(record?.parts).toContain('第10段投资经营正文，包含独立结论与行动建议。');
    expect(record?.fullTextTruncated).toBe(false);
  });

  it('preserves a meaningful two-character answer inside a source-proven Q&A body', () => {
    const question = '这个创业项目现在已经满足继续投入资源和扩大验证范围的全部条件了吗？';
    const [record] = harvestTopics({
      succeeded: true,
      resp_data: {
        topics: [{
          topic_id: '903100000000001',
          question: { text: question },
          answer: { text: '是。' },
        }],
      },
    }, 400, {
      responsePath: 'https://api.zsxq.com/v2/groups/48844584441158/topics',
    });

    expect(record?.sourceBodyProven).toBe(true);
    expect(record?.parts).toEqual([question, '是。']);
    expect(record?.fullText).toContain('是。');
  });

  it('does not certify a partial Q&A source object that omitted the answer component', () => {
    const [record] = harvestTopics({
      succeeded: true,
      resp_data: {
        topics: [{
          topic_id: '903100000000005',
          question: { text: '这个创业项目现在是否应该继续扩大投入？' },
        }],
      },
    }, 400, {
      responsePath: 'https://api.zsxq.com/v2/groups/48844584441158/topics',
    });

    expect(record?.sourceBodyProven).toBe(false);
    expect(record?.sourceMediaProven).toBe(false);
  });

  it('fails closed for numeric topic ids that JSON has already rounded', () => {
    const [record] = harvestTopics({
      topic_id: 55522452154844124,
      talk: { text: '这个数值帖子号超过 JavaScript 的安全整数范围，不能继续拿错误身份归档。' },
    });

    expect(record).toBeUndefined();
  });

  it('treats task and solution as source body segments instead of dropping that topic type', () => {
    const task = '请完成本周创业项目的用户访谈，并整理三个最关键的付费阻力。';
    const solution = '已完成，最关键的是决策周期、信任成本和预算审批。';
    const [record] = harvestTopics({
      succeeded: true,
      resp_data: {
        topics: [{
          topic_id: '903100000000002',
          task: { text: task },
          solution: { text: solution },
        }],
      },
    }, 400, {
      responsePath: 'https://api.zsxq.com/v2/groups/48844584441158/topics',
    });

    expect(record).toMatchObject({ sourceBodyProven: true, parts: [task, solution] });
    expect(record?.fullText).toContain(solution);
  });

  it.each([
    ['task', '请提交本周用户访谈记录和现金流复盘。'],
    ['solution', '本周已经完成访谈，并根据结论缩减了无效投放。'],
  ] as const)('certifies a standalone %s topic component', (type, body) => {
    const [record] = harvestTopics({
      succeeded: true,
      resp_data: {
        topics: [{
          topic_id: type === 'task' ? '903100000000010' : '903100000000011',
          type,
          [type]: { text: body },
        }],
      },
    }, 400, {
      responsePath: 'https://api.zsxq.com/v2/groups/48844584441158/topics',
    });

    expect(record).toMatchObject({ sourceBodyProven: true, sourceMediaProven: true });
    expect(record?.text).toContain(body);
  });

  it('retains every source image and proves media only when the known image schema is readable', () => {
    const first = 'https://images.zsxq.com/Fj_tail_1.jpg';
    const second = 'https://images.zsxq.com/Fj_tail_2.jpg';
    const [record] = harvestTopics({
      succeeded: true,
      resp_data: {
        topics: [{
          topic_id: '903100000000003',
          talk: {
            text: '这篇正文的尾部还有两张关键图表，折叠 DOM 尚未把它们挂出来。',
            images: [
              { original: { url: first }, name: '第一张图' },
              { large: { url: second } },
            ],
          },
        }],
      },
    }, 400, {
      responsePath: 'https://api.zsxq.com/v2/groups/48844584441158/topics',
    });

    expect(record?.sourceMediaProven).toBe(true);
    expect(record?.images).toEqual([
      { url: first, alt: '第一张图' },
      { url: second },
    ]);

    const [unknown] = harvestTopics({
      succeeded: true,
      resp_data: {
        topics: [{
          topic_id: '903100000000004',
          talk: {
            text: '图片对象出现了当前构建不认识的形状，不能假定媒体已经完整。',
            images: [{ image_id: 'opaque-without-url' }],
          },
        }],
      },
    }, 400, {
      responsePath: 'https://api.zsxq.com/v2/groups/48844584441158/topics',
    });
    expect(unknown?.sourceBodyProven).toBe(true);
    expect(unknown?.sourceMediaProven).toBe(false);
  });

  it('keeps every known image URL variant as an identity alias while preferring original for archival', () => {
    const original = 'https://images.zsxq.com/Fj_variant_original.jpg';
    const large = 'https://images.zsxq.com/Fj_variant_large.jpg';
    const thumbnail = 'https://images.zsxq.com/Fj_variant_thumbnail.jpg';
    const direct = 'https://images.zsxq.com/Fj_variant_direct.jpg';
    const src = 'https://images.zsxq.com/Fj_variant_src.jpg';
    const [record] = harvestTopics({
      succeeded: true,
      resp_data: {
        topics: [{
          topic_id: '903100000000015',
          talk: {
            text: '',
            images: [{
              image_id: 'variant-image',
              original: { url: original },
              large: { url: large },
              thumbnail: { url: thumbnail },
              url: direct,
              src,
            }],
          },
        }],
      },
    }, 400, {
      responsePath: 'https://api.zsxq.com/v2/groups/48844584441158/topics',
    });

    expect(record?.images).toEqual([{
      url: original,
      aliases: [large, thumbnail, direct, src],
    }]);
    const index = new TopicIndex();
    index.add(record ? [record] : []);
    for (const url of [original, large, thumbnail, direct, src]) {
      expect(index.findByImageUrls([url]), url).toEqual({
        status: 'unique',
        topicId: '903100000000015',
      });
    }

    const sanitized = topicRecordsFromMessage({
      source: 'data-collector:topics',
      hookVersion: TOPIC_HOOK_VERSION,
      hookBuildId: '开发构建',
      records: record ? [record] : [],
    });
    expect(sanitized?.[0]?.images).toEqual(record?.images);
    expect(sanitized?.[0]?.images).not.toBe(record?.images);
    expect(sanitized?.[0]?.images?.[0]?.aliases).not.toBe(record?.images?.[0]?.aliases);
  });

  it('merges compatible image aliases across repeated source observations without creating a conflict', () => {
    const topicId = '903100000000022';
    const body = '同一来源正文先后返回不同图片规格时仍是同一张图。';
    const original = 'https://images.zsxq.com/Fj_repeat_original.jpg';
    const large = 'https://images.zsxq.com/Fj_repeat_large.jpg';
    const base = {
      topicId,
      text: body,
      fullTextTruncated: false,
      sourceBodyProven: true,
      sourceMediaProven: true,
    } as const;
    const originalOnly = { ...base, images: [{ url: original }] };
    const withAlias = { ...base, images: [{ url: original, aliases: [large] }] };

    for (const records of [[originalOnly, withAlias], [withAlias, originalOnly]] as const) {
      const index = new TopicIndex();
      index.add(records);
      expect(index.sourceBodyConflicted(topicId)).toBe(false);
      expect(index.sourceImagesOf(topicId)).toEqual([{
        url: original,
        aliases: [large],
      }]);
      expect(index.findByImageUrls([large])).toEqual({ status: 'unique', topicId });
      expect(preferredTopicRecord(records[0], records[1]).images).toEqual([{
        url: original,
        aliases: [large],
      }]);
    }
  });

  it('unions complementary image aliases in first-seen order without exceeding the transport budget', () => {
    const topicId = '903100000000023';
    const original = 'https://images.zsxq.com/Fj_union_original.jpg';
    const firstAliases = Array.from(
      { length: 10 },
      (_, index) => `https://images.zsxq.com/Fj_union_first_${index}.jpg`,
    );
    const secondAliases = Array.from(
      { length: 10 },
      (_, index) => `https://images.zsxq.com/Fj_union_second_${index}.jpg`,
    );
    const base = {
      topicId,
      text: '同一张来源图片的互补规格必须跨响应留存。',
      fullTextTruncated: false,
      sourceBodyProven: true,
      sourceMediaProven: true,
    } as const;
    const first = { ...base, images: [{ url: original, aliases: firstAliases }] };
    const second = { ...base, images: [{ url: original, aliases: secondAliases }] };
    const expectedAliases = [...firstAliases, ...secondAliases.slice(0, 6)];

    const index = new TopicIndex();
    index.add([first, second]);

    expect(index.sourceBodyConflicted(topicId)).toBe(false);
    expect(index.sourceImagesOf(topicId)).toEqual([{ url: original, aliases: expectedAliases }]);
    expect(preferredTopicRecord(first, second).images).toEqual([{
      url: original,
      aliases: expectedAliases,
    }]);
    expect(first.images[0]?.aliases).toEqual(firstAliases);
    expect(second.images[0]?.aliases).toEqual(secondAliases);
  });

  it('keeps alias union when sticky truncation evidence clones the selected record', () => {
    const base = {
      topicId: '903100000000024',
      text: '截断证据与图片规格是两条独立证据链。',
      sourceBodyProven: true,
      sourceMediaProven: true,
    } as const;
    const previous = {
      ...base,
      fullTextTruncated: false,
      images: [{
        url: 'https://images.zsxq.com/Fj_sticky_original.jpg',
        aliases: ['https://images.zsxq.com/Fj_sticky_large.jpg'],
      }],
    };
    const candidate = {
      ...base,
      fullTextTruncated: true,
      images: [{
        url: 'https://images.zsxq.com/Fj_sticky_original.jpg',
        aliases: ['https://images.zsxq.com/Fj_sticky_thumbnail.jpg'],
      }],
    };

    expect(preferredTopicRecord(previous, candidate)).toMatchObject({
      fullTextTruncated: true,
      images: [{
        url: 'https://images.zsxq.com/Fj_sticky_original.jpg',
        aliases: [
          'https://images.zsxq.com/Fj_sticky_large.jpg',
          'https://images.zsxq.com/Fj_sticky_thumbnail.jpg',
        ],
      }],
    });
  });

  it('retains an image-only topic and treats opaque attachments or unknown media as unproven', () => {
    const imageUrl = 'https://images.zsxq.com/Fj_image_only.jpg';
    const [imageOnly] = harvestTopics({
      succeeded: true,
      resp_data: {
        topics: [{
          topic_id: '903100000000006',
          talk: { text: '', images: [{ original: { url: imageUrl }, name: '现金流图表' }] },
        }],
      },
    }, 400, {
      responsePath: 'https://api.zsxq.com/v2/groups/48844584441158/topics',
    });
    expect(imageOnly).toMatchObject({
      topicId: '903100000000006',
      text: '',
      sourceBodyProven: true,
      sourceMediaProven: true,
      images: [{ url: imageUrl, alt: '现金流图表' }],
    });

    const [opaque] = harvestTopics({
      succeeded: true,
      resp_data: {
        topics: [{
          topic_id: '903100000000007',
          talk: {
            text: '正文后还有一个当前构建拿不到下载地址的附件，不能宣称完整。',
            files: [{ file_id: 'opaque-file' }],
          },
        }],
      },
    }, 400, {
      responsePath: 'https://api.zsxq.com/v2/groups/48844584441158/topics',
    });
    expect(opaque?.sourceBodyProven).toBe(true);
    expect(opaque?.sourceMediaProven).toBe(false);

    const [unknownMedia] = harvestTopics({
      succeeded: true,
      resp_data: {
        topics: [{
          topic_id: '903100000000008',
          talk: {
            text: '正文携带未来媒体组件，当前构建不认识时必须 fail closed。',
            media_component: { opaque_id: 'future-media' },
          },
        }],
      },
    }, 400, {
      responsePath: 'https://api.zsxq.com/v2/groups/48844584441158/topics',
    });
    expect(unknownMedia?.sourceMediaProven).toBe(false);

    const [boldText] = harvestTopics({
      succeeded: true,
      resp_data: {
        topics: [{
          topic_id: '903100000000018',
          talk: {
            text: '正文里的加粗只是排版，不是媒体。<e type="text_bold">关键结论</e>',
          },
        }],
      },
    }, 400, {
      responsePath: 'https://api.zsxq.com/v2/groups/48844584441158/topics',
    });
    expect(boldText).toMatchObject({
      sourceBodyProven: true,
      sourceMediaProven: true,
    });

    for (const marker of [
      '<e type="image" image_id="missing-image" />',
      '<e type="file" file_id="missing-file" />',
    ]) {
      const [inlineOpaque] = harvestTopics({
        succeeded: true,
        resp_data: {
          topics: [{
            topic_id: marker.includes('image') ? '903100000000012' : '903100000000013',
            talk: { text: `这段正文后有一个未解析的内联资源。${marker}` },
          }],
        },
      }, 400, {
        responsePath: 'https://api.zsxq.com/v2/groups/48844584441158/topics',
      });
      expect(inlineOpaque?.sourceMediaProven, marker).toBe(false);
    }

    const [mismatchedInline] = harvestTopics({
      succeeded: true,
      resp_data: {
        topics: [{
          topic_id: '903100000000014',
          talk: {
            text: '正文<e type="image" image_id="expected-image" />',
            images: [{
              image_id: 'different-image',
              original: { url: 'https://images.zsxq.com/Fj_different.jpg' },
            }],
          },
        }],
      },
    }, 400, {
      responsePath: 'https://api.zsxq.com/v2/groups/48844584441158/topics',
    });
    expect(mismatchedInline?.sourceMediaProven).toBe(false);
  });

  it('treats unknown scalar media fields as incomplete but ignores pure count/size metadata', () => {
    const harvest = (talk: Record<string, unknown>) => harvestTopics({
      succeeded: true,
      resp_data: {
        topics: [{ topic_id: '903100000000016', talk }],
      },
    }, 400, {
      responsePath: 'https://api.zsxq.com/v2/groups/48844584441158/topics',
    })[0];

    for (const [key, value] of [
      ['media_component_id', 'opaque-media'],
      ['image_token', 'opaque-image'],
      ['file_id', 123456],
      ['audio_url', 'opaque-audio'],
      ['video_enabled', true],
    ] as const) {
      expect(harvest({ text: '正文携带当前构建无法解析的标量媒体字段。', [key]: value })
        ?.sourceMediaProven, key).toBe(false);
    }

    expect(harvest({
      text: '只有媒体尺寸和数量等纯元数据，不代表存在未解析的资源节点。',
      image_count: 0,
      file_size: 1024,
      audio_duration: 0,
      video_width: 1920,
      video_height: 1080,
    })?.sourceMediaProven).toBe(true);
  });

  it('distinguishes the closed content-voice narration cache from authored audio', () => {
    const harvest = (
      topicId: string,
      talk: Record<string, unknown>,
      topicFields: Record<string, unknown> = {},
    ) => harvestTopics({
      succeeded: true,
      resp_data: { topics: [{ topic_id: topicId, talk, ...topicFields }] },
    }, 400, {
      responsePath: 'https://api.zsxq.com/v2/groups/48844584441158/topics',
    })[0];
    const narrationCache = {
      file_id: 123456789,
      name: 'content.mp3',
      hash: 'opaque-cache-hash',
      size: 4096,
      duration: 88,
      download_count: 0,
      create_time: '2026-08-11T10:22:00.000+0800',
    };

    expect(harvest('903100000000029', {
      text: '完整纯文本正文。',
    }, {
      content_voice: narrationCache,
    })).toMatchObject({
      sourceBodyProven: true,
      sourceMediaProven: true,
    });

    for (const [topicId, field, value, atTopicRoot] of [
      ['903100000000030', 'voice', narrationCache, false],
      ['903100000000031', 'audio', narrationCache, false],
      ['903100000000032', 'content_voice', {
        ...narrationCache,
        download_url: 'https://files.zsxq.com/content.mp3',
      }, true],
      ['903100000000033', 'content_voice', {
        ...narrationCache,
        payload: { file_id: 123456789 },
      }, true],
    ] as const) {
      expect(harvest(topicId, {
        text: '真实语音、可下载音频或扩展结构仍必须完整解析。',
        ...(!atTopicRoot ? { [field]: value } : {}),
      }, atTopicRoot ? { [field]: value } : {})?.sourceMediaProven, `${field}:${topicId}`).toBe(false);
    }
  });

  it('does not certify more opaque inline placeholders than parsed structured assets', () => {
    const harvest = (topicId: string, talk: Record<string, unknown>) => harvestTopics({
      succeeded: true,
      resp_data: { topics: [{ topic_id: topicId, talk }] },
    }, 400, {
      responsePath: 'https://api.zsxq.com/v2/groups/48844584441158/topics',
    })[0];

    const oneImage = { original: { url: 'https://images.zsxq.com/Fj_one_inline.jpg' } };
    expect(harvest('903100000000017', {
      text: '正文<e type="image" /><e type="image" />',
      images: [oneImage],
    })?.sourceMediaProven).toBe(false);
    expect(harvest('903100000000018', {
      text: '正文<e type="image" />',
      images: [oneImage],
    })?.sourceMediaProven).toBe(true);

    const oneFile = { download_url: 'https://files.zsxq.com/one-inline.pdf' };
    expect(harvest('903100000000019', {
      text: '正文<e type="file" /><e type="file" />',
      files: [oneFile],
    })?.sourceMediaProven).toBe(false);
    expect(harvest('903100000000020', {
      text: '正文<e type="file" />',
      files: [oneFile],
    })?.sourceMediaProven).toBe(true);
  });

  it('keeps opaque inline video/card components incomplete and binds video ids to structured media', () => {
    const harvest = (topicId: string, talk: Record<string, unknown>) => harvestTopics({
      succeeded: true,
      resp_data: { topics: [{ topic_id: topicId, talk }] },
    }, 400, {
      responsePath: 'https://api.zsxq.com/v2/groups/48844584441158/topics',
    })[0];

    expect(harvest('903100000000022', {
      text: '正文<e type="video" video_id="missing-video" />',
    })?.sourceMediaProven).toBe(false);
    expect(harvest('903100000000023', {
      text: '正文<e type="card" id="opaque-card" />',
    })?.sourceMediaProven).toBe(false);
    expect(harvest('903100000000027', {
      text: '正文<e type="poll" href="https://example.com/poll" />',
    })?.sourceMediaProven).toBe(false);
    expect(harvest('903100000000028', {
      text: '正文<e type="future-widget" href="https://example.com/widget" />',
    })?.sourceMediaProven).toBe(false);

    const directVideo = 'https://files.zsxq.com/direct-inline-video.mp4';
    expect(harvest('903100000000024', {
      text: `正文<e type="video" href="${directVideo}" title="访谈视频" />`,
    })).toMatchObject({
      sourceMediaProven: true,
      attachments: [{ url: directVideo, title: '访谈视频' }],
    });

    const structuredVideo = 'https://files.zsxq.com/structured-video.mp4';
    expect(harvest('903100000000025', {
      text: '正文<e type="video" video_id="video-1" />',
      videos: [{ video_id: 'video-1', url: structuredVideo }],
    })).toMatchObject({
      sourceMediaProven: true,
      attachments: [{ url: structuredVideo, title: '视频' }],
    });
    expect(harvest('903100000000026', {
      text: '正文<e type="video" video_id="video-expected" />',
      videos: [{ video_id: 'video-other', url: structuredVideo }],
    })?.sourceMediaProven).toBe(false);
  });

  it('keeps source-media incompleteness sticky for the same proven topic body in either order', () => {
    const topicId = '903100000000021';
    const body = '同一帖子正文的任一来源观察发现未知媒体后都不能再洗白。';
    const complete = {
      topicId,
      text: body,
      fullTextTruncated: false,
      sourceBodyProven: true,
      sourceMediaProven: true,
    } as const;
    const incomplete = { ...complete, sourceMediaProven: false as const };

    for (const records of [[complete, incomplete], [incomplete, complete]] as const) {
      const index = new TopicIndex();
      index.add(records);
      expect(index.sourceBodyConflicted(topicId)).toBe(false);
      expect(index.sourceMediaProvenOf(topicId)).toBe(false);
      expect(preferredTopicRecord(records[0], records[1]).sourceMediaProven).toBe(false);
    }
  });

  it('sticks a conflict when one topic id produces two different source-proven bodies', () => {
    const topicId = '903100000000009';
    const first = '第一版正文讨论创业现金流和用户留存。'.repeat(4);
    const second = '第二版正文讨论完全不同的公司治理决策。'.repeat(4);
    const index = new TopicIndex();
    index.add(harvestTopics({
      succeeded: true,
      resp_data: { topics: [{ topic_id: topicId, talk: { text: first } }] },
    }, 400, {
      responsePath: 'https://api.zsxq.com/v2/groups/48844584441158/topics',
    }));
    index.add(harvestTopics({
      succeeded: true,
      resp_data: { topics: [{ topic_id: topicId, talk: { text: second } }] },
    }, 400, {
      responsePath: 'https://api.zsxq.com/v2/groups/48844584441158/topics',
    }));

    expect(index.sourceBodyConflicted(topicId)).toBe(true);
    expect(index.hasSourceBody(topicId)).toBe(false);
    expect(index.sourceBodyOf(topicId)).toBeUndefined();
  });

  it('marks the API body truncated when a defensive structure budget is actually exhausted', () => {
    const segments = Array.from(
      { length: 400 },
      (_, index) => ({ text: `预算测试第${index + 1}段正文。` }),
    );
    const [record] = harvestTopics({ topic_id: '9032', content: segments });

    expect(record?.fullTextTruncated).toBe(true);
  });

  it('does not let a later shorter duplicate erase the richer API body', () => {
    const index = new TopicIndex();
    const prefix = '同一条投资与经营正文。'.repeat(200);
    const rich = `${prefix}${'后半段完整内容。'.repeat(300)}`;
    index.add([{ topicId: '904', text: prefix.slice(0, 2_000), fullText: rich }]);
    index.add([{ topicId: '904', text: prefix.slice(0, 2_000) }]);

    expect(index.fullTextOf('904')).toBe(rich);
  });

  it('keeps truncation taint when an equal-length legacy record has no completeness flag', () => {
    const index = new TopicIndex();
    index.add([{
      topicId: '905',
      text: 'A'.repeat(2_000),
      fullText: 'A'.repeat(20_000),
      fullTextTruncated: true,
    }]);
    index.add([{
      topicId: '905',
      text: 'B'.repeat(2_000),
      fullText: 'B'.repeat(20_000),
    }]);

    expect(index.fullTextTruncatedOf('905')).toBe(true);
  });

  it('never lets a later shorter negative scan erase positive truncation evidence', () => {
    const index = new TopicIndex();
    index.add([{
      topicId: '906',
      text: 'A'.repeat(2_000),
      fullText: 'A'.repeat(20_000),
      fullTextTruncated: true,
    }]);
    index.add([{
      topicId: '906',
      text: 'B'.repeat(2_000),
      fullText: 'B'.repeat(19_000),
      fullTextTruncated: false,
    }]);

    expect(index.fullTextOf('906')).toBe('A'.repeat(20_000));
    expect(index.fullTextTruncatedOf('906')).toBe(true);
  });

  it('keeps source-proven body evidence separate from arbitrary richer summaries', () => {
    const index = new TopicIndex();
    const topicId = '906000000000001';
    const proven = '已知帖子正文端点直接返回的正文与最终结论。';
    index.add([{
      topicId,
      text: proven,
      fullTextTruncated: false,
      sourceBodyProven: true,
    }]);
    index.add([{
      topicId,
      text: `${proven}${'任意接口里更长的引用或评论摘要，不能继承完整证明。'.repeat(20)}`,
      fullTextTruncated: false,
      sourceBodyProven: false,
    }]);

    expect(index.has(topicId)).toBe(true);
    expect(index.hasSourceBody(topicId)).toBe(true);
    expect(index.sourceBodyOf(topicId)).toBe(proven);

    const unknownOnly = new TopicIndex();
    unknownOnly.add([{
      topicId,
      text: '仅标题或摘要型记录，即使同号也只能用于身份，不能证明正文完整。',
      fullTextTruncated: false,
      sourceBodyProven: false,
    }]);
    expect(unknownOnly.has(topicId)).toBe(true);
    expect(unknownOnly.hasSourceBody(topicId)).toBe(false);
    expect(unknownOnly.sourceBodyOf(topicId)).toBeUndefined();
  });

  it('accepts topic records only from the exact current main-world hook build', () => {
    const records = [{
      topicId: '907000000000000',
      text: '当前钩子正文',
      fullTextTruncated: false,
      sourceBodyProven: true,
      sourceMediaProven: true,
    }];
    expect(topicRecordsFromMessage({ source: 'data-collector:topics', records })).toBeUndefined();
    expect(topicRecordsFromMessage({
      source: 'data-collector:topics',
      hookVersion: TOPIC_HOOK_VERSION - 1,
      hookBuildId: 'build-B',
      records,
    })).toBeUndefined();
    expect(topicRecordsFromMessage({
      source: 'data-collector:topics',
      hookVersion: TOPIC_HOOK_VERSION,
      hookBuildId: 'build-A',
      records,
    })).toBeUndefined();
    expect(topicRecordsFromMessage({
      source: 'data-collector:topics',
      hookVersion: TOPIC_HOOK_VERSION,
      hookBuildId: '开发构建',
      records,
    })).toEqual(records);
  });

  it('rejects malformed or over-budget records from the current public-build route without throwing', () => {
    const message = (records: unknown) => ({
      source: 'data-collector:topics',
      hookVersion: TOPIC_HOOK_VERSION,
      hookBuildId: '开发构建',
      records,
    });
    const valid = {
      topicId: '907000000000000',
      text: '有效正文',
      fullTextTruncated: false,
      sourceBodyProven: true,
      sourceMediaProven: true,
    };
    const cases: unknown[] = [
      'not-an-array',
      Array.from({ length: 401 }, () => valid),
      [{ ...valid, topicId: '907' }],
      [{ ...valid, topicId: 'x'.repeat(15) }],
      [{ ...valid, text: '' }],
      [{ ...valid, text: ' '.repeat(10) }],
      [{ ...valid, text: 'x'.repeat(2_001) }],
      [{ ...valid, fullText: 'x'.repeat(200_001) }],
      [{ ...valid, parts: Array.from({ length: 257 }, () => '段落') }],
      [{ ...valid, parts: ['x'.repeat(2_001)] }],
      [{ ...valid, keys: Array.from({ length: 25 }, (_, index) => `key-${index}`) }],
      [{ ...valid, keys: ['x'.repeat(129)] }],
      [{ topicId: valid.topicId, text: valid.text }],
      [{ ...valid, fullTextTruncated: 'false' }],
      [{ ...valid, sourceBodyProven: 'true' }],
      Array.from({ length: 11 }, (_, index) => ({
        topicId: String(907000000000000 + index),
        text: '总预算测试',
        fullText: 'x'.repeat(200_000),
        fullTextTruncated: false,
        sourceBodyProven: true,
        sourceMediaProven: true,
      })),
    ];

    for (const records of cases) {
      expect(() => topicRecordsFromMessage(message(records))).not.toThrow();
      expect(topicRecordsFromMessage(message(records))).toBeUndefined();
    }
  });

  it('returns detached sanitized copies and strips unknown fields', () => {
    const input = {
      topicId: '907000000000001',
      text: '当前构建的完整正文',
      parts: ['第一段', '第二段'],
      keys: ['topic_id', 'talk'],
      fullText: '当前构建的完整正文，还有更长的尾部。',
      fullTextTruncated: false,
      sourceBodyProven: true,
      sourceMediaProven: true,
      ignored: { attackerControlled: true },
    };
    const [copy] = topicRecordsFromMessage({
      source: 'data-collector:topics',
      hookVersion: TOPIC_HOOK_VERSION,
      hookBuildId: '开发构建',
      records: [input],
    })!;

    expect(copy).not.toBe(input);
    expect(copy).toEqual({
      topicId: input.topicId,
      text: input.text,
      parts: input.parts,
      keys: input.keys,
      fullText: input.fullText,
      fullTextTruncated: false,
      sourceBodyProven: true,
      sourceMediaProven: true,
    });
    expect(copy.parts).not.toBe(input.parts);
    expect(copy.keys).not.toBe(input.keys);
    expect(copy).not.toHaveProperty('ignored');
  });

  it('渲染接口正文时保住外链——星球长文帖的正文就是一个外链', () => {
    const html = inlineMarkupToHtml(
      '先跟新粉解释下：\n<e type="web" href="https%3A%2F%2Farticles.zsxq.com%2Fid_x.html" title="%E5%B1%85%E6%B0%91%E5%80%BA%E5%8A%A1" />',
    );
    expect(html).toContain('<a href="https://articles.zsxq.com/id_x.html">居民债务</a>');
    expect(html).toContain('<p>先跟新粉解释下：</p>');
  });

  it('正文里本来就有的尖括号要转义，不能当成标记', () => {
    expect(inlineMarkupToHtml('if a < b && b > c 则成立')).toBe(
      '<p>if a &lt; b &amp;&amp; b &gt; c 则成立</p>',
    );
  });
});
