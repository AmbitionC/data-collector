import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArticleAction, ArticlePageAction, ArticlePageResult, NowcoderAccountIdentity } from '@data-collector/shared';
import { NowcoderArticlesRunner } from '../../packages/extension/src/background/nowcoderArticles.js';
import { OwnedTabRegistry } from '../../packages/extension/src/background/ownedTabs.js';

const profile = 'https://www.nowcoder.com/users/544222414';
const editor = 'https://www.nowcoder.com/creation/write/article';
const detail = 'https://www.nowcoder.com/discuss/123456';
const identity: NowcoderAccountIdentity = { userId: '544222414', nickname: '妙脆角猫正在思考中', profileUrl: profile, observedAt: '2026-10-31T10:00:00.000Z' };
const action: ArticleAction = { kind: 'article-publish', title: 'Agent 一面整理版', body: '备考题单\n完整正文，包含 agent-journey.cn', expectedAccountId: '544222414', provenance: 'compiled' };
const clicked = { pageStartedAt: '2026-10-31T10:00:01.000Z', beforeSubmitAt: '2026-10-31T10:00:02.000Z', submitClickedAt: '2026-10-31T10:00:03.000Z' };
const receipt = { url: detail, title: action.title, body: action.body, accountId: '544222414', observedAt: '2026-10-31T10:00:04.000Z' };

function harness(execute: (url: string, action: ArticleAction, id: number) => Promise<unknown> | unknown, profileHasCandidate = false) {
  const pages = new Map<number, string>(), created: string[] = [], closed: number[] = [], handed: Array<{ id: number; url: string }> = [], executions: ArticlePageAction[] = [];
  let next = 1;
  const tabs = {
    async create(url: string) { const id = next++; pages.set(id, url); created.push(url); return { id }; },
    async wait(_id: number) {},
    async execute(id: number, request: ArticlePageAction) {
      executions.push(request);
      if (request.kind === 'article-prepare') return { kind: 'article-prepared', diagnostics: { pageStartedAt: identity.observedAt } };
      if (!profileHasCandidate && pages.get(id) === profile && request.kind === 'article-verify') return { kind: 'article-verified', identity };
      return execute(pages.get(id)!, request, id);
    },
    async get(id: number) { return { url: pages.get(id)! }; },
    async close(id: number) { closed.push(id); pages.delete(id); },
    async handoff(id: number, url: string) { handed.push({ id, url }); },
  };
  return { tabs, pages, created, closed, handed, executions };
}
afterEach(() => vi.useRealTimers());

