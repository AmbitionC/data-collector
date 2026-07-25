import { describe, expect, it, vi } from 'vitest';
import { TRUSTED_EXTENSION_ID, type CollectedDocument } from '@data-collector/shared';
import {
  JobRunner,
  type BatchProgress,
  type BridgeClient,
  type BrowserTab,
  type TabsApi,
} from '../../packages/extension/src/background/jobs.js';

const URL = 'https://mp.weixin.qq.com/s/background-test';
const LIST_URL = 'https://wx.zsxq.com/group/48844584441158';

function document(): CollectedDocument {
  return {
    schemaVersion: 1,
    source: 'wechat',
    kind: 'article',
    url: URL,
    canonicalUrl: URL,
    title: '后台任务测试文章',
    collectedAt: '2026-07-18T00:00:00.000Z',
    html: '<p>正文内容足够长，可以完成浏览器扩展的自动采集流程。</p>',
    text: '正文内容足够长，可以完成浏览器扩展的自动采集流程。',
    images: [],
  };
}

function topic(id: string): CollectedDocument {
  const url = `${LIST_URL}/topic/${id}`;
  return {
    ...document(),
    source: 'zsxq',
    kind: 'post',
    url,
    canonicalUrl: url,
    title: `星球帖子 ${id}`,
  };
}

class InMemoryTabs implements TabsApi {
  readonly created: Array<{ url: string; active: boolean }> = [];
  readonly removed: number[] = [];
  readonly updated: Array<{ id: number; active: boolean }> = [];
  /** 内容脚本收到的消息类型顺序（批量采集靠它验证「提取一轮 → 翻一页」的节奏）。 */
  readonly asked: string[] = [];
  readonly reloaded: number[] = [];
  listRounds: Array<{ documents: CollectedDocument[]; skipped: number; total: number }> = [];
  advances: Array<{ collapsed: number; loaded: number }> = [];
  response: Awaited<ReturnType<TabsApi['sendMessage']>> = { ok: true, document: document() };
  activeTab: BrowserTab = { id: 7, url: URL, status: 'complete' };

  async create(input: { url: string; active: boolean }): Promise<BrowserTab> {
    this.created.push(input);
    return { id: 42, url: input.url, status: 'loading' };
  }

  async remove(id: number): Promise<void> {
    this.removed.push(id);
  }

  async update(id: number, input: { active: boolean }): Promise<void> {
    this.updated.push({ id, ...input });
  }

  async query(): Promise<BrowserTab[]> {
    return [this.activeTab];
  }

  async reload(id: number): Promise<void> {
    this.reloaded.push(id);
  }

  async sendMessage(
    _id: number,
    message: unknown,
  ): Promise<Awaited<ReturnType<TabsApi['sendMessage']>>> {
    const type = (message as { type?: string }).type ?? '';
    this.asked.push(type);
    if (type === 'extract.list') {
      const round = this.listRounds.shift();
      if (!round) return { ok: false, error: { code: 'COLLECTION_FAILED', message: '没有更多轮次' } };
      return { ok: true, list: round };
    }
    if (type === 'list.advance') {
      return { ok: true, advance: this.advances.shift() ?? { collapsed: 0, loaded: 0 } };
    }
    return this.response;
  }
}

class InMemoryBridge implements BridgeClient {
  readonly sent: Array<{ type: string; requestId: string; payload: unknown }> = [];
  /** 依次建过任务的 URL —— 批量采集下每条帖子必须各建各的。 */
  readonly createdFor: string[] = [];
  createdJobId = 'current-job';
  failCreateFor: string | undefined;

  send(type: string, requestId: string, payload: unknown): void {
    this.sent.push({ type, requestId, payload });
  }

  async createJob(url: string): Promise<{ id: string }> {
    this.createdFor.push(url);
    if (this.failCreateFor === url) throw new Error('创建采集任务失败：HTTP 500');
    return {
      id: this.createdFor.length === 1
        ? this.createdJobId
        : `${this.createdJobId}-${this.createdFor.length}`,
    };
  }
}

