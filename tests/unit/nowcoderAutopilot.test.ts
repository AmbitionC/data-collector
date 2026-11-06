import { describe, expect, it, vi } from 'vitest';
import { COMMENT_POLICY, draftRejection, initialState, nextWindowOpen, packetSkipReason, similarity, tick, type AutopilotDeps, type AutopilotState, type Draft, type Packet } from '../../packages/bridge/src/operations/autopilot.js';

const NOW = Date.parse('2026-11-07T04:00:00.000Z'); // 12:00 Shanghai
const packet = (over: Partial<Packet> = {}): Packet => ({ id: 'ops-aaaaaaaaaaaa', sourceId: 'aaaaaaaaaaaa', canonicalUrl: 'https://www.nowcoder.com/discuss/1', sourceConflict: false, anchorOptions: ['RAG 怎么评测'],
  currentPost: { title: 't', body: 'RAG 怎么评测，面试官一直追问检索和生成要怎么分开看效果，线上指标又该怎么定', images: [] },
  conversation: { comments: [], coverage: { total: 0, complete: true } },
  draftEnvelope: { schemaVersion: 1, opportunityId: 'ops-aaaaaaaaaaaa', revision: 2, contextHash: 'a'.repeat(64), conversationHash: 'b'.repeat(64) }, ...over });
const good: Draft = { decision: 'reply', primary: '检索和生成分开打分，先看召回有没有命中再看答案', alternative: '可以固定一组问题，分别记录命中率和答案正确率', anchorIndex: 0, notes: 'n' };

function harness(over: Partial<AutopilotDeps> & { attempt?: string } = {}) {
  const started: Array<{ request: Record<string, unknown>; send: boolean }> = [];
  const deps: AutopilotDeps = {
    recovery: async () => ({ status: 'ready', code: 'READY', message: '', nextCheckAt: null }),
    startWorkflow: async (request, send) => { started.push({ request, send }); return { runId: 'run', status: 'completed', resultPath: String(request.kind) }; },
    getWorkflow: async () => ({ runId: 'run', status: 'completed', resultPath: '' }),
    attempts: async () => { const key = (started.at(-1)?.request.items as Array<{ key: string }> | undefined)?.[0]?.key ?? 'k'; return [{ key, state: over.attempt ?? 'published', replyUrl: 'https://www.nowcoder.com/discuss/comment/1' }]; },
    readPacket: async path => path === 'search' ? { candidates: [{ sourceId: 'aaaaaaaaaaaa', url: 'https://www.nowcoder.com/discuss/1' }] } : { prepared: [packet()], items: [{ result: { contentAccess: 'full' } }] },
    ownPostUrls: async () => new Set(), draft: async () => ({ draft: good }), notify: vi.fn(async () => undefined), now: () => NOW, sleep: async () => undefined, ...over,
  };
  return { deps, started };
}
const run = (state: AutopilotState, deps: AutopilotDeps, live = true) => tick(state, deps, { live, saveState: async () => undefined });

