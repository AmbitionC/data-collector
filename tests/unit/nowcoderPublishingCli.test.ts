import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runOperationsCli } from '../../packages/bridge/src/operations/cli.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';
const dirs = createTemporaryDirectoryTracker();
afterEach(async () => { vi.unstubAllGlobals(); await dirs.cleanup(); });
const credentials = { baseUrl: 'http://127.0.0.1:17321', token: 'local-test-token' };
const output = { stdout(_value: string) {}, stderr(_value: string) {} };
it('reads global publishing limits through the authenticated local API', async () => {
  const fetcher = vi.fn(async () => Response.json({ schemaVersion: 1, verification: null })); vi.stubGlobal('fetch', fetcher);
  await runOperationsCli(['nowcoder', 'ops', 'limits'], credentials, output);
  expect(fetcher.mock.calls[0]?.[0]).toBe('http://127.0.0.1:17321/v1/nowcoder/operations/publishing');
  expect(fetcher.mock.calls[0]?.[1]?.method).toBe('GET');
});
it('requires explicit completion confirmation before any resume request and cannot accept send', async () => {
  const fetcher = vi.fn(async () => Response.json({})); vi.stubGlobal('fetch', fetcher);
  const args = ['nowcoder', 'ops', 'resume', '--id', '12345678-1234-4234-8234-123456789012'];
  await expect(runOperationsCli(args, credentials, output)).rejects.toThrow(/完成|verification/u);
  expect(fetcher).not.toHaveBeenCalled();
  await expect(runOperationsCli([...args, '--verification-completed', '--send'], credentials, output)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  await runOperationsCli([...args, '--verification-completed'], credentials, output);
  expect(fetcher.mock.calls[0]?.[0]).toBe('http://127.0.0.1:17321/v1/nowcoder/operations/publishing/resume');
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ id: '12345678-1234-4234-8234-123456789012', verificationCompleted: true });
});
it('validates full policy files locally before configuration; limits cannot be zeroed', async () => {
  const path = join(await dirs.create('publishing-cli-'), 'policy.json');
  const fetcher = vi.fn(async () => Response.json({})); vi.stubGlobal('fetch', fetcher);
  await writeFile(path, JSON.stringify({ minIntervalMs: 0, maxPerHour: 5, maxPer24Hours: 20 }));
  await expect(runOperationsCli(['nowcoder', 'ops', 'configure', '--file', path], credentials, output)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  await writeFile(path, JSON.stringify({ minIntervalMs: 120000, maxPerHour: 5, maxPer24Hours: 20 }));
  await runOperationsCli(['nowcoder', 'ops', 'configure', '--file', path], credentials, output);
  expect(fetcher.mock.calls[0]?.[1]?.method).toBe('PUT');
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ minIntervalMs: 120000, maxPerHour: 5, maxPer24Hours: 20 });
});
