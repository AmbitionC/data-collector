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
  it('detects the two supported sources', () => {
    expect(detectSource(new URL('https://mp.weixin.qq.com/s/x'))).toBe('wechat');
    expect(detectSource(new URL('https://wx.zsxq.com/dweb2/index/topic_detail/x'))).toBe('zsxq');
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
});
