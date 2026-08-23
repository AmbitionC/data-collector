import { mkdir, open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const LOCK_WAIT_MS = 5 * 60_000;
const STALE_LOCK_MS = 30 * 60_000;

export async function withFeJourneyCandidateLock<T>(
  libraryRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const catalogDirectory = join(libraryRoot, '_catalog');
  const lockPath = join(catalogDirectory, 'fe-journey.lock');
  await mkdir(catalogDirectory, { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    let handle;
    try {
      handle = await open(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error('等待 fe-journey 候选索引写锁超时');
      await delay(50);
      continue;
    }
    try {
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      return await operation();
    } finally {
      await handle.close();
      await rm(lockPath, { force: true });
    }
  }
}
