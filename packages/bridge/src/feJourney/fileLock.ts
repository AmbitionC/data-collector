import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const LOCK_WAIT_MS = 5 * 60_000;
const STALE_LOCK_MS = 30 * 60_000;
const HEARTBEAT_MS = 60_000;
const RECOVERY_LEASE_MS = 60_000;

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
  if (pid === undefined) return false;
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

async function removeAbandonedRecoveryLease(recoveryPath: string): Promise<void> {
  try {
    const recoveryStat = await stat(recoveryPath);
    if (Date.now() - recoveryStat.mtimeMs <= RECOVERY_LEASE_MS) return;
    const existing = await lockRecord(recoveryPath);
    if (processIsAlive(existing?.pid)) return;
    const abandonedPath = `${recoveryPath}.${randomUUID()}.abandoned`;
    try {
      await rename(recoveryPath, abandonedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    await rm(abandonedPath, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function recoverDeadLock(lockPath: string, recoveryPath: string): Promise<void> {
  const owner = randomUUID();
  let recoveryHandle;
  try {
    recoveryHandle = await open(recoveryPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      await removeAbandonedRecoveryLease(recoveryPath);
      return;
    }
    throw error;
  }
  try {
    await recoveryHandle.writeFile(`${JSON.stringify({ owner, pid: process.pid })}\n`);
    const lockStat = await stat(lockPath);
    const existing = await lockRecord(lockPath);
    if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS && !processIsAlive(existing?.pid)) {
      const now = new Date();
      await recoveryHandle.utimes(now, now);
      if ((await lockRecord(recoveryPath))?.owner !== owner) return;
      await rm(lockPath, { force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  } finally {
    const heldStat = await recoveryHandle.stat();
    await recoveryHandle.close();
    try {
      const currentStat = await stat(recoveryPath);
      if (currentStat.dev === heldStat.dev && currentStat.ino === heldStat.ino) {
        await rm(recoveryPath, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
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