describe('Nowcoder article owned-tab runner', () => {
  it('rechecks the actual account after preparing the editor and stops if it has changed', async () => {
    let probes = 0;
    const h = harness((_url, request, id) => {
      if (request.kind === 'account') return { kind: 'account', identity: ++probes === 1 ? identity : { ...identity, userId: '154061340', profileUrl: 'https://www.nowcoder.com/users/154061340' } };
      if (request.kind === 'article-publish') { h.pages.set(id, detail); return { kind: 'article-clicked', diagnostics: clicked }; }
      return { kind: 'article-published', receipt };
    });
    expect(await new NowcoderArticlesRunner(h.tabs).run(action)).toMatchObject({ kind: 'attention', code: 'ACCOUNT_MISMATCH', submission: 'not_attempted' });
    expect(h.executions.filter(a => a.kind === 'article-publish')).toHaveLength(0);
    expect(h.pages.get(2)).toBe(editor);
  });
  it('requires an explicit own-profile account ID without creating an ambiguous account tab', async () => {
    const h = harness(() => { throw new Error('must not execute'); });
    expect(await new NowcoderArticlesRunner(h.tabs).run({ kind: 'account' })).toMatchObject({ kind: 'attention', code: 'ACCOUNT_ID_REQUIRED', submission: 'not_attempted' });
    expect(h.created).toEqual([]);
  });

  it('stops before opening the composer when the proven owned account mismatches', async () => {
    const h = harness(() => ({ kind: 'account', identity: { ...identity, userId: '154061340', profileUrl: 'https://www.nowcoder.com/users/154061340' } }));
    expect(await new NowcoderArticlesRunner(h.tabs).run(action)).toMatchObject({ kind: 'attention', code: 'ACCOUNT_MISMATCH', submission: 'not_attempted', tabUrl: profile });
    expect(h.created).toEqual([profile]); expect(h.closed).toEqual([]);
  });

  it('rechecks the observed profile URL before trusting an otherwise valid account result', async () => {
    const h = harness((_url, _request, id) => { h.pages.set(id, 'https://www.nowcoder.com/users/154061340'); return { kind: 'account', identity }; });
    expect(await new NowcoderArticlesRunner(h.tabs).run(action)).toMatchObject({ kind: 'attention', code: 'ACCOUNT_MISMATCH', submission: 'not_attempted' });
    expect(h.created).toEqual([profile]);
  });

  it('probes ownership immediately before the editor and converts clicked proof only after a full receipt', async () => {
    const h = harness((url, request, id) => {
      if (request.kind === 'account') return { kind: 'account', identity };
      if (request.kind === 'article-publish') { h.pages.set(id, detail); return { kind: 'article-clicked', diagnostics: clicked }; }
      expect(url).toBe(detail); expect(request.kind).toBe('article-verify');
      return { kind: 'article-published', receipt };
    });
    const runner = new NowcoderArticlesRunner(h.tabs);
    expect(await runner.run(action)).toMatchObject({ kind: 'article-published', receipt, diagnostics: clicked });
    expect(h.created).toEqual([profile, editor, profile]);
    expect(h.executions.map(item => item.kind)).toEqual(['account', 'article-verify', 'article-prepare', 'account', 'article-publish', 'article-verify']);
    expect(h.closed.sort()).toEqual([1, 2, 3]); expect(runner.busy).toBe(false);
  });

  it('does not publish when an own-profile candidate already has the exact full content and author', async () => {
    const h = harness((url, request) => {
      if (request.kind === 'account') return { kind: 'account', identity };
      if (url === profile) return { kind: 'article-candidate', url: detail, identity };
      return { kind: 'article-published', receipt };
    }, true);
    expect(await new NowcoderArticlesRunner(h.tabs).run(action)).toMatchObject({ kind: 'attention', code: 'DUPLICATE_ARTICLE', submission: 'not_attempted', tabUrl: detail });
    expect(h.created).toEqual([profile, detail]);
    expect(h.executions.some(request => request.kind === 'article-publish')).toBe(false);
  });

  it('canonicalizes site tracking parameters on the observed detail URL without losing its path binding', async () => {
    const h = harness((_url, request, id) => {
      if (request.kind === 'account') return { kind: 'account', identity };
      if (request.kind === 'article-publish') { h.pages.set(id, `${detail}?sourceSSR=users#article`); return { kind: 'article-clicked', diagnostics: clicked }; }
      return { kind: 'article-published', receipt };
    });
    expect(await new NowcoderArticlesRunner(h.tabs).run(action)).toMatchObject({ kind: 'article-published', receipt });
  });

  it('uses only read-only inspection after an executeScript navigation interruption', async () => {
    const h = harness((_url, request, id) => {
      if (request.kind === 'account') return { kind: 'account', identity };
      if (request.kind === 'article-publish') { h.pages.set(id, detail); throw new Error('execution context destroyed'); }
      return { kind: 'article-published', receipt };
    });
    expect(await new NowcoderArticlesRunner(h.tabs).run(action)).toMatchObject({ kind: 'article-published', receipt });
    expect(h.executions.filter(item => item.kind === 'article-publish')).toHaveLength(1);
  });

  it('does not invent clicked timestamps when the publishing execution is destroyed', async () => {
    const h = harness((_url, request) => {
      if (request.kind === 'account') return { kind: 'account', identity };
      if (request.kind === 'article-publish') throw new Error('execution context destroyed');
      return { kind: 'article-verified', identity };
    });
    const result = await new NowcoderArticlesRunner(h.tabs).run(action);
    expect(result).toMatchObject({ kind: 'attention', submission: 'uncertain' });
    expect(result.diagnostics?.submitClickedAt).toBeUndefined();
    expect(h.executions.filter(item => item.kind === 'article-publish')).toHaveLength(1);
    expect(h.pages.size).toBeGreaterThan(0);
  });

  it('keeps the original editor and actual click proof when no full receipt can be found', async () => {
    vi.useFakeTimers();
    const h = harness((_url, request) => request.kind === 'account' ? { kind: 'account', identity }
      : request.kind === 'article-publish' ? { kind: 'article-clicked', diagnostics: clicked } : { kind: 'article-verified', identity });
    const pending = new NowcoderArticlesRunner(h.tabs).run(action); await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ kind: 'attention', submission: 'uncertain', diagnostics: clicked, tabUrl: editor });
    expect(h.pages.get(2)).toBe(editor); expect(h.closed).not.toContain(2);
    expect(h.executions.filter(request => request.kind === 'article-publish')).toHaveLength(1);
  });

  it('does not erase a challenge found by readonly inspection after interrupted publish navigation', async () => {
    const diagnostics = { pageStartedAt: '2026-10-31T10:00:05.000Z', verificationObservedAt: '2026-10-31T10:00:06.000Z' };
    const h = harness((_url, request) => {
      if (request.kind === 'account') return { kind: 'account', identity };
      if (request.kind === 'article-publish') throw new Error('context destroyed');
      return { kind: 'attention', code: 'VERIFICATION_REQUIRED', message: '验证', submission: 'not_attempted', diagnostics };
    });
    expect(await new NowcoderArticlesRunner(h.tabs).run(action)).toMatchObject({ kind: 'attention', code: 'VERIFICATION_REQUIRED', submission: 'uncertain', diagnostics });
    expect(h.executions.filter(request => request.kind === 'article-publish')).toHaveLength(1);
    expect(h.pages.get(2)).toBe(editor);
  });

  it('uses only the saved detail URL for explicit verification, without searching for replacements', async () => {
    const h = harness((_url, request) => request.kind === 'account' ? { kind: 'account', identity }
      : { kind: 'attention', code: 'ARTICLE_CONTENT_MISMATCH', message: '正文不匹配', submission: 'not_attempted' });
    expect(await new NowcoderArticlesRunner(h.tabs).run({ kind: 'article-verify', title: action.title, body: action.body, expectedAccountId: '544222414', postUrl: detail })).toMatchObject({ kind: 'attention', code: 'ARTICLE_CONTENT_MISMATCH' });
    expect(h.created).toEqual([profile, detail]);
    expect(h.executions.filter(request => request.kind === 'article-verify')).toEqual([{ kind: 'article-verify', title: action.title, body: action.body, expectedAccountId: '544222414', postUrl: detail }]);
  });

  it.each(['accountId', 'body', 'title', 'url'] as const)('refuses a receipt with a foreign %s', async field => {
    const wrong = { ...receipt, [field]: { accountId: '154061340', body: '只有摘要', title: '另一个标题', url: 'https://www.nowcoder.com/discuss/999999' }[field] };
    const h = harness((_url, request, id) => {
      if (request.kind === 'account') return { kind: 'account', identity };
      if (request.kind === 'article-publish') { h.pages.set(id, detail); return { kind: 'article-clicked', diagnostics: clicked }; }
      return { kind: 'article-published', receipt: wrong };
    });
    expect(await new NowcoderArticlesRunner(h.tabs).run(action)).toMatchObject({ kind: 'attention', submission: 'uncertain' });
    expect(h.pages.size).toBeGreaterThan(0);
  });

  it('retains actual challenge diagnostics and the page even when handoff fails', async () => {
    const diagnostics = { ...clicked, verificationObservedAt: '2026-10-31T10:00:03.100Z' };
    const h = harness((_url, request) => request.kind === 'account' ? { kind: 'account', identity } : { kind: 'attention', code: 'VERIFICATION_REQUIRED', message: '请完成验证', submission: 'uncertain', diagnostics });
    h.tabs.handoff = async () => { throw new Error('focus unavailable'); };
    expect(await new NowcoderArticlesRunner(h.tabs).run(action)).toMatchObject({ kind: 'attention', code: 'VERIFICATION_REQUIRED', submission: 'uncertain', diagnostics, tabUrl: editor });
    expect(h.pages.get(2)).toBe(editor);
    expect(h.closed).not.toContain(2);
  });
  it('durably hands off the unresolved editor as well as a later challenged recovery profile', async () => {
    vi.useFakeTimers();
    let profiles = 0;
    const h = harness((url, request) => {
      if (request.kind === 'account') return { kind: 'account', identity };
      if (request.kind === 'article-publish') return { kind: 'article-clicked', diagnostics: clicked };
      if (url === profile && ++profiles > 0) return { kind: 'attention', code: 'VERIFICATION_REQUIRED', message: '请完成验证', submission: 'not_attempted' };
      return { kind: 'attention', code: 'RECEIPT_NOT_OBSERVED', message: '尚无详情', submission: 'not_attempted' };
    }, true);
    // Preflight is empty; the recovery-only profile scan is challenged.
    const raw = h.tabs.execute;
    let profileReads = 0;
    h.tabs.execute = async (id, request) => request.kind === 'article-verify' && h.pages.get(id) === profile && ++profileReads === 1
      ? { kind: 'article-verified', identity } : raw(id, request);
    const values: Record<string, unknown> = {};
    const storage = { get: async () => values, set: async (v: Record<string, unknown>) => { Object.assign(values, v); } };
    const rawTabs = { remove: async (id: number) => { h.pages.delete(id); } };
    const registry = new OwnedTabRegistry(storage, rawTabs);
    const create = h.tabs.create, handoff = h.tabs.handoff;
    h.tabs.create = async url => { const tab = await create(url); await registry.track({ ...tab, url }, 'nowcoder-operations'); return tab; };
    h.tabs.handoff = async (id, url) => { await handoff(id, url); await registry.handoff(id, url, { preservePrevious: true }); };
    const pending = new NowcoderArticlesRunner(h.tabs).run(action); await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ kind: 'attention', code: 'VERIFICATION_REQUIRED', submission: 'uncertain' });
    expect(h.handed.some(t => t.id === 2 && t.url === editor)).toBe(true);
    expect(h.handed.some(t => t.id !== 2 && t.url === profile)).toBe(true);
    await new OwnedTabRegistry(storage, rawTabs).cleanupStale();
    expect(h.pages.get(2)).toBe(editor);
    expect([...h.pages.values()]).toContain(profile);
  });

  it('inspects a timed-out account load for a challenge without proceeding to publish', async () => {
    const diagnostics = { pageStartedAt: '2026-10-31T10:00:01.000Z', verificationObservedAt: '2026-10-31T10:00:02.000Z' };
    const h = harness(() => ({ kind: 'attention', code: 'VERIFICATION_REQUIRED', message: '请验证', submission: 'not_attempted', diagnostics }));
    h.tabs.wait = async () => { throw new Error('load timeout'); };
    expect(await new NowcoderArticlesRunner(h.tabs).run(action)).toMatchObject({ kind: 'attention', code: 'VERIFICATION_REQUIRED', diagnostics });
    expect(h.created).toEqual([profile]); expect(h.closed).toEqual([]);
  });

  it('opens one typed own-profile candidate read-only and returns the independently proven identity', async () => {
    const h = harness((url, request) => {
      if (request.kind === 'account') return { kind: 'account', identity };
      if (url === profile) return { kind: 'article-candidate', url: detail, identity } satisfies ArticlePageResult;
      return { kind: 'article-published', receipt };
    }, true);
    expect(await new NowcoderArticlesRunner(h.tabs).run({ kind: 'article-verify', title: action.title, body: action.body, expectedAccountId: '544222414' })).toMatchObject({ kind: 'article-verified', identity, receipt });
    expect(h.created).toEqual([profile, detail]);
    expect(h.executions.some(item => item.kind === 'article-publish')).toBe(false);
  });

  it('rejects a candidate belonging to another account before opening its URL', async () => {
    const h = harness((_url, request) => request.kind === 'account' ? { kind: 'account', identity } : { kind: 'article-candidate', url: detail, identity: { ...identity, userId: '154061340', profileUrl: 'https://www.nowcoder.com/users/154061340' } }, true);
    expect(await new NowcoderArticlesRunner(h.tabs).run({ kind: 'article-verify', title: action.title, body: action.body, expectedAccountId: '544222414' })).toMatchObject({ kind: 'attention', code: 'ACCOUNT_MISMATCH', submission: 'not_attempted' });
    expect(h.created).toEqual([profile]);
  });

  it('does not start another page operation while a tab is pending', async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const h = harness(() => ({ kind: 'account', identity })); h.tabs.wait = () => waiting;
    const runner = new NowcoderArticlesRunner(h.tabs), first = runner.run({ kind: 'account', expectedAccountId: '544222414' });
    expect(runner.busy).toBe(true);
    expect(await runner.run(action)).toMatchObject({ kind: 'attention', code: 'ARTICLES_BUSY', submission: 'not_attempted' });
    release(); expect(await first).toMatchObject({ kind: 'account', identity });
    expect(h.created).toEqual([profile]); expect(runner.busy).toBe(false);
  });
});
