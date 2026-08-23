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

function batchStatus(phase: string, extra: Record<string, unknown> = {}) {
  return {
    ...readyStatus(),
    batch: {
      url: LIST_URL,
      collected: 2,
      skipped: 1,
      failed: 0,
      rounds: 1,
      phase,
      updatedAt: Date.now(),
      log: ['12:00:00 第 1 轮：本屏待采 3 条'],
      ...extra,
    },
    batchItems: [
      { key: 'a', title: '已入库的一条', status: 'saved' },
      { key: 'b', title: '跳过的一条', status: 'skipped', reason: '没能对上帖子号' },
    ],
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
  // 上一个用例导入的侧栏模块还在轮询，会继续往同一个 document 上渲染、
  // 把下一个用例的屏幕覆盖掉。侧栏关闭时本来就该停轮询，这里发一次 pagehide
  // 让它按生产逻辑收工。
  window.dispatchEvent(new Event('pagehide'));
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('side panel build stamp', () => {
  it('右下角常驻显示构建版本', () => {
    // 用户无法从浏览器里判断自己加载的是不是最新构建，只能靠「某个功能怎么没出现」
    // 反推——实际就这么踩过一次：功能全做完了，用户看到的还是旧版。
    const stamp = document.querySelector<HTMLElement>('#build-id');
    expect(stamp).not.toBeNull();
    // 直接跑源码时没有打包期注入的 __BUILD_ID__，必须退化成明确文案而不是空白或崩溃。
    expect(stamp?.textContent).toBe('开发构建');
  });
});

describe('fixed collection plans page', () => {
  it('loads plan status and can force an immediate run through the background', async () => {
    const seen: Array<{ type: string; planId?: string; force?: boolean }> = [];
    handler = async message => {
      seen.push(message as { type: string; planId?: string; force?: boolean });
      if (message.type === 'plans.status') {
        return {
          ok: true,
          value: {
            plans: [{
              id: 'nowcoder-agent-market',
              due: false,
              pending: false,
              nextRunAt: '2026-08-24T01:00:00.000Z',
            }],
          },
        };
      }
      if (message.type === 'plans.run') return { ok: true, value: { batch: { id: 'batch-1' } } };
      return { ok: true, value: readyStatus() };
    };

    document.querySelector<HTMLButtonElement>('#nav-plans')!.click();
    await vi.waitFor(() => expect(visible('#plans-panel')).toBe(true));
    await vi.waitFor(() => expect(
      document.querySelector<HTMLButtonElement>('[data-plan-run="nowcoder-agent-market"]'),
    ).not.toBeNull());
    document.querySelector<HTMLButtonElement>('[data-plan-run="nowcoder-agent-market"]')!.click();
    await vi.waitFor(() => expect(seen).toContainEqual({
      type: 'plans.run',
      planId: 'nowcoder-agent-market',
      force: true,
    }));
  });
});

describe('side panel details view', () => {
  it('opens the per-post list from the batch result and can come back', async () => {
    handler = async message =>
      message.type === 'capture.list'
        ? { ok: true, value: { phase: 'done' } }
        : { ok: true, value: batchStatus('done') };

    document.querySelector<HTMLButtonElement>('#capture-button')!.click();
    await vi.waitFor(() => expect(visible('#batch-panel')).toBe(true));

    document.querySelector<HTMLButtonElement>('#batch-items-button')!.click();
    await vi.waitFor(() => expect(visible('#items-panel')).toBe(true));
    expect(document.querySelectorAll('#items-list li')).toHaveLength(2);

    document.querySelector<HTMLButtonElement>('#items-back-button')!.click();
    await vi.waitFor(() => expect(visible('#batch-panel')).toBe(true));
  });

  it('asks the page to scroll to and highlight the clicked post', async () => {
    const located: string[] = [];
    handler = async message => {
      if (message.type === 'capture.list') return { ok: true, value: { phase: 'done' } };
      if (message.type === 'list.locate') {
        located.push((message as unknown as { key: string }).key);
        return { ok: true, value: { found: true } };
      }
      return { ok: true, value: batchStatus('done') };
    };

    document.querySelector<HTMLButtonElement>('#capture-button')!.click();
    await vi.waitFor(() => expect(visible('#batch-panel')).toBe(true));
    document.querySelector<HTMLButtonElement>('#batch-items-button')!.click();
    await vi.waitFor(() => expect(visible('#items-panel')).toBe(true));

    document.querySelector<HTMLButtonElement>('#items-list button')!.click();
    await vi.waitFor(() => expect(located).toEqual(['a']));
  });

  it('点没入库的那条：滚过去之外，还把证据复制到剪贴板', async () => {
    // 「为什么这条被跳过」必须能一键取证，否则只能靠来回猜——已经绕了太多圈。
    const copied: string[] = [];
    const diagnosed: string[] = [];
    vi.stubGlobal('navigator', {
      clipboard: { writeText: async (text: string) => { copied.push(text); } },
    });
    handler = async message => {
      if (message.type === 'capture.list') return { ok: true, value: { phase: 'done' } };
      if (message.type === 'list.locate') return { ok: true, value: { found: true } };
      if (message.type === 'list.itemDiagnose') {
        diagnosed.push((message as unknown as { key: string }).key);
        return { ok: true, value: { diagnostics: '{"kind":"item","key":"b"}' } };
      }
      return { ok: true, value: batchStatus('done') };
    };

    document.querySelector<HTMLButtonElement>('#capture-button')!.click();
    await vi.waitFor(() => expect(visible('#batch-panel')).toBe(true));
    document.querySelector<HTMLButtonElement>('#batch-items-button')!.click();
    await vi.waitFor(() => expect(visible('#items-panel')).toBe(true));

    // 第二条是「已跳过」，正是需要取证的那种。
    document.querySelectorAll<HTMLButtonElement>('#items-list button')[1]!.click();
    await vi.waitFor(() => expect(copied).toEqual(['{"kind":"item","key":"b"}']));
    expect(diagnosed).toEqual(['b']);
    expect(document.querySelector('#items-hint')?.textContent).toContain('已复制到剪贴板');
  });

  it('已入库的那条不取证，避免无谓打扰', async () => {
    const diagnosed: string[] = [];
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => undefined } });
    handler = async message => {
      if (message.type === 'capture.list') return { ok: true, value: { phase: 'done' } };
      if (message.type === 'list.locate') return { ok: true, value: { found: true } };
      if (message.type === 'list.itemDiagnose') {
        diagnosed.push('called');
        return { ok: true, value: { diagnostics: '{}' } };
      }
      return { ok: true, value: batchStatus('done') };
    };

    document.querySelector<HTMLButtonElement>('#capture-button')!.click();
    await vi.waitFor(() => expect(visible('#batch-panel')).toBe(true));
    document.querySelector<HTMLButtonElement>('#batch-items-button')!.click();
    await vi.waitFor(() => expect(visible('#items-panel')).toBe(true));

    document.querySelector<HTMLButtonElement>('#items-list button')!.click();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(diagnosed).toEqual([]);
  });
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

  it('和后台失联时让批量记录说话，而不是把原生英文报错粘在屏上', async () => {
    // 批量要跑好几分钟，中途后台被回收时这条消息的端口会断，抛出来的是
    // 「message port closed」这类原生报错。它对用户毫无意义，而且会顶在最前面，
    // 把写好的「已中断，可续采」屏彻底盖掉——E8 那条路径因此一直走不到。
    handler = async message =>
      message.type === 'capture.list'
        ? { ok: false, error: 'The message port closed before a response was received.' }
        : { ok: true, value: finishedBatchStatus() };

    document.querySelector<HTMLButtonElement>('#capture-button')!.click();
    await vi.waitFor(() => expect(visible('#batch-panel')).toBe(true));
    expect(visible('#job-error-panel')).toBe(false);
    // 原生英文报错一个字都不该出现在界面上。
    expect(document.body.textContent).not.toContain('message port closed');
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
            error: '页面脚本未就绪，且自动注入没有成功。',
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
    // 绝不出现「刷新页面」：刷新会把知识星球的「精华」分类退回「最新」。
    expect(document.querySelector<HTMLButtonElement>('#batch-retry-button')?.textContent)
      .toBe('重试');
    expect(document.querySelector('#batch-panel')?.textContent).not.toContain('刷新');
    expect(visible('#job-error-panel')).toBe(false);
  });
});

