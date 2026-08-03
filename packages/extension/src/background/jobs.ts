import { parseSupportedUrl, type CollectedDocument } from '@data-collector/shared';
import { linkedArticleUrl } from '../extractors/index.js';
import type { HookStats } from '../topicIndex.js';

export interface BrowserTab {
  id?: number;
  url?: string;
  status?: string;
}

/** 列表页一轮里的一条帖子（内容脚本已剥掉无法跨消息边界传递的 DOM 节点）。 */
export interface ListItem {
  /** 稳定标识，侧栏点它就能滚回页面上的那一条并高亮。 */
  key: string;
  title: string;
  document?: CollectedDocument;
  /** 无法采集的原因。 */
  reason?: string;
}

export interface ListPayload {
  items: ListItem[];
  skipped: number;
  total: number;
  /** 已捕获到的帖子号条数；为 0 说明还没截到应用的接口响应。 */
  captured?: number;
}

/** 逐条结果：侧栏的「本轮明细」列表就是它，用户据此逐条核对。 */
export interface BatchItem {
  key: string;
  title: string;
  status: 'saved' | 'skipped' | 'failed';
  /** 跳过 / 失败的原因。 */
  reason?: string;
  url?: string;
}

export type ExtractionResponse =
  | { ok: true; document: CollectedDocument }
  | { ok: true; list: ListPayload }
  | { ok: true; advance: { collapsed: number; loaded: number; scroll?: string } }
  | { ok: true; diagnostics: string }
  | { ok: true; highlight: { found: boolean } }
  | { ok: true; hook: HookStats }
  | { ok: true; refresh: { toggled: boolean; category?: string } }
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
  /** scroll：这一轮到底滚了哪个元素、位移多少，写进运行记录用。 */
  advance: { collapsed: number; loaded: number; scroll?: string };
  diagnostics: string;
  highlight: { found: boolean };
  hook: HookStats;
  refresh: { toggled: boolean; category?: string };
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
  /**
   * 排查用的运行记录：每一轮看到多少、采了多少、滚动有没有加载出新内容。
   * 批量是个多轮的长流程，出问题时没有这个就只能靠猜。
   */
  log: string[];
}

export interface JobRunnerOptions {
  tabs: TabsApi;
  bridge: BridgeClient;
  waitForTabComplete: (tabId: number, timeoutMs?: number) => Promise<void>;
  /** 可注入的延时（测试用）；缺省用 setTimeout。 */
  delay?: (ms: number) => Promise<void>;
  /** 批量采集的进度回调（写入 storage 供侧栏轮询）。 */
  reportBatch?: (progress: BatchProgress) => void;
  /** 逐条结果回调（写入 storage 供侧栏的「本轮明细」列表使用）。 */
  reportItems?: (items: BatchItem[]) => void;
  /**
   * 本机库里已有内容的规范地址。
   *
   * **本机库是唯一的去重依据**，可采集端原先根本不知道库里有什么——
   * 页面上的「已处理」标记只活在那一个没刷新过的标签页里，刷新一次、
   * 扩展重载一次就清零，于是整屏又从头采一遍（实测：同一批 topic id 采了四轮）。
   * 目标条数也因此被旧内容吃满，永远推进不到新帖子。
   *
   * 取不到时按空集合处理：宁可重复采一遍，也不能因为查不到库就不采。
   */
  knownUrls?: () => Promise<ReadonlySet<string>>;
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

