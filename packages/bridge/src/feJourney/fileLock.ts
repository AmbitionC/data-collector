import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AsyncLocalStorage } from 'node:async_hooks';

const LOCK_WAIT_SECONDS = 5 * 60;
const RELEASE_WAIT_MS = 5_000;
const READY_MARKER = 'DATA_COLLECTOR_LOCK_READY';
const HOLDER_SCRIPT = `
process.stdout.write('${READY_MARKER}\\n');
process.stdin.resume();
process.stdin.once('end', () => process.exit(0));
`;

interface CatalogLockLease {
  key: string;
  active: boolean;
}

const catalogLockContext = new AsyncLocalStorage<ReadonlyMap<string, CatalogLockLease>>();

interface LockCommand {
  command: string;
  args: string[];
}

function lockCommand(lockPath: string, platform: NodeJS.Platform = process.platform): LockCommand {
  if (platform === 'darwin') {
    return {
      command: '/usr/bin/lockf',
      args: ['-k', '-s', '-t', String(LOCK_WAIT_SECONDS), lockPath, process.execPath, '-e', HOLDER_SCRIPT],
    };
  }
  if (platform === 'linux') {
    return {
      command: '/usr/bin/flock',
      args: ['-w', String(LOCK_WAIT_SECONDS), lockPath, process.execPath, '-e', HOLDER_SCRIPT],
    };
  }
  if (platform === 'win32') {
    const mutexName = `Local\\DataCollector-${createHash('sha256').update(lockPath.toLowerCase()).digest('hex')}`;
    const script = `
$mutex = [System.Threading.Mutex]::new($false, '${mutexName}')
$acquired = $false
try {
  try { $acquired = $mutex.WaitOne(${LOCK_WAIT_SECONDS * 1_000}) }
  catch [System.Threading.AbandonedMutexException] { $acquired = $true }
  if (-not $acquired) { exit 75 }
  [Console]::Out.WriteLine('${READY_MARKER}')
  [Console]::In.ReadLine() | Out-Null
} finally {
  if ($acquired) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
`;
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', script],
    };
  }
  throw new Error(`暂不支持在 ${platform} 上创建 fe-journey 候选索引写锁`);
}

function waitForLock(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const cleanup = () => {
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (!stdout.includes(`${READY_MARKER}\n`)) return;
      cleanup();
      child.stdout.resume();
      child.stderr.resume();
      resolve();
    };
    const onStderr = (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2_000);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(
        `等待 fe-journey 候选索引写锁失败（exit=${code ?? 'null'}, signal=${signal ?? 'none'}）`
        + (stderr.trim() ? `：${stderr.trim()}` : ''),
      ));
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const onExit = () => resolve();
    child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      child.off('exit', onExit);
      resolve();
    }
  });
}

async function releaseLock(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForExit(child);
  child.stdin.end();
  const result = await Promise.race([
    exited.then(() => 'exited' as const),
    delay(RELEASE_WAIT_MS).then(() => 'timeout' as const),
  ]);
  if (result === 'exited') return;
  child.kill('SIGTERM');
  await exited;
}

async function validateOptionalLockLeaf(catalogDirectory: string, lockPath: string): Promise<void> {
  try {
    const lockMetadata = await lstat(lockPath);
    if (lockMetadata.isSymbolicLink() || !lockMetadata.isFile()
      || await realpath(lockPath) !== lockPath) throw new Error('定向候选锁文件无效');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = await lstat(catalogDirectory);
    if (parent.isSymbolicLink() || !parent.isDirectory()
      || await realpath(catalogDirectory) !== catalogDirectory) throw error;
  }
}

async function withCatalogDirectoryLock<T>(
  catalogDirectory: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = await realpath(catalogDirectory);
  if (catalogLockContext.getStore()?.get(key)?.active) return await operation();
  const lockPath = join(key, 'fe-journey.lock');
  await validateOptionalLockLeaf(key, lockPath);
  const command = lockCommand(lockPath);
  const child = spawn(command.command, command.args, { stdio: 'pipe' });
  await waitForLock(child);
  const lease: CatalogLockLease = { key, active: true };
  try {
    const held = new Map(catalogLockContext.getStore() ?? []);
    held.set(key, lease);
    return await catalogLockContext.run(held, operation);
  } finally {
    // Detached descendants retain the ALS store. Invalidate their lease before releasing the OS
    // holder so stale async context can never be mistaken for current lock authority.
    lease.active = false;
    await releaseLock(child);
  }
}

/** True only inside this process's unforgeable async lease for the same physical catalog. */
export async function libraryCatalogLockHeld(libraryRoot: string): Promise<boolean> {
  const held = catalogLockContext.getStore();
  if (!held) return false;
  try {
    return held.get(await realpath(join(libraryRoot, '_catalog')))?.active === true;
  } catch {
    return false;
  }
}

/** Acquire the shared cross-process authority used by every internal catalog writer. */
export async function withLibraryCatalogLock<T>(
  libraryRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const catalogDirectory = join(libraryRoot, '_catalog');
  await mkdir(catalogDirectory, { recursive: true });
  return await withCatalogDirectoryLock(await realpath(catalogDirectory), operation);
}

/** Acquire the same authority only inside an already canonical, preflighted library. */
export async function withExistingLibraryCatalogLock<T>(
  canonicalLibraryRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const catalogDirectory = join(canonicalLibraryRoot, '_catalog');
  const metadata = await lstat(catalogDirectory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()
    || await realpath(catalogDirectory) !== catalogDirectory) throw new Error('定向候选锁目录无效');
  const lockPath = join(catalogDirectory, 'fe-journey.lock');
  const rel = relative(canonicalLibraryRoot, lockPath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('定向候选锁越出本机库');
  }
  await validateOptionalLockLeaf(catalogDirectory, lockPath);
  return await withCatalogDirectoryLock(catalogDirectory, operation);
}

/** Backward-compatible Fe Journey names; both catalogs intentionally share one lock file. */
export const withFeJourneyCandidateLock = withLibraryCatalogLock;
export const withExistingFeJourneyCandidateLock = withExistingLibraryCatalogLock;
