import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { APP_VERSION, NOWCODER_ARTICLE_CAPABILITY, NOWCODER_BROWSER_OPERATIONS_CAPABILITY, TRUSTED_EXTENSION_ID } from '@data-collector/shared';
import { startBridge, type BridgeHandle } from '../../packages/bridge/src/server/index.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';
const dirs = createTemporaryDirectoryTracker(), bridges: BridgeHandle[] = [], sockets: WebSocket[] = [];
const token = 'article-integration-test-token-0000000000000';
const draft = { schemaVersion: 1, title: '字节 Agent 全栈一面｜备考整理', body: '整理自不同公开记录，非本人面试经历\nAgent项目与SSE\nagent-journey.cn', browser: 'chrome', accountId: '544222414', provenance: 'compiled', sourceUrls: ['https://example.com/questions'] };
const identity = (id = draft.accountId) => ({ userId: id, nickname: '测试创作者', profileUrl: `https://www.nowcoder.com/users/${id}`, observedAt: new Date().toISOString() });
afterEach(async () => { sockets.splice(0).forEach(s => s.terminate()); await Promise.all(bridges.splice(0).map(b => b.close())); await dirs.cleanup(); });
async function setup(mode: 'normal' | 'challenge' | 'wrong-account' = 'normal', fetcher?: typeof fetch) {
  const root = await dirs.create('articles-api-'), configDir = join(root, 'config'); await mkdir(configDir);
  await writeFile(join(configDir, 'auth.json'), JSON.stringify({ version: 1, token }));
  const bridge = await startBridge({ port: 0, configDir, libraryRoot: join(root, 'library'), fetch: fetcher ?? (async () => { throw new Error('no public network'); }) }); bridges.push(bridge);
  const request = async (method: string, path: string, body?: unknown, authorized = true) => {
    const r = await fetch(`${bridge.url}${path}`, { method, headers: { ...(authorized ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() };
  };
  const envelope = (type: string, requestId: string, payload: unknown) => JSON.stringify({ protocolVersion: 1, type, requestId, timestamp: new Date().toISOString(), payload });
  const primary = new WebSocket(`${bridge.wsUrl}?token=${token}`, { origin: `chrome-extension://${TRUSTED_EXTENSION_ID}` }); sockets.push(primary); await once(primary, 'open');
  primary.send(envelope('extension.hello', 'primary-hello', { version: APP_VERSION, runtimeId: '12345678-1234-4234-8234-123456789011', browserFamily: 'edge', capabilities: [NOWCODER_BROWSER_OPERATIONS_CAPABILITY] }));
  await vi.waitFor(async () => expect((await request('GET', '/health')).body.extensionConnected).toBe(true));
  const secondary = new WebSocket(`${bridge.wsUrl}?token=${token}&channel=articles`, { origin: `chrome-extension://${TRUSTED_EXTENSION_ID}` }); sockets.push(secondary); await once(secondary, 'open');
  const primaryActions: string[] = [], secondaryActions: string[] = [];
  primary.on('message', raw => { const msg = JSON.parse(raw.toString()); if (msg.type.endsWith('.execute')) primaryActions.push(msg.type); });
  secondary.on('message', raw => {
    const msg = JSON.parse(raw.toString()); if (msg.type !== 'article.execute') return;
    secondaryActions.push(msg.payload.kind);
    const receipt = { url: 'https://www.nowcoder.com/discuss/995001', title: draft.title, body: draft.body, accountId: draft.accountId, observedAt: new Date().toISOString() };
    const result = msg.payload.kind === 'account' ? { kind: 'account', identity: identity(mode === 'wrong-account' ? '12345' : undefined) }
      : msg.payload.kind === 'article-verify' ? { kind: 'article-verified', identity: identity(), receipt }
      : mode === 'challenge' ? { kind: 'attention', code: 'VERIFICATION_REQUIRED', message: '牛客要求验证', submission: 'uncertain' } : { kind: 'article-published', receipt };
    secondary.send(envelope('article.result', msg.requestId, result));
  });
  secondary.send(envelope('extension.hello', 'article-hello', { version: APP_VERSION, runtimeId: '12345678-1234-4234-8234-123456789012', browserFamily: 'chrome', capabilities: [NOWCODER_ARTICLE_CAPABILITY] }));
  await new Promise(resolve => setTimeout(resolve, 20));
  return { root, bridge, configDir, request, primary, secondary, primaryActions, secondaryActions };
}
it('authenticates article routes and keeps Chrome article connection separate from Edge collector', async () => {
  const c = await setup(), base = '/v1/nowcoder/articles';
  expect((await c.request('GET', base, undefined, false)).status).toBe(401);
  const runtime = await c.request('GET', `${base}/runtime`); expect(runtime).toMatchObject({ status: 200, body: { connected: true, browserFamily: 'chrome' } });
  expect(c.primary.readyState).toBe(WebSocket.OPEN);
  expect((await c.request('GET', '/health')).body).toMatchObject({ extensionConnected: true, primaryBrowser: 'edge', articleRuntime: { connected: true, browserFamily: 'chrome' } });
  expect((await c.request('POST', `${base}/account`, { browser: 'chrome', accountId: draft.accountId })).body).toMatchObject({ kind: 'account', identity: { userId: draft.accountId } });
  expect(c.primaryActions).toEqual([]); expect(c.secondaryActions).toEqual(['account']);
});
it('does not let a vacancy claim displace an occupied collector, including a new connection before hello', async () => {
  const c = await setup();
  const candidate = new WebSocket(`${c.bridge.wsUrl}?token=${token}&claim=vacant`, { origin: `chrome-extension://${TRUSTED_EXTENSION_ID}` }); sockets.push(candidate);
  const rejected = once(candidate, 'close'); await once(candidate, 'open');
  expect((await rejected)[0]).toBe(4009);
  expect(c.primary.readyState).toBe(WebSocket.OPEN);
  expect(c.secondary.readyState).toBe(WebSocket.OPEN);
  c.primary.close(); await once(c.primary, 'close');
  await vi.waitFor(async () => expect((await c.request('GET', '/health')).body.collectorChannelOccupied).toBe(false));
  const winner = new WebSocket(`${c.bridge.wsUrl}?token=${token}&claim=vacant`, { origin: `chrome-extension://${TRUSTED_EXTENSION_ID}` }); sockets.push(winner); await once(winner, 'open');
  expect((await c.request('GET', '/health')).body).toMatchObject({ collectorChannelOccupied: true, extensionConnected: false });
  const loser = new WebSocket(`${c.bridge.wsUrl}?token=${token}&claim=vacant`, { origin: `chrome-extension://${TRUSTED_EXTENSION_ID}` }); sockets.push(loser);
  const lost = once(loser, 'close'); await once(loser, 'open'); expect((await lost)[0]).toBe(4009);
  expect(winner.readyState).toBe(WebSocket.OPEN); expect(c.secondary.readyState).toBe(WebSocket.OPEN);
});
it('imports, previews and publishes once with correct-account receipt, retaining readonly replay', async () => {
  const c = await setup(), base = '/v1/nowcoder/articles';
  const created = await c.request('POST', base, draft); expect(created.status).toBe(200); const id = created.body.entry.id;
  const preview = await c.request('POST', `${base}/${id}/preview`, {}); expect(preview.status).toBe(200);
  const input = { revision: preview.body.entry.revision, contentHash: preview.body.entry.contentHash, browser: 'chrome', accountId: draft.accountId, key: 'authorized-article-api-key', send: true };
  expect((await c.request('POST', `${base}/${id}/publish`, { ...input, send: false })).status).toBe(400);
  const result = await c.request('POST', `${base}/${id}/publish`, input);
  expect(result).toMatchObject({ status: 200, body: { publication: { state: 'published', postUrl: 'https://www.nowcoder.com/discuss/995001', evidence: 'observed' } } });
  const sent = [...c.secondaryActions];
  expect((await c.request('POST', `${base}/${id}/publish`, input)).body.publication.state).toBe('published');
  expect((await c.request('POST', `${base}/${id}/verify`, { key: input.key })).body.publication.state).toBe('published');
  expect(c.secondaryActions).toEqual(sent); expect(c.primaryActions).toEqual([]);
  expect((await c.request('GET', `${base}/limits`)).body).toMatchObject({ policy: { maxPer24Hours: null }, usage: { last24Hours: 1 } });
  expect((await c.request('GET', '/v1/nowcoder/operations/publishing')).body.usage.last24Hours).toBe(0);
});
it('wrong live account refuses preview without recording a send', async () => {
  const c = await setup('wrong-account'), base = '/v1/nowcoder/articles';
  const id = (await c.request('POST', base, draft)).body.entry.id;
  expect((await c.request('POST', `${base}/${id}/preview`, {})).status).toBe(409);
  expect(JSON.parse(await readFile(join(c.configDir, 'nowcoder-articles', `${id}.json`), 'utf8')).publicationAttempts).toEqual([]);
});
it('article challenge pauses both channels and common explicit resume only reconciles the original article', async () => {
  const c = await setup('challenge'), base = '/v1/nowcoder/articles', common = '/v1/nowcoder/operations/publishing';
  const id = (await c.request('POST', base, draft)).body.entry.id, p = (await c.request('POST', `${base}/${id}/preview`, {})).body.entry;
  const input = { revision: p.revision, contentHash: p.contentHash, browser: 'chrome', accountId: draft.accountId, key: 'article-challenge-api-key', send: true };
  expect((await c.request('POST', `${base}/${id}/publish`, input)).body.publication.state).toBe('uncertain');
  const status = (await c.request('GET', common)).body; expect(status.verification).toMatchObject({ channel: 'article', articleId: id });
  expect((await c.request('POST', '/v1/nowcoder/operations/search', { query: 'Agent' })).status).toBe(409);
  const resumed = await c.request('POST', `${common}/resume`, { id: status.verification.id, verificationCompleted: true });
  expect(resumed).toMatchObject({ status: 200, body: { status: { verification: null }, publication: { state: 'published' } } });
  expect(c.secondaryActions.filter(x => x === 'article-publish')).toHaveLength(1);
});
it('allows Chrome account preview while an independent Edge comment workflow is busy', async () => {
  let release!: () => void, requested = false;
  const fetcher: typeof fetch = async () => { requested = true; await new Promise<void>(r => { release = r; }); return Response.json({ success: true, code: 0, data: { records: [], totalPage: 1 } }); };
  const c = await setup('normal', fetcher), base = '/v1/nowcoder/articles';
  const id = (await c.request('POST', base, draft)).body.entry.id;
  try {
    expect((await c.request('POST', '/v1/nowcoder/operations/workflow', { schemaVersion: 1, kind: 'search', key: 'parallel-comment-search', queries: ['Agent'] })).status).toBe(202);
    await vi.waitFor(() => expect(requested).toBe(true));
    expect((await c.request('POST', `${base}/${id}/preview`, {})).status).toBe(200);
  } finally { release?.(); }
});
