import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { JobStore } from '../../packages/bridge/src/jobs/store.js';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_VERSION, NOWCODER_BROWSER_OPERATIONS_CAPABILITY, TRUSTED_EXTENSION_ID, stableContentId, type CollectedDocument } from '@data-collector/shared';
import { startBridge, type BridgeHandle } from '../../packages/bridge/src/server/index.js';
import { MarkdownLibrary, listLibrary } from '../../packages/bridge/src/library/index.js';
import { organize } from '../../packages/bridge/src/organize/index.js';
import { runCli } from '../../packages/bridge/src/cli.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const temporaryDirectories = createTemporaryDirectoryTracker();
const bridges: BridgeHandle[] = [];
const sockets: WebSocket[] = [];
const token = 'operations-test-token-00000000000000000000';
const url = 'https://www.nowcoder.com/discuss/123456';
afterEach(async () => {
  sockets.splice(0).forEach(socket => socket.terminate());
  await Promise.all(bridges.splice(0).map(bridge => bridge.close()));
  vi.useRealTimers();
  await temporaryDirectories.cleanup();
});

async function fixture(overrides: Partial<CollectedDocument> = {}, bridgeOptions: Partial<Parameters<typeof startBridge>[0]> = {}) {
  const root = await temporaryDirectories.create('nowcoder-operations-');
  const configDir = join(root, 'config'), libraryRoot = join(root, 'library');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'auth.json'), JSON.stringify({ version: 1, token }));
  const document: CollectedDocument = {
    schemaVersion: 1, source: 'nowcoder', kind: 'post', url, canonicalUrl: url,
    title: '学了 LangGraph 后怎么准备 Agent 项目面试？',
    text: '我学过 Java 和 LangGraph，但不知道下一步该做什么项目，希望补上 Agent 项目的工程实践。',
    html: '<p>我学过 Java 和 LangGraph，但不知道下一步该做什么项目，希望补上 Agent 项目的工程实践。</p>',
    collectedAt: '2026-10-28T06:00:00.000Z', images: [], ...overrides,
  };
  await new MarkdownLibrary({ root: libraryRoot }).save(organize(document));
  const bridge = await startBridge({ port: 0, configDir, libraryRoot,
    fetch: async () => { throw new Error('Operations must not make network requests'); }, ...bridgeOptions });
  bridges.push(bridge);
  const request = async (method: string, path: string, body?: unknown, authorized = true) => {
    const response = await fetch(`${bridge.url}${path}`, { method,
      headers: { ...(authorized ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { root, configDir, libraryRoot, bridge, document, request, sourceId: stableContentId(url) };
}

describe('private Nowcoder operations workflow', () => {
  it('authenticates global limits, validates policy and retains historical attempts across configuration', async () => {
    const c = await fixture(), path = '/v1/nowcoder/operations/publishing';
    expect((await c.request('GET', path, undefined, false)).status).toBe(401);
    expect((await c.request('GET', path)).body).toMatchObject({ policy: { minIntervalMs: 120000, maxPerHour: 5, maxPer24Hours: 20 }, usage: { lastHour: 0, last24Hours: 0 }, verification: null });
    expect((await c.request('PUT', path, { minIntervalMs: 0, maxPerHour: 5, maxPer24Hours: 20 })).status).toBe(400);
    const policy = { minIntervalMs: 240000, maxPerHour: 3, maxPer24Hours: 10 };
    expect((await c.request('PUT', path, policy)).body.policy).toEqual(policy);
    expect(JSON.parse(await readFile(join(c.configDir, 'nowcoder-publishing.json'), 'utf8')).policy).toEqual(policy);
    expect((await c.request('POST', `${path}/resume`, { id: '12345678-1234-4234-8234-123456789012' })).status).toBe(400);
    expect((await c.request('POST', `${path}/resume`, { id: '12345678-1234-4234-8234-123456789012', verificationCompleted: true })).status).toBe(409);
  });
  it('stops all operation reads after a challenge and reconciles the original attempt without another submit', async () => {
    const c = await fixture(), base = '/v1/nowcoder/operations';
    let entry = (await c.request('POST', base, { sourceId: c.sourceId })).body.entry;
    const socket = new WebSocket(`${c.bridge.wsUrl}?token=${token}`, { origin: `chrome-extension://${TRUSTED_EXTENSION_ID}` }); sockets.push(socket);
    await once(socket, 'open');
    const envelope = (type: string, requestId: string, payload: unknown) => JSON.stringify({ protocolVersion: 1, type, requestId, timestamp: new Date().toISOString(), payload });
    socket.send(envelope('extension.hello', 'hello', { version: APP_VERSION, capabilities: [NOWCODER_BROWSER_OPERATIONS_CAPABILITY] }));
    await vi.waitFor(async () => expect((await c.request('GET', '/health')).body.extensionConnected).toBe(true));
    const actions: string[] = []; let sentText = '';
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()); if (message.type !== 'operations.execute') return;
      actions.push(message.payload.kind); const at = new Date().toISOString();
      if (message.payload.kind === 'publish') {
        sentText = message.payload.text;
        socket.send(envelope('operations.result', message.requestId, { kind: 'attention', code: 'VERIFICATION_REQUIRED', message: '牛客要求验证，请在保留页面完成', submission: 'uncertain', diagnostics: { pageStartedAt: at, submitClickedAt: at, verificationObservedAt: at } }));
      } else socket.send(envelope('operations.result', message.requestId, { kind: 'context', snapshot: { sourceUrl: url, readAt: at, post: { title: c.document.title, body: c.document.text, images: [] },
        comments: sentText ? [{ url: 'https://www.nowcoder.com/discuss/comment/991001', parentUrl: null, text: sentText, images: [], isAuthor: false, likes: null }] : [],
        coverage: { total: sentText ? 1 : 0, observed: sentText ? 1 : 0, pagesRead: 1, hasMore: false, complete: true, limitations: [] } } }));
    });
    const path = `${base}/${entry.id}`;
    const context = (await c.request('POST', `${path}/context`, {})).body;
    entry = (await c.request('PUT', path, { revision: context.revision, contextHash: context.contextHash, conversationHash: context.conversationHash, drafts: { primary: '拿自己的资料做个小工具呗', alternative: '先跑通一个场景', tone: 'contextual', anchor: 'LangGraph', notes: '' } })).body.entry;
    const input = { revision: entry.revision, contextHash: entry.contextHash, key: 'verification-real-api-key', send: true };
    const result = await c.request('POST', `${path}/publish`, input);
    expect(result.body.publication).toMatchObject({ state: 'uncertain', attentionCode: 'VERIFICATION_REQUIRED', diagnostics: { submitClickedAt: expect.any(String) } });
    const status = (await c.request('GET', `${base}/publishing`)).body;
    expect(status).toMatchObject({ usage: { lastHour: 1 }, verification: { key: input.key, sourceUrl: url } });
    expect((await c.request('POST', `${path}/context`, {})).status).toBe(409);
    expect((await c.request('POST', `${base}/search`, { query: 'Agent' })).status).toBe(409);
    expect((await c.request('POST', `${path}/publish`, input)).body.publication.state).toBe('uncertain');
    const resumed = await c.request('POST', `${base}/publishing/resume`, { id: status.verification.id, verificationCompleted: true });
    expect(resumed.body).toMatchObject({ status: { verification: null, usage: { lastHour: 1 } }, publication: { state: 'published', replyUrl: 'https://www.nowcoder.com/discuss/comment/991001' } });
    expect(actions).toEqual(['context', 'publish', 'context']);
  });
  it('reads comments and publishes the stored draft through authenticated plugin RPC and compact CLI JSON', async () => {
    const c = await fixture(), base = '/v1/nowcoder/operations';
    const { entry } = (await c.request('POST', base, { sourceId: c.sourceId })).body;
    const socket = new WebSocket(`${c.bridge.wsUrl}?token=${token}`, { origin: `chrome-extension://${TRUSTED_EXTENSION_ID}` });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const envelope = (type: string, requestId: string, payload: unknown) => JSON.stringify({ protocolVersion: 1, type, requestId, timestamp: new Date().toISOString(), payload });
    socket.send(envelope('extension.hello', 'hello', { version: APP_VERSION, capabilities: [NOWCODER_BROWSER_OPERATIONS_CAPABILITY] }));
    await vi.waitFor(async () => { expect((await c.request('GET', '/health')).body.extensionConnected).toBe(true); });
    const sent: string[] = [];
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'operations.execute') return;
      sent.push(message.payload.kind);
      socket.send(envelope('operations.result', message.requestId, message.payload.kind === 'context' ? { kind: 'context', snapshot: {
        sourceUrl: url, readAt: new Date().toISOString(), post: { title: c.document.title, body: c.document.text, images: [] },
        comments: [{ url: 'https://www.nowcoder.com/discuss/comment/100001', parentUrl: null, text: '先从自己的需求做起', images: [], isAuthor: false, likes: null }],
        coverage: { total: 1, observed: 1, pagesRead: 1, hasMore: false, complete: true, limitations: [] },
      } } : { kind: 'published', receipt: { sourceUrl: url, url: 'https://www.nowcoder.com/discuss/comment/100002', text: message.payload.text, observedAt: new Date().toISOString() } }));
    });
    const options = ['--port', String(new URL(c.bridge.url).port), '--config', c.configDir];
    let output = '', error = '';
    const io = { stdout: (v: string) => { output += v; }, stderr: (v: string) => { error += v; } };
    expect(await runCli(['nowcoder', 'ops', 'context', '--id', entry.id, ...options], io)).toBe(0);
    const context = JSON.parse(output); output = '';
    expect(context.sourceUntrusted.comments[0]).toMatchObject({ likes: null, text: '先从自己的需求做起' });
    const path = join(c.root, 'plugin-draft.private.json');
    await writeFile(path, JSON.stringify({ schemaVersion: 1, opportunityId: entry.id, revision: context.revision, contextHash: context.contextHash, conversationHash: context.conversationHash,
      drafts: { primary: '先做个同事能用的文档问答呗', alternative: '拿自己的资料先做个小工具', tone: 'practical', anchor: 'LangGraph', notes: '已读取插件评论上下文' } }));
    expect(await runCli(['nowcoder', 'ops', 'draft', '--file', path, ...options], io)).toBe(0);
    const saved = JSON.parse(output).entry; output = '';
    const publishArgs = ['nowcoder', 'ops', 'publish', '--id', entry.id, '--revision', String(saved.revision), '--key', 'authorized-integration-001', ...options];
    expect(await runCli(publishArgs, io)).toBe(1);
    expect(sent).toEqual(['context']); error = '';
    expect(await runCli([...publishArgs, '--send'], io)).toBe(0);
    expect(JSON.parse(output).publication).toMatchObject({ state: 'published', replyUrl: 'https://www.nowcoder.com/discuss/comment/100002' });
    output = '';
    expect(await runCli([...publishArgs, '--send'], io)).toBe(0);
    expect(sent).toEqual(['context', 'publish']);
    output = '';
    expect(await runCli(['nowcoder', 'ops', 'verify', '--id', entry.id, '--key', 'authorized-integration-001', ...options], io)).toBe(0);
    expect(JSON.parse(output).publication).toMatchObject({ state: 'published', evidence: 'observed' });
    expect(sent).toEqual(['context', 'publish']);
    expect(error).toBe('');
  });
  it('persists one frozen source per URL without delivering or adding another library entry', async () => {
    const c = await fixture(), path = '/v1/nowcoder/operations';
    expect((await c.request('GET', path, undefined, false)).status).toBe(401);
    expect(await c.request('GET', path)).toEqual({ status: 200, body: { entries: [] } });
    const created = await c.request('POST', path, { sourceId: c.sourceId });
    expect(created.status).toBe(200);
    expect(created.body.entry).toMatchObject({ status: 'queued', body: c.document.text,
      visibility: 'private', revision: 1, assessment: { fit: 'high' } });
    const duplicate = await c.request('POST', path, { sourceId: c.sourceId });
    expect(duplicate.body.entry.id).toBe(created.body.entry.id);
    expect(duplicate.body.entry.revision).toBe(1);
    const saved = JSON.parse(await readFile(join(c.configDir, 'nowcoder-operations', `${created.body.entry.id}.json`), 'utf8'));
    expect(saved.contextHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await c.request('GET', path)).body.entries).toHaveLength(1);
    expect((await c.request('GET', path)).body.entries[0]).not.toHaveProperty('body');
    expect(await listLibrary(c.libraryRoot)).toHaveLength(1);
    expect((await c.request('GET', '/v1/plans/batches')).body.batches).toEqual([]);
  });

  it('rejects stale imports and requires a comment link before manually recording a reply', async () => {
    const c = await fixture();
    const { entry } = (await c.request('POST', '/v1/nowcoder/operations', { sourceId: c.sourceId })).body;
    const path = `/v1/nowcoder/operations/${entry.id}`;
    const drafts = { primary: '先给已有项目补一个失败恢复场景。', alternative: '可以先把任务状态持久化，再模拟处理中断，验证重启后能恢复到哪一步。', tone: 'practical', anchor: 'LangGraph', notes: '未读取评论，请核对是否已有相同回答。' };
    expect((await c.request('PUT', path, { revision: 1, contextHash: '0'.repeat(64), drafts })).status).toBe(409);
    const saved = await c.request('PUT', path, { revision: 1, contextHash: entry.contextHash, drafts, note: '下一版少讲道理，先接住迷茫。' });
    expect(saved.body.entry).toMatchObject({ status: 'drafted', revision: 2, drafts });
    const nextBrief = await c.request('GET', `${path}?brief=1`);
    expect(nextBrief.body.feedback).toBe('下一版少讲道理，先接住迷茫。');
    expect(nextBrief.body.previousDrafts.primary).toBe(drafts.primary);
    expect((await c.request('PUT', path, { revision: 1, note: 'stale' })).status).toBe(409);
    expect((await c.request('PUT', path, { revision: 2, status: 'replied' })).status).toBe(400);
    expect((await c.request('PUT', path, { revision: 2, status: 'replied', replyUrl: url })).status).toBe(400);
    const replied = await c.request('PUT', path, { revision: 2, status: 'replied', replyUrl: 'https://www.nowcoder.com/discuss/comment/22846505' });
    expect(replied.body.entry).toMatchObject({ status: 'replied', revision: 3 });
    expect((await c.request('PUT', path, { revision: 3, contextHash: entry.contextHash, drafts })).status).toBe(409);
  });

  it('refuses truncated source context rather than generating an apparently complete brief', async () => {
    const c = await fixture({ truncated: true, sourceMetadata: { contentAccess: 'paywalled' } });
    const result = await c.request('POST', '/v1/nowcoder/operations', { sourceId: c.sourceId });
    expect(result.status).toBe(409);
    expect(result.body.error.message).toContain('完整正文');
    expect((await c.request('GET', '/v1/nowcoder/operations')).body.entries).toEqual([]);
  });

  it('runs CLI add, untrusted-context brief and revision-bound draft import through the real API', async () => {
    const c = await fixture();
    const options = ['--port', String(new URL(c.bridge.url).port), '--config', c.configDir];
    let output = '', error = '';
    const io = { stdout: (value: string) => { output += value; }, stderr: (value: string) => { error += value; } };
    expect(await runCli(['nowcoder', 'ops', 'add', '--source', c.sourceId, ...options], io)).toBe(0);
    const { entry } = JSON.parse(output); output = '';
    expect(await runCli(['nowcoder', 'ops', 'brief', '--id', entry.id, ...options], io)).toBe(0);
    const brief = JSON.parse(output); output = '';
    expect(brief.sourceUntrusted.body).toBe(c.document.text);
    expect(brief.commentsStatus).toBe('not-collected');
    expect(brief.commentContextRequired).toBe(true);
    expect(brief.assessment).not.toHaveProperty('angle');
    expect(brief.references).toContain('.codex/skills/data-collector-delivery/references/nowcoder-replies.md');
    const path = join(c.root, 'draft.private.json');
    await writeFile(path, JSON.stringify({ schemaVersion: 1, opportunityId: entry.id, revision: entry.revision,
      contextHash: entry.contextHash, drafts: { primary: '先补一个可检验的小场景。', alternative: '已有项目可以先记录任务状态，模拟中断后确认恢复过程和重复任务的处理。', tone: 'practical', anchor: 'LangGraph', notes: '' } }));
    expect(await runCli(['nowcoder', 'ops', 'draft', '--file', path, ...options], io)).toBe(0);
    expect(JSON.parse(output).entry.status).toBe('drafted');
    expect(error).toBe('');
  });
});
it('authenticates durable workflow routes and returns compact failed preparation with exact job evidence', async () => {
 const c = await fixture(), base = '/v1/nowcoder/operations/workflow';
 const body = { schemaVersion: 1, kind: 'search', key: 'authenticated-search-01', queries: ['Agent'] };
 expect((await c.request('POST', base, body, false)).status).toBe(401);
 const started = await c.request('POST', base, body); expect(started.status).toBe(202);
 await vi.waitFor(async () => expect((await c.request('GET', `${base}/${started.body.runId}`)).body.status).toBe('needs_attention'), { timeout: 10000 });
 expect((await c.request('GET', `${base}/${started.body.runId}/stats`)).body).toMatchObject({ counts: { failed: 1 }, resultPath: expect.stringContaining('.private.json') });
 const replay = await c.request('POST', base, body); expect(replay.body.runId).toBe(started.body.runId);
 expect((await c.request('POST', base, { ...body, queries: ['changed'] })).status).toBe(409);
});
it('prepares through the ordinary job queue and fences external writes while preserving exact collection proof', async () => {
 const c = await fixture({ sourceMetadata: { contentAccess: 'full' } }), base = '/v1/nowcoder/operations/workflow';
 const socket = new WebSocket(`${c.bridge.wsUrl}?token=${token}`, { origin: `chrome-extension://${TRUSTED_EXTENSION_ID}` }); sockets.push(socket);
 await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
 const envelope = (type: string, requestId: string, payload: unknown) => JSON.stringify({ protocolVersion: 1, type, requestId, timestamp: new Date().toISOString(), payload });
 socket.send(envelope('extension.hello', 'hello', { version: APP_VERSION, capabilities: [NOWCODER_BROWSER_OPERATIONS_CAPABILITY] }));
 await vi.waitFor(async () => expect((await c.request('GET', '/health')).body.extensionConnected).toBe(true));
 let jobId = '', contextId = '';
 socket.on('message', raw => { const msg = JSON.parse(raw.toString()); if (msg.type === 'job.collect') { jobId = msg.requestId; socket.send(envelope('job.result', msg.requestId, { document: c.document })); } if (msg.type === 'operations.execute') contextId = msg.requestId; });
 const request = { schemaVersion: 1, kind: 'prepare', key: 'prepare-integration-01', candidates: [{ sourceId: c.sourceId, url }] };
 const started = await c.request('POST', base, request); expect(started.status).toBe(202);
 await vi.waitFor(() => expect(contextId).not.toBe(''), { timeout: 10000 });
 expect((await c.request('POST', base, request)).body.runId).toBe(started.body.runId);
 expect((await c.request('POST', '/v1/jobs', { url, requestedBy: 'codex' })).status).toBe(409);
 expect((await c.request('POST', '/v1/nowcoder/operations', { sourceId: c.sourceId })).status).toBe(409);
 socket.send(envelope('operations.result', contextId, { kind: 'context', snapshot: { sourceUrl: url, readAt: new Date().toISOString(), post: { title: c.document.title, body: c.document.text, images: [] }, comments: [], coverage: { total: null, observed: 0, pagesRead: 1, hasMore: false, complete: false, limitations: ['评论总数未知'] } } }));
 await vi.waitFor(async () => expect((await c.request('GET', `${base}/${started.body.runId}`)).body.status).toBe('completed'), { timeout: 10000 });
 const status = (await c.request('GET', `${base}/${started.body.runId}`)).body;
 const packet = JSON.parse(await readFile(status.resultPath, 'utf8'));
 expect(packet.items[0].result).toMatchObject({ jobId, status: 'saved' });
 expect(packet.prepared[0]).toMatchObject({ currentPost: { body: c.document.text }, conversation: { coverage: { total: null, complete: false } }, draftEnvelope: { opportunityId: `ops-${c.sourceId}` } });
 expect((await c.request('GET', '/v1/plans/batches')).body.batches).toEqual([]);
 // A saved job alone is not full-body evidence: the current extractor must attest full access.
 delete c.document.sourceMetadata;
 socket.on('message', raw => { const msg = JSON.parse(raw.toString()); if (msg.type === 'operations.execute') socket.send(envelope('operations.result', msg.requestId, { kind: 'context', snapshot: { sourceUrl: url, readAt: new Date().toISOString(), post: { title: c.document.title, body: c.document.text, images: [] }, comments: [], coverage: { total: 0, observed: 0, pagesRead: 1, hasMore: false, complete: true, limitations: [] } } })); });
 const unproven = await c.request('POST', base, { ...request, key: 'prepare-unproven-01' });
 await vi.waitFor(async () => expect((await c.request('GET', `${base}/${unproven.body.runId}`)).body.status).toBe('needs_attention'), { timeout: 10000 });
 const stopped = (await c.request('GET', `${base}/${unproven.body.runId}`)).body;
 expect(JSON.parse(await readFile(stopped.resultPath, 'utf8')).items[0].result).toMatchObject({ jobId: expect.any(String), status: 'needs_attention', errorCode: 'OPERATIONS_SOURCE_INCOMPLETE' });
});

