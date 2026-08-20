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

  it('canonicalizes a GitHub repository and accepts fe-journey candidate metadata', () => {
    const url = canonicalizeUrl(
      parseSupportedUrl('https://github.com/acme/agent-lab?tab=readme-ov-file#usage'),
    );

    expect(url.href).toBe('https://github.com/acme/agent-lab');
    expect(
      collectedDocumentSchema.parse({
        schemaVersion: 1,
        source: 'github',
        kind: 'article',
        url: 'https://github.com/acme/agent-lab?tab=readme-ov-file#usage',
        canonicalUrl: 'https://github.com/acme/agent-lab',
        title: 'acme/agent-lab',
        author: 'acme',
        collectedAt: '2026-08-19T00:00:00.000Z',
        html: '<p>Production-ready agent project.</p>',
        text: 'Production-ready agent project.',
        images: [],
        feJourney: {
          candidateKinds: ['project', 'knowledge'],
          qualityScore: 82,
          qualitySignals: ['包含完整 README', '包含部署说明'],
          contentHash: '0123456789abcdef',
          simHash: 'fedcba9876543210',
          clusterId: 'cluster-0123456789ab',
          projectScore: 86,
          projectSignals: ['许可证明确'],
        },
      }).feJourney,
    ).toEqual({
      candidateKinds: ['project', 'knowledge'],
      qualityScore: 82,
      qualitySignals: ['包含完整 README', '包含部署说明'],
      contentHash: '0123456789abcdef',
      simHash: 'fedcba9876543210',
      clusterId: 'cluster-0123456789ab',
      projectScore: 86,
      projectSignals: ['许可证明确'],
    });
  });

  it('rejects out-of-range fe-journey scores and malformed fingerprints', () => {
    const base = {
      schemaVersion: 1 as const,
      source: 'nowcoder' as const,
      kind: 'post' as const,
      url: 'https://www.nowcoder.com/discuss/123',
      canonicalUrl: 'https://www.nowcoder.com/discuss/123',
      title: 'Agent 面经',
      collectedAt: '2026-08-19T00:00:00.000Z',
      html: '<p>正文</p>',
      text: '正文',
      images: [],
    };

    expect(collectedDocumentSchema.safeParse({
      ...base,
      feJourney: {
        candidateKinds: ['interview'],
        qualityScore: 101,
        qualitySignals: [],
        contentHash: 'not-hex',
        simHash: '1',
        clusterId: 'x',
      },
    }).success).toBe(false);
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
