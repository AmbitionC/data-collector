import { describe, expect, it, vi } from 'vitest';
import { TRUSTED_EXTENSION_ID, type CollectedDocument } from '@data-collector/shared';
import {
  JobRunner,
  type BridgeClient,
  type BrowserTab,
  type TabsApi,
} from '../../packages/extension/src/background/jobs.js';

const URL = 'https://mp.weixin.qq.com/s/background-test';

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

class InMemoryTabs implements TabsApi {
  readonly created: Array<{ url: string; active: boolean }> = [];
  readonly removed: number[] = [];
  readonly updated: Array<{ id: number; active: boolean }> = [];
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

  async sendMessage(): Promise<Awaited<ReturnType<TabsApi['sendMessage']>>> {
    return this.response;
  }
}

class InMemoryBridge implements BridgeClient {
  readonly sent: Array<{ type: string; requestId: string; payload: unknown }> = [];
  createdJobId = 'current-job';

  send(type: string, requestId: string, payload: unknown): void {
    this.sent.push({ type, requestId, payload });
  }

  async createJob(): Promise<{ id: string }> {
    return { id: this.createdJobId };
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
