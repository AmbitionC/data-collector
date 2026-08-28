import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  TRUSTED_EXTENSION_ID,
  ZSXQ_COMPLETE_CONTENT_CAPABILITY,
  zsxqSemanticSignature,
  type CollectedDocument,
  type ZsxqLibraryIndexEntry,
} from '@data-collector/shared';
import {
  JobRunner,
  explainEmptyIndex,
  retryTransientTabOperation,
  trustedZsxqContentCompleteness,
  type BatchItem,
  type BatchProgress,
  type BridgeClient,
  type BrowserTab,
  type TabsApi,
} from '../../packages/extension/src/background/jobs.js';
import {
  CONTENT_EXTRACTION_PROTOCOL,
  contentRequestType,
} from '../../packages/extension/src/contentProtocol.js';
import { extractDocument } from '../../packages/extension/src/extractors/index.js';

const URL = 'https://mp.weixin.qq.com/s/background-test';
const LIST_URL = 'https://wx.zsxq.com/group/48844584441158';
const PLAN_ATTEMPT = 'a1b2c3d4e5f60718';

afterEach(() => {
  vi.useRealTimers();
});

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
    truncated: false,
  };
}

class InMemoryTabs implements TabsApi {
  readonly created: Array<{ url: string; active: boolean }> = [];
  readonly removed: number[] = [];
  readonly reloaded: number[] = [];
  readonly updated: Array<{ id: number; active: boolean }> = [];
  readonly handedOff: Array<{ id: number; url: string }> = [];
  /** 内容脚本收到的消息类型顺序（批量采集靠它验证「提取一轮 → 翻一页」的节奏）。 */
  readonly asked: string[] = [];
  /** 只保留采集节奏（去掉还原页面这类善后消息），断言更聚焦。 */
  get rhythm(): string[] {
    const result: string[] = [];
    for (const type of this.asked) {
      if (type !== 'extract.list' && type !== 'list.advance') continue;
      // 一轮现在会做多个稳定性样本；节奏断言只关心“本屏提取 → 翻页”。
      if (type === 'extract.list' && result.at(-1) === 'extract.list') continue;
      result.push(type);
    }
    return result;
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
  private activeListRound: (typeof this.listRounds)[number] | undefined;
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
        skipKind: 'coverage-risk',
      } as never);
    }
    return {
      items,
      skipped: round.skipped,
      total: round.total,
      captured: round.captured ?? round.total,
    };
  }
  advances: Array<{ collapsed: number; loaded: number; uncertain?: boolean }> = [];
  response: Awaited<ReturnType<TabsApi['sendMessage']>> = { ok: true, document: document() };
  activeTab: BrowserTab = { id: 7, url: URL, status: 'complete' };

  async create(input: { url: string; active: boolean }): Promise<BrowserTab> {
    this.created.push(input);
    return { id: 42, url: input.url, status: 'loading' };
  }

  async remove(id: number): Promise<void> {
    this.removed.push(id);
  }

  async reload(id: number): Promise<void> {
    this.reloaded.push(id);
  }

  async update(id: number, input: { active: boolean }): Promise<void> {
    this.updated.push({ id, ...input });
  }

  async handoff(id: number, url: string): Promise<void> {
    this.handedOff.push({ id, url });
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
      const round = this.activeListRound ?? this.listRounds.shift();
      if (!round) return { ok: false, error: { code: 'COLLECTION_FAILED', message: '没有更多轮次' } };
      this.activeListRound = round;
      return { ok: true, list: this.toPayload(round) };
    }
    if (type === 'list.refreshTopics') {
      this.refreshCalls += 1;
      this.activeListRound = undefined;
      return {
        ok: true,
        refresh: this.canRefresh ? { toggled: true, category: '精华' } : { toggled: false },
      };
    }
    if (type === 'list.advance') {
      this.activeListRound = undefined;
      return { ok: true, advance: this.advances.shift() ?? { collapsed: 0, loaded: 0 } };
    }
    if (type === 'list.restore') {
      this.activeListRound = undefined;
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
  readonly createdContexts: Array<Parameters<BridgeClient['createJob']>[1]> = [];
  createdJobId = 'current-job';
  failCreateFor: string | undefined;
  /** 每条都建任务失败（模拟知识库目录写不动这类「不是服务断了」的失败）。 */
  failCreate = false;
  readonly terminalWaits: Array<{ jobId: string; attempt?: string }> = [];
  terminalAck: (jobId: string, attempt?: string) => Promise<void> = async () => undefined;

  send(type: string, requestId: string, payload: unknown): void {
    this.sent.push({ type, requestId, payload });
  }

  async createJob(
    url: string,
    overrides?: Parameters<BridgeClient['createJob']>[1],
  ): Promise<{ id: string }> {
    this.createdFor.push(url);
    this.createdContexts.push(overrides);
    if (this.failCreate || this.failCreateFor === url) {
      throw new Error('创建采集任务失败：HTTP 500');
    }
    return {
      id: this.createdFor.length === 1
        ? this.createdJobId
        : `${this.createdJobId}-${this.createdFor.length}`,
    };
  }

  async waitForJobTerminal(jobId: string, attempt?: string): Promise<void> {
    this.terminalWaits.push({ jobId, ...(attempt ? { attempt } : {}) });
    await this.terminalAck(jobId, attempt);
  }
}

function linkedPreviewPlanFixture(detailTruncated: boolean, listHasArticleAnchor = true): {
  tabs: InMemoryTabs;
  bridge: InMemoryBridge;
  runner: JobRunner;
  candidate: CollectedDocument;
  detailText: string;
  articleText: string;
  phases: Array<{ rejections?: Record<string, number> }>;
} {
  const tabs = new InMemoryTabs();
  const bridge = new InMemoryBridge();
  const articleUrl = 'https://articles.zsxq.com/id_detailproof.html';
  const candidate = {
    ...topic('744444444444441'),
    title: '投资创业长文预览',
    text: '列表页只渲染了投资长文导语，且另有真实折叠风险。',
    html: '<p>列表页只渲染了投资长文导语，且另有真实折叠风险。</p>'
      + (listHasArticleAnchor ? `<a href="${articleUrl}">阅读全文</a>` : ''),
    truncated: true,
    publishedAt: '2026-08-24T10:00:00.000Z',
    sourceMetadata: { authorRole: 'owner' },
  } satisfies CollectedDocument;
  const detailText = `${candidate.text}${'详情页继续补全原帖自身的正文，包含投资、创业和经营复盘。'.repeat(12)}`;
  const articleText = '链接长文页的完整正文，继续展开投资、创业与经营的全部论证。'.repeat(40);
  let active = '';
  tabs.sendMessage = async (_id, message) => {
    const request = message as { type: string; label?: string };
    if (request.type === 'list.selectView') {
      active = request.label ?? '';
      return { ok: true, selected: { label: active, topicIds: [] } } as never;
    }
    if (request.type === 'list.restore') {
      return { ok: true, advance: { collapsed: 0, loaded: 0 } };
    }
    if (request.type === 'extract.list') {
      const documents = active === '最新' ? [candidate] : [];
      return {
        ok: true,
        list: {
          items: documents.map((document, index) => ({
            key: `${active}-${index}`,
            title: document.title,
            document,
          })),
          skipped: 0,
          total: documents.length,
          captured: documents.length,
        },
      };
    }
    if (request.type === 'list.advance') {
      return { ok: true, advance: { collapsed: 0, loaded: 0 } };
    }
    if (request.type === 'extract.document') {
      const currentUrl = tabs.created.at(-1)?.url;
      if (currentUrl === candidate.canonicalUrl) {
        return {
          ok: true,
          document: {
            ...candidate,
            html: `<p>${detailText}</p><a href="${articleUrl}">阅读全文</a>`,
            text: detailText,
            truncated: detailTruncated,
            sourceMetadata: {
              ...candidate.sourceMetadata,
              topicId: '744444444444441',
              sourceBodyProven: true,
              sourceMediaProven: true,
              sourceCoversDom: true,
            },
          },
        };
      }
      if (currentUrl === articleUrl) {
        return {
          ok: true,
          document: {
            ...candidate,
            kind: 'article',
            url: articleUrl,
            canonicalUrl: articleUrl,
            title: '链接长文完整正文',
            html: `<p>${articleText}</p>`,
            text: articleText,
            truncated: false,
          },
        };
      }
    }
    throw new Error(`unexpected ${request.type} for ${tabs.created.at(-1)?.url ?? '(none)'}`);
  };
  const runner = new JobRunner({
    tabs,
    bridge,
    waitForTabComplete: async () => undefined,
    delay: async () => undefined,
  });
  const phases: Array<{ rejections?: Record<string, number> }> = [];
  return { tabs, bridge, runner, candidate, detailText, articleText, phases };
}

describe('extension job runner', () => {
  it('trusts catalog completeness only when it carries the current protocol', () => {
    expect(trustedZsxqContentCompleteness({ contentComplete: true })).toBeUndefined();
    expect(trustedZsxqContentCompleteness({
      contentComplete: true,
      contentCompletenessVersion: 'zsxq-complete-content-v1',
    })).toBeUndefined();
    expect(trustedZsxqContentCompleteness({
      contentComplete: true,
      contentCompletenessVersion: ZSXQ_COMPLETE_CONTENT_CAPABILITY,
    })).toBe(true);
    expect(trustedZsxqContentCompleteness({ contentComplete: false })).toBe(false);
  });

  it('processes owner history page-wise with exact and semantic dedupe before completion', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    const ownerDocument = (id: string, title: string, text: string): CollectedDocument => ({
      ...topic(id),
      title,
      text,
      html: `<p>${text}</p>`,
      publishedAt: '2026-08-24T10:00:00.000Z',
      sourceMetadata: { authorRole: 'owner', topicId: id },
    });
    const exact = ownerDocument('80001', '投资复盘', '投资经营复盘正文'.repeat(20));
    const semantic = ownerDocument('80002', '投资复盘副本', '投资经营复盘语义正文'.repeat(20));
    const repair = ownerDocument('80003', '创业修复', '创业经营完整正文'.repeat(20));
    const fresh = ownerDocument('80004', '财富新内容', '财富与职业认知完整正文'.repeat(20));
    const irrelevant = ownerDocument('80005', '天气闲聊', '今天空气很好适合散步'.repeat(20));
    const semanticStoredUrl = `${LIST_URL}/topic/79999`;
    const knownIndex: ZsxqLibraryIndexEntry[] = [
      { id: '111111111111', url: exact.canonicalUrl, topicId: '80001', contentComplete: true },
      {
        id: '222222222222',
        url: semanticStoredUrl,
        topicId: '79999',
        contentComplete: true,
        publishedAt: semantic.publishedAt,
        authorRole: 'owner',
        semanticSignature: zsxqSemanticSignature({
          publishedAt: semantic.publishedAt!,
          authorRole: 'owner',
          text: semantic.text,
        }),
      },
      { id: '333333333333', url: repair.canonicalUrl, topicId: '80003', contentComplete: false },
    ];
    tabs.sendMessage = async (_tabId, message) => {
      const request = message as { type: string };
      tabs.asked.push(request.type);
      if (request.type === 'list.apiCollectOwnerPage') {
        return {
          ok: true,
          ownerPage: {
            documents: [exact, semantic, repair, fresh, irrelevant],
            businessSkips: [{
              url: `${LIST_URL}/topic/80006`,
              reason: '打新内容',
              publishedAt: '2026-08-24T09:00:00.000Z',
            }],
            rawCount: 6,
            pageKey: 'start:80001,80002,80003,80004,80005,80006',
            exhausted: true,
            newestObservedAt: '2026-08-24T10:00:00.000Z',
            oldestObservedAt: '2026-08-24T09:00:00.000Z',
            context: { ownerId: '1001', ownerName: '陈老师', scope: 'by_owner' },
          },
        } as never;
      }
      throw new Error(`unexpected ${request.type}`);
    };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
      knownZsxqIndex: async () => knownIndex,
    });
    bridge.terminalAck = async () => {
      expect(bridge.sent.filter(message => message.type === 'job.result')).toHaveLength(0);
    };
    const phases: Array<Record<string, unknown>> = [];

    await runner.runZsxqCollectionPlan(
      'owner-history-page-order',
      PLAN_ATTEMPT,
      result => {
        if ('checkpoint' in result) expect(bridge.terminalWaits).toHaveLength(2);
        phases.push(result as unknown as Record<string, unknown>);
      },
      { zsxqMode: 'owner-history', targetDays: [] },
    );

    expect(tabs.asked).toEqual(['list.apiCollectOwnerPage']);
    expect(bridge.createdFor).toEqual([repair.canonicalUrl, fresh.canonicalUrl]);
    expect(bridge.terminalWaits).toEqual([
      { jobId: 'current-job', attempt: PLAN_ATTEMPT },
      { jobId: 'current-job-2', attempt: PLAN_ATTEMPT },
    ]);
    expect(phases.at(-1)).toMatchObject({
      prepared: true,
      checkpoint: { mode: 'owner-history', pagesFetched: 1, exhausted: true },
      ownerAudit: {
        mode: 'owner-history', observed: 6, qualifying: 4,
        exactDuplicates: 1, semanticDuplicates: 1, filtered: 2,
        knownComplete: 1, repaired: 1, saved: 2, failed: 0,
        exhausted: true, safetyCapReached: false,
      },
      dayDrafts: [expect.objectContaining({
        day: '2026-08-24', qualifyingCount: 4, filteredCount: 2,
        exactDuplicateCount: 1, semanticDuplicateCount: 1,
        knownCompleteCount: 1, repairCount: 1, candidateCount: 2,
        savedCount: 2, failedCount: 0, crossedDayBoundary: true,
        itemFacts: [
          expect.objectContaining({ url: exact.canonicalUrl, outcome: 'exact' }),
          expect.objectContaining({ url: semantic.canonicalUrl, outcome: 'semantic' }),
          expect.objectContaining({ url: repair.canonicalUrl, outcome: 'repaired' }),
          expect.objectContaining({ url: fresh.canonicalUrl, outcome: 'saved' }),
        ],
      })],
    });
  });

  it('reports a zero-count boundary update when a later owner page crosses the prior page day', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    const first = {
      ...topic('80007'),
      title: '投资复盘',
      text: '投资经营复盘正文'.repeat(20),
      publishedAt: '2026-08-24T10:00:00.000Z',
      sourceMetadata: { authorRole: 'owner', topicId: '80007' },
    } satisfies CollectedDocument;
    const pages = [{
      documents: [first],
      businessSkips: [],
      rawCount: 1,
      pageKey: 'start:80007',
      nextCursor: '2026-08-24T09:59:59.999Z',
      exhausted: false,
      newestObservedAt: first.publishedAt,
      oldestObservedAt: first.publishedAt,
      context: { ownerId: '1001', scope: 'by_owner' as const },
    }, {
      documents: [],
      businessSkips: [{
        url: `${LIST_URL}/topic/80008`,
        reason: '选题偏好过滤',
        publishedAt: '2026-08-23T09:00:00.000Z',
      }],
      rawCount: 1,
      pageKey: '2026-08-24T09:59:59.999Z:80008',
      exhausted: true,
      newestObservedAt: '2026-08-23T09:00:00.000Z',
      oldestObservedAt: '2026-08-23T09:00:00.000Z',
      context: { ownerId: '1001', scope: 'by_owner' as const },
    }];
    tabs.sendMessage = async () => ({ ok: true, ownerPage: pages.shift()! }) as never;
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      knownZsxqIndex: async () => [{
        id: '111111111111',
        url: first.canonicalUrl,
        topicId: '80007',
        contentComplete: true,
      }],
    });
    const phases: Array<Record<string, unknown>> = [];

    await runner.runZsxqCollectionPlan(
      'owner-history-boundary-update',
      PLAN_ATTEMPT,
      phase => { phases.push(phase as unknown as Record<string, unknown>); },
      { zsxqMode: 'owner-history', targetDays: [] },
    );

    expect(phases.at(-1)).toMatchObject({
      prepared: true,
      dayDrafts: expect.arrayContaining([
        expect.objectContaining({
          day: '2026-08-24',
          rawOwnerCount: 0,
          qualifyingCount: 0,
          crossedDayBoundary: true,
        }),
      ]),
    });
  });

  it('collects the bounded latest and digest views before daily owner-ledger pages', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    const known = {
      ...topic('80011'),
      title: '投资复盘',
      text: '投资经营复盘正文'.repeat(20),
      html: `<p>${'投资经营复盘正文'.repeat(20)}</p>`,
      publishedAt: '2026-08-24T10:00:00.000Z',
      sourceMetadata: { authorRole: 'owner', topicId: '80011' },
    } satisfies CollectedDocument;
    tabs.sendMessage = async (_tabId, message) => {
      const request = message as { type: string };
      tabs.asked.push(request.type);
      if (request.type === 'list.apiCollectOwnerPage') {
        return {
          ok: true,
          ownerPage: {
            documents: [known],
            businessSkips: [],
            rawCount: 1,
            pageKey: 'start:80011',
            exhausted: true,
            newestObservedAt: known.publishedAt,
            oldestObservedAt: known.publishedAt,
            context: { ownerId: '1001', ownerName: '陈老师', scope: 'by_owner' },
          },
        } as never;
      }
      throw new Error(`unexpected ${request.type}`);
    };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
      knownZsxqIndex: async () => [{
        id: '111111111111',
        url: known.canonicalUrl,
        topicId: '80011',
        publishedAt: known.publishedAt,
        authorRole: 'owner',
        contentComplete: true,
      }],
    });
    const collectViews = vi.spyOn(runner, 'collectZsxqPlanViews')
      .mockImplementation(async (_tabId, _views, audit) => {
        if (audit) audit.coverage['视图:最新'] = 1;
        return [known];
      });
    const phases: Array<Record<string, unknown>> = [];

    await runner.runZsxqCollectionPlan(
      'daily-views-and-ledger',
      PLAN_ATTEMPT,
      phase => { phases.push(phase as unknown as Record<string, unknown>); },
      { zsxqMode: 'daily-ledger', targetDays: ['2026-08-24'] },
    );

    expect(collectViews).toHaveBeenCalledWith(42, ['最新', '精华'], expect.any(Object));
    expect(tabs.asked).toEqual(['list.apiCollectOwnerPage']);
    expect(bridge.createdFor).toEqual([]);
    expect(phases.at(-1)).toMatchObject({
      discovered: 2,
      coverage: { '视图:最新': 1 },
      rejections: { 本机库已有完整正文: 2 },
    });
  });

  it('does not request the next owner page when a page receipt fails', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    const candidate = {
      ...topic('80101'),
      title: '投资经营复盘',
      text: '投资创业经营完整正文'.repeat(20),
      html: '<p>投资创业经营完整正文</p>',
      publishedAt: '2026-08-24T10:00:00.000Z',
      sourceMetadata: { authorRole: 'owner', topicId: '80101' },
    } satisfies CollectedDocument;
    let pageRequests = 0;
    tabs.sendMessage = async (_tabId, message) => {
      const request = message as { type: string };
      if (request.type !== 'list.apiCollectOwnerPage') {
        throw new Error(`unexpected ${request.type}`);
      }
      pageRequests += 1;
      return {
        ok: true,
        ownerPage: {
          documents: [candidate],
          businessSkips: Array.from({ length: 19 }, (_, index) => ({
            url: `${LIST_URL}/topic/${80200 + index}`,
            reason: '选题偏好过滤',
            publishedAt: '2026-08-24T09:00:00.000Z',
          })),
          rawCount: 20,
          pageKey: 'start:first-page',
          nextCursor: '2026-08-24T08:59:59.999Z',
          exhausted: false,
          newestObservedAt: '2026-08-24T10:00:00.000Z',
          oldestObservedAt: '2026-08-24T09:00:00.000Z',
          context: { ownerId: '1001', scope: 'by_owner' },
        },
      } as never;
    };
    bridge.terminalAck = async () => { throw new Error('持久化回执失败'); };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      knownZsxqIndex: async () => [],
    });
    const phases: Array<Record<string, unknown>> = [];

    await expect(runner.runZsxqCollectionPlan(
      'owner-page-receipt-failure',
      PLAN_ATTEMPT,
      phase => { phases.push(phase as unknown as Record<string, unknown>); },
      { zsxqMode: 'owner-history', targetDays: [] },
    )).rejects.toThrow('持久化回执失败');

    expect(pageRequests).toBe(1);
    expect(phases).toEqual([]);
  });

  it('does not checkpoint an owner page that contains an incomplete qualifying body', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    const candidate = {
      ...topic('80102'),
      title: '投资经营复盘',
      text: '投资创业经营正文'.repeat(20),
      html: '<p>投资创业经营正文</p>',
      truncated: true,
      publishedAt: '2026-08-24T10:00:00.000Z',
      sourceMetadata: {
        authorRole: 'owner',
        topicId: '80102',
        sourceBodyProven: true,
        sourceMediaProven: false,
      },
    } satisfies CollectedDocument;
    let pageRequests = 0;
    tabs.sendMessage = async (_tabId, message) => {
      const request = message as { type: string };
      if (request.type !== 'list.apiCollectOwnerPage') {
        throw new Error(`unexpected ${request.type}`);
      }
      pageRequests += 1;
      return {
        ok: true,
        ownerPage: {
          documents: [candidate],
          businessSkips: [],
          rawCount: 1,
          pageKey: 'start:incomplete-page',
          exhausted: true,
          newestObservedAt: candidate.publishedAt,
          oldestObservedAt: candidate.publishedAt,
          context: { ownerId: '1001', scope: 'by_owner' },
        },
      } as never;
    };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      knownZsxqIndex: async () => [],
    });
    const phases: Array<Record<string, unknown>> = [];

    await expect(runner.runZsxqCollectionPlan(
      'owner-page-incomplete-body',
      PLAN_ATTEMPT,
      phase => { phases.push(phase as unknown as Record<string, unknown>); },
      { zsxqMode: 'owner-history', targetDays: [] },
    )).rejects.toThrow(
      /CONTENT_COVERAGE_INCOMPLETE.*1 条.*80102.*sourceMediaProven=false/u,
    );

    expect(pageRequests).toBe(1);
    expect(bridge.createdFor).toEqual([]);
    expect(phases).toEqual([]);
  });

  it('fails closed when an owner page count cannot account for every returned item', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    tabs.sendMessage = async () => ({
      ok: true,
      ownerPage: {
        documents: [],
        businessSkips: [],
        rawCount: 1,
        pageKey: 'start:unaccounted',
        exhausted: true,
        context: { ownerId: '1001', scope: 'by_owner' },
      },
    }) as never;
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      knownZsxqIndex: async () => [],
    });

    await expect(runner.runZsxqCollectionPlan(
      'owner-page-unaccounted',
      PLAN_ATTEMPT,
      undefined,
      { zsxqMode: 'owner-history', targetDays: [] },
    )).rejects.toThrow(/OWNER_PAGE_INVALID.*rawCount/u);
    expect(bridge.createdFor).toEqual([]);
  });
  it('retries transient tab edit failures after 1/3/9 seconds but not authentication failures', async () => {
    const waits: number[] = [];
    let attempts = 0;
    const value = await retryTransientTabOperation(async () => {
      attempts += 1;
      if (attempts < 4) throw new Error('Tabs cannot be edited right now');
      return 'ok';
    }, async milliseconds => { waits.push(milliseconds); });

    expect(value).toBe('ok');
    expect(waits).toEqual([1_000, 3_000, 9_000]);
    const auth = vi.fn(async () => { throw new Error('AUTH_REQUIRED'); });
    await expect(retryTransientTabOperation(auth, async () => undefined)).rejects.toThrow('AUTH_REQUIRED');
    expect(auth).toHaveBeenCalledOnce();
  });

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
      if (request.type === 'list.restore') {
        return { ok: true, advance: { collapsed: 0, loaded: 0 } };
      }
      if (request.type === 'list.advance') {
        return { ok: true, advance: { collapsed: 0, loaded: 0 } };
      }
      throw new Error(`unexpected ${request.type}`);
    };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
    });

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

  it('pages within a plan view before switching to the next view', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    let active = '';
    let latestPage = 0;
    tabs.sendMessage = async (_id, message) => {
      const request = message as { type: string; label?: string };
      tabs.asked.push(request.type);
      if (request.type === 'list.selectView') {
        active = request.label ?? '';
        return { ok: true, selected: { label: active, topicIds: [] } } as never;
      }
      if (request.type === 'list.restore') {
        return { ok: true, advance: { collapsed: 0, loaded: 0 } };
      }
      if (request.type === 'extract.list') {
        const documents = active === '最新' && latestPage < 2
          ? [topic(String(9001 + latestPage))]
          : [];
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
      if (request.type === 'list.advance') {
        if (active === '最新' && latestPage === 0) {
          latestPage = 1;
          return { ok: true, advance: { collapsed: 1, loaded: 1 } };
        }
        return { ok: true, advance: { collapsed: 1, loaded: 0 } };
      }
      throw new Error(`unexpected ${request.type}`);
    };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
    });

    const documents = await runner.collectZsxqPlanViews(7);

    expect(documents.map(document => document.canonicalUrl)).toEqual([
      `${LIST_URL}/topic/9001`,
      `${LIST_URL}/topic/9002`,
    ]);
  });

  it('fails closed when the twelfth plan-view round still loads another page below the item cap', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    let page = 0;
    let advances = 0;
    tabs.sendMessage = async (_id, message) => {
      const request = message as { type: string; label?: string };
      if (request.type === 'list.selectView') {
        return { ok: true, selected: { label: request.label, topicIds: [] } } as never;
      }
      if (request.type === 'list.restore') {
        return { ok: true, advance: { collapsed: 0, loaded: 0 } };
      }
      if (request.type === 'extract.list') {
        const candidate = topic(String(91_000 + page));
        return {
          ok: true,
          list: {
            items: [{ key: `bounded-page-${page}`, title: candidate.title, document: candidate }],
            skipped: 0,
            total: 1,
            captured: 1,
          },
        } as never;
      }
      if (request.type === 'list.advance') {
        advances += 1;
        page += 1;
        return { ok: true, advance: { collapsed: 1, loaded: 1 } };
      }
      throw new Error(`unexpected ${request.type}`);
    };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
    });

    await expect(runner.collectZsxqPlanViews(7, ['最新']))
      .rejects.toThrow(/CONTENT_COVERAGE_INCOMPLETE.*最新.*12.*1/u);
    expect(advances).toBe(12);
  });

  it('fails closed when fixed-plan advance cannot prove that the view is exhausted', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    const candidate = topic('9003');
    tabs.sendMessage = async (_id, message) => {
      const request = message as { type: string; label?: string };
      if (request.type === 'list.selectView') {
        return { ok: true, selected: { label: request.label, topicIds: [] } } as never;
      }
      if (request.type === 'list.restore') {
        return { ok: true, advance: { collapsed: 0, loaded: 0 } };
      }
      if (request.type === 'extract.list') {
        return {
          ok: true,
          list: {
            items: [{ key: 'fixed-uncertain', title: candidate.title, document: candidate }],
            skipped: 0,
            total: 1,
            captured: 1,
          },
        };
      }
      if (request.type === 'list.advance') {
        return { ok: true, advance: { collapsed: 1, loaded: 0, uncertain: true } } as never;
      }
      throw new Error(`unexpected ${request.type}`);
    };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
    });

    await expect(runner.collectZsxqPlanViews(7, ['最新']))
      .rejects.toThrow(/CONTENT_ADVANCE_UNCERTAIN/u);
  });

  it('fails a fixed plan when one canonical URL has incompatible same-frame bodies', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    const base = topic('9004');
    const firstText = '同一 URL 的甲正文讨论长期投资和经营复盘。'.repeat(8);
    const secondText = '同一 URL 的乙正文却是另一条完全无关的职业建议。'.repeat(8);
    const documents = [
      { ...base, text: firstText, html: `<p>${firstText}</p>`, truncated: false },
      { ...base, text: secondText, html: `<p>${secondText}</p>`, truncated: false },
    ];
    tabs.sendMessage = async (_id, message) => {
      const request = message as { type: string; label?: string };
      if (request.type === 'list.selectView') {
        return { ok: true, selected: { label: request.label, topicIds: [] } } as never;
      }
      if (request.type === 'list.restore') {
        return { ok: true, advance: { collapsed: 0, loaded: 0 } };
      }
      if (request.type === 'extract.list') {
        return {
          ok: true,
          list: {
            items: documents.map((document, index) => ({
              key: `conflicting-copy-${index}`,
              title: document.title,
              document,
            })),
            skipped: 0,
            total: 2,
            captured: 2,
          },
        };
      }
      if (request.type === 'list.advance') {
        return { ok: true, advance: { collapsed: 2, loaded: 0 } };
      }
      throw new Error(`unexpected ${request.type}`);
    };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
    });

    await expect(runner.collectZsxqPlanViews(7, ['最新']))
      .rejects.toThrow(/CONTENT_COVERAGE_INCOMPLETE.*互不兼容/u);
  });

  it('keeps sampling all three ZSXQ views when the latest view reaches its per-view cap', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    let active = '';
    const latest = Array.from({ length: 20 }, (_, index) => topic(String(10_000 + index)));
    const byView: Record<string, CollectedDocument[]> = {
      '最新': latest,
      '精华': [topic('20001')],
      '只看星主': [topic('30001')],
    };
    const extractedViews: string[] = [];
    tabs.sendMessage = async (_id, message) => {
      const request = message as { type: string; label?: string };
      if (request.type === 'list.selectView') {
        active = request.label ?? '';
        return { ok: true, selected: { label: active, topicIds: [] } } as never;
      }
      if (request.type === 'list.restore') {
        return { ok: true, advance: { collapsed: 0, loaded: 0 } };
      }
      if (request.type === 'extract.list') {
        extractedViews.push(active);
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
      if (request.type === 'list.advance') {
        return { ok: true, advance: { collapsed: 0, loaded: 0 } };
      }
      throw new Error(`unexpected ${request.type}`);
    };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
    });

    const documents = await runner.collectZsxqPlanViews(7);

    expect([...new Set(extractedViews)]).toEqual(['最新', '精华', '只看星主']);
    expect(documents).toHaveLength(22);
    expect(documents.map(document => document.canonicalUrl)).toContain(`${LIST_URL}/topic/20001`);
    expect(documents.map(document => document.canonicalUrl)).toContain(`${LIST_URL}/topic/30001`);
  });

  it('fails closed when neither DOM nor signed API can prove a required ZSXQ view', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    let active = '';
    let latestAttempts = 0;
    const valid = (id: string): CollectedDocument => ({
      ...topic(id),
      title: `投资创业复盘 ${id}`,
      text: '这是陈老师关于投资、创业和经营的完整复盘。',
      publishedAt: '2026-08-24T10:00:00.000Z',
      truncated: false,
      sourceMetadata: { authorRole: 'owner' },
    });
    tabs.sendMessage = async (_id, message) => {
      const request = message as { type: string; label?: string };
      if (request.type === 'list.selectView') {
        active = request.label ?? '';
        return { ok: true, selected: { label: active, topicIds: [] } } as never;
      }
      if (request.type === 'list.restore') {
        return { ok: true, advance: { collapsed: 0, loaded: 0 } };
      }
      if (request.type === 'extract.list') {
        if (active === '最新') {
          latestAttempts += 1;
          return {
            ok: true,
            list: {
              items: Array.from({ length: 20 }, (_, index) => ({
                key: `missing-${index}`,
                title: `无法证明的第 ${index + 1} 条`,
                reason: '这条帖子的编号没截到，所以无法确定它自己的网址',
              })),
              skipped: 20,
              total: 20,
              captured: 0,
            },
          } as never;
        }
        const document = valid(active === '精华' ? 'coverage-elite' : 'coverage-owner');
        return {
          ok: true,
          list: {
            items: [{ key: active, title: document.title, document }],
            skipped: 0,
            total: 1,
            captured: 1,
          },
        } as never;
      }
      if (request.type === 'list.advance') {
        return { ok: true, advance: { collapsed: 0, loaded: 0 } };
      }
      if (request.type === 'list.apiCollect') {
        return {
          ok: false,
          error: {
            code: 'COLLECTION_FAILED',
            message: 'CONTENT_COVERAGE_INCOMPLETE（ZSXQ_API_TOPIC_UNPROVEN）：签名接口仍无法形成可验证文档',
          },
        } as never;
      }
      throw new Error(`unexpected ${request.type}`);
    };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
    });
    const phases: Array<{ prepared: boolean }> = [];

    await expect(runner.runZsxqCollectionPlan(
      'coverage-gap',
      PLAN_ATTEMPT,
      result => { phases.push(result); },
    )).rejects.toThrow(/CONTENT_COVERAGE_INCOMPLETE.*签名接口/u);

    expect(phases.some(phase => phase.prepared)).toBe(false);
    expect(bridge.createdFor).toEqual([]);
    expect(bridge.sent.some(message => message.type === 'job.result')).toBe(false);
    expect(latestAttempts).toBe(11);
  });

  it('refreshes an already-active fixed-plan view once to recover missing topic identities', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    const recovered = topic('73200');
    let refreshed = false;
    let refreshRequests = 0;
    tabs.sendMessage = async (_id, message) => {
      const request = message as { type: string; label?: string };
      if (request.type === 'list.selectView') {
        return { ok: true, selected: { label: request.label, topicIds: [] } } as never;
      }
      if (request.type === 'list.restore') {
        return { ok: true, advance: { collapsed: 0, loaded: 0 } };
      }
      if (request.type === 'list.refreshTopics') {
        refreshRequests += 1;
        refreshed = true;
        return { ok: true, refresh: { toggled: true, category: '最新' } } as never;
      }
      if (request.type === 'extract.list') {
        return refreshed
          ? {
              ok: true,
              list: {
                items: [{ key: 'recovered-topic', title: recovered.title, document: recovered }],
                skipped: 0,
                total: 1,
                captured: 1,
              },
            }
          : {
              ok: true,
              list: {
                items: [{
                  key: 'missing-topic-id',
                  title: '已显示但尚未绑定帖子编号',
                  reason: '这条帖子的编号没截到，所以无法确定它自己的网址',
                  skipKind: 'coverage-risk',
                }],
                skipped: 1,
                total: 1,
                captured: 0,
              },
            } as never;
      }
      if (request.type === 'list.advance') {
        return { ok: true, advance: { collapsed: 0, loaded: 0 } };
      }
      throw new Error(`unexpected ${request.type}`);
    };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
    });

    const documents = await runner.collectZsxqPlanViews(7, ['最新']);

    expect(documents.map(document => document.canonicalUrl)).toEqual([
      `${LIST_URL}/topic/73200`,
    ]);
    expect(refreshRequests).toBe(1);
  });

  it('retries a transient coverage-risk frame before accepting the stable document frame', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    let active = '';
    let latestAttempts = 0;
    const stable = topic('73201');
    tabs.sendMessage = async (_id, message) => {
      const request = message as { type: string; label?: string };
      if (request.type === 'list.selectView') {
        active = request.label ?? '';
        return { ok: true, selected: { label: active, topicIds: [] } } as never;
      }
      if (request.type === 'list.restore') {
        return { ok: true, advance: { collapsed: 0, loaded: 0 } };
      }
      if (request.type === 'extract.list') {
        if (active !== '最新') {
          return { ok: true, list: { items: [], skipped: 0, total: 0, captured: 0 } } as never;
        }
        latestAttempts += 1;
        return latestAttempts === 1
          ? {
              ok: true,
              list: {
                items: [{
                  key: 'same-topic-node',
                  title: '正文尚在渲染',
                  reason: '正文太短或为空',
                  skipKind: 'coverage-risk',
                }],
                skipped: 1,
                total: 1,
                captured: 0,
              },
            } as never
          : {
              ok: true,
              list: {
                items: [{ key: 'same-topic-node', title: stable.title, document: stable }],
                skipped: 0,
                total: 1,
                captured: 1,
              },
            } as never;
      }
      if (request.type === 'list.advance') {
        return { ok: true, advance: { collapsed: 0, loaded: 0 } };
      }
      throw new Error(`unexpected ${request.type}`);
    };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
    });

    const documents = await runner.collectZsxqPlanViews(7);

    expect(documents.map(document => document.canonicalUrl)).toEqual([stable.canonicalUrl]);
    // 首帧风险解除后，仍需从完整正文首次出现起连续稳定 24 秒。
    expect(latestAttempts).toBe(9);
  });

  it('keeps a structured business skip auditable without treating it as a coverage outage', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T00:30:00.000Z'));
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    let active = '';
    const accepted = {
      ...topic('73101'),
      title: '投资创业完整复盘',
      text: '这是陈老师关于投资、创业和经营的完整复盘。',
      publishedAt: '2026-08-24T10:00:00.000Z',
      truncated: false,
      sourceMetadata: { authorRole: 'owner' },
    } satisfies CollectedDocument;
    const filteredUrl = `${LIST_URL}/topic/73102`;
    tabs.sendMessage = async (_id, message) => {
      const request = message as { type: string; label?: string };
      if (request.type === 'list.selectView') {
        active = request.label ?? '';
        return { ok: true, selected: { label: active, topicIds: [] } } as never;
      }
      if (request.type === 'list.restore') {
        return { ok: true, advance: { collapsed: 0, loaded: 0 } };
      }
      if (request.type === 'extract.list') {
        return active === '最新'
          ? {
              ok: true,
              list: {
                items: [
                  { key: 'accepted', title: accepted.title, document: accepted },
                  {
                    key: 'filtered',
                    title: '打新活动',
                    reason: '打新（按选题偏好跳过，命中：新股）',
                    skipKind: 'business-filter',
                    url: filteredUrl,
                  },
                ],
                skipped: 1,
                total: 2,
                captured: 2,
              },
            } as never
          : {
              ok: true,
              list: { items: [], skipped: 0, total: 0, captured: 0 },
            } as never;
      }
      if (request.type === 'list.advance') {
        return { ok: true, advance: { collapsed: 0, loaded: 0 } };
      }
      throw new Error(`unexpected ${request.type}`);
    };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
    });
    const phases: Array<{
      discovered: number;
      prepared: boolean;
      coverage?: Record<string, number>;
      rejections?: Record<string, number>;
      rejectionDetails?: Array<{ url: string; reason: string }>;
    }> = [];

    await runner.runZsxqCollectionPlan(
      'business-filter-audit',
      PLAN_ATTEMPT,
      phase => { phases.push(phase); },
    );

    expect(bridge.createdFor).toEqual([accepted.canonicalUrl]);
    expect(phases.at(-1)).toMatchObject({
      discovered: 2,
      prepared: true,
      coverage: {
        '视图:最新': 2,
        '视图:精华': 0,
        '视图:只看星主': 0,
        '发布日期:2026-08-24': 1,
      },
      rejections: { '选题偏好过滤': 1 },
      rejectionDetails: [{ url: filteredUrl, reason: '选题偏好过滤' }],
    });
  });

  it('times out a content-script request instead of leaving a plan running forever', async () => {
    vi.useFakeTimers();
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    tabs.sendMessage = async () => new Promise(() => undefined);
    const runner = new JobRunner({ tabs, bridge, waitForTabComplete: async () => undefined });

    const pending = runner.collectZsxqPlanViews(7);
    const assertion = expect(pending).rejects.toThrow(/页面交互.*超时/u);
    await vi.advanceTimersByTimeAsync(60_001);

    await assertion;
  });

  it('backfills only new owner posts from the last 15 days with a trustworthy date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T10:00:00.000Z'));
    const knownUrl = `${LIST_URL}/topic/41004`;
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    let active = '';
    const planTopic = (
      id: string,
      publishedAt: string | undefined,
    ): CollectedDocument => ({
      ...topic(id),
      title: `投资创业复盘 ${id}`,
      text: '这是陈老师关于投资、创业和经营的完整复盘。',
      ...(publishedAt ? { publishedAt } : {}),
      sourceMetadata: { authorRole: 'owner' },
    });
    const candidates = [
      planTopic('41001', '2026-08-10T10:00:00.000Z'),
      planTopic('41002', '2026-08-07T09:59:59.000Z'),
      planTopic('41004', '2026-08-12T10:00:00.000Z'),
      {
        ...planTopic('41005', '2026-08-22T10:00:00.000Z'),
        truncated: true,
        sourceMetadata: {
          authorRole: 'owner',
          sourceBodyProven: true,
          sourceMediaProven: false,
          sourceCoversDom: true,
          extractionMode: 'signed-api-fallback',
          sourceMediaIssues: 'field:media_component:object-opaque_id',
        },
      },
      {
        ...planTopic('41006', '2026-08-22T11:00:00.000Z'),
        title: '老师，如果想投资黄金的话，最方便灵活的是买什么',
        text: '黄金 ETF 联结基金分为 A 和 C 两种，管理费和交易费不同。',
      },
    ];
    tabs.sendMessage = async (_id, message) => {
      const request = message as { type: string; label?: string };
      if (request.type === 'list.selectView') {
        active = request.label ?? '';
        return { ok: true, selected: { label: active, topicIds: [] } } as never;
      }
      if (request.type === 'list.restore') {
        return { ok: true, advance: { collapsed: 0, loaded: 0 } };
      }
      if (request.type === 'extract.list') {
        const documents = active === '最新' ? candidates : [];
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
      if (request.type === 'list.advance') {
        return { ok: true, advance: { collapsed: 0, loaded: 0 } };
      }
      throw new Error(`unexpected ${request.type}`);
    };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
      knownUrls: async () => new Set([knownUrl]),
    });

    const phases: Array<{
      rejections?: Record<string, number>;
      rejectionDetails?: Array<{ url: string; reason: string }>;
    }> = [];
    await runner.runZsxqCollectionPlan('backfill-15-days', PLAN_ATTEMPT, result => {
      phases.push(result as {
        rejections?: Record<string, number>;
        rejectionDetails?: Array<{ url: string; reason: string }>;
      });
    });

    expect(bridge.createdFor).toEqual([
      `${LIST_URL}/topic/41006`,
      `${LIST_URL}/topic/41001`,
    ]);
    expect(bridge.createdContexts).toEqual([
      expect.objectContaining({ attempt: PLAN_ATTEMPT }),
      expect.objectContaining({ attempt: PLAN_ATTEMPT }),
    ]);
    expect(phases.at(-1)?.rejections).toEqual({
      '超出15天': 1,
      '本机库已有': 1,
      '正文不完整': 1,
    });
    expect(phases.at(-1)?.rejectionDetails).toEqual([
      { url: `${LIST_URL}/topic/41002`, reason: '超出15天' },
      { url: `${LIST_URL}/topic/41004`, reason: '本机库已有' },
      {
        url: `${LIST_URL}/topic/41005`,
        reason: '正文不完整',
        evidence: 'sourceBodyProven=true; sourceMediaProven=false; sourceCoversDom=true; '
          + 'extractionMode=signed-api-fallback; textLength=21; images=0; '
          + 'linkedArticle=false; truncatedBefore=true; truncatedAfter=true; '
          + 'sourceMediaIssues=field:media_component:object-opaque_id',
      },
    ]);
    const saved = bridge.sent.find(message => message.type === 'job.result');
    expect(saved?.payload).toMatchObject({
      document: {
        userCategory: '投资',
        sourceMetadata: {
          planId: 'zsxq-chen-teacher',
          batchId: 'backfill-15-days',
          windowDays: '15',
        },
      },
    });
    const gold = bridge.sent.find(message =>
      (message.payload as { document?: CollectedDocument }).document?.canonicalUrl
        === `${LIST_URL}/topic/41006`);
    expect(gold?.payload).toMatchObject({ document: { userCategory: '投资' } });
  });

  it('rejects only proven members and fails closed on missing author or date proof', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T00:30:00.000Z'));
    const candidate = (
      id: string,
      authorRole: 'owner' | 'member' | undefined,
      publishedAt: string | null = '2026-08-24T10:00:00.000Z',
    ): CollectedDocument => ({
      ...topic(id),
      title: `投资创业复盘 ${id}`,
      text: '这是陈老师关于投资、创业和经营的完整复盘。',
      truncated: false,
      ...(publishedAt ? { publishedAt } : {}),
      ...(authorRole ? { sourceMetadata: { authorRole } } : {}),
    });
    const setup = (documents: CollectedDocument[]) => {
      const tabs = new InMemoryTabs();
      const bridge = new InMemoryBridge();
      const runner = new JobRunner({
        tabs,
        bridge,
        waitForTabComplete: async () => undefined,
        delay: async () => undefined,
      });
      vi.spyOn(runner, 'collectZsxqPlanViews').mockResolvedValue(documents);
      const phases: Array<{
        prepared: boolean;
        rejections?: Record<string, number>;
      }> = [];
      return { bridge, runner, phases };
    };

    const proven = setup([
      candidate('proof-owner', 'owner'),
      candidate('proof-member', 'member'),
    ]);
    await proven.runner.runZsxqCollectionPlan(
      'proven-author-roles',
      PLAN_ATTEMPT,
      phase => { proven.phases.push(phase); },
    );
    expect(proven.bridge.createdFor).toEqual([`${LIST_URL}/topic/proof-owner`]);
    expect(proven.phases.at(-1)?.rejections).toEqual({ '非星主': 1 });

    const unknownAuthor = setup([
      candidate('known-owner', 'owner'),
      candidate('unknown-author', undefined),
    ]);
    await expect(unknownAuthor.runner.runZsxqCollectionPlan(
      'unknown-author-proof',
      PLAN_ATTEMPT,
      phase => { unknownAuthor.phases.push(phase); },
    )).rejects.toThrow(/AUTHOR_IDENTITY_UNPROVEN.*unknown-author/u);
    expect(unknownAuthor.bridge.createdFor).toEqual([]);
    expect(unknownAuthor.phases.some(phase => phase.prepared)).toBe(false);

    const missingDate = setup([
      candidate('dated-owner', 'owner'),
      candidate('missing-date', 'owner', null),
    ]);
    await expect(missingDate.runner.runZsxqCollectionPlan(
      'missing-date-proof',
      PLAN_ATTEMPT,
      phase => { missingDate.phases.push(phase); },
    )).rejects.toThrow(/PUBLISHED_AT_UNPROVEN.*missing-date/u);
    expect(missingDate.bridge.createdFor).toEqual([]);
    expect(missingDate.phases.some(phase => phase.prepared)).toBe(false);
  });

  it('completes a linked ZSXQ article before filtering a feed preview', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T00:30:00.000Z'));
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    const candidate = {
      ...topic('42001'),
      title: '投资创业完整复盘',
      text: '这里是导语，正文需要从链接长文补齐。',
      html: '<p>这里是导语，正文需要从链接长文补齐。</p><a href="https://articles.zsxq.com/id_plan.html">全文</a>',
      // 合法“全文”链接本身不再算截断；true 只留给另一个真实残留控件。
      truncated: false,
      publishedAt: '2026-08-24T10:00:00.000Z',
      sourceMetadata: { authorRole: 'owner' },
    } satisfies CollectedDocument;
    const legacyCandidate = {
      ...topic('42002'),
      title: '这篇文章的导语',
      text: '这里只留下了一段没有主题关键词的导语。',
      html: '<p>这里只留下了一段没有主题关键词的导语。</p><a href="https://articles.zsxq.com/id_legacy.html">全文</a>',
      publishedAt: '2026-08-24T11:00:00.000Z',
      sourceMetadata: { authorRole: 'owner' },
    } satisfies CollectedDocument;
    const completeCandidate = {
      ...topic('42003'),
      title: '已完整入库的投资长文',
      text: '这条已经完整入库，不应每天重复打开长文页。',
      html: '<p>这条已经完整入库，不应每天重复打开长文页。</p><a href="https://articles.zsxq.com/id_complete.html">全文</a>',
      publishedAt: '2026-08-24T12:00:00.000Z',
      sourceMetadata: { authorRole: 'owner' },
    } satisfies CollectedDocument;
    const plainIncompleteCandidate = {
      ...topic('42004'),
      title: '已重新展开的投资普通帖',
      text: '本轮页面已经拿到投资与经营复盘的完整普通帖正文。',
      html: '<p>本轮页面已经拿到投资与经营复盘的完整普通帖正文。</p>',
      publishedAt: '2026-08-24T15:00:00.000Z',
      sourceMetadata: { authorRole: 'owner' },
    } satisfies CollectedDocument;
    const plainUnknownCandidate = {
      ...topic('42005'),
      title: '历史状态未知的创业普通帖',
      text: '这次重新采集已经确认创业与商业模式正文完整。',
      html: '<p>这次重新采集已经确认创业与商业模式正文完整。</p>',
      publishedAt: '2026-08-24T14:00:00.000Z',
      sourceMetadata: { authorRole: 'owner' },
    } satisfies CollectedDocument;
    const plainCompleteCandidate = {
      ...topic('42006'),
      title: '已确认完整的投资普通帖',
      text: '已确认完整的投资正文不应重复覆盖。',
      html: '<p>已确认完整的投资正文不应重复覆盖。</p>',
      publishedAt: '2026-08-24T13:00:00.000Z',
      sourceMetadata: { authorRole: 'owner' },
    } satisfies CollectedDocument;
    const articleText = '这里是链接文章中的完整正文，包含投资、创业与经营复盘。'.repeat(10);
    let active = '';
    tabs.sendMessage = async (_id, message) => {
      const request = message as { type: string; label?: string };
      if (request.type === 'list.selectView') {
        active = request.label ?? '';
        return { ok: true, selected: { label: active, topicIds: [] } } as never;
      }
      if (request.type === 'list.restore') {
        return { ok: true, advance: { collapsed: 0, loaded: 0 } };
      }
      if (request.type === 'extract.list') {
        const documents = active === '最新'
          ? [
              candidate,
              legacyCandidate,
              completeCandidate,
              plainIncompleteCandidate,
              plainUnknownCandidate,
              plainCompleteCandidate,
            ]
          : [];
        return {
          ok: true,
          list: {
            items: documents.map((document, index) => ({
              key: `${active}-${index}`,
              title: document.title,
              document,
            })),
            skipped: 0,
            total: documents.length,
            captured: documents.length,
          },
        };
      }
      if (request.type === 'list.advance') {
        return { ok: true, advance: { collapsed: 0, loaded: 0 } };
      }
      if (request.type === 'extract.document') {
        const currentArticleUrl = tabs.created.at(-1)?.url;
        if (!currentArticleUrl?.startsWith('https://articles.zsxq.com/')) {
          throw new Error(`unexpected extract.document for ${currentArticleUrl ?? '(none)'}`);
        }
        return {
          ok: true,
          document: {
            ...candidate,
            kind: 'article',
            url: currentArticleUrl,
            canonicalUrl: currentArticleUrl,
            title: '完整长文',
            html: `<p>${articleText}</p>`,
            text: articleText,
            truncated: false,
          },
        };
      }
      throw new Error(`unexpected ${request.type}`);
    };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
      // 旧逻辑可能已经把同 URL 的半篇内容存进本机库；截断或完整性未知都要允许覆盖修复。
      knownUrls: async () => new Set([
        candidate.canonicalUrl,
        legacyCandidate.canonicalUrl,
        completeCandidate.canonicalUrl,
        plainIncompleteCandidate.canonicalUrl,
        plainUnknownCandidate.canonicalUrl,
        plainCompleteCandidate.canonicalUrl,
      ]),
      knownContent: async () => new Map([
        [candidate.canonicalUrl, false],
        [legacyCandidate.canonicalUrl, undefined],
        [completeCandidate.canonicalUrl, true],
        [plainIncompleteCandidate.canonicalUrl, false],
        [plainUnknownCandidate.canonicalUrl, undefined],
        [plainCompleteCandidate.canonicalUrl, true],
      ]),
    });
    const phases: Array<{
      rejections?: Record<string, number>;
      rejectionDetails?: Array<{ url: string; reason: string }>;
    }> = [];

    await runner.runZsxqCollectionPlan('linked-article-completion', PLAN_ATTEMPT, result => {
      phases.push(result as typeof phases[number]);
    });

    expect(tabs.created.map(item => item.url)).toContain('https://articles.zsxq.com/id_plan.html');
    expect(tabs.created.map(item => item.url)).not.toContain('https://articles.zsxq.com/id_complete.html');
    expect(bridge.createdFor).toEqual([
      plainIncompleteCandidate.canonicalUrl,
      plainUnknownCandidate.canonicalUrl,
      legacyCandidate.canonicalUrl,
      candidate.canonicalUrl,
    ]);
    const savedDocuments = bridge.sent
      .filter(message => message.type === 'job.result')
      .map(message => (message.payload as { document: CollectedDocument }).document);
    expect(savedDocuments).toHaveLength(4);
    expect(savedDocuments).toEqual(expect.arrayContaining([
      expect.objectContaining({ canonicalUrl: candidate.canonicalUrl, truncated: false }),
      expect.objectContaining({ canonicalUrl: legacyCandidate.canonicalUrl, truncated: false }),
      expect.objectContaining({ canonicalUrl: plainIncompleteCandidate.canonicalUrl, truncated: false }),
      expect.objectContaining({ canonicalUrl: plainUnknownCandidate.canonicalUrl, truncated: false }),
    ]));
    expect(savedDocuments
      .filter(document => [candidate.canonicalUrl, legacyCandidate.canonicalUrl]
        .includes(document.canonicalUrl))
      .every(document => document.text.includes(articleText))).toBe(true);
    expect(phases.at(-1)?.rejections?.['正文不完整']).toBeUndefined();
    expect(phases.at(-1)?.rejections?.['本机库已有']).toBe(2);
    expect(phases.at(-1)?.rejectionDetails).toEqual([
      { url: completeCandidate.canonicalUrl, reason: '本机库已有' },
      { url: plainCompleteCandidate.canonicalUrl, reason: '本机库已有' },
    ]);
  });

  it('accepts an initially truncated linked preview only after topic detail and article are both complete', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T00:30:00.000Z'));
    const fixture = linkedPreviewPlanFixture(false);

    await fixture.runner.runZsxqCollectionPlan(
      'linked-preview-detail-complete',
      PLAN_ATTEMPT,
      phase => { fixture.phases.push(phase); },
    );

    expect(fixture.tabs.created.map(tab => tab.url)).toEqual(expect.arrayContaining([
      fixture.candidate.canonicalUrl,
      'https://articles.zsxq.com/id_detailproof.html',
    ]));
    expect(fixture.bridge.createdFor).toEqual([fixture.candidate.canonicalUrl]);
    const saved = fixture.bridge.sent.find(message => message.type === 'job.result');
    expect((saved?.payload as { document: CollectedDocument }).document).toMatchObject({
      canonicalUrl: fixture.candidate.canonicalUrl,
      truncated: false,
      text: expect.stringContaining(fixture.detailText),
    });
    expect((saved?.payload as { document: CollectedDocument }).document.text)
      .toContain(fixture.articleText);
    expect(fixture.phases.at(-1)?.rejections?.['正文不完整']).toBeUndefined();
  });

  it('rejects an initially truncated linked preview when topic detail remains incomplete', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T00:30:00.000Z'));
    const fixture = linkedPreviewPlanFixture(true);

    await fixture.runner.runZsxqCollectionPlan(
      'linked-preview-detail-incomplete',
      PLAN_ATTEMPT,
      phase => { fixture.phases.push(phase); },
    );

    expect(fixture.tabs.created.map(tab => tab.url)).toContain(fixture.candidate.canonicalUrl);
    expect(fixture.bridge.createdFor).toEqual([]);
    expect(fixture.bridge.sent.some(message => message.type === 'job.result')).toBe(false);
    expect(fixture.phases.at(-1)?.rejections?.['正文不完整']).toBe(1);
  });

  it('discovers and collects an article anchor that appears only after topic-detail recovery', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T00:30:00.000Z'));
    const fixture = linkedPreviewPlanFixture(false, false);

    await fixture.runner.runZsxqCollectionPlan(
      'linked-anchor-from-topic-detail',
      PLAN_ATTEMPT,
      phase => { fixture.phases.push(phase); },
    );

    expect(fixture.tabs.created.map(tab => tab.url)).toContain(
      'https://articles.zsxq.com/id_detailproof.html',
    );
    const saved = fixture.bridge.sent.find(message => message.type === 'job.result');
    expect((saved?.payload as { document: CollectedDocument }).document).toMatchObject({
      truncated: false,
      text: expect.stringContaining(fixture.articleText),
    });
  });

  it('bounds reconnect bursts, prioritizes interactive jobs, and closes every generated tab', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    const releases: Array<() => void> = [];
    let waits = 0;
    let markThirdCreated: (() => void) | undefined;
    const thirdCreated = new Promise<void>(resolve => { markThirdCreated = resolve; });
    const create = tabs.create.bind(tabs);
    tabs.create = async input => {
      const tab = await create(input);
      if (tabs.created.length === 3) markThirdCreated?.();
      return tab;
    };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => {
        waits += 1;
        if (waits <= 2) await new Promise<void>(resolve => { releases.push(resolve); });
      },
    });

    const urls = [1, 2, 3, 4].map(index => `https://mp.weixin.qq.com/s/background-test-${index}`);
    const first = runner.runRemoteJob('job-1', urls[0]!, false);
    const second = runner.runRemoteJob('job-2', urls[1]!, false);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(tabs.created).toHaveLength(2);
    const interactive = runner.runRemoteJob('job-3', urls[2]!, true);
    const fourth = runner.runRemoteJob('job-4', urls[3]!, false);

    releases[0]?.();
    await thirdCreated;
    expect(tabs.created.map(tab => tab.url)).toEqual([urls[0], urls[1], urls[2]]);

    releases[1]?.();
    await Promise.all([first, second, interactive, fourth]);
    expect(tabs.created.map(tab => tab.url)).toEqual(urls);
    expect(tabs.handedOff).toEqual([]);
    expect(tabs.removed).toEqual([42, 42, 42, 42]);
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

    expect(tabs.created).toEqual([{ url: URL, active: false, purpose: 'remote-job' }]);
    expect(tabs.removed).toEqual([42]);
    expect(bridge.sent.map(message => message.type)).toEqual(['job.progress', 'job.result']);
    expect(bridge.sent[1]).toMatchObject({ requestId: 'job-1', payload: { document: { title: '后台任务测试文章' } } });
  });

  it('marks a fully rendered ordinary ZSXQ remote job explicitly complete', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    const complete = { ...topic('ordinary-complete'), truncated: false };
    tabs.response = { ok: true, document: complete };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
    });

    await runner.runRemoteJob('ordinary-zsxq', complete.canonicalUrl);

    expect(bridge.sent.at(-1)).toMatchObject({
      type: 'job.result',
      requestId: 'ordinary-zsxq',
      payload: { document: { canonicalUrl: complete.canonicalUrl, truncated: false } },
    });
  });

  it('recovers an API-capped list body by opening the stable topic detail before saving', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    const preview = {
      ...topic('api-capped-detail'),
      text: 'A'.repeat(20_000),
      html: `<p>${'A'.repeat(20_000)}</p>`,
      truncated: true,
    };
    const full = {
      ...preview,
      text: `${preview.text}${'完整正文尾部与最终结论。'.repeat(500)}`,
      html: `<p>${preview.text}${'完整正文尾部与最终结论。'.repeat(500)}</p>`,
      truncated: false,
    };
    let detailSamples = 0;
    tabs.sendMessage = async () => {
      detailSamples += 1;
      return { ok: true, document: full };
    };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
    });

    const completed = await (runner as unknown as {
      withLinkedArticle(document: CollectedDocument): Promise<CollectedDocument>;
    }).withLinkedArticle(preview);

    expect(tabs.created).toContainEqual({
      url: preview.canonicalUrl,
      active: false,
      purpose: 'remote-job',
    });
    expect(completed.text).toBe(full.text);
    expect(completed.truncated).toBe(false);
    expect(detailSamples).toBe(9);
  });

  it('lets an equal compatible complete topic detail clear a transient list click-timeout risk', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    const text = '列表正文其实已经完整，只是展开点击瞬态超时留下了风险标记。'.repeat(12);
    const preview = {
      ...topic('74408'),
      html: `<p>${text}</p>`,
      text,
      truncated: true,
    };
    const detail = { ...preview, truncated: false };
    let detailSamples = 0;
    tabs.sendMessage = async () => {
      detailSamples += 1;
      return { ok: true, document: detail };
    };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
    });

    const completed = await (runner as unknown as {
      withLinkedArticle(document: CollectedDocument): Promise<CollectedDocument>;
    }).withLinkedArticle(preview);

    expect(completed.text).toBe(text);
    expect(completed.truncated).toBe(false);
    expect(detailSamples).toBe(9);
  });

  it('fails closed instead of carrying unproven list-only assets into an equal detail', async () => {
    const tabs = new InMemoryTabs();
    const text = '列表正文已经完整，但瞬态风险要求打开独立详情页再次证明。'.repeat(12);
    const articleUrl = 'https://articles.zsxq.com/id_detailassets.html';
    const previewImage = 'https://images.example/detail-preview.png';
    const preview = {
      ...topic('74410'),
      html: `<p>${text}</p><a href="${articleUrl}">阅读全文</a>`
        + `<img src="${previewImage}" alt="列表配图">`,
      text,
      images: [{ url: previewImage, alt: '列表配图' }],
      truncated: true,
    };
    const detail = {
      ...preview,
      html: `<p>${text}</p>`,
      images: [],
      truncated: false,
    };
    tabs.sendMessage = async () => {
      const currentUrl = tabs.created.at(-1)?.url;
      if (currentUrl === preview.canonicalUrl) {
        return { ok: true, document: detail };
      }
      throw new Error(`不应打开未经详情证明的列表长文：${currentUrl ?? '(none)'}`);
    };
    const runner = new JobRunner({
      tabs,
      bridge: new InMemoryBridge(),
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
    });

    const completed = await (runner as unknown as {
      withLinkedArticle(document: CollectedDocument): Promise<CollectedDocument>;
    }).withLinkedArticle(preview);

    expect(tabs.created.map(tab => tab.url)).toEqual([preview.canonicalUrl]);
    expect(completed.text).toBe(text);
    expect(completed.html).not.toContain(articleUrl);
    expect(completed.html).not.toContain(previewImage);
    expect(completed.images).toEqual([]);
    expect(completed.truncated).toBe(true);
  });

  it('fails closed when an equal detail omits an unproven list-only video resource', async () => {
    const tabs = new InMemoryTabs();
    const text = '列表与详情文字一致，但列表虚拟节点还残留上一帖的视频资源。'.repeat(12);
    const staleVideo = 'https://files.zsxq.com/stale-list-video.mp4';
    const preview = {
      ...topic('74412'),
      html: `<p>${text}</p><video controls><source src="${staleVideo}"></video>`,
      text,
      images: [],
      truncated: true,
      sourceMetadata: { sourceMediaProven: false },
    };
    const detail = {
      ...preview,
      html: `<p>${text}</p>`,
      truncated: false,
    };
    tabs.sendMessage = async () => ({ ok: true, document: detail });
    const runner = new JobRunner({
      tabs,
      bridge: new InMemoryBridge(),
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
    });

    const completed = await (runner as unknown as {
      withLinkedArticle(document: CollectedDocument): Promise<CollectedDocument>;
    }).withLinkedArticle(preview);

    expect(completed.html).not.toContain(staleVideo);
    expect(completed.truncated).toBe(true);
  });

  it('drops stale list assets when an equal detail has authoritative source-media proof', async () => {
    const tabs = new InMemoryTabs();
    const text = '帖子 B 正文已经正确，但列表虚拟节点仍短暂带着帖子 A 的资源。'.repeat(12);
    const staleArticle = 'https://articles.zsxq.com/id_stale_list_A.html';
    const staleImage = 'https://images.example/stale-list-A.png';
    const preview = {
      ...topic('74411'),
      html: `<p>${text}</p><a href="${staleArticle}">阅读全文</a>`
        + `<img src="${staleImage}" alt="上一帖配图">`,
      text,
      images: [{ url: staleImage, alt: '上一帖配图' }],
      truncated: true,
      sourceMetadata: { sourceMediaProven: false },
    };
    const detail = {
      ...preview,
      html: `<p>${text}</p>`,
      images: [],
      truncated: false,
      sourceMetadata: {
        topicId: '74411',
        sourceBodyProven: true,
        sourceMediaProven: true,
        sourceCoversDom: true,
      },
    };
    tabs.sendMessage = async () => {
      const currentUrl = tabs.created.at(-1)?.url;
      if (currentUrl === preview.canonicalUrl) return { ok: true, document: detail };
      throw new Error(`不应打开上一帖长文：${currentUrl ?? '(none)'}`);
    };
    const runner = new JobRunner({
      tabs,
      bridge: new InMemoryBridge(),
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
    });

    const completed = await (runner as unknown as {
      withLinkedArticle(document: CollectedDocument): Promise<CollectedDocument>;
    }).withLinkedArticle(preview);

    expect(tabs.created.map(tab => tab.url)).toEqual([preview.canonicalUrl]);
    expect(completed.html).not.toContain(staleArticle);
    expect(completed.html).not.toContain(staleImage);
    expect(completed.images).toEqual([]);
    expect(completed.truncated).toBe(false);
  });

  it('rejects conflicting, shorter, or still-truncated topic detail proofs', async () => {
    const previewText = '列表正文完整讨论投资组合、现金流和长期经营判断。'.repeat(12);
    const preview = {
      ...topic('74409'),
      html: `<p>${previewText}</p>`,
      text: previewText,
      truncated: true,
    };
    const cases: Array<{ name: string; detail: CollectedDocument }> = [
      {
        name: 'conflicting body',
        detail: {
          ...preview,
          html: `<p>${'详情页却是完全无关的团队管理与产品增长内容。'.repeat(30)}</p>`,
          text: '详情页却是完全无关的团队管理与产品增长内容。'.repeat(30),
          truncated: false,
        },
      },
      {
        name: 'shorter compatible body',
        detail: {
          ...preview,
          html: `<p>${previewText.slice(0, -30)}</p>`,
          text: previewText.slice(0, -30),
          truncated: false,
        },
      },
      {
        name: 'positive truncation evidence',
        detail: { ...preview, truncated: true },
      },
    ];

    for (const scenario of cases) {
      const tabs = new InMemoryTabs();
      tabs.sendMessage = async () => ({ ok: true, document: scenario.detail });
      const runner = new JobRunner({
        tabs,
        bridge: new InMemoryBridge(),
        waitForTabComplete: async () => undefined,
        delay: async () => undefined,
      });

      const completed = await (runner as unknown as {
        withLinkedArticle(document: CollectedDocument): Promise<CollectedDocument>;
      }).withLinkedArticle(preview);

      expect(completed.text, scenario.name).toBe(preview.text);
      expect(completed.truncated, scenario.name).toBe(true);
    }
  });

  it('rejects an old content listener that cannot attest the current extraction protocol', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    const candidate = { ...topic('old-listener'), truncated: false };
    tabs.response = { ok: true, document: candidate };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
      requireContentProtocol: true,
    });

    await runner.runRemoteJob('old-content-listener', candidate.canonicalUrl, false);

    expect(tabs.injected).toContain(42);
    expect(bridge.sent.some(message => message.type === 'job.result')).toBe(false);
    expect(bridge.sent.at(-1)).toMatchObject({
      type: 'job.error',
      payload: { code: 'CONTENT_SCRIPT_OUTDATED', needsAttention: true },
    });
  });

  it.each([
    ['extract.document', { ok: true, document: topic('attest-document') }],
    ['extract.list', {
      ok: true,
      list: { items: [], skipped: 0, total: 0, captured: 0 },
    }],
    ['list.selectView', {
      ok: true,
      selected: { label: '最新', topicIds: [] },
    }],
    ['list.restore', { ok: true, advance: { collapsed: 0, loaded: 0 } }],
    ['list.advance', { ok: true, advance: { collapsed: 0, loaded: 0 } }],
    ['list.refreshTopics', { ok: true, refresh: { toggled: false } }],
  ] as const)(
    'rejects missing and foreign exact-build attestations for %s responses',
    async (operation, payload) => {
      const expectedBuild = 'v0.4.29 · build-B';
      for (const attestation of [
        {},
        {
          contentProtocol: CONTENT_EXTRACTION_PROTOCOL,
          contentBuildId: 'v0.4.29 · build-A',
        },
      ]) {
        const tabs = new InMemoryTabs();
        tabs.response = { ...payload, ...attestation } as typeof tabs.response;
        const runner = new JobRunner({
          tabs,
          bridge: new InMemoryBridge(),
          waitForTabComplete: async () => undefined,
          delay: async () => undefined,
          requireContentProtocol: true,
          expectedContentBuildId: expectedBuild,
        });
        const ask = (runner as unknown as {
          ask(tabId: number, message: unknown): Promise<unknown>;
        }).ask.bind(runner);

        await expect(ask(42, {
          type: contentRequestType(operation, expectedBuild),
        })).rejects.toThrow(/CONTENT_SCRIPT_OUTDATED/u);
      }
    },
  );

  it('uses only exact-build request types while an old static listener is still present', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    const candidate = { ...topic('v2-controls'), truncated: false };
    const expectedBuild = 'v0.4.29 · build-B';
    const exact = (operation: string) => contentRequestType(operation, expectedBuild);
    const attestation = {
      contentProtocol: CONTENT_EXTRACTION_PROTOCOL,
      contentBuildId: expectedBuild,
    };
    let currentListenerInjected = false;
    const asked: string[] = [];
    tabs.inject = async id => {
      tabs.injected.push(id);
      currentListenerInjected = true;
    };
    tabs.sendMessage = async (_id, message) => {
      const type = String((message as { type?: unknown }).type ?? '');
      asked.push(type);
      // 页面里旧 listener 仍会回答这些静态 type；后台若误发，就会被它用 loaded:0 抢答。
      if (/\.(?:v2)$/u.test(type)) {
        return { ok: true, advance: { collapsed: 0, loaded: 0 } };
      }
      if (type === exact('list.selectView') && !currentListenerInjected) return undefined as never;
      if (type === exact('list.selectView')) {
        return {
          ok: true,
          ...attestation,
          selected: { label: '最新', topicIds: [] },
        };
      }
      if (type === exact('list.restore')) {
        return { ok: true, ...attestation, advance: { collapsed: 0, loaded: 0 } };
      }
      if (type === exact('extract.list')) {
        return {
          ok: true,
          ...attestation,
          list: {
            items: [{ key: 'v2-controls', title: candidate.title, document: candidate }],
            skipped: 0,
            total: 1,
            captured: 1,
          },
        };
      }
      if (type === exact('list.advance')) {
        return { ok: true, ...attestation, advance: { collapsed: 1, loaded: 0 } };
      }
      throw new Error(`没有当前 build listener 能处理：${type}`);
    };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
      requireContentProtocol: true,
      expectedContentBuildId: expectedBuild,
    });

    const documents = await runner.collectZsxqPlanViews(42, ['最新']);

    expect(documents).toEqual([expect.objectContaining({ canonicalUrl: candidate.canonicalUrl })]);
    expect(tabs.injected).toEqual([42]);
    expect(asked.slice(0, 3)).toEqual([
      exact('list.selectView'),
      exact('list.selectView'),
      exact('list.restore'),
    ]);
    expect(asked.filter(type => type === exact('extract.list'))).toHaveLength(9);
    expect(asked.at(-1)).toBe(exact('list.advance'));
    expect(asked.every(type => type.includes(expectedBuild))).toBe(true);
  });

  it('waits for build B advance instead of accepting build A loaded-zero first', async () => {
    vi.useFakeTimers();
    const tabs = new InMemoryTabs();
    tabs.activeTab = { id: 7, url: LIST_URL, status: 'complete' };
    const bridge = new InMemoryBridge();
    const expectedBuild = 'v0.4.29 · build-B';
    const exactA = (operation: string) => contentRequestType(operation, 'v0.4.29 · build-A');
    const exactB = (operation: string) => contentRequestType(operation, expectedBuild);
    const attestation = {
      contentProtocol: CONTENT_EXTRACTION_PROTOCOL,
      contentBuildId: expectedBuild,
    };
    const candidate = topic('late-build-b');
    const asked: string[] = [];
    tabs.sendMessage = async (_id, message) => {
      const type = String((message as { type?: unknown }).type ?? '');
      asked.push(type);
      // 旧 A/static listener 都会立即声称“到底了”；这些 type 不应被发送。
      if (type === 'list.advance.v2' || type === exactA('list.advance')) {
        return { ok: true, advance: { collapsed: 0, loaded: 0 } };
      }
      if (type === exactB('list.advance')) {
        return new Promise(resolve => {
          setTimeout(() => resolve({
            ok: true,
            ...attestation,
            advance: { collapsed: 0, loaded: 1 },
          }), 24_000);
        });
      }
      if (type === exactB('extract.list')) {
        return {
          ok: true,
          ...attestation,
          list: {
            items: [{ key: 'late-build-b', title: candidate.title, document: candidate }],
            skipped: 0,
            total: 1,
            captured: 1,
          },
        };
      }
      if (type === exactB('list.restore')) {
        return { ok: true, ...attestation, advance: { collapsed: 1, loaded: 0 } };
      }
      if (type === exactB('list.focusLast')) {
        return { ok: true, ...attestation, highlight: { found: true } };
      }
      throw new Error(`unexpected exact-build request: ${type}`);
    };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
      requireContentProtocol: true,
      expectedContentBuildId: expectedBuild,
    });

    let settled = false;
    const capture = runner.captureList({}, { continuation: true, maxItems: 1 })
      .then(result => {
        settled = true;
        return result;
      });
    await vi.advanceTimersByTimeAsync(23_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const summary = await capture;

    expect(summary).toMatchObject({ collected: 1, phase: 'capped' });
    expect(asked[0]).toBe(exactB('list.advance'));
    expect(asked).not.toContain('list.advance.v2');
    expect(asked).not.toContain(exactA('list.advance'));
  });

  it('fails a zero-document ZSXQ fixed plan before reporting a prepared success', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
    });
    vi.spyOn(runner, 'collectZsxqPlanViews').mockResolvedValue([]);
    const phases: Array<{ prepared: boolean }> = [];

    await expect(runner.runZsxqCollectionPlan(
      'zero-document-plan',
      PLAN_ATTEMPT,
      result => { phases.push(result); },
    )).rejects.toThrow(/CONTENT_EMPTY.*三个视图/u);

    expect(phases).toEqual([]);
    expect(bridge.createdFor).toEqual([]);
  });

  it('reloads its fresh plan tab once when the ZSXQ SPA shell stays blank', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T10:00:00.000Z'));
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    const completedLoads: number[] = [];
    const candidate = {
      ...topic('blank-shell-recovery'),
      title: '陈老师投资与创业复盘',
      text: '这是陈老师关于投资、创业和经营的完整复盘。',
      publishedAt: '2026-08-24T10:00:00.000Z',
      sourceMetadata: { authorRole: 'owner' },
    } satisfies CollectedDocument;
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async tabId => { completedLoads.push(tabId); },
      delay: async () => undefined,
    });
    const collect = vi.spyOn(runner, 'collectZsxqPlanViews')
      .mockRejectedValueOnce(new Error('页面上找不到「最新」标签（分类栏尚未渲染）'))
      .mockResolvedValueOnce([candidate]);

    await runner.runZsxqCollectionPlan(
      'blank-shell-recovery',
      PLAN_ATTEMPT,
      undefined,
      { force: true },
    );

    expect(collect).toHaveBeenCalledTimes(2);
    expect(tabs.reloaded).toEqual([42]);
    expect(completedLoads).toEqual([42, 42]);
    expect(bridge.createdFor).toEqual([candidate.canonicalUrl]);
    expect(tabs.removed).toEqual([42]);
  });

  it('uses the signed API fallback when the fresh ZSXQ SPA is blank after reload', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T10:00:00.000Z'));
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    const candidate = {
      ...topic('api-shell-recovery'),
      title: '陈老师投资经营复盘',
      text: '这是陈老师关于投资、创业和经营的完整复盘。',
      publishedAt: '2026-08-24T10:00:00.000Z',
      sourceMetadata: { authorRole: 'owner' },
    } satisfies CollectedDocument;
    tabs.sendMessage = async (_tabId, message) => {
      const type = (message as { type?: string }).type ?? '';
      tabs.asked.push(type);
      if (type === 'list.apiCollect') {
        return {
          ok: true,
          apiCollection: { documents: [candidate], businessSkips: [] },
        } as never;
      }
      throw new Error(`unexpected ${type}`);
    };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
    });
    vi.spyOn(runner, 'collectZsxqPlanViews')
      .mockRejectedValue(new Error('页面上找不到「最新」标签（分类栏尚未渲染）'));

    await runner.runZsxqCollectionPlan(
      'api-shell-recovery',
      PLAN_ATTEMPT,
      undefined,
      { force: true },
    );

    expect(tabs.reloaded).toEqual([42]);
    expect(tabs.asked).toContain('list.apiCollect');
    expect(bridge.createdFor).toEqual([candidate.canonicalUrl]);
    expect(tabs.removed).toEqual([42]);
  });

  it('uses the signed API fallback after bounded DOM identity recovery still lacks coverage', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T10:00:00.000Z'));
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    const candidate = {
      ...topic('api-identity-recovery'),
      title: '陈老师投资经营复盘',
      text: '这是陈老师关于投资、创业和经营的完整复盘。',
      publishedAt: '2026-08-24T10:00:00.000Z',
      sourceMetadata: { authorRole: 'owner' },
    } satisfies CollectedDocument;
    tabs.sendMessage = async (_tabId, message) => {
      const type = (message as { type?: string }).type ?? '';
      tabs.asked.push(type);
      if (type === 'list.apiCollect') {
        return {
          ok: true,
          apiCollection: { documents: [candidate], businessSkips: [] },
        } as never;
      }
      throw new Error(`unexpected ${type}`);
    };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
    });
    vi.spyOn(runner, 'collectZsxqPlanViews').mockRejectedValue(new Error(
      'CONTENT_COVERAGE_INCOMPLETE：知识星球必采视图「最新」无法形成可验证文档',
    ));

    await runner.runZsxqCollectionPlan(
      'api-identity-recovery',
      PLAN_ATTEMPT,
      undefined,
      { force: true },
    );

    expect(tabs.reloaded).toEqual([]);
    expect(tabs.asked).toContain('list.apiCollect');
    expect(bridge.createdFor).toEqual([candidate.canonicalUrl]);
    expect(tabs.removed).toEqual([42]);
  });

  it('fails closed when a configured Bridge cannot provide per-URL completeness state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T10:00:00.000Z'));
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    const candidate = {
      ...topic('41999'),
      title: '投资与创业完整复盘',
      text: '这是陈老师关于投资、创业和经营的完整复盘。',
      truncated: false,
      publishedAt: '2026-08-24T10:00:00.000Z',
      sourceMetadata: { authorRole: 'owner' },
    } satisfies CollectedDocument;
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
      knownContent: async () => undefined,
      knownUrls: async () => new Set([candidate.canonicalUrl]),
    });
    vi.spyOn(runner, 'collectZsxqPlanViews').mockResolvedValue([candidate]);

    await expect(runner.runZsxqCollectionPlan('missing-completeness-state', PLAN_ATTEMPT))
      .rejects.toThrow(/BRIDGE_UPDATE_REQUIRED.*完整状态/u);
    expect(bridge.createdFor).toEqual([]);
  });

  it('stages a known-complete ZSXQ item again when the fixed plan is forced for repair', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T10:00:00.000Z'));
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    const candidate = {
      ...topic('41888'),
      title: '投资与创业完整复盘',
      text: '这是陈老师关于投资、创业和经营的完整复盘。',
      truncated: false,
      publishedAt: '2026-08-24T10:00:00.000Z',
      sourceMetadata: { authorRole: 'owner' },
    } satisfies CollectedDocument;
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
      knownContent: async () => new Map([[candidate.canonicalUrl, true]]),
    });
    vi.spyOn(runner, 'collectZsxqPlanViews').mockResolvedValue([candidate]);

    await runner.runZsxqCollectionPlan(
      'forced-repair',
      PLAN_ATTEMPT,
      undefined,
      { force: true },
    );

    expect(bridge.createdFor).toEqual([candidate.canonicalUrl]);
    expect(bridge.createdContexts).toEqual([
      expect.objectContaining({ attempt: PLAN_ATTEMPT }),
    ]);
  });

  it('reports an incomplete linked ZSXQ remote job as attention instead of organizing forever', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    const preview = {
      ...topic('ordinary-incomplete'),
      html: '<p>只有导语</p><a href="https://articles.zsxq.com/id_incomplete.html">全文</a>',
      text: '只有导语',
      truncated: true,
    };
    let asks = 0;
    tabs.sendMessage = async () => {
      asks += 1;
      if (asks === 1) return { ok: true, document: preview };
      return {
        ok: true,
        document: {
          ...preview,
          kind: 'article',
          url: 'https://articles.zsxq.com/id_incomplete.html',
          canonicalUrl: 'https://articles.zsxq.com/id_incomplete.html',
          text: '仍未渲染完整的局部正文。'.repeat(20),
          html: '<p>仍未渲染完整的局部正文。</p>',
          truncated: true,
        },
      };
    };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
    });

    await runner.runRemoteJob('incomplete-remote', preview.canonicalUrl, false);

    expect(bridge.sent.some(message => message.type === 'job.result')).toBe(false);
    expect(bridge.sent.at(-1)).toMatchObject({
      type: 'job.error',
      requestId: 'incomplete-remote',
      payload: {
        code: 'INCOMPLETE_CONTENT',
        needsAttention: true,
      },
    });
  });

  it('does not treat an articles.zsxq.com link inside a non-ZSXQ document as enrichment', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    const wechat = {
      ...document(),
      html: '<p>微信正文</p><a href="https://articles.zsxq.com/id_reference.html">参考链接</a>',
    };
    tabs.response = { ok: true, document: wechat };
    const runner = new JobRunner({ tabs, bridge, waitForTabComplete: async () => undefined });

    await runner.runRemoteJob('wechat-reference', wechat.canonicalUrl);

    expect(tabs.created).toEqual([{ url: wechat.canonicalUrl, active: false, purpose: 'remote-job' }]);
    expect(bridge.sent.at(-1)).toMatchObject({
      type: 'job.result',
      payload: { document: { text: wechat.text } },
    });
  });

  it('completes a linked article before saving the current ZSXQ page', async () => {
    const tabs = new InMemoryTabs();
    const bridge = new InMemoryBridge();
    const preview = {
      ...topic('current-linked'),
      html: '<p>导语</p><a href="https://articles.zsxq.com/id_currentlinked.html">全文</a>',
      text: '导语',
      truncated: false,
    };
    const articleBody = '这是当前页引用长文的完整正文。'.repeat(20);
    tabs.activeTab = { id: 7, url: preview.canonicalUrl, status: 'complete' };
    tabs.sendMessage = async (tabId, message) => {
      if ((message as { type?: string }).type !== 'extract.document') {
        throw new Error('unexpected message');
      }
      if (tabId === 7) return { ok: true, document: preview };
      return {
        ok: true,
        document: {
          ...preview,
          kind: 'article',
          url: 'https://articles.zsxq.com/id_currentlinked.html',
          canonicalUrl: 'https://articles.zsxq.com/id_currentlinked.html',
          html: `<p>${articleBody}</p>`,
          text: articleBody,
          truncated: false,
        },
      };
    };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
    });

    await runner.captureCurrent({});

    const sent = bridge.sent.at(-1) as {
      type: string;
      payload: { document: CollectedDocument };
    };
    expect(sent.type).toBe('job.result');
    expect(sent.payload.document.text).toContain(articleBody);
    expect(sent.payload.document.truncated).toBe(false);
    expect(tabs.created.map(item => item.url)).toContain(
      'https://articles.zsxq.com/id_currentlinked.html',
    );
  });

  it('hands an interactive authentication tab to the user', async () => {
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
    expect(tabs.handedOff).toEqual([{
      id: 42,
      url: 'https://wx.zsxq.com/dweb2/index/topic_detail/1',
    }]);
    expect(bridge.sent.at(-1)).toMatchObject({
      type: 'job.error',
      requestId: 'job-2',
      payload: { code: 'AUTH_REQUIRED', needsAttention: true },
    });
  });

  it('reports plan authentication attention but closes its non-interactive generated tab', async () => {
    const tabs = new InMemoryTabs();
    tabs.response = {
      ok: false,
      error: { code: 'AUTH_REQUIRED', message: '请先登录知识星球' },
    };
    const bridge = new InMemoryBridge();
    const runner = new JobRunner({ tabs, bridge, waitForTabComplete: async () => undefined });

    await runner.runRemoteJob(
      'plan-job',
      'https://wx.zsxq.com/dweb2/index/topic_detail/1',
      false,
    );

    expect(tabs.handedOff).toEqual([]);
    expect(tabs.updated).toEqual([]);
    expect(tabs.removed).toEqual([42]);
    expect(bridge.sent.at(-1)).toMatchObject({
      type: 'job.error',
      payload: { code: 'AUTH_REQUIRED', needsAttention: true },
    });
  });

  it('preserves an auth error code and hands off the single ZSXQ plan page without login wording', async () => {
    const tabs = new InMemoryTabs();
    tabs.sendMessage = async () => ({
      ok: false,
      error: {
        code: 'AUTH_REQUIRED',
        message: '知识星球当前显示公开介绍页；请恢复该星球的成员访问后重试',
      },
    });
    const bridge = new InMemoryBridge();
    const runner = new JobRunner({ tabs, bridge, waitForTabComplete: async () => undefined });

    await expect(runner.runZsxqCollectionPlan('login-batch', PLAN_ATTEMPT))
      .rejects.toThrow(/AUTH_REQUIRED.*成员访问/u);

    expect(tabs.created).toEqual([{
      url: LIST_URL,
      active: false,
      purpose: 'zsxq-plan',
    }]);
    expect(tabs.updated).toEqual([{ id: 42, active: true }]);
    expect(tabs.handedOff).toEqual([{ id: 42, url: LIST_URL }]);
    expect(tabs.removed).toEqual([]);
  });

  it('closes an unsupported-layout tab instead of retaining it for attention', async () => {
    const tabs = new InMemoryTabs();
    tabs.response = {
      ok: false,
      error: { code: 'UNSUPPORTED_LAYOUT', message: '页面结构暂不支持' },
    };
    const bridge = new InMemoryBridge();
    const runner = new JobRunner({ tabs, bridge, waitForTabComplete: async () => undefined });

    await runner.runRemoteJob('unsupported', URL);

    expect(tabs.handedOff).toEqual([]);
    expect(tabs.removed).toEqual([42]);
    expect(bridge.sent.at(-1)).toMatchObject({
      type: 'job.error',
      payload: { code: 'UNSUPPORTED_LAYOUT', needsAttention: false },
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

  it('samples the first list frame through the stability window and saves the richer body', async () => {
    const { tabs, bridge, runner } = listRunner();
    const partial = '这是列表首帧尚未渲染完的正文。'.repeat(8);
    const full = `${partial}${'这是稍后出现的完整正文尾段。'.repeat(30)}`;
    let samples = 0;
    tabs.sendMessage = async (_id, message) => {
      const type = (message as { type?: string }).type;
      if (type === 'list.restore') return { ok: true, advance: { collapsed: 0, loaded: 0 } };
      if (type === 'extract.list') {
        samples += 1;
        const text = samples <= 3 ? partial : full;
        const candidate = {
          ...topic('74101'),
          html: `<p>${text}</p>`,
          text,
          truncated: false,
        };
        return {
          ok: true,
          list: {
            items: [{ key: 'stable-first', title: candidate.title, document: candidate }],
            skipped: 0,
            total: 1,
            captured: 1,
          },
        };
      }
      if (type === 'list.advance') return { ok: true, advance: { collapsed: 1, loaded: 0 } };
      throw new Error(`unexpected ${type}`);
    };

    const summary = await runner.captureList();

    const saved = bridge.sent.find(message => message.type === 'job.result');
    expect((saved?.payload as { document?: CollectedDocument }).document).toMatchObject({
      text: expect.stringContaining('完整正文尾段'),
      truncated: false,
    });
    expect(summary).toMatchObject({ collected: 1, failed: 0, phase: 'done' });
    expect(samples).toBe(9);
  });

  it('keeps an earlier equal-text article link and image through list stabilization, then completes the linked body', async () => {
    const { tabs, bridge, runner } = listRunner();
    const candidate = topic('74102');
    const intro = '列表稳定采样里的正文始终相同，但首帧才带有长文链接和配图。'.repeat(4);
    const articleUrl = 'https://articles.zsxq.com/id_stableassets.html';
    const previewImage = 'https://images.example/stable-preview.png';
    const articleText = '这是链接长文的完整正文，详细讨论投资、创业、现金流和经营决策。'.repeat(24);
    let listSamples = 0;
    let articleSamples = 0;
    const original = tabs.sendMessage.bind(tabs);
    tabs.sendMessage = async (id, message) => {
      const type = (message as { type?: string }).type;
      if (type === 'extract.list') {
        listSamples += 1;
        const document = listSamples === 1
          ? {
              ...candidate,
              html: `<p>${intro}</p><a href="${articleUrl}">阅读全文</a>`
                + `<img src="${previewImage}" alt="首帧配图">`,
              text: intro,
              images: [{ url: previewImage, alt: '首帧配图' }],
            }
          : {
              ...candidate,
              html: `<p>${intro}</p>`,
              text: intro,
              images: [],
            };
        return {
          ok: true,
          list: {
            items: [{ key: 'stable-assets', title: document.title, document }],
            skipped: 0,
            total: 1,
            captured: 1,
          },
        } as never;
      }
      if (type === 'extract.document') {
        articleSamples += 1;
        return {
          ok: true,
          document: {
            ...candidate,
            kind: 'article' as const,
            url: articleUrl,
            canonicalUrl: articleUrl,
            title: '稳定采样保留下来的链接长文',
            html: `<p>${articleText}</p>`,
            text: articleText,
            images: [],
            truncated: false,
          },
        } as never;
      }
      return original(id, message);
    };

    const summary = await runner.captureList();

    expect(listSamples).toBe(9);
    expect(articleSamples).toBe(9);
    expect(tabs.created.map(item => item.url)).toContain(articleUrl);
    const saved = bridge.sent.find(message => message.type === 'job.result');
    const completed = (saved?.payload as { document?: CollectedDocument }).document;
    expect(completed?.text).toContain(articleText);
    expect(completed?.images).toContainEqual({ url: previewImage, alt: '首帧配图' });
    expect(summary).toMatchObject({ collected: 1, failed: 0, phase: 'done' });
  });

  it('keeps an unproven A coverage risk when the same virtual key later becomes complete B', async () => {
    const tabs = new InMemoryTabs();
    tabs.activeTab = { id: 7, url: LIST_URL, status: 'complete' };
    const bridge = new InMemoryBridge();
    const expectedBuild = 'v0.4.29 · observation-test';
    const exact = (operation: string) => contentRequestType(operation, expectedBuild);
    const attestation = {
      contentProtocol: CONTENT_EXTRACTION_PROTOCOL,
      contentBuildId: expectedBuild,
    };
    const completeB = {
      ...topic('74402'),
      title: '虚拟节点复用后的完整帖子 B',
      text: '这是虚拟节点复用后的完整帖子 B 正文，身份和内容都已经证明。'.repeat(8),
      truncated: false,
    };
    let samples = 0;
    tabs.sendMessage = async (_id, message) => {
      const type = String((message as { type?: unknown }).type ?? '');
      if (type === exact('list.restore')) {
        return { ok: true, ...attestation, advance: { collapsed: 0, loaded: 0 } };
      }
      if (type === exact('extract.list')) {
        samples += 1;
        const items = samples <= 4
          ? [{
              key: 'reused-virtual-node',
              observationId: 'generation-1:revision-0',
              title: '尚未取得身份的帖子 A',
              reason: '帖子 A 的编号尚未取得',
              skipKind: 'coverage-risk' as const,
            }]
          : [{
              key: 'reused-virtual-node',
              observationId: 'generation-1:revision-1',
              title: completeB.title,
              document: completeB,
            }];
        return {
          ok: true,
          ...attestation,
          list: { items, skipped: samples <= 4 ? 1 : 0, total: 1, captured: 1 },
        };
      }
      if (type === exact('list.advance')) {
        return { ok: true, ...attestation, advance: { collapsed: 1, loaded: 0 } };
      }
      if (type === exact('list.focusLast')) {
        return { ok: true, ...attestation, highlight: { found: true } };
      }
      throw new Error(`unexpected ${type}`);
    };
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
      requireContentProtocol: true,
      expectedContentBuildId: expectedBuild,
    });

    const summary = await runner.captureList();

    expect(samples).toBe(11);
    expect(summary).toMatchObject({
      phase: 'failed',
      code: 'CONTENT_COVERAGE_INCOMPLETE',
      collected: 1,
      skipped: 1,
    });
    expect(bridge.createdFor).toEqual([completeB.canonicalUrl]);
  });

  it('still binds a late API URL when DOM generation and semantic revision are unchanged', async () => {
    const tabs = new InMemoryTabs();
    const expectedBuild = 'v0.4.29 · observation-control';
    const exactList = contentRequestType('extract.list', expectedBuild);
    const candidate = {
      ...topic('74403'),
      text: '同一 DOM 和同一正文一直没有变化，只是 API 帖子号稍后才到。'.repeat(8),
      truncated: false,
    };
    let samples = 0;
    tabs.sendMessage = async (_id, message) => {
      expect((message as { type?: string }).type).toBe(exactList);
      samples += 1;
      return {
        ok: true,
        contentProtocol: CONTENT_EXTRACTION_PROTOCOL,
        contentBuildId: expectedBuild,
        list: {
          items: samples <= 4
            ? [{
                key: 'same-observation',
                observationId: 'generation-2:revision-0',
                title: candidate.title,
                reason: 'API 帖子号尚未到达',
                skipKind: 'coverage-risk' as const,
              }]
            : [{
                key: 'same-observation',
                observationId: 'generation-2:revision-0',
                title: candidate.title,
                document: candidate,
              }],
          skipped: samples <= 4 ? 1 : 0,
          total: 1,
          captured: samples <= 4 ? 0 : 1,
        },
      } as never;
    };
    const runner = new JobRunner({
      tabs,
      bridge: new InMemoryBridge(),
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
      requireContentProtocol: true,
      expectedContentBuildId: expectedBuild,
    });

    const response = await (runner as unknown as {
      extractStableList(tabId: number): Promise<Awaited<ReturnType<TabsApi['sendMessage']>>>;
    }).extractStableList(7);

    expect(samples).toBe(10);
    expect(response).toMatchObject({
      ok: true,
      list: {
        items: [{ document: { canonicalUrl: candidate.canonicalUrl, truncated: false } }],
        skipped: 0,
        total: 1,
      },
    });
  });

  it('stabilizes the newly advanced list frame before saving its document', async () => {
    const { tabs, bridge, runner } = listRunner();
    const first = '第一屏已经稳定的完整正文。'.repeat(20);
    const partial = '第二屏刚出现时的局部正文。'.repeat(8);
    const full = `${partial}${'第二屏稍后出现的正文尾段。'.repeat(30)}`;
    let page = 0;
    let pageSamples = 0;
    tabs.sendMessage = async (_id, message) => {
      const type = (message as { type?: string }).type;
      if (type === 'list.restore') return { ok: true, advance: { collapsed: 0, loaded: 0 } };
      if (type === 'extract.list') {
        pageSamples += 1;
        const text = page === 0 ? first : pageSamples <= 3 ? partial : full;
        const candidate = {
          ...topic(page === 0 ? '74201' : '74202'),
          html: `<p>${text}</p>`,
          text,
          truncated: false,
        };
        return {
          ok: true,
          list: {
            items: [{ key: `stable-page-${page}`, title: candidate.title, document: candidate }],
            skipped: 0,
            total: 1,
            captured: 1,
          },
        };
      }
      if (type === 'list.advance') {
        if (page === 0) {
          page = 1;
          pageSamples = 0;
          return { ok: true, advance: { collapsed: 1, loaded: 1 } };
        }
        return { ok: true, advance: { collapsed: 1, loaded: 0 } };
      }
      throw new Error(`unexpected ${type}`);
    };

    const summary = await runner.captureList();

    const saved = bridge.sent
      .filter(message => message.type === 'job.result')
      .map(message => (message.payload as { document: CollectedDocument }).document);
    expect(saved).toHaveLength(2);
    expect(saved[1]?.text).toContain('第二屏稍后出现的正文尾段');
    expect(summary).toMatchObject({ collected: 2, failed: 0, phase: 'done' });
  });

  it('marks a list body that is still growing in the final sample incomplete', async () => {
    const { tabs, bridge, runner } = listRunner();
    let samples = 0;
    tabs.sendMessage = async (_id, message) => {
      const type = (message as { type?: string }).type;
      if (type === 'list.restore') return { ok: true, advance: { collapsed: 0, loaded: 0 } };
      if (type === 'extract.list') {
        samples += 1;
        const text = '仍在增长的列表正文。'.repeat(20 + samples * 5);
        const candidate = {
          ...topic('74301'),
          html: `<p>${text}</p>`,
          text,
          truncated: false,
        };
        return {
          ok: true,
          list: {
            items: [{ key: 'growing-final', title: candidate.title, document: candidate }],
            skipped: 0,
            total: 1,
            captured: 1,
          },
        };
      }
      if (type === 'extract.document') {
        return { ok: false, error: { code: 'CONTENT_EMPTY', message: '详情页仍未稳定' } };
      }
      if (type === 'list.advance') return { ok: true, advance: { collapsed: 1, loaded: 0 } };
      throw new Error(`unexpected ${type}`);
    };

    const summary = await runner.captureList();

    expect(samples).toBe(11);
    expect(bridge.sent.some(message => message.type === 'job.result')).toBe(false);
    expect(summary).toMatchObject({
      collected: 0,
      failed: 1,
      phase: 'failed',
      code: 'INCOMPLETE_CONTENT',
    });
  });

  it('does not taint transient unknown list frames before the same body becomes proven and stable', async () => {
    const { tabs, runner } = listRunner();
    const proven = topic('74308');
    const unknown: CollectedDocument = { ...proven };
    delete unknown.truncated;
    let samples = 0;
    tabs.sendMessage = async (_id, message) => {
      const type = (message as { type?: string }).type;
      if (type !== 'extract.list') throw new Error(`unexpected ${type}`);
      samples += 1;
      const candidate = samples <= 2 ? unknown : proven;
      return {
        ok: true,
        list: {
          items: [{ key: 'transient-list-unknown', title: candidate.title, document: candidate }],
          skipped: 0,
          total: 1,
          captured: 1,
        },
      } as never;
    };

    const response = await (runner as unknown as {
      extractStableList(tabId: number): Promise<Awaited<ReturnType<TabsApi['sendMessage']>>>;
    }).extractStableList(7);

    expect(response).toMatchObject({
      ok: true,
      list: { items: [{ document: { canonicalUrl: proven.canonicalUrl, truncated: false } }] },
    });
    expect(samples).toBe(9);
  });

  it('forces persistent unknown list completeness to incomplete at the bounded sample limit', async () => {
    const { tabs, runner } = listRunner();
    const unknown: CollectedDocument = { ...topic('74309') };
    delete unknown.truncated;
    let samples = 0;
    tabs.sendMessage = async (_id, message) => {
      const type = (message as { type?: string }).type;
      if (type !== 'extract.list') throw new Error(`unexpected ${type}`);
      samples += 1;
      return {
        ok: true,
        list: {
          items: [{ key: 'persistent-list-unknown', title: unknown.title, document: unknown }],
          skipped: 0,
          total: 1,
          captured: 1,
        },
      } as never;
    };

    const response = await (runner as unknown as {
      extractStableList(tabId: number): Promise<Awaited<ReturnType<TabsApi['sendMessage']>>>;
    }).extractStableList(7);

    expect(response).toMatchObject({
      ok: true,
      list: { items: [{ document: { canonicalUrl: unknown.canonicalUrl, truncated: true } }] },
    });
    expect(samples).toBe(11);
  });

  it('keeps positive list truncation evidence sticky even when later frames look complete', async () => {
    const { tabs, runner } = listRunner();
    let samples = 0;
    const candidate = topic('74302');
    tabs.sendMessage = async (_id, message) => {
      const type = (message as { type?: string }).type;
      if (type !== 'extract.list') throw new Error(`unexpected ${type}`);
      samples += 1;
      return {
        ok: true,
        list: {
          items: [{
            key: 'sticky-taint',
            title: candidate.title,
            document: { ...candidate, truncated: samples === 1 },
          }],
          skipped: 0,
          total: 1,
          captured: 1,
        },
      } as never;
    };

    const response = await (runner as unknown as {
      extractStableList(tabId: number): Promise<Awaited<ReturnType<TabsApi['sendMessage']>>>;
    }).extractStableList(7);

    expect(response).toMatchObject({
      ok: true,
      list: { items: [{ document: { truncated: true } }] },
    });
    expect(samples).toBeGreaterThanOrEqual(8);
  });

  it('keeps conflicting linked-article coverage sticky across otherwise stable list frames', async () => {
    const { tabs, runner } = listRunner();
    const candidate = topic('74306');
    const body = '相同的帖子正文不能证明两个互不包含的长文链接哪个才属于当前帖子。'.repeat(8);
    let samples = 0;
    tabs.sendMessage = async (_id, message) => {
      const type = (message as { type?: string }).type;
      if (type !== 'extract.list') throw new Error(`unexpected ${type}`);
      samples += 1;
      const articleUrl = samples === 1
        ? 'https://articles.zsxq.com/id_conflictA.html'
        : 'https://articles.zsxq.com/id_conflictB.html';
      return {
        ok: true,
        list: {
          items: [{
            key: 'sticky-link-conflict',
            title: candidate.title,
            document: {
              ...candidate,
              html: `<p>${body}</p><a href="${articleUrl}">阅读全文</a>`,
              text: body,
            },
          }],
          skipped: 0,
          total: 1,
          captured: 1,
        },
      } as never;
    };

    const response = await (runner as unknown as {
      extractStableList(tabId: number): Promise<Awaited<ReturnType<TabsApi['sendMessage']>>>;
    }).extractStableList(7);

    expect(response).toMatchObject({
      ok: true,
      list: { items: [{ document: { truncated: true } }] },
    });
    expect(samples).toBeGreaterThanOrEqual(8);
  });

  it('keeps incompatible body coverage sticky across otherwise stable list frames', async () => {
    const { tabs, runner } = listRunner();
    const candidate = topic('74307');
    const firstBody = '第一份正文完整讨论投资决策与现金流，不能与另一份正文互换。'.repeat(8);
    const laterBody = '第二份正文完整讨论产品增长与团队管理，不能与第一份正文互换。'.repeat(8);
    let samples = 0;
    tabs.sendMessage = async (_id, message) => {
      const type = (message as { type?: string }).type;
      if (type !== 'extract.list') throw new Error(`unexpected ${type}`);
      samples += 1;
      const text = samples === 1 ? firstBody : laterBody;
      return {
        ok: true,
        list: {
          items: [{
            key: 'sticky-body-conflict',
            title: candidate.title,
            document: { ...candidate, html: `<p>${text}</p>`, text },
          }],
          skipped: 0,
          total: 1,
          captured: 1,
        },
      } as never;
    };

    const response = await (runner as unknown as {
      extractStableList(tabId: number): Promise<Awaited<ReturnType<TabsApi['sendMessage']>>>;
    }).extractStableList(7);

    expect(response).toMatchObject({
      ok: true,
      list: { items: [{ document: { truncated: true } }] },
    });
    expect(samples).toBeGreaterThanOrEqual(8);
  });

  it('does not treat transiently empty post-advance frames as an exhausted view', async () => {
    const { tabs, runner } = listRunner();
    let samples = 0;
    const late = topic('74305');
    tabs.sendMessage = async (_id, message) => {
      const type = (message as { type?: string }).type;
      if (type !== 'extract.list') throw new Error(`unexpected ${type}`);
      samples += 1;
      return samples <= 8
        ? { ok: true, list: { items: [], skipped: 0, total: 0, captured: 0 } } as never
        : {
            ok: true,
            list: {
              items: [{ key: 'late-after-empty', title: late.title, document: late }],
              skipped: 0,
              total: 1,
              captured: 1,
            },
          } as never;
    };

    const response = await (runner as unknown as {
      extractStableList(tabId: number): Promise<Awaited<ReturnType<TabsApi['sendMessage']>>>;
    }).extractStableList(7);

    expect(response).toMatchObject({
      ok: true,
      list: {
        items: [{ document: { canonicalUrl: late.canonicalUrl, truncated: true } }],
      },
    });
    expect(samples).toBe(11);
  });

  it('does not merge two topics when a virtual list reuses the same DOM key', async () => {
    const { tabs, runner } = listRunner();
    let samples = 0;
    const first = topic('74303');
    const second = topic('74304');
    tabs.sendMessage = async (_id, message) => {
      const type = (message as { type?: string }).type;
      if (type !== 'extract.list') throw new Error(`unexpected ${type}`);
      samples += 1;
      const candidate = samples <= 4 ? first : second;
      return {
        ok: true,
        list: {
          items: [{ key: 'recycled-node', title: candidate.title, document: candidate }],
          skipped: 0,
          total: 1,
          captured: 1,
        },
      } as never;
    };

    const response = await (runner as unknown as {
      extractStableList(tabId: number): Promise<Awaited<ReturnType<TabsApi['sendMessage']>>>;
    }).extractStableList(7);

    expect(response.ok).toBe(true);
    if (!response.ok || !('list' in response)) throw new Error('expected list response');
    expect(response.list.items.map(item => item.document?.canonicalUrl)).toEqual([
      first.canonicalUrl,
      second.canonicalUrl,
    ]);
    // A 已离屏，不能靠 B 的稳定帧替它作完整证明；必须保留风险而不是静默丢 A。
    expect(response.list.items.map(item => item.document?.truncated)).toEqual([true, false]);
    expect(samples).toBe(11);
  });

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
            html: '<p>正文</p>', text: '正文', images: [], truncated: false,
          },
        };
      };
      return { tabs, bridge, runner, attempts: () => asked };
    }

    it('前几次没渲染出来就等一等，渲染好了照常入库', async () => {
      const { bridge, runner, attempts } = renderAfter(3);

      await runner.runRemoteJob('req-1', 'https://wx.zsxq.com/group/1/topic/2');

      // ZSXQ 正文需跑满稳定观察窗，不能第一帧“看似完整”就提前接受。
      expect(attempts()).toBe(9);
      expect(bridge.sent.some(item => item.type === 'job.result')).toBe(true);
    });

    it('does not accept the first no-control ZSXQ post sample before SPA finishes rendering', async () => {
      const { tabs, bridge, runner } = listRunner();
      const partial = topic('staged-post');
      partial.text = '这是 SPA 首次挂载的局部正文。'.repeat(5);
      partial.html = `<p>${partial.text}</p>`;
      partial.truncated = false;
      const full = {
        ...partial,
        text: `${partial.text}${'这是稍后挂载的完整正文尾部和最终结论。'.repeat(20)}`,
        html: `<p>${partial.text}${'这是稍后挂载的完整正文尾部和最终结论。'.repeat(20)}</p>`,
      };
      let asked = 0;
      tabs.sendMessage = async () => {
        asked += 1;
        return { ok: true as const, document: asked <= 3 ? partial : full };
      };

      await runner.runRemoteJob('staged-zsxq-post', partial.canonicalUrl);

      const saved = bridge.sent.find(message => message.type === 'job.result');
      expect((saved?.payload as { document?: CollectedDocument }).document?.text).toBe(full.text);
      expect(asked).toBe(9);
    });

    it('fails closed when a ZSXQ body grows after the first 24-second observation boundary', async () => {
      const { tabs, runner } = listRunner();
      const partial = {
        ...topic('late-growth'),
        text: '前 23 秒看似稳定的正文。'.repeat(20),
        truncated: false,
      };
      const full = {
        ...partial,
        text: `${partial.text}${'第 30 秒才出现的正文尾段。'.repeat(20)}`,
      };
      let asked = 0;
      tabs.sendMessage = async () => {
        asked += 1;
        return { ok: true, document: asked <= 8 ? partial : full } as const;
      };

      const response = await (runner as unknown as {
        extractWithRetry(
          tabId: number,
          overrides: undefined,
          retryUnsupportedLayout: boolean,
          stabilizeZsxq: boolean,
          maxAttempts: number,
        ): Promise<Awaited<ReturnType<TabsApi['sendMessage']>>>;
      }).extractWithRetry(7, undefined, false, true, 11);

      expect(response).toMatchObject({
        ok: true,
        document: { text: full.text, truncated: true },
      });
      expect(asked).toBe(11);
    });

    it('does not accept the first no-control direct ZSXQ article sample', async () => {
      const { tabs, bridge, runner } = listRunner();
      const url = 'https://articles.zsxq.com/id_staged_direct.html';
      const partial = {
        ...topic('staged-direct-article'),
        kind: 'article' as const,
        url,
        canonicalUrl: url,
        text: '这是长文页首次挂载的局部正文。'.repeat(8),
        html: `<p>${'这是长文页首次挂载的局部正文。'.repeat(8)}</p>`,
        truncated: false,
      };
      const full = {
        ...partial,
        text: `${partial.text}${'这是稍后挂载的完整长文尾部。'.repeat(30)}`,
        html: `<p>${partial.text}${'这是稍后挂载的完整长文尾部。'.repeat(30)}</p>`,
      };
      let asked = 0;
      tabs.sendMessage = async () => {
        asked += 1;
        return { ok: true as const, document: asked <= 3 ? partial : full };
      };

      await runner.runRemoteJob('staged-zsxq-article', url);

      const saved = bridge.sent.find(message => message.type === 'job.result');
      expect((saved?.payload as { document?: CollectedDocument }).document?.text).toBe(full.text);
      expect(asked).toBe(9);
    });

    it('牛客详情页短暂报布局不支持时也等待 SPA 正文渲染', async () => {
      const { tabs, bridge, runner } = listRunner();
      let asked = 0;
      tabs.sendMessage = async () => {
        asked += 1;
        if (asked <= 2) {
          return {
            ok: false as const,
            error: { code: 'UNSUPPORTED_LAYOUT', message: '请在牛客网打开一篇面经或讨论的详情页后重试' },
          };
        }
        return {
          ok: true as const,
          document: {
            schemaVersion: 1, source: 'nowcoder', kind: 'post',
            url: 'https://www.nowcoder.com/feed/main/detail/abc',
            canonicalUrl: 'https://www.nowcoder.com/feed/main/detail/abc',
            title: '字节 Agent 开发面经', collectedAt: '2026-08-23T00:00:00.000Z',
            html: '<p>Agent 开发面试问题完整正文。</p>', text: 'Agent 开发面试问题完整正文。', images: [],
          },
        };
      };

      await runner.runRemoteJob(
        'nowcoder-spa',
        'https://www.nowcoder.com/feed/main/detail/abc',
      );

      expect(asked).toBe(3);
      expect(bridge.sent.some(item => item.type === 'job.result')).toBe(true);
      expect(bridge.sent.some(item => item.type === 'job.error')).toBe(false);
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
    function withArticle(articleText: string | undefined, articleTruncated = false) {
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
              truncated: articleTruncated,
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

    it('同屏重复正文相等时保留后份长文链接和两边图片，再完成链接正文补齐', async () => {
      const { tabs, bridge, runner } = listRunner();
      const candidate = topic('linked-duplicate-assets');
      const intro = '这是一段两份 DOM 观察完全相同的长文导语。';
      const articleUrl = 'https://articles.zsxq.com/id_duplicateassets.html';
      const firstImage = 'https://images.example/duplicate-first.png';
      const secondImage = 'https://images.example/duplicate-second.png';
      const articleImage = 'https://images.example/duplicate-article.png';
      tabs.listRounds = [{
        documents: [
          {
            ...candidate,
            html: `<p>${intro}</p><img src="${firstImage}" alt="首图">`,
            text: intro,
            images: [{ url: firstImage, alt: '首图' }],
            truncated: false,
          },
          {
            ...candidate,
            html: `<p>${intro}</p><a href="${articleUrl}">阅读全文</a>`
              + `<img src="${firstImage}" alt="首图">`
              + `<img src="${secondImage}" alt="次图">`,
            text: intro,
            images: [
              { url: firstImage, alt: '首图' },
              { url: secondImage, alt: '次图' },
            ],
            truncated: false,
          },
        ],
        skipped: 0,
        total: 2,
      }];
      tabs.advances = [{ collapsed: 2, loaded: 0 }];
      const articleText = '这是链接长文的完整正文，详细讨论投资、创业和经营。'.repeat(20);
      const original = tabs.sendMessage.bind(tabs);
      tabs.sendMessage = async (id, message) => {
        if ((message as { type?: string }).type !== 'extract.document') {
          return original(id, message);
        }
        return {
          ok: true as const,
          document: {
            ...candidate,
            kind: 'article' as const,
            url: articleUrl,
            canonicalUrl: articleUrl,
            title: '重复观察指向的完整长文',
            html: `<p>${articleText}</p><img src="${articleImage}" alt="长文图">`,
            text: articleText,
            images: [{ url: articleImage, alt: '长文图' }],
            truncated: false,
          },
        };
      };

      const summary = await runner.captureList();

      expect(tabs.created.map(item => item.url)).toContain(articleUrl);
      const sent = bridge.sent.find(item => item.type === 'job.result');
      const completed = (sent?.payload as { document?: CollectedDocument }).document;
      expect(completed?.text).toContain(articleText);
      expect(completed?.images).toEqual(expect.arrayContaining([
        { url: firstImage, alt: '首图' },
        { url: secondImage, alt: '次图' },
        { url: articleImage, alt: '长文图' },
      ]));
      expect(summary).toMatchObject({ collected: 1, failed: 0, phase: 'done' });
    });

    it('外部长文补齐不能洗掉原帖自身的正向截断证据', async () => {
      const body = '这里是引用长文的完整正文，包含投资、创业和经营结论。'.repeat(10);
      const { runner } = withArticle(body);
      const preview = {
        ...topic('linked-but-own-body-truncated'),
        html: '<p>原帖仍有未展开内容</p><button>展开全部</button>'
          + '<a href="https://articles.zsxq.com/id_abc.html">全文</a>',
        text: '原帖仍有未展开内容',
        truncated: true,
      };

      const completed = await (runner as unknown as {
        withLinkedArticle(document: CollectedDocument): Promise<CollectedDocument>;
      }).withLinkedArticle(preview);

      expect(completed.text).toContain(body);
      expect(completed.truncated).toBe(true);
    });

    it('rejects a stale linked-article response whose canonical URL belongs to another article', async () => {
      const { tabs, runner } = withArticle(undefined);
      const preview = {
        ...topic('linked-identity-a'),
        html: '<p>文章 A 的导语</p><a href="https://articles.zsxq.com/id_abc.html">全文</a>',
        text: '文章 A 的导语',
        truncated: false,
      };
      const wrongBody = '这是 SPA 上一篇文章 B 遗留的完整长文正文，绝不能串进文章 A。'.repeat(20);
      tabs.sendMessage = async () => ({
        ok: true as const,
        document: {
          ...preview,
          source: 'zsxq' as const,
          kind: 'article' as const,
          url: 'https://articles.zsxq.com/id_other.html',
          canonicalUrl: 'https://articles.zsxq.com/id_other.html',
          html: `<p>${wrongBody}</p>`,
          text: wrongBody,
          truncated: false,
        },
      });

      const completed = await (runner as unknown as {
        withLinkedArticle(document: CollectedDocument): Promise<CollectedDocument>;
      }).withLinkedArticle(preview);

      expect(completed.text).toBe(preview.text);
      expect(completed.text).not.toContain(wrongBody);
      expect(completed.truncated).toBe(true);
    });

    it('waits past a no-control partial linked-article sample until the richer body is stable', async () => {
      const { tabs, runner } = withArticle(undefined);
      const preview = {
        ...topic('linked-staged-body'),
        html: '<p>长文导语</p><a href="https://articles.zsxq.com/id_abc.html">全文</a>',
        text: '长文导语',
        truncated: false,
      };
      const partial = '这是无控件但尚未完成的长文首段。'.repeat(8);
      const full = `${partial}${'这是稍后才挂载的完整正文尾部。'.repeat(30)}`;
      let asked = 0;
      tabs.sendMessage = async () => {
        asked += 1;
        const text = asked <= 3 ? partial : full;
        return {
          ok: true as const,
          document: {
            ...preview,
            kind: 'article' as const,
            url: 'https://articles.zsxq.com/id_abc.html',
            canonicalUrl: 'https://articles.zsxq.com/id_abc.html',
            html: `<p>${text}</p>`,
            text,
            truncated: false,
          },
        };
      };

      const completed = await (runner as unknown as {
        withLinkedArticle(document: CollectedDocument): Promise<CollectedDocument>;
      }).withLinkedArticle(preview);

      expect(completed.text).toContain('稍后才挂载的完整正文尾部');
      expect(completed.truncated).toBe(false);
      expect(asked).toBe(9);
    });

    it('does not let transient weak article frames taint a later strong body that stays stable for 24 seconds', async () => {
      const { tabs, runner } = withArticle(undefined);
      const articleUrl = 'https://articles.zsxq.com/id_weakthenstrong.html';
      const preview = {
        ...topic('linked-weak-then-strong'),
        html: `<p>长文导语</p><a href="${articleUrl}">全文</a>`,
        text: '长文导语',
        truncated: false,
      };
      const weak = '这是 SPA 首帧里只有裸 content 的未知正文，不能形成正向截断证据。'.repeat(8);
      const full = `${weak}${'这是随后挂载到强语义 article 中的完整正文尾段。'.repeat(30)}`;
      const observed: Array<boolean | undefined> = [];
      let asked = 0;
      tabs.sendMessage = async () => {
        asked += 1;
        const html = asked <= 2
          ? `<div class="content">${weak}</div>`
          : `<main><article>${full}</article></main>`;
        const extracted = extractDocument(
          new JSDOM(html, { url: articleUrl }).window.document,
          articleUrl,
          () => '2026-08-25T00:00:00.000Z',
        );
        observed.push(extracted.truncated);
        return { ok: true as const, document: extracted };
      };

      const completed = await (runner as unknown as {
        withLinkedArticle(document: CollectedDocument): Promise<CollectedDocument>;
      }).withLinkedArticle(preview);

      expect(observed.slice(0, 2)).toEqual([undefined, undefined]);
      expect(completed.text).toContain('完整正文尾段');
      expect(completed.truncated).toBe(false);
      expect(asked).toBe(9);
    });

    it('keeps persistent weak article frames unknown and rejects them at the bounded retry limit', async () => {
      const { tabs, runner } = withArticle(undefined);
      const articleUrl = 'https://articles.zsxq.com/id_persistentweak.html';
      const preview = {
        ...topic('linked-persistent-weak'),
        html: `<p>长文导语</p><a href="${articleUrl}">全文</a>`,
        text: '长文导语',
        truncated: false,
      };
      const weak = '这一帧只有裸 content，虽然字数足够但始终无法证明文章结构完整。'.repeat(12);
      const observed: Array<boolean | undefined> = [];
      let asked = 0;
      tabs.sendMessage = async () => {
        asked += 1;
        const extracted = extractDocument(
          new JSDOM(`<div class="content">${weak}</div>`, { url: articleUrl }).window.document,
          articleUrl,
          () => '2026-08-25T00:00:00.000Z',
        );
        observed.push(extracted.truncated);
        return { ok: true as const, document: extracted };
      };

      const completed = await (runner as unknown as {
        withLinkedArticle(document: CollectedDocument): Promise<CollectedDocument>;
      }).withLinkedArticle(preview);

      expect(observed).toHaveLength(11);
      expect(observed.every(value => value === undefined)).toBe(true);
      expect(completed.text).toBe(preview.text);
      expect(completed.truncated).toBe(true);
      expect(asked).toBe(11);
    });

    it('keeps a real article expand control sticky even after later strong frames look complete', async () => {
      const { tabs, runner } = withArticle(undefined);
      const articleUrl = 'https://articles.zsxq.com/id_expandsticky.html';
      const preview = {
        ...topic('linked-expand-sticky'),
        html: `<p>长文导语</p><a href="${articleUrl}">全文</a>`,
        text: '长文导语',
        truncated: false,
      };
      const partial = '这是仍挂着真实展开控件的长文局部正文。'.repeat(12);
      const full = `${partial}${'这是控件消失后出现的完整正文尾段。'.repeat(30)}`;
      const observed: Array<boolean | undefined> = [];
      let asked = 0;
      tabs.sendMessage = async () => {
        asked += 1;
        const html = asked === 1
          ? `<main><article>${partial}<button>显示全部</button></article></main>`
          : `<main><article>${full}</article></main>`;
        const extracted = extractDocument(
          new JSDOM(html, { url: articleUrl }).window.document,
          articleUrl,
          () => '2026-08-25T00:00:00.000Z',
        );
        observed.push(extracted.truncated);
        return { ok: true as const, document: extracted };
      };

      const completed = await (runner as unknown as {
        withLinkedArticle(document: CollectedDocument): Promise<CollectedDocument>;
      }).withLinkedArticle(preview);

      expect(observed[0]).toBe(true);
      expect(observed.slice(1).every(value => value === false)).toBe(true);
      expect(completed.text).toBe(preview.text);
      expect(completed.truncated).toBe(true);
      expect(asked).toBe(11);
    });

    it('长文页仍处于半渲染状态时不会假报批量入库成功', async () => {
      const partial = '这是尚未加载完成的投资长文局部正文。'.repeat(12);
      const { bridge, runner } = withArticle(partial, true);

      const summary = await runner.captureList();

      expect(bridge.createdFor).toEqual([]);
      expect(bridge.sent.some(item => item.type === 'job.result')).toBe(false);
      expect(summary).toMatchObject({
        collected: 0,
        failed: 1,
        phase: 'failed',
        code: 'INCOMPLETE_CONTENT',
      });
    });

    it('长文取不到时明确失败，不把导语当全文入库', async () => {
      const { bridge, runner } = withArticle(undefined);

      const summary = await runner.captureList();

      expect(summary).toMatchObject({
        collected: 0,
        failed: 1,
        phase: 'failed',
        code: 'INCOMPLETE_CONTENT',
      });
      expect(bridge.createdFor).toEqual([]);
      expect(bridge.sent.some(item => item.type === 'job.result')).toBe(false);
    });

    it('混合批次有一条正文不完整时也不假报全部完成', async () => {
      const partial = '仍在渲染的投资长文局部正文。'.repeat(12);
      const { tabs, bridge, runner } = withArticle(partial, true);
      tabs.listRounds[0]!.documents.unshift(topic('complete-in-mixed-batch'));
      tabs.listRounds[0]!.total = 2;
      tabs.advances = [{ collapsed: 2, loaded: 0 }];

      const summary = await runner.captureList();

      expect(summary).toMatchObject({
        collected: 1,
        failed: 1,
        phase: 'failed',
        code: 'INCOMPLETE_CONTENT',
      });
      expect(bridge.createdFor).toEqual([
        `${LIST_URL}/topic/complete-in-mixed-batch`,
      ]);
    });

    it('长文标签页无法读取时保留导语并如实标记正文不完整', async () => {
      const tabs = new InMemoryTabs();
      const bridge = new InMemoryBridge();
      tabs.create = async input => {
        tabs.created.push(input);
        return { url: input.url, status: 'complete' };
      };
      const runner = new JobRunner({
        tabs,
        bridge,
        waitForTabComplete: async () => undefined,
        delay: async () => undefined,
      });
      const preview = {
        ...topic('112'),
        html: '<p>这里只拿到了导语</p><a href="https://articles.zsxq.com/id_missing.html">全文</a>',
        text: '这里只拿到了导语',
      };

      const completed = await (runner as unknown as {
        withLinkedArticle(document: CollectedDocument): Promise<CollectedDocument>;
      }).withLinkedArticle(preview);

      expect(completed.text).toBe(preview.text);
      expect(completed.truncated).toBe(true);
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

  it('creates one job per post but does not call a mixed saved plus coverage-risk batch complete', async () => {
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
      phase: 'failed',
      code: 'CONTENT_COVERAGE_INCOMPLETE',
    });
  });

  it('keeps a proven business-filter skip non-failing in an ordinary batch', async () => {
    const { tabs, bridge, runner } = listRunner();
    const accepted = topic('ordinary-business-accepted');
    const filteredUrl = `${LIST_URL}/topic/ordinary-business-filtered`;
    tabs.sendMessage = async (_id, message) => {
      const type = (message as { type?: string }).type;
      if (type === 'list.restore') return { ok: true, advance: { collapsed: 0, loaded: 0 } };
      if (type === 'extract.list') {
        return {
          ok: true,
          list: {
            items: [
              { key: 'accepted', title: accepted.title, document: accepted },
              {
                key: 'filtered',
                title: '有规范 URL 的打新业务过滤',
                url: filteredUrl,
                reason: '打新（按选题偏好跳过，命中：新股）',
                skipKind: 'business-filter',
              },
            ],
            skipped: 1,
            total: 2,
            captured: 2,
          },
        } as never;
      }
      if (type === 'list.advance') return { ok: true, advance: { collapsed: 2, loaded: 0 } };
      throw new Error(`unexpected ${type}`);
    };

    const summary = await runner.captureList();

    expect(bridge.createdFor).toEqual([accepted.canonicalUrl]);
    expect(summary).toMatchObject({
      collected: 1,
      skipped: 1,
      failed: 0,
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

  it('fails closed when ordinary batch advance returns uncertain instead of treating zero as exhaustion', async () => {
    const { tabs, runner } = listRunner();
    tabs.listRounds = [{ documents: [topic('uncertain-ordinary')], skipped: 0, total: 1 }];
    tabs.advances = [{ collapsed: 1, loaded: 0, uncertain: true }];

    const summary = await runner.captureList();

    expect(summary).toMatchObject({
      collected: 1,
      phase: 'failed',
      code: 'CONTENT_ADVANCE_UNCERTAIN',
    });
    expect(summary.error).toContain('无法证明');
  });

  it('fails closed when continuation advance returns uncertain instead of reporting the page done', async () => {
    const { tabs, runner } = listRunner();
    tabs.advances = [{ collapsed: 0, loaded: 0, uncertain: true }];

    const summary = await runner.captureList({}, { continuation: true });

    expect(summary).toMatchObject({
      collected: 0,
      phase: 'failed',
      code: 'CONTENT_ADVANCE_UNCERTAIN',
    });
    expect(summary.error).toContain('无法证明');
    expect(tabs.rhythm).toEqual(['list.advance']);
  });

  it('fails closed when ordinary batch advance throws instead of treating transport failure as exhaustion', async () => {
    const { tabs, runner } = listRunner();
    tabs.listRounds = [{ documents: [topic('advance-throws-ordinary')], skipped: 0, total: 1 }];
    const original = tabs.sendMessage.bind(tabs);
    tabs.sendMessage = async (id, message) => {
      if ((message as { type?: string }).type === 'list.advance') {
        throw new Error('advance transport disconnected');
      }
      return original(id, message);
    };

    const summary = await runner.captureList();

    expect(summary).toMatchObject({
      collected: 1,
      phase: 'failed',
      code: 'CONTENT_ADVANCE_FAILED',
    });
    expect(summary.error).toContain('advance transport disconnected');
  });

  it('fails closed when continuation advance returns an error response instead of reporting done', async () => {
    const { tabs, runner } = listRunner();
    tabs.sendMessage = async (_id, message) => {
      if ((message as { type?: string }).type === 'list.advance') {
        return {
          ok: false,
          error: { code: 'COLLECTION_FAILED', message: 'advance response failed' },
        };
      }
      throw new Error(`unexpected ${(message as { type?: string }).type}`);
    };

    const summary = await runner.captureList({}, { continuation: true });

    expect(summary).toMatchObject({
      collected: 0,
      phase: 'failed',
      code: 'CONTENT_ADVANCE_FAILED',
    });
    expect(summary.error).toContain('advance response failed');
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

    expect(summary).toMatchObject({
      collected: 2,
      failed: 1,
      phase: 'failed',
      code: 'PARTIAL_FAILURE',
    });
    expect(bridge.sent.filter(item => item.type === 'job.result')).toHaveLength(2);
  });

  it('does not count a post as saved when the Bridge reports sink persistence failure', async () => {
    const { tabs, bridge, runner } = listRunner();
    bridge.terminalAck = async () => {
      throw new Error('SAVE_FAILED：知识库目录写入失败');
    };
    tabs.listRounds = [{ documents: [topic('sink-failed')], skipped: 0, total: 1 }];
    tabs.advances = [{ collapsed: 1, loaded: 0 }];

    const summary = await runner.captureList();

    expect(bridge.terminalWaits).toEqual([{ jobId: 'current-job' }]);
    expect(summary).toMatchObject({
      collected: 0,
      failed: 1,
      phase: 'failed',
      code: 'ALL_WRITES_FAILED',
    });
  });

  it('does not advance saved progress until the matching persistence acknowledgement arrives', async () => {
    const { tabs, bridge, runner, progress } = listRunner();
    let acknowledge!: () => void;
    bridge.terminalAck = () => new Promise<void>(resolve => { acknowledge = resolve; });
    tabs.listRounds = [{ documents: [topic('slow-sink')], skipped: 0, total: 1 }];
    tabs.advances = [{ collapsed: 1, loaded: 0 }];

    const capture = runner.captureList();
    await vi.waitFor(() => expect(bridge.terminalWaits).toEqual([{ jobId: 'current-job' }]));
    expect(progress.at(-1)).toMatchObject({ collected: 0, phase: 'running' });

    acknowledge();
    const summary = await capture;

    expect(summary).toMatchObject({ collected: 1, failed: 0, phase: 'done' });
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
      session: {
        get: vi.fn(async () => ({})),
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

  it('同一地址的短、长两份完整观察只保存合并后的长正文', async () => {
    const base = topic('511111111111111');
    const shortText = '这是同一帖先渲染出来的完整开头。'.repeat(4);
    const longText = `${shortText}${'这是稍后出现的更丰富正文尾部。'.repeat(12)}`;
    const short = { ...base, text: shortText, html: `<p>${shortText}</p>`, truncated: false };
    const long = { ...base, text: longText, html: `<p>${longText}</p>`, truncated: false };
    const tabs = new InMemoryTabs();
    tabs.activeTab = { id: 7, url: LIST_URL, status: 'complete' };
    tabs.listRounds = [{ documents: [short, long], skipped: 0, total: 2 }];
    const rows: BatchItem[] = [];
    const bridge = new InMemoryBridge();
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
      reportItems: next => { rows.splice(0, rows.length, ...next); },
    });

    const progress = await runner.captureList();

    expect(progress.collected).toBe(1);
    expect(progress.skipped).toBe(0);
    expect(progress.phase).toBe('done');
    expect(rows).toHaveLength(1);
    expect(bridge.sent.find(message => message.type === 'job.result')).toMatchObject({
      payload: { document: { text: longText, truncated: false } },
    });
  });

  it('同一地址出现互不兼容正文时按覆盖冲突失败，不能先到先存后报绿', async () => {
    const base = topic('511111111111112');
    const firstText = '甲版本讲的是投资组合与长期经营结论。'.repeat(8);
    const secondText = '乙版本讲的是完全不同的职场话题与行动建议。'.repeat(8);
    const tabs = new InMemoryTabs();
    tabs.activeTab = { id: 7, url: LIST_URL, status: 'complete' };
    tabs.listRounds = [{
      documents: [
        { ...base, text: firstText, html: `<p>${firstText}</p>`, truncated: false },
        { ...base, text: secondText, html: `<p>${secondText}</p>`, truncated: false },
      ],
      skipped: 0,
      total: 2,
    }];
    const bridge = new InMemoryBridge();
    const runner = new JobRunner({
      tabs,
      bridge,
      waitForTabComplete: async () => undefined,
      delay: async () => undefined,
    });

    const progress = await runner.captureList();

    expect(progress).toMatchObject({
      phase: 'failed',
      code: 'CONTENT_COVERAGE_INCOMPLETE',
    });
    expect(bridge.sent.some(message => message.type === 'job.result')).toBe(false);
  });
});
