import { describe, expect, it } from 'vitest';
import {
  canonicalizeUrl,
  collectedDocumentSchema,
  parseSupportedUrl,
  stableContentId,
} from '../../packages/shared/src/index.js';

describe('supported URLs', () => {
  it('canonicalizes a WeChat article and keeps a stable identity', () => {
    const a = canonicalizeUrl(
      parseSupportedUrl('https://mp.weixin.qq.com/s/abc?scene=1#rd'),
    );
    const b = canonicalizeUrl(
      parseSupportedUrl('https://mp.weixin.qq.com/s/abc'),
    );

    expect(a.href).toBe('https://mp.weixin.qq.com/s/abc');
    expect(stableContentId(a)).toBe(stableContentId(b));
    expect(stableContentId(a)).toMatch(/^[a-f0-9]{12}$/);
  });

  it('keeps ZSXQ resource identity parameters while removing tracking', () => {
    const url = canonicalizeUrl(
      parseSupportedUrl(
        'https://wx.zsxq.com/dweb2/index/topic_detail/123?inviter_id=1&topic_id=456#comments',
      ),
    );

    expect(url.href).toBe(
      'https://wx.zsxq.com/dweb2/index/topic_detail/123?topic_id=456',
    );
  });

  it.each([
    'http://mp.weixin.qq.com/s/x',
    'file:///tmp/x',
    'https://example.com/x',
    'https://mp.weixin.qq.com.evil.example/s/x',
    'not a url',
  ])('rejects %s', value => {
    expect(() => parseSupportedUrl(value)).toThrow(/不支持的采集地址/);
  });

  it('rejects documents whose source or canonical URL contradict the page URL', () => {
    const base = {
      schemaVersion: 1 as const,
      source: 'wechat' as const,
      kind: 'article' as const,
      url: 'https://mp.weixin.qq.com/s/contract',
      canonicalUrl: 'https://mp.weixin.qq.com/s/contract',
      title: '契约测试',
      collectedAt: '2026-07-18T00:00:00.000Z',
      html: '<p>正文</p>',
      text: '正文',
      images: [],
    };

    expect(collectedDocumentSchema.safeParse(base).success).toBe(true);
    expect(
      collectedDocumentSchema.safeParse({
        ...base,
        canonicalUrl: 'https://mp.weixin.qq.com/s/other',
      }).success,
    ).toBe(false);
    expect(
      collectedDocumentSchema.safeParse({
        ...base,
        source: 'zsxq',
      }).success,
    ).toBe(false);
  });
});
