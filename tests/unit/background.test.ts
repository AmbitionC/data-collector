import { describe, expect, it, vi } from 'vitest';
import { TRUSTED_EXTENSION_ID, type CollectedDocument } from '@data-collector/shared';
import {
  JobRunner,
  explainEmptyIndex,
  type BatchItem,
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
  /** 只保留采集节奏（去掉还原页面这类善后消息），断言更聚焦。 */
  get rhythm(): string[] {
    return this.asked.filter(type => type === 'extract.list' || type === 'list.advance');
  }
  readonly injected: number[] = [];
  readonly restored: number[] = [];
  listRounds: Array<{
    documents: CollectedDocument[];
    skipped: number;
    total: number;
    /** 本轮已截获的帖子号条数；不写就按「截到了」处理（真实页面的常态）。 */
    captured?: number;
  }> = [];
  /** 「切走分类再切回来」被请求了几次，以及页面上有没有这个控件。 */
  refreshCalls = 0;
  canRefresh = true;
  /** 把用例里写的 documents 转成内容脚本真正回传的逐条结构。 */
  private toPayload(round: { documents: CollectedDocument[]; skipped: number; total: number }) {
    const items = round.documents.map((document, index) => ({
      key: `k${index}-${document.canonicalUrl}`,
      title: document.title,
      document,
    }));
    for (let index = 0; index < round.skipped; index += 1) {
      items.push({
        key: `skip-${index}`,
        title: `跳过的第 ${index} 条`,
        reason: '没能对上帖子号',
      } as never);
    }
    return {
      items,
      skipped: round.skipped,
      total: round.total,
      captured: round.captured ?? round.total,
    };
  }
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

  async inject(id: number): Promise<void> {
    this.injected.push(id);
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
      return { ok: true, list: this.toPayload(round) };
    }
    if (type === 'list.refreshTopics') {
      this.refreshCalls += 1;
      return {
        ok: true,
        refresh: this.canRefresh ? { toggled: true, category: '精华' } : { toggled: false },
      };
    }
    if (type === 'list.advance') {
      return { ok: true, advance: this.advances.shift() ?? { collapsed: 0, loaded: 0 } };
    }
    if (type === 'list.restore') {
      this.restored.push(_id);
      return { ok: true, advance: { collapsed: 0, loaded: 0 } };
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
  /** 每条都建任务失败（模拟知识库目录写不动这类「不是服务断了」的失败）。 */
  failCreate = false;

  send(type: string, requestId: string, payload: unknown): void {
    this.sent.push({ type, requestId, payload });
  }

  async createJob(url: string): Promise<{ id: string }> {
    this.createdFor.push(url);
    if (this.failCreate || this.failCreateFor === url) {
      throw new Error('创建采集任务失败：HTTP 500');
    }
    return {
      id: this.createdFor.length === 1
        ? this.createdJobId
        : `${this.createdJobId}-${this.createdFor.length}`,
    };
  }
}

describe('extension job runner', () => {
  it('unions ZSXQ documents across three views before creating any save job', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    const labels: string[] = [];
    let active = '';
    const byView: Record<string, CollectedDocument[]> = {
      最新: [topic('7001'), topic('7002')],
      精华: [topic('7002'), topic('7003')],
      只看星主: [topic('7001'), topic('7004')],
    };
    tabs.sendMessage = async (_id, message) => {
      const request = message as { type: string; label?: string };
      tabs.asked.push(request.type);
      if (request.type === 'list.selectView') {
        active = request.label ?? '';
        labels.push(active);
        return { ok: true, selected: { label: active, topicIds: [] } } as never;
      }
      if (request.type === 'extract.list') {
        expect(bridge.createdFor).toHaveLength(0);
        const documents = byView[active] ?? [];
        return {
          ok: true,
          list: {
            items: documents.map((document, index) => ({ key: `${active}-${index}`, title: document.title, document })),
            skipped: 0,
            total: documents.length,
            captured: documents.length,
          },
        };
      }
      throw new Error(`unexpected ${request.type}`);
    };
    const runner = new JobRunner({ tabs, bridge, waitForTabComplete: async () => undefined });

    const documents = await runner.collectZsxqPlanViews(7);

    expect(labels).toEqual(['最新', '精华', '只看星主']);
    expect(documents.map(document => document.canonicalUrl)).toEqual([
      `${LIST_URL}/topic/7001`,
      `${LIST_URL}/topic/7002`,
      `${LIST_URL}/topic/7003`,
      `${LIST_URL}/topic/7004`,
    ]);
    expect(documents[0]?.sourceMetadata?.viewLabels).toBe('最新、只看星主');
    expect(documents[1]?.sourceMetadata?.viewLabels).toBe('最新、精华');
    expect(bridge.createdFor).toHaveLength(0);
  });

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
  function listRunner(
    extra: { knownUrls?: () => Promise<ReadonlySet<string>> } = {},
  ): { tabs: InMemoryTabs; bridge: InMemoryBridge; runner: JobRunner; progress: BatchProgress[] } {
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
      ...extra,
    });
    return { tabs, bridge, runner, progress };
  }

  describe('单页应用还没渲染完时要等，不能一次 CONTENT_EMPTY 就放弃', () => {
    /**
     * 实测：按 URL 单条采集第一条就失败在这里。知识星球整站是 SPA，
     * 标签页 complete 只代表 HTML 到了，正文还要等接口回来。
     * 批量采集踩不到（那时页面早渲染好了），单条采集必然 100% 撞上。
     */
    function renderAfter(failures: number) {
      const { tabs, bridge, runner } = listRunner();
      let asked = 0;
      tabs.sendMessage = async (_id, message) => {
        if ((message as { type?: string }).type !== 'extract.document') {
          return { ok: false as const, error: { code: 'X', message: 'x' } };
        }
        asked += 1;
        if (asked <= failures) {
          return { ok: false as const, error: { code: 'CONTENT_EMPTY', message: '未读到帖子正文' } };
        }
        return {
          ok: true as const,
          document: {
            schemaVersion: 1, source: 'zsxq', kind: 'post',
            url: 'https://wx.zsxq.com/group/1/topic/2',
            canonicalUrl: 'https://wx.zsxq.com/group/1/topic/2',
            title: '渲染完了', collectedAt: '2026-08-03T00:00:00.000Z',
            html: '<p>正文</p>', text: '正文', images: [],
          },
        };
      };
      return { tabs, bridge, runner, attempts: () => asked };
    }

    it('前几次没渲染出来就等一等，渲染好了照常入库', async () => {
      const { bridge, runner, attempts } = renderAfter(3);

      await runner.runRemoteJob('req-1', 'https://wx.zsxq.com/group/1/topic/2');

      expect(attempts()).toBe(4);
      expect(bridge.sent.some(item => item.type === 'job.result')).toBe(true);
    });

    it('要登录这种再等也没用的错误，一次就返回', async () => {
      const { tabs, bridge, runner } = listRunner();
      let asked = 0;
      tabs.sendMessage = async () => {
        asked += 1;
        return { ok: false as const, error: { code: 'AUTH_REQUIRED', message: '请先登录知识星球' } };
      };

      await runner.runRemoteJob('req-2', 'https://wx.zsxq.com/group/1/topic/2');

      expect(asked).toBe(1);
      const error = bridge.sent.find(item => item.type === 'job.error');
      expect((error?.payload as { code?: string })?.code).toBe('AUTH_REQUIRED');
    });
  });

  describe('工单 D2：帖子只是导语时，把长文正文取回来接上', () => {
    /**
     * 星球长文帖在信息流里只有一段引子加一个 articles.zsxq.com 链接——
     * 实测 77 条投递里 54 条（70%）是这形态，43 条正文不足 400 字。
     * 长文页是单页应用、接口要登录态，只能开后台标签页让内容脚本去读。
     */
    function withArticle(articleText: string | undefined) {
      const { tabs, bridge, runner } = listRunner();
      tabs.listRounds = [{
        documents: [{
          ...topic('111'),
          html: '<p>先跟新粉解释下</p><a href="https://articles.zsxq.com/id_abc.html">全文</a>',
          text: '先跟新粉解释下',
        }],
        skipped: 0,
        total: 1,
      }];
      tabs.advances = [{ collapsed: 1, loaded: 0 }];
      const original = tabs.sendMessage.bind(tabs);
      tabs.sendMessage = async (id, message) => {
        const type = (message as { type?: string }).type;
        // 长文页那个标签页只会收到 extract.document。
        if (type === 'extract.document') {
          if (articleText === undefined) {
            return { ok: false as const, error: { code: 'CONTENT_EMPTY', message: '还没渲染出来' } };
          }
          return {
            ok: true as const,
            document: {
              schemaVersion: 1, source: 'zsxq', kind: 'article',
              url: 'https://articles.zsxq.com/id_abc.html',
              canonicalUrl: 'https://articles.zsxq.com/id_abc.html',
              title: '长文', collectedAt: '2026-08-02T00:00:00.000Z',
              html: `<p>${articleText}</p>`, text: articleText, images: [],
            },
          };
        }
        return original(id, message);
      };
      return { tabs, bridge, runner };
    }

    it('长文正文接在导语后面，一并入库', async () => {
      const body = '这里是长文的完整正文，讲居民杠杆率与房地产周期。'.repeat(10);
      const { tabs, bridge, runner } = withArticle(body);

      await runner.captureList();

      // 开过一个后台标签页去取长文，取完关掉，不留残余。
      expect(tabs.created.map(item => item.url)).toContain('https://articles.zsxq.com/id_abc.html');
      expect(tabs.removed.length).toBeGreaterThan(0);
      const sent = bridge.sent.find(item => item.type === 'job.result');
      const document = (sent?.payload as { document?: { text?: string } })?.document;
      expect(document?.text).toContain('先跟新粉解释下');
      expect(document?.text).toContain('居民杠杆率');
    });

    it('长文取不到时原样保留导语，绝不让整条采集失败', async () => {
      const { bridge, runner } = withArticle(undefined);

      const summary = await runner.captureList();

      expect(summary.collected).toBe(1);
      const sent = bridge.sent.find(item => item.type === 'job.result');
      expect((sent?.payload as { document?: { text?: string } })?.document?.text)
        .toBe('先跟新粉解释下');
    });
  });

