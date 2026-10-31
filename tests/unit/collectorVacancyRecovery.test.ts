import { afterEach, expect, it, vi } from 'vitest';
import { NOWCODER_ARTICLE_CAPABILITY, TRUSTED_EXTENSION_ID } from '@data-collector/shared';
import { BridgeConnection, type SocketLike } from '../../packages/extension/src/background/connection.js';
const recoveryCapability = 'collector-channel-claim-v1';
const active: BridgeConnection[] = [];
afterEach(() => active.splice(0).forEach(c => c.stop()));
async function setup(healthPatch: Record<string, unknown> = {}, role = 'collector', browser: 'chrome' | 'edge' = 'edge') {
  const values: Record<string, unknown> = { bridgeToken: 'x'.repeat(43), connectionRole: role, bridgeStatus: 'replaced' };
  const health: Record<string, unknown> = { trustedExtensionId: TRUSTED_EXTENSION_ID, version: '0.4.64',
    bridgeCapabilities: [NOWCODER_ARTICLE_CAPABILITY, recoveryCapability], collectorChannelOccupied: false,
    articleRuntime: { connected: true, browserFamily: 'chrome' }, buildId: 'v0.4.64 · 1234567', ...healthPatch };
  const urls: string[] = [], sockets: Array<{ fail(): void }> = [];
  const fetcher = vi.fn(async () => Response.json(health));
  const make = () => { const c = new BridgeConnection({ extensionId: TRUSTED_EXTENSION_ID, browserFamily: browser,
    storage: { get: async () => ({ ...values }), set: async patch => { Object.assign(values, patch); }, remove: async keys => { for (const key of typeof keys === 'string' ? [keys] : keys) delete values[key]; } },
    fetch: fetcher, socketFactory: url => {
      urls.push(url); const listeners = new Map<string, Array<(event: { data?: string }) => void>>();
      const socket = { readyState: 0, send() {}, close() { this.readyState = 3; },
        addEventListener(type: string, handler: (event: { data?: string }) => void) { listeners.set(type, [...listeners.get(type) ?? [], handler]); },
        fail() { this.readyState = 3; for (const handler of listeners.get('error') ?? []) handler({}); } };
      sockets.push(socket); return socket as SocketLike;
    },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
  }); active.push(c); return c; }; const c = make(); await c.start(); return { c, health, values, urls, fetcher, make, sockets };
}
it('automatically reclaims only the vacant collector channel after Chrome moves to articles', async () => {
  const r = await setup(); expect(r.urls).toHaveLength(1);
  expect(new URL(r.urls[0]!).searchParams.get('claim')).toBe('vacant');
  expect(new URL(r.urls[0]!).searchParams.has('channel')).toBe(false);
  expect(r.values.connectionRole).toBe('collector');
});
it.each([
  { collectorChannelOccupied: true }, { collectorChannelOccupied: undefined },
  { bridgeCapabilities: [NOWCODER_ARTICLE_CAPABILITY] }, { trustedExtensionId: 'untrusted' },
  { articleRuntime: { connected: false, browserFamily: 'chrome' } },
  { articleRuntime: { connected: true, browserFamily: 'edge' } },
])('does not displace another collector or infer readiness from incomplete evidence: %j', async patch => {
  const r = await setup(patch); expect(r.urls).toEqual([]); expect(r.values.bridgeStatus).toBe('replaced');
});
it('keeps learning new builds while displaced, then recovers on a later free-channel check', async () => {
  const r = await setup({ collectorChannelOccupied: true });
  expect(r.fetcher).toHaveBeenCalledTimes(1); expect(r.values.buildId).toBe('v0.4.64 · 1234567');
  r.health.collectorChannelOccupied = false; await r.c.start();
  expect(r.urls).toHaveLength(1); expect(new URL(r.urls[0]!).searchParams.get('claim')).toBe('vacant');
});
it('retains vacancy-only recovery across a worker restart before the handshake completes', async () => {
  const r = await setup(); expect(r.urls).toHaveLength(1); r.c.stop();
  r.health.collectorChannelOccupied = true;
  const restarted = r.make(); await restarted.start();
  expect(r.urls).toHaveLength(1);
  expect(r.values.collectorClaimOnly).toBe(true);
  expect(r.values.bridgeStatus).toBe('replaced');
});
it('continues safe discovery and bootstrap after a failed claim invalidates its token', async () => {
  const r = await setup(); r.sockets[0]!.fail();
  await vi.waitFor(() => expect(r.values.bridgeToken).toBeUndefined());
  r.fetcher.mockClear(); r.health.collectorChannelOccupied = true; r.health.buildId = 'v0.4.64 · 7654321';
  await r.c.start(); expect(r.fetcher).toHaveBeenCalled(); expect(r.values.buildId).toBe('v0.4.64 · 7654321');
  expect(r.urls).toHaveLength(1);
  r.health.collectorChannelOccupied = false; await r.c.start();
  expect(r.urls).toHaveLength(2); const url = new URL(r.urls[1]!);
  expect(url.searchParams.get('bootstrap')).toBe('1'); expect(url.searchParams.get('claim')).toBe('vacant');
  expect(url.pathname).toBe('/v1/extension/claim-collector');
});
it('keeps accepted recovery vacancy-only when the other browser later disconnects', async () => {
  const r = await setup(); r.c.stop(); r.health.articleRuntime = { connected: false };
  const restarted = r.make(); await restarted.start();
  expect(r.urls).toHaveLength(2); expect(new URL(r.urls[1]!).searchParams.get('claim')).toBe('vacant');
});
it('allows an explicit manual retry to leave protected recovery mode', async () => {
  const r = await setup(); r.c.stop(); r.health.collectorChannelOccupied = true;
  await r.c.retry(); expect(r.urls).toHaveLength(2);
  expect(new URL(r.urls[1]!).searchParams.has('claim')).toBe(false);
  expect(new URL(r.urls[1]!).pathname).toBe('/v1/extension');
  expect(r.values.collectorClaimOnly).toBeUndefined();
});
it('leaves article takeover semantics unchanged and preserves explicit manual retry', async () => {
  const r = await setup({}, 'articles', 'chrome'); expect(r.urls).toEqual([]);
  await r.c.retry(); expect(r.urls).toHaveLength(1);
  expect(new URL(r.urls[0]!).searchParams.get('channel')).toBe('articles');
  expect(new URL(r.urls[0]!).searchParams.has('claim')).toBe(false);
});
