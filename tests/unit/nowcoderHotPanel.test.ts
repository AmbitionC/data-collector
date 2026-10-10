// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import { bindHotMaterials } from '../../packages/extension/src/sidepanel/hotMaterials.js';
import { extractNowcoderHotList } from '../../packages/extension/src/extractors/nowcoder.js';
import { HOT_SCREENSHOT_NOTICE, hotMaterialId } from '@data-collector/shared';

beforeEach(async () => {
  document.body.innerHTML = await readFile('packages/extension/src/sidepanel/index.html', 'utf8');
});
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('hot material preview controls', () => {
  it('keeps rows unchecked, separates editorial notes and saves only selected IDs', async () => {
    const feed = document.implementation.createHTMLDocument('讨论列表');
    feed.body.innerHTML = '<article><a href="/discuss/123456">找工作困惑</a><p>发帖人的自述</p></article><article><a href="/discuss/654321">另一条</a></article>';
    const docs = extractNowcoderHotList(feed, new URL('https://www.nowcoder.com/'), () => '2026-10-10T12:00:00.000Z').documents;
    const requests: any[] = [];
    const panel = bindHotMaterials(document, async <T>(request: any): Promise<T> => {
      requests.push(request);
      if (request.type === 'hot.preview') return { token: 'token', capped: false, rows: docs.map(document => ({ document, id: hotMaterialId(document.canonicalUrl), alreadySaved: false })) } as T;
      return { saved: 1, skipped: 0, failed: 0, items: [{ id: hotMaterialId(docs[0]!.canonicalUrl), status: 'saved', message: '已保存' }] } as T;
    });
    panel.show();
    document.querySelector<HTMLButtonElement>('#hot-read')?.click(); await settle();
    expect(document.querySelectorAll('.hot-select')).toHaveLength(2);
    expect([...document.querySelectorAll<HTMLInputElement>('.hot-select')].some(input => input.checked)).toBe(false);
    expect(document.querySelector<HTMLButtonElement>('#hot-save')?.disabled).toBe(true);
    const select = document.querySelector<HTMLInputElement>('.hot-select')!;
    select.checked = true; select.dispatchEvent(new Event('change'));
    const note = document.querySelector<HTMLTextAreaElement>('.hot-note')!;
    note.value = '等待面邀时可以做什么'; note.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>('#hot-save')?.click(); await settle();
    expect(requests.find(request => request.type === 'hot.save').selections).toEqual([{ id: hotMaterialId(docs[0]!.canonicalUrl), emotionTags: [], inspirationNote: '等待面邀时可以做什么', attribution: 'source-quote' }]);
    expect(document.querySelector('#hot-notice')?.textContent).toContain(HOT_SCREENSHOT_NOTICE);
    expect(document.querySelector('#hot-status')?.textContent).toContain('已保存 1');
  });

  it('shows empty-list and sticky failures with an explicit retry', async () => {
    let tries = 0;
    const panel = bindHotMaterials(document, async <T>(): Promise<T> => {
      tries++;
      if (tries === 1) throw new Error('当前页面暂未加载');
      return { token: 'retry', rows: [], capped: false } as T;
    });
    panel.show(); document.querySelector<HTMLButtonElement>('#hot-read')?.click(); await settle();
    panel.show();
    expect(document.querySelector('#hot-status')?.textContent).toContain('当前页面暂未加载');
    document.querySelector<HTMLButtonElement>('#hot-read')?.click(); await settle();
    expect(document.querySelector('#hot-status')?.textContent).toContain('没有识别到');
  });
});
