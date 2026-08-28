import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  ExtractionError,
  detectSource,
  extractDocument,
  extractList,
  pendingTopicCount,
} from '../../packages/extension/src/extractors/index.js';
import { harvestTopics, TopicIndex } from '../../packages/extension/src/topicIndex.js';
import { parsePublishedAt } from '../../packages/extension/src/extractors/common.js';
import {
  completeContent,
  isZsxqArticle,
  linkedArticleUrl,
  stripUiNoise,
  titleFromText,
} from '../../packages/extension/src/extractors/zsxq.js';

/** 接口响应里拿到的帖子号（DOM 上没有），前两条能对上号，第三条对不上。 */
function topicIndex(): TopicIndex {
  const index = new TopicIndex();
  index.add([
    {
      topicId: '511111111111111',
      text: '第一条帖子的正文内容，足够长以便通过长度校验判断。',
      fullTextTruncated: false,
      sourceBodyProven: true,
      sourceMediaProven: true,
    },
    {
      topicId: '522222222222222',
      text: '第二条帖子的正文内容，同样足够长以便通过长度校验。',
      fullTextTruncated: false,
      sourceBodyProven: true,
      sourceMediaProven: true,
    },
  ]);
  return index;
}

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const NOW = () => '2026-07-18T00:00:00.000Z';
const PROVEN_TOPIC_CONTEXT = {
  responsePath: 'https://api.zsxq.com/v2/groups/48844584441158/topics',
} as const;

function harvestProvenTopic(topic: Record<string, unknown>) {
  return harvestTopics({ succeeded: true, resp_data: { topics: [topic] } }, 400, PROVEN_TOPIC_CONTEXT);
}

async function fixture(name: string, url: string): Promise<Document> {
  const html = await readFile(join(FIXTURES, name), 'utf8');
  return new JSDOM(html, { url }).window.document;
}

describe('source detection', () => {
  it('detects the supported sources', () => {
    expect(detectSource(new URL('https://mp.weixin.qq.com/s/x'))).toBe('wechat');
    expect(detectSource(new URL('https://wx.zsxq.com/group/123/topic/456'))).toBe('zsxq');
    expect(detectSource(new URL('https://www.nowcoder.com/discuss/123'))).toBe('nowcoder');
    expect(detectSource(new URL('https://github.com/acme/agent-lab'))).toBe('github');
  });

  it('keeps GitHub collection in the Bridge provider instead of the page extractor', () => {
    const url = 'https://github.com/acme/agent-lab';
    const document = new JSDOM('<main><article>README</article></main>', { url }).window.document;

    expect(() => extractDocument(document, url, NOW)).toThrowError(
      expect.objectContaining<Partial<ExtractionError>>({
        code: 'UNSUPPORTED_LAYOUT',
        message: 'GitHub 项目由 fe-journey 定时任务采集',
      }),
    );
  });
});

describe('WeChat extraction', () => {
  it('extracts the supplied smoke article structure and normalizes lazy images', async () => {
    const url = 'https://mp.weixin.qq.com/s/uW5gUigjslVY24YmCYhg0g?scene=1#rd';
    const result = extractDocument(await fixture('wechat-article.html', url), url, NOW);

    expect(result).toMatchObject({
      schemaVersion: 1,
      source: 'wechat',
      kind: 'article',
      title: '一夜之间，通胀的玩笑这次开大了',
      author: '重远投资观',
      canonicalUrl: 'https://mp.weixin.qq.com/s/uW5gUigjslVY24YmCYhg0g',
      collectedAt: NOW(),
    });
    expect(result.publishedAt).toBe('2026-07-17T12:37:00.000Z');
    expect(result.text).toContain('通胀预期为什么重要');
    expect(result.images).toEqual([
      {
        url: 'https://mmbiz.qpic.cn/mmbiz_jpg/example/640?wx_fmt=jpeg',
        alt: '通胀图表',
      },
    ]);
    expect(result.html).toContain('src="https://mmbiz.qpic.cn/');
    expect(result.html).not.toContain('qrcode');
  });

  it('uses inert WeChat page variables when rendered metadata nodes are empty', () => {
    const url = 'https://mp.weixin.qq.com/s/variable-fallback';
    const doc = new JSDOM(`
      <script>
        var msg_title = "变量标题";
        var nickname = "变量公众号";
        var ct = "1784280000";
      </script>
      <div id="js_content"><p>${'这是一段足够长的公众号正文内容。'.repeat(5)}</p></div>
    `, { url }).window.document;

    const result = extractDocument(doc, url, NOW);

    expect(result).toMatchObject({ title: '变量标题', author: '变量公众号' });
    expect(result.publishedAt).toBe(new Date(1_784_280_000_000).toISOString());
  });
});

