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
  /** 已捕获到的帖子号条数；为 0 说明还没截到应用的接口响应。 */
  captured?: number;
}

export type ExtractionResponse =
  | { ok: true; document: CollectedDocument }
  | { ok: true; list: ListPayload }
  | { ok: true; advance: { collapsed: number; loaded: number } }
  | { ok: true; diagnostics: string }
  | { ok: false; error: { code: string; message: string } };

export interface TabsApi {
  create(input: { url: string; active: boolean }): Promise<BrowserTab>;
  remove(id: number): Promise<void>;
  update(id: number, input: { active: boolean }): Promise<void>;
  query(input?: unknown): Promise<BrowserTab[]>;
  sendMessage(id: number, message: unknown): Promise<ExtractionResponse>;
  /**
   * 把内容脚本注入到已打开的标签页。
   *
   * 绝不能改用「重新加载页面」来自愈：知识星球的分类（精华 / 最新）是应用内状态，
   * 刷新会退回默认的「最新」，用户在精华页发起的采集就采成了别的内容。
   * 注入不动页面状态。
   */
  inject(id: number): Promise<void>;
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
  diagnostics: string;
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

/**
 * 批量采集的终态。**「结束」不等于「完成」**：异常中止、一条没采到、全部跳过
 * 都必须和正常跑完区分开，否则侧栏会把失败汇报成成功（见 docs/sidepanel-states.md）。
 */
export type BatchPhase =
  | 'running'
  | 'done'
  | 'capped'
  | 'stopped'
  | 'empty'
  | 'skipped_all'
  | 'failed';

/** 批量采集记录：既是实时进度，也是终态与失败原因的唯一真相源。 */
export interface BatchProgress {
  /** 触发批量采集的列表页地址（侧栏只在同一页面展示这份进度）。 */
  url: string;
  collected: number;
  skipped: number;
  failed: number;
  rounds: number;
  phase: BatchPhase;
  /** 失败原因（phase 为 failed 时必有），直接展示给用户。 */
  error?: string;
  /** 失败分类，决定侧栏给哪种出路按钮（如 CONTENT_SCRIPT_MISSING → 刷新页面并重试）。 */
  code?: string;
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
  private batchStopped = false;

  constructor(private readonly options: JobRunnerOptions) {}

  private wait(ms: number): Promise<void> {
    return this.options.delay ? this.options.delay(ms) : new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 向内容脚本发消息；内容脚本尚未就绪时短暂重试（最多 4 次），
   * 并在中途补注入一次——插件更新后已打开的标签页里没有内容脚本，
   * 注入即可自愈，不必刷新页面（刷新会丢掉「精华」这类应用内分类状态）。
   */
  private async ask(tabId: number, message: unknown): Promise<ExtractionResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.options.tabs.sendMessage(tabId, message);
      } catch (error) {
        if (!isContentScriptNotReady(error) || attempt === 3) throw error;
        lastError = error;
        if (attempt === 0) {
          try {
            await this.options.tabs.inject(tabId);
          } catch {
            // 注入失败（如页面不在允许的站点）就按原来的重试节奏继续。
          }
        }
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
  /** 用户点了「停止」：在条与条、轮与轮之间检查，尽快收尾并如实汇报已入库条数。 */
  stopBatch(): void {
    this.batchStopped = true;
  }

  /** 采不到各自链接时（E4），取一份页面结构样本供适配排查。 */
  async diagnoseList(): Promise<string> {
    const [tab] = await this.options.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id === undefined) throw new Error('当前没有可诊断的浏览器页面');
    const response = await this.ask(tab.id, { type: 'list.diagnose' });
    if (!response.ok) throw new Error(response.error.message);
    return payloadOf(response, 'diagnostics');
  }

  /**
   * 把页面还原成用户原本看到的样子（撤销所有折叠）。
   * 失败静默：还原只是善后，不该让它盖过真正的失败原因。
   */
  private async restorePage(tabId: number): Promise<void> {
    try {
      await this.options.tabs.sendMessage(tabId, { type: 'list.restore' });
    } catch {
      // 页面已关闭或脚本不在，无需处理。
    }
  }