describe('extension job runner', () => {
  it('queues remote jobs so reconnect bursts do not open unlimited tabs', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    let releaseFirst: (() => void) | undefined;
    let waits = 0;
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => {
        waits += 1;
        if (waits === 1) await new Promise<void>(resolve => { releaseFirst = resolve; });
      },
    });

    const first = runner.runRemoteJob('job-1', URL);
    const second = runner.runRemoteJob('job-2', URL);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(tabs.created).toHaveLength(1);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(tabs.created).toHaveLength(2);
  });

  it('retries the content-script message while it is not ready, then succeeds', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    let calls = 0;
    tabs.sendMessage = async () => {
      calls += 1;
      if (calls < 3) throw new Error('Could not establish connection. Receiving end does not exist.');
      return { ok: true, document: document() };
    };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
    });

    await runner.runRemoteJob('job-retry', URL);
    expect(calls).toBe(3);
    expect(bridge.sent.some(message => message.type === 'job.result')).toBe(true);
    expect(bridge.sent.some(message => message.type === 'job.error')).toBe(false);
  });

  it('reports an actionable error when the current page has no content script（不再卡在「清理正文」）', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    tabs.sendMessage = async () => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
    });

    await runner.captureCurrent({});

    // 必须回报 job.error，否则任务永远停在 collecting、侧栏一直显示「清理正文」。
    const error = bridge.sent.find(message => message.type === 'job.error');
    expect(error).toBeDefined();
    const payload = error!.payload as { code: string; message: string; needsAttention: boolean };
    expect(payload.code).toBe('CONTENT_SCRIPT_MISSING');
    expect(payload.needsAttention).toBe(true);
    expect(payload.message).toContain('刷新');
    expect(bridge.sent.some(message => message.type === 'job.result')).toBe(false);
  });

  it('reports COLLECTION_FAILED when the content script never becomes ready', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    tabs.sendMessage = async () => {
      throw new Error('Receiving end does not exist.');
    };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
    });

    await runner.runRemoteJob('job-fail', URL);
    const error = bridge.sent.find(message => message.type === 'job.error');
    expect((error?.payload as { code: string }).code).toBe('COLLECTION_FAILED');
    expect(tabs.removed).toContain(42);
  });

  it('opens a background tab, returns content, and closes the created tab', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    const runner = new JobRunner({ tabs, bridge, waitForTabComplete: async () => undefined });

    await runner.runRemoteJob('job-1', URL);

    expect(tabs.created).toEqual([{ url: URL, active: false }]);
    expect(tabs.removed).toEqual([42]);
    expect(bridge.sent.map(message => message.type)).toEqual(['job.progress', 'job.result']);
    expect(bridge.sent[1]).toMatchObject({ requestId: 'job-1', payload: { document: { title: '后台任务测试文章' } } });
  });

  it('keeps and activates a tab that needs login', async () => {
    const tabs = new InMemoryTabs();
    tabs.response = {
      ok: false,
      error: { code: 'AUTH_REQUIRED', message: '请先登录知识星球' },
    };
    const bridge = new InMemoryBridge();
    const runner = new JobRunner({ tabs, bridge, waitForTabComplete: async () => undefined });

    await runner.runRemoteJob('job-2', 'https://wx.zsxq.com/dweb2/index/topic_detail/1');

    expect(tabs.removed).toEqual([]);
    expect(tabs.updated).toEqual([{ id: 42, active: true }]);
    expect(bridge.sent.at(-1)).toMatchObject({
      type: 'job.error',
      requestId: 'job-2',
      payload: { code: 'AUTH_REQUIRED', needsAttention: true },
    });
  });

  it('captures the current tab with user overrides through a real Bridge job', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    const runner = new JobRunner({ tabs, bridge, waitForTabComplete: async () => undefined });

    const jobId = await runner.captureCurrent({ userCategory: '稍后阅读', userTags: ['重点'] });

    expect(jobId).toBe('current-job');
    expect(tabs.created).toEqual([]);
    expect(bridge.sent.at(-1)).toMatchObject({
      type: 'job.result',
      requestId: 'current-job',
      payload: { document: { userCategory: '稍后阅读', userTags: ['重点'] } },
    });
  });
});

