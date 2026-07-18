// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  popupStateFromStatus,
  renderPopup,
  type PopupActions,
} from '../../packages/extension/src/popup/state.js';

const HTML_PATH = join(
  import.meta.dirname,
  '..',
  '..',
  'packages',
  'extension',
  'src',
  'popup',
  'index.html',
);

let actions: PopupActions;

beforeEach(async () => {
  document.open();
  document.write(await readFile(HTML_PATH, 'utf8'));
  document.close();
  actions = {
    pair: vi.fn(async () => undefined),
    capture: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    copyPath: vi.fn(async () => undefined),
  };
});

describe('popup states', () => {
  it('keeps polling while the paired WebSocket is still connecting', () => {
    expect(
      popupStateFromStatus({
        bridgeStatus: 'connecting',
        page: { supported: true, title: '文章', url: 'https://mp.weixin.qq.com/s/x' },
      }),
    ).toEqual({ phase: 'loading' });
  });

  it('maps Bridge organization to the third visible track stage', () => {
    expect(
      popupStateFromStatus({
        bridgeStatus: 'connected',
        lastJobStatus: 'organizing',
        page: { supported: true, title: '文章', url: 'https://mp.weixin.qq.com/s/x' },
      }),
    ).toEqual({ phase: 'collecting', activeStage: 2 });
  });

  it('shows the recognized page and submits editable organization fields', async () => {
    renderPopup(
      document,
      {
        phase: 'ready',
        sourceLabel: '微信公众号',
        title: '一夜之间，通胀的玩笑这次开大了',
        category: '商业与投资',
        tags: ['通胀', '投资'],
      },
      actions,
    );

    expect(document.querySelector<HTMLElement>('#ready-panel')?.hidden).toBe(false);
    expect(document.querySelector('#page-title')?.textContent).toContain('一夜之间');
    expect(document.querySelector<HTMLInputElement>('#category')?.value).toBe('商业与投资');
    document.querySelector<HTMLInputElement>('#category')!.value = '稍后精读';
    document.querySelector<HTMLInputElement>('#tags')!.value = '宏观, 利率';
    document.querySelector<HTMLButtonElement>('#capture-button')!.click();
    await Promise.resolve();

    expect(actions.capture).toHaveBeenCalledWith({
      userCategory: '稍后精读',
      userTags: ['宏观', '利率'],
    });
  });

  it('pairs with a six-digit code and exposes an explicit input label', async () => {
    renderPopup(document, { phase: 'unpaired' }, actions);
    const input = document.querySelector<HTMLInputElement>('#pair-code')!;

    expect(document.querySelector<HTMLLabelElement>('label[for="pair-code"]')?.textContent)
      .toContain('配对码');
    input.value = '123456';
    document.querySelector<HTMLFormElement>('#pair-form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();

    expect(actions.pair).toHaveBeenCalledWith('123456');
  });

  it('renders the four meaningful collection stages without color-only status', () => {
    renderPopup(document, { phase: 'collecting', activeStage: 2 }, actions);
    const stages = [...document.querySelectorAll<HTMLElement>('.track-step')];

    expect(stages).toHaveLength(4);
    expect(stages.map(stage => stage.textContent?.trim())).toEqual([
      '识别页面',
      '清理正文',
      '归纳内容',
      '写入本机',
    ]);
    expect(document.querySelector('[aria-current="step"]')?.textContent).toContain('归纳内容');
    expect(document.querySelector('[role="status"]')?.textContent).toContain('正在归纳内容');
  });

  it('shows the saved path and invokes copy with the exact path', async () => {
    const path = '/Users/chenhao/Documents/data-collector/微信公众号/商业与投资/index.md';
    renderPopup(document, { phase: 'saved', path }, actions);
    document.querySelector<HTMLButtonElement>('#copy-path-button')!.click();
    await Promise.resolve();

    expect(document.querySelector('#saved-path')?.textContent).toBe(path);
    expect(actions.copyPath).toHaveBeenCalledWith(path);
  });

  it('gives one concrete next step for attention states', () => {
    renderPopup(
      document,
      { phase: 'needs_attention', message: '请先登录知识星球，再打开需要保存的单条内容' },
      actions,
    );

    expect(document.querySelector<HTMLElement>('#attention-panel')?.hidden).toBe(false);
    expect(document.querySelector('#attention-message')?.textContent).toContain('请先登录知识星球');
  });
});
