import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollectedDocument } from '@data-collector/shared';
import { FeJourneyCollector } from '../../packages/bridge/src/feJourney/index.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const temporaryDirectories = createTemporaryDirectoryTracker();
afterEach(() => temporaryDirectories.cleanup());

function githubDocument(): CollectedDocument {
  return {
    schemaVersion: 1,
    source: 'github',
    kind: 'article',
    url: 'https://github.com/acme/agent-lab',
    canonicalUrl: 'https://github.com/acme/agent-lab',
    title: 'acme/agent-lab',
    collectedAt: '2026-08-19T00:00:00.000Z',
    html: '<p>README</p>',
    text: 'Agent project README with quick start, tests and architecture.',
    images: [],
  };
}

async function collectorFixture(overrides: Record<string, unknown> = {}) {
  const root = await temporaryDirectories.create('fe-journey-collector-');
  let current = '2026-08-19T00:00:00.000Z';
  const dependencies = {
    stateFile: join(root, 'fe-journey-state.json'),
    enabled: true,
    now: () => current,
    knownNowcoderUrls: vi.fn(() => new Set<string>()),
    discoverNowcoder: vi.fn(async () => ['https://www.nowcoder.com/discuss/1001']),
    enqueueNowcoder: vi.fn(async () => true),
    discoverGithub: vi.fn(async () => [githubDocument()]),
    saveGithub: vi.fn(async () => true),
    ...overrides,
  };
  const collector = await FeJourneyCollector.open(dependencies);
  return {
    root,
    dependencies,
    collector,
    setNow(value: string) { current = value; },
  };
}

