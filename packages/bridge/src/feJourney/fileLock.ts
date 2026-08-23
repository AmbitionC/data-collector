import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const LOCK_WAIT_SECONDS = 5 * 60;
const RELEASE_WAIT_MS = 5_000;
const READY_MARKER = 'DATA_COLLECTOR_LOCK_READY';
const HOLDER_SCRIPT = `
process.stdout.write('${READY_MARKER}\\n');
process.stdin.resume();
process.stdin.once('end', () => process.exit(0));
`;

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
    const mutexName = `Local\\DataCollector-${createHash('sha256').update(lockPath).digest('hex')}`;
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

async function releaseLock(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.stdin.end();
  const result = await Promise.race([
    exited.then(() => 'exited' as const),
    delay(RELEASE_WAIT_MS).then(() => 'timeout' as const),
  ]);
  if (result === 'exited') return;
  child.kill('SIGTERM');
  await exited;
}

export async function withFeJourneyCandidateLock<T>(
  libraryRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const catalogDirectory = join(libraryRoot, '_catalog');
  const lockPath = join(catalogDirectory, 'fe-journey.lock');
  await mkdir(catalogDirectory, { recursive: true });
  const command = lockCommand(lockPath);
  const child = spawn(command.command, command.args, { stdio: 'pipe' });
  await waitForLock(child);
  try {
    return await operation();
  } finally {
    await releaseLock(child);
  }
}
