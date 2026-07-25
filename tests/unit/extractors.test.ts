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
    expect((thrown as Error).message).toContain('4 条帖子');
    expect((thrown as Error).message).toContain('批量保存');
  });

  it('splits a list page into one document per post, each carrying its own topic URL', async () => {
    const doc = await fixture('zsxq-list.html', LIST);

    const list = extractList(doc, LIST, NOW);

    // 身份由规范 URL 派生：每条必须带自己的 /topic/ 地址，否则会算出同一个 ID 相互覆盖。
    expect(list.documents.map(item => item.canonicalUrl)).toEqual([
      'https://wx.zsxq.com/group/48844584441158/topic/511111111111111',
      'https://wx.zsxq.com/group/48844584441158/topic/522222222222222',
    ]);
    expect(new Set(list.documents.map(item => item.canonicalUrl)).size).toBe(2);
    expect(list.documents[0]).toMatchObject({ source: 'zsxq', kind: 'post', author: '重远' });
    expect(list.documents[0]?.text).toContain('第一条帖子');
    // 拿不到自身 URL 的那条如实计入 skipped，而不是静默少采。
    expect(list.skipped).toBe(1);
    expect(list.total).toBe(3);
    // 上一轮采过并打了标记的那条不再进入本轮。
    expect(list.documents.some(item => item.text.includes('第四条帖子'))).toBe(false);
    expect(list.containers).toHaveLength(3);
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

    expect(() => extractList(doc, 'https://mp.weixin.qq.com/s/abc', NOW)).toThrowError(
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
