import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOWCODER_ARTICLE_CAPABILITY, TRUSTED_EXTENSION_ID } from '@data-collector/shared';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

async function setup(values: Record<string, unknown> = {}, userAgent = 'Mozilla/5.0 Chrome/142.0.0.0') {
  vi.resetModules();
  const stored: Record<string, unknown> = { bridgePort: 17321, bridgeToken: 'x'.repeat(43), ...values };
  let onMessage!: (message: unknown, sender: unknown, respond: (response: unknown) => void) => boolean;
  const sockets: Array<{ url: string; readyState: number }> = [];
  class Socket {
    readyState = 0;
    constructor(readonly url: string) { sockets.push(this); }
    addEventListener() {}
    send() {}
    close() { this.readyState = 3; }
  }
  vi.stubGlobal('chrome', {
    runtime: {
      id: TRUSTED_EXTENSION_ID,
      onMessage: { addListener: (handler: typeof onMessage) => { onMessage = handler; } },
      onInstalled: { addListener() {} }, onStartup: { addListener() {} },
    },
    storage: {
      local: { get: async () => ({ ...stored }), set: async (extra: Record<string, unknown>) => { Object.assign(stored, extra); }, remove: async () => undefined },
      session: { get: async () => ({}), set: async () => undefined },
    },
    tabs: { query: async () => [], remove: async () => undefined },
    alarms: { create: async () => undefined, onAlarm: { addListener() {} } },
  });
  vi.stubGlobal('navigator', { userAgent });
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('fetch', async () => Response.json({ trustedExtensionId: TRUSTED_EXTENSION_ID, bridgeCapabilities: [NOWCODER_ARTICLE_CAPABILITY] }));
  await import('../../packages/extension/src/background/index.js');
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  const send = async (message: unknown) => new Promise<unknown>(resolve => { onMessage(message, {}, resolve); });
  return { stored, sockets, send };
}

describe('background connection role settings', () => {
  it.each([
    ['Mozilla/5.0 Chrome/142.0.0.0', 'chrome'],
    ['Mozilla/5.0 HeadlessChrome/142.0.0.0', 'chrome'],
    ['Mozilla/5.0 Chrome/142.0.0.0 Edg/142.0.0.0', 'edge'],
  ])('reports observed browser and saves a role explicitly for %s', async (agent, browserFamily) => {
    const runtime = await setup({}, agent);
    expect(await runtime.send({ type: 'connection.role.get' })).toMatchObject({ ok: true, value: { role: 'collector', browserFamily } });
    expect(await runtime.send({ type: 'connection.role.set', role: 'articles' })).toMatchObject({ ok: true, value: { role: 'articles', browserFamily } });
    expect(runtime.stored.connectionRole).toBe('articles');
    expect(new URL(runtime.sockets[1]!.url).searchParams.get('channel')).toBe('articles');
  });

  it.each([
    { directedRunActive: true },
    { batch: { phase: 'running', updatedAt: Date.now() } },
    { lastJobStatus: 'collecting', lastJobUpdatedAt: Date.now() },
  ])('refuses role switching while collection/directed work is active: %j', async busy => {
    const runtime = await setup(busy);
    expect(await runtime.send({ type: 'connection.role.set', role: 'articles' })).toMatchObject({ ok: false, error: expect.stringContaining('进行中') });
    expect(runtime.stored.connectionRole).toBeUndefined();
    expect(runtime.sockets).toHaveLength(1);
  });
});
