import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBridge, type BridgeHandle } from '../../packages/bridge/src/server/index.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const temporaryDirectories = createTemporaryDirectoryTracker();
const bridges: BridgeHandle[] = [];
const token = 'test-schedule-token-00000000000000000000';
afterEach(async () => {
  await Promise.all(bridges.splice(0).map(bridge => bridge.close()));
  await temporaryDirectories.cleanup();
});

async function fixture() {
  const root = await temporaryDirectories.create('nowcoder-schedule-http-');
  const configDir = join(root, 'config'), libraryRoot = join(root, 'library');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'auth.json'), JSON.stringify({ version: 1, token }));
  const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('No network is allowed in this fixture'); });
  const open = async () => {
    const bridge = await startBridge({ port: 0, configDir, libraryRoot, fetch: fetcher });
    bridges.push(bridge);
    return bridge;
  };
  return { root, configDir, open, fetcher };
}

async function request(bridge: BridgeHandle, method: string, path: string, body?: unknown, authorized = true) {
  const response = await fetch(`${bridge.url}${path}`, { method, headers: {
    ...(authorized ? { authorization: `Bearer ${token}` } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}

describe('private Nowcoder schedule HTTP settings', () => {
  it('requires authentication, defaults disabled, and persists settings without starting collection', async () => {
    const context = await fixture(), bridge = await context.open();
    const path = '/v1/plans/nowcoder-schedule';
    expect((await request(bridge, 'GET', path, undefined, false)).status).toBe(401);
    expect((await request(bridge, 'GET', path)).body).toMatchObject({ enabled: false, reviewOnly: true });
    const configuration = { enabled: true, companies: ['ant'], reviewOnly: true };
    expect(await request(bridge, 'PUT', path, configuration)).toEqual({ status: 200, body: configuration });
    expect((await request(bridge, 'GET', '/v1/plans/batches')).body).toEqual({ batches: [] });
    await bridge.close();
    const reopened = await context.open();
    expect((await request(reopened, 'GET', path)).body).toEqual(configuration);
    expect(context.fetcher).not.toHaveBeenCalled();
  });

  it('rejects delivery mode, duplicate companies and extra fields without altering disabled defaults', async () => {
    const context = await fixture(), bridge = await context.open(), path = '/v1/plans/nowcoder-schedule';
    for (const value of [
      { enabled: true, companies: ['ant'], reviewOnly: false },
      { enabled: true, companies: ['ant', 'ant'], reviewOnly: true },
      { enabled: true, companies: ['ant'], reviewOnly: true, push: true },
    ]) expect((await request(bridge, 'PUT', path, value)).status).toBe(400);
    expect((await request(bridge, 'GET', path)).body.enabled).toBe(false);
    expect(context.fetcher).not.toHaveBeenCalled();
  });

  it('quarantines corrupt schedule state rather than falling back to automatic delivery', async () => {
    const context = await fixture();
    await writeFile(join(context.configDir, 'nowcoder-schedule.json'), '{invalid');
    const bridge = await context.open();
    expect((await request(bridge, 'GET', '/v1/plans/nowcoder-schedule')).status).toBe(409);
    expect((await request(bridge, 'POST', '/v1/plans/run', { planId: 'nowcoder-agent-market', nowcoderReviewOnly: true })).status).toBe(409);
    expect(context.fetcher).not.toHaveBeenCalled();
  });
});