describe('ZSXQ extraction（按真实 Angular DOM）', () => {
  const DETAIL = 'https://wx.zsxq.com/group/48844584441158/topic/55522452154844124';
  const LIST = 'https://wx.zsxq.com/group/48844584441158';

  it('extracts a topic detail, derives a title from the body, and drops the comments', async () => {
    const result = extractDocument(await fixture('zsxq-topic.html', DETAIL), DETAIL, NOW);

    expect(result).toMatchObject({ source: 'zsxq', kind: 'post', author: '陈老师' });
    // 作者绝不能抓成点赞的人名列表：归档时作者是用来定博主的，抓错直接串档。
    expect(result.author).not.toContain('百事可乐');
    // 发布时间在 .author .date 上，原先的选择器一个都没命中。
    expect(result.publishedAt).toBe('2026-07-20T01:12:00.000Z');
    // 站点 <title> 恒为「…-知识星球」，标题必须由正文首句派生。
    expect(result.title).toContain('创业板已经跌破 60 日线');
    expect(result.title).not.toContain('知识星球');
    expect(result.text).toContain('股价是业绩的期货');
    // 评论在正文容器之外，不应混入归档正文。
    expect(result.text).not.toContain('查看更多评论');
    expect(result.text).not.toContain('网友甲');
    expect(result.images[0]?.url).toBe('https://images.zsxq.com/chart.png');
  });

  it('preserves an embedded long-article resource as a safe absolute link', () => {
    const articleUrl = 'https://articles.zsxq.com/id_embeddedresource.html';
    const embedUrl = 'https://player.zsxq.com/embed/interview-1';
    const body = '这篇知识星球长文包含完整文字论证，并在正文中嵌入一段访谈视频。'.repeat(8);
    const doc = new JSDOM(`
      <main><article><div class="article-content">
        <p>${body}</p>
        <iframe src="${embedUrl}" title="访谈视频"></iframe>
      </div></article></main>
    `, { url: articleUrl }).window.document;

    const result = extractDocument(doc, articleUrl, NOW);

    expect(result.kind).toBe('article');
    expect(result.html).toContain(`href="${embedUrl}"`);
    expect(result.html).toContain('访谈视频');
    expect(result.html).not.toContain('<iframe');
    expect(result.truncated).toBe(false);
  });

  it('selects the detail container whose explicit topic id matches the requested URL', () => {
    const targetId = '55522452154844124';
    const staleId = '55522452154844125';
    const stale = '这是 SPA 仍留在页面里的旧列表帖子 B，绝不能冒充目标 A 入库。'.repeat(4);
    const target = '这才是当前详情 URL 对应的目标帖子 A，必须根据根节点 topic id 选中。'.repeat(4);
    const doc = new JSDOM(`
      <div class="topic-container" data-topic-id="${staleId}">
        <div class="talk-content-container"><div class="content">${stale}</div></div>
      </div>
      <div class="topic-container" data-topic-id="${targetId}">
        <div class="talk-content-container"><div class="content">${target}</div></div>
      </div>
    `, { url: DETAIL }).window.document;

    const result = extractDocument(doc, DETAIL, NOW);

    expect(result.text).toContain(target.slice(-80));
    expect(result.text).not.toContain('SPA 仍留在页面里的旧列表帖子 B');
  });

  it('fails closed when multiple semantic detail containers cannot prove the requested topic id', () => {
    const first = '多候选详情页里的第一段强语义正文，但它没有目标帖子身份证明。'.repeat(4);
    const second = '多候选详情页里的第二段强语义正文，同样无法证明它属于当前 URL。'.repeat(4);
    const doc = new JSDOM(`
      <div class="topic-container">
        <div class="talk-content-container"><div class="content">${first}</div></div>
      </div>
      <div class="topic-container">
        <div class="talk-content-container"><div class="content">${second}</div></div>
      </div>
    `, { url: DETAIL }).window.document;

    expect(() => extractDocument(doc, DETAIL, NOW)).toThrowError(
      expect.objectContaining<Partial<ExtractionError>>({
        code: 'UNSUPPORTED_LAYOUT',
        message: expect.stringContaining('身份'),
      }),
    );
  });

  it('refuses to save a list page as one article and points at batch collection', async () => {
    const doc = await fixture('zsxq-list.html', LIST);

    // 列表页有多条帖子；绝不能把整个信息流当成一篇存下来。
    let thrown: unknown;
    try {
      extractDocument(doc, LIST, NOW);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as ExtractionError).code).toBe('UNSUPPORTED_LAYOUT');
    expect((thrown as Error).message).toContain('批量保存');
  });

  it('splits a list page into one document per post, each carrying its own topic URL', async () => {
    const doc = await fixture('zsxq-list.html', LIST);

    const list = extractList(doc, LIST, topicIndex(), NOW);

    const collected = list.entries.flatMap(entry => entry.document ?? []);
    // 身份由规范 URL 派生：每条必须带自己的 /topic/ 地址，否则会算出同一个 ID 相互覆盖。
    expect(collected.map(item => item.canonicalUrl)).toEqual([
      'https://wx.zsxq.com/group/48844584441158/topic/511111111111111',
      'https://wx.zsxq.com/group/48844584441158/topic/522222222222222',
    ]);
    expect(collected[0]).toMatchObject({ source: 'zsxq', kind: 'post', author: '重远' });
    expect(collected[0]?.text).toContain('第一条帖子');
    // 接口里没有的那条如实计入 skipped，绝不猜一个 id（猜错会把两条写到同一个文件上）。
    expect(list.skipped).toBe(1);
    expect(list.total).toBe(3);
    // 分类标签栏也用 .topic-container，绝不能被当成一篇帖子。
    expect(collected.some(item => item.text.includes('只看星主'))).toBe(false);
    // 每条都带稳定 key 与标题：侧栏明细列表点它就能滚回页面上的那一条。
    expect(list.entries).toHaveLength(3);
    expect(new Set(list.entries.map(entry => entry.key)).size).toBe(3);
    expect(list.entries.every(entry => entry.title.length > 0)).toBe(true);
    // 跳过的那条要带上原因，而不是无声消失。
    // 跳过原因要说清是什么、为什么、怎么办——只写「没能对上帖子号」用户无从下手。
    const reason = list.entries.find(entry => !entry.document)?.reason ?? '';
    expect(reason).toContain('编号');
    expect(reason).toContain('接口响应');
    expect(reason).toContain('切走再切回来');
  });

  it('does not mistake an internal link to another topic for the current post URL', () => {
    const ownId = '566666666666661';
    const referencedId = '566666666666662';
    const body = '这是当前帖子自己的完整正文，并在末尾附上另一篇旧帖作为参考。旧帖参考';
    const doc = new JSDOM(`
      <div class="main-content-container"><div class="topic-container">
        <div class="talk-content-container"><div class="content">
          这是当前帖子自己的完整正文，并在末尾附上另一篇旧帖作为参考。<a href="/group/48844584441158/topic/${referencedId}">旧帖参考</a>
        </div></div>
      </div></div>
    `, { url: LIST }).window.document;
    const index = new TopicIndex();
    index.add([{ topicId: ownId, text: body, fullTextTruncated: false }]);

    const result = extractList(doc, LIST, index, NOW).entries[0]?.document;

    expect(result?.canonicalUrl).toBe(`${LIST}/topic/${ownId}`);
  });

  it('does not treat an unrelated descendant long id as the current topic id', () => {
    const ownId = '577777777777771';
    const unrelatedUserId = '577777777777772';
    const body = '这是当前帖子自己的完整正文，旁观者名字只属于作者区的子组件。旁观者';
    const doc = new JSDOM(`
      <div class="main-content-container"><div class="topic-container">
        <div class="talk-content-container"><div class="content">这是当前帖子自己的完整正文，旁观者名字只属于作者区的子组件。旁观者</div></div>
        <span data-user-id="${unrelatedUserId}">旁观者</span>
      </div></div>
    `, { url: LIST }).window.document;
    const index = new TopicIndex();
    index.add([{ topicId: ownId, text: body, fullTextTruncated: false }]);

    const result = extractList(doc, LIST, index, NOW).entries[0]?.document;

    expect(result?.canonicalUrl).toBe(`${LIST}/topic/${ownId}`);
  });

  it('skips a list item when no semantic body selector matches instead of archiving the whole topic shell', () => {
    const shiftedBody = '新版页面里的正文仍然很长，但它所在的类名已经变化，不能把作者、时间和操作栏一起冒充完整正文。'.repeat(6);
    const doc = new JSDOM(`
      <div class="main-content-container">
        <div class="topic-container" data-topic-id="655555555555555">
          <div class="author"><div class="info">
            <div class="role owner">陈老师</div><div class="date">2026-08-25 08:00</div>
          </div></div>
          <div class="future-body-layout">${shiftedBody}</div>
          <div class="content">这是评论区的通用 content 节点，不能当成作者正文。${'评论'.repeat(30)}</div>
          <div class="actions">点赞 评论 分享</div>
        </div>
      </div>
    `, { url: LIST }).window.document;

    const list = extractList(doc, LIST, undefined, NOW);

    expect(list.skipped).toBe(1);
    expect(list.entries[0]?.document).toBeUndefined();
    expect(list.entries[0]?.reason).toContain('正文结构');
  });

  it('uses captured API text to complete a collapsed post even when the full text is under 2000 characters', () => {
    const fullText = '这是陈老师关于投资、创业和企业经营的完整复盘，包含后续判断与执行建议。'.repeat(24);
    const collapsedText = fullText.slice(0, 72);
    const doc = new JSDOM(`
      <div class="main-content-container">
        <div class="topic-container">
          <div class="author"><div class="info">
            <div class="role owner">陈老师</div><div class="date">2026-08-24 08:00</div>
          </div></div>
          <div class="talk-content-container"><div class="content">
            ${collapsedText}<span>展开全部</span>
          </div></div>
        </div>
      </div>
    `, { url: LIST }).window.document;
    const index = new TopicIndex();
    index.add(harvestProvenTopic({
      topic_id: '633333333333333',
      create_time: '2026-08-24T08:00:00.000+0800',
      talk: { text: fullText },
    }));

    const result = extractList(doc, LIST, index, NOW).entries[0]?.document;

    expect(fullText.length).toBeLessThan(2_000);
    expect(result?.canonicalUrl).toBe(`${LIST}/topic/633333333333333`);
    expect(result?.text).toContain(fullText.slice(-80));
    expect(result?.text).not.toContain('展开全部');
    expect(result?.truncated).toBe(false);
  });

  it('does not drop a two-character answer when source-proven Q&A replaces folded DOM', () => {
    const topicId = '633333333333334';
    const question = '这个创业项目现在已经满足继续投入资源和扩大验证范围的全部条件了吗？';
    const doc = new JSDOM(`
      <div class="main-content-container">
        <div class="topic-container">
          <div class="q-content-container"><div class="content">${question}</div></div>
          <div class="answer-content-container"><div class="content"><span>展开全部</span></div></div>
        </div>
      </div>
    `, { url: LIST }).window.document;
    const index = new TopicIndex();
    index.add(harvestProvenTopic({
      topic_id: topicId,
      question: { text: question },
      answer: { text: '是。' },
    }));

    const result = extractList(doc, LIST, index, NOW).entries[0]?.document;

    expect(result?.canonicalUrl).toBe(`${LIST}/topic/${topicId}`);
    expect(result?.text).toContain(question);
    expect(result?.text).toContain('是。');
    expect(result?.truncated).toBe(false);
  });

  it('restores source-proven tail images that are absent from the folded DOM', () => {
    const topicId = '633333333333335';
    const preview = '这篇投资复盘的 DOM 只显示首段，尾部图表尚未挂载。';
    const tail = '接口正文还包含完整结论与图表说明。'.repeat(12);
    const imageUrl = 'https://images.zsxq.com/Fj_complete_tail.jpg';
    const doc = new JSDOM(`
      <div class="main-content-container">
        <div class="topic-container">
          <div class="talk-content-container"><div class="content">
            ${preview}<span>展开全部</span>
          </div></div>
        </div>
      </div>
    `, { url: LIST }).window.document;
    const index = new TopicIndex();
    index.add(harvestProvenTopic({
      topic_id: topicId,
      talk: {
        text: `${preview}${tail}`,
        images: [{ original: { url: imageUrl }, name: '完整尾图' }],
      },
    }));

    const result = extractList(doc, LIST, index, NOW).entries[0]?.document;

    expect(result?.text).toContain(tail);
    expect(result?.images).toContainEqual({ url: imageUrl, alt: '完整尾图' });
    expect(result?.html).toContain(imageUrl);
    expect(result?.truncated).toBe(false);
  });

  it('rejects a source-proven body when the DOM still contains an unlisted video resource', () => {
    const topicId = '633333333333343';
    const body = '当前帖子正文已经来自精确接口，但虚拟节点仍残留上一帖的视频资源。'.repeat(4);
    const staleVideo = 'https://files.zsxq.com/stale-previous-topic.mp4';
    const doc = new JSDOM(`
      <div class="main-content-container">
        <div class="topic-container">
          <div class="talk-content-container"><div class="content">
            <p>${body}</p><video controls><source src="${staleVideo}"></video>
          </div></div>
        </div>
      </div>
    `, { url: LIST }).window.document;
    const index = new TopicIndex();
    index.add(harvestProvenTopic({ topic_id: topicId, talk: { text: body } }));

    const entry = extractList(doc, LIST, index, NOW).entries[0];

    expect(entry?.document).toBeUndefined();
    expect(entry?.url).toBe(`${LIST}/topic/${topicId}`);
    expect(entry?.reason).toContain('正文/资源尚未同步');
    expect(entry?.retryable).toBe(true);
  });

  it('rejects unlisted poster and srcset variants that would otherwise disappear from a text post', () => {
    const topicId = '633333333333344';
    const body = '正文虽然一致，但响应式图片和视频封面也属于必须核对的正文资源。'.repeat(4);
    const stalePoster = 'https://images.zsxq.com/stale-video-poster.jpg';
    const staleSrcset = 'https://images.zsxq.com/stale-responsive-large.jpg';
    const doc = new JSDOM(`
      <div class="main-content-container">
        <div class="topic-container">
          <div class="talk-content-container"><div class="content">
            <p>${body}</p>
            <video poster="${stalePoster}"></video>
            <picture><source srcset="${staleSrcset} 2x"></picture>
          </div></div>
        </div>
      </div>
    `, { url: LIST }).window.document;
    const index = new TopicIndex();
    index.add(harvestProvenTopic({ topic_id: topicId, talk: { text: body } }));

    const entry = extractList(doc, LIST, index, NOW).entries[0];

    expect(entry?.document).toBeUndefined();
    expect(entry?.retryable).toBe(true);
  });

  it('archives an image-only topic by exact source image identity instead of dropping it as short text', () => {
    const topicId = '633333333333338';
    const imageUrl = 'https://images.zsxq.com/Fj_image_only_topic.jpg';
    const doc = new JSDOM(`
      <div class="main-content-container">
        <div class="topic-container">
          <div class="talk-content-container"><div class="content">
            <img src="${imageUrl}" alt="现金流图表">
          </div></div>
        </div>
      </div>
    `, { url: LIST }).window.document;
    const index = new TopicIndex();
    index.add(harvestProvenTopic({
      topic_id: topicId,
      talk: { text: '', images: [{ original: { url: imageUrl }, name: '现金流图表' }] },
    }));

    const result = extractList(doc, LIST, index, NOW).entries[0]?.document;

    expect(result?.canonicalUrl).toBe(`${LIST}/topic/${topicId}`);
    expect(result?.title).toContain('现金流图表');
    expect(result?.images).toEqual([{ url: imageUrl, alt: '现金流图表' }]);
    expect(result?.truncated).toBe(false);
  });

  it('matches a rendered large image alias but archives only the source original URL', () => {
    const topicId = '633333333333342';
    const originalUrl = 'https://images.zsxq.com/Fj_original_quality.jpg';
    const largeUrl = 'https://images.zsxq.com/Fj_large_rendered.jpg';
    const doc = new JSDOM(`
      <div class="main-content-container">
        <div class="topic-container">
          <div class="talk-content-container"><div class="content">
            <img src="${largeUrl}" alt="资产配置原图">
          </div></div>
        </div>
      </div>
    `, { url: LIST }).window.document;
    const index = new TopicIndex();
    index.add(harvestProvenTopic({
      topic_id: topicId,
      talk: {
        text: '',
        images: [{
          original: { url: originalUrl },
          large: { url: largeUrl },
          name: '资产配置原图',
        }],
      },
    }));

    const result = extractList(doc, LIST, index, NOW).entries[0]?.document;

    expect(result?.canonicalUrl).toBe(`${LIST}/topic/${topicId}`);
    expect(result?.images).toEqual([{ url: originalUrl, alt: '资产配置原图' }]);
    expect(result?.html).toContain(originalUrl);
    expect(result?.html).not.toContain(largeUrl);
    expect(result?.truncated).toBe(false);
  });

  it('does not use a comment image to identify an empty image-only body as another topic', () => {
    const otherTopicId = '633333333333341';
    const commentImage = 'https://images.zsxq.com/Fj_comment_other_topic.jpg';
    const doc = new JSDOM(`
      <div class="main-content-container">
        <div class="topic-container">
          <div class="talk-content-container"><div class="content"></div></div>
          <div class="comments"><img src="${commentImage}" alt="评论配图"></div>
        </div>
      </div>
    `, { url: LIST }).window.document;
    const index = new TopicIndex();
    index.add(harvestProvenTopic({
      topic_id: otherTopicId,
      talk: { text: '', images: [{ original: { url: commentImage } }] },
    }));

    const entry = extractList(doc, LIST, index, NOW).entries[0];

    expect(entry?.document).toBeUndefined();
    expect(entry?.url).toBeUndefined();
    expect(entry?.reason).toContain('编号没截到');
    expect(entry?.retryable).toBe(true);
  });

  it('archives a short source-equal text post when its full component and media schemas are proven', () => {
    const topicId = '633333333333339';
    const body = '先活下来。';
    const doc = new JSDOM(`
      <div class="main-content-container">
        <div class="topic-container" data-topic-id="${topicId}">
          <div class="talk-content-container"><div class="content">${body}</div></div>
        </div>
      </div>
    `, { url: LIST }).window.document;
    const index = new TopicIndex();
    index.add(harvestProvenTopic({ topic_id: topicId, talk: { text: body } }));

    const result = extractList(doc, LIST, index, NOW).entries[0]?.document;

    expect(result?.text).toBe(body);
    expect(result?.truncated).toBe(false);
  });

  it('archives a short source-proven long-article card and preserves its exact article URL', () => {
    const topicId = '633333333333340';
    const articleUrl = 'https://articles.zsxq.com/id_short_intro.html';
    const inline = `<e type="web" href="${articleUrl}" title="看全文" />`;
    const doc = new JSDOM(`
      <div class="main-content-container">
        <div class="topic-container" data-topic-id="${topicId}">
          <div class="talk-content-container"><div class="content">
            <a href="${articleUrl}">看全文</a>
          </div></div>
        </div>
      </div>
    `, { url: LIST }).window.document;
    const index = new TopicIndex();
    index.add(harvestProvenTopic({ topic_id: topicId, talk: { text: inline } }));

    const result = extractList(doc, LIST, index, NOW).entries[0]?.document;

    expect(result?.text).toBe('看全文');
    expect(result?.html).toContain(`href="${articleUrl}"`);
    expect(result?.truncated).toBe(false);
  });

  it('preserves richer DOM and stays unknown when the proven API body is only its prefix', () => {
    const topicId = '633333333333336';
    const question = '这个创业项目现在是否应该继续扩大投入？';
    const answer = '应该先完成下一轮留存与付费验证，再决定扩张节奏。';
    const doc = new JSDOM(`
      <div class="main-content-container">
        <div class="topic-container" data-topic-id="${topicId}">
          <div class="q-content-container"><div class="content">${question}</div></div>
          <div class="answer-content-container"><div class="content">${answer}</div></div>
        </div>
      </div>
    `, { url: LIST }).window.document;
    const index = new TopicIndex();
    index.add(harvestProvenTopic({
      topic_id: topicId,
      question: { text: question },
    }));

    const result = extractList(doc, LIST, index, NOW).entries[0]?.document;

    expect(result?.text).toContain(question);
    expect(result?.text).toContain(answer);
    expect(result?.truncated).toBeUndefined();
  });

  it('rejects a transient root-id update before that root body and assets switch to the same topic', () => {
    const topicId = '633333333333337';
    const stale = '这是虚拟列表上一帖 A 的正文与资源，根节点编号已经抢先切成 B。'.repeat(4);
    const current = '这是当前帖子 B 的完整正文，必须只保留属于 B 的正文与资源。'.repeat(4);
    const staleImage = 'https://images.zsxq.com/Fj_stale_A.jpg';
    const staleArticle = 'https://articles.zsxq.com/id_staleA.html';
    const index = new TopicIndex();
    index.add(harvestProvenTopic({
      topic_id: topicId,
      talk: { text: current },
    }));
    const staleFrame = new JSDOM(`
      <div class="main-content-container">
        <div class="topic-container" data-topic-id="${topicId}">
          <div class="talk-content-container"><div class="content">
            ${stale}<a href="${staleArticle}">全文</a><img src="${staleImage}">
          </div></div>
        </div>
      </div>
    `, { url: LIST }).window.document;

    const first = extractList(staleFrame, LIST, index, NOW).entries[0];

    expect(first?.document).toBeUndefined();
    expect(first?.retryable).toBe(true);

    const currentFrame = new JSDOM(`
      <div class="main-content-container">
        <div class="topic-container" data-topic-id="${topicId}">
          <div class="talk-content-container"><div class="content">${current}</div></div>
        </div>
      </div>
    `, { url: LIST }).window.document;
    const final = extractList(currentFrame, LIST, index, NOW).entries[0]?.document;

    expect(final?.canonicalUrl).toBe(`${LIST}/topic/${topicId}`);
    expect(final?.truncated).toBe(false);
    expect(final?.html).not.toContain(staleArticle);
    expect(final?.html).not.toContain(staleImage);
    expect(final?.images).toEqual([]);
  });

  it('marks a replacement as incomplete when the captured API body exceeded its retention limit', () => {
    const fullText = '这是陈老师关于投资、创业、商业模式和经营决策的超长完整正文。'.repeat(12_000);
    const collapsedText = fullText.slice(0, 72);
    const doc = new JSDOM(`
      <div class="main-content-container">
        <div class="topic-container">
          <div class="author"><div class="info">
            <div class="role owner">陈老师</div><div class="date">2026-08-24 08:00</div>
          </div></div>
          <div class="talk-content-container"><div class="content">
            ${collapsedText}<span>展开全部</span>
          </div></div>
        </div>
      </div>
    `, { url: LIST }).window.document;
    const index = new TopicIndex();
    index.add(harvestProvenTopic({
      topic_id: '644444444444444',
      create_time: '2026-08-24T08:00:00.000+0800',
      talk: { text: fullText },
    }));

    const result = extractList(doc, LIST, index, NOW).entries[0]?.document;

    expect(fullText.length).toBeGreaterThan(200_000);
    expect(result?.text).not.toContain('展开全部');
    expect(result?.truncated).toBe(true);
  });

  it('keeps API truncation evidence when a 199k DOM copy is replaced by the 200k retained body', () => {
    const topicId = '645555555555555';
    const fullText = 'A'.repeat(201_000);
    const domText = fullText.slice(0, 199_000);
    const doc = new JSDOM(`
      <div class="main-content-container">
        <div class="topic-container">
          <div class="author"><div class="info">
            <div class="role owner">陈老师</div><div class="date">2026-08-24 08:00</div>
          </div></div>
          <div class="talk-content-container"><div class="content">${domText}<span>展开全部</span></div></div>
        </div>
      </div>
    `, { url: LIST }).window.document;
    const index = new TopicIndex();
    index.add(harvestProvenTopic({ topic_id: topicId, talk: { text: fullText } }));

    const result = extractList(doc, LIST, index, NOW).entries[0]?.document;

    expect(result?.text).toHaveLength(200_000);
    expect(result?.truncated).toBe(true);
  });

  it('records owner/member evidence, topic id, active view, and preserves the questioner', async () => {
    const doc = await fixture('zsxq-three-views.html', LIST);
    const index = new TopicIndex();
    index.add([
      {
        topicId: '611111111111111',
        text: '陈老师发布的投资创业观察，正文长度足够用于采集与分类归纳。',
        fullTextTruncated: false,
        sourceBodyProven: true,
        sourceMediaProven: true,
      },
      {
        topicId: '622222222222222',
        text: '请问创业项目在融资前应该重点验证哪些数据指标？ 应该先验证真实留存、付费意愿和获客成本，再谈规模。',
        parts: [
          '请问创业项目在融资前应该重点验证哪些数据指标？',
          '应该先验证真实留存、付费意愿和获客成本，再谈规模。',
        ],
        fullTextTruncated: false,
        sourceBodyProven: true,
        sourceMediaProven: true,
      },
    ]);

    const collected = extractList(doc, LIST, index, NOW).entries.flatMap(entry => entry.document ?? []);

    expect(collected[0]?.sourceMetadata).toMatchObject({
      authorRole: 'owner',
      topicId: '611111111111111',
      viewLabels: '最新',
    });
    expect(collected[1]).toMatchObject({
      questioner: '提问者乙',
      truncated: false,
      sourceMetadata: {
        authorRole: 'member',
        topicId: '622222222222222',
        viewLabels: '最新',
      },
    });
    expect(collected[1]?.text).toContain('请问创业项目在融资前应该重点验证哪些数据指标');
    expect(collected[1]?.text).toContain('应该先验证真实留存、付费意愿和获客成本');
  });

  it('does not invent member evidence when the author role class is unknown', () => {
    const topicId = '566666666666669';
    const doc = new JSDOM(`
      <div class="main-content-container"><div class="topic-container" data-topic-id="${topicId}">
        <div class="author"><div class="info">
          <div class="role future-role-class">陈老师</div><div class="date">2026-08-25 08:00</div>
        </div></div>
        <div class="talk-content-container"><div class="content">
          这是一篇作者区域已经渲染、但身份类名尚无法证明的完整帖子正文。
        </div></div>
      </div></div>
    `, { url: LIST }).window.document;

    const result = extractList(doc, LIST, undefined, NOW).entries[0]?.document;

    expect(result?.sourceMetadata).not.toHaveProperty('authorRole');
  });

  it('问答帖：问和答都归档，且靠任意一段就能对上帖子号', async () => {
    // 精华里混着不少问答帖。页面上问与答是两块、中间还夹着「回答」这类标签，
    // 接口那边则是 question / answer 两段。只取第一块 → 丢掉回答，
    // 只索引拼接结果 → 两边都不是对方的连续子串，整条对不上号（实测第 7 条就这样漏掉）。
    const doc = await fixture('zsxq-qa-list.html', LIST);
    const index = new TopicIndex();
    index.add([
      {
        topicId: '577777777777777',
        text: '老师您好，创业板已经跌破 60 日线了，现在这个位置还能继续加仓吗？ 跌破 60 日线就该降仓，这是纪律问题，不是判断问题。等站回去再说。',
        parts: [
          '老师您好，创业板已经跌破 60 日线了，现在这个位置还能继续加仓吗？',
          '跌破 60 日线就该降仓，这是纪律问题，不是判断问题。等站回去再说。',
        ],
      },
    ]);

    const list = extractList(doc, LIST, index, NOW);

    const document = list.entries[0]?.document;
    expect(document?.canonicalUrl).toBe(
      'https://wx.zsxq.com/group/48844584441158/topic/577777777777777',
    );
    // 回答是这类帖子里最有价值的部分，绝不能只存问题。
    expect(document?.text).toContain('还能继续加仓吗');
    expect(document?.text).toContain('跌破 60 日线就该降仓');
    expect(list.skipped).toBe(0);
  });

  it('skips every post when no topic ids were captured, rather than inventing URLs', async () => {
    const doc = await fixture('zsxq-list.html', LIST);

    const list = extractList(doc, LIST, undefined, NOW);

    // 没有帖子号来源时一条都不该入库：共用列表页地址会让它们算出同一个 ID 相互覆盖。
    expect(list.entries.every(entry => entry.document === undefined)).toBe(true);
    expect(list.skipped).toBe(3);
  });

  it('counts only posts that still need collecting（滚动后据此判断有没有新内容）', async () => {
    const doc = await fixture('zsxq-list.html', LIST);

    expect(pendingTopicCount(doc)).toBe(3);
    for (const container of doc.querySelectorAll('.topic-container')) {
      container.setAttribute('data-dc-collected', '1');
    }
    expect(pendingTopicCount(doc)).toBe(0);
  });

  it('refuses list extraction on sources that have no feed layout', () => {
    const doc = new JSDOM('<main></main>').window.document;

    expect(() => extractList(doc, 'https://mp.weixin.qq.com/s/abc', undefined, NOW)).toThrowError(
      expect.objectContaining<Partial<ExtractionError>>({ code: 'UNSUPPORTED_LAYOUT' }),
    );
  });

  it('reports authentication instead of scraping a login page', () => {
    const doc = new JSDOM('<app-login>请登录</app-login>').window.document;

    expect(() => extractDocument(doc, DETAIL, NOW)).toThrowError(
      expect.objectContaining<Partial<ExtractionError>>({ code: 'AUTH_REQUIRED' }),
    );
  });
});