it('fences automatic due-plan ticks across the whole asynchronous workflow', async () => {
 vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
 let release!: (value: Response) => void;
 const blocked = new Promise<Response>(resolve => { release = resolve; });
 const c = await fixture({}, { enableCollectionPlanScheduler: true, collectionPlanCheckIntervalMs: 10000, fetch: async () => blocked });
 const base = '/v1/nowcoder/operations/workflow';
 const started = await c.request('POST', base, { schemaVersion: 1, kind: 'search', key: 'scheduler-fence-key', queries: ['Agent'] });
 expect(started.status).toBe(202);
 try {
   await vi.advanceTimersByTimeAsync(10000);
   await new Promise(resolve => setTimeout(resolve, 300));
   expect((await c.request('GET', '/v1/plans/batches')).body.batches).toEqual([]);
 } finally { release(Response.json({ success: true, code: 0, data: { totalPage: 1, records: [] } })); }
 await vi.waitFor(async () => expect((await c.request('GET', `${base}/${started.body.runId}`)).body.status).toBe('completed'), { timeout: 10000 });
});

it('reserves an external streaming-body operation before workflow admission and releases on completion', async () => {
 const c = await fixture(), base = '/v1/nowcoder/operations', entry = (await c.request('POST', base, { sourceId: c.sourceId })).body.entry;
 const pending = httpRequest(`${c.bridge.url}${base}/${entry.id}/context`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', expect: '100-continue' } });
 const response = new Promise<{ status: number; body: any }>((resolve, reject) => { pending.on('response', res => { let raw = ''; res.on('data', chunk => { raw += chunk; }); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(raw) })); }); pending.on('error', reject); });
 pending.flushHeaders(); await once(pending, 'continue'); pending.write('{"maxPages":');
 const workflowRequest = { schemaVersion: 1, kind: 'search', key: 'streaming-admission-key', queries: ['Agent'] };
 try {
   const blocked = await c.request('POST', `${base}/workflow`, workflowRequest);
   expect(blocked).toMatchObject({ status: 409, body: { error: { code: 'WORKFLOW_BUSY' } } });
   expect(await readdir(join(c.configDir, 'nowcoder-workflows')).catch(() => [])).toEqual([]);
 } finally { pending.end('1}'); await response; }
 expect((await c.request('POST', `${base}/workflow`, workflowRequest)).status).toBe(202);
});
it('reserves external job creation through asynchronous insertion before a job is visible', async () => {
 const c = await fixture(); let release!: () => void, entered!: () => void;
 const insertion = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
 const original = JobStore.prototype.create;
 const spy = vi.spyOn(JobStore.prototype, 'create').mockImplementation(async function(input) { entered(); await gate; return original.call(this, input); });
 const creation = c.request('POST', '/v1/jobs', { url, requestedBy: 'codex' }); await insertion;
 try {
   expect(await c.request('POST', '/v1/nowcoder/operations/workflow', { schemaVersion: 1, kind: 'search', key: 'insertion-admission-key', queries: ['Agent'] })).toMatchObject({ status: 409, body: { error: { code: 'WORKFLOW_BUSY' } } });
   expect(await readdir(join(c.configDir, 'nowcoder-workflows')).catch(() => [])).toEqual([]);
 } finally { release(); await creation; spy.mockRestore(); }
});
