// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  sidePanelStateFromStatus,
  renderSidePanel,
  type SidePanelActions,
} from '../../packages/extension/src/sidepanel/state.js';

const PANEL_ROOT = join(
  import.meta.dirname,
  '..',
  '..',
  'packages',
  'extension',
  'src',
  'sidepanel',
);

let actions: SidePanelActions;

beforeEach(async () => {
  document.open();
  document.write(await readFile(join(PANEL_ROOT, 'index.html'), 'utf8'));
  document.close();
  actions = {
    capture: vi.fn(async () => undefined),
    captureList: vi.fn(async () => undefined),
    stopBatch: vi.fn(async () => undefined),
    diagnoseBatch: vi.fn(async () => undefined),
    dismissBatch: vi.fn(async () => undefined),
    recapture: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    copyPath: vi.fn(async () => undefined),
    revealPath: vi.fn(async () => undefined),
  };
});

describe('side panel state mapping', () => {
  it('shows a persistent connection state while the local service is connecting', () => {
    const state = sidePanelStateFromStatus({
      bridgeStatus: 'connecting',
      page: { supported: true, title: '文章', url: 'https://mp.weixin.qq.com/s/x' },
    });

    expect(state).toEqual({ phase: 'connecting' });
    renderSidePanel(document, state, actions);
    expect(document.querySelector<HTMLElement>('#connecting-panel')?.hidden).toBe(false);
    expect(document.querySelector('#connecting-panel')?.textContent).toContain('正在连接本机服务');
  });

  it('maps a disconnected service before stale job results and offers retry', () => {
    const state = sidePanelStateFromStatus({
      bridgeStatus: 'disconnected',
      lastJobStatus: 'saved',
      lastJobUrl: 'https://mp.weixin.qq.com/s/x',
      lastOutputPath: '/tmp/stale/index.md',
      page: { supported: true, title: '文章', url: 'https://mp.weixin.qq.com/s/x' },
    });

    expect(state).toEqual({ phase: 'bridge_unavailable' });
    renderSidePanel(document, state, actions);
    expect(document.querySelector<HTMLElement>('#bridge-unavailable-panel')?.hidden).toBe(false);
    expect(document.querySelector('#bridge-unavailable-panel')?.textContent)
      .toContain('npm run setup');
    document.querySelector<HTMLButtonElement>('#retry-button')!.click();
    expect(actions.retry).toHaveBeenCalledOnce();
  });

  it('maps an identity mismatch before job states and explains how to reinstall', () => {
    const state = sidePanelStateFromStatus({
      bridgeStatus: 'identity_error',
      lastJobStatus: 'failed',
      lastJobUrl: 'https://mp.weixin.qq.com/s/x',
      page: { supported: true, title: '文章', url: 'https://mp.weixin.qq.com/s/x' },
    });

    expect(state).toEqual({ phase: 'identity_error' });
    renderSidePanel(document, state, actions);
    expect(document.querySelector<HTMLElement>('#identity-error-panel')?.hidden).toBe(false);
    expect(document.querySelector('#identity-error-panel')?.textContent)
      .toMatch(/Edge.*扩展管理.*移除.*重新安装/);
  });

  it('explains replacement standby separately and allows an explicit retry', () => {
    const state = sidePanelStateFromStatus({
      bridgeStatus: 'replaced',
      page: { supported: true, title: '文章', url: 'https://mp.weixin.qq.com/s/x' },
    });

    expect(state).toEqual({ phase: 'replaced' });
    renderSidePanel(document, state, actions);
    expect(document.querySelector<HTMLElement>('#replaced-panel')?.hidden).toBe(false);
    expect(document.querySelector('#replaced-panel')?.textContent)
      .toContain('另一个浏览器实例已接管');
    document.querySelector<HTMLButtonElement>('#replaced-retry-button')!.click();
    expect(actions.retry).toHaveBeenCalledOnce();
  });

  it('marks a list page so the panel offers batch collection instead of single save', () => {
    const url = 'https://wx.zsxq.com/group/48844584441158';
    expect(sidePanelStateFromStatus({
      bridgeStatus: 'connected',
      page: { supported: true, list: true, title: '重远投资观', url },
    })).toMatchObject({ phase: 'ready', list: true });
    expect(sidePanelStateFromStatus({
      bridgeStatus: 'connected',
      page: { supported: true, list: false, title: '某条帖子', url: `${url}/topic/555` },
    })).toMatchObject({ phase: 'ready', list: false });
  });

  it('shows batch progress for the page that started it, and drops it elsewhere', () => {
    const url = 'https://wx.zsxq.com/group/48844584441158';
    const batch = {
      url,
      collected: 7,
      skipped: 2,
      failed: 0,
      rounds: 2,
      phase: 'running' as const,
      updatedAt: 1_000,
    };

    expect(sidePanelStateFromStatus(
      { bridgeStatus: 'connected', batch, page: { supported: true, list: true, title: '', url } },
      () => 2_000,
    )).toEqual({
      phase: 'batch',
      batchPhase: 'running',
      collected: 7,
      skipped: 2,
      failed: 0,
      message: '',
    });

    // 换到别的页面就不再打扰（与单页任务同一套归属判断）。
    expect(sidePanelStateFromStatus(
      {
        bridgeStatus: 'connected',
        batch,
        page: { supported: true, title: '文章', url: 'https://mp.weixin.qq.com/s/x' },
      },
      () => 2_000,
    )).toMatchObject({ phase: 'ready' });
  });

  it('E8: a batch whose progress went stale is reported as interrupted, not as finished', () => {
    const url = 'https://wx.zsxq.com/group/48844584441158';
    // Service Worker 被回收时进度会停更；既不能永远转圈，也不能谎报「完成」。
    const state = sidePanelStateFromStatus(
      {
        bridgeStatus: 'connected',
        batch: {
          url,
          collected: 3,
          skipped: 0,
          failed: 0,
          rounds: 1,
          phase: 'running',
          updatedAt: 0,
        },
        page: { supported: true, list: true, title: '', url },
      },
      () => 120_000,
    );

    expect(state).toMatchObject({ phase: 'batch', batchPhase: 'failed', collected: 3 });
    expect((state as { message: string }).message).toContain('中断');
  });

  it('carries the batch failure reason through instead of dropping it', () => {
    const url = 'https://wx.zsxq.com/group/48844584441158';
    const state = sidePanelStateFromStatus(
      {
        bridgeStatus: 'connected',
        batch: {
          url,
          collected: 0,
          skipped: 0,
          failed: 0,
          rounds: 0,
          phase: 'failed',
          code: 'CONTENT_SCRIPT_MISSING',
          error: '页面脚本未就绪：插件安装或更新后，之前打开的标签页需要重新加载一次。',
          updatedAt: 1_000,
        },
        page: { supported: true, list: true, title: '', url },
      },
      () => 2_000,
    );

    expect(state).toMatchObject({
      phase: 'batch',
      batchPhase: 'failed',
      code: 'CONTENT_SCRIPT_MISSING',
    });
    expect((state as { message: string }).message).toContain('重新加载');
  });

  it('keeps ready, collecting, and matching saved behavior', () => {
    const page = { supported: true, title: '通胀与估值', url: 'https://mp.weixin.qq.com/s/x' };
    expect(sidePanelStateFromStatus({ bridgeStatus: 'connected', page }))
      .toMatchObject({ phase: 'ready', title: '通胀与估值', url: page.url, category: '' });
    expect(sidePanelStateFromStatus({
      bridgeStatus: 'connected',
      lastJobStatus: 'organizing',
      lastJobUrl: page.url,
      page,
    })).toEqual({ phase: 'collecting', activeStage: 2 });
    expect(sidePanelStateFromStatus({
      bridgeStatus: 'connected',
      lastJobStatus: 'saved',
      lastJobUrl: page.url,
      lastOutputPath: '/tmp/x/index.md',
      page,
    })).toEqual({ phase: 'saved', path: '/tmp/x/index.md' });
  });
});

