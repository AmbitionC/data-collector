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
import { TopicIndex } from '../../packages/extension/src/topicIndex.js';
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
    { topicId: '511111111111111', text: '第一条帖子的正文内容，足够长以便通过长度校验判断。' },
    { topicId: '522222222222222', text: '第二条帖子的正文内容，同样足够长以便通过长度校验。' },
  ]);
  return index;
}

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const NOW = () => '2026-07-18T00:00:00.000Z';

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

    const list = extractList(doc, LIST, topicIndex(), NOW);

    expect(list.entries[0]?.document).toBeUndefined();
    // 绝不静默：跳过要说清是什么、依据是什么，用户得能自己复核判得对不对。
    expect(list.entries[0]?.reason).toContain('推广/带货内容');
    expect(list.entries[0]?.reason).toContain('cps.qixin19.com');
    expect(list.skipped).toBe(1);
  });

  it('长文帖那个 articles.zsxq.com 外链绝不能被判成广告', () => {
    // 这类帖子的正文主体就是一个指向博主自己长文的链接，判错等于把干货整篇扔掉。
    const doc = listWith('<a href="https://articles.zsxq.com/id_i9g8xrwktrlb.html">全文</a>');

    const list = extractList(doc, LIST, topicIndex(), NOW);

    expect(list.entries[0]?.document).toBeDefined();
    expect(list.skipped).toBe(0);
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

  it('长文页按正文提取，选择器落空时退回文字最多的块', () => {
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

  it('正文里还挂着「展开全部」就标 truncated', () => {
    // 实测：按 URL 重采出来的 48 条 truncated 全是 0——我只把它加在了批量路径上，
    // 归档侧只能退回去靠字数猜（误报率 78%）。
    const doc = new JSDOM(`
      <div class="topic-container">
        <div class="author"><div class="info"><div class="role owner">陈老师</div></div></div>
        <div class="talk-content-container"><div class="content">
          导语一段，正文主体在长文里。<a href="https://articles.zsxq.com/id_x.html">全文</a>
          <p>展开全部</p>
        </div></div>
      </div>`, { url: DETAIL }).window.document;

    expect(extractDocument(doc, DETAIL, NOW).truncated).toBe(true);
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

  it('正常帖子两个字段都不带', () => {
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
});
