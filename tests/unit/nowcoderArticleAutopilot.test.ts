import { describe, expect, it, vi } from 'vitest';
import { articleRejection, articleTick, currentSlot, initialArticleState, pickSources, type ArticleDeps, type GeneratedArticle, type Leaf } from '../../packages/bridge/src/articles/autopilot.js';

const AM = Date.parse('2026-11-07T02:40:00.000Z'); // 10:40 Shanghai
const body = `今晚按这场做一轮模拟，下面是备考题单。\n\n1. 队列不一致怎么定位？\n\n${'先画时间线，再看消息和状态。'.repeat(30)}`;
const article: GeneratedArticle = { decision: 'write', title: '腾讯 后台开发二面', body, notes: '' };
const leaf: Leaf = { key: 'k', company: 'Tencent', label: 'l', url: 'https://x/k.md', updatedAt: '2026-11-01' };
function harness(publication: Record<string, unknown> = { state: 'published', evidence: 'observed' }) {
  const calls: Array<[string, string | undefined]> = [];
  const deps: ArticleDeps = { now: () => AM, sleep: async () => undefined, notify: vi.fn(async () => undefined), catalog: async () => [leaf], source: async () => 'q', generate: async () => ({ value: article }),
    api: async (path, method) => { calls.push([path, method]);
      if (path === '/runtime') return { connected: true, active: false };
      if (path === '/limits') return { verification: null, nextAllowedAt: null };
      if (path.endsWith('/publish')) return { publication, receipt: { url: 'u' } };
      return { entry: { id: 'article-1', revision: 1, contentHash: 'h', preview: { identity: { userId: '544222414' } } } }; } };
  return { deps, calls };
}
const run = (state: ReturnType<typeof initialArticleState>, deps: ArticleDeps, live = true) => articleTick(state, deps, { live, save: async () => undefined });

describe('article autopilot', () => {
  it('publishes once per slot', async () => {
    const { deps, calls } = harness(), state = initialArticleState();
    expect((await run(state, deps)).outcome).toBe('published');
    expect((await run(state, deps)).outcome).toBe('not_due');
    expect(calls.filter(([p]) => p.endsWith('/publish'))).toHaveLength(1);
  });
  it('never reaches publish in rehearsal', async () => {
    const { deps, calls } = harness();
    expect((await run(initialArticleState(), deps, false)).outcome).toBe('dry_run_draft');
    expect(calls.some(([p]) => p.endsWith('/publish'))).toBe(false);
  });
  it('marks an uncertain slot done without retrying', async () => {
    const { deps } = harness({ state: 'uncertain' }), state = initialArticleState();
    expect((await run(state, deps)).outcome).toBe('isolated_uncertain');
    expect((await run(state, deps)).outcome).toBe('not_due');
    expect(deps.notify).toHaveBeenCalledOnce();
  });
  it('resolves a crashed attempt from the journal', async () => {
    const { deps, calls } = harness(), state = initialArticleState(), id = '2026-11-07-am';
    state.inflight = { key: 'key-000000000', id: 'article-1', slot: id };
    state.retryAt = new Date(AM + 60_000).toISOString();
    expect((await run(state, deps)).outcome).toBe('not_due');
    expect(state.slots[id]).toBeUndefined();
    expect(state.inflight).toBeNull();
    expect(calls.some(([p]) => p.endsWith('/publish'))).toBe(false);
  });
  it('closes the slot when the journal shows an attempt', async () => {
    const h = harness(), api = h.deps.api, state = initialArticleState(), id = '2026-11-07-am';
    h.deps.api = async (p, m, b) => p === '/article-1' ? { entry: { publicationAttempts: [{ key: 'key-000000000', state: 'uncertain' }] } } : api(p, m, b);
    state.inflight = { key: 'key-000000000', id: 'article-1', slot: id };
    expect((await run(state, h.deps)).outcome).toBe('not_due');
    expect(state.slots[id]?.state).toBe('uncertain');
  });
  it('rejects a different account', async () => {
    const h = harness(), api = h.deps.api;
    h.deps.api = async (p, m, b) => p.endsWith('/preview') ? { entry: { preview: { identity: { userId: '1' } } } } : api(p, m, b);
    expect((await run(initialArticleState(), h.deps)).detail).toBe('account-mismatch');
  });
  it('caps model calls when a slot keeps failing', async () => {
    let now = AM; const generate = vi.fn(async () => ({ value: { ...article, decision: 'skip' as const } })), { deps } = harness(); deps.now = () => now; deps.generate = generate; deps.catalog = async () => [{ ...leaf, url: `u${generate.mock.calls.length}` }];
    const state = initialArticleState();
    for (let minute = 0; minute < 80; minute++) { await run(state, deps); now += 60_000; }
    expect(generate).toHaveBeenCalledTimes(3);
    expect(state.slots['2026-11-07-am']?.state).toBe('gave_up');
  });
  it('enforces windows, rotation and content rules', () => {
    expect(currentSlot(AM)?.id).toBe('2026-11-07-am');
    expect(currentSlot(Date.parse('2026-11-07T05:00:00.000Z'))).toBeNull();
    expect(pickSources([leaf, { ...leaf, company: 'Meituan', url: 'm' }], [], 'Bytedance')[0]?.company).toBe('Meituan');
    expect(articleRejection(article, 'Tencent')).toBeUndefined();
    expect(articleRejection({ ...article, title: '腾讯 二面｜整理版' }, 'Tencent')).toBe('title');
    expect(articleRejection({ ...article, body: body.replace('模拟', '').replace('备考', '') }, 'Tencent')).toBe('missing-practice-context');
    expect(articleRejection({ ...article, body: `${body}\n\n面试官问我这题` }, 'Tencent')).toBe('invented-experience');
    expect(articleRejection({ ...article, body: `${body}\n\nhttps://a.cn` }, 'Tencent')).toBe('promotion');
  });
});
