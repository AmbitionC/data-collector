import { describe, expect, it } from 'vitest';
import { RemoteJobScheduler } from '../../packages/extension/src/background/remoteJobScheduler.js';

describe('remote job scheduler', () => {
  it('rejects a concurrency limit that is not a positive safe integer', () => {
    expect(() => new RemoteJobScheduler(0)).toThrow('并发上限必须为正整数');
    expect(() => new RemoteJobScheduler(1.5)).toThrow('并发上限必须为正整数');
  });

  it('runs at most two tasks and gives the next free slot to an interactive task', async () => {
    const scheduler = new RemoteJobScheduler(2);
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const task = (name: string) => {
      let markStarted: (() => void) | undefined;
      const startedSignal = new Promise<void>(resolve => { markStarted = resolve; });
      const result = scheduler.run(async () => {
        started.push(name);
        markStarted?.();
        await new Promise<void>(resolve => { releases.set(name, resolve); });
        return name;
      }, name === 'interactive' ? 'interactive' : 'batch');
      return { result, started: startedSignal };
    };

    const first = task('batch-1');
    const second = task('batch-2');
    const third = task('batch-3');
    const interactive = task('interactive');
    await Promise.all([first.started, second.started]);

    expect(started).toEqual(['batch-1', 'batch-2']);
    expect(scheduler.peakActiveCount).toBe(2);

    releases.get('batch-1')?.();
    await interactive.started;
    expect(started).toEqual(['batch-1', 'batch-2', 'interactive']);

    releases.get('batch-2')?.();
    releases.get('interactive')?.();
    await third.started;
    releases.get('batch-3')?.();
    await expect(Promise.all([first.result, second.result, third.result, interactive.result])).resolves.toEqual([
      'batch-1',
      'batch-2',
      'batch-3',
      'interactive',
    ]);
    expect(scheduler.activeCount).toBe(0);
  });

  it('releases capacity after a rejected task', async () => {
    const scheduler = new RemoteJobScheduler(2);

    await expect(scheduler.run(async () => { throw new Error('boom'); }, 'batch'))
      .rejects.toThrow('boom');
    await expect(scheduler.run(async () => 'ok', 'batch')).resolves.toBe('ok');

    expect(scheduler.activeCount).toBe(0);
  });
});