  /**
   * 帖子只是导语时，把它引用的长文正文取回来接上。
   *
   * 星球的长文帖在信息流里只有一段引子加一个 `articles.zsxq.com` 链接——实测 77 条
   * 投递里 54 条（70%）是这形态，其中 43 条正文不足 400 字，归档侧拿到的基本是空壳。
   * 长文页是单页应用，接口还要登录态，所以只能开一个后台标签页让内容脚本去读。
   *
   * 取不到就**原样保留导语**：长文没抓到不该让整条采集失败。
   */
  private async withLinkedArticle(document: CollectedDocument): Promise<CollectedDocument> {
    const articleUrl = linkedArticleUrl(document.html);
    if (!articleUrl) return document;
    let tabId: number | undefined;
    try {
      const tab = await this.options.tabs.create({ url: articleUrl, active: false });
      if (tab.id === undefined) return document;
      tabId = tab.id;
      await this.options.waitForTabComplete(tabId, 30_000);
      /*
       * **轮询重试，别只等一次。**
       *
       * 长文页是单页应用，正文要等接口回来才渲染。原先固定等 1200ms 读一次，
       * 没渲染完就放弃——实测 121 条里有 6 条这么丢了。而拿那 6 个 URL 手动 curl，
       * 返回的是和成功那些**一模一样的 1437 字节壳**：不是页面形态不同、更不是权限，
       * 就是那一刻还没渲染完。它们在信息流里相邻，所以看着像「成对失败」。
       */
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await this.wait(900 + attempt * 800);
        const response = await this.ask(tabId, { type: 'extract.document' });
        if (!response.ok) continue;
        const article = payloadOf(response, 'document');
        if (article.text.length <= document.text.length) continue;
        return {
          ...document,
          // 导语留着（有时交代了背景），长文正文接在后面。
          html: `${document.html}\n<hr />\n${article.html}`,
          text: `${document.text}\n\n${article.text}`,
          images: [...document.images, ...article.images],
          // 全文补上了，这条就不再是截断的。
          truncated: false,
        };
      }
      return document;
    } catch {
      return document;
    } finally {
      if (tabId !== undefined) await this.options.tabs.remove(tabId).catch(() => undefined);
    }
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
      // 单条采集同样要补长文：按 URL 定向重采（收件箱那 48 条）走的就是这条路。
      this.options.bridge.send('job.result', requestId, {
        document: await this.withLinkedArticle(payloadOf(response, 'document')),
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
          // 绝不建议刷新：刷新会把知识星球的「精华」退回「最新」，采到的就不是用户要的内容。
          // 自动补注入已经试过并失败，所以这里只剩「确认扩展启用后重试」这一条路。
          ? '页面脚本未就绪，且自动注入没有成功。请在 edge://extensions 确认 Data Collector 已启用后重试；不必刷新页面。'
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
   * 一轮 = 提取本屏 → 逐条入库 → 拟人滚动到底触发懒加载，把下一批带出来。
   * 处理过的帖子只打一个**不可见**的属性标记（绝不 display:none —— 用户要能肉眼核对
   * 采到的内容），下一轮靠这个标记跳过，不会把同一条重复提取。
   */
  /**
   * 批量收尾时把页面停在采到的最后一条上。
   *
   * 不停在那儿的话，用户看不到进度到哪儿了；更要命的是「继续采下一批」会从视口
   * 当前位置往下滚——页面有几万像素高，从中间滚几千像素永远到不了底，
   * 懒加载于是永远不触发，表现就是「滚动到底也没有加载新内容」而页面其实没到底。
   * 尽力而为，失败不影响任何结论。
   */
  private async focusLast(tabId: number): Promise<void> {
    await this.ask(tabId, { type: 'list.focusLast' }).catch(() => undefined);
  }

  /** 用户点了「停止」：在条与条、轮与轮之间检查，尽快收尾并如实汇报已入库条数。 */
  stopBatch(): void {
    this.batchStopped = true;
  }

  /** 问页面里的主世界钩子要一份运行统计；拿不到就按「没在运行」处理。 */
  private async hookStats(tabId: number): Promise<HookStats> {
    const response = await this.ask(tabId, { type: 'list.hookStats' }).catch(() => undefined);
    if (response?.ok) {
      try {
        return payloadOf(response, 'hook');
      } catch {
        // 页面里还是旧版内容脚本，答不上这个字段。
      }
    }
    return {
      installed: false,
      observed: 0,
      jsonResponses: 0,
      withTopicId: 0,
      publishedRecords: 0,
      recent: [],
    };
  }

  /**
   * 单条帖子的「为什么没对上号」证据包（页面文本 vs 接口原文）。
   * 整页诊断回答不了「这一条差在哪」，跳过的条目必须能单独取证。
   */
  async itemDiagnostics(key: string): Promise<string> {
    const [tab] = await this.options.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id === undefined) throw new Error('当前没有可采集的浏览器页面');
    const response = await this.ask(tab.id, { type: 'list.itemDiagnose', key });
    if (!response.ok) throw new Error(response.error.message);
    return payloadOf(response, 'diagnostics');
  }

  /** 侧栏点某条时，让页面滚过去并高亮它，方便逐条核对采到的内容。 */
  async highlight(key: string): Promise<boolean> {
    const [tab] = await this.options.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id === undefined) return false;
    const response = await this.ask(tab.id, { type: 'list.highlight', key }).catch(() => undefined);
    return Boolean(response?.ok && payloadOf(response, 'highlight').found);
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
   * 清空本机库之后，把页面上的「已处理」标记一并抹掉。
   *
   * 本机库是去重的唯一依据，页面标记只是「这一轮采过了，下一轮别重复」的临时状态。
   * 库都清空了，标记就是脏的：不抹掉，用户在同一个没刷新过的标签页里重采，
   * 这些帖子会被整批当成已采过跳过——看上去就像采集坏了。
   *
   * 失败不吭声是安全的：找不到页面、内容脚本不在，都意味着那份 DOM 早就没了，
   * 标记跟着一起没了，本来就无事可做。
   */
  async resetPageMarks(): Promise<void> {
    const [tab] = await this.options.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id === undefined) return;
    await this.restorePage(tab.id);
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
    limits: {
      maxRounds?: number;
      /** 本次要采够多少条；采够即停，不需要用户盯着手动停。 */
      maxItems?: number;
      /**
       * 「连已入库的一起重采」。
       *
       * 平时本机库是去重依据，库里有的直接跳过。但采集器修好之后（比如补上了长文正文），
       * 库里那批是用旧逻辑采的，需要整体刷新一遍——这时才打开它。
       * 重采同一地址仍然只有一条（稳定内容 ID 幂等覆盖），但同步状态会回到未同步，
       * 于是只有**内容真的变了**的条目需要再推一次，不做重复动作。
       */
      refresh?: boolean;
      continuation?: boolean;
    } = {},
  ): Promise<BatchProgress> {
    const [tab] = await this.options.tabs.query({ active: true, lastFocusedWindow: true });
    // E10：连可采集的标签页都没有，写不出归属某页的记录，交给侧栏的本地粘性错误。
    if (tab?.id === undefined || !tab.url) throw new Error('当前没有可采集的浏览器页面');
    const tabId = tab.id;
    const maxRounds = limits.maxRounds ?? 12;
    const maxItems = limits.maxItems ?? 20;
    this.batchStopped = false;
    const progress: BatchProgress = {
      url: tab.url,
      collected: 0,
      skipped: 0,
      failed: 0,
      rounds: 0,
      phase: 'running',
      updatedAt: Date.now(),
      log: [],
    };
    const note = (line: string): void => {
      progress.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
      if (progress.log.length > 200) progress.log.shift();
      console.info(`[data-collector] ${line}`);
    };
    const report = () => {
      progress.updatedAt = Date.now();
      this.options.reportBatch?.({ ...progress });
      this.options.reportItems?.([...items]);
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
    /*
     * 本机库里已经有的地址。取一次就够——一轮批量之内库不会被别人改。
     * 查不到（服务断了、接口变了）一律按空集合处理：宁可重复采一遍，
     * 也绝不能因为查库失败就把整批拦下。
     */
    let known: ReadonlySet<string> = new Set();
    try {
      known = (await this.options.knownUrls?.()) ?? new Set();
    } catch {
      known = new Set();
    }
    const items: BatchItem[] = [];
    /**
     * 计数一律从明细里数出来。
     *
     * 早先「已跳过」是在逐条循环**之前**按整屏一次性加上的，而解释这些跳过的行
     * 只在循环体内 push——采够条数或用户点停止时循环从中间断开，计数留着、行没了：
     * 面板说「已跳过 2」，点进明细却是「已跳过 0」，一行都没有。
     * 同源就不可能再漂。
     */
    const tally = () => {
      progress.collected = items.filter(item => item.status === 'saved').length;
      progress.skipped = items.filter(item => item.status === 'skipped').length;
      progress.failed = items.filter(item => item.status === 'failed').length;
    };
    report();

    if (limits.continuation) {
      // 「继续采下一批」：本屏都处理过了，得先滚动把下一页加载出来再提取，
      // 否则一上来就是「没有待采内容」。
      note('继续采下一批：先滚动加载下一页');
      const advanced = await this.ask(tabId, { type: 'list.advance' }).catch(() => undefined);
      const outcome = advanced?.ok
        ? payloadOf(advanced, 'advance')
        : { loaded: 0, collapsed: 0, scroll: undefined };
      const loaded = outcome.loaded;
      // 滚没滚动必须写下来：只报「新增 0 条」时，分不清是到底了还是压根没滚。
      if (outcome.scroll) note(outcome.scroll);
      note(`滚动后新加载出 ${loaded} 条待采内容`);
      if (loaded === 0) {
        progress.phase = 'done';
        progress.error = '滚动到底也没有加载出新内容，本页应该已经采完了。';
        report();
        return { ...progress };
      }
    } else {
      // 新开一批：清掉上一批的处理标记，让整页重新可采。
      await this.restorePage(tabId);
      note('新的一批：已清除上一轮的处理标记');
    }

    let sawAnyPost = false;
    let captured = 0;
    /** 是否已经替用户切过一次分类来触发接口请求（最多一次）。 */
    let refreshedFeed = false;
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

      // 一个帖子号都没截到：页面多半是更早之前加载好的，那次接口响应已经错过。
      // 与其让用户自己去切分类，不如插件代劳一次——这是唯一能不刷新页面就
      // 让站点重新请求的办法（刷新会把「精华」退回「最新」）。只做一次，避免来回折腾。
      if (!refreshedFeed && (list.captured ?? 0) === 0 && list.total > 0) {
        refreshedFeed = true;
        note('本页一个帖子号都没截到：切走分类再切回来，让站点重新请求一次');
        // 全程尽力而为：这一步失败（页面里是旧版内容脚本、答不上这个字段等）
        // 绝不能把整批采集带下水——它只是个「省得用户自己动手」的便利。
        const refresh = await this.ask(tabId, { type: 'list.refreshTopics' })
          .then(response => (response.ok ? payloadOf(response, 'refresh') : { toggled: false }))
          .catch(() => ({ toggled: false as boolean, category: undefined }));
        if (refresh.toggled) {
          note(`已切走并切回「${refresh.category ?? '原分类'}」，重新提取本屏`);
          round -= 1; // 重跑这一轮（refreshedFeed 保证只会发生一次）
          continue;
        }
        note('页面上没找到分类切换控件，这一步跳过');
      }

      progress.rounds = round + 1;
      if (list.total > 0) sawAnyPost = true;
      captured = Math.max(captured, list.captured ?? 0);
      note(
        `第 ${round + 1} 轮：本屏待采 ${list.total} 条，其中 ${list.total - list.skipped} 条可入库，`
        + `已捕获帖子号 ${list.captured ?? 0} 个`,
      );

      for (const item of list.items) {
        if (this.batchStopped) break;
        if (progress.collected >= maxItems) break;
        if (!item.document) {
          items.push({ key: item.key, title: item.title, status: 'skipped', ...(item.reason ? { reason: item.reason } : {}) });
          tally();
          continue;
        }
        const document = item.document;
        if (seen.has(document.canonicalUrl)) {
          // 本轮已经采过同一个地址：如实记一行，**绝不静默丢弃**。
          // 这种情况多半是有条帖子被对到了别人的帖子号上，正是最该让用户看见的。
          items.push({
            key: item.key,
            title: item.title,
            status: 'skipped',
            reason: '和本轮另一条算出了同一个地址，未重复入库',
          });
          tally();
          continue;
        }
        seen.add(document.canonicalUrl);
        // 本机库里已经有了就跳过，让目标条数只数**新内容**——
        // 否则刷新一次页面，整屏旧帖子又会把这一批吃满。
        if (!limits.refresh && known.has(document.canonicalUrl)) {
          items.push({
            key: item.key,
            title: item.title,
            status: 'skipped',
            reason: '已在本机库，未重复采集',
            url: document.canonicalUrl,
          });
          tally();
          continue;
        }
        const saved = await this.saveCollected(await this.withLinkedArticle(document), overrides);
        if (saved === 'ok') {
          items.push({ key: item.key, title: item.title, status: 'saved', url: document.canonicalUrl });
          tally();
        } else if (saved === 'bridge-down') {
          // E5：本机服务断了，后面每条都会失败，立刻收尾而不是刷一屏失败。
          note('本机服务无响应，提前收尾');
          return await fail('BRIDGE_UNAVAILABLE', '本机服务无响应，本批已中断。');
        } else {
          items.push({ key: item.key, title: item.title, status: 'failed', reason: '写入本机失败' });
          tally();
        }
        report();
        // 条与条之间留一点随机间隔：连续无间隔的请求最像脚本。
        if (progress.collected < maxItems) await this.wait(250 + Math.random() * 450);
      }

      if (this.batchStopped) {
        await this.focusLast(tabId);
        progress.phase = 'stopped';
        report();
        return { ...progress };
      }
      if (progress.collected >= maxItems) {
        // 采够目标条数就收工——这是正常完成，不是被截断。
        // **必须先把这一屏标记掉**：否则「继续采下一批」上来第一件事是滚动，
        // 而这一屏还都是「待采」状态，滚完立刻就有「新内容」，于是又把同一屏
        // 提取一遍——表现就是点了继续毫无进展，永远卡在原地。
        const marked = await this.ask(tabId, { type: 'list.restore', mark: true })
          .then(response => (response.ok ? payloadOf(response, 'advance').collapsed : 0))
          .catch(() => 0);
        note(`已采够目标条数 ${maxItems} 条，收工（已标记本屏 ${marked} 条，续采从下一屏开始）`);
        await this.focusLast(tabId);
        progress.phase = 'capped';
        report();
        return { ...progress };
      }

      const advanced = await this.ask(tabId, { type: 'list.advance' }).catch(() => undefined);
      const nextPage = advanced?.ok
        ? payloadOf(advanced, 'advance')
        : { loaded: 0, collapsed: 0, scroll: undefined };
      const loaded = nextPage.loaded;
      if (nextPage.scroll) note(nextPage.scroll);
      note(`滚动加载下一页：新增待采 ${loaded} 条`);
      if (loaded === 0) break;
      report();
    }

    // 零产出（没找到帖子 / 全部无法定位）同样要把页面还原。
    if (progress.collected === 0) await this.restorePage(tabId);
    else await this.focusLast(tabId);
    // E3 / E4：跑完了但没有产出，都不是「完成」。
    progress.phase = !sawAnyPost
      ? 'empty'
      // 一条都没入库、却有写入失败：这是失败，不是「完成」。
      // 之前 failed 完全没参与终态判定，全军覆没会渲染成绿色的「本轮批量归档完成」，
      // 说明文字还写着「内容已落到本机库」——那是假的。
      : progress.collected === 0 && progress.failed > 0
        ? 'failed'
        : progress.collected === 0 && progress.skipped > 0
          ? 'skipped_all'
          : progress.rounds >= maxRounds && progress.collected >= maxItems
            ? 'capped'
            : 'done';
    if (progress.phase === 'failed') {
      progress.error = `本轮 ${progress.failed} 条全部写入失败，一条都没入库。`
        + '多半是本机服务写不了知识库目录（磁盘满、目录被占用或权限变更）。';
      progress.code = 'ALL_WRITES_FAILED';
    }
    if (progress.phase === 'skipped_all') {
      // 区分两种「全部跳过」：还没截到接口响应（用户能自己解决），
      // 还是截到了但对不上号（需要我改适配）。
      if (captured === 0) {
        // 「一个都没截到」有三种完全不同的成因，直接问钩子要统计，
        // 把结论说死，而不是丢一段放之四海皆准的建议让用户自己试。
        const hook = await this.hookStats(tabId);
        progress.error = explainEmptyIndex(hook);
        progress.code = 'TOPIC_INDEX_EMPTY';
        note(
          `帖子号钩子：${hook.installed ? '在运行' : '未运行'}，`
          + `旁观请求 ${hook.observed} 次，其中 JSON 响应 ${hook.jsonResponses} 次，`
          + `含帖子号 ${hook.withTopicId} 次`,
        );
      } else {
        progress.error = `已获取 ${captured} 条帖子号，但和页面上的帖子对不上号。`
          + '请在「本轮明细」里点这些条目复制证据，或用「复制完整报告」发给开发者。';
        progress.code = 'TOPIC_INDEX_MISMATCH';
      }
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

/**
 * 「一个帖子号都没截到」到底是哪种情况——把结论说死。
 *
 * 之前只有一句放之四海皆准的「滚一屏或切一次分类」，用户照做也没用，
 * 因为真正的成因可能根本不是这个。三种成因给三种说法，各自对应能解决它的动作。
 */
export function explainEmptyIndex(hook: HookStats): string {
  if (!hook.installed) {
    return '页面里的帖子号钩子没有在运行，所以一条帖子号都截不到。'
      + '这通常发生在扩展刚更新、而本页是更新之前打开的。'
      + '请在 edge://extensions 确认 Data Collector 已启用，然后**新开一个知识星球标签页**再试'
      + '（本页不必刷新，刷新会把「精华」退回「最新」）。';
  }
  if (hook.observed === 0) {
    return '钩子在正常运行，但从它装上到现在，页面一个接口请求都没发出过——'
      + '本页的内容是更早之前加载好的，帖子号在那次响应里，已经错过了。'
      + '请把分类切走再切回来（会重新请求一次，且不会离开精华页），然后重试。';
  }
  if (hook.jsonResponses === 0) {
    return `钩子旁观到 ${hook.observed} 次请求，但没有一次是 JSON 响应，因而取不到帖子号。`
      + '请用「复制完整报告」把诊断发给开发者。';
  }
  return `钩子旁观到 ${hook.jsonResponses} 次 JSON 响应，但里面都没有帖子号——`
    + '站点的接口结构很可能变了，需要改适配。请用「复制完整报告」把诊断发给开发者。';
}