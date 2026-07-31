// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  sidePanelStateFromStatus,
  renderSidePanel,
  renderUpdateBanner,
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
    reloadExtension: vi.fn(async () => undefined),
    showItems: vi.fn(),
    filterItems: vi.fn(),
    locateItem: vi.fn(async () => undefined),
    copyLog: vi.fn(async () => undefined),
    openPage: vi.fn(),
    reloadLibrary: vi.fn(async () => undefined),
    filterLibrary: vi.fn(),
    askDelete: vi.fn(),
    confirmDelete: vi.fn(async () => undefined),
    cancelDelete: vi.fn(),
    filterSync: vi.fn(),
    syncLibrary: vi.fn(async () => undefined),
    openEntry: vi.fn(),
    closeEntry: vi.fn(),
    openSource: vi.fn(),
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

  it('carries the output path through so the result screen can point somewhere', () => {
    const url = 'https://wx.zsxq.com/group/48844584441158';
    const batch = {
      url,
      collected: 6,
      skipped: 0,
      failed: 0,
      rounds: 1,
      phase: 'done' as const,
      updatedAt: 1_000,
    };
    const page = { supported: true, list: true, title: '', url };

    expect(sidePanelStateFromStatus(
      { bridgeStatus: 'connected', batch, lastOutputPath: '/library/a/index.md', page },
      () => 2_000,
    )).toMatchObject({ phase: 'batch', outputPath: '/library/a/index.md' });

    // 零产出时不给路径：没有东西可看。
    expect(sidePanelStateFromStatus(
      {
        bridgeStatus: 'connected',
        batch: { ...batch, collected: 0, phase: 'empty' },
        lastOutputPath: '/library/a/index.md',
        page,
      },
      () => 2_000,
    )).not.toHaveProperty('outputPath');
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
    })).toEqual({ phase: 'saved', path: '/tmp/x/index.md', targets: [] });
  });

  it('names every destination a saved job actually reached', () => {
    // 默认路由同时写两处时，结果屏必须两处都说出来——只说「本地知识库」是在骗人。
    const page = {
      supported: true,
      title: '通胀与估值',
      url: 'https://wx.zsxq.com/topic/511',
      destinations: [
        { id: 'markdown', label: '本机库', categories: [] },
        { id: 'life-teachers', label: 'life-teachers 收件箱', categories: [] },
      ],
    };
    expect(sidePanelStateFromStatus({
      bridgeStatus: 'connected',
      lastJobStatus: 'saved',
      lastJobUrl: page.url,
      lastOutputPath: '/tmp/x/index.md',
      lastSinkIds: ['markdown', 'life-teachers'],
      page,
    })).toEqual({
      phase: 'saved',
      path: '/tmp/x/index.md',
      targets: ['本机库', 'life-teachers 收件箱'],
    });
  });
});

