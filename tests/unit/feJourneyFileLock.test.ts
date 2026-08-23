import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { withFeJourneyCandidateLock } from '../../packages/bridge/src/feJourney/fileLock.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const temporaryDirectories = createTemporaryDirectoryTracker();
afterEach(() => temporaryDirectories.cleanup());

describe('withFeJourneyCandidateLock', () => {
  it('does not remove a lock whose owner token changed before release', async () => {
    const root = await temporaryDirectories.create('fe-journey-file-lock-owner-');
    const catalog = join(root, '_catalog');
    const lockPath = join(catalog, 'fe-journey.lock');
    await mkdir(catalog, { recursive: true });

    await withFeJourneyCandidateLock(root, async () => {
      await writeFile(lockPath, `${JSON.stringify({ owner: 'replacement-owner' })}\n`);
    });

    await expect(readFile(lockPath, 'utf8')).resolves.toContain('replacement-owner');
    await rm(lockPath, { force: true });
  });

  it('recovers a stale lock only after its owner process is gone', async () => {
    const root = await temporaryDirectories.create('fe-journey-file-lock-stale-');
    const catalog = join(root, '_catalog');
    const lockPath = join(catalog, 'fe-journey.lock');
    await mkdir(catalog, { recursive: true });
    await writeFile(lockPath, `${JSON.stringify({ owner: 'stale-owner', pid: 999_999_999 })}\n`);
    const staleAt = new Date(Date.now() - 31 * 60_000);
    await utimes(lockPath, staleAt, staleAt);

    await expect(withFeJourneyCandidateLock(root, async () => 'recovered')).resolves.toBe('recovered');
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers an empty stale lock left before its owner record was written', async () => {
    const root = await temporaryDirectories.create('fe-journey-file-lock-empty-');
    const catalog = join(root, '_catalog');
    const lockPath = join(catalog, 'fe-journey.lock');
    await mkdir(catalog, { recursive: true });
    await writeFile(lockPath, '');
    const staleAt = new Date(Date.now() - 31 * 60_000);
    await utimes(lockPath, staleAt, staleAt);

    await expect(withFeJourneyCandidateLock(root, async () => 'recovered')).resolves.toBe('recovered');
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers an abandoned recovery election before reclaiming a dead lock', async () => {
    const root = await temporaryDirectories.create('fe-journey-file-lock-recovery-');
    const catalog = join(root, '_catalog');
    const lockPath = join(catalog, 'fe-journey.lock');
    const recoveryPath = `${lockPath}.recovery`;
    await mkdir(catalog, { recursive: true });
    await writeFile(recoveryPath, '');
    await writeFile(lockPath, `${JSON.stringify({ owner: 'stale-owner', pid: 999_999_999 })}\n`);
    const staleLockAt = new Date(Date.now() - 31 * 60_000);
    const staleRecoveryAt = new Date(Date.now() - 2 * 60_000);
    await utimes(lockPath, staleLockAt, staleLockAt);
    await utimes(recoveryPath, staleRecoveryAt, staleRecoveryAt);

    await expect(withFeJourneyCandidateLock(root, async () => 'recovered')).resolves.toBe('recovered');
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('elects one stale-lock recoverer and never overlaps competing critical sections', async () => {
    const root = await temporaryDirectories.create('fe-journey-file-lock-contenders-');
    const catalog = join(root, '_catalog');
    const lockPath = join(catalog, 'fe-journey.lock');
    await mkdir(catalog, { recursive: true });
    await writeFile(lockPath, `${JSON.stringify({ owner: 'stale-owner', pid: 999_999_999 })}\n`);
    const staleAt = new Date(Date.now() - 31 * 60_000);
    await utimes(lockPath, staleAt, staleAt);
    let active = 0;
    let maximumActive = 0;

    await Promise.all(Array.from({ length: 8 }, () => withFeJourneyCandidateLock(root, async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await delay(10);
      active -= 1;
    })));

    expect(maximumActive).toBe(1);
  });
});
