import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';
const execFile = promisify(execFileCallback), dirs = createTemporaryDirectoryTracker();
afterEach(() => dirs.cleanup());
const from = '2026-10-30T10:00:00.000Z', to = '2026-10-30T10:05:00.000Z';
const usage = { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 };
const record = (id: string, timestamp: string, raw = usage) => ({ type: 'token_usage_record', timestamp, payload: { response_id: id, usage: raw, thread_token_usage: { total_tokens: 9999999 }, secret: 'PRIVATE_RAW_MUST_NOT_APPEAR' } });
async function run(records: unknown[][]) {
 const root = await dirs.create('usage-'), sessionPaths = records.map((_, i) => join(root, `${i}.jsonl`));
 await Promise.all(records.map((rows, i) => writeFile(sessionPaths[i]!, rows.map(r => JSON.stringify(r)).join('\n'))));
 const path = join(root, 'measurement.private.json'); await writeFile(path, JSON.stringify({ sessionPaths, from, to }));
 return execFile(process.execPath, [resolve('scripts/codex-run-usage.mjs'), '--file', path]);
}
it('streams multiple sessions at inclusive exact boundaries, deduplicates response IDs and counts reasoning as subset', async () => {
 const { stdout, stderr } = await run([[record('before', '2026-10-30T09:59:59.999Z'), record('one', from), { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 99999999 } } } }], [record('one', from), record('two', to), record('after', '2026-10-30T10:05:00.001Z')]]);
 expect(stderr).toBe(''); expect(JSON.parse(stdout)).toMatchObject({ from, to, responses: 2, inputTokens: 200, cachedInputTokens: 120, uncachedInputTokens: 80, outputTokens: 40, reasoningOutputTokens: 10, totalTokens: 240 });
 expect(stdout).not.toContain('PRIVATE_RAW');
});
it.each([
 { ...usage, cached_input_tokens: 101 }, { ...usage, reasoning_output_tokens: 21 }, { ...usage, total_tokens: 119 }, { ...usage, input_tokens: -1 }, { ...usage, output_tokens: undefined },
])('fails clearly for inconsistent/missing usage without defaulting fields to zero: %j', async raw => {
 await expect(run([[record('invalid', from, raw as typeof usage)]])).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringMatching(/usage|token/u) });
});
it('rejects missing response IDs and conflicting duplicate records', async () => {
 const bad = record('', from); await expect(run([[bad]])).rejects.toMatchObject({ code: 1, stdout: '' });
 await expect(run([[record('same', from)], [record('same', from, { ...usage, cached_input_tokens: 50 })]])).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringMatching(/duplicate|重复/u) });
});
