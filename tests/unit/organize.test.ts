import { describe, expect, it } from 'vitest';
import type { CollectedDocument } from '@data-collector/shared';
import {
  classify,
  keywords,
  organize,
  sanitizeCollectedHtml,
  summarize,
} from '../../packages/bridge/src/organize/index.js';

const WECHAT_URL = 'https://mp.weixin.qq.com/s/example';

function document(overrides: Partial<CollectedDocument> = {}): CollectedDocument {
  return {
    schemaVersion: 1,
    source: 'wechat',
    kind: 'article',
    url: WECHAT_URL,
    canonicalUrl: WECHAT_URL,
    title: '浏览器插件如何构建本地知识库',
    collectedAt: '2026-07-18T00:00:00.000Z',
    html: '<p>浏览器插件可以保存网页内容。</p>',
    text: '浏览器插件可以保存网页内容。本地知识库便于分类整理。自动化工作流能减少重复劳动。',
    images: [],
    ...overrides,
  };
}

describe('HTML sanitization', () => {
  it('removes executable markup and event handlers', () => {
    expect(
      sanitizeCollectedHtml(
        '<p onclick="x()">正文</p><script>x()</script><form><input></form>',
        WECHAT_URL,
      ),
    ).toBe('<p>正文</p>');
  });

  it('resolves relative URLs and rejects unsafe schemes', () => {
    const sanitized = sanitizeCollectedHtml(
      '<a href="/safe">安全</a><a href="javascript:alert(1)">危险</a><img src="/image.png" alt="图">',
      WECHAT_URL,
    );

    expect(sanitized).toContain('href="https://mp.weixin.qq.com/safe"');
    expect(sanitized).toContain('src="https://mp.weixin.qq.com/image.png"');
    expect(sanitized).not.toContain('javascript:');
  });
});

describe('offline organization', () => {
  it('creates a deterministic concise Chinese summary', () => {
    const text = [
      '浏览器插件负责读取用户当前打开并且有权访问的页面内容。',
      '本地知识库把原始链接、正文和图片保存在同一个稳定目录中。',
      '离线归纳不会把私人内容上传到外部服务。',
      '任务队列能够在浏览器重启后恢复未完成的采集工作。',
      '这些边界共同构成一个可审计的数据采集流程。',
    ].join('');
    const result = summarize(text.repeat(4), '浏览器插件与本地知识库');

    expect(result.length).toBeLessThanOrEqual(280);
    expect(result).toContain('浏览器插件');
    expect(summarize(text.repeat(4), '浏览器插件与本地知识库')).toBe(result);
  });

  it('extracts useful keywords and maps categories', () => {
    expect(keywords('React TypeScript 前端组件浏览器性能优化', 'React 浏览器性能')).toEqual(
      expect.arrayContaining(['react', '浏览器']),
    );
    expect(classify({ title: 'React 性能优化', text: '组件渲染与前端工程' }).category)
      .toBe('前端开发');
    expect(classify({ title: '一夜之间的通胀', text: '投资者重新判断利率与估值' }).category)
      .toBe('商业与投资');
  });

  it('gives user category and tags absolute precedence', () => {
    const result = organize(
      document({
        userCategory: '个人收藏',
        userTags: ['稍后精读', '宏观'],
        suggestedCategory: '效率与工具',
        suggestedTags: ['自动化'],
      }),
    );

    expect(result.category).toBe('个人收藏');
    expect(result.tags).toEqual(['稍后精读', '宏观']);
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.sanitizedHtml).not.toContain('<script');
  });
});