describe('comment autopilot', () => {
  it('publishes one comment with an explicit send and schedules the cadence', async () => {
    const { deps, started } = harness(), state = initialState();
    const result = await run(state, deps);
    expect(result.outcome).toBe('published');
    expect(started.filter(s => s.send).map(s => s.request.kind)).toEqual(['publish']);
    expect(state.nextAt).toBe(new Date(NOW + COMMENT_POLICY.cadenceMs).toISOString());
    expect(state.inflight).toBeNull();
  });
  it('never sends in rehearsal mode', async () => {
    const { deps, started } = harness(), result = await run(initialState(), deps, false);
    expect(result.outcome).toBe('dry_run_draft');
    expect(started.some(s => s.send || s.request.kind === 'publish')).toBe(false);
  });
  it('keeps an uncertain send isolated and never retries that source', async () => {
    const { deps } = harness({ attempt: 'uncertain' }), state = initialState();
    const result = await run(state, deps);
    expect(result.outcome).toBe('isolated_uncertain');
    expect(state.excluded.aaaaaaaaaaaa).toBe('sent-uncertain');
    expect(state.failures).toBe(0);
  });
  it('resolves a crashed send from the journal without sending again', async () => {
    const h = harness({ attempts: async () => [{ key: 'old-key-000000', state: 'dispatching' }], readPacket: async () => ({ candidates: [] }) }), state = initialState();
    state.inflight = { key: 'old-key-000000', opportunityId: 'ops-aaaaaaaaaaaa', sourceId: 'aaaaaaaaaaaa', startedAt: new Date(NOW - 3_600_000).toISOString() };
    const result = await run(state, h.deps);
    expect(result.outcome).toBe('no_opportunity');
    expect(state.excluded.aaaaaaaaaaaa).toBe('inflight-dispatching');
    expect(h.started.some(s => s.send)).toBe(false);
  });
  it('notifies once and calls no model while verification is pending', async () => {
    const draft = vi.fn(), { deps } = harness({ draft, recovery: async () => ({ status: 'needs_user', code: 'VERIFICATION_REQUIRED', message: 'm', nextCheckAt: new Date(NOW + 1000).toISOString() }) }), state = initialState();
    await run(state, deps); state.nextAt = null; await run(state, deps);
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(draft).not.toHaveBeenCalled();
  });
  it('backs off on technical failure and keeps the candidate', async () => {
    const { deps } = harness({ draft: async () => { throw new Error('boom'); } }), state = initialState();
    const result = await run(state, deps);
    expect(result.outcome).toBe('technical_failure');
    expect(state.candidates).toHaveLength(1);
    expect(state.nextAt).toBe(new Date(NOW + 5 * 60_000).toISOString());
  });
  it('skips one bad source and continues with the next in the same tick', async () => {
    const candidates = [{ sourceId: 'bbbbbbbbbbbb', url: 'https://www.nowcoder.com/discuss/2' }, { sourceId: 'aaaaaaaaaaaa', url: 'https://www.nowcoder.com/discuss/1' }];
    const h = harness({ startWorkflow: async (request, send) => { h.started.push({ request, send }); const bad = JSON.stringify(request).includes('bbbbbbbbbbbb'); return { runId: 'r', status: bad ? 'needs_attention' : 'completed', message: 'x', resultPath: String(request.kind) }; },
      readPacket: async path => path === 'search' ? { candidates } : { prepared: [packet()], items: [{ result: { contentAccess: 'full' } }] } });
    const state = initialState(), result = await run(state, h.deps);
    expect(result.outcome).toBe('published');
    expect(state.excluded.bbbbbbbbbbbb).toContain('prepare-failed');
  });
  it('stays quiet outside the window and honours nextAt', async () => {
    const late = Date.parse('2026-11-07T16:30:00.000Z'), { deps } = harness({ now: () => late }), state = initialState();
    expect((await run(state, deps)).outcome).toBe('outside_window');
    expect(state.nextAt).toBe('2026-11-08T00:00:00.000Z');
    expect((await run(state, deps)).outcome).toBe('not_due');
  });
  it('rejects links, promotion, invented experience and repetition', () => {
    expect(draftRejection({ ...good, primary: '可以看 agent-journey.cn 上的整理' }, packet(), [])).toBe('contains-link');
    expect(draftRejection({ ...good, primary: '我整理的资料里写过这个问题的做法' }, packet(), [])).toBe('self-promotion');
    expect(draftRejection({ ...good, primary: '我之前面过这个问题，当时答得不好' }, packet(), [])).toBe('invented-experience');
    expect(draftRejection(good, packet({ conversation: { comments: [{ text: good.primary, likes: null }], coverage: { total: 1, complete: true } } }), [])).toBe('repeats-comment');
    expect(draftRejection(good, packet(), [{ text: good.primary, at: '' }])).toBe('repeats-own-comment');
    expect(draftRejection({ ...good, anchorIndex: 5 }, packet(), [])).toBe('invalid-anchor');
    expect(draftRejection(good, packet(), [])).toBeUndefined();
  });
  it('skips posts that cannot be fully reviewed', () => {
    expect(packetSkipReason(packet({ sourceConflict: true }))).toBe('source-conflict');
    expect(packetSkipReason(packet({ currentPost: { title: 't', body: 'x'.repeat(40), images: ['i'] } }))).toBe('post-has-images');
    expect(packetSkipReason(packet({ conversation: { comments: [], coverage: { total: null, complete: false } } }))).toBe('comment-coverage-incomplete');
    expect(packetSkipReason(packet())).toBeUndefined();
  });
  it('computes window edges and similarity', () => {
    expect(nextWindowOpen(NOW)).toBeNull();
    expect(nextWindowOpen(Date.parse('2026-11-06T23:00:00.000Z'))).toBe(Date.parse('2026-11-07T00:00:00.000Z'));
    expect(similarity('完全相同的一句话', '完全相同的一句话')).toBe(1);
  });
});