describe('list page batch capture', () => {
  function listRunner(): { tabs: InMemoryTabs; bridge: InMemoryBridge; runner: JobRunner; progress: BatchProgress[] } {
    const tabs = new InMemoryTabs();
    tabs.activeTab = { id: 7, url: LIST_URL, status: 'complete' };
    const bridge = new InMemoryBridge();
    const progress: BatchProgress[] = [];
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
      reportBatch: snapshot => progress.push(snapshot),
    });
    return { tabs, bridge, runner, progress };
  }

  it('creates one job per post, each keyed by its own topic URL', async () => {
    const { tabs, bridge, runner } = listRunner();
    tabs.listRounds = [{ documents: [topic('111'), topic('222')], skipped: 1, total: 3 }];
    tabs.advances = [{ collapsed: 3, loaded: 0 }];

    const summary = await runner.captureList({ sinks: ['life-teachers'] });

    // 每条各建各的任务：共用列表页 URL 的话三条会算出同一个内容 ID 相互覆盖。
    expect(bridge.createdFor).toEqual([
      `${LIST_URL}/topic/111`,
      `${LIST_URL}/topic/222`,
    ]);
    const results = bridge.sent.filter(item => item.type === 'job.result');
    expect(results).toHaveLength(2);
    expect(results.map(item => (item.payload as { document: CollectedDocument }).document.canonicalUrl))
      .toEqual([`${LIST_URL}/topic/111`, `${LIST_URL}/topic/222`]);
    expect(new Set(results.map(item => item.requestId)).size).toBe(2);
    expect(summary).toMatchObject({
      url: LIST_URL,
      collected: 2,
      skipped: 1,
      failed: 0,
      rounds: 1,
      phase: 'done',
    });
  });

  it('keeps advancing the feed until a round loads nothing new', async () => {
    const { tabs, runner } = listRunner();
    tabs.listRounds = [
      { documents: [topic('111'), topic('222')], skipped: 0, total: 2 },
      { documents: [topic('333')], skipped: 0, total: 1 },
    ];
    tabs.advances = [{ collapsed: 2, loaded: 1 }, { collapsed: 1, loaded: 0 }];

    const summary = await runner.captureList();

    expect(tabs.asked).toEqual([
      'extract.list',
      'list.advance',
      'extract.list',
      'list.advance',
    ]);
    expect(summary).toMatchObject({ collected: 3, rounds: 2, phase: 'done' });
  });

  it('does not re-archive a post that shows up again in a later round', async () => {
    const { tabs, bridge, runner } = listRunner();
    // 置顶 / 列表刷新会让同一条重复出现在下一轮里。
    tabs.listRounds = [
      { documents: [topic('111')], skipped: 0, total: 1 },
      { documents: [topic('111'), topic('222')], skipped: 0, total: 2 },
    ];
    tabs.advances = [{ collapsed: 1, loaded: 2 }, { collapsed: 2, loaded: 0 }];

    const summary = await runner.captureList();

    expect(bridge.createdFor).toEqual([`${LIST_URL}/topic/111`, `${LIST_URL}/topic/222`]);
    expect(summary).toMatchObject({ collected: 2, failed: 0, phase: 'done' });
  });

  it('counts a failed post and carries on with the rest of the batch (E6)', async () => {
    const { tabs, bridge, runner } = listRunner();
    bridge.failCreateFor = `${LIST_URL}/topic/222`;
    tabs.listRounds = [{ documents: [topic('111'), topic('222'), topic('333')], skipped: 0, total: 3 }];
    tabs.advances = [{ collapsed: 3, loaded: 0 }];

    const summary = await runner.captureList();

    expect(summary).toMatchObject({ collected: 2, failed: 1, phase: 'done' });
    expect(bridge.sent.filter(item => item.type === 'job.result')).toHaveLength(2);
  });

  it('reports live progress so the side panel can count up during a long batch', async () => {
    const { tabs, runner, progress } = listRunner();
    tabs.listRounds = [{ documents: [topic('111'), topic('222')], skipped: 0, total: 2 }];
    tabs.advances = [{ collapsed: 2, loaded: 0 }];

    await runner.captureList();

    expect(progress[0]).toMatchObject({ collected: 0, phase: 'running', url: LIST_URL });
    expect(progress.map(item => item.collected)).toEqual([0, 1, 2, 2]);
    expect(progress.at(-1)).toMatchObject({ collected: 2, phase: 'done' });
  });

  // ── 错误场景矩阵（docs/sidepanel-states.md 第四节）────────────────────

  it('E1: reports CONTENT_SCRIPT_MISSING as a failed batch, never as a finished one', async () => {
    const { tabs, runner, progress } = listRunner();
    tabs.sendMessage = async () => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    };

    const summary = await runner.captureList();

    // 这正是「错误一闪而过就跳到『本轮批量归档完成』」的根因：终态必须是 failed。
    expect(summary.phase).toBe('failed');
    expect(summary.code).toBe('CONTENT_SCRIPT_MISSING');
    expect(summary.error).toContain('重新加载');
    expect(progress.at(-1)).toMatchObject({ phase: 'failed', code: 'CONTENT_SCRIPT_MISSING' });
    // 中途不得出现任何被当成成功的终态。
    expect(progress.some(item => ['done', 'capped', 'stopped'].includes(item.phase))).toBe(false);
  });

  it('E1 自愈: reloads the tab first, then collects', async () => {
    const { tabs, runner } = listRunner();
    tabs.listRounds = [{ documents: [topic('111')], skipped: 0, total: 1 }];
    tabs.advances = [{ collapsed: 1, loaded: 0 }];

    const summary = await runner.captureList({}, { reloadFirst: true });

    // 用户不该被要求「自己按 F5」——插件自己重载页面再跑。
    expect(tabs.reloaded).toEqual([7]);
    expect(summary).toMatchObject({ collected: 1, phase: 'done' });
  });

  it('E2: passes an extractor error (login wall) straight through', async () => {
    const { tabs, runner } = listRunner();
    tabs.sendMessage = async () => ({
      ok: false as const,
      error: { code: 'AUTH_REQUIRED', message: '请先登录知识星球' },
    });

    const summary = await runner.captureList();

    expect(summary).toMatchObject({ phase: 'failed', code: 'AUTH_REQUIRED' });
    expect(summary.error).toContain('登录');
  });

  it('E3: an empty feed is reported as empty, not as done', async () => {
    const { tabs, runner } = listRunner();
    tabs.listRounds = [{ documents: [], skipped: 0, total: 0 }];

    const summary = await runner.captureList();

    expect(summary).toMatchObject({ phase: 'empty', collected: 0 });
  });

  it('E4: posts found but none addressable is reported as skipped_all', async () => {
    const { tabs, runner } = listRunner();
    tabs.listRounds = [{ documents: [], skipped: 21, total: 21 }];

    const summary = await runner.captureList();

    // 21 条全跳过不是「完成」，是需要修 DOM 适配。
    expect(summary).toMatchObject({ phase: 'skipped_all', collected: 0, skipped: 21 });
  });

  it('E5: a dead Bridge ends the batch instead of failing every remaining post', async () => {
    const { tabs, bridge, runner } = listRunner();
    tabs.listRounds = [{
      documents: [topic('111'), topic('222'), topic('333')],
      skipped: 0,
      total: 3,
    }];
    bridge.createJob = async (url: string) => {
      bridge.createdFor.push(url);
      if (bridge.createdFor.length > 1) throw new Error('Failed to fetch');
      return { id: 'job-1' };
    };

    const summary = await runner.captureList();

    expect(summary).toMatchObject({ phase: 'failed', code: 'BRIDGE_UNAVAILABLE', collected: 1 });
    // 不再对剩下的每一条重试，避免刷一屏失败。
    expect(bridge.createdFor).toHaveLength(2);
  });

  it('E7: stopping mid-batch keeps what was collected and says so', async () => {
    const { tabs, bridge, runner } = listRunner();
    tabs.listRounds = [{ documents: [topic('111'), topic('222')], skipped: 0, total: 2 }];
    const original = bridge.createJob.bind(bridge);
    bridge.createJob = async (url: string) => {
      const job = await original(url);
      runner.stopBatch();
      return job;
    };

    const summary = await runner.captureList();

    expect(summary).toMatchObject({ phase: 'stopped', collected: 1 });
    expect(tabs.asked).toEqual(['extract.list']);
  });

  it('E9: hitting the item cap is disclosed, not silently truncated', async () => {
    const { tabs, runner } = listRunner();
    tabs.listRounds = [{ documents: [topic('111'), topic('222'), topic('333')], skipped: 0, total: 3 }];

    const summary = await runner.captureList({}, { maxItems: 2 });

    expect(summary).toMatchObject({ collected: 2, phase: 'capped' });
    // 到顶就收工，不再翻页。
    expect(tabs.asked).toEqual(['extract.list']);
  });

  it('E10: no collectable tab throws so the panel shows a sticky local error', async () => {
    const { tabs, runner } = listRunner();
    tabs.activeTab = { id: undefined, url: undefined };

    await expect(runner.captureList()).rejects.toThrow('没有可采集的浏览器页面');
  });

  it('exports a DOM sample for adaptation instead of asking the user to run console scripts', async () => {
    const { tabs, runner } = listRunner();
    tabs.sendMessage = async () => ({ ok: true as const, diagnostics: '{"topicCount":21}' });

    expect(await runner.diagnoseList()).toBe('{"topicCount":21}');
  });
});