describe('side panel DOM behavior', () => {
  it('采集只落本机库；面板说明之后同步到哪，分类跟随同步去向', async () => {
    // 新链路：采集 → 本机库 → 人工核对 → 显式同步 → Agent 归档。
    // 因此这里不再有「去向」选择器——选了也不会在采集时生效，
    // 摆一个不起作用的控件比没有更糟。
    renderSidePanel(document, {
      phase: 'ready',
      url: 'https://mp.weixin.qq.com/s/current',
      sourceLabel: '微信公众号',
      title: '一夜之间，通胀的玩笑这次开大了',
      category: '',
      tags: ['通胀', '投资'],
      list: false,
      syncTarget: 'life-teachers 收件箱',
      destinations: [
        { id: 'markdown', label: '本机库', categories: ['商业与投资', '认知'] },
        { id: 'life-teachers', label: 'life-teachers 收件箱', categories: ['投资', '财富', '认知'] },
      ],
    }, actions);

    expect(document.querySelector<HTMLElement>('#ready-panel')?.hidden).toBe(false);
    expect(document.querySelector('#page-title')?.textContent).toContain('一夜之间');
    expect(document.querySelector('#destination')).toBeNull();

    // 采集去向说死：只落本机库。
    expect(document.querySelector('#route-hint')?.textContent).toBe('保存去向：本机库（采集只落本地）');
    // 并说明下一步：核对后同步到哪，再由 Agent 归档。
    const syncHint = document.querySelector('#sync-hint');
    expect(syncHint?.textContent).toContain('life-teachers 收件箱');
    expect(syncHint?.textContent).toContain('已入库');

    // 分类用**同步去向**那套体系：内容最终要去那儿，不该给本机库那套。
    const category = document.querySelector<HTMLSelectElement>('#category')!;
    expect([...category.options].map(option => option.value))
      .toEqual(['', '投资', '财富', '认知']);

    category.value = '投资';
    document.querySelector<HTMLInputElement>('#tags')!.value = '宏观, 利率';
    document.querySelector<HTMLButtonElement>('#capture-button')!.click();
    await Promise.resolve();

    // 不再下发 sinks：采集阶段没有去向可选。
    expect(actions.capture).toHaveBeenCalledWith({
      userCategory: '投资',
      userTags: ['宏观', '利率'],
      maxItems: 20,
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

    // 目标条数只对批量有意义，列表页才显示。
    expect(document.querySelector<HTMLElement>('#target')?.hidden).toBe(false);
    document.querySelector<HTMLInputElement>('#target')!.value = '8';
    document.querySelector<HTMLButtonElement>('#capture-button')!.click();
    await Promise.resolve();

    // 列表页绝不能走单页保存——那会把整个信息流糊成一篇。
    expect(actions.capture).not.toHaveBeenCalled();
    // 采够 8 条就自动停，用户不必盯着手动停。
    expect(actions.captureList).toHaveBeenLastCalledWith({ userCategory: '投资', maxItems: 8 });
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

    document.querySelector<HTMLButtonElement>('#batch-done-button')!.click();
    await Promise.resolve();
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

  it('never offers to reload the page — that would reset the site tab the user is on', async () => {
    renderSidePanel(
      document,
      batchState('failed', {
        code: 'CONTENT_SCRIPT_MISSING',
        message: '页面脚本未就绪，且自动注入没有成功。',
      }),
      actions,
    );

    const retry = document.querySelector<HTMLButtonElement>('#batch-retry-button')!;
    // 知识星球的「精华」分类是应用内状态，刷新会退回「最新」，采到的就不是用户要的内容。
    expect(retry.textContent).toBe('重试');
    expect(document.querySelector('#batch-panel')?.textContent).not.toContain('刷新页面');

    retry.click();
    await Promise.resolve();
    // 重试 = 重来一遍（先还原页面），不带 continuation。
    const [, options] = vi.mocked(actions.captureList).mock.calls[0]!;
    expect(options?.continuation).toBeUndefined();
  });

  it('continues a batch without resetting the marks, and retries with a reset', async () => {
    renderSidePanel(document, batchState('done', { collected: 3 }), actions);
    document.querySelector<HTMLButtonElement>('#batch-continue-button')!.click();
    await Promise.resolve();
    expect(actions.captureList).toHaveBeenCalledWith(expect.anything(), { continuation: true });
  });

  it('E4: offers one-click diagnostics on every state that needs attention', async () => {
    for (const phase of ['skipped_all', 'empty', 'failed'] as const) {
      renderSidePanel(document, batchState(phase, { skipped: 21 }), actions);
      expect(visible('#batch-diagnose-button')).toBe(true);
    }
    document.querySelector<HTMLButtonElement>('#batch-diagnose-button')!.click();
    await Promise.resolve();
    expect(actions.diagnoseBatch).toHaveBeenCalledOnce();

    // 成功终态不该出现诊断按钮。
    renderSidePanel(document, batchState('done', { collected: 3 }), actions);
    expect(visible('#batch-diagnose-button')).toBe(false);
  });

  it('tells the user where the batch put things, and offers to open it', async () => {
    renderSidePanel(
      document,
      { ...batchState('done', { collected: 6 }), outputPath: '/Users/x/code/life-teachers/_inbox/知识星球/a/original.md' },
      actions,
    );

    // 采了 6 条却不说落在哪，用户只能干看着——结果页必须给出去向和入口。
    expect(visible('#batch-path')).toBe(true);
    expect(document.querySelector('#batch-path')?.textContent).toContain('_inbox');
    expect(visible('#batch-reveal-button')).toBe(true);
    document.querySelector<HTMLButtonElement>('#batch-reveal-button')!.click();
    await Promise.resolve();
    expect(actions.revealPath).toHaveBeenCalledWith(
      '/Users/x/code/life-teachers/_inbox/知识星球/a/original.md',
    );

    // 一条都没采到时不该出现路径和入口。
    renderSidePanel(document, batchState('skipped_all', { skipped: 21 }), actions);
    expect(visible('#batch-path')).toBe(false);
    expect(visible('#batch-reveal-button')).toBe(false);
  });

  it('lists every post with its status, filters by status, and locates one on click', async () => {
    const items = [
      { key: 'a', title: '创业板已经跌破 60 日线', status: 'saved' as const, url: 'https://x/topic/1' },
      { key: 'b', title: '一条没对上号的帖子', status: 'skipped' as const, reason: '没能对上帖子号' },
      { key: 'c', title: '写入失败的帖子', status: 'failed' as const, reason: '写入本机失败' },
    ];
    renderSidePanel(document, { phase: 'items', items, filter: 'all', log: ['第一轮 ...'] }, actions);

    expect(visible('#items-panel')).toBe(true);
    expect(document.querySelector('#items-heading')?.textContent).toBe('本轮看到 3 条');
    expect(document.querySelectorAll('#items-list li')).toHaveLength(3);
    // 状态要看得见，而不是只有一个总数。
    expect(document.querySelector('#items-list li')?.getAttribute('data-status')).toBe('saved');
    expect(document.querySelector('#items-list')?.textContent).toContain('没能对上帖子号');

    // 顶部筛选按状态分组，并带上各自条数。
    const chips = [...document.querySelectorAll('#items-filters button')].map(chip => chip.textContent);
    expect(chips).toEqual(['全部 3', '已入库 1', '已跳过 1', '失败 1']);
    document.querySelectorAll<HTMLButtonElement>('#items-filters button')[1]!.click();
    expect(actions.filterItems).toHaveBeenCalledWith('saved');

    // 点某一条 → 让页面滚过去并高亮它。
    document.querySelector<HTMLButtonElement>('#items-list button')!.click();
    await Promise.resolve();
    expect(actions.locateItem).toHaveBeenCalledWith('a', 'saved');

    document.querySelector<HTMLButtonElement>('#items-log-button')!.click();
    await Promise.resolve();
    expect(actions.copyLog).toHaveBeenCalledWith(['第一轮 ...']);
  });

  it('applies the active filter and says so when nothing matches', () => {
    const items = [
      { key: 'a', title: '已入库的', status: 'saved' as const },
      { key: 'b', title: '跳过的', status: 'skipped' as const },
    ];
    renderSidePanel(document, { phase: 'items', items, filter: 'skipped', log: [] }, actions);

    expect(document.querySelectorAll('#items-list li')).toHaveLength(1);
    expect(document.querySelector('#items-list')?.textContent).toContain('跳过的');
    expect(visible('#items-empty')).toBe(false);

    renderSidePanel(document, { phase: 'items', items, filter: 'failed', log: [] }, actions);
    expect(document.querySelectorAll('#items-list li')).toHaveLength(0);
    expect(visible('#items-empty')).toBe(true);
  });

  it('offers the details entry on any terminal state that saw posts', () => {
    renderSidePanel(document, batchState('skipped_all', { skipped: 21 }), actions);
    // 全部跳过时最需要逐条看为什么被跳过。
    expect(visible('#batch-items-button')).toBe(true);

    renderSidePanel(document, batchState('running', { collected: 2 }), actions);
    expect(visible('#batch-items-button')).toBe(false);

    renderSidePanel(document, batchState('empty'), actions);
    expect(visible('#batch-items-button')).toBe(false);
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
    renderSidePanel(document, { phase: 'saved', path, targets: ['本机库'] }, actions);
    document.querySelector<HTMLButtonElement>('#copy-path-button')!.click();
    document.querySelector<HTMLButtonElement>('#reveal-path-button')!.click();
    await Promise.resolve();

    expect(document.querySelector('#saved-path')?.textContent).toBe(path);
    expect(actions.copyPath).toHaveBeenCalledWith(path);
    expect(actions.revealPath).toHaveBeenCalledWith(path);
  });

  it('preserves copied text for the same saved path and resets it for a new path', async () => {
    renderSidePanel(document, { phase: 'saved', path: '/library/a/index.md', targets: [] }, actions);
    const copyButton = document.querySelector<HTMLButtonElement>('#copy-path-button')!;
    copyButton.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(copyButton.textContent).toBe('路径已复制');

    renderSidePanel(document, { phase: 'saved', path: '/library/a/index.md', targets: [] }, actions);
    expect(copyButton.textContent).toBe('路径已复制');

    renderSidePanel(document, { phase: 'saved', path: '/library/b/index.md', targets: [] }, actions);
    expect(copyButton.textContent).toBe('复制文件路径');
  });

  it('offers one-click reload when the local service already built a newer version', async () => {
    renderUpdateBanner(document, true, actions);

    // 用户只该做这一件事：点一下。不用去 edge://extensions，也不用开终端。
    expect(document.querySelector<HTMLElement>('#update-banner')?.hidden).toBe(false);
    document.querySelector<HTMLButtonElement>('#update-reload-button')!.click();
    await Promise.resolve();
    expect(actions.reloadExtension).toHaveBeenCalledOnce();

    renderUpdateBanner(document, false, actions);
    expect(document.querySelector<HTMLElement>('#update-banner')?.hidden).toBe(true);
  });

  it('lists library entries, filters by source, and never deletes without confirmation', async () => {
    const entries = [
      { id: 'a', source: '知识星球', title: '第一条', url: 'https://x/a', category: '投资', updatedAt: '2026-07-25T00:00:00.000Z' },
      { id: 'b', source: '微信公众号', title: '第二条', url: 'https://x/b', category: '认知', updatedAt: '2026-07-24T00:00:00.000Z' },
    ];
    renderSidePanel(document, { phase: 'library', entries, source: '', syncFilter: 'all', loading: false }, actions);

    expect(visible('#library-panel')).toBe(true);
    expect(document.querySelector('#library-heading')?.textContent).toBe('已入库 2 条');
    expect(document.querySelectorAll('#library-list li')).toHaveLength(2);
    expect([...document.querySelectorAll('#library-filters button')].map(chip => chip.textContent))
      .toEqual(['全部 2', '微信公众号 1', '知识星球 1']);

    document.querySelectorAll<HTMLButtonElement>('#library-filters button')[1]!.click();
    expect(actions.filterLibrary).toHaveBeenCalledWith('微信公众号');

    // 点删除只进入确认态，绝不直接删。
    [...document.querySelectorAll<HTMLButtonElement>('#library-list .item-delete')]
      .find(button => button.textContent === '删除')!
      .click();
    expect(actions.askDelete).toHaveBeenCalledWith({ kind: 'one', id: 'a', title: '第一条' });
    expect(actions.confirmDelete).not.toHaveBeenCalled();
  });

  it('spells out what a destructive action will remove before doing it', async () => {
    const entries = [
      { id: 'a', source: '知识星球', title: '第一条', url: 'https://x/a', category: '投资', updatedAt: '2026-07-25T00:00:00.000Z' },
    ];
    renderSidePanel(
      document,
      {
        phase: 'library',
        syncFilter: 'all',
        entries,
        source: '',
        loading: false,
        pending: { kind: 'all', count: 12 },
      },
      actions,
    );

    const confirm = document.querySelector('#library-confirm');
    expect(visible('#library-confirm')).toBe(true);
    expect(confirm?.textContent).toContain('全部 12 条');
    expect(confirm?.textContent).toContain('不可恢复');

    document.querySelector<HTMLButtonElement>('#library-confirm-yes')!.click();
    await Promise.resolve();
    expect(actions.confirmDelete).toHaveBeenCalledOnce();

    document.querySelector<HTMLButtonElement>('#library-confirm-no')!.click();
    expect(actions.cancelDelete).toHaveBeenCalledOnce();
  });

  it('disables 清空 when the library is already empty', () => {
    renderSidePanel(document, { phase: 'library', entries: [], source: '', syncFilter: 'all', loading: false }, actions);

    expect(document.querySelector<HTMLButtonElement>('#library-clear-button')?.disabled).toBe(true);
    expect(visible('#library-empty')).toBe(true);
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

describe('已入库页面', () => {
  const ENTRIES = [
    {
      id: 'aaa',
      source: 'zsxq',
      title: '创业板跌破 60 日线',
      url: 'https://wx.zsxq.com/topic/511',
      category: '投资',
      updatedAt: '2026-07-26T00:00:00.000Z',
    },
  ];

  it('来源显示成人话，不把内部标识摆给用户看', () => {
    renderSidePanel(document, { phase: 'library', entries: ENTRIES, source: '', syncFilter: 'all', loading: false }, actions);

    expect(document.querySelector('#library-list .item-status')?.textContent).toBe('知识星球');
    expect(document.querySelector('#library-list')?.textContent).not.toContain('zsxq');
    // 筛选按钮同理：显示中文，但筛选值仍是标识（要和索引对得上）。
    const chips = [...document.querySelectorAll<HTMLButtonElement>('#library-filters button')];
    expect(chips.map(chip => chip.textContent)).toEqual(['全部 1', '知识星球 1']);
    chips[1]!.click();
    expect(actions.filterLibrary).toHaveBeenCalledWith('zsxq');
  });

  it('整行可点，点了就去读这一条的正文', () => {
    // 早先这里是个 <span>，压根点不动——用户看不到自己采到了什么。
    renderSidePanel(document, { phase: 'library', entries: ENTRIES, source: '', syncFilter: 'all', loading: false }, actions);

    const row = document.querySelector<HTMLButtonElement>('#library-list .item-open');
    expect(row).not.toBeNull();
    row!.click();
    expect(actions.openEntry).toHaveBeenCalledWith('aaa', '创业板跌破 60 日线');
  });

  it('删除按钮和整行按钮是两颗按钮，删除不会被撑成整行宽', () => {
    // 回归：样式写成 `.collected-list button` 时，display:grid + width:100%
    // 漏给了「删除」，那颗小圆角按钮被撑满整行。类名分开是这条的前提。
    renderSidePanel(document, { phase: 'library', entries: ENTRIES, source: '', syncFilter: 'all', loading: false }, actions);

    const buttons = [...document.querySelectorAll<HTMLButtonElement>('#library-list .item-delete')];
    // 行内两颗小按钮：同步、删除。都不该是整行那颗（否则会被撑满整行宽）。
    expect(buttons.map(button => button.textContent)).toEqual(['同步', '删除']);
    expect(buttons.every(button => !button.classList.contains('item-open'))).toBe(true);
    const remove = buttons.find(button => button.textContent === '删除');
    remove!.click();
    expect(actions.askDelete).toHaveBeenCalledWith({
      kind: 'one', id: 'aaa', title: '创业板跌破 60 日线',
    });
  });

  it('正文浮层：读取中说在读、读到了显示正文、失败说清原因', () => {
    const base = { phase: 'library' as const, entries: ENTRIES, source: '', syncFilter: 'all' as const, loading: false };

    renderSidePanel(document, {
      ...base,
      viewing: { id: 'aaa', title: '创业板跌破 60 日线', loading: true },
    }, actions);
    expect(document.querySelector<HTMLElement>('#entry-overlay')?.hidden).toBe(false);
    expect(document.querySelector('#entry-status')?.textContent).toContain('正在读取');

    renderSidePanel(document, {
      ...base,
      viewing: {
        id: 'aaa',
        title: '创业板跌破 60 日线',
        loading: false,
        markdown: '# 标题\n\n正文内容。',
        truncated: false,
        source: 'zsxq',
        category: '投资',
        url: 'https://wx.zsxq.com/topic/511',
        absolutePath: '/library/知识星球/投资/2026/aaa/index.md',
      },
    }, actions);
    expect(document.querySelector('#entry-body')?.textContent).toContain('正文内容。');
    expect(document.querySelector('#entry-meta')?.textContent).toContain('知识星球');
    expect(document.querySelector<HTMLElement>('#entry-status')?.hidden).toBe(true);

    renderSidePanel(document, {
      ...base,
      viewing: { id: 'aaa', title: '创业板跌破 60 日线', loading: false, error: '这一条已经不在本机知识库里了' },
    }, actions);
    // 读不到必须说出来，绝不给一片空白让人以为内容就是空的。
    expect(document.querySelector('#entry-status')?.textContent).toBe('这一条已经不在本机知识库里了');
    expect(document.querySelector('#entry-body')?.textContent).toBe('');
  });

  it('没在看任何一条时浮层是收起的', () => {
    renderSidePanel(document, { phase: 'library', entries: ENTRIES, source: '', syncFilter: 'all', loading: false }, actions);

    expect(document.querySelector<HTMLElement>('#entry-overlay')?.hidden).toBe(true);
  });
});
