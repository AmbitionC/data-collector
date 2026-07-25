import { parseSupportedUrl, type CollectedDocument } from '@data-collector/shared';

export interface BrowserTab {
  id?: number;
  url?: string;
  status?: string;
}

/** 列表页一轮提取的结果（内容脚本已剥掉无法跨消息边界传递的 DOM 节点）。 */
export interface ListPayload {
  documents: CollectedDocument[];
  skipped: number;
  total: number;
}

export type ExtractionResponse =
  | { ok: true; document: CollectedDocument }
  | { ok: true; list: ListPayload }
  | { ok: true; advance: { collapsed: number; loaded: number } }
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
    overrides?: { userCategory?: string; userTags?: string[]; sinks?: string[] },
  ): Promise<{ id: string }>;
}

interface PayloadMap {
  document: CollectedDocument;
  list: ListPayload;
  advance: { collapsed: number; loaded: number };
}

/** 按请求类型取出应答载荷；字段对不上说明页面里的内容脚本还是旧版本。 */
function payloadOf<K extends keyof PayloadMap>(
  response: ExtractionResponse,
  key: K,
): PayloadMap[K] {
  const value = (response as Record<string, unknown>)[key];
  if (value === undefined) throw new Error('页面脚本与扩展版本不一致，请刷新本页后重试');
  return value as PayloadMap[K];
}

/** 批量采集的实时进度，侧栏据此显示「已保存 N 条」。 */
export interface BatchProgress {
  /** 触发批量采集的列表页地址（侧栏只在同一页面展示这份进度）。 */
  url: string;
  collected: number;
  skipped: number;
  failed: number;
  rounds: number;
  running: boolean;
  /** 最后一次进度更新时刻；Service Worker 中途被回收时，侧栏据此判定这批已经断了。 */
  updatedAt: number;
}

export interface JobRunnerOptions {
  tabs: TabsApi;
  bridge: BridgeClient;
  waitForTabComplete: (tabId: number, timeoutMs?: number) => Promise<void>;
  /** 可注入的延时（测试用）；缺省用 setTimeout。 */
  delay?: (ms: number) => Promise<void>;
  /** 批量采集的进度回调（写入 storage 供侧栏轮询）。 */
  reportBatch?: (progress: BatchProgress) => void;
}

/** 内容脚本在标签页 complete 后可能仍未注册消息监听，这类错误可短暂重试。 */
function isContentScriptNotReady(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Receiving end does not exist|Could not establish connection/i.test(message);
}

export interface CaptureOverrides {
  userCategory?: string;
  userTags?: string[];
  /** 用户为本次采集选定的落地去向（sink id）；缺省按来源默认路由。 */
  sinks?: string[];
}

const NEEDS_ATTENTION = new Set(['AUTH_REQUIRED', 'UNSUPPORTED_LAYOUT']);

