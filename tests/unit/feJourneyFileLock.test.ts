import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
});
