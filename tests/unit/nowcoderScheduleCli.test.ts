import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../packages/bridge/src/cli.js';

const roots: string[] = [];
const CONFIG = { enabled: false, companies: ['ant', 'tencent'], reviewOnly: true };
async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'nowcoder-schedule-cli-')); roots.push(root);
  await writeFile(join(root, 'auth.json'), JSON.stringify({ version: 1, token: 't'.repeat(43) }));
  let stdout = '', stderr = '';
  const io = { stdout: (text: string) => { stdout += text; }, stderr: (text: string) => { stderr += text; } };
  return { root, base: ['--config', root, '--port', '17321'], io, stdout: () => stdout, stderr: () => stderr };
}
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Nowcoder review schedule CLI', () => {
  it('prints authenticated schedule settings without changing or running them', async () => {
    const h = await harness();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), ...(init ? { init } : {}) });
      return Response.json(CONFIG);
    });
    expect(await runCli(['plans', 'schedule', ...h.base], h.io)).toBe(0);
    expect(JSON.parse(h.stdout())).toEqual(CONFIG);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'http://127.0.0.1:17321/v1/plans/nowcoder-schedule', init: { headers: { authorization: `Bearer ${'t'.repeat(43)}` } } });
    expect(calls[0]!.init?.method ?? 'GET').toBe('GET');
  });

  it.each(['--json', '--json-file'])('saves validated JSON using %s and never requests a run', async flag => {
    const h = await harness();
    const file = join(h.root, 'schedule.json');
    await writeFile(file, JSON.stringify(CONFIG));
    const calls: Array<{ url: string; method?: string; body: unknown }> = [];
    vi.stubGlobal('fetch', async (input: unknown, init: RequestInit) => {
      calls.push({ url: String(input), method: init.method, body: JSON.parse(String(init.body)) });
      return Response.json(CONFIG);
    });
    expect(await runCli(['plans', 'schedule', flag, flag === '--json' ? JSON.stringify(CONFIG) : file, ...h.base], h.io)).toBe(0);
    expect(calls).toEqual([{ url: 'http://127.0.0.1:17321/v1/plans/nowcoder-schedule', method: 'PUT', body: CONFIG }]);
  });

  it('sends explicit review-only company scope for manual collection', async () => {
    const h = await harness();
    let body: unknown;
    vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return Response.json({ id: 'review-batch', status: 'running' });
    });
    expect(await runCli(['plans', 'run', 'nowcoder-agent-market', '--review-only', '--companies', 'ant,tencent', ...h.base], h.io)).toBe(0);
    expect(body).toEqual({ planId: 'nowcoder-agent-market', force: false, nowcoderReviewOnly: true, nowcoderCompanies: ['ant', 'tencent'] });
  });

  it.each([
    ['plans', 'schedule', '--json', '{"enabled":true,"companies":["ant"],"reviewOnly":false}'],
    ['plans', 'schedule', '--json', '{"enabled":true,"companies":["unknown"],"reviewOnly":true}'],
    ['plans', 'schedule', '--json', '{}', '--json-file', 'ignored.json'],
    ['plans', 'run', 'zsxq-chen-teacher', '--review-only'],
    ['plans', 'run', 'nowcoder-agent-market', '--companies', 'ant'],
    ['plans', 'run', 'nowcoder-agent-market', '--review-only', '--companies', 'ant,ant'],
    ['plans', 'run', 'nowcoder-agent-market', '--review-only', '--companies', 'unknown'],
  ])('rejects invalid settings or review scope before a request: %j', async (...command) => {
    const h = await harness();
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect(await runCli([...command, ...h.base], h.io)).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(h.stderr()).not.toBe('');
  });
});
