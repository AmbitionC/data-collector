import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { jobIssues, jobStatus, runJob, withLock } from '../../packages/bridge/src/autopilot/core.js';

const NOW = Date.parse('2026-11-07T06:00:00.000Z'); // 14:00 Shanghai
const line = (over: object) => `${JSON.stringify({ at: new Date(NOW - 60_000).toISOString(), ...over })}\n`;

describe('autopilot core', () => {
  it('persists state, logs activity and keeps idle ticks out of the log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ap-'));
    const job = (outcome: string) => runJob<{ n: number }, { outcome: string }>({ configDir: dir, name: 'x', now: () => NOW, initial: async () => ({ n: 0 }), tick: async (state, save) => { await save({ n: state.n + 1 }); return { outcome }; } });
    await job('published'); await job('not_due');
    const root = join(dir, 'nowcoder-autopilot');
    expect(JSON.parse(await readFile(join(root, 'x.json'), 'utf8')).n).toBe(2);
    expect((await readFile(join(root, 'x.log.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
  });
  it('turns a thrown tick into a logged failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ap-'));
    const result = await runJob<object, { outcome: string }>({ configDir: dir, name: 'x', now: () => NOW, initial: async () => ({}), tick: async () => { throw new Error('boom'); } });
    expect(result).toMatchObject({ outcome: 'technical_failure', detail: 'boom' });
  });
  it('recovers a lock left by a dead process', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'ap-')), 'l'); await writeFile(path, '999999');
    expect(await withLock(path, Date.now(), async () => 'ran')).toBe('ran');
  });
  it('flags token waste, repeated failure and silence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ap-'));
    await writeFile(join(root, 'comments.log.jsonl'), line({ outcome: 'published', usage: { input_tokens: 4_000_000, output_tokens: 1 } }) + line({ outcome: 'technical_failure', detail: 'x' }).repeat(5));
    const statuses = await jobStatus(root, NOW);
    expect(statuses[0]).toMatchObject({ job: 'comments', lastFailure: 'technical_failure: x' });
    expect(jobIssues(statuses, NOW)).toHaveLength(2);
    expect(jobIssues(statuses, NOW + 4 * 3_600_000).some(issue => issue.includes('没有成功'))).toBe(true);
    expect(jobIssues([{ job: 'comments', outcomes: {}, tokens: 0, lastSuccessAt: null, lastFailure: null }], NOW)).toEqual([]);
  });
});
