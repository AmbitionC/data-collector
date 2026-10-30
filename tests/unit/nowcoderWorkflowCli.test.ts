import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runOperationsCli } from '../../packages/bridge/src/operations/cli.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';
const dirs = createTemporaryDirectoryTracker();
afterEach(async () => { vi.unstubAllGlobals(); vi.useRealTimers(); await dirs.cleanup(); });
const credentials = { baseUrl: 'http://127.0.0.1:13111', token: 'test' };
it('refuses publish without send before HTTP, then waits internally and prints one terminal JSON', async () => {
 const root = await dirs.create('workflow-cli-'), path = join(root, 'request.private.json');
 await writeFile(path, JSON.stringify({ schemaVersion: 1, kind: 'publish', key: 'publish-key-0001', items: [] }));
 const requests: string[] = []; let reads = 0, output = '';
 vi.stubGlobal('fetch', async (url: string) => { requests.push(url); return Response.json({ runId: 'workflow-example-1', status: reads++ < 2 ? 'running' : 'completed' }); });
 const io = { stdout: (s: string) => { output += s; }, stderr() {} };
 await expect(runOperationsCli(['nowcoder', 'ops', 'workflow', '--file', path], credentials, io)).rejects.toThrow(/send/u);
 expect(requests).toEqual([]);
 await writeFile(path, JSON.stringify({ schemaVersion: 1, kind: 'search', key: 'search-key-00001', queries: ['Agent'] }));
 vi.useFakeTimers();
 const result = runOperationsCli(['nowcoder', 'ops', 'workflow', '--file', path, '--wait', '600000'], credentials, io);
 await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
 await vi.runAllTimersAsync();
 expect(await result).toBe(0); expect(JSON.parse(output)).toMatchObject({ runId: 'workflow-example-1', status: 'completed' });
 expect(output.trim().split('\n')).toHaveLength(1);
});
it('wait deadline returns original running ID and nonzero without cancellation; stats/resume only GET', async () => {
 const requests: string[] = []; let output = '';
 vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { requests.push(`${init.method} ${url}`); return Response.json({ runId: 'workflow-example-1', status: 'running' }); });
 vi.useFakeTimers();
 const result = runOperationsCli(['nowcoder', 'ops', 'workflow', '--id', 'workflow-example-1', '--wait', '10'], credentials, { stdout: s => { output += s; }, stderr() {} });
 await vi.runAllTimersAsync();
 expect(await result).toBe(1); expect(JSON.parse(output)).toMatchObject({ runId: 'workflow-example-1', waitingTimedOut: true, status: 'running' });
 expect(requests.every(r => r.startsWith('GET '))).toBe(true);
 output = ''; expect(await runOperationsCli(['nowcoder', 'ops', 'stats', '--id', 'workflow-example-1'], credentials, { stdout: s => { output += s; }, stderr() {} })).toBe(0);
 expect(requests.at(-1)).toContain('/workflow/workflow-example-1/stats');
});
it('lists workflow file, resume, wait and stats forms in ordinary usage errors', async () => {
 await expect(runOperationsCli(['nowcoder', 'ops', 'brief'], credentials, { stdout() {}, stderr() {} })).rejects.toThrow(/workflow --file .*--send.*--wait.*workflow --id .*--wait.*stats --id/u);
});
