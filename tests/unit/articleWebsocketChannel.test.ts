import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { TRUSTED_EXTENSION_ID } from '@data-collector/shared';
import { AccessTokenManager } from '../../packages/bridge/src/auth.js';
import { attachExtensionWebSocket } from '../../packages/bridge/src/server/websocket.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dc-article-channel-'));
  const access = await AccessTokenManager.open(join(root, 'auth.json'));
  const token = await access.ensureToken();
  const server = createServer();
  const connections: Array<{ socket: WebSocket; authorization: { channel: string; bootstrapToken?: string } }> = [];
  const websocket = attachExtensionWebSocket({ server, access, onConnection(socket, authorization) { connections.push({ socket, authorization }); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  cleanup.push(async () => {
    for (const client of websocket.clients) client.terminate();
    await new Promise<void>(resolve => websocket.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  return { token, connections, connect: async (query: string, origin = `chrome-extension://${TRUSTED_EXTENSION_ID}`, path = '/v1/extension') => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}?${query}`, { origin });
    return await new Promise<{ socket?: WebSocket; status?: number }>((resolve, reject) => {
      socket.once('open', () => resolve({ socket }));
      socket.once('unexpected-response', (_request, response) => { response.resume(); resolve({ status: response.statusCode }); });
      socket.once('error', reject);
    });
  } };
}

describe('authenticated article WebSocket channel metadata', () => {
  it('marks an authenticated collector vacancy claim without changing its role', async () => {
    const r = await setup(); await r.connect(`token=${r.token}`, undefined, '/v1/extension/claim-collector');
    expect(r.connections[0]!.authorization).toEqual({ channel: 'collector', claimVacant: true });
  });
  it('does not allow the collector-claim path to target the article role', async () => {
    const r = await setup(); expect((await r.connect(`token=${r.token}&channel=articles`, undefined, '/v1/extension/claim-collector')).status).toBe(400);
  });
  it.each(['claim=other', 'claim=vacant&claim=vacant', 'channel=articles&claim=vacant'])('rejects an invalid or wrong-channel vacancy claim: %s', async query => {
    const r = await setup(); expect((await r.connect(`token=${r.token}&${query}`)).status).toBe(400);
  });
  it('defaults legacy clients to collector while keeping an article socket separate', async () => {
    const runtime = await setup();
    const primary = await runtime.connect(`token=${runtime.token}`);
    const article = await runtime.connect(`token=${runtime.token}&channel=articles`);
    expect(runtime.connections.map(item => item.authorization.channel)).toEqual(['collector', 'articles']);
    expect(primary.socket?.readyState).toBe(WebSocket.OPEN);
    expect(article.socket?.readyState).toBe(WebSocket.OPEN);
  });

  it('carries the article channel through trusted bootstrap authorization', async () => {
    const runtime = await setup();
    await runtime.connect('bootstrap=1&channel=articles');
    expect(runtime.connections[0]!.authorization).toEqual({ channel: 'articles', bootstrapToken: runtime.token });
  });

  it.each(['other', '', 'collector&channel=articles'])('rejects an invalid or ambiguous channel %s', async channel => {
    const runtime = await setup();
    const result = await runtime.connect(`token=${runtime.token}&channel=${channel}`);
    expect(result.status).toBe(400);
    expect(runtime.connections).toHaveLength(0);
  });

  it.each([
    { token: 'wrong', origin: `chrome-extension://${TRUSTED_EXTENSION_ID}` },
    { token: 'valid', origin: 'https://www.nowcoder.com' },
  ])('keeps token and origin checks for article channel', async input => {
    const runtime = await setup();
    const result = await runtime.connect(`token=${input.token === 'valid' ? runtime.token : input.token}&channel=articles`, input.origin);
    expect(result.status).toBe(401);
    expect(runtime.connections).toHaveLength(0);
  });
});