describe('Nowcoder extraction', () => {
  it('extracts an interview post and drops query-only tracking from the identity', async () => {
    const url = 'https://www.nowcoder.com/discuss/123456?channel=feed&from=push';
    const result = extractDocument(await fixture('nowcoder-post.html', url), url, NOW);

    expect(result).toMatchObject({
      source: 'nowcoder',
      kind: 'post',
      title: '字节跳动前端一面面经（已过）',
      author: '前端の张三',
      canonicalUrl: 'https://www.nowcoder.com/discuss/123456',
      collectedAt: NOW(),
    });
    expect(result.publishedAt).toBe('2026-07-10T01:30:00.000Z');
    expect(result.text).toContain('事件循环');
    expect(result.text).not.toContain('感谢分享');
    expect(result.text).not.toContain('首页');
    expect(result.images).toEqual([
      {
        url: 'https://static.nowcoder.com/images/interview-eventloop.png',
        alt: '事件循环示意图',
      },
    ]);
  });

  it('reports authentication instead of scraping a login wall', () => {
    const doc = new JSDOM(
      '<div class="nc-login-modal">登录后查看完整面经</div><main><article class="post-detail"><h1 class="post-title">被挡住的面经</h1></article></main>',
    ).window.document;

    expect(() => extractDocument(doc, 'https://www.nowcoder.com/discuss/999', NOW)).toThrowError(
      expect.objectContaining<Partial<ExtractionError>>({ code: 'AUTH_REQUIRED' }),
    );
  });

  it('falls back to a unique dense block when semantic selectors are absent', () => {
    const doc = new JSDOM(`
      <main>
        <nav><a>首页导航很长</a><a>讨论区很长</a><a>找工作很长</a><a>消息很长</a></nav>
        <div class="feed-item">
          <h1>美团前端二面面经分享</h1>
          <p>这是完整的二面记录，涵盖了浏览器渲染、性能优化和一道中等难度算法题。</p>
          <p>面试官先让做自我介绍，然后围绕项目深挖了状态管理与打包体积优化。</p>
          <p>最后一道算法是最长递增子序列，要求给出动态规划思路并分析复杂度。</p>
        </div>
        <aside><a>相关推荐一</a><a>相关推荐二</a><a>相关推荐三</a></aside>
      </main>
    `).window.document;

    const result = extractDocument(doc, 'https://www.nowcoder.com/feed/main/detail/abc', NOW);

    expect(result.source).toBe('nowcoder');
    expect(result.title).toBe('美团前端二面面经分享');
    expect(result.text).toContain('最长递增子序列');
    expect(result.text).not.toContain('首页导航');
  });

  it('marks an explicitly paywalled body as unavailable for full-content consumption', async () => {
    const url = 'https://www.nowcoder.com/discuss/920079269143871488';
    const result = extractDocument(
      await fixture('nowcoder-paywalled.html', url),
      url,
      () => '2026-08-23T00:00:00.000Z',
    );

    expect(result.truncated).toBe(true);
    expect(result.sourceMetadata).toMatchObject({ contentAccess: 'paywalled' });
  });

  it('uses only the current detail object from embedded SSR state when semantic DOM is absent', async () => {
    const url = 'https://www.nowcoder.com/feed/main/detail/42ba29ab006d4bb793112eb263d18f6a';
    const result = extractDocument(
      await fixture('nowcoder-ssr.html', url),
      url,
      () => '2026-08-23T00:00:00.000Z',
    );

    expect(result).toMatchObject({
      title: '阿里云 Agent 开发一面',
      author: '匿名候选人',
      publishedAt: '2026-08-18T15:39:00.000Z',
      sourceMetadata: { contentAccess: 'full' },
    });
    expect(result.text).toContain('设计 Agent Loop');
  });

  it('rejects creator rankings and page chrome instead of archiving them as a post', async () => {
    const url = 'https://www.nowcoder.com/discuss/108000000000000000';
    const pageChrome = await fixture('nowcoder-page-chrome.html', url);

    expect(() => extractDocument(pageChrome, url, NOW)).toThrowError(
      expect.objectContaining<Partial<ExtractionError>>({ code: 'UNSUPPORTED_LAYOUT' }),
    );
  });
});

