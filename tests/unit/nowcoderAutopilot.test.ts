import { describe, expect, it, vi } from 'vitest';
import { COMMENT_POLICY, LEAD_POLICY, draftRejection, initialState, leadBudgetClosed, leadIneligibility, leadRejection, nextWindowOpen, packetSkipReason, similarity, tick, type AutopilotDeps, type AutopilotState, type Draft, type Packet } from '../../packages/bridge/src/operations/autopilot.js';

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
    probeVerification: async () => 'still_required' as const,
    startWorkflow: async (request, send) => { started.push({ request, send }); return { runId: 'run', status: 'completed', resultPath: String(request.kind) }; },
    getWorkflow: async () => ({ runId: 'run', status: 'completed', resultPath: '' }),
    attempts: async () => { const key = (started.at(-1)?.request.items as Array<{ key: string }> | undefined)?.[0]?.key ?? 'k'; return [{ key, state: over.attempt ?? 'published', replyUrl: 'https://www.nowcoder.com/discuss/comment/1' }]; },
    readPacket: async path => path === 'search' ? { candidates: [{ sourceId: 'aaaaaaaaaaaa', url: 'https://www.nowcoder.com/discuss/1' }] } : { prepared: [packet()], items: [{ result: { contentAccess: 'full' } }] },
    ownPostUrls: async () => new Set(), leadMode: async () => 'shadow', draft: async () => ({ draft: good }), notify: vi.fn(async () => undefined), now: () => NOW, sleep: async () => undefined, ...over,
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
  it('probes a captcha once after the cooldown and resumes when it is gone', async () => {
    const pause = { id: 'p1', detectedAt: new Date(NOW - 2 * 3_600_000).toISOString() }, probe = vi.fn(async () => 'cleared' as const);
    const { deps } = harness({ probeVerification: probe, recovery: async () => ({ status: 'needs_user', code: 'VERIFICATION_REQUIRED', message: 'm', nextCheckAt: null, verification: pause }) }), state = initialState();
    expect((await run(state, deps)).outcome).toBe('captcha_probe_cleared');
    state.nextAt = null; await run(state, deps);
    expect(probe).toHaveBeenCalledTimes(1);
  });
  it('does not probe a fresh captcha or a second one soon after', async () => {
    const probe = vi.fn(async () => 'cleared' as const), state = initialState();
    const fresh = harness({ probeVerification: probe, recovery: async () => ({ status: 'needs_user', code: 'VERIFICATION_REQUIRED', message: 'm', nextCheckAt: null, verification: { id: 'p2', detectedAt: new Date(NOW - 10 * 60_000).toISOString() } }) });
    expect((await run(state, fresh.deps)).outcome).toBe('needs_user');
    state.probe = { pauseId: 'p1', at: new Date(NOW - 3_600_000).toISOString(), result: 'cleared' }; state.nextAt = null;
    const second = harness({ probeVerification: probe, recovery: async () => ({ status: 'needs_user', code: 'VERIFICATION_REQUIRED', message: 'm', nextCheckAt: null, verification: { id: 'p3', detectedAt: new Date(NOW - 3 * 3_600_000).toISOString() } }) });
    expect((await run(state, second.deps)).outcome).toBe('needs_user');
    expect(probe).not.toHaveBeenCalled();
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
  it('runs around the clock and honours nextAt', async () => {
    const late = Date.parse('2026-11-07T19:30:00.000Z'), { deps } = harness({ now: () => late }), state = initialState(); // 03:30 Shanghai
    expect((await run(state, deps)).outcome).toBe('published');
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
    expect(nextWindowOpen(Date.parse('2026-11-06T19:00:00.000Z'))).toBeNull();
    expect(similarity('完全相同的一句话', '完全相同的一句话')).toBe(1);
  });
});

