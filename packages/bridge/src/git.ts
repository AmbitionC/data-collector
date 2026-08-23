import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 让本机服务能跑起 git。
 *
 * 这里踩过一个坑，必须写清楚免得再犯：用户点同步，16 条全失败，报错都是
 * `xcrun: error: invalid active developer path`。我据此告诉用户「你这台 Mac 的命令行工具坏了，
 * 去跑 `xcode-select --install`」——**这是错的**，用户终端里的 git 一直好好的。
 *
 * 差别不在 git，在**谁在跑 git**。本机服务是以登录项常驻的（launchd / systemd），
 * 它继承的环境和终端不是一回事：launchd 只给 `/usr/bin:/bin:/usr/sbin:/sbin`，看不见 Homebrew。
 * 用户终端里跑的是 `/opt/homebrew/bin/git`（真二进制，一切正常），服务里却只找得到
 * `/usr/bin/git`——那只是个壳，得先经 `xcrun` 找开发者目录，找不到就炸。
 *
 * 所以：**别指望裸 `git` 在窄 PATH 下能解析对**。按固定顺序探一遍，用第一个
 * `--version` 答得上来的绝对路径；同时把常见安装目录前置进 PATH，好让 git 自己要调的东西
 * （凭证助手、ssh）也找得到。一个都探不到才报错，并如实列出试过哪些——
 * 绝不再把「服务这边环境不对」说成「你的机器坏了」。
 */

/** 常见的 git 安装目录，按「用户自己装的优先于系统壳」排序。 */
export const GIT_SEARCH_DIRS = [
  '/opt/homebrew/bin', // Apple Silicon 的 Homebrew
  '/usr/local/bin', // Intel Homebrew / 手动安装
  '/opt/local/bin', // MacPorts
  '/usr/bin', // 系统自带（macOS 上是需要 xcrun 的壳，所以排在后面）
  '/bin',
];

/** 登录项该带的 PATH：常见安装目录 + 系统目录。写进 plist / service，让服务一启动就够用。 */
export const SERVICE_PATH = [...GIT_SEARCH_DIRS, '/usr/sbin', '/sbin'].join(':');

/** 一个都探不到时消息的开头；`explainGitFailure` 靠它认出这是我们自己写好的说明。 */
export const MISSING_GIT_PREFIX = '本机服务找不到能用的 git';

export interface GitAttempt {
  command: string;
  reason: string;
}

export interface GitResolution {
  /** 探通了的绝对路径；一个都没探通时为 undefined。 */
  command?: string;
  tried: GitAttempt[];
}

export type GitProbe = (command: string) => Promise<{ ok: boolean; reason: string }>;

/** 候选路径：Windows 上交给系统解析，其余平台一律给绝对路径，不赌 PATH。 */
export function toolCandidates(tool: string, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') return [tool];
  return [...GIT_SEARCH_DIRS.map(dir => `${dir}/${tool}`), tool];
}

/** 候选 git：Windows 上交给系统解析，其余平台一律给绝对路径，不赌 PATH。 */
export function gitCandidates(platform: NodeJS.Platform): string[] {
  return toolCandidates('git', platform);
}

/** 把常见安装目录前置进 PATH。前置而不是追加：登录项自带的 `/usr/bin` 会抢在前面。 */
export function gitSearchPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  const current = env.PATH ?? '';
  if (platform === 'win32') return current;
  return [...new Set([...GIT_SEARCH_DIRS, ...current.split(':').filter(Boolean)])].join(':');
}

export function gitEnvironment(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...env, PATH: gitSearchPath(platform, env) };
}

/** 依次探候选，返回第一个能跑的；全都不行时把每个的失败原因带回来。 */
export async function resolveGit(
  candidates: readonly string[],
  probe: GitProbe,
): Promise<GitResolution> {
  const tried: GitAttempt[] = [];
  for (const command of candidates) {
    const outcome = await probe(command);
    if (outcome.ok) return { command, tried };
    tried.push({ command, reason: outcome.reason });
  }
  return { tried };
}

/**
 * 一个都探不到时的说明。
 *
 * 说的是「服务这边找不到」，不是「你的 git 坏了」——把试过的位置和各自的原因摆出来，
 * 用户拿 `which git` 一比就知道该软链到哪。
 */
