import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { stableContentId } from '@data-collector/shared';
import { NowcoderOperationsStore } from '../../packages/bridge/src/operations/store.js';
import { NowcoderOperationsActivity } from '../../packages/bridge/src/operations/activity.js';
import { NowcoderPublishingControl } from '../../packages/bridge/src/operations/publishingControl.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';
const dirs = createTemporaryDirectoryTracker();
afterEach(() => dirs.cleanup());
async function fixture() {
  const root = await dirs.create('workflow-');
  const module = await import('../../packages/bridge/src/operations/workflow.js').catch(() => undefined);
  expect(module, 'durable batch coordinator is available').toBeDefined();
  const store = new NowcoderOperationsStore(root, root), sent: string[] = [];
  const activity = new NowcoderOperationsActivity(store, { assertAvailable() {}, async execute(action) {
    if (action.kind !== 'publish') throw new Error('unexpected context');
    sent.push(action.url);
    return { kind: 'published', receipt: { sourceUrl: action.url, url: `https://www.nowcoder.com/discuss/comment/${100 + sent.length}`, text: action.text, observedAt: new Date().toISOString() } };
  } }, async () => Response.json({ success: true, code: 0, data: { totalPage: 1, records: [{ contentData: { id: '123456', title: 'Agent 求助', content: '怎么做项目', createTime: Date.now() } }] } }));
  const workflow = new module!.NowcoderOperationsWorkflow(join(root, 'runs'), store, activity, async () => ({ jobId: 'job-proof', status: 'needs_attention' }));
  await workflow.recover();
  return { root, module: module!, store, activity, workflow, sent };
}
async function seed(c: Awaited<ReturnType<typeof fixture>>, number: number) {
  const url = `https://www.nowcoder.com/discuss/${number}`, sourceId = stableContentId(url), id = `ops-${sourceId}`, now = new Date().toISOString();
  const title = '求 Agent 学习方向', body = '学过 LangGraph，想做一个能用的项目';
  await writeFile(join(c.root, `${id}.json`), JSON.stringify({ schemaVersion: 1, visibility: 'private', id, sourceId, canonicalUrl: url, title, body, contextHash: createHash('sha256').update(`${title}\n${body}`).digest('hex'), collectedAt: now, createdAt: now, updatedAt: now, revision: 1, status: 'queued', assessment: { fit: 'high', intent: 'learning', angle: '', reason: '', limitations: [] }, note: '' }));
  const entry = await c.store.saveConversation(id, { sourceUrl: url, readAt: now, post: { title, body, images: [] }, comments: [], coverage: { total: 0, observed: 0, pagesRead: 1, hasMore: false, complete: true, limitations: [] } });
  return { key: `single-key-${number}`, draft: { schemaVersion: 1, opportunityId: id, revision: entry.revision, contextHash: entry.contextHash, conversationHash: entry.conversation!.hash, drafts: { primary: '先做一个能用的工具', alternative: '从自己的资料做起', tone: 'contextual', anchor: 'LangGraph', notes: '' } } };
}
async function terminal(workflow: any, id: string) { for (let i = 0; i < 1500; i++) { const run = await workflow.get(id); if (!['running', 'queued'].includes(run.status)) return run; await new Promise(r => setTimeout(r, 5)); } throw new Error('not terminal'); }
async function controlled(c: Awaited<ReturnType<typeof fixture>>, interrupt = false) {
  let clock = Date.now(); const sentAt: number[] = [], sleeps: number[] = [];
  const control = new NowcoderPublishingControl(join(c.root, 'policy', 'control.json'), async () =>
    (await c.store.list()).flatMap(e => (e.publicationAttempts ?? []).map(publication => ({ opportunityId: e.id, sourceUrl: e.canonicalUrl, publication }))),
    { now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms;
      if (interrupt) await control.pause({ sourceUrl: 'https://www.nowcoder.com/discuss/123456', requestId: '12345678-1234-4234-8234-123456789012' }); } });
  const activity = new NowcoderOperationsActivity(c.store, { assertAvailable() {}, async execute(action) {
    if (action.kind !== 'publish') throw new Error('unexpected read'); sentAt.push(clock);
    return { kind: 'published', diagnostics: { pageStartedAt: new Date(clock).toISOString(), submitClickedAt: new Date(clock).toISOString() },
      receipt: { sourceUrl: action.url, url: `https://www.nowcoder.com/discuss/comment/${990 + sentAt.length}`, text: action.text, observedAt: new Date(clock).toISOString() } };
  } }, fetch, control);
  const workflow = new c.module.NowcoderOperationsWorkflow(join(c.root, 'controlled-runs'), c.store, activity, async () => { throw new Error('no collect'); });
  return { control, workflow, sentAt, sleeps };
}
it('checks whole-list publishing capacity before saving any draft', async () => {
  const c = await fixture(), a = await seed(c, 123456), b = await seed(c, 234567), x = await controlled(c);
  await x.control.configure({ minIntervalMs: 120000, maxPerHour: 1, maxPer24Hours: 20 });
  const run = await x.workflow.start({ schemaVersion: 1, kind: 'publish', key: 'budget-preflight-key', items: [a, b] }, true);
  expect(await terminal(x.workflow, run.runId)).toMatchObject({ status: 'needs_attention', counts: { failed: 1, notExecuted: 1 } });
  expect((await c.store.get(a.draft.opportunityId))!.revision).toBe(2);
  expect((await c.store.get(b.draft.opportunityId))!.revision).toBe(2); expect(x.sentAt).toEqual([]);
});
it('waits internally for the shared interval and returns bounded actual diagnostics', async () => {
  const c = await fixture(), a = await seed(c, 123456), b = await seed(c, 234567), x = await controlled(c);
  const run = await x.workflow.start({ schemaVersion: 1, kind: 'publish', key: 'internal-wait-key', items: [a, b] }, true);
  const done = await terminal(x.workflow, run.runId);
  expect(done.status).toBe('completed'); expect(x.sleeps.length).toBeGreaterThan(0);
  expect(x.sentAt[1]! - x.sentAt[0]!).toBeGreaterThanOrEqual(119000);
  expect(done.items[0]).toMatchObject({ diagnostics: { submitClickedAt: expect.any(String) } });
  expect(JSON.stringify(done)).not.toContain(a.draft.drafts.primary);
});
it('a challenge during cooldown stops before mutating or sending the next item', async () => {
  const c = await fixture(), a = await seed(c, 123456), b = await seed(c, 234567), x = await controlled(c, true);
  const run = await x.workflow.start({ schemaVersion: 1, kind: 'publish', key: 'cooldown-stop-key', items: [a, b] }, true);
  expect(await terminal(x.workflow, run.runId)).toMatchObject({ status: 'needs_attention', counts: { succeeded: 1, failed: 1 } });
  expect(x.sentAt).toHaveLength(1); expect((await c.store.get(b.draft.opportunityId))!.revision).toBe(2);
  expect((await x.control.status()).verification).not.toBeNull();
});
it('does not collect a preparation candidate while a global verification pause is pending', async () => {
  const c = await fixture(), x = await controlled(c);
  await x.control.pause({ sourceUrl: 'https://www.nowcoder.com/discuss/123456', requestId: '12345678-1234-4234-8234-123456789012' });
  let collected = 0;
  const workflow = new c.module.NowcoderOperationsWorkflow(join(c.root, 'paused-prepare'), c.store,
    new NowcoderOperationsActivity(c.store, { assertAvailable() {}, async execute() { throw new Error('no site access'); } }, fetch, x.control),
    async () => { collected++; return { jobId: 'must-not-start', status: 'failed' }; });
  const url = 'https://www.nowcoder.com/discuss/123456';
  const run = await workflow.start({ schemaVersion: 1, kind: 'prepare', key: 'paused-prepare-key', candidates: [{ sourceId: stableContentId(url), url }] });
  expect(await terminal(workflow, run.runId)).toMatchObject({ status: 'needs_attention' }); expect(collected).toBe(0);
});
it('deduplicates search URLs, persists private evidence, and binds keys to complete manifests', async () => {
  const c = await fixture(), request = { schemaVersion: 1, kind: 'search', key: 'search-batch-key-1', queries: ['Agent', '前端'] };
  const run = await c.workflow.start(request); const done = await terminal(c.workflow, run.runId);
  expect(done).toMatchObject({ status: 'completed', counts: { succeeded: 2, failed: 0 } });
  expect(JSON.stringify(done)).not.toContain('sourceUntrusted');
  const packet = JSON.parse(await readFile(done.resultPath, 'utf8'));
  expect(packet.candidates).toHaveLength(1);
  expect(await c.workflow.start(request)).toMatchObject({ runId: run.runId });
  await expect(c.workflow.start({ ...request, queries: ['different'] })).rejects.toThrow(/key|键/u);
});
it('preflights every publish draft before any mutation, then publishes once across batch replay', async () => {
  const c = await fixture(), first = await seed(c, 123456), second = await seed(c, 234567);
  const bad = { ...second, draft: { ...second.draft, revision: 999 } };
  const failed = await c.workflow.start({ schemaVersion: 1, kind: 'publish', key: 'batch-stale-key-1', items: [first, bad] }, true);
  expect(await terminal(c.workflow, failed.runId)).toMatchObject({ status: 'needs_attention' });
  expect((await c.store.get(first.draft.opportunityId))?.revision).toBe(2);
  expect(c.sent).toEqual([]);
  const request = { schemaVersion: 1, kind: 'publish', key: 'batch-good-key-01', items: [first, second] };
  const run = await c.workflow.start(request, true);
  expect(await terminal(c.workflow, run.runId)).toMatchObject({ status: 'completed', counts: { succeeded: 2, failed: 0, notExecuted: 0 } });
  await c.workflow.start(request, true); expect(c.sent).toHaveLength(2);
});
it('rejects missing send and duplicate identities; retains job proof when preparation stops', async () => {
  const c = await fixture(), item = await seed(c, 123456);
  await expect(c.workflow.start({ schemaVersion: 1, kind: 'publish', key: 'no-send-key-0001', items: [item] })).rejects.toThrow(/send/u);
  await expect(c.workflow.start({ schemaVersion: 1, kind: 'publish', key: 'duplicate-key-01', items: [item, item] }, true)).rejects.toThrow();
  const url = 'https://www.nowcoder.com/discuss/123456';
  await expect(c.workflow.start({ schemaVersion: 1, kind: 'prepare', key: 'bad-source-key-1', candidates: [{ sourceId: '000000000000', url }] })).rejects.toThrow();
  const run = await c.workflow.start({ schemaVersion: 1, kind: 'prepare', key: 'prepare-key-0001', candidates: [{ sourceId: stableContentId(url), url }, { sourceId: stableContentId('https://www.nowcoder.com/discuss/234567'), url: 'https://www.nowcoder.com/discuss/234567' }] });
  const done = await terminal(c.workflow, run.runId);
  expect(done).toMatchObject({ status: 'needs_attention', counts: { failed: 1, notExecuted: 1 } });
  expect(JSON.parse(await readFile(done.resultPath, 'utf8')).items[0].result).toMatchObject({ jobId: 'job-proof', status: 'needs_attention' });
});
it('holds busy before durable writes and recovers interrupted runs without dispatch', async () => {
  const c = await fixture();
  let release!: () => void;
  const w = new c.module.NowcoderOperationsWorkflow(join(c.root, 'other'), c.store, c.activity, async () => { await new Promise<void>(r => { release = r; }); return { jobId: 'pending', status: 'failed' }; });
  const url = 'https://www.nowcoder.com/discuss/123456';
  const pending = w.start({ schemaVersion: 1, kind: 'prepare', key: 'busy-prepare-key', candidates: [{ sourceId: stableContentId(url), url }] });
  expect(w.busy).toBe(true);
  await expect(w.start({ schemaVersion: 1, kind: 'search', key: 'busy-search-key1', queries: ['Agent'] })).rejects.toThrow(/busy|执行/u);
  const run = await pending;
  while (!release) await new Promise(r => setTimeout(r, 5));
  const recovered = new c.module.NowcoderOperationsWorkflow(join(c.root, 'other'), c.store, c.activity, async () => { throw new Error('must not replay'); });
  await recovered.recover(); expect(await recovered.get(run.runId)).toMatchObject({ status: 'needs_attention' }); release(); await w.drain();
});
it('preparation packet keeps full text once, anchors from frozen body and flags current conflicts', async () => {
  const c = await fixture(), item = await seed(c, 123456), id = item.draft.opportunityId;
  const packet = await c.store.preparationPacket(id) as any;
  expect(packet).toMatchObject({ sourceConflict: false, currentPost: { body: '学过 LangGraph，想做一个能用的项目' }, draftEnvelope: { opportunityId: id, revision: 2 } });
  expect(packet.frozenPost).toBeUndefined();
  expect(packet.anchorOptions.length).toBeGreaterThan(0);
  expect(packet.anchorOptions.every((s: string) => '学过 LangGraph，想做一个能用的项目'.includes(s))).toBe(true);
  const entry = (await c.store.get(id))!;
  await c.store.saveConversation(id, { ...entry.conversation!.snapshot, post: { ...entry.conversation!.snapshot.post, body: '当前正文已经修改，仍保留原始来源用于核对' } });
  expect(await c.store.preparationPacket(id)).toMatchObject({ sourceConflict: true, frozenPost: { body: '学过 LangGraph，想做一个能用的项目' }, currentPost: { body: '当前正文已经修改，仍保留原始来源用于核对' } });
});
it('returns an in-flight identical manifest without replay and stops after a rejected second publication', async () => {
 const c = await fixture(), first = await seed(c, 123456), second = await seed(c, 234567), third = await seed(c, 345678);
 let count = 0;
 const activity = new NowcoderOperationsActivity(c.store, { assertAvailable() {}, async execute(action) { count++; if (count === 2) return { kind: 'attention', code: 'CONTEXT_CHANGED', message: '评论已变', submission: 'not_attempted' }; if (action.kind !== 'publish') throw new Error('unexpected'); return { kind: 'published', receipt: { sourceUrl: action.url, url: 'https://www.nowcoder.com/discuss/comment/888', text: action.text, observedAt: new Date().toISOString() } }; } }, fetch);
 const workflow = new c.module.NowcoderOperationsWorkflow(join(c.root, 'stop'), c.store, activity, async () => { throw new Error('no collect'); });
 const request = { schemaVersion: 1, kind: 'publish', key: 'stop-publish-key-1', items: [first, second, third] };
 const started = workflow.start(request, true), replay = workflow.start(request, true);
 const run = await started; expect((await replay).runId).toBe(run.runId);
 expect(await terminal(workflow, run.runId)).toMatchObject({ status: 'needs_attention', counts: { succeeded: 1, failed: 1, notExecuted: 1 } });
 expect((await c.store.get(third.draft.opportunityId))!.revision).toBe(2);
 const packet = JSON.parse(await readFile((await workflow.get(run.runId)).resultPath, 'utf8'));
 expect(packet.items[1].result).toMatchObject({ publication: { state: 'rejected' }, attention: { code: 'CONTEXT_CHANGED' } });
});
it('records read-only preflight rejection against its item and reports refused/not-executed from durable details', async () => {
 const c = await fixture(), first = await seed(c, 123456), second = await seed(c, 234567);
 const run = await c.workflow.start({ schemaVersion: 1, kind: 'publish', key: 'preflight-stats-key', items: [first, { ...second, draft: { ...second.draft, conversationHash: 'a'.repeat(64) } }] }, true);
 const status = await terminal(c.workflow, run.runId);
 expect(status).toMatchObject({ counts: { succeeded: 0, failed: 1, rejected: 1, notExecuted: 1 } });
 expect(status.items[1].stages).toContainEqual(expect.objectContaining({ stage: 'preflight', status: 'failed', elapsedMs: expect.any(Number) }));
 expect(c.sent).toEqual([]);
});
it('recovers packet item/stage state and elapsed times while preserving prepared and search payloads', async () => {
 const c = await fixture(), { WorkflowStore } = await import('../../packages/bridge/src/operations/workflowStore.js');
 const disk = new WorkflowStore(join(c.root, 'recover-packet')), runId = 'workflow-recovery-packet', startedAt = new Date(Date.now() - 10000).toISOString();
 const request = { schemaVersion: 1 as const, kind: 'search' as const, key: 'recovery-packet-key', queries: ['Agent'], limitPerQuery: 8 };
 const run = { schemaVersion: 1 as const, runId, request, digest: disk.digest(request), status: 'running' as const, startedAt, resultPath: disk.resultPath(runId), items: [{ status: 'running' as const, result: { jobId: 'exact-recovery-job', status: 'saved' }, stages: [{ stage: 'context', startedAt, status: 'running' }] }] };
 await disk.save(run); const prepared = [{ currentPost: { body: '保留完整已观察材料' } }], candidates = [{ url: 'https://www.nowcoder.com/discuss/123456' }];
 await disk.packet(run, { runId, items: run.items, prepared, candidates });
 const recovered = new c.module.NowcoderOperationsWorkflow(join(c.root, 'recover-packet'), c.store, c.activity, async () => { throw new Error('must not replay'); });
 await recovered.recover(); const status = await recovered.get(runId), packet = JSON.parse(await readFile(status.resultPath, 'utf8'));
 expect(packet).toMatchObject({ prepared, candidates, items: [{ status: 'failed', result: { jobId: 'exact-recovery-job' }, stages: [{ status: 'interrupted', elapsedMs: expect.any(Number), finishedAt: status.finishedAt }] }] });
 expect(packet.items[0].stages[0].elapsedMs).toBeGreaterThanOrEqual(10000);
 expect(packet.items[0].stages).toEqual(status.items[0].stages);
 expect(JSON.parse(await readFile(disk.path(runId), 'utf8')).elapsedMs).toBe(status.elapsedMs);
});

