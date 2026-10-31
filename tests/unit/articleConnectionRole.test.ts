import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOWCODER_ARTICLE_CAPABILITY, TRUSTED_EXTENSION_ID, extensionHelloPayloadSchema, type ArticleResult } from '@data-collector/shared';
import { BridgeConnection, type ExtensionStorage, type SocketLike } from '../../packages/extension/src/background/connection.js';

class Storage implements ExtensionStorage {
  values: Record<string, unknown>;
  constructor(extra: Record<string, unknown> = {}) { this.values = { bridgeToken: 'x'.repeat(43), ...extra }; }
  async get() { return { ...this.values }; }
  async set(values: Record<string, unknown>) { Object.assign(this.values, values); }
  async remove(keys: string | string[]) { for (const key of typeof keys === 'string' ? [keys] : keys) delete this.values[key]; }
}
class Socket implements SocketLike {
  readyState = 0;
  sent: Array<{ type: string; requestId: string; payload: unknown }> = [];
  listeners = new Map<string, Array<(event: { data?: string }) => void>>();
  addEventListener(type: string, handler: (event: { data?: string }) => void) { this.listeners.set(type, [...this.listeners.get(type) ?? [], handler]); }
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; for (const listener of this.listeners.get('open') ?? []) listener({}); }
  receive(type: string, requestId: string, payload: unknown) {
    for (const listener of this.listeners.get('message') ?? []) listener({ data: JSON.stringify({ protocolVersion: 1, type, requestId, timestamp: new Date().toISOString(), payload }) });
  }
}
const active: BridgeConnection[] = [];
afterEach(() => { for (const connection of active.splice(0)) connection.stop(); });
async function setup(role?: string, compatible = true, browserFamily: 'chrome' | 'edge' | null = 'chrome') {
  const storage = new Storage(role ? { connectionRole: role } : {});
  const urls: string[] = [], sockets: Socket[] = [];
  const connection = new BridgeConnection({
    storage, extensionId: TRUSTED_EXTENSION_ID, ...(browserFamily ? { browserFamily } : {}),
    socketFactory: url => { urls.push(url); const socket = new Socket(); sockets.push(socket); return socket; },
    fetch: async () => Response.json({ trustedExtensionId: TRUSTED_EXTENSION_ID, version: '0.4.63', bridgeCapabilities: compatible ? [NOWCODER_ARTICLE_CAPABILITY] : [] }),
    setInterval: () => 1, clearInterval: () => undefined, setTimeout: () => 1, clearTimeout: () => undefined,
  });
  active.push(connection);
  await connection.start();
  sockets[0]?.open();
  if (sockets.length) await vi.waitFor(() => expect(sockets[0]!.sent[0]?.type).toBe('extension.hello'));
  return { connection, storage, urls, sockets };
}
const publish = { kind: 'article-publish', title: '整理题单', body: '整理内容', expectedAccountId: '123', provenance: 'compiled' };
const attention: ArticleResult = { kind: 'attention', code: 'VERIFY', message: '请核验', submission: 'uncertain' };

describe('extension article connection role', () => {
  it('keeps legacy collector URL and strict hello against an old Bridge', async () => {
    const runtime = await setup(undefined, false);
    expect(new URL(runtime.urls[0]!).searchParams.has('channel')).toBe(false);
    const hello = runtime.sockets[0]!.sent[0]!.payload as Record<string, unknown>;
    expect(hello).not.toHaveProperty('browserFamily');
    expect(hello.capabilities).not.toContain(NOWCODER_ARTICLE_CAPABILITY);
  });

  it('persists and reconnects only after an explicit role save', async () => {
    const runtime = await setup();
    await runtime.connection.setConnectionRole('articles');
    expect(runtime.storage.values.connectionRole).toBe('articles');
    expect(runtime.sockets[0]!.readyState).toBe(3);
    expect(new URL(runtime.urls[1]!).searchParams.get('channel')).toBe('articles');
    runtime.sockets[1]!.open();
    await vi.waitFor(() => expect(runtime.sockets[1]!.sent).toHaveLength(1));
    expect(runtime.sockets[1]!.sent[0]!.payload).toMatchObject({ browserFamily: 'chrome', capabilities: [NOWCODER_ARTICLE_CAPABILITY] });
  });

  it('advertises observed browser identity only to a compatible Bridge', async () => {
    const runtime = await setup('articles', true, 'edge');
    const hello = runtime.sockets[0]!.sent[0]!.payload;
    expect(extensionHelloPayloadSchema.safeParse(hello).success).toBe(true);
    expect(hello).toMatchObject({ browserFamily: 'edge', capabilities: [NOWCODER_ARTICLE_CAPABILITY] });
  });

  it.each([false, true])('fails closed for articles when Bridge/browser evidence is missing (compatible=%s)', async compatible => {
    const runtime = await setup('articles', compatible, compatible ? null : 'chrome');
    expect(runtime.urls).toEqual([]);
    expect(runtime.storage.values.bridgeStatus).not.toBe('connected');
  });

  it('does not execute collector work on an article role connection', async () => {
    const runtime = await setup('articles');
    let reads = 0;
    runtime.connection.onCollect(() => { reads++; });
    runtime.connection.onPlanCollect(() => { reads++; });
    runtime.connection.onOperations(async () => { reads++; return attention; });
    const socket = runtime.sockets[0]!;
    socket.receive('job.collect', 'job', { url: 'https://www.nowcoder.com/discuss/123' });
    socket.receive('plan.collect', 'plan', {});
    socket.receive('operations.execute', 'comment', { kind: 'context', url: 'https://www.nowcoder.com/discuss/123', maxPages: 1 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(reads).toBe(0);
    expect(runtime.storage.values).not.toHaveProperty('lastJobId');
  });

  it('does not run an article command on a collector role connection', async () => {
    const runtime = await setup();
    let runs = 0;
    runtime.connection.setArticleHandler(async () => { runs++; return attention; });
    runtime.sockets[0]!.receive('article.execute', 'foreign', publish);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(runs).toBe(0);
  });

  it('caches article attempts by request ID and rejects content changes for that ID', async () => {
    const runtime = await setup('articles');
    let runs = 0, release!: (result: ArticleResult) => void;
    runtime.connection.setArticleHandler(async () => { runs++; return new Promise(resolve => { release = resolve; }); });
    const socket = runtime.sockets[0]!;
    socket.receive('article.execute', 'same-id', publish);
    socket.receive('article.execute', 'same-id', publish);
    await vi.waitFor(() => expect(runs).toBe(1));
    expect(runtime.connection.busy).toBe(true);
    release(attention);
    await vi.waitFor(() => expect(socket.sent.filter(item => item.type === 'article.result')).toHaveLength(2));
    socket.receive('article.execute', 'same-id', publish);
    await vi.waitFor(() => expect(socket.sent.filter(item => item.type === 'article.result')).toHaveLength(3));
    socket.receive('article.execute', 'same-id', { ...publish, title: '另一份内容' });
    await vi.waitFor(() => expect(socket.sent.filter(item => item.type === 'article.result')).toHaveLength(4));
    expect(runs).toBe(1);
    expect(socket.sent.at(-1)!.payload).toMatchObject({ kind: 'attention', code: 'ARTICLE_REQUEST_CONFLICT', submission: 'uncertain' });
    expect(runtime.connection.busy).toBe(false);
  });

  it('turns invalid internal click results into uncertain attention', async () => {
    const runtime = await setup('articles');
    runtime.connection.setArticleHandler(async () => ({ kind: 'article-clicked', diagnostics: {} }) as never);
    runtime.sockets[0]!.receive('article.execute', 'bad-result', publish);
    await vi.waitFor(() => expect(runtime.sockets[0]!.sent.at(-1)!.payload).toMatchObject({ kind: 'attention', submission: 'uncertain' }));
  });

  it('does not send deferred results to a new socket after reconnect', async () => {
    const runtime = await setup('articles');
    let release!: (result: ArticleResult) => void;
    runtime.connection.setArticleHandler(async () => new Promise(resolve => { release = resolve; }));
    runtime.sockets[0]!.receive('article.execute', 'late-result', publish);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    runtime.connection.stop();
    await runtime.connection.start();
    runtime.sockets[1]!.open();
    await vi.waitFor(() => expect(runtime.sockets[1]!.sent).toHaveLength(1));
    release(attention);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(runtime.sockets.flatMap(item => item.sent).filter(item => item.type === 'article.result')).toEqual([]);
  });

  it('refuses a role switch during a pending article and retains the original request result across idle switches', async () => {
    const runtime = await setup('articles');
    let release!: (value: ArticleResult) => void, runs = 0;
    runtime.connection.setArticleHandler(async () => { runs++; return new Promise(resolve => { release = resolve; }); });
    runtime.sockets[0]!.receive('article.execute', 'retained-result', publish);
    await vi.waitFor(() => expect(runtime.connection.busy).toBe(true));
    await expect(runtime.connection.setConnectionRole('collector')).rejects.toThrow('进行中');
    expect(runtime.storage.values.connectionRole).toBe('articles');
    release(attention);
    await vi.waitFor(() => expect(runtime.connection.busy).toBe(false));
    await runtime.connection.setConnectionRole('collector');
    await runtime.connection.setConnectionRole('articles');
    runtime.sockets[2]!.open();
    await vi.waitFor(() => expect(runtime.sockets[2]!.sent).toHaveLength(1));
    runtime.sockets[2]!.receive('article.execute', 'retained-result', publish);
    await vi.waitFor(() => expect(runtime.sockets[2]!.sent.at(-1)?.payload).toEqual(attention));
    expect(runs).toBe(1);
  });

  it('does not reconnect the old collector role while a role save is pending', async () => {
    const runtime = await setup();
    let release!: () => void, writing = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const save = runtime.storage.set.bind(runtime.storage);
    runtime.storage.set = async values => {
      if (values.connectionRole) { writing = true; await gate; }
      await save(values);
    };
    const changing = runtime.connection.setConnectionRole('articles');
    await vi.waitFor(() => expect(writing).toBe(true));
    await runtime.connection.start();
    expect(runtime.urls).toHaveLength(1);
    expect(runtime.connection.busy).toBe(true);
    release();
    await changing;
    expect(runtime.urls).toHaveLength(2);
    expect(new URL(runtime.urls[1]!).searchParams.get('channel')).toBe('articles');
  });

  it('restores the previous connection when role persistence fails', async () => {
    const runtime = await setup();
    const save = runtime.storage.set.bind(runtime.storage);
    runtime.storage.set = async values => {
      if (values.connectionRole) throw new Error('设置保存失败');
      await save(values);
    };
    await expect(runtime.connection.setConnectionRole('articles')).rejects.toThrow('设置保存失败');
    expect(runtime.storage.values.connectionRole).toBeUndefined();
    expect(runtime.urls).toHaveLength(2);
    expect(new URL(runtime.urls[1]!).searchParams.has('channel')).toBe(false);
    expect(runtime.connection.busy).toBe(false);
  });
});