export function explainMissingTool(tool: string, tried: readonly GitAttempt[]): string {
  const list = tried.map(item => `${item.command}（${item.reason}）`).join('；');
  return `本机服务找不到能用的 ${tool}。本机服务是以登录项常驻的，拿到的 PATH 比你终端里的窄，`
    + `你终端里那个 ${tool} 未必在它看得见的位置——终端里能用不代表这里能用。`
    + `已经试过：${list || '无候选'}。`
    + `在终端跑 \`which ${tool}\` 看它在哪，软链一份到 /usr/local/bin/${tool}，然后重启本机服务。`;
}

export function explainMissingGit(tried: readonly GitAttempt[]): string {
  return explainMissingTool('git', tried);
}

function probeVersion(env: NodeJS.ProcessEnv): GitProbe {
  return command =>
    new Promise(resolveProbe => {
      execFile(command, ['--version'], { env, timeout: 10_000 }, (error, _stdout, stderr) => {
        if (!error) {
          resolveProbe({ ok: true, reason: '' });
          return;
        }
        const detail =
          (stderr ?? '').trim()
          || (error as NodeJS.ErrnoException).code
          || error.message
          || '无法执行';
        resolveProbe({ ok: false, reason: String(detail).split('\n')[0] ?? '无法执行' });
      });
    });
}

const cached = new Map<string, Promise<GitResolution>>();

/** 解析一次并缓存：服务是常驻的，没必要每条内容都探一遍。 */
export function resolveToolOnce(tool: string): Promise<GitResolution> {
  let pending = cached.get(tool);
  if (!pending) {
    pending = resolveGit(toolCandidates(tool, process.platform), probeVersion(gitEnvironment()));
    cached.set(tool, pending);
  }
  return pending;
}

export function resolveGitOnce(): Promise<GitResolution> {
  return resolveToolOnce('git');
}

/** 仅供测试：清掉缓存的解析结果。 */
export function resetGitResolution(): void {
  cached.clear();
}

export interface GitRunResult {
  code: number;
  stderr: string;
  /** 标准输出。`git commit` 的「nothing to commit」走的是这里，不是 stderr。 */
  stdout?: string;
}

/** 在仓库里跑一条 git 命令。用探好的绝对路径，并带上补齐过的 PATH。 */
export async function runGit(repoPath: string, args: string[]): Promise<GitRunResult> {
  const { command, tried } = await resolveGitOnce();
  // 探不到就直说，别让 execFile 甩一个 ENOENT 或 xcrun 的英文报错出去。
  if (!command) return { code: 127, stderr: explainMissingGit(tried) };
  return new Promise(resolveRun => {
    execFile(
      command,
      ['-C', repoPath, ...args],
      { env: gitEnvironment(), timeout: 30_000 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        resolveRun({ code, stderr: stderr ?? '', stdout: stdout ?? '' });
      },
    );
  });
}

export interface ToolCommand {
  command: string;
  args: string[];
}

export interface ToolProcessOptions {
  timeoutMs?: number;
  maxBufferBytes?: number;
  killGraceMs?: number;
  platform?: NodeJS.Platform;
}

class ToolProcessError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'ToolProcessError';
  }
}

