import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractNowcoder } from '../../packages/extension/src/extractors/nowcoder.js';

const URL_VALUE = new URL('https://www.nowcoder.com/discuss/83001');
const NOW = () => '2026-10-13T00:00:00.000Z';
const BODY = '<article class="nc-post-content"><h1>Agent 面经</h1><p>面试官让设计验证码系统，讨论限流、缓存和失败重试，然后继续问 Agent 工具调用和 RAG 召回。</p></article>';

describe('Nowcoder visible access challenges', () => {
  it.each([
    '<div class="captcha-modal">请完成验证码验证</div>',
    '<div class="geetest_panel">请拖动滑块完成验证</div>',
    '<title>安全验证 - 牛客网</title>',
  ])('stops extraction on a visible captcha challenge: %s', html => {
    const document = new JSDOM(html + BODY).window.document;
    expect(() => extractNowcoder(document, URL_VALUE, NOW)).toThrowError(
      expect.objectContaining({ code: 'CAPTCHA_REQUIRED' }),
    );
  });

  it('keeps interview text about captchas and ignores challenge widgets hidden by ancestors', () => {
    const document = new JSDOM('<div style="display:none"><div class="captcha-modal">请完成验证</div></div>' + BODY).window.document;
    expect(extractNowcoder(document, URL_VALUE, NOW).text).toContain('设计验证码系统');
  });

  it('ignores a hidden login dialog and still extracts a readable post', () => {
    const document = new JSDOM('<div hidden><div class="nc-login-modal">请登录</div></div>' + BODY).window.document;
    expect(extractNowcoder(document, URL_VALUE, NOW).text).toContain('RAG');
  });
});


describe('Nowcoder detail access error pages', () => {
  it.each([
    ['<title>429 Too Many Requests</title><h1>Too Many Requests</h1>', 'RATE_LIMITED'],
    ['<title>HTTP ERROR 429</title>', 'RATE_LIMITED'],
    ['<main><h1>Too Many Requests</h1></main>', 'RATE_LIMITED'],
    ['<title>403 Forbidden</title><h1>Forbidden</h1>', 'AUTH_REQUIRED'],
    ['<title>Access denied</title>', 'AUTH_REQUIRED'],
    ['<main><h1>Access Denied</h1></main>', 'AUTH_REQUIRED'],
  ])('returns a durable stop code for the explicit error page %s', (html, code) => {
    const document = new JSDOM(html).window.document;
    expect(() => extractNowcoder(document, URL_VALUE, NOW)).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it('keeps a technical post that discusses 429 and 403 and uses an error phrase as a content heading', () => {
    const document = new JSDOM('<title>Agent 技术面经 - 牛客网</title><article class="nc-post-content"><h1>429 Too Many Requests</h1><p>面试官追问限流方案、HTTP 429 Too Many Requests、403 Access Denied 和验证码系统，我解释了请求限流和鉴权失败的处理，再分析 RAG 工具调用流程。</p></article>').window.document;
    expect(extractNowcoder(document, URL_VALUE, NOW).text).toContain('403 Access Denied');
  });

  it('ignores hidden top-level access-error headings while preserving a readable post', () => {
    const document = new JSDOM('<main hidden><h1>Too Many Requests</h1><h2>Access Denied</h2></main>' + BODY).window.document;
    expect(extractNowcoder(document, URL_VALUE, NOW).text).toContain('RAG');
  });
});