describe('发布时间：宁可说不知道，也不猜一个年份', () => {
  it('只有月日的时间戳一律不解析（否则会被补成 2001 年）', () => {
    // new Date('03-05') 不会失败，它返回 2001-03-05。牛客「编辑于 03-05」、
    // 星球「3-5」都长这样。猜错的年份还会以 date_source: published
    //（「原文给了发布时间，可信」）写进收件箱，下游 Agent 照单全收。
    for (const raw of ['03-05', '3-5', '05/06', '编辑于 03-05', 'Mar 5']) {
      expect(parsePublishedAt(raw, null)).toBeUndefined();
    }
  });

  it('带年份的照常解析', () => {
    expect(parsePublishedAt('2026年3月5日', null)).toBe('2026-03-04T16:00:00.000Z');
    expect(parsePublishedAt('2026-03-05 14:30', null)).toBe('2026-03-05T06:30:00.000Z');
    expect(parsePublishedAt('', '2026-03-05T06:30:00.000Z')).toBe('2026-03-05T06:30:00.000Z');
  });

  it('两位数年份也算「站点写了年份」，不能按没有年份处理', () => {
    // 星球上超过一年的老帖就是这种写法。一律要求 4 位年份的话，它们会全部
    // 退回采集时间——真出过：一篇 23年06月18日 的帖子被记成了 2026-08-01。
    // 这和上面被挡掉的 `03-05` 不同：年份是站点写出来的，不是我们补的。
    expect(parsePublishedAt('23年06月18日', null)).toBe('2023-06-17T16:00:00.000Z');
    expect(parsePublishedAt('23-06-18', null)).toBe('2023-06-17T16:00:00.000Z');
    expect(parsePublishedAt('23年6月18日 14:30', null)).toBe('2023-06-18T06:30:00.000Z');
    // 仍然只有两段的，照旧不认。
    expect(parsePublishedAt('06-18', null)).toBeUndefined();
  });
});

