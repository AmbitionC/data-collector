import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../packages/bridge/src/config.js';
import { JobStateError, JobStore } from '../../packages/bridge/src/jobs/store.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const WECHAT_URL = 'https://mp.weixin.qq.com/s/uW5gUigjslVY24YmCYhg0g';
const NOW = '2026-07-18T00:00:00.000Z';
const temporaryDirectories = createTemporaryDirectoryTracker();

afterEach(() => temporaryDirectories.cleanup());

async function temporaryDirectory(): Promise<string> {
  return temporaryDirectories.create('data-collector-jobs-');
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

  it('allows an extension current-page job to begin collecting without dispatch', async () => {
    const root = await temporaryDirectory();
    const jobs = await JobStore.open(join(root, '_catalog', 'jobs.json'), {
      now: () => NOW,
      id: () => 'current-page-job',
    });
    const job = await jobs.create({ url: WECHAT_URL, requestedBy: 'extension' });

    await jobs.transition(job.id, 'collecting');

    expect(jobs.get(job.id)?.status).toBe('collecting');
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

  it('serializes concurrent creates and transitions without losing durable jobs', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'jobs.json');
    const jobs = await JobStore.open(path, { now: () => NOW });
    const ids = Array.from({ length: 40 }, (_, index) => `parallel-${index}`);

    await Promise.all(
      ids.map((id, index) =>
        jobs.create({
          id,
          url: `https://mp.weixin.qq.com/s/parallel-${index}`,
          requestedBy: 'codex',
        }),
      ),
    );
    await Promise.all(ids.map(id => jobs.transition(id, 'dispatched')));

    const reopened = await JobStore.open(path);
    expect(reopened.list()).toHaveLength(ids.length);
    expect(reopened.list().every(job => job.status === 'dispatched')).toBe(true);
  });

  it('retries only failed or attention-needed jobs and clears stale result fields', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'jobs.json');
    let timestamp = 0;
    const jobs = await JobStore.open(path, {
      now: () => `2026-08-20T00:00:0${timestamp++}.000Z`,
    });

    const failed = await jobs.create({
      id: 'retry-failed',
      url: 'https://www.nowcoder.com/discuss/9101',
      requestedBy: 'codex',
    });
    await jobs.transition(failed.id, 'failed', {
      errorCode: 'EXTRACT_FAILED',
      errorMessage: 'temporary extraction failure',
      outputPath: '/tmp/stale.md',
    });
    expect(await jobs.retry(failed.id)).toMatchObject({
      id: failed.id,
      status: 'queued',
      createdAt: failed.createdAt,
    });
    expect(jobs.get(failed.id)).not.toHaveProperty('errorCode');
    expect(jobs.get(failed.id)).not.toHaveProperty('errorMessage');
    expect(jobs.get(failed.id)).not.toHaveProperty('outputPath');

    const attention = await jobs.create({
      id: 'retry-attention',
      url: 'https://www.nowcoder.com/discuss/9102',
      requestedBy: 'codex',
    });
    await jobs.transition(attention.id, 'dispatched');
    await jobs.transition(attention.id, 'needs_attention', {
      errorCode: 'LOGIN_REQUIRED',
      errorMessage: 'login expired',
    });
    await expect(jobs.retry(attention.id)).resolves.toMatchObject({ status: 'queued' });

    const saved = await jobs.create({
      id: 'do-not-retry-saved',
      url: 'https://www.nowcoder.com/discuss/9103',
      requestedBy: 'codex',
    });
    await jobs.transition(saved.id, 'collecting');
    await jobs.transition(saved.id, 'saved', { outputPath: '/tmp/current.md' });
    await expect(jobs.retry(saved.id)).rejects.toBeInstanceOf(JobStateError);
  });
});