function signalProcessTree(
  pid: number,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform,
): void {
  try {
    if (platform === 'win32') {
      const args = ['/pid', String(pid), '/T'];
      if (signal === 'SIGKILL') args.push('/F');
      const killer = spawn('taskkill', args, { detached: false, stdio: 'ignore', windowsHide: true });
      killer.unref();
      return;
    }
    // detached=true 让外部命令成为独立进程组。向负 PID 发信号会覆盖 npm -> sh -> tsc
    // 整棵树，避免 execFile 只杀 npm、把真正构建的孙进程遗留在后台。
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/**
 * 在独立进程组里运行自更新命令。超时或输出失控时会先 TERM、再 KILL 整棵进程树。
 * 导出是为了用真实子进程做资源回收回归测试；业务入口仍是 runTool。
 */
export function runProcessForTool(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: ToolProcessOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const maxBufferBytes = options.maxBufferBytes ?? 8 * 1024 * 1024;
  const killGraceMs = options.killGraceMs ?? 2_000;
  const platform = options.platform ?? process.platform;

  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], {
      cwd,
      env,
      detached: platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let terminalError: Error | undefined;
    let forceTimer: NodeJS.Timeout | undefined;

    const output = (chunks: Buffer[]) => Buffer.concat(chunks).toString('utf8');
    const stopTree = (error: Error) => {
      if (terminalError) return;
      terminalError = error;
      if (child.pid === undefined) return;
      signalProcessTree(child.pid, 'SIGTERM', platform);
      forceTimer = setTimeout(() => {
        if (child.pid !== undefined) signalProcessTree(child.pid, 'SIGKILL', platform);
      }, killGraceMs);
      forceTimer.unref();
    };
    const append = (target: Buffer[], chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > maxBufferBytes) {
        stopTree(new Error(`命令输出超过 ${maxBufferBytes} 字节上限`));
        return;
      }
      target.push(buffer);
    };

    child.stdout.on('data', chunk => append(stdout, chunk));
    child.stderr.on('data', chunk => append(stderr, chunk));

    const timeout = setTimeout(
      () => stopTree(new Error(`命令执行超时（${timeoutMs}ms）`)),
      timeoutMs,
    );
    child.once('error', error => {
      terminalError = terminalError ?? error;
    });
    child.once('close', code => {
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      const stdoutText = output(stdout);
      const stderrText = output(stderr);
      if (terminalError) {
        rejectRun(new ToolProcessError(terminalError.message, stdoutText, stderrText));
        return;
      }
      if (code !== 0) {
        rejectRun(new ToolProcessError(`进程退出码 ${code ?? '未知'}`, stdoutText, stderrText));
        return;
      }
      resolveRun(stdoutText);
    });
  });
}

/**
 * npm 藏在哪。
 *
 * 它比 git 飘得多：nvm / fnm / Volta 把它装在版本目录里，不在任何固定路径上，
 * 按目录挨个探根本探不着。但**我们自己就是被 node 跑起来的**——顺着
 * `process.execPath` 找同一套安装里的 `npm-cli.js`，比猜目录可靠得多，
 * 而且用的必然是同一个 node。找不到再退回按目录探一个 npm 出来。
 */
export function npmCliCandidates(execPath: string): string[] {
  const dir = dirname(execPath);
  return [
    // POSIX 前缀布局：<prefix>/bin/node 与 <prefix>/lib/node_modules/npm
    join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // Windows 安装布局：node.exe 与 node_modules 同级
    join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
}

export async function resolveNpm(
  execPath: string = process.execPath,
  exists: (path: string) => boolean = existsSync,
): Promise<ToolCommand> {
  const cli = npmCliCandidates(execPath).find(exists);
  if (cli) return { command: execPath, args: [cli] };
  const { command, tried } = await resolveToolOnce('npm');
  if (!command) throw new Error(explainMissingTool('npm', tried));
  return { command, args: [] };
}

async function resolveNamed(tool: string): Promise<ToolCommand> {
  const { command, tried } = await resolveToolOnce(tool);
  if (!command) throw new Error(explainMissingTool(tool, tried));
  return { command, args: [] };
}

/**
 * 跑一条外部命令（自更新在用）。和 `runGit` 同一个道理：解析到绝对路径 + 补齐 PATH。
 *
 * 之前这里是裸 `execFile('git' | 'npm', …)`，继承的正是登录项那份窄 PATH——
 * 自更新于是在用户机器上一声不响地失败，只往服务日志里写一行 warn，
 * 界面上永远显示不出「有新版」。
 */
export async function runTool(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<string> {
  const resolved = command === 'npm' ? await resolveNpm() : await resolveNamed(command);
  try {
    return await runProcessForTool(
      resolved.command,
      [...resolved.args, ...args],
      cwd,
      gitEnvironment(),
    );
  } catch (error) {
    const processError = error instanceof ToolProcessError ? error : undefined;
    // 构建失败时有用的那行经常在 stdout（tsc / vitest 都往那儿写），别只看 stderr。
    const detail = ((processError?.stderr ?? '').trim() || (processError?.stdout ?? '').trim())
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .pop();
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${command} ${args.join(' ')} 失败：${reason}${detail ? `；${detail}` : ''}`,
    );
  }
}
