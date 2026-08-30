import { describe, expect, it, vi } from 'vitest';
import {
  ArtifactReaderCoordinator,
} from '../../packages/bridge/src/artifactReaderCoordinator.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('ArtifactReaderCoordinator', () => {
  it('shares one physical lease across run and operation readers and releases it once', async () => {
    const events: string[] = [];
    const physical = { release: vi.fn(async () => { events.push('physical:release'); }) };
    const coordinator = new ArtifactReaderCoordinator({
      acquirePhysical: async () => {
        events.push('physical:acquire');
        return physical;
      },
    });

    const run = await coordinator.acquireReader('nowcoder-directed-run');
    const zsxq = await coordinator.acquireReader('zsxq-persistence');
    const result = await coordinator.acquireReader('nowcoder-directed-persistence');

    expect(events).toEqual(['physical:acquire']);
    expect(coordinator.snapshot()).toMatchObject({ activeReaders: 3, pendingReaders: 0 });
    await zsxq.release();
    await run.release();
    expect(physical.release).not.toHaveBeenCalled();
    await result.release();
    await result.release();
    expect(physical.release).toHaveBeenCalledOnce();
    expect(events).toEqual(['physical:acquire', 'physical:release']);
  });

  it('publishes pending acquisition synchronously and excludes update/start races', async () => {
    const physicalGate = deferred<{ release(): Promise<void> }>();
    const coordinator = new ArtifactReaderCoordinator({
      acquirePhysical: () => physicalGate.promise,
    });

    const start = coordinator.tryBeginStart();
    expect(start).toBeDefined();
    const readerPromise = coordinator.acquireReader('nowcoder-directed-run');
    expect(coordinator.snapshot()).toMatchObject({ startIntents: 1, pendingReaders: 1 });
    expect(coordinator.tryBeginUpdate(false)).toBeUndefined();
    start!.release();
    expect(coordinator.tryBeginUpdate(false)).toBeUndefined();

    const physical = { release: vi.fn(async () => undefined) };
    physicalGate.resolve(physical);
    const reader = await readerPromise;
    expect(coordinator.tryBeginUpdate(false)).toBeUndefined();
    await reader.release();

    const update = coordinator.tryBeginUpdate(false);
    expect(update).toBeDefined();
    expect(coordinator.tryBeginStart()).toBeUndefined();
    update!.handoffToRestart();
    expect(coordinator.snapshot().updateState).toBe('restart');
    expect(coordinator.tryBeginStart()).toBeUndefined();
    update!.release();
    expect(coordinator.tryBeginStart()).toBeDefined();
  });

  it('fires one idle opportunity after the last idempotent logical release', async () => {
    const onIdle = vi.fn();
    const coordinator = new ArtifactReaderCoordinator({
      acquirePhysical: async () => ({ release: async () => undefined }),
      onIdle,
    });
    const first = await coordinator.acquireReader('first');
    const second = await coordinator.acquireReader('second');

    await first.release();
    expect(onIdle).not.toHaveBeenCalled();
    await second.release();
    await second.release();

    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('rolls back a failed physical acquisition without leaking pending state', async () => {
    const coordinator = new ArtifactReaderCoordinator({
      acquirePhysical: async () => { throw new Error('lease unavailable'); },
    });

    await expect(coordinator.acquireReader('directed-run')).rejects.toThrow('lease unavailable');
    expect(coordinator.snapshot()).toMatchObject({ activeReaders: 0, pendingReaders: 0 });
    const update = coordinator.tryBeginUpdate(false);
    expect(update).toBeDefined();
    update!.release();
  });

  it('stays busy until deferred physical release settles', async () => {
    const releaseGate = deferred<void>();
    const releaseStarted = deferred<void>();
    const coordinator = new ArtifactReaderCoordinator({
      acquirePhysical: async () => ({
        release: async () => {
          releaseStarted.resolve();
          await releaseGate.promise;
        },
      }),
    });
    const reader = await coordinator.acquireReader('directed-run');

    const releasing = reader.release();
    await releaseStarted.promise;
    expect(coordinator.snapshot()).toMatchObject({
      activeReaders: 0,
      physicalBusy: true,
    });
    expect(coordinator.tryBeginUpdate(false)).toBeUndefined();

    releaseGate.resolve();
    await releasing;
    expect(coordinator.snapshot()).toMatchObject({ physicalBusy: false });
    const update = coordinator.tryBeginUpdate(false);
    expect(update).toBeDefined();
    update!.release();
  });

  it('shares one successful release promise across concurrent and later calls on one handle', async () => {
    const releaseStarted = deferred<void>();
    const releaseGate = deferred<void>();
    const physicalRelease = vi.fn(async () => {
      releaseStarted.resolve();
      await releaseGate.promise;
    });
    const coordinator = new ArtifactReaderCoordinator({
      acquirePhysical: async () => ({ release: physicalRelease }),
    });
    const reader = await coordinator.acquireReader('directed-run');

    const first = reader.release();
    await releaseStarted.promise;
    const concurrent = reader.release();

    expect(concurrent).toBe(first);
    expect(coordinator.snapshot()).toMatchObject({ activeReaders: 0, physicalBusy: true });
    releaseGate.resolve();
    await expect(first).resolves.toBeUndefined();
    expect(reader.release()).toBe(first);
    expect(physicalRelease).toHaveBeenCalledOnce();
    expect(coordinator.snapshot()).toMatchObject({ activeReaders: 0, physicalBusy: false });
  });

  it('shares one quarantined release rejection across concurrent and later calls on one handle', async () => {
    const releaseStarted = deferred<void>();
    const releaseGate = deferred<void>();
    const physicalRelease = vi.fn(async () => {
      releaseStarted.resolve();
      await releaseGate.promise;
    });
    const coordinator = new ArtifactReaderCoordinator({
      acquirePhysical: async () => ({ release: physicalRelease }),
    });
    const reader = await coordinator.acquireReader('directed-run');

    const first = reader.release();
    await releaseStarted.promise;
    const concurrent = reader.release();
    const settlements = Promise.allSettled([first, concurrent]);

    expect(concurrent).toBe(first);
    releaseGate.reject(new Error('private cross-process release failure'));
    const [firstResult, concurrentResult] = await settlements;
    expect(firstResult).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({
        message: 'artifact physical lease release is quarantined',
      }),
    });
    expect(concurrentResult).toMatchObject({ status: 'rejected' });
    if (firstResult.status !== 'rejected' || concurrentResult.status !== 'rejected') {
      throw new Error('release promises unexpectedly fulfilled');
    }
    expect(concurrentResult.reason).toBe(firstResult.reason);
    const later = reader.release();
    expect(later).toBe(first);
    await expect(later).rejects.toBe(firstResult.reason);
    expect(physicalRelease).toHaveBeenCalledOnce();
    expect(coordinator.snapshot()).toMatchObject({
      activeReaders: 0,
      pendingReaders: 0,
      physicalBusy: true,
      physicalFaulted: true,
    });
  });

  it('emits one idle edge after a start-intent reader acquisition fails', async () => {
    const onIdle = vi.fn();
    const coordinator = new ArtifactReaderCoordinator({
      acquirePhysical: async () => { throw new Error('lease unavailable'); },
      onIdle,
    });
    const start = coordinator.tryBeginStart();
    expect(start).toBeDefined();

    await expect(coordinator.acquireReader('directed-run')).rejects.toThrow('lease unavailable');
    expect(onIdle).not.toHaveBeenCalled();
    start!.release();
    start!.release();

    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('permanently quarantines a rejected physical release without emitting idle', async () => {
    const releaseStarted = deferred<void>();
    const releaseGate = deferred<void>();
    const onIdle = vi.fn();
    const physicalRelease = vi.fn(async () => {
      releaseStarted.resolve();
      await releaseGate.promise;
    });
    const acquirePhysical = vi.fn(async () => ({ release: physicalRelease }));
    const coordinator = new ArtifactReaderCoordinator({ acquirePhysical, onIdle });
    const reader = await coordinator.acquireReader('directed-run');

    const releasing = reader.release();
    await releaseStarted.promise;
    const concurrentWaiter = coordinator.acquireReader('concurrent-operation');
    const releasingRejected = expect(releasing).rejects.toThrow('artifact physical lease release is quarantined');
    const waiterRejected = expect(concurrentWaiter).rejects.toThrow('artifact physical lease release is quarantined');
    releaseGate.reject(new Error('cross-process ownership uncertain'));
    await Promise.all([releasingRejected, waiterRejected]);

    expect(coordinator.snapshot()).toMatchObject({
      activeReaders: 0,
      pendingReaders: 0,
      physicalBusy: true,
      physicalFaulted: true,
    });
    expect(onIdle).not.toHaveBeenCalled();
    const start = coordinator.tryBeginStart();
    expect(start).toBeUndefined();
    start?.release();
    const update = coordinator.tryBeginUpdate(false);
    expect(update).toBeUndefined();
    update?.release();
    await expect(coordinator.acquireReader('after-quarantine'))
      .rejects.toThrow('artifact physical lease release is quarantined');
    await expect(coordinator.close())
      .rejects.toThrow('artifact physical lease release is quarantined');
    expect(acquirePhysical).toHaveBeenCalledOnce();
    expect(physicalRelease).toHaveBeenCalledOnce();
  });
});