function backgroundChromeMock(withSidePanel: boolean) {
  const installedListeners: Array<() => void> = [];
  const startupListeners: Array<() => void> = [];
  const messageListeners: Array<(
    message: unknown,
    sender: unknown,
    sendResponse: (response: unknown) => void,
  ) => boolean> = [];
  const alarmListeners: Array<(alarm: { name: string }) => void> = [];
  const setPanelBehavior = vi.fn(async () => undefined);
  const chromeMock = {
    runtime: {
      id: TRUSTED_EXTENSION_ID,
      onInstalled: { addListener: vi.fn((listener: () => void) => installedListeners.push(listener)) },
      onStartup: { addListener: vi.fn((listener: () => void) => startupListeners.push(listener)) },
      onMessage: {
        addListener: vi.fn((listener: typeof messageListeners[number]) => messageListeners.push(listener)),
      },
    },
    storage: {
      local: {
        get: vi.fn(async () => ({ bridgeToken: 'x'.repeat(43), bridgePort: 17321 })),
        set: vi.fn(async () => undefined),
      },
    },
    tabs: {
      create: vi.fn(),
      remove: vi.fn(),
      update: vi.fn(),
      query: vi.fn(async () => []),
      sendMessage: vi.fn(),
      get: vi.fn(),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    alarms: {
      create: vi.fn(async () => undefined),
      onAlarm: { addListener: vi.fn((listener: typeof alarmListeners[number]) => alarmListeners.push(listener)) },
    },
    ...(withSidePanel ? { sidePanel: { setPanelBehavior } } : {}),
  };
  return {
    chromeMock,
    installedListeners,
    startupListeners,
    messageListeners,
    setPanelBehavior,
  };
}

class BackgroundSocket {
  readyState = 0;

  addEventListener(): void {}
  send(): void {}
  close(): void { this.readyState = 3; }
}

describe('background bootstrap', () => {
  it('configures toolbar action opening at initialization, install, and startup', async () => {
    vi.resetModules();
    const mock = backgroundChromeMock(true);
    vi.stubGlobal('chrome', mock.chromeMock);
    vi.stubGlobal('WebSocket', BackgroundSocket);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>());

    await import('../../packages/extension/src/background/index.js');
    expect(mock.setPanelBehavior).toHaveBeenCalledTimes(1);
    expect(mock.setPanelBehavior).toHaveBeenLastCalledWith({ openPanelOnActionClick: true });

    mock.installedListeners[0]!();
    mock.startupListeners[0]!();
    expect(mock.setPanelBehavior).toHaveBeenCalledTimes(3);
  });

  it('guards missing Side Panel API and no longer accepts manual pairing messages', async () => {
    vi.resetModules();
    const mock = backgroundChromeMock(false);
    vi.stubGlobal('chrome', mock.chromeMock);
    vi.stubGlobal('WebSocket', BackgroundSocket);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>());

    await expect(import('../../packages/extension/src/background/index.js')).resolves.toBeDefined();
    expect(() => mock.installedListeners[0]!()).not.toThrow();
    expect(() => mock.startupListeners[0]!()).not.toThrow();

    const response = vi.fn();
    expect(mock.messageListeners[0]!({ type: ['pair', 'submit'].join('.'), code: '123456' }, {}, response)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(response).toHaveBeenCalledWith({ ok: false, error: '不支持的扩展操作' });
  });
});
