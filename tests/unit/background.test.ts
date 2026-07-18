import { describe, expect, it } from 'vitest';
import type { CollectedDocument } from '@data-collector/shared';
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
