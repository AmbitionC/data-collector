import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  ExtractionError,
  detectSource,
  extractDocument,
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
    expect(detectSource(new URL('https://wx.zsxq.com/dweb2/index/topic_detail/x'))).toBe('zsxq');
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

describe('ZSXQ extraction', () => {
  it('extracts a single article detail', async () => {
    const url = 'https://wx.zsxq.com/dweb2/index/topic_detail/123';
    const result = extractDocument(await fixture('zsxq-article.html', url), url, NOW);

    expect(result).toMatchObject({
      source: 'zsxq',
      kind: 'article',
      title: '浏览器知识采集的三个边界',
      author: '陈同学',
      publishedAt: '2026-07-16T01:00:00.000Z',
    });
    expect(result.images[0]?.url).toBe('https://wx.zsxq.com/assets/collector.png');
  });

  it('combines a question and its visible answer', async () => {
    const url = 'https://wx.zsxq.com/dweb2/index/topic_detail/456';
    const result = extractDocument(await fixture('zsxq-question.html', url), url, NOW);

    expect(result.kind).toBe('question');
    expect(result.title).toBe('如何把收藏内容沉淀为知识库？');
    expect(result.text).toContain('我收藏了很多文章');
    expect(result.text).toContain('先保存原始来源');
    expect(result.sourceMetadata).toMatchObject({ answerCount: 1 });
  });

  it('reports authentication instead of scraping a login page', () => {
    const doc = new JSDOM('<main data-testid="login">登录知识星球后继续</main>').window.document;

    expect(() => extractDocument(doc, 'https://wx.zsxq.com/dweb2/index/group/1', NOW))
      .toThrowError(expect.objectContaining<Partial<ExtractionError>>({ code: 'AUTH_REQUIRED' }));
  });

  it('rejects ambiguous feed pages', () => {
    const doc = new JSDOM('<main><article>短动态一</article><article>短动态二</article></main>').window.document;

    expect(() => extractDocument(doc, 'https://wx.zsxq.com/dweb2/index/group/1', NOW))
      .toThrowError(expect.objectContaining<Partial<ExtractionError>>({ code: 'UNSUPPORTED_LAYOUT' }));
  });

  it('selects a unique visible detail by density and navigation noise', () => {
    const doc = new JSDOM(`
      <style>.hidden-copy { display: none }</style>
      <main>
        <nav><a>首页导航很长</a><a>星球列表很长</a><a>用户中心很长</a><a>消息通知很长</a></nav>
        <div class="hidden-copy"><h1>隐藏副本</h1><p>${'隐藏噪声'.repeat(100)}</p></div>
        <section>
          <h1>一篇没有固定选择器的星球动态</h1>
          <p>这是用户打开的单条详情正文，包含足够明确的段落结构和实际信息。</p>
          <p>正文说明本地采集、分类归纳以及后续写入知识库的具体工作方式。</p>
          <p>最后一个段落用于拉开与导航、侧栏和隐藏副本之间的正文密度差异。</p>
        </section>
        <aside><a>推荐一</a><a>推荐二</a><a>推荐三</a></aside>
      </main>
    `).window.document;

    const result = extractDocument(
      doc,
      'https://wx.zsxq.com/dweb2/index/topic_detail/fallback',
      NOW,
    );

    expect(result.kind).toBe('post');
    expect(result.title).toBe('一篇没有固定选择器的星球动态');
    expect(result.text).toContain('单条详情正文');
    expect(result.text).not.toContain('首页导航');
    expect(result.text).not.toContain('隐藏噪声');
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