describe('need-gated lead experiment', () => {
  const ask = packet({ currentPost: { title: '【求助】双非 Java 后端想转 Agent，该做什么项目', body: '有一个点评项目，Java 基础还行，不知道 Agent 方向该怎么学、做什么项目能写进简历，求建议', images: [] } });
  const lead = '已经有 Java 和点评项目的话，先别另起一个 Agent 项目。给点评加一个只读客服：用户问商品就走你现有的查询接口，参数不全时先追问，查不到就直说查不到，不要让模型自己编。分阶段的练习我整理在 agent-journey.cn，可以对着做。先把工具超时和用户换订单号这两条失败路径跑通，再看日志里每一步调用是否符合预期，这样简历上就有能讲清楚的具体改动了';
  const seeded = (n: number) => { const s = initialState(); s.published = Array.from({ length: n }, (_, i) => new Date(NOW - (i + 1) * 3_600_000).toISOString()); return s; };

  it('only treats posts that ask for help as lead opportunities', () => {
    expect(leadIneligibility(ask)).toBeUndefined();
    expect(leadIneligibility(packet({ currentPost: { title: '字节后端一面面经', body: '求建议，怎么学 RAG', images: [] } }))).toBe('interview-post');
    expect(leadIneligibility(packet())).toBe('no-stated-need');
  });
  it('accepts a disclosed, self-contained lead and rejects the warned tail pattern', () => {
    expect(lead.length).toBeGreaterThanOrEqual(LEAD_POLICY.minLength);
    expect(leadRejection(lead, ask, [])).toBeUndefined();
    expect(leadRejection('250条评测集得留一批没拿来调过的题，不然模型也会背题，评测这块我整理在 agent-journey.cn 了', ask, [])).toBe('lead-length');
    expect(leadRejection(`${lead.replace('agent-journey.cn', '那边')}，详见 agent-journey.cn`, ask, [])).toBe('lead-domain-at-tail');
    expect(leadRejection(lead.replace('我整理在', '都在'), ask, [])).toBe('lead-no-disclosure');
    expect(leadRejection(`${lead}，注册就能用`, ask, [])).toBe('lead-call-to-action');
    expect(leadRejection(`${lead}，agent-journey.cn`, ask, [])).toBe('lead-domain-count');
    expect(leadRejection(lead, packet({ ...ask, conversation: { comments: [{ text: '看看 agent-journey.cn', likes: null }], coverage: { total: 1, complete: true } } }), [])).toBe('lead-domain-already-in-thread');
  });
  it('caps leads per day, by gap and by weekly share', () => {
    expect(leadBudgetClosed(seeded(5), NOW)).toBe('too-few-comments');
    expect(leadBudgetClosed(seeded(30), NOW)).toBeUndefined();
    const today = seeded(60); today.leads = [1, 2, 3, 4, 5, 6].map(m => ({ at: new Date(NOW - m * 60_000).toISOString(), sourceId: `t${m}` }));
    expect(leadBudgetClosed(today, NOW)).toBe('daily-cap');
    const late = seeded(30); late.leads = [{ at: new Date(NOW + 10 * 3_600_000).toISOString(), sourceId: 'x' }]; // 22:00, next check 23:30 the same evening
    expect(leadBudgetClosed(late, NOW + 11.5 * 3_600_000)).toBe('min-gap');
    const share = seeded(20); share.leads = [1, 2, 3, 4].map(d => ({ at: new Date(NOW - d * 86_400_000).toISOString(), sourceId: `s${d}` }));
    expect(leadBudgetClosed(share, NOW)).toBe('weekly-share');
  });
  it('shadow mode publishes the link-free text and logs the lead', async () => {
    const h = harness({ readPacket: async path => path === 'search' ? { candidates: [{ sourceId: 'aaaaaaaaaaaa', url: 'https://www.nowcoder.com/discuss/1' }] } : { prepared: [ask], items: [{ result: { contentAccess: 'full' } }] },
      draft: async () => ({ draft: { ...good, lead } }) });
    const state = seeded(30), result = await run(state, h.deps);
    expect(result.outcome).toBe('published');
    expect(result.lead).toEqual({ status: 'shadow', text: lead });
    const sent = (h.started.find(s => s.send)!.request.items as Array<{ draft: { drafts: { primary: string } } }>)[0]!.draft.drafts.primary;
    expect(sent).toBe(good.primary);
    expect(state.leads).toHaveLength(0);
  });
  it('live mode sends the lead once and records it against the budget', async () => {
    const prompts: string[] = [];
    const h = harness({ leadMode: async () => 'live', readPacket: async path => path === 'search' ? { candidates: [{ sourceId: 'aaaaaaaaaaaa', url: 'https://www.nowcoder.com/discuss/1' }] } : { prepared: [ask], items: [{ result: { contentAccess: 'full' } }] },
      draft: async prompt => { prompts.push(prompt); return { draft: { ...good, lead } }; } });
    const state = seeded(30), result = await run(state, h.deps);
    expect(prompts[0]).toContain('lead 的要求');
    expect(result.lead).toEqual({ status: 'live', text: lead });
    const sent = (h.started.find(s => s.send)!.request.items as Array<{ draft: { drafts: { primary: string } } }>)[0]!.draft.drafts.primary;
    expect(sent).toBe(lead);
    expect(state.leads).toHaveLength(1);
    expect(state.published).toHaveLength(31);
  });
  it('never asks for a lead on ordinary posts or when switched off', async () => {
    const prompts: string[] = [];
    const h = harness({ leadMode: async () => 'live', draft: async prompt => { prompts.push(prompt); return { draft: { ...good, lead } }; } });
    const result = await run(seeded(30), h.deps);
    expect(prompts[0]).not.toContain('lead 的要求');
    expect(result.lead).toEqual({ status: 'ineligible:no-stated-need' });
    const off = harness({ leadMode: async () => 'off' });
    expect((await run(seeded(30), off.deps)).lead).toEqual({ status: 'off' });
  });
});
