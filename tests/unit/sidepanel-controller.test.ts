// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PANEL_ROOT = join(
  import.meta.dirname,
  '..',
  '..',
  'packages',
  'extension',
  'src',
  'sidepanel',
);

const LIST_URL = 'https://wx.zsxq.com/group/48844584441158';

type Handler = (message: { type: string }) => Promise<unknown>;

let handler: Handler;

function readyStatus() {
  return {
    bridgeStatus: 'connected',
    page: {
      supported: true,
      list: true,
      title: '重远投资观',
      url: LIST_URL,
      destinations: [{ id: 'life-teachers', label: 'life-teachers 收件箱', categories: ['投资'] }],
      defaultSinkIds: ['life-teachers'],
      routeTargets: ['life-teachers 收件箱'],
    },
  };
}

/** 模拟旧 bug 的现场：后台留下一条「已结束」的批量记录。 */
function finishedBatchStatus() {
  return {
    ...readyStatus(),
    batch: {
      url: LIST_URL,
      collected: 0,
      skipped: 0,
      failed: 0,
      rounds: 0,
      phase: 'done',
      updatedAt: Date.now(),
    },
  };
}

function visible(selector: string): boolean {
  return document.querySelector<HTMLElement>(selector)?.hidden === false;
}

beforeEach(async () => {
  document.open();
  document.write(await readFile(join(PANEL_ROOT, 'index.html'), 'utf8'));
  document.close();
  handler = async () => ({ ok: true, value: readyStatus() });
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: (message: { type: string }) => handler(message) },
  });
  vi.resetModules();
  await import('../../packages/extension/src/sidepanel/index.js');
  // 放过启动时的首次 refresh。
  await vi.waitFor(() => expect(visible('#ready-panel')).toBe(true));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('side panel controller error precedence', () => {
  it('keeps a local failure on screen instead of letting the next poll overwrite it', async () => {
    // 批量根本没能开始（如找不到可采集的标签页）：失败只活在侧栏本地。
    handler = async message =>
      message.type === 'capture.list'
        ? { ok: false, error: '批量采集没能开始：当前没有可采集的浏览器页面' }
        : { ok: true, value: finishedBatchStatus() };

    document.querySelector<HTMLButtonElement>('#capture-button')!.click();
    await vi.waitFor(() => expect(visible('#job-error-panel')).toBe(true));
    expect(document.querySelector('#job-error-message')?.textContent).toContain('没有可采集');

    // 关键回归：轮询照常跑，但不许把错误屏换成「批量归档完成」。
    // 事故现场就是这样——错误一闪而过，1 秒后跳到成功屏。
    for (let tick = 0; tick < 4; tick += 1) {
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(visible('#job-error-panel')).toBe(true);
      expect(visible('#batch-panel')).toBe(false);
    }
    expect(document.querySelector('#job-error-message')?.textContent).toContain('没有可采集');
  });

  it('clears the sticky failure once the user asks to retry', async () => {
    handler = async message =>
      message.type === 'capture.list'
        ? { ok: false, error: '批量采集没能开始' }
        : { ok: true, value: readyStatus() };

    document.querySelector<HTMLButtonElement>('#capture-button')!.click();
    await vi.waitFor(() => expect(visible('#job-error-panel')).toBe(true));

    // 只有用户动作能解除粘性错误。
    handler = async () => ({ ok: true, value: readyStatus() });
    document.querySelector<HTMLButtonElement>('#job-recapture-button')!.click();
    await vi.waitFor(() => expect(visible('#ready-panel')).toBe(true));
  });

  it('lets a batch failure recorded by the background drive the batch panel', async () => {
    // 批量自身的失败写进了 batch 记录：由推导状态呈现，不走本地粘性错误，
    // 这样「重试 / 复制诊断」这些按钮才拿得到失败分类。
    handler = async message => {
      if (message.type === 'capture.list') {
        return { ok: true, value: { phase: 'failed', code: 'CONTENT_SCRIPT_MISSING' } };
      }
      return {
        ok: true,
        value: {
          ...readyStatus(),
          batch: {
            url: LIST_URL,
            collected: 0,
            skipped: 0,
            failed: 0,
            rounds: 0,
            phase: 'failed',
            code: 'CONTENT_SCRIPT_MISSING',
            error: '页面脚本未就绪：插件安装或更新后，之前打开的标签页需要重新加载一次。',
            updatedAt: Date.now(),
          },
        },
      };
    };

    document.querySelector<HTMLButtonElement>('#capture-button')!.click();
    // 先乐观渲染「正在批量归档」，随后由后台记录接管为失败终态。
    await vi.waitFor(() =>
      expect(document.querySelector('#batch-heading')?.textContent).toBe('批量归档中断'),
    );

    expect(visible('#batch-panel')).toBe(true);
    expect(document.querySelector('#batch-heading')?.textContent).not.toContain('完成');
    expect(document.querySelector<HTMLButtonElement>('#batch-retry-button')?.textContent)
      .toBe('刷新页面并重试');
    expect(visible('#job-error-panel')).toBe(false);
  });
});