describe('页面折叠时用接口正文补齐（completeContent）', () => {
  // 这个文件不跑在 jsdom 环境里，自己造一个 Document。
  const { document } = new JSDOM('<body></body>').window;
  const dom = (html: string) => {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host;
  };

  it('页面只有半篇时换成接口那份完整正文', () => {
    // 真实症状：入库正文末尾还挂着「展开全部」，后半段根本没采到。
    const collapsed = dom('<div>先跟新粉解释下，老粉可以跳过下述说明：历史上主要的房地产泡沫…<span>...展开全部</span></div>');
    const apiText = `先跟新粉解释下，老粉可以跳过下述说明：\n${'历史上主要的房地产泡沫，都是在居民杠杆率下降的过程中实现触底的。'.repeat(12)}`;

    const result = completeContent(document, collapsed, apiText);

    expect(result).not.toBe(collapsed);
    expect(result.textContent).toContain('居民杠杆率下降');
    expect(result.textContent?.length).toBeGreaterThan((collapsed.textContent ?? '').length);
    expect(result.textContent).not.toContain('展开全部');
  });

  it('页面那份已经完整时原样用它——DOM 有排版和链接，比接口纯文本好', () => {
    const full = dom('<div><p>一段完整的正文，页面上没有折叠，长度和接口那边相当。</p></div>');
    expect(completeContent(document, full, '一段完整的正文，页面上没有折叠，长度和接口那边相当。')).toBe(full);
    expect(completeContent(document, full, undefined)).toBe(full);
  });

  it('keeps an exact API linked-article href when DOM and API visible text have equal length', () => {
    const intro = '这是一段投资经营长文导语。';
    const articleTitle = '房地产周期完整复盘';
    const articleUrl = 'https://articles.zsxq.com/id_EqualText123.html';
    const rendered = dom(`<div><p>${intro}</p><div class="web-card">${articleTitle}</div></div>`);
    const apiText = `${intro}\n<e type="web" href="${encodeURIComponent(articleUrl)}" title="${encodeURIComponent(articleTitle)}" />`;

    const result = completeContent(document, rendered, apiText);

    expect(result.textContent?.replace(/\s+/gu, '')).toBe(
      rendered.textContent?.replace(/\s+/gu, ''),
    );
    expect(result.querySelector('a')?.getAttribute('href')).toBe(articleUrl);
    expect(rendered.querySelector('a')).toBeNull();
  });

  it('uses a reliably matched API tail even when it is fewer than 120 characters longer', () => {
    const prefix = '投资创业经营复盘正文。'.repeat(100);
    const tail = '这是接口明确包含、页面还没有渲染出的最后结论。'.repeat(4);
    const partial = dom(`<div>${prefix}</div>`);

    const result = completeContent(document, partial, prefix + tail);

    expect(result).not.toBe(partial);
    expect(result.textContent).toContain('最后结论');
    expect(result.textContent?.replace(/\s+/g, '').length).toBe((prefix + tail).length);
  });

  it('补齐时把页面上的图片一并搬过来（接口正文里只有占位标记）', () => {
    const collapsed = dom('<div>导语一句话<img src="https://images.zsxq.com/a.jpg"><span>...展开全部</span></div>');
    const result = completeContent(document, collapsed, `导语一句话\n${'后面还有很多内容。'.repeat(30)}`);
    expect(result.querySelector('img')?.getAttribute('src')).toBe('https://images.zsxq.com/a.jpg');
  });

  it('绝不改动页面本身——用户正在肉眼核对', () => {
    const collapsed = dom('<div>导语一句话<span>...展开全部</span></div>');
    const before = collapsed.innerHTML;
    completeContent(document, collapsed, `导语一句话\n${'后面还有很多内容。'.repeat(30)}`);
    expect(collapsed.innerHTML).toBe(before);
  });
});

