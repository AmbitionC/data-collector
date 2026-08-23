import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { withFeJourneyCandidateLock } from '../../packages/bridge/src/feJourney/fileLock.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const temporaryDirectories = createTemporaryDirectoryTracker();
afterEach(() => temporaryDirectories.cleanup());

describe('withFeJourneyCandidateLock', () => {
  it('serializes competing critical sections with an operating-system lock', async () => {
    const root = await temporaryDirectories.create('fe-journey-file-lock-contenders-');
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

  it('releases the operating-system lock when an operation fails', async () => {
    const root = await temporaryDirectories.create('fe-journey-file-lock-error-');
    await expect(withFeJourneyCandidateLock(root, async () => {
      throw new Error('expected failure');
    })).rejects.toThrow('expected failure');

    await expect(withFeJourneyCandidateLock(root, async () => 'recovered')).resolves.toBe('recovered');
  });

  it('ignores stale artifacts from the previous userspace lock protocol', async () => {
    const root = await temporaryDirectories.create('fe-journey-file-lock-migration-');
    const catalog = join(root, '_catalog');
    await mkdir(join(catalog, 'fe-journey.lock.recovery'), { recursive: true });
    await writeFile(join(catalog, 'fe-journey.lock'), JSON.stringify({ pid: 999_999_999 }));

    await expect(withFeJourneyCandidateLock(root, async () => 'locked')).resolves.toBe('locked');
  });
});
