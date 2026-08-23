import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const LOCK_WAIT_MS = 5 * 60_000;
const STALE_LOCK_MS = 30 * 60_000;
const HEARTBEAT_MS = 60_000;

interface LockRecord {
  owner?: string;
  pid?: number;
}

async function lockRecord(lockPath: string): Promise<LockRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(lockPath, 'utf8')) as { owner?: unknown; pid?: unknown };
    return {
      ...(typeof value.owner === 'string' ? { owner: value.owner } : {}),
      ...(typeof value.pid === 'number' && Number.isInteger(value.pid) ? { pid: value.pid } : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return undefined;
  }
}

function processIsAlive(pid: number | undefined): boolean {
  if (pid === undefined) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function releaseOwnedLock(lockPath: string, owner: string): Promise<void> {
  if ((await lockRecord(lockPath))?.owner !== owner) return;
  const now = new Date();
  await utimes(lockPath, now, now);
  if ((await lockRecord(lockPath))?.owner !== owner) return;
  await rm(lockPath, { force: true });
}

async function recoverDeadLock(lockPath: string, recoveryPath: string): Promise<void> {
  try {
    await mkdir(recoveryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw error;
  }
  try {
    const lockStat = await stat(lockPath);
    const existing = await lockRecord(lockPath);
    if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS && !processIsAlive(existing?.pid)) {
      await rm(lockPath, { force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  } finally {
    await rm(recoveryPath, { recursive: true, force: true });
  }
}

export async function withFeJourneyCandidateLock<T>(
  libraryRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const catalogDirectory = join(libraryRoot, '_catalog');
  const lockPath = join(catalogDirectory, 'fe-journey.lock');
  const recoveryPath = `${lockPath}.recovery`;
  const owner = randomUUID();
  await mkdir(catalogDirectory, { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    let handle;
    try {
      handle = await open(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        await recoverDeadLock(lockPath, recoveryPath);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error('等待 fe-journey 候选索引写锁超时');
      await delay(50);
      continue;
    }
    try {
      await handle.writeFile(`${JSON.stringify({ owner, pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      const heartbeat = setInterval(() => {
        void lockRecord(lockPath).then(current => {
          if (current?.owner !== owner) return;
          const now = new Date();
          return utimes(lockPath, now, now);
        }).catch(() => undefined);
      }, HEARTBEAT_MS);
      heartbeat.unref();
      try {
        return await operation();
      } finally {
        clearInterval(heartbeat);
      }
    } finally {
      await handle.close();
      await releaseOwnedLock(lockPath, owner);
    }
  }
}
