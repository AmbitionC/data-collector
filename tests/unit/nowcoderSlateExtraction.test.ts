import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { extractNowcoder } from '../../packages/extension/src/extractors/nowcoder.js';

const URL_VALUE = new URL('https://www.nowcoder.com/discuss/83002');
const NOW = () => '2026-11-04T05:00:00.000Z';
const BODY = '一面追问混合检索与重排的区别，二面要求说明模型选型和排障依据。正文中的提示和订阅专刊是讨论内容，不能按词语删除。';

describe('Nowcoder Slate detail body', () => {
  it('collects only the editor body and its images, excluding the surrounding title and subscription UI', () => {
    const document = new JSDOM(`<article>
      <h1>后端技术面经</h1>
      <div class="nc-slate-editor-content"><p>${BODY}</p><img src="https://static.nowcoder.com/images/slate-example.png" alt="结构图"></div>
      <aside>提示 订阅专刊</aside>
    </article>`).window.document;

    const result = extractNowcoder(document, URL_VALUE, NOW);

    expect(result.title).toBe('后端技术面经');
    expect(result.text).toBe(BODY);
    expect(result.html).not.toContain('<h1>');
    expect(result.html).not.toContain('<aside>');
    expect(result.images).toEqual([{ url: 'https://static.nowcoder.com/images/slate-example.png', alt: '结构图' }]);
    expect(result.sourceMetadata?.contentAccess).toBe('full');
  });

  it('accepts a short complete question in the precise Slate body without collecting outer UI to satisfy a length gate', () => {
    const document = new JSDOM('<article><h1>项目求助</h1><div class="nc-slate-editor-content">重排前后怎么对比？</div><aside>提示 订阅专刊</aside></article>').window.document;

    expect(extractNowcoder(document, URL_VALUE, NOW).text).toBe('重排前后怎么对比？');
  });

  it('ignores a hidden stale editor when a visible editor is available', () => {
    const document = new JSDOM(`<article>
      <h1>后端技术面经</h1>
      <div hidden><div class="nc-slate-editor-content">旧的正文不能混入当前帖子</div></div>
      <div class="nc-slate-editor-content"><p>${BODY}</p></div>
    </article>`).window.document;

    expect(extractNowcoder(document, URL_VALUE, NOW).text).toBe(BODY);
  });

  it.each(['展开全部', '展开全文', '阅读全文', '显示全部'])('keeps a Slate preview truncated when its post has a visible sibling %s control', label => {
    const document = new JSDOM(`<section class="post-content-box">
      <h1>后端技术面经</h1>
      <div class="nc-slate-editor-content"><p>${BODY}</p></div>
      <button>${label}</button>
    </section>`).window.document;

    const result = extractNowcoder(document, URL_VALUE, NOW);

    expect(result.text).toBe(BODY);
    expect(result.sourceMetadata?.contentAccess).toBe('truncated');
    expect(result.truncated).toBe(true);
  });

  it('does not treat a hidden fold control as an incomplete post', () => {
    const document = new JSDOM(`<article>
      <h1>后端技术面经</h1>
      <div class="nc-slate-editor-content"><p>${BODY}</p></div>
      <button hidden>展开全文</button>
    </article>`).window.document;

    expect(extractNowcoder(document, URL_VALUE, NOW).sourceMetadata?.contentAccess).toBe('full');
  });

  it('does not use the comment thread expansion control as post truncation evidence', () => {
    const document = new JSDOM(`<article>
      <h1>后端技术面经</h1>
      <div class="nc-slate-editor-content"><p>${BODY}</p></div>
      <div class="js-comment-container"><button>展开全部</button></div>
    </article>`).window.document;

    const result = extractNowcoder(document, URL_VALUE, NOW);

    expect(result.text).toBe(BODY);
    expect(result.sourceMetadata?.contentAccess).toBe('full');
  });
});