describe('已入库 → 同步远程', () => {
  const ENTRY = {
    id: 'aaa',
    source: 'zsxq',
    title: '创业板跌破 60 日线',
    url: 'https://wx.zsxq.com/topic/511',
    category: '投资',
    updatedAt: '2026-07-31T00:00:00.000Z',
  };

  function libraryHandler(entries: unknown[], onSync: (payload: unknown) => unknown): Handler {
    return async message => {
      if (message.type === 'library.list') return { ok: true, value: { entries } };
      if (message.type === 'library.sync') return { ok: true, value: onSync(message) };
      return { ok: true, value: readyStatus() };
    };
  }

  it('未同步的条目可以一键同步，结果如实回报', async () => {
    let synced: unknown;
    handler = libraryHandler([ENTRY], message => {
      synced = message;
      return { synced: 1, failed: 0, entries: [{ title: ENTRY.title, sync: { state: 'synced' } }] };
    });

    document.querySelector<HTMLButtonElement>('#nav-library')!.click();
    await vi.waitFor(() => expect(document.querySelectorAll('#library-list li')).toHaveLength(1));
    const button = document.querySelector<HTMLButtonElement>('#library-sync-button')!;
    expect(button.textContent).toContain('同步未同步的 1 条');

    button.click();
    await vi.waitFor(() => expect(synced).toBeDefined());
    // 「同步全部未同步」由 Bridge 展开成具体 id，绝不把「没传 ids」当成「同步全部」。
    expect(synced).toMatchObject({ type: 'library.sync', pending: true });
    await vi.waitFor(() =>
      expect(document.querySelector('#library-sync-note')?.textContent).toContain('已同步 1 条'),
    );
  });

  it('多条因为同一个原因失败时，只说一次原因加条数', async () => {
    // 实测：16 条因为同一个 git 报错失败，面板把同一句话重复贴了 16 遍，
    // 既看不出该干什么，也完全没法读。
    const many = Array.from({ length: 16 }, (_, index) => ({
      title: `第 ${index + 1} 条内容的标题`,
      sync: { state: 'failed', error: 'git add 失败：这台 Mac 的命令行工具坏了或没装。' },
    }));
    handler = libraryHandler([ENTRY], () => ({ synced: 0, failed: 16, entries: many }));

    document.querySelector<HTMLButtonElement>('#nav-library')!.click();
    await vi.waitFor(() => expect(document.querySelectorAll('#library-list li')).toHaveLength(1));
    document.querySelector<HTMLButtonElement>('#library-sync-button')!.click();

    await vi.waitFor(() => {
      const note = document.querySelector('#library-sync-note')?.textContent ?? '';
      expect(note).toContain('失败 16 条');
      // 原因只出现一次，并带上条数。
      expect(note.split('命令行工具坏了').length - 1).toBe(1);
      expect(note).toContain('16 条，例如');
    });
  });

  it('同步失败要点名是哪一条、为什么，不只给个总数', async () => {
    handler = libraryHandler([ENTRY], () => ({
      synced: 0,
      failed: 1,
      entries: [{ title: ENTRY.title, sync: { state: 'failed', error: '没有为「zsxq」配置同步去向' } }],
    }));

    document.querySelector<HTMLButtonElement>('#nav-library')!.click();
    await vi.waitFor(() => expect(document.querySelectorAll('#library-list li')).toHaveLength(1));
    document.querySelector<HTMLButtonElement>('#library-sync-button')!.click();

    await vi.waitFor(() => {
      const note = document.querySelector('#library-sync-note')?.textContent ?? '';
      expect(note).toContain('失败 1 条');
      expect(note).toContain('创业板跌破 60 日线');
      expect(note).toContain('没有为「zsxq」配置同步去向');
    });
  });

  it('全部已同步时不再提供批量同步（没有可同步的东西）', async () => {
    handler = libraryHandler(
      [{ ...ENTRY, sync: { state: 'synced', target: 'life-teachers' } }],
      () => ({ synced: 0, failed: 0, entries: [] }),
    );

    document.querySelector<HTMLButtonElement>('#nav-library')!.click();
    await vi.waitFor(() => expect(document.querySelectorAll('#library-list li')).toHaveLength(1));
    const button = document.querySelector<HTMLButtonElement>('#library-sync-button')!;
    await vi.waitFor(() => expect(button.disabled).toBe(true));
    expect(button.textContent).toBe('全部已同步');
  });

  it('逐条同步：只把这一条的 id 发出去', async () => {
    let payload: unknown;
    handler = libraryHandler([ENTRY], message => {
      payload = message;
      return { synced: 1, failed: 0, entries: [{ title: ENTRY.title, sync: { state: 'synced' } }] };
    });

    document.querySelector<HTMLButtonElement>('#nav-library')!.click();
    await vi.waitFor(() => expect(document.querySelectorAll('#library-list li')).toHaveLength(1));
    [...document.querySelectorAll<HTMLButtonElement>('#library-list .row-button')]
      .find(button => button.textContent === '同步')!
      .click();

    await vi.waitFor(() => expect(payload).toMatchObject({ type: 'library.sync', ids: ['aaa'] }));
  });
});