async function journalPublication(c: Awaited<ReturnType<typeof fixture>>, item: Awaited<ReturnType<typeof seed>>) {
 const saved = await c.store.update(item.draft.opportunityId, { revision: item.draft.revision, contextHash: item.draft.contextHash, conversationHash: item.draft.conversationHash, drafts: item.draft.drafts });
 await c.store.beginPublication(saved.id, { revision: saved.revision, contextHash: saved.contextHash, key: item.key, send: true }, '12345678-1234-4234-8234-123456789012');
 const receipt = { sourceUrl: saved.canonicalUrl, url: 'https://www.nowcoder.com/discuss/comment/880001', text: item.draft.drafts.primary, observedAt: new Date().toISOString() };
 const publication = await c.store.finishPublication(saved.id, item.key, { kind: 'published', receipt });
 return { publication, receipt };
}
async function recoveryFixture(c: Awaited<ReturnType<typeof fixture>>, request: any, items: any[]) {
 const { WorkflowStore, workflowRequestSchema } = await import('../../packages/bridge/src/operations/workflowStore.js');
 request = workflowRequestSchema.parse(request);
 const root = join(c.root, 'recovery-ahead'), disk = new WorkflowStore(root), runId = 'workflow-evidence-ahead', startedAt = new Date(Date.now() - 10000).toISOString();
 const run = { schemaVersion: 1 as const, runId, request, digest: disk.digest(request), status: 'running' as const, startedAt, resultPath: disk.resultPath(runId), items };
 await disk.save(run);
 const workflow = new c.module.NowcoderOperationsWorkflow(root, c.store, c.activity, async () => { throw new Error('must not collect on recovery'); });
 return { disk, run, workflow };
}
it('preserves a newer packet receipt and reconciles its success without continuing the batch', async () => {
 const c = await fixture(), first = await seed(c, 123456), second = await seed(c, 234567), evidence = await journalPublication(c, first), time = new Date(Date.now() - 1000).toISOString();
 const request = { schemaVersion: 1, kind: 'publish', key: 'recovery-packet-ahead', items: [first, second] };
 const r = await recoveryFixture(c, request, [{ id: first.draft.opportunityId, status: 'running', stages: [{ stage: 'publish', status: 'succeeded', startedAt: time, finishedAt: time, elapsedMs: 0 }] }, { id: second.draft.opportunityId, status: 'not_executed', stages: [] }]);
 await r.disk.packet(r.run, { runId: r.run.runId, items: [{ ...r.run.items[0], status: 'succeeded', result: { id: first.draft.opportunityId, ...evidence } }, r.run.items[1]] });
 await r.workflow.recover(); const status = await r.workflow.get(r.run.runId), packet = JSON.parse(await readFile(status.resultPath, 'utf8'));
 expect(packet.items[0].result).toMatchObject(evidence);
 expect(JSON.stringify(status)).not.toContain(evidence.receipt.text);
 expect(status).toMatchObject({ status: 'needs_attention', counts: { succeeded: 1, failed: 0, notExecuted: 1 } });
 expect((await r.workflow.start(request, true)).runId).toBe(r.run.runId); expect(c.sent).toEqual([]);
 expect((await c.store.get(first.draft.opportunityId))!.publicationAttempts).toHaveLength(1);
});
it('reconciles an already-published journal before any batch result exists without inventing observedAt', async () => {
 const c = await fixture(), first = await seed(c, 123456), evidence = await journalPublication(c, first), time = new Date(Date.now() - 1000).toISOString();
 const request = { schemaVersion: 1, kind: 'publish', key: 'recovery-journal-ahead', items: [first] };
 const r = await recoveryFixture(c, request, [{ id: first.draft.opportunityId, status: 'running', stages: [{ stage: 'publish', status: 'running', startedAt: time }] }]);
 await r.disk.packet(r.run, { runId: r.run.runId, items: r.run.items }); await r.workflow.recover();
 const status = await r.workflow.get(r.run.runId), packet = JSON.parse(await readFile(status.resultPath, 'utf8'));
 expect(status).toMatchObject({ status: 'needs_attention', counts: { succeeded: 1, failed: 0 } });
 expect(packet.items[0].result).toMatchObject({ publication: evidence.publication });
 expect(packet.items[0].result).not.toHaveProperty('receipt'); expect(JSON.stringify(packet)).not.toContain('\"observedAt\":');
 expect(c.sent).toEqual([]);
});
it('retains a newer bound job result and preparation payload when the run still contains queued proof', async () => {
 const c = await fixture(), sourceId = stableContentId('https://www.nowcoder.com/discuss/123456'), time = new Date().toISOString();
 const request = { schemaVersion: 1, kind: 'prepare', key: 'recovery-job-proof-key', candidates: [{ sourceId, url: 'https://www.nowcoder.com/discuss/123456' }], maxPages: 2 };
 const r = await recoveryFixture(c, request, [{ sourceId, status: 'running', stages: [{ stage: 'collect', status: 'running', startedAt: time }], result: { jobId: 'exact-current-job', status: 'queued' } }]);
 const prepared = [{ sourceId, currentPost: { body: '实际已观察到的完整正文' } }];
 await r.disk.packet(r.run, { runId: r.run.runId, prepared, items: [{ ...r.run.items[0], result: { jobId: 'exact-current-job', status: 'saved', contentAccess: 'full' } }] });
 await r.workflow.recover(); const status = await r.workflow.get(r.run.runId), packet = JSON.parse(await readFile(status.resultPath, 'utf8'));
 expect(packet).toMatchObject({ prepared, items: [{ status: 'failed', result: { jobId: 'exact-current-job', status: 'saved', contentAccess: 'full' } }] });
 expect(status).toMatchObject({ status: 'needs_attention', counts: { failed: 1 } }); expect(c.sent).toEqual([]);
});
it('does not attach swapped packet items to another request index while retaining their raw evidence', async () => {
 const c = await fixture(), first = await seed(c, 123456), second = await seed(c, 234567), evidence = await journalPublication(c, first), time = new Date().toISOString();
 const request = { schemaVersion: 1, kind: 'publish', key: 'recovery-index-binding', items: [first, second] };
 const r = await recoveryFixture(c, request, [{ id: first.draft.opportunityId, status: 'running', stages: [{ stage: 'publish', status: 'running', startedAt: time }] }, { id: second.draft.opportunityId, status: 'not_executed', stages: [] }]);
 await r.disk.packet(r.run, { runId: r.run.runId, items: [{ id: second.draft.opportunityId, status: 'succeeded', stages: [], result: { id: second.draft.opportunityId, receipt: evidence.receipt } }, { id: first.draft.opportunityId, status: 'succeeded', stages: [], result: { id: first.draft.opportunityId, ...evidence } }] });
 await r.workflow.recover(); const status = await r.workflow.get(r.run.runId), packet = JSON.parse(await readFile(status.resultPath, 'utf8'));
 expect(status).toMatchObject({ counts: { succeeded: 1, notExecuted: 1 } });
 expect(packet.items[0].result).toMatchObject({ publication: evidence.publication }); expect(packet.items[0].result).not.toHaveProperty('receipt');
 expect(packet.items[1]).not.toHaveProperty('result'); expect(packet.recoveryUnmatchedItems).toHaveLength(2);
 expect(packet.recoveryUnmatchedItems[1].item.result.receipt).toEqual(evidence.receipt); expect(c.sent).toEqual([]);
});
it('does not count a journal publication for a different requested draft as recovered success', async () => {
 const c = await fixture(), first = await seed(c, 123456); await journalPublication(c, first);
 const altered = { ...first, draft: { ...first.draft, drafts: { ...first.draft.drafts, primary: '这是另一个未发出的主草稿' } } };
 const request = { schemaVersion: 1, kind: 'publish', key: 'recovery-draft-binding', items: [altered] };
 const r = await recoveryFixture(c, request, [{ id: first.draft.opportunityId, status: 'running', stages: [] }]);
 await r.disk.packet(r.run, { runId: r.run.runId, items: r.run.items }); await r.workflow.recover();
 expect(await r.workflow.get(r.run.runId)).toMatchObject({ status: 'needs_attention', counts: { succeeded: 0, failed: 1 } });
 expect(c.sent).toEqual([]);
});
it('quarantines packet payloads with another request digest instead of attributing them to this run', async () => {
 const c = await fixture(), sourceId = stableContentId('https://www.nowcoder.com/discuss/123456');
 const request = { schemaVersion: 1, kind: 'prepare', key: 'recovery-request-binding', candidates: [{ sourceId, url: 'https://www.nowcoder.com/discuss/123456' }], maxPages: 2 };
 const r = await recoveryFixture(c, request, [{ sourceId, status: 'running', stages: [] }]);
 const prepared = [{ currentPost: { body: '其他清单的原始准备材料，不可丢弃或冒认' } }];
 await writeFile(r.run.resultPath, JSON.stringify({ runId: r.run.runId, requestDigest: 'f'.repeat(64), prepared, items: [{ sourceId, status: 'succeeded', stages: [], result: { jobId: 'another-request-job', status: 'saved' } }] }));
 await r.workflow.recover(); const status = await r.workflow.get(r.run.runId), packet = JSON.parse(await readFile(status.resultPath, 'utf8'));
 expect(packet).not.toHaveProperty('prepared'); expect(packet.recoveryUnmatchedPacket.prepared).toEqual(prepared);
 expect(packet.items[0]).not.toHaveProperty('result'); expect(status).toMatchObject({ status: 'needs_attention', counts: { succeeded: 0, failed: 1 } });
});
