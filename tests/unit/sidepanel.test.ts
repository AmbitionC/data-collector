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
      .toContain('npm run collector -- bridge start');
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
  it('shows the current page and submits editable organization fields', async () => {
    renderSidePanel(document, {
      phase: 'ready',
      url: 'https://mp.weixin.qq.com/s/current',
      sourceLabel: '微信公众号',
      title: '一夜之间，通胀的玩笑这次开大了',
      category: '商业与投资',
      tags: ['通胀', '投资'],
    }, actions);

    expect(document.querySelector<HTMLElement>('#ready-panel')?.hidden).toBe(false);
    expect(document.querySelector('#page-title')?.textContent).toContain('一夜之间');
    document.querySelector<HTMLInputElement>('#category')!.value = '稍后精读';
    document.querySelector<HTMLInputElement>('#tags')!.value = '宏观, 利率';
    document.querySelector<HTMLButtonElement>('#capture-button')!.click();
    await Promise.resolve();

    expect(actions.capture).toHaveBeenCalledWith({
      userCategory: '稍后精读',
      userTags: ['宏观', '利率'],
    });
  });

  it('preserves dirty organization fields for the same URL and resets them for a new URL', () => {
    renderSidePanel(document, {
      phase: 'ready',
      url: 'https://mp.weixin.qq.com/s/a',
      sourceLabel: '微信公众号',
      title: '文章 A',
      category: '初始分类',
      tags: ['初始标签'],
    }, actions);
    document.querySelector<HTMLInputElement>('#category')!.value = '用户编辑分类';
    document.querySelector<HTMLInputElement>('#tags')!.value = '用户编辑标签';

    renderSidePanel(document, {
      phase: 'ready',
      url: 'https://mp.weixin.qq.com/s/a',
      sourceLabel: '微信公众号',
      title: '文章 A（刷新）',
      category: '',
      tags: [],
    }, actions);
    expect(document.querySelector<HTMLInputElement>('#category')?.value).toBe('用户编辑分类');
    expect(document.querySelector<HTMLInputElement>('#tags')?.value).toBe('用户编辑标签');

    renderSidePanel(document, {
      phase: 'ready',
      url: 'https://mp.weixin.qq.com/s/b',
      sourceLabel: '微信公众号',
      title: '文章 B',
      category: '新分类',
      tags: ['新标签'],
    }, actions);
    expect(document.querySelector<HTMLInputElement>('#category')?.value).toBe('新分类');
    expect(document.querySelector<HTMLInputElement>('#tags')?.value).toBe('新标签');
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
    expect(html).not.toMatch(/popup|pair|配对码|unpaired/i);
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
    expect(source).toContain("default: 1000");
  });
});
