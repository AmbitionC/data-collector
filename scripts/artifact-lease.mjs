import { randomUUID } from 'node:crypto';
import {
  mkdir,
  lstat,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const ARTIFACT_LEASE_DIRECTORY = '.data-collector-extension-lease';

const OWNER_FILE = 'owner.json';
const OWNER_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 50;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ROLE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const DESTINATION_BUSY_CODES = new Set(['EEXIST', 'ENOTEMPTY', 'EISDIR', 'ENOTDIR']);

function errorCode(error) {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function validOwner(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const owner = value;
  if (
    owner.version !== OWNER_VERSION
    || !Number.isSafeInteger(owner.pid)
    || owner.pid <= 0
    || typeof owner.token !== 'string'
    || !TOKEN_PATTERN.test(owner.token)
    || typeof owner.role !== 'string'
    || !ROLE_PATTERN.test(owner.role)
    || typeof owner.startedAt !== 'string'
    || !Number.isFinite(Date.parse(owner.startedAt))
  ) return undefined;
  return {
    version: OWNER_VERSION,
    pid: owner.pid,
    token: owner.token,
    role: owner.role,
    startedAt: owner.startedAt,
  };
}

async function readOwner(directory) {
  try {
    return validOwner(JSON.parse(await readFile(join(directory, OWNER_FILE), 'utf8')));
  } catch {
    return undefined;
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function prepareCandidate(candidate, owner) {
  await mkdir(candidate, { mode: 0o700 });
  const ownerPath = join(candidate, OWNER_FILE);
  const handle = await open(ownerPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  const persisted = await readOwner(candidate);
  if (
    !persisted
    || persisted.pid !== owner.pid
    || persisted.token !== owner.token
    || persisted.role !== owner.role
    || persisted.startedAt !== owner.startedAt
  ) {
    throw new Error('artifact lease candidate owner validation failed');
  }
  await syncDirectory(candidate);
}

function ownerIsDefinitelyDead(owner, processKill) {
  try {
    processKill(owner.pid, 0);
    return false;
  } catch (error) {
    return errorCode(error) === 'ESRCH';
  }
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

export function artifactLeasePath(workspaceRoot) {
  return join(workspaceRoot, 'artifacts', ARTIFACT_LEASE_DIRECTORY);
}

/**
 * Acquire the process-shared artifact lease.
 *
 * A candidate is fully written, fsynced and read back before a single rename publishes it as
 * canonical. A canonical owner is recoverable only when its metadata is valid and kill(pid, 0)
 * explicitly returns ESRCH. The stale token's quarantine directory is intentionally retained as
 * an ABA tombstone: another waiter that observed the same stale owner can never rename a newer
 * canonical lease into that old token's destination.
 */
export async function acquireArtifactLease(workspaceRoot, options) {
  if (!options || typeof options.role !== 'string' || !ROLE_PATTERN.test(options.role)) {
    throw new Error('artifact lease role is invalid');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error('artifact lease timeout is invalid');
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error('artifact lease poll interval is invalid');
  }

  const canonical = artifactLeasePath(workspaceRoot);
  await mkdir(dirname(canonical), { recursive: true });
  const token = randomUUID();
  const owner = {
    version: OWNER_VERSION,
    pid: process.pid,
    token,
    role: options.role,
    startedAt: new Date().toISOString(),
  };
  const candidate = `${canonical}.candidate-${process.pid}-${token}`;
  const processKill = options.processKill ?? process.kill.bind(process);
  const deadline = Date.now() + timeoutMs;
  let acquired = false;

  try {
    await prepareCandidate(candidate, owner);
    while (true) {
      // POSIX rename may replace an existing *empty* directory. Never attempt publication merely
      // because canonical lacks a readable owner: only lstat's explicit ENOENT authorizes rename.
      // If another legal contender wins between lstat and rename, its canonical is non-empty and
      // our rename fails atomically with ENOTEMPTY/EEXIST.
      if (!(await pathExists(canonical))) {
        try {
          await rename(candidate, canonical);
          acquired = true;
          break;
        } catch (error) {
          if (!DESTINATION_BUSY_CODES.has(errorCode(error))) throw error;
        }
      }

      const incumbent = await readOwner(canonical);
      if (incumbent && ownerIsDefinitelyDead(incumbent, processKill)) {
        const staleQuarantine = `${canonical}.stale-${incumbent.token}`;
        try {
          await rename(canonical, staleQuarantine);
          // Do not delete this token-derived tombstone. A concurrent reaper may already have read
          // the stale token; EEXIST at this exact path is what prevents it from moving our new lock.
          continue;
        } catch (error) {
          const code = errorCode(error);
          if (code !== 'ENOENT' && !DESTINATION_BUSY_CODES.has(code)) throw error;
        }
      }

      if (Date.now() >= deadline) {
        throw new Error(`artifact lease acquisition timeout for role ${options.role}`);
      }
      await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
  } finally {
    if (!acquired) await rm(candidate, { recursive: true, force: true });
  }

  let releasePromise;
  const release = async () => {
    if (releasePromise) return releasePromise;
    releasePromise = (async () => {
      const incumbent = await readOwner(canonical);
      if (!incumbent || incumbent.token !== token) {
        throw new Error('artifact lease ownership changed before release');
      }
      const releaseQuarantine = `${canonical}.release-${token}`;
      await rename(canonical, releaseQuarantine);
      const moved = await readOwner(releaseQuarantine);
      if (!moved || moved.token !== token) {
        throw new Error('artifact lease ownership changed during release');
      }
      await rm(releaseQuarantine, { recursive: true });
    })();
    return releasePromise;
  };

  return {
    path: canonical,
    token,
    owner,
    release,
  };
}

export async function withArtifactLease(workspaceRoot, options, operation) {
  const lease = await acquireArtifactLease(workspaceRoot, options);
  try {
    return await operation(lease);
  } finally {
    await lease.release();
  }
}