describe('带货帖按硬证据跳过，且照样出现在明细里', () => {
  const LIST = 'https://wx.zsxq.com/group/48844584441158';

  function listWith(linkHtml: string): Document {
    return new JSDOM(`
      <div class="main-content-container">
        <div class="topic-container">
          <div class="author"><div class="info"><div class="role owner">陈老师</div></div></div>
          <div class="talk-content-container"><div class="content">
            第一条帖子的正文内容，足够长以便通过长度校验判断。${linkHtml}
          </div></div>
        </div>
      </div>`, { url: LIST }).window.document;
  }

  it('挂着 CPS 分销链接的帖子被跳过，原因写明域名和依据', () => {
    const doc = listWith(
      '<a class="link-of-topic" href="https://cps.qixin19.com/apps/cps/zyt1106596/product/detail'
      + '?prodId=105222&planId=130748&tenantId=0">投保入口</a>',
    );

    const index = new TopicIndex();
    index.add([{
      topicId: '511111111111111',
      text: '第一条帖子的正文内容，足够长以便通过长度校验判断。投保入口',
      fullTextTruncated: false,
    }]);
    const list = extractList(doc, LIST, index, NOW);

    expect(list.entries[0]?.document).toBeUndefined();
    // 绝不静默：跳过要说清是什么、依据是什么，用户得能自己复核判得对不对。
    expect(list.entries[0]?.reason).toContain('推广/带货内容');
    expect(list.entries[0]?.reason).toContain('cps.qixin19.com');
    expect(list.skipped).toBe(1);
  });

  it('does not call a business filter auditable until the current topic URL is proven', () => {
    const doc = listWith(
      '<a href="https://cps.qixin19.com/apps/cps/product/detail">投保入口</a>',
    );

    const list = extractList(doc, LIST, undefined, NOW);

    expect(list.entries[0]?.document).toBeUndefined();
    expect(list.entries[0]?.reason).toContain('编号没截到');
    expect(list.entries[0]?.reason).not.toContain('推广/带货内容');
    expect(list.entries[0]?.retryable).toBe(true);
  });

  it('does not call a no-URL selection exclusion auditable either', () => {
    const doc = listWith('这是一条打新和新股申购活动说明，页面仍未取得本帖编号。');

    const list = extractList(doc, LIST, undefined, NOW);

    expect(list.entries[0]?.document).toBeUndefined();
    expect(list.entries[0]?.reason).toContain('编号没截到');
    expect(list.entries[0]?.reason).not.toContain('按选题偏好');
    expect(list.entries[0]?.retryable).toBe(true);
  });

  it('长文帖那个 articles.zsxq.com 外链绝不能被判成广告', () => {
    // 这类帖子的正文主体就是一个指向博主自己长文的链接，判错等于把干货整篇扔掉。
    const doc = listWith('<a href="https://articles.zsxq.com/id_i9g8xrwktrlb.html">全文</a>');
    const index = new TopicIndex();
    index.add([{
      topicId: '511111111111111',
      text: '第一条帖子的正文内容，足够长以便通过长度校验判断。全文',
    }]);

    const list = extractList(doc, LIST, index, NOW);

    expect(list.entries[0]?.document).toBeDefined();
    expect(list.skipped).toBe(0);
  });

  it('列表正文末尾仍有「显示全部」时标记为截断', () => {
    const identityOnly = new TopicIndex();
    identityOnly.add([{
      topicId: '511111111111111',
      text: '第一条帖子的正文内容，足够长以便通过长度校验判断。显示全部',
      fullTextTruncated: false,
      sourceBodyProven: false,
      sourceMediaProven: false,
    }]);
    const list = extractList(listWith('<button>显示全部</button>'), LIST, identityOnly, NOW);

    expect(list.entries[0]?.document?.truncated).toBe(true);
  });
});

/**
 * 以下四组全部对应 life-teachers/collector-issues 的实测工单（77 条投递）。
 */
describe('工单 D1/D6：标题不能吞进 --- 分隔线，也不能是半句话', () => {
  it('分隔线绝不进标题——它会把下游的 frontmatter 切错位置', () => {
    // 实测唯一样本，但后果最重：下游 split('---') 会切错，date/source_url 全落进正文。
    const title = titleFromText('2024春节后，中产即将遭遇一场全面的返贫危机 本文做一个备份\n------------------\n正文开始');
    expect(title).not.toContain('---');
    expect(title).toContain('2024春节后');
  });

  it('宁可短，也不留半个词组（53/77 是断句标题）', () => {
    const title = titleFromText(
      '匿名用户 提问：陈老师好，关于7月4日18：41星友的问题，星友100万本金亏损25%，问是应该割肉等下轮牛市来临买宽基还是继续持有等回本',
    );
    // 原先硬截 60 字得到「…问是应该割肉等下轮牛市来临买宽」这种断句。
    expect(title.endsWith('买宽')).toBe(false);
    expect(title.length).toBeLessThanOrEqual(48);
  });

  it('行首的 Markdown 结构字符也剥掉', () => {
    expect(titleFromText('# 标题在这里\n正文')).toBe('标题在这里');
    expect(titleFromText('> 引用开头的帖子正文内容')).toBe('引用开头的帖子正文内容');
  });
});

describe('工单 D7：正文里不该留「展开全部」这类控件文案', () => {
  it('整行的 UI 文案去掉，正文里正常出现的同名词不动', () => {
    expect(stripUiNoise('正文第一段\n展开全部\n')).toBe('正文第一段');
    const cleaned = stripUiNoise('正文\n收起\n更多正文');
    expect(cleaned).not.toContain('收起');
    expect(cleaned).toContain('正文');
    expect(cleaned).toContain('更多正文');
    // 「他把全文都读完了」里的「全文」是内容，不能删。
    expect(stripUiNoise('他把全文都读完了')).toBe('他把全文都读完了');
  });
});