export class JobRunner {
  private remoteQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: JobRunnerOptions) {}

  private wait(ms: number): Promise<void> {
    return this.options.delay ? this.options.delay(ms) : new Promise(resolve => setTimeout(resolve, ms));
  }

  /** 向内容脚本发消息；内容脚本尚未就绪时短暂重试（最多 4 次）。 */
  private async ask(tabId: number, message: unknown): Promise<ExtractionResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.options.tabs.sendMessage(tabId, message);
      } catch (error) {
        if (!isContentScriptNotReady(error) || attempt === 3) throw error;
        lastError = error;
        await this.wait(150);
      }
    }
    throw lastError;
  }

  private extractWithRetry(
    tabId: number,
    overrides?: CaptureOverrides,
  ): Promise<ExtractionResponse> {
    return this.ask(tabId, {
      type: 'extract.document',
      ...(overrides ? { overrides } : {}),
    });
  }

  async runRemoteJob(requestId: string, rawUrl: string): Promise<void> {
    const result = this.remoteQueue.then(() => this.runRemoteJobNow(requestId, rawUrl));
    this.remoteQueue = result.catch(() => undefined);
    return result;
  }

  private async runRemoteJobNow(requestId: string, rawUrl: string): Promise<void> {
    let tabId: number | undefined;
    let keepTab = false;
    try {
      const url = parseSupportedUrl(rawUrl).href;
      const tab = await this.options.tabs.create({ url, active: false });
      if (tab.id === undefined) throw new Error('浏览器未返回新标签页 ID');
      tabId = tab.id;
      await this.options.waitForTabComplete(tabId, 30_000);
      this.options.bridge.send('job.progress', requestId, { stage: 'collecting' });
      const response = await this.extractWithRetry(tabId);
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
      this.options.bridge.send('job.result', requestId, {
        document: payloadOf(response, 'document'),
      });
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
    let response: ExtractionResponse;
    try {
      response = await this.extractWithRetry(tab.id, overrides);
    } catch (error) {
      // 内容脚本不在该标签页（常见于扩展刚安装/重载，而标签页是之前打开的）。
      // 必须显式回报，否则任务会永远停在 collecting，侧栏一直显示「清理正文」。
      const notReady = isContentScriptNotReady(error);
      this.options.bridge.send('job.error', job.id, {
        code: notReady ? 'CONTENT_SCRIPT_MISSING' : 'COLLECTION_FAILED',
        message: notReady
          ? '页面脚本未就绪：扩展安装或更新后，已打开的标签页需要刷新一次。请按 F5 刷新本页再保存。'
          : error instanceof Error
            ? error.message
            : '浏览器采集失败',
        needsAttention: notReady,
      });
      return job.id;
    }
    if (!response.ok) {
      this.options.bridge.send('job.error', job.id, {
        code: response.error.code,
        message: response.error.message,
        needsAttention: NEEDS_ATTENTION.has(response.error.code),
      });
      return job.id;
    }
    const document: CollectedDocument = {
      ...payloadOf(response, 'document'),
      ...(overrides.userCategory ? { userCategory: overrides.userCategory } : {}),
      ...(overrides.userTags ? { userTags: overrides.userTags } : {}),
    };
    this.options.bridge.send('job.result', job.id, { document });
    return job.id;
  }

  /**
   * 列表 / 精华页批量采集：把当前页上的每条帖子各建一个任务入库。
   *
   * 每条帖子必须带自己的详情 URL —— 稳定内容 ID 由规范 URL 派生，
   * 都用列表页 URL 的话 21 条会算出同一个 ID 相互覆盖，最后只剩 1 条。
   *
   * 一轮 = 提取本屏 → 逐条入库 → 收起已处理的帖子并滚到底加载下一批。
   * 收起是关键：知识星球列表是滚到底懒加载，不把处理过的收走，
   * 下一轮还会把同样的帖子再提取一遍，永远推进不到新内容。
   */
  async captureList(
    overrides: CaptureOverrides = {},
    limits: { maxRounds?: number; maxItems?: number } = {},
  ): Promise<BatchProgress> {
    const [tab] = await this.options.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id === undefined || !tab.url) throw new Error('当前没有可采集的浏览器页面');
    const tabId = tab.id;
    const maxRounds = limits.maxRounds ?? 12;
    const maxItems = limits.maxItems ?? 60;
    const progress: BatchProgress = {
      url: tab.url,
      collected: 0,
      skipped: 0,
      failed: 0,
      rounds: 0,
      running: true,
      updatedAt: Date.now(),
    };
    const report = () => {
      progress.updatedAt = Date.now();
      this.options.reportBatch?.({ ...progress });
    };
    // 同一条在两轮里重复出现（列表刷新、置顶）时不重复建任务。
    const seen = new Set<string>();
    report();

    try {
      for (let round = 0; round < maxRounds; round += 1) {
        const response = await this.ask(tabId, { type: 'extract.list' }).catch(error => {
          // 扩展刚安装/更新时，之前打开的标签页里没有内容脚本——说清楚怎么办，别抛底层报错。
          if (isContentScriptNotReady(error)) {
            throw new Error('页面脚本未就绪：扩展安装或更新后，已打开的标签页需要刷新一次。请按 F5 刷新本页再批量保存。');
          }
          throw error;
        });
        if (!response.ok) throw new Error(response.error.message);
        const list = payloadOf(response, 'list');
        progress.rounds = round + 1;
        progress.skipped += list.skipped;

        for (const document of list.documents) {
          if (progress.collected >= maxItems) break;
          if (seen.has(document.canonicalUrl)) continue;
          seen.add(document.canonicalUrl);
          if (await this.saveCollected(document, overrides)) progress.collected += 1;
          else progress.failed += 1;
          report();
        }
        if (progress.collected >= maxItems) break;

        const advanced = await this.ask(tabId, { type: 'list.advance' });
        if (!advanced.ok) break;
        if (payloadOf(advanced, 'advance').loaded === 0) break;
        report();
      }
    } finally {
      progress.running = false;
      report();
    }
    return { ...progress };
  }

  /** 已经提取好的一篇：建任务 → 直接回传结果（内容已在手，无需再开标签页）。 */
  private async saveCollected(
    document: CollectedDocument,
    overrides: CaptureOverrides,
  ): Promise<boolean> {
    try {
      const job = await this.options.bridge.createJob(document.canonicalUrl, overrides);
      this.options.bridge.send('job.progress', job.id, { stage: 'collecting' });
      this.options.bridge.send('job.result', job.id, {
        document: {
          ...document,
          ...(overrides.userCategory ? { userCategory: overrides.userCategory } : {}),
          ...(overrides.userTags ? { userTags: overrides.userTags } : {}),
        },
      });
      return true;
    } catch {
      // 单条失败不该中断整批：计入 failed，继续下一条。
      return false;
    }
  }
}
