import { afterEach, expect, it, vi } from 'vitest';
import { runOperationsCli } from '../../packages/bridge/src/operations/cli.js';
import { runCli } from '../../packages/bridge/src/cli.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const directories = createTemporaryDirectoryTracker();
afterEach(async () => { vi.unstubAllGlobals(); await directories.cleanup(); });
const credentials = { baseUrl: 'http://127.0.0.1:17321', token: 'local-test-token' };
function output() {
  let text = '';
  return { io: { stdout: (value: string) => { text += value; }, stderr: (_value: string) => {} }, result: () => JSON.parse(text) };
}

it('reads authenticated recovery advice with the requested backoff attempt', async () => {
  const fetcher = vi.fn(async () => Response.json({ schemaVersion: 1, status: 'ready', code: 'READY', message: '可以准备新工作', nextCheckAt: null,
    canPrepareNewWork: true, requiresUser: false, canPublishDirectly: false, canCompleteVerification: false, replaysFailedRuns: false,
    limits: { schemaVersion: 1, policy: { minIntervalMs: 120000, maxPerHour: 5, maxPer24Hours: 20 }, usage: { lastHour: 0, last24Hours: 16 }, nextAllowedAt: null, verification: null } }));
  vi.stubGlobal('fetch', fetcher); const out = output();
  await expect(runOperationsCli(['nowcoder', 'ops', 'recovery', '--attempt', '2'], credentials, out.io)).resolves.toBe(0);
  expect(out.result()).toMatchObject({ status: 'ready', code: 'READY' });
  expect(fetcher.mock.calls[0]?.[0]).toBe('http://127.0.0.1:17321/v1/nowcoder/operations/recovery?attempt=2');
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', headers: { authorization: 'Bearer local-test-token' } });
});

it('returns structured waiting advice when the local Bridge is offline instead of killing the campaign', async () => {
  vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed'); }); const out = output();
  await expect(runOperationsCli(['nowcoder', 'ops', 'recovery'], credentials, out.io)).resolves.toBe(0);
  expect(out.result()).toMatchObject({ status: 'waiting', code: 'BRIDGE_UNAVAILABLE', canPrepareNewWork: false, requiresUser: false });
  expect(Date.parse(out.result().nextCheckAt)).toBeGreaterThan(Date.now());
});

it('preserves authentication failures as a human handoff rather than claiming the Bridge is ready', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ error: { code: 'UNAUTHORIZED', message: '本机连接认证失效' } }, { status: 401 }));
  const out = output();
  await expect(runOperationsCli(['nowcoder', 'ops', 'recovery'], credentials, out.io)).resolves.toBe(0);
  expect(out.result()).toMatchObject({ status: 'needs_user', code: 'UNAUTHORIZED', canPrepareNewWork: false, requiresUser: true });
});

it('retains a publishing-history failure as a human handoff even when returned as an HTTP error', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ error: { code: 'PUBLISH_HISTORY_UNAVAILABLE', message: '发布历史记录不可用' } }, { status: 409 }));
  const out = output();
  await expect(runOperationsCli(['nowcoder', 'ops', 'recovery'], credentials, out.io)).resolves.toBe(0);
  expect(out.result()).toMatchObject({ status: 'needs_user', code: 'PUBLISH_HISTORY_UNAVAILABLE', canPrepareNewWork: false, requiresUser: true });
});

it('does not accept a ready response that also reports an exhausted publishing budget', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ schemaVersion: 1, status: 'ready', code: 'READY', message: '可以准备新工作', nextCheckAt: null,
    canPrepareNewWork: true, requiresUser: false, canPublishDirectly: false, canCompleteVerification: false, replaysFailedRuns: false,
    limits: { schemaVersion: 1, policy: { minIntervalMs: 120000, maxPerHour: 5, maxPer24Hours: 20 }, usage: { lastHour: 5, last24Hours: 20 }, nextAllowedAt: null, verification: null } }));
  const out = output();
  await expect(runOperationsCli(['nowcoder', 'ops', 'recovery'], credentials, out.io)).resolves.toBe(0);
  expect(out.result()).toMatchObject({ status: 'waiting', code: 'RECOVERY_RESPONSE_INVALID', canPrepareNewWork: false });
});

it.each(['missing', 'corrupt'])('returns structured advice from the real CLI when local credentials are %s', async kind => {
  const config = await directories.create('recovery-local-auth-'), authPath = join(config, 'auth.json');
  if (kind === 'corrupt') await writeFile(authPath, '{broken');
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); const out = output();
  await expect(runCli(['nowcoder', 'ops', 'recovery', '--config', config], out.io)).resolves.toBe(0);
  expect(out.result()).toMatchObject({ status: 'needs_user', code: 'LOCAL_AUTH_UNAVAILABLE', requiresUser: true, canPrepareNewWork: false });
  expect(fetcher).not.toHaveBeenCalled();
  if (kind === 'corrupt') expect(await readFile(authPath, 'utf8')).toBe('{broken');
  else await expect(readFile(authPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([
  { nextAllowedAt: '2099-01-01T00:00:00.000Z', verification: null },
  { nextAllowedAt: null, verification: { id: '12345678-1234-4234-8234-123456789012', detectedAt: '2026-11-03T04:00:00.000Z', sourceUrl: 'https://www.nowcoder.com/discuss/123456', requestId: '12345678-1234-4234-8234-123456789013', opportunityId: 'ops-abcdef123456', key: 'original-comment-key' } },
])('rejects a ready response with a contradictory pending protection (%s)', async protection => {
  vi.stubGlobal('fetch', async () => Response.json({ schemaVersion: 1, status: 'ready', code: 'READY', message: '可以准备新工作', nextCheckAt: null,
    canPrepareNewWork: true, requiresUser: false, canPublishDirectly: false, canCompleteVerification: false, replaysFailedRuns: false,
    verification: protection.verification, limits: { schemaVersion: 1, policy: { minIntervalMs: 120000, maxPerHour: 5, maxPer24Hours: 20 },
      usage: { lastHour: 0, last24Hours: 16 }, nextAllowedAt: protection.nextAllowedAt, verification: null } }));
  const out = output(); await expect(runOperationsCli(['nowcoder', 'ops', 'recovery'], credentials, out.io)).resolves.toBe(0);
  expect(out.result()).toMatchObject({ status: 'waiting', code: 'RECOVERY_RESPONSE_INVALID', canPrepareNewWork: false });
});

it.each([
  ['--send'], ['--verification-completed'], ['--attempt', '-1'], ['--attempt', '101'], ['--attempt', 'NaN'],
  ['--file', '/tmp/not-a-recovery-input.json'],
])('rejects unsafe or invalid recovery flags before making any request (%s)', async (...flags) => {
  const fetcher = vi.fn(async () => Response.json({})); vi.stubGlobal('fetch', fetcher);
  await expect(runOperationsCli(['nowcoder', 'ops', 'recovery', ...flags], credentials, output().io)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