  async captureList(
    overrides: CaptureOverrides = {},
    limits: { maxRounds?: number; maxItems?: number; continuation?: boolean } = {},
  ): Promise<BatchProgress> {
    const [tab] = await this.options.tabs.query({ active: true, lastFocusedWindow: true });
    // E10：连可采集的标签页都没有，写不出归属某页的记录，交给侧栏的本地粘性错误。
    if (tab?.id === undefined || !tab.url) throw new Error('当前没有可采集的浏览器页面');
    const tabId = tab.id;
    const maxRounds = limits.maxRounds ?? 12;
    const maxItems = limits.maxItems ?? 60;
    this.batchStopped = false;
    const progress: BatchProgress = {
      url: tab.url,
      collected: 0,
      skipped: 0,
      failed: 0,
      rounds: 0,
      phase: 'running',
      updatedAt: Date.now(),
    };
    const report = () => {
      progress.updatedAt = Date.now();
      this.options.reportBatch?.({ ...progress });
    };
    const fail = async (code: string, message: string): Promise<BatchProgress> => {
      // 一条都没采到就把页面还原：绝不能让用户的星球主页凭空少掉一屏内容。
      if (progress.collected === 0) await this.restorePage(tabId);
      progress.phase = 'failed';
      progress.code = code;
      progress.error = message;
      report();
      return { ...progress };
    };
    // 同一条在两轮里重复出现（列表刷新、置顶）时不重复建任务。
    const seen = new Set<string>();
    report();

    // 新开一批时先把上一批的折叠标记全部撤销，让页面回到用户看到的完整状态；
    // 「继续采下一批」是续采，保留标记才能跳过已经采过的。
    if (!limits.continuation) await this.restorePage(tabId);

    let sawAnyPost = false;
    let captured = 0;
    for (let round = 0; round < maxRounds; round += 1) {
      let response: ExtractionResponse;
      try {
        response = await this.ask(tabId, { type: 'extract.list' });
      } catch (error) {
        // E1：扩展刚安装/更新时，之前打开的标签页里没有内容脚本。
        if (isContentScriptNotReady(error)) {
          return await fail(
            'CONTENT_SCRIPT_MISSING',
            '页面脚本未就绪，且自动注入没有成功。请在插件管理页确认 Data Collector 已启用后重试。',
          );
        }
        return await fail(
          'COLLECTION_FAILED',
          error instanceof Error ? error.message : '读取本页帖子失败',
        );
      }
      if (!response.ok) {
        // E2 等提取器给出的明确原因（未登录、结构不支持）原样透传。
        return await fail(response.error.code, response.error.message);
      }
      const list = payloadOf(response, 'list');
      progress.rounds = round + 1;
      progress.skipped += list.skipped;
      if (list.total > 0) sawAnyPost = true;
      captured = Math.max(captured, list.captured ?? 0);

      for (const document of list.documents) {
        if (this.batchStopped) break;
        if (progress.collected >= maxItems) break;
        if (seen.has(document.canonicalUrl)) continue;
        seen.add(document.canonicalUrl);
        const saved = await this.saveCollected(document, overrides);
        if (saved === 'ok') progress.collected += 1;
        else if (saved === 'bridge-down') {
          // E5：本机服务断了，后面每条都会失败，立刻收尾而不是刷一屏失败。
          return await fail('BRIDGE_UNAVAILABLE', '本机服务无响应，本批已中断。');
        } else progress.failed += 1;
        report();
      }

      if (this.batchStopped) {
        progress.phase = 'stopped';
        report();
        return { ...progress };
      }
      if (progress.collected >= maxItems) {
        // E9：到顶要说出来，不能静默截断。
        progress.phase = 'capped';
        report();
        return { ...progress };
      }

      const advanced = await this.ask(tabId, { type: 'list.advance' }).catch(() => undefined);
      if (!advanced?.ok || payloadOf(advanced, 'advance').loaded === 0) break;
      report();
    }

    // 零产出（没找到帖子 / 全部无法定位）同样要把页面还原。
    if (progress.collected === 0) await this.restorePage(tabId);
    // E3 / E4：跑完了但没有产出，都不是「完成」。
    progress.phase = !sawAnyPost
      ? 'empty'
      : progress.collected === 0 && progress.skipped > 0
        ? 'skipped_all'
        : progress.rounds >= maxRounds && progress.collected >= maxItems
          ? 'capped'
          : 'done';
    if (progress.phase === 'skipped_all') {
      // 区分两种「全部跳过」：还没截到接口响应（用户能自己解决），
      // 还是截到了但对不上号（需要我改适配）。
      progress.error = captured === 0
        ? '还没有截到本页的接口响应，因而拿不到每条帖子的地址。请在页面里滚动一屏、或把分类切走再切回来，然后重试。'
        : `已获取 ${captured} 条帖子号，但和页面上的帖子对不上号。请复制诊断信息发给开发者。`;
      progress.code = captured === 0 ? 'TOPIC_INDEX_EMPTY' : 'TOPIC_INDEX_MISMATCH';
    }
    report();
    return { ...progress };
  }

  /**
   * 已经提取好的一篇：建任务 → 直接回传结果（内容已在手，无需再开标签页）。
   * 区分「这一条不行」和「本机服务不行」：前者继续下一条，后者立刻收尾。
   */
  private async saveCollected(
    document: CollectedDocument,
    overrides: CaptureOverrides,
  ): Promise<'ok' | 'failed' | 'bridge-down'> {
    let job: { id: string };
    try {
      job = await this.options.bridge.createJob(document.canonicalUrl, overrides);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      // 只有「连不上 / 没授权」才是整条链路的问题，值得中断整批；
      // 服务端 5xx 更可能是这一条内容的问题，计入失败继续下一条。
      return /Failed to fetch|NetworkError|未连接|仍在自动连接|HTTP 40[13]/i.test(message)
        ? 'bridge-down'
        : 'failed';
    }
    try {
      this.options.bridge.send('job.progress', job.id, { stage: 'collecting' });
      this.options.bridge.send('job.result', job.id, {
        document: {
          ...document,
          ...(overrides.userCategory ? { userCategory: overrides.userCategory } : {}),
          ...(overrides.userTags ? { userTags: overrides.userTags } : {}),
        },
      });
      return 'ok';
    } catch {
      // WebSocket 断了，后面每条都会一样失败。
      return 'bridge-down';
    }
  }
}