describe('side panel DOM behavior', () => {
  it('offers destination and category as bound選項 and submits the chosen ones', async () => {
    renderSidePanel(document, {
      phase: 'ready',
      url: 'https://mp.weixin.qq.com/s/current',
      sourceLabel: '微信公众号',
      title: '一夜之间，通胀的玩笑这次开大了',
      category: '',
      tags: ['通胀', '投资'],
      list: false,
      routeTargets: ['本机库'],
      defaultSinkIds: ['markdown'],
      destinations: [
        { id: 'markdown', label: '本机库', categories: ['商业与投资', '认知'] },
        { id: 'life-teachers', label: 'life-teachers 收件箱', categories: ['投资', '财富', '认知'] },
      ],
    }, actions);

    expect(document.querySelector<HTMLElement>('#ready-panel')?.hidden).toBe(false);
    expect(document.querySelector('#page-title')?.textContent).toContain('一夜之间');

    // 一级「去向」：默认项 + 每个可选目标（不是自由输入）。
    const destination = document.querySelector<HTMLSelectElement>('#destination')!;
    expect([...destination.options].map(option => option.value))
      .toEqual(['', 'markdown', 'life-teachers']);
    expect(destination.options[0]?.textContent).toContain('默认（本机库）');

    // 二级「分类」：跟随默认去向（本机库）的分类清单。
    const category = document.querySelector<HTMLSelectElement>('#category')!;
    expect([...category.options].map(option => option.value))
      .toEqual(['', '商业与投资', '认知']);

    // 切到 life-teachers 后，分类清单联动为该库的主分类，去向提示同步。
    destination.value = 'life-teachers';
    destination.dispatchEvent(new window.Event('change'));
    expect([...category.options].map(option => option.value))
      .toEqual(['', '投资', '财富', '认知']);
    expect(document.querySelector('#route-hint')?.textContent)
      .toContain('life-teachers 收件箱');

    category.value = '投资';
    document.querySelector<HTMLInputElement>('#tags')!.value = '宏观, 利率';
    document.querySelector<HTMLButtonElement>('#capture-button')!.click();
    await Promise.resolve();

    expect(actions.capture).toHaveBeenCalledWith({
      userCategory: '投资',
      userTags: ['宏观', '利率'],
      sinks: ['life-teachers'],
    });
  });

  it('preserves dirty organization fields for the same URL and resets them for a new URL', () => {
    const destinations = [
      { id: 'markdown', label: '本机库', categories: ['前端开发', '商业与投资'] },
    ];
    const ready = (url: string, title: string, tags: string[]) => ({
      phase: 'ready' as const,
      url,
      sourceLabel: '微信公众号',
      title,
      category: '',
      tags,
      list: false,
      destinations,
      defaultSinkIds: ['markdown'],
      routeTargets: ['本机库'],
    });

    renderSidePanel(document, ready('https://mp.weixin.qq.com/s/a', '文章 A', ['初始标签']), actions);
    document.querySelector<HTMLSelectElement>('#category')!.value = '商业与投资';
    document.querySelector<HTMLInputElement>('#tags')!.value = '用户编辑标签';

    // 同一 URL 的轮询刷新不得覆盖用户已选/已填内容。
    renderSidePanel(document, ready('https://mp.weixin.qq.com/s/a', '文章 A（刷新）', []), actions);
    expect(document.querySelector<HTMLSelectElement>('#category')?.value).toBe('商业与投资');
    expect(document.querySelector<HTMLInputElement>('#tags')?.value).toBe('用户编辑标签');

    // 切换到新页面时重置为默认（自动分类 + 新标签）。
    renderSidePanel(document, ready('https://mp.weixin.qq.com/s/b', '文章 B', ['新标签']), actions);
    expect(document.querySelector<HTMLSelectElement>('#category')?.value).toBe('');
    expect(document.querySelector<HTMLInputElement>('#tags')?.value).toBe('新标签');
  });

  it('turns the save action into batch collection on a list page', async () => {
    renderSidePanel(document, {
      phase: 'ready',
      url: 'https://wx.zsxq.com/group/48844584441158',
      sourceLabel: '知识星球',
      title: '重远投资观',
      category: '',
      tags: [],
      list: true,
      routeTargets: ['life-teachers 收件箱'],
      defaultSinkIds: ['life-teachers'],
      destinations: [
        { id: 'life-teachers', label: 'life-teachers 收件箱', categories: ['投资', '财富'] },
      ],
    }, actions);

    expect(document.querySelector('#capture-button-label')?.textContent).toBe('批量保存本页帖子');
    expect(document.querySelector<HTMLElement>('#list-hint')?.hidden).toBe(false);

    document.querySelector<HTMLSelectElement>('#category')!.value = '投资';
    document.querySelector<HTMLButtonElement>('#capture-button')!.click();
    await Promise.resolve();

    // 列表页绝不能走单页保存——那会把整个信息流糊成一篇。
    expect(actions.capture).not.toHaveBeenCalled();
    expect(actions.captureList).toHaveBeenCalledWith({ userCategory: '投资' });
  });

  const batchState = (
    batchPhase: 'running' | 'done' | 'capped' | 'stopped' | 'empty' | 'skipped_all' | 'failed',
    extra: Partial<{ collected: number; skipped: number; failed: number; message: string; code: string }> = {},
  ) => ({
    phase: 'batch' as const,
    batchPhase,
    collected: 0,
    skipped: 0,
    failed: 0,
    message: '',
    ...extra,
  });

  const visible = (selector: string) =>
    document.querySelector<HTMLElement>(selector)?.hidden === false;

  it('counts a running batch and only offers stop while it runs', async () => {
    renderSidePanel(document, batchState('running', { collected: 4, skipped: 2, failed: 1 }), actions);

    expect(visible('#batch-panel')).toBe(true);
    expect(document.querySelector('#batch-heading')?.textContent).toBe('正在批量归档');
    expect(document.querySelector('#batch-collected')?.textContent).toBe('4');
    expect(document.querySelector('#batch-skipped')?.textContent).toBe('2');
    expect(document.querySelector('#batch-failed')?.textContent).toBe('1');
    // 长任务必须能中止；跑着的时候不给「继续/完成」，避免同一页并发两批。
    expect(visible('#batch-stop-button')).toBe(true);
    expect(visible('#batch-continue-button')).toBe(false);
    expect(visible('#batch-done-button')).toBe(false);

    document.querySelector<HTMLButtonElement>('#batch-stop-button')!.click();
    await Promise.resolve();
    expect(actions.stopBatch).toHaveBeenCalledOnce();
  });

  it('offers continue / done only for the terminal states that actually succeeded', async () => {
    for (const phase of ['done', 'capped', 'stopped'] as const) {
      renderSidePanel(document, batchState(phase, { collected: 6 }), actions);
      expect(visible('#batch-continue-button')).toBe(true);
      expect(visible('#batch-done-button')).toBe(true);
      expect(visible('#batch-retry-button')).toBe(false);
      expect(document.querySelector<HTMLElement>('#batch-panel')?.dataset.tone).toBe('ok');
    }

    document.querySelector<HTMLButtonElement>('#batch-continue-button')!.click();
    document.querySelector<HTMLButtonElement>('#batch-done-button')!.click();
    await Promise.resolve();
    expect(actions.captureList).toHaveBeenCalledOnce();
    expect(actions.dismissBatch).toHaveBeenCalledOnce();
  });

  it('never renders a failed or empty batch with success wording', () => {
    // 这正是本次事故：0 条入库、异常中止，却显示「本轮批量归档完成」。
    for (const phase of ['failed', 'empty', 'skipped_all'] as const) {
      renderSidePanel(document, batchState(phase, { skipped: 21 }), actions);
      const heading = document.querySelector('#batch-heading')?.textContent ?? '';
      expect(heading).not.toContain('完成');
      expect(document.querySelector<HTMLElement>('#batch-panel')?.dataset.tone).toBe('warn');
      expect(document.querySelector('#batch-kicker')?.textContent).toBe('需要你处理');
      // 需要处理的终态给「重试」，不给「继续采下一批」。
      expect(visible('#batch-retry-button')).toBe(true);
      expect(visible('#batch-continue-button')).toBe(false);
    }
  });

  it('E1: turns the refresh instruction into a button that does the refresh', async () => {
    renderSidePanel(
      document,
      batchState('failed', {
        code: 'CONTENT_SCRIPT_MISSING',
        message: '页面脚本未就绪：插件安装或更新后，之前打开的标签页需要重新加载一次。',
      }),
      actions,
    );

    const retry = document.querySelector<HTMLButtonElement>('#batch-retry-button')!;
    expect(retry.textContent).toBe('刷新页面并重试');
    expect(document.querySelector('#batch-note')?.textContent).toContain('重新加载');

    retry.click();
    await Promise.resolve();
    // 不让用户自己去按 F5：插件重载页面后自己再跑一遍。
    expect(actions.captureList).toHaveBeenCalledWith(expect.anything(), { reloadFirst: true });
  });

  it('E4: offers one-click diagnostics when nothing was addressable', async () => {
    renderSidePanel(document, batchState('skipped_all', { skipped: 21 }), actions);

    expect(visible('#batch-diagnose-button')).toBe(true);
    document.querySelector<HTMLButtonElement>('#batch-diagnose-button')!.click();
    await Promise.resolve();
    expect(actions.diagnoseBatch).toHaveBeenCalledOnce();

    // 其它终态不该出现诊断按钮。
    renderSidePanel(document, batchState('done', { collected: 3 }), actions);
    expect(visible('#batch-diagnose-button')).toBe(false);
  });

  it('shows the concrete failure reason rather than a generic one', () => {
    renderSidePanel(
      document,
      batchState('failed', { collected: 5, code: 'BRIDGE_UNAVAILABLE', message: '本机服务无响应，本批已中断。' }),
      actions,
    );

    expect(document.querySelector('#batch-note')?.textContent).toBe('本机服务无响应，本批已中断。');
    // 中断前采到的要如实认账。
    expect(document.querySelector('#batch-collected')?.textContent).toBe('5');
  });

  it('shows a saved path and invokes both result actions with the exact path', async () => {
    const path = '/Users/chenhao/Documents/data-collector/微信公众号/商业与投资/index.md';
    renderSidePanel(document, { phase: 'saved', path }, actions);
    document.querySelector<HTMLButtonElement>('#copy-path-button')!.click();
    document.querySelector<HTMLButtonElement>('#reveal-path-button')!.click();
    await Promise.resolve();

    expect(document.querySelector('#saved-path')?.textContent).toBe(path);
    expect(actions.copyPath).toHaveBeenCalledWith(path);
    expect(actions.revealPath).toHaveBeenCalledWith(path);
  });

  it('preserves copied text for the same saved path and resets it for a new path', async () => {
    renderSidePanel(document, { phase: 'saved', path: '/library/a/index.md' }, actions);
    const copyButton = document.querySelector<HTMLButtonElement>('#copy-path-button')!;
    copyButton.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(copyButton.textContent).toBe('路径已复制');

    renderSidePanel(document, { phase: 'saved', path: '/library/a/index.md' }, actions);
    expect(copyButton.textContent).toBe('路径已复制');

    renderSidePanel(document, { phase: 'saved', path: '/library/b/index.md' }, actions);
    expect(copyButton.textContent).toBe('复制文件路径');
  });

  it('contains no manual connection form or legacy copy', async () => {
    const html = await readFile(join(PANEL_ROOT, 'index.html'), 'utf8');

    expect(document.querySelector('#pair-form')).toBeNull();
    expect(html).not.toMatch(/popup|pair/i);
    expect(html).not.toMatch(new RegExp(['配', '对码'].join('')));
  });
});