describe('本机库已有的不再重复采', () => {
  /**
   * 用户实测：刷新页面 / 重载扩展后再采，整屏旧帖子又采了一遍——
   * 同一批 topic id 连采四轮，目标条数全被旧内容吃满，永远推进不到新帖子。
   * 页面上的「已处理」标记只活在那一个没刷新过的标签页里，扛不住刷新。
   */
  it('库里已有的计入「已跳过」并写明原因，不占目标条数', async () => {
    const { tabs, bridge, runner } = listRunner({
      knownUrls: async () =>
        new Set(['https://wx.zsxq.com/group/48844584441158/topic/111']),
    });
    tabs.listRounds = [
      { documents: [topic('111'), topic('222')], skipped: 0, total: 2 },
    ];
    tabs.advances = [{ collapsed: 2, loaded: 0 }];

    const summary = await runner.captureList();

    // 只有没入过库的那条真的建了任务。
    expect(bridge.createdFor).toEqual([
      'https://wx.zsxq.com/group/48844584441158/topic/222',
    ]);
    expect(summary.collected).toBe(1);
    expect(summary.skipped).toBe(1);
  });

  it('查库失败时照常采，绝不因此把整批拦下', async () => {
    const { bridge, tabs, runner } = listRunner({
      knownUrls: async () => { throw new Error('本机服务无响应'); },
    });
    tabs.listRounds = [{ documents: [topic('111')], skipped: 0, total: 1 }];
    tabs.advances = [{ collapsed: 1, loaded: 0 }];

    const summary = await runner.captureList();

    expect(summary.collected).toBe(1);
    expect(bridge.createdFor).toHaveLength(1);
  });
});

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

    expect(tabs.rhythm).toEqual([
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
    expect(summary.error).toContain('自动注入没有成功');
    // 绝不能建议用户刷新页面：刷新会丢掉「精华」这类应用内分类状态。
    expect(summary.error).not.toContain('刷新');
    expect(progress.at(-1)).toMatchObject({ phase: 'failed', code: 'CONTENT_SCRIPT_MISSING' });
    // 中途不得出现任何被当成成功的终态。
    expect(progress.some(item => ['done', 'capped', 'stopped'].includes(item.phase))).toBe(false);
  });

  it('E1 自愈: injects the content script instead of reloading the page', async () => {
    const { tabs, runner } = listRunner();
    let missing = true;
    tabs.sendMessage = async (id: number, message: unknown) => {
      const type = (message as { type: string }).type;
      if (type === 'extract.list' && missing) {
        missing = false;
        throw new Error('Could not establish connection. Receiving end does not exist.');
      }
      if (type === 'extract.list') {
        return {
          ok: true as const,
          list: {
            items: [{ key: 'k0', title: '星球帖子 111', document: topic('111') }],
            skipped: 0,
            total: 1,
          },
        };
      }
      return { ok: true as const, advance: { collapsed: 1, loaded: 0 } };
    };

    const summary = await runner.captureList();

    // 绝不能刷新页面：知识星球的「精华」分类是应用内状态，刷新会退回「最新」，
    // 用户在精华页发起的采集就采成了别的内容。注入不动页面状态。
    expect(tabs.injected).toEqual([7]);
    expect(summary).toMatchObject({ collected: 1, phase: 'done' });
  });

  it('restores the page when a fresh batch starts, and keeps marks when continuing', async () => {
    const { tabs, runner } = listRunner();
    tabs.listRounds = [
      { documents: [topic('111')], skipped: 0, total: 1 },
      { documents: [topic('222')], skipped: 0, total: 1 },
    ];
    tabs.advances = [{ collapsed: 1, loaded: 0 }, { collapsed: 1, loaded: 0 }];

    await runner.captureList();
    expect(tabs.restored).toEqual([7]);

    // 「继续采下一批」是续采：不清标记，而且要先滚动把下一页加载出来，
    // 否则本屏都处理过了，一上来就是「没有待采内容」。
    const before = tabs.rhythm.length;
    tabs.advances = [{ collapsed: 0, loaded: 1 }, { collapsed: 1, loaded: 0 }];
    tabs.listRounds = [{ documents: [topic('222')], skipped: 0, total: 1 }];
    await runner.captureList({}, { continuation: true });
    expect(tabs.restored).toEqual([7]);
    expect(tabs.rhythm[before]).toBe('list.advance');
  });

  it('清空本机库后抹掉页面上的已处理标记', async () => {
    // 本机库是去重的唯一依据。库清空了、标记还留在那个没刷新过的标签页上，
    // 用户重采时这些帖子会被整批当成「已采过」跳过，看上去就像采集坏了。
    const { tabs, runner } = listRunner();
    tabs.listRounds = [{ documents: [topic('111')], skipped: 0, total: 1 }];
    tabs.advances = [{ collapsed: 1, loaded: 0 }];
    await runner.captureList();
    const before = tabs.restored.length;

    await runner.resetPageMarks();

    expect(tabs.restored.length).toBe(before + 1);
    expect(tabs.restored.at(-1)).toBe(7);
  });

  it('puts the page back when a batch produced nothing', async () => {
    const { tabs, runner } = listRunner();
    tabs.listRounds = [{ documents: [], skipped: 21, total: 21 }];

    const summary = await runner.captureList();

    expect(summary.phase).toBe('skipped_all');
    // 一条都没采到却把 21 条帖子留在隐藏状态，用户会看到自己的星球主页凭空少了一屏。
    expect(tabs.restored.filter(id => id === 7).length).toBeGreaterThanOrEqual(2);
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
    expect(tabs.rhythm).toEqual(['extract.list']);
  });

  it('E9: hitting the item cap is disclosed, not silently truncated', async () => {
    const { tabs, runner } = listRunner();
    tabs.listRounds = [{ documents: [topic('111'), topic('222'), topic('333')], skipped: 0, total: 3 }];

    const summary = await runner.captureList({}, { maxItems: 2 });

    expect(summary).toMatchObject({ collected: 2, phase: 'capped' });
    // 到顶就收工，不再翻页。
    expect(tabs.rhythm).toEqual(['extract.list']);
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

describe('一个帖子号都没截到时，先替用户切一次分类', () => {
  const topicDoc = (id: string) => topic(id);

  it('第一轮没截到帖子号 → 切走分类再切回来 → 重跑这一轮', async () => {
    // 帖子号只在接口响应里。页面若是更早加载好的，那次响应已经错过，
    // 光重试永远没用——这正是实测「已捕获 0 个」的成因。
    const tabs = new InMemoryTabs();
    tabs.activeTab = { id: 7, url: LIST_URL, status: 'complete' };
    tabs.listRounds = [
      // 第一轮：页面上有 2 条，但一个帖子号都没截到。
      { documents: [], skipped: 2, total: 2, captured: 0 },
      // 切过分类之后，同一屏这次对上号了。
      { documents: [topicDoc('511111111111111'), topicDoc('522222222222222')], skipped: 0, total: 2 },
      { documents: [], skipped: 0, total: 0 },
    ];
    const bridge = new InMemoryBridge();
    const runner = new JobRunner({
      tabs, bridge, waitForTabComplete: async () => undefined, delay: async () => undefined,
    });

    const progress = await runner.captureList();

    expect(tabs.refreshCalls).toBe(1);
    expect(progress.collected).toBe(2);
    // 切分类只做一次，绝不来回折腾用户的页面。
    expect(progress.log.some(line => line.includes('切走分类再切回来'))).toBe(true);
  });

  it('页面上没有分类切换控件时如实记一笔，然后照常往下走', async () => {
    const tabs = new InMemoryTabs();
    tabs.activeTab = { id: 7, url: LIST_URL, status: 'complete' };
    tabs.canRefresh = false;
    tabs.listRounds = [{ documents: [], skipped: 2, total: 2, captured: 0 }];
    const runner = new JobRunner({
      tabs,
      bridge: new InMemoryBridge(),
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
    });

    const progress = await runner.captureList();

    expect(tabs.refreshCalls).toBe(1);
    expect(progress.log.some(line => line.includes('没找到分类切换控件'))).toBe(true);
    // 这一步只是便利，失败绝不能把整批带下水。
    expect(progress.phase).toBe('skipped_all');
  });
});

describe('「一个帖子号都没截到」的三种成因', () => {
  it('钩子没在运行：指向新开标签页，而不是让用户白滚一屏', () => {
    const message = explainEmptyIndex({
      installed: false, observed: 0, jsonResponses: 0, withTopicId: 0, publishedRecords: 0, recent: [],
    });
    expect(message).toContain('没有在运行');
    expect(message).toContain('新开一个知识星球标签页');
    // 绝不建议刷新：刷新会把「精华」退回「最新」。
    expect(message).toContain('刷新会把');
  });

  it('钩子在跑但页面没发过请求：指向切换分类', () => {
    const message = explainEmptyIndex({
      installed: true, observed: 0, jsonResponses: 0, withTopicId: 0, publishedRecords: 0, recent: [],
    });
    expect(message).toContain('一个接口请求都没发出过');
    expect(message).toContain('分类切走再切回来');
  });

  it('有 JSON 响应但没有帖子号：接口结构变了，该找开发者', () => {
    const message = explainEmptyIndex({
      installed: true, observed: 9, jsonResponses: 4, withTopicId: 0, publishedRecords: 0, recent: [],
    });
    expect(message).toContain('接口结构');
    expect(message).toContain('复制完整报告');
  });

  it('三种说法互不相同——否则等于没区分', () => {
    const base = { publishedRecords: 0, recent: [] };
    const messages = new Set([
      explainEmptyIndex({ ...base, installed: false, observed: 0, jsonResponses: 0, withTopicId: 0 }),
      explainEmptyIndex({ ...base, installed: true, observed: 0, jsonResponses: 0, withTopicId: 0 }),
      explainEmptyIndex({ ...base, installed: true, observed: 5, jsonResponses: 0, withTopicId: 0 }),
      explainEmptyIndex({ ...base, installed: true, observed: 5, jsonResponses: 5, withTopicId: 0 }),
    ]);
    expect(messages.size).toBe(4);
  });
});

describe('计数与明细必须同源，失败不许伪装成完成', () => {
  it('采够条数时，本轮的跳过项照样出现在明细里', async () => {
    // 「已跳过」曾经在逐条循环之前按整屏一次性加上，而解释这些跳过的行只在循环里
    // push——采够条数时循环从中间断开，计数留着、行没了：面板说「已跳过 2」，
    // 点进明细却是一行都没有，而用户正是被指引去那里逐条核对的。
    const tabs = new InMemoryTabs();
    tabs.activeTab = { id: 7, url: LIST_URL, status: 'complete' };
    tabs.listRounds = [{
      documents: [topic('511111111111111'), topic('522222222222222')],
      skipped: 2,
      total: 4,
    }];
    const collected: BatchItem[] = [];
    const runner = new JobRunner({
      tabs,
      bridge: new InMemoryBridge(),
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
      reportItems: rows => { collected.splice(0, collected.length, ...rows); },
    });

    const progress = await runner.captureList({}, { maxItems: 2 });

    expect(progress.phase).toBe('capped');
    expect(progress.collected).toBe(2);
    // 计数说几条跳过，明细就得有几行——两者从同一个数组数出来。
    const items = collected.filter(item => item.status === 'skipped');
    expect(items).toHaveLength(progress.skipped);
  });

  it('全部写入失败 → 终态是 failed，不是「完成」', async () => {
    const tabs = new InMemoryTabs();
    tabs.activeTab = { id: 7, url: LIST_URL, status: 'complete' };
    tabs.listRounds = [{
      documents: [topic('511111111111111'), topic('522222222222222')],
      skipped: 0,
      total: 2,
    }];
    const bridge = new InMemoryBridge();
    // 每条都写入失败（如知识库目录写不动），但不是「本机服务断了」。
    bridge.failCreate = true;
    const runner = new JobRunner({
      tabs, bridge, waitForTabComplete: async () => undefined, delay: async () => undefined,
    });

    const progress = await runner.captureList();

    expect(progress.collected).toBe(0);
    expect(progress.failed).toBe(2);
    // 绿色的「本轮批量归档完成」+「内容已落到本机库」是假话。
    expect(progress.phase).toBe('failed');
    expect(progress.error).toContain('全部写入失败');
  });

  it('两条帖子算出同一个地址时，被顶掉的那条如实记一行', async () => {
    // 静默 continue 会让用户看到「本屏 2 条」但明细只有 1 行，第二条无声消失。
    const duplicate = topic('511111111111111');
    const tabs = new InMemoryTabs();
    tabs.activeTab = { id: 7, url: LIST_URL, status: 'complete' };
    tabs.listRounds = [{ documents: [duplicate, { ...duplicate }], skipped: 0, total: 2 }];
    const rows: BatchItem[] = [];
    const runner = new JobRunner({
      tabs,
      bridge: new InMemoryBridge(),
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
      reportItems: next => { rows.splice(0, rows.length, ...next); },
    });

    const progress = await runner.captureList();

    expect(progress.collected).toBe(1);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ status: 'skipped' });
    expect(rows[1]?.reason).toContain('同一个地址');
  });
});
