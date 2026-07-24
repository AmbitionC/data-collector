import { describe, expect, it } from 'vitest';
import {
  SOURCES,
  SOURCE_REGISTRY,
  canonicalizeUrl,
  descriptorFor,
  descriptorForHost,
  parseSupportedUrl,
  stableContentId,
} from '../../packages/shared/src/index.js';

describe('source registry', () => {
  it('registers a descriptor for every source id', () => {
    for (const source of SOURCES) {
      expect(SOURCE_REGISTRY[source]?.id).toBe(source);
      expect(descriptorFor(source).label.length).toBeGreaterThan(0);
    }
  });

  it('matches hosts to descriptors and rejects unknown hosts', () => {
    expect(descriptorForHost('mp.weixin.qq.com')?.id).toBe('wechat');
    expect(descriptorForHost('wx.zsxq.com')?.id).toBe('zsxq');
    expect(descriptorForHost('api.zsxq.com')?.id).toBe('zsxq');
    expect(descriptorForHost('www.nowcoder.com')?.id).toBe('nowcoder');
    expect(descriptorForHost('nowcoder.com')?.id).toBe('nowcoder');
    expect(descriptorForHost('example.com')).toBeUndefined();
  });

  it('canonicalizes Nowcoder by path identity, dropping all query tracking', () => {
    const a = canonicalizeUrl(
      parseSupportedUrl('https://www.nowcoder.com/discuss/123456?channel=feed&from=push#reply'),
    );
    const b = canonicalizeUrl(parseSupportedUrl('https://www.nowcoder.com/discuss/123456/'));

    expect(a.href).toBe('https://www.nowcoder.com/discuss/123456');
    expect(stableContentId(a)).toBe(stableContentId(b));
    expect(stableContentId(a)).toMatch(/^[a-f0-9]{12}$/);
  });

  it('constrains allowed content kinds per source', () => {
    expect(SOURCE_REGISTRY.wechat.kinds).toEqual(['article']);
    expect(SOURCE_REGISTRY.nowcoder.kinds).toEqual(['post']);
    expect(SOURCE_REGISTRY.zsxq.kinds).toContain('question');
  });
});