describe('responsive side panel layout', () => {
  it('fills the panel viewport and keeps the footer in document flow', async () => {
    const css = await readFile(join(PANEL_ROOT, 'styles.css'), 'utf8');

    expect(css).toMatch(/width:\s*100%/);
    expect(css).toMatch(/min-width:\s*280px/);
    expect(css).toMatch(/min-height:\s*100vh/);
    expect(css).toMatch(/\.masthead\s*\{[^}]*position:\s*sticky/s);
    expect(css).not.toMatch(/\.privacy-note\s*\{[^}]*position:\s*absolute/s);
  });

  it('uses a single result-action column below 420px and two above it', async () => {
    const css = await readFile(join(PANEL_ROOT, 'styles.css'), 'utf8');

    expect(css).toMatch(/\.result-actions\s*\{[^}]*grid-template-columns:\s*1fr/s);
    expect(css).toMatch(
      /@media\s*\(min-width:\s*420px\)[\s\S]*?\.result-actions\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*1fr\)/,
    );
  });
});

describe('persistent side panel refresh cadence', () => {
  it('polls quickly while connecting or collecting and every second otherwise', async () => {
    const source = await readFile(join(PANEL_ROOT, 'index.ts'), 'utf8');

    expect(source).toContain("connecting: 250");
    expect(source).toContain("collecting: 700");
    expect(source).toContain("batch: 700");
    expect(source).toContain("default: 1000");
  });
});