describe('工单 D2：长文正文在 articles.zsxq.com 上', () => {
  it('认得出长文地址', () => {
    expect(isZsxqArticle(new URL('https://articles.zsxq.com/id_g5tujomiabtu.html'))).toBe(true);
    expect(isZsxqArticle(new URL('https://wx.zsxq.com/group/123/topic/456'))).toBe(false);
  });

  it('从帖子正文里找出它引用的长文链接', () => {
    const html = '<p>先跟新粉解释下</p><a href="https://articles.zsxq.com/id_i9g8xrwktrlb.html">全文</a>';
    expect(linkedArticleUrl(html)).toBe('https://articles.zsxq.com/id_i9g8xrwktrlb.html');
    expect(linkedArticleUrl('<p>没有外链的帖子</p>')).toBeUndefined();
  });

  it('长文页按正文提取，选择器落空时退回文字最多的块并标记为未验证完整', () => {
    const url = 'https://articles.zsxq.com/id_g5tujomiabtu.html';
    // 长文页是 Angular 单页应用，类名随时可能变——所以要有密度兜底。
    const body = '这是长文的正文内容，讲居民杠杆率与房地产周期的关系。'.repeat(12);
    const doc = new JSDOM(
      `<div class="nav">导航</div><div class="mystery-container"><p>${body}</p></div>`,
      { url },
    ).window.document;

    const result = extractDocument(doc, url, NOW);

    expect(result.kind).toBe('article');
    expect(result.text).toContain('居民杠杆率');
    expect(result.text.length).toBeGreaterThan(200);
    expect(result.truncated).toBeUndefined();
  });

  it('长文页有摘要和正文两个语义候选时不会只归档先出现的摘要', () => {
    const url = 'https://articles.zsxq.com/id_summary_and_body.html';
    const summary = '这是页面顶部的摘要，只概括了文章结论，不能代替后面的完整论证。'.repeat(6);
    const fullBody = '这是长文主体，逐段分析居民杠杆、企业现金流和资产配置，并给出完整推导过程。'.repeat(60);
    const doc = new JSDOM(`
      <div class="article-content">${summary}</div>
      <article><p>${fullBody}</p></article>
    `, { url }).window.document;

    const result = extractDocument(doc, url, NOW);

    expect(summary.length).toBeGreaterThan(150);
    expect(fullBody.length).toBeGreaterThan(2_000);
    expect(result.text).toContain(fullBody.slice(-120));
    expect(result.text).not.toContain('页面顶部的摘要');
    expect(result.text.length).toBeGreaterThan(2_000);
    expect(result.truncated).toBeUndefined();
  });

  it('未知文章根下的同类并列正文块也会按 DOM 顺序完整合并', () => {
    const url = 'https://articles.zsxq.com/id_parallel_blocks.html';
    const first = '第一章讨论需求验证、用户访谈和真实付费意愿。'.repeat(20);
    const second = '第二章讨论现金流、组织效率和规模扩张边界。'.repeat(20);
    const doc = new JSDOM(`
      <div class="future-article-root">
        <section class="article-content"><p>${first}</p></section>
        <section class="article-content"><p>${second}</p></section>
      </div>
    `, { url }).window.document;

    const result = extractDocument(doc, url, NOW);

    expect(result.text).toContain(first.slice(-80));
    expect(result.text).toContain(second.slice(-80));
    expect(result.text.indexOf('第一章')).toBeLessThan(result.text.indexOf('第二章'));
    expect(result.truncated).toBe(false);
  });

  it('多个无法归为同组的强语义候选只取最丰富正文但保留歧义证据', () => {
    const url = 'https://articles.zsxq.com/id_ambiguous_strong_blocks.html';
    const richest = '主正文候选分析企业经营与现金流，内容更丰富。'.repeat(20);
    const other = '另一个强语义候选可能是并列章节，也可能是旧渲染版本。'.repeat(12);
    const doc = new JSDOM(`
      <div class="future-article-root">
        <section class="article-content">${richest}</section>
        <section class="rich_media_content">${other}</section>
      </div>
    `, { url }).window.document;

    const result = extractDocument(doc, url, NOW);

    expect(result.text).toContain(richest.slice(-80));
    expect(result.text).not.toContain('另一个强语义候选');
    expect(result.truncated).toBeUndefined();
  });

  it('已有强语义正文时不会把推荐区的裸 content 合并进文章', () => {
    const url = 'https://articles.zsxq.com/id_ignore_generic_content.html';
    const body = '正文持续分析企业经营、现金流管理与投资决策。'.repeat(40);
    const recommendation = '相关推荐和评论列表不是作者正文，绝不能混入归档。'.repeat(30);
    const doc = new JSDOM(`
      <article><p>${body}</p></article>
      <aside><div class="content">${recommendation}</div></aside>
    `, { url }).window.document;

    const result = extractDocument(doc, url, NOW);

    expect(result.text).toContain(body.slice(-80));
    expect(result.text).not.toContain('相关推荐和评论列表');
    expect(result.truncated).toBe(false);
  });

  it('does not treat a recommendation card bare article as the current long-form body', () => {
    const url = 'https://articles.zsxq.com/id_recommendation_article.html';
    const recommendation = '推荐卡里的另一篇长文，即使字数很多也不能证明属于当前 URL。'.repeat(30);
    const body = '这才是当前知识星球长文的目标正文，完整讲解经营、现金流与投资决策。'.repeat(35);
    const doc = new JSDOM(`
      <aside><article>${recommendation}</article></aside>
      <main><div class="content">${body}</div></main>
    `, { url }).window.document;

    const result = extractDocument(doc, url, NOW);

    expect(result.text).toContain(body.slice(-100));
    expect(result.text).not.toContain('推荐卡里的另一篇长文');
    // 裸 .content 只能证明像正文，既不能证明完整，也不是“确定截断”的正向证据。
    expect(result.truncated).toBeUndefined();
  });

  it('ignores semantic-looking article content inside recommendation and hidden regions', () => {
    const url = 'https://articles.zsxq.com/id_semantic_recommendation.html';
    const recommendation = '推荐区故意复用 article-content 类名，但它仍然不是当前 URL 的正文。'.repeat(35);
    const hiddenOld = '隐藏的旧 SPA 正文快照不能作为当前长文的完整证明。'.repeat(30);
    const body = '当前 main 区域里的目标长文正文，讲解产品、经营与投资决策的完整过程。'.repeat(40);
    const doc = new JSDOM(`
      <aside class="recommendations"><section class="article-content">${recommendation}</section></aside>
      <section class="article-content" aria-hidden="true">${hiddenOld}</section>
      <main><div class="content">${body}</div></main>
    `, { url }).window.document;

    const result = extractDocument(doc, url, NOW);

    expect(result.text).toContain(body.slice(-100));
    expect(result.text).not.toContain('推荐区故意复用');
    expect(result.text).not.toContain('隐藏的旧 SPA');
    expect(result.truncated).toBeUndefined();
  });

  it('ignores strong candidates hidden by stylesheet-computed visibility', () => {
    const url = 'https://articles.zsxq.com/id_computed_hidden.html';
    const stale = '样式表隐藏的旧 SPA 长文快照，不能冒充当前 URL 的完整正文。'.repeat(35);
    const body = '当前可见的长文主体，持续讲解产品、经营、现金流和投资判断。'.repeat(40);
    const doc = new JSDOM(`
      <style>.stale-pane { display: none; }</style>
      <section class="stale-pane"><div class="article-content">${stale}</div></section>
      <main><div class="content">${body}</div></main>
    `, { url }).window.document;

    const result = extractDocument(doc, url, NOW);

    expect(result.text).toContain(body.slice(-100));
    expect(result.text).not.toContain('样式表隐藏的旧 SPA');
    expect(result.truncated).toBeUndefined();
  });

  it('removes nested recommendation and comment regions from a strong article body', () => {
    const url = 'https://articles.zsxq.com/id_nested_ui_regions.html';
    const body = '这是当前长文的真实主体，详细分析产品验证、经营现金流和投资决策。'.repeat(40);
    const recommendation = '另一篇推荐长文的完整摘要，不属于当前作者正文。'.repeat(25);
    const comments = '读者评论和回复区内容，绝不能混入作者正文。'.repeat(25);
    const doc = new JSDOM(`
      <main><article>
        <div class="article-content">${body}</div>
        <aside class="recommendations">${recommendation}</aside>
        <section class="comments">${comments}</section>
      </article></main>
    `, { url }).window.document;

    const result = extractDocument(doc, url, NOW);

    expect(result.text).toContain(body.slice(-100));
    expect(result.text).not.toContain('另一篇推荐长文');
    expect(result.text).not.toContain('读者评论和回复区');
    expect(result.truncated).toBe(false);
  });

  it('只有裸 content 可用时保守标记为未验证完整', () => {
    const url = 'https://articles.zsxq.com/id_weak_content_only.html';
    const body = '这是旧版页面里一段足够长的长文正文，但裸 content 类名本身无法排除评论或推荐。'.repeat(20);
    const doc = new JSDOM(`<div class="content">${body}</div>`, { url }).window.document;

    const result = extractDocument(doc, url, NOW);

    expect(result.text).toContain(body.slice(-80));
    expect(result.truncated).toBeUndefined();
  });

  it('给唯一裸 content 长文留下标题、作者和时间齐全的稳定性候选证据', () => {
    const url = 'https://articles.zsxq.com/id_identified_weak_content.html';
    const body = '这是知识星球长文章的完整正文，持续讨论企业经营、自由现金流与投资纪律。'.repeat(30);
    const doc = new JSDOM(`
      <h1>中概股近期性价比分析</h1>
      <div class="author-info">
        <div class="author"><span class="nick-name">陈老师</span></div>
        <div class="date">2026-08-28 18:50</div>
      </div>
      <div class="content">${body}</div>
    `, { url }).window.document;

    const result = extractDocument(doc, url, NOW);

    expect(result).toMatchObject({
      kind: 'article',
      title: '中概股近期性价比分析',
      author: '陈老师',
      publishedAt: '2026-08-28T10:50:00.000Z',
      sourceMetadata: {
        articleLayoutMode: 'weak',
        articleLayoutSelector: '.content',
        articleLayoutAmbiguous: false,
        articleStableCandidate: true,
      },
    });
    expect(result.truncated).toBeUndefined();
  });

  it('长文页已有局部正文但仍挂展开控件时标记为未完成', () => {
    const url = 'https://articles.zsxq.com/id_partial.html';
    const partial = '这是还在渲染的投资与经营长文局部正文。'.repeat(12);
    const doc = new JSDOM(
      `<article><p>${partial}</p><button>显示全部</button></article>`,
      { url },
    ).window.document;

    const result = extractDocument(doc, url, NOW);

    expect(result.text.length).toBeGreaterThan(100);
    expect(result.truncated).toBe(true);
  });

  it('正文没渲染出来时如实报错，绝不落一条空壳', () => {
    const url = 'https://articles.zsxq.com/id_empty.html';
    // curl 拿到的就是这个：单页应用的壳，一个字都没有。
    const doc = new JSDOM('<app-root></app-root>', { url }).window.document;
    let thrown: unknown;
    try {
      extractDocument(doc, url, NOW);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as ExtractionError).code).toBe('CONTENT_EMPTY');
  });
});