describe('FeJourneyCollector schedule orchestration', () => {
  it('runs due sources, skips early repeats, and lets force bypass cadence', async () => {
    const fixture = await collectorFixture();

    const first = await fixture.collector.run();
    expect(first.sources).toMatchObject({
      nowcoder: { status: 'completed', discovered: 1, enqueued: 1 },
      github: { status: 'completed', discovered: 1, saved: 1, failed: 0 },
    });

    const early = await fixture.collector.run();
    expect(early.sources).toMatchObject({
      nowcoder: { status: 'skipped', reason: 'not_due' },
      github: { status: 'skipped', reason: 'not_due' },
    });
    expect(fixture.dependencies.discoverNowcoder).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.discoverGithub).toHaveBeenCalledTimes(1);

    fixture.setNow('2026-08-20T00:00:00.001Z');
    const daily = await fixture.collector.run();
    expect(daily.sources.nowcoder.status).toBe('completed');
    expect(daily.sources.github).toMatchObject({ status: 'skipped', reason: 'not_due' });

    const forced = await fixture.collector.run({ force: true });
    expect(forced.sources.nowcoder.status).toBe('completed');
    expect(forced.sources.github.status).toBe('completed');
    expect(fixture.dependencies.discoverNowcoder).toHaveBeenCalledTimes(3);
    expect(fixture.dependencies.discoverGithub).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent runs into one source execution', async () => {
    let release!: (urls: string[]) => void;
    const pending = new Promise<string[]>(resolve => { release = resolve; });
    const discoverNowcoder = vi.fn(() => pending);
    const fixture = await collectorFixture({ discoverNowcoder });

    const first = fixture.collector.run({ force: true, github: false });
    const second = fixture.collector.run({ force: true, github: false });
    expect(second).toBe(first);
    release(['https://www.nowcoder.com/discuss/1001']);

    const [left, right] = await Promise.all([first, second]);
    expect(right).toEqual(left);
    expect(discoverNowcoder).toHaveBeenCalledOnce();
  });

  it('can run the scheduled GitHub source without invoking Nowcoder', async () => {
    const fixture = await collectorFixture();

    const report = await fixture.collector.run({ nowcoder: false, github: true });

    expect(report.sources.nowcoder).toMatchObject({ status: 'skipped', reason: 'not_requested' });
    expect(report.sources.github).toMatchObject({ status: 'completed', saved: 1 });
    expect(fixture.dependencies.discoverNowcoder).not.toHaveBeenCalled();
    expect(fixture.dependencies.discoverGithub).toHaveBeenCalledOnce();
  });

  it('records one source failure while allowing the other source to finish', async () => {
    const fixture = await collectorFixture({
      discoverNowcoder: vi.fn(async () => { throw new Error('牛客临时不可用'); }),
    });

    const report = await fixture.collector.run({ force: true });

    expect(report.sources.nowcoder).toMatchObject({ status: 'failed', error: '牛客临时不可用' });
    expect(report.sources.github).toMatchObject({ status: 'completed', saved: 1 });
    const state = JSON.parse(await readFile(join(fixture.root, 'fe-journey-state.json'), 'utf8'));
    expect(state.sources.nowcoder.lastError).toBe('牛客临时不可用');
    expect(state.sources.github.lastSuccessAt).toBeDefined();
  });

  it('retries a failed source after a short backoff instead of waiting the full normal cadence', async () => {
    const discoverNowcoder = vi.fn()
      .mockRejectedValueOnce(new Error('牛客临时不可用'))
      .mockResolvedValue(['https://www.nowcoder.com/discuss/1001']);
    const fixture = await collectorFixture({ discoverNowcoder });

    const failed = await fixture.collector.run({ force: true, github: false });
    expect(failed.sources.nowcoder.status).toBe('failed');
    expect(fixture.collector.status().nextDueAt.nowcoder).toBe('2026-08-19T01:00:00.000Z');

    fixture.setNow('2026-08-19T00:59:59.999Z');
    const tooEarly = await fixture.collector.run({ github: false });
    expect(tooEarly.sources.nowcoder).toMatchObject({ status: 'skipped', reason: 'not_due' });

    fixture.setNow('2026-08-19T01:00:00.000Z');
    const retried = await fixture.collector.run({ github: false });
    expect(retried.sources.nowcoder.status).toBe('completed');
    expect(discoverNowcoder).toHaveBeenCalledTimes(2);
  });

  it('records an all-failed GitHub save batch as failed instead of successful', async () => {
    const fixture = await collectorFixture({
      saveGithub: vi.fn(async () => { throw new Error('磁盘已满'); }),
    });

    const report = await fixture.collector.run({ force: true, nowcoder: false });

    expect(report.sources.github).toMatchObject({
      status: 'failed',
      discovered: 1,
      saved: 0,
      failed: 1,
      error: expect.stringContaining('磁盘已满'),
    });
    const state = JSON.parse(await readFile(join(fixture.root, 'fe-journey-state.json'), 'utf8'));
    expect(state.sources.github.lastError).toContain('磁盘已满');
    expect(state.sources.github.lastSuccessAt).toBeUndefined();
  });

  it('persists the first warning when a GitHub save batch only partly succeeds', async () => {
    const second = {
      ...githubDocument(),
      url: 'https://github.com/acme/second-agent',
      canonicalUrl: 'https://github.com/acme/second-agent',
      title: 'acme/second-agent',
    };
    const fixture = await collectorFixture({
      discoverGithub: vi.fn(async () => [githubDocument(), second]),
      saveGithub: vi.fn(async document => {
        if (document.canonicalUrl.endsWith('/second-agent')) throw new Error('第二个项目写入失败');
        return true;
      }),
    });

    const report = await fixture.collector.run({ force: true, nowcoder: false });

    expect(report.sources.github).toMatchObject({
      status: 'completed',
      discovered: 2,
      saved: 1,
      failed: 1,
      error: expect.stringContaining('第二个项目写入失败'),
    });
    const state = JSON.parse(await readFile(join(fixture.root, 'fe-journey-state.json'), 'utf8'));
    expect(state.sources.github.lastSuccessAt).toBeDefined();
    expect(state.sources.github.lastWarning).toContain('第二个项目写入失败');
  });

  it('stays disabled and performs no collection without the fixed fe-journey sink', async () => {
    const fixture = await collectorFixture({ enabled: false });

    const report = await fixture.collector.run({ force: true });

    expect(report.sources).toMatchObject({
      nowcoder: { status: 'disabled' },
      github: { status: 'disabled' },
    });
    expect(fixture.dependencies.discoverNowcoder).not.toHaveBeenCalled();
    expect(fixture.dependencies.discoverGithub).not.toHaveBeenCalled();
  });
});
