import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PairingManager } from '../../packages/bridge/src/auth.js';
import { loadConfig } from '../../packages/bridge/src/config.js';
import { JobStateError, JobStore } from '../../packages/bridge/src/jobs/store.js';

const WECHAT_URL = 'https://mp.weixin.qq.com/s/uW5gUigjslVY24YmCYhg0g';
const NOW = '2026-07-18T00:00:00.000Z';

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'data-collector-jobs-'));
}

describe('bridge configuration', () => {
  it('resolves local paths and rejects a non-loopback host', async () => {
    const root = await temporaryDirectory();
    const config = loadConfig({ libraryRoot: root, port: 0 });

    expect(config.host).toBe('127.0.0.1');
    expect(config.jobsFile).toBe(join(root, '_catalog', 'jobs.json'));
    expect(() => loadConfig({ libraryRoot: root, host: '0.0.0.0' })).toThrow(
      /只允许监听 127\.0\.0\.1/,
    );
  });
});

describe('pairing', () => {
  it('exchanges a one-time code, persists a protected token, and rejects reuse', async () => {
    const root = await temporaryDirectory();
    const authFile = join(root, 'auth.json');
    const pairing = await PairingManager.open(authFile, {
      now: () => Date.parse(NOW),
      code: () => '123456',
      token: () => 'test-token-with-at-least-32-characters',
    });

    expect(pairing.createPairingCode()).toMatchObject({ code: '123456' });
    const token = await pairing.exchange('123456');
    expect(token).toBe('test-token-with-at-least-32-characters');
    expect(pairing.verify(token)).toBe(true);
    expect(pairing.verify('wrong-token-with-at-least-32-chars')).toBe(false);
    await expect(pairing.exchange('123456')).rejects.toThrow(/配对码无效或已过期/);
    expect((await stat(authFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(authFile, 'utf8')).not.toContain('123456');

    const reopened = await PairingManager.open(authFile);
    expect(reopened.verify(token)).toBe(true);
  });

  it('expires a code after ten minutes', async () => {
    const root = await temporaryDirectory();
    let now = Date.parse(NOW);
    const pairing = await PairingManager.open(join(root, 'auth.json'), {
      now: () => now,
      code: () => '654321',
      token: () => 'another-test-token-with-32-characters',
    });
    pairing.createPairingCode();
    now += 10 * 60 * 1000 + 1;

    await expect(pairing.exchange('654321')).rejects.toThrow(/配对码无效或已过期/);
  });
});

describe('durable jobs', () => {
  it('persists legal transitions and refuses terminal-state reversal', async () => {
    const root = await temporaryDirectory();
    const path = join(root, '_catalog', 'jobs.json');
    const jobs = await JobStore.open(path, {
      now: () => NOW,
      id: () => 'job-1',
    });
    const job = await jobs.create({ url: WECHAT_URL, requestedBy: 'codex' });

    await jobs.transition(job.id, 'dispatched');
    await jobs.transition(job.id, 'collecting');
    await jobs.transition(job.id, 'saved', { outputPath: '/tmp/index.md' });
    await expect(jobs.transition(job.id, 'collecting')).rejects.toBeInstanceOf(JobStateError);

    const reopened = await JobStore.open(path);
    expect(reopened.get(job.id)).toMatchObject({
      status: 'saved',
      outputPath: '/tmp/index.md',
    });
  });

  it('recovers in-flight work and creates duplicate request IDs idempotently', async () => {
    const root = await temporaryDirectory();
    const path = join(root, '_catalog', 'jobs.json');
    const jobs = await JobStore.open(path, { now: () => NOW, id: () => 'job-2' });
    const first = await jobs.create({
      id: 'request-42',
      url: `${WECHAT_URL}?scene=1`,
      requestedBy: 'cli',
    });
    const duplicate = await jobs.create({
      id: 'request-42',
      url: WECHAT_URL,
      requestedBy: 'cli',
    });
    expect(duplicate).toEqual(first);

    await jobs.transition(first.id, 'dispatched');
    await jobs.recover();
    expect(jobs.get(first.id)?.status).toBe('queued');
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 1 });
  });

  it('rejects a duplicate ID that points to different content', async () => {
    const root = await temporaryDirectory();
    const jobs = await JobStore.open(join(root, 'jobs.json'), {
      now: () => NOW,
      id: () => 'job-3',
    });
    await jobs.create({ id: 'same', url: WECHAT_URL, requestedBy: 'cli' });

    await expect(
      jobs.create({
        id: 'same',
        url: 'https://mp.weixin.qq.com/s/different',
        requestedBy: 'cli',
      }),
    ).rejects.toThrow(/任务 ID 已用于其他地址/);
  });
});