describe('单条采集也要给 truncated / questioner（两条路径必须一致）', () => {
  const DETAIL = 'https://wx.zsxq.com/group/48844584441158/topic/55522452154844124';

  it('正文里还挂着任一展开控件就标 truncated', () => {
    // 实测：按 URL 重采出来的 48 条 truncated 全是 0——我只把它加在了批量路径上，
    // 归档侧只能退回去靠字数猜（误报率 78%）。
    for (const label of ['展开全部', '展开全文', '阅读全文', '显示全部', '展开']) {
      const doc = new JSDOM(`
        <div class="topic-container">
          <div class="author"><div class="info"><div class="role owner">陈老师</div></div></div>
          <div class="talk-content-container"><div class="content">
            这是一段已经足够长的导语，正文主体仍然需要继续展开后才能完整读取。<a href="https://articles.zsxq.com/id_x.html">全文</a>
            <button>${label}</button>
          </div></div>
        </div>`, { url: DETAIL }).window.document;

      expect(extractDocument(doc, DETAIL, NOW).truncated, label).toBe(true);
    }
  });

  it('把普通元素里的展开文案视为截断控件，但豁免合法长文导航链接', () => {
    const shell = (control: string) => new JSDOM(`
      <div class="topic-container">
        <div class="author"><div class="info"><div class="role owner">陈老师</div></div></div>
        <div class="talk-content-container"><div class="content">
          这是一段尚未完整展开的投资复盘导语，后面还有正文。${control}
        </div></div>
      </div>`, { url: DETAIL }).window.document;

    expect(extractDocument(shell('<span>全文</span>'), DETAIL, NOW).truncated).toBe(true);
    expect(extractDocument(
      shell('<div role="button">...全文</div>'),
      DETAIL,
      NOW,
    ).truncated).toBe(true);
    for (const label of ['全文', '阅读全文', '展开全文', '显示全部']) {
      expect(extractDocument(
        shell(`<a href="https://articles.zsxq.com/id_x.html"><span>${label}</span></a>`),
        DETAIL,
        NOW,
      ).truncated, label).toBeUndefined();
    }
  });

  it('豁免只包装合法长文导航的多层节点，但不豁免夹带额外展开文案的容器', () => {
    const shell = (navigation: string) => new JSDOM(`
      <div class="topic-container">
        <div class="author"><div class="info"><div class="role owner">陈老师</div></div></div>
        <div class="talk-content-container"><div class="content">
          这是一段投资长文导语，完整论证位于后续链接页面。${navigation}
        </div></div>
      </div>`, { url: DETAIL }).window.document;

    expect(extractDocument(
      shell(`
        <div class="article-link-wrapper">
          <a href="https://articles.zsxq.com/id_nested.html"><span>全文</span></a>
        </div>`),
      DETAIL,
      NOW,
    ).truncated).toBeUndefined();

    expect(extractDocument(
      shell(`
        <div class="article-link-wrapper">
          <a href="https://articles.zsxq.com/id_nested.html"><span>阅读全文</span></a>
          <button>展开全文</button>
        </div>`),
      DETAIL,
      NOW,
    ).truncated).toBe(true);

    for (const interactiveWrapper of [
      '<div role="button"><a href="https://articles.zsxq.com/id_nested.html"><span>全文</span></a></div>',
      '<div aria-expanded="false"><a href="https://articles.zsxq.com/id_nested.html"><span>全文</span></a></div>',
      '<div aria-controls="full-body"><a href="https://articles.zsxq.com/id_nested.html"><span>全文</span></a></div>',
      '<button><a href="https://articles.zsxq.com/id_nested.html"><span>全文</span></a></button>',
    ]) {
      expect(extractDocument(
        shell(interactiveWrapper),
        DETAIL,
        NOW,
      ).truncated, interactiveWrapper).toBe(true);
    }
  });

  it('问答帖带上提问者', () => {
    const doc = new JSDOM(`
      <div class="topic-container">
        <div class="author"><div class="info"><div class="role owner">陈老师</div></div></div>
        <div class="q-content-container"><div class="content">
          <div class="question-owner"><span>City 躺平大叔</span> 提问：</div>
          陈老师好，我就是你公众号里提到的牛市亏大钱的人，想请教几个问题。
        </div></div>
      </div>`, { url: DETAIL }).window.document;

    const result = extractDocument(doc, DETAIL, NOW);
    expect(result.questioner).toBe('City 躺平大叔');
    expect(result.author).toBe('陈老师');
  });

  it('混合问题块和回答块的详情页会完整归档两段正文', () => {
    const doc = new JSDOM(`
      <div class="topic-container">
        <div class="author"><div class="info"><div class="role owner">陈老师</div></div></div>
        <div class="question-owner"><span>创业者甲</span> 提问：</div>
        <div class="q-content-container"><div class="content">
          请问创业项目在融资前应该重点验证哪些数据指标？
        </div></div>
        <div class="label">回答</div>
        <div class="talk-content-container"><div class="content">
          应该先验证真实留存、付费意愿和获客成本，再谈规模。
        </div></div>
      </div>`, { url: DETAIL }).window.document;

    const result = extractDocument(doc, DETAIL, NOW);

    expect(result.text).toContain('请问创业项目在融资前应该重点验证哪些数据指标');
    expect(result.text).toContain('应该先验证真实留存、付费意愿和获客成本');
    expect(result.truncated).toBeUndefined();
  });

  it('recognizes answer-content-container as the semantic answer block', () => {
    const doc = new JSDOM(`
      <div class="topic-container">
        <div class="author"><div class="info"><div class="role owner">陈老师</div></div></div>
        <div class="q-content-container"><div class="content">
          请问创业团队应该先验证产品还是先扩大投放？
        </div></div>
        <div class="answer-content-container"><div class="content">
          应该先验证留存和付费，再逐步扩大获客投放，并持续复盘单位经济模型。
        </div></div>
      </div>`, { url: DETAIL }).window.document;

    const result = extractDocument(doc, DETAIL, NOW);

    expect(result.text).toContain('请问创业团队应该先验证产品');
    expect(result.text).toContain('应该先验证留存和付费');
    expect(result.truncated).toBeUndefined();
  });

  it('正常 DOM 在没有来源正文证明时保持 unknown 且不带提问者', () => {
    const doc = new JSDOM(`
      <div class="topic-container">
        <div class="author"><div class="info"><div class="role owner">陈老师</div></div></div>
        <div class="talk-content-container"><div class="content">
          ${'这是一篇完整的帖子，正文就在这里，没有折叠也没有外链。'.repeat(4)}
        </div></div>
      </div>`, { url: DETAIL }).window.document;

    const result = extractDocument(doc, DETAIL, NOW);
    expect(result.truncated).toBeUndefined();
    expect(result.questioner).toBeUndefined();
  });

  it('accepts a source-equal expanded detail whose UI control now says 收起', () => {
    const topicId = '55522452154844124';
    const body = '这是已经完整展开的创业项目复盘正文，尾部结论和行动建议都已正常显示。'.repeat(6);
    const doc = new JSDOM(`
      <div class="topic-container" data-topic-id="${topicId}">
        <div class="talk-content-container"><div class="content">
          <p>${body}</p><button>收起</button>
        </div></div>
      </div>
    `, { url: DETAIL }).window.document;
    const index = new TopicIndex();
    index.add(harvestProvenTopic({ topic_id: topicId, talk: { text: body } }));

    const result = extractDocument(doc, DETAIL, NOW, index, true);

    expect(result.text).toContain(body.slice(-60));
    expect(result.text).not.toContain('收起');
    expect(result.truncated).toBe(false);
  });

  it('rejects a detail when the same topic id has conflicting source bodies even after UI expansion', () => {
    const topicId = '55522452154844124';
    const bodyA = '来源版本 A：这是投资与创业复盘的完整正文，包含全部结论。'.repeat(6);
    const bodyB = '来源版本 B：这是另一份互不兼容的经营分析，绝不能洗白冲突。'.repeat(6);
    const doc = new JSDOM(`
      <div class="topic-container" data-topic-id="${topicId}">
        <div class="talk-content-container"><div class="content">
          <p>${bodyA}</p><button>收起</button>
        </div></div>
      </div>
    `, { url: DETAIL }).window.document;
    const index = new TopicIndex();
    index.add([
      {
        topicId,
        text: bodyA,
        fullTextTruncated: false,
        sourceBodyProven: true,
        sourceMediaProven: true,
      },
      {
        topicId,
        text: bodyB,
        fullTextTruncated: false,
        sourceBodyProven: true,
        sourceMediaProven: true,
      },
    ]);

    expect(() => extractDocument(doc, DETAIL, NOW, index, false)).toThrowError(
      expect.objectContaining<Partial<ExtractionError>>({
        code: 'CONTENT_EMPTY',
        message: expect.stringContaining('互不兼容'),
      }),
    );
  });

  it('archives a source-proven image-only detail without imposing a text-length minimum', () => {
    const topicId = '55522452154844124';
    const imageUrl = 'https://images.zsxq.com/Fj_detail_image_only.jpg';
    const doc = new JSDOM(`
      <div class="topic-container" data-topic-id="${topicId}">
        <div class="talk-content-container"><div class="content">
          <img src="${imageUrl}" alt="经营数据图">
        </div></div>
      </div>
    `, { url: DETAIL }).window.document;
    const index = new TopicIndex();
    index.add(harvestProvenTopic({
      topic_id: topicId,
      talk: { text: '', images: [{ original: { url: imageUrl }, name: '经营数据图' }] },
    }));

    const result = extractDocument(doc, DETAIL, NOW, index, true);

    expect(result.title).toContain('经营数据图');
    expect(result.images).toEqual([{ url: imageUrl, alt: '经营数据图' }]);
    expect(result.truncated).toBe(false);
  });

  it('详情页没有命中语义正文结构时拒绝把整个帖子外壳当成完整正文', () => {
    const shiftedBody = '正文节点类名已经变化，页面外壳里还混有作者、时间、点赞和评论等信息。'.repeat(8);
    const doc = new JSDOM(`
      <div class="topic-container">
        <div class="author"><div class="info"><div class="role owner">陈老师</div></div></div>
        <div class="future-body-layout">${shiftedBody}</div>
        <div class="content">这是评论区的通用 content 节点，不能当成作者正文。${'评论'.repeat(30)}</div>
        <div class="actions">点赞 评论 分享</div>
      </div>
    `, { url: DETAIL }).window.document;

    expect(() => extractDocument(doc, DETAIL, NOW)).toThrowError(
      expect.objectContaining<Partial<ExtractionError>>({
        code: 'UNSUPPORTED_LAYOUT',
        message: expect.stringContaining('正文结构'),
      }),
    );
  });
});
