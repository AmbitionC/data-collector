import { parseSupportedUrl, type CollectedDocument } from '@data-collector/shared';

export interface BrowserTab {
  id?: number;
  url?: string;
  status?: string;
}

export type ExtractionResponse =
  | { ok: true; document: CollectedDocument }
  | { ok: false; error: { code: string; message: string } };

export interface TabsApi {
  create(input: { url: string; active: boolean }): Promise<BrowserTab>;
  remove(id: number): Promise<void>;
  update(id: number, input: { active: boolean }): Promise<void>;
  query(input?: unknown): Promise<BrowserTab[]>;
  sendMessage(id: number, message: unknown): Promise<ExtractionResponse>;
}

export interface BridgeClient {
  send(type: string, requestId: string, payload: unknown): void;
  createJob(
    url: string,
    overrides?: { userCategory?: string; userTags?: string[] },
  ): Promise<{ id: string }>;
}

export interface JobRunnerOptions {
  tabs: TabsApi;
  bridge: BridgeClient;
  waitForTabComplete: (tabId: number, timeoutMs?: number) => Promise<void>;
}

export interface CaptureOverrides {
  userCategory?: string;
  userTags?: string[];
}

const NEEDS_ATTENTION = new Set(['AUTH_REQUIRED', 'UNSUPPORTED_LAYOUT']);

export class JobRunner {
  constructor(private readonly options: JobRunnerOptions) {}

  async runRemoteJob(requestId: string, rawUrl: string): Promise<void> {
    let tabId: number | undefined;
    let keepTab = false;
    try {
      const url = parseSupportedUrl(rawUrl).href;
      const tab = await this.options.tabs.create({ url, active: false });
      if (tab.id === undefined) throw new Error('浏览器未返回新标签页 ID');
      tabId = tab.id;
      await this.options.waitForTabComplete(tabId, 30_000);
      this.options.bridge.send('job.progress', requestId, { stage: 'collecting' });
      const response = await this.options.tabs.sendMessage(tabId, { type: 'extract.document' });
      if (!response.ok) {
        keepTab = NEEDS_ATTENTION.has(response.error.code);
        if (keepTab) await this.options.tabs.update(tabId, { active: true });
        this.options.bridge.send('job.error', requestId, {
          code: response.error.code,
          message: response.error.message,
          needsAttention: keepTab,
        });
        return;
      }
      this.options.bridge.send('job.result', requestId, { document: response.document });
    } catch (error) {
      this.options.bridge.send('job.error', requestId, {
        code: error instanceof Error && error.message.includes('不支持的采集地址')
          ? 'UNSUPPORTED_URL'
          : 'COLLECTION_FAILED',
        message: error instanceof Error ? error.message : '浏览器采集失败',
        needsAttention: false,
      });
    } finally {
      if (tabId !== undefined && !keepTab) await this.options.tabs.remove(tabId);
    }
  }

  async captureCurrent(overrides: CaptureOverrides = {}): Promise<string> {
    const [tab] = await this.options.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id === undefined || !tab.url) throw new Error('当前没有可采集的浏览器页面');
    const url = parseSupportedUrl(tab.url).href;
    const job = await this.options.bridge.createJob(url, overrides);
    this.options.bridge.send('job.progress', job.id, { stage: 'collecting' });
    const response = await this.options.tabs.sendMessage(tab.id, {
      type: 'extract.document',
      overrides,
    });
    if (!response.ok) {
      this.options.bridge.send('job.error', job.id, {
        code: response.error.code,
        message: response.error.message,
        needsAttention: NEEDS_ATTENTION.has(response.error.code),
      });
      return job.id;
    }
    const document: CollectedDocument = {
      ...response.document,
      ...(overrides.userCategory ? { userCategory: overrides.userCategory } : {}),
      ...(overrides.userTags ? { userTags: overrides.userTags } : {}),
    };
    this.options.bridge.send('job.result', job.id, { document });
    return job.id;
  }
}
