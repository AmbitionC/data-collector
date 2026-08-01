import { execFile } from 'node:child_process';

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

/** 候选 git：Windows 上交给系统解析，其余平台一律给绝对路径，不赌 PATH。 */
export function gitCandidates(platform: NodeJS.Platform): string[] {
  if (platform === 'win32') return ['git'];
  return [...GIT_SEARCH_DIRS.map(dir => `${dir}/git`), 'git'];
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
export function explainMissingGit(tried: readonly GitAttempt[]): string {
  const list = tried.map(item => `${item.command}（${item.reason}）`).join('；');
  return `${MISSING_GIT_PREFIX}。本机服务是以登录项常驻的，拿到的 PATH 比你终端里的窄，`
    + '你终端里那个 git 未必在它看得见的位置——终端里能用不代表这里能用。'
    + `已经试过：${list || '无候选'}。`
    + '在终端跑 `which git` 看它在哪，软链一份到 /usr/local/bin/git，然后重启本机服务。';
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

let cached: Promise<GitResolution> | undefined;

/** 解析一次并缓存：服务是常驻的，没必要每条内容都探一遍。 */
export function resolveGitOnce(): Promise<GitResolution> {
  cached ??= resolveGit(gitCandidates(process.platform), probeVersion(gitEnvironment()));
  return cached;
}

/** 仅供测试：清掉缓存的解析结果。 */
export function resetGitResolution(): void {
  cached = undefined;
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
