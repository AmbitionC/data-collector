import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import {
  MISSING_GIT_PREFIX,
  explainMissingGit,
  explainMissingTool,
  gitCandidates,
  gitSearchPath,
  npmCliCandidates,
  resolveGit,
  resolveNpm,
  runProcessForTool,
  terminateActiveToolProcesses,
  toolCandidates,
  type GitProbe,
} from '../../packages/bridge/src/git.js';
import { explainGitFailure } from '../../packages/bridge/src/sinks/repoInboxSink.js';

/**
 * 这一组全是同一个真实故障的回归：用户点同步，16 条全失败，报错是
 * `xcrun: error: invalid active developer path`，而用户终端里的 git 完全正常。
 * 原因是本机服务以登录项常驻，拿到的 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，
 * 裸 `git` 解析到了 macOS 那层需要 xcrun 的壳；用户平时用的是 /opt/homebrew/bin/git。
 */

/** launchd 给登录项的 PATH 就这么窄——bug 的起点。 */
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

const XCRUN_ERROR =
  'xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools)';

/** 只有 Homebrew 那份能跑，系统壳报 xcrun——用户机器的真实状态。 */
function probeWithOnlyHomebrew(seen: string[]): GitProbe {
  return async command => {
    seen.push(command);
    if (command === '/opt/homebrew/bin/git') return { ok: true, reason: '' };
    if (command.startsWith('/usr/bin') || command === 'git') {
      return { ok: false, reason: XCRUN_ERROR };
    }
    return { ok: false, reason: 'ENOENT' };
  };
}

describe('候选 git 的顺序', () => {
  it('把用户自己装的排在系统壳前面', () => {
    const candidates = gitCandidates('darwin');
    expect(candidates.indexOf('/opt/homebrew/bin/git')).toBeLessThan(
      candidates.indexOf('/usr/bin/git'),
    );
    expect(candidates.indexOf('/usr/local/bin/git')).toBeLessThan(
      candidates.indexOf('/usr/bin/git'),
    );
  });

  it('给的是绝对路径而不是裸 git——窄 PATH 下裸名字正是踩坑的原因', () => {
    expect(gitCandidates('darwin').filter(item => item === 'git')).toHaveLength(1);
    expect(gitCandidates('darwin')[0]).toMatch(/^\//);
  });
});

describe('补齐 PATH', () => {
  it('把常见安装目录前置进登录项那份窄 PATH', () => {
    const merged = gitSearchPath('darwin', { PATH: LAUNCHD_PATH }).split(':');
    expect(merged.indexOf('/opt/homebrew/bin')).toBeLessThan(merged.indexOf('/usr/bin'));
    // 原有目录一个都不能丢：git push 还要靠它们找 ssh。
    expect(merged).toContain('/usr/sbin');
    expect(merged).toContain('/sbin');
  });

  it('不重复已有目录', () => {
    const merged = gitSearchPath('darwin', { PATH: '/usr/bin:/opt/homebrew/bin' }).split(':');
    expect(merged.filter(item => item === '/opt/homebrew/bin')).toHaveLength(1);
  });

  it('始终把当前 Node 的 bin 放在最前，npm 子脚本不会切回系统旧 node', () => {
    const merged = gitSearchPath(
      'darwin',
      { PATH: '/usr/local/bin:/usr/bin:/bin' },
      '/Users/me/.nvm/versions/node/v22.3.0/bin/node',
    ).split(':');
    expect(merged[0]).toBe('/Users/me/.nvm/versions/node/v22.3.0/bin');
    expect(merged.indexOf('/opt/homebrew/bin')).toBeLessThan(merged.indexOf('/usr/bin'));
  });
});

describe('解析出一个真能跑的 git', () => {
  it('跳过报 xcrun 的系统壳，选中 Homebrew 那份', async () => {
    const seen: string[] = [];
    const resolution = await resolveGit(gitCandidates('darwin'), probeWithOnlyHomebrew(seen));
    expect(resolution.command).toBe('/opt/homebrew/bin/git');
  });

  it('一个都跑不了时不瞎猜，把试过哪些、各自为什么带回来', async () => {
    const resolution = await resolveGit(['/opt/homebrew/bin/git', '/usr/bin/git'], async command => ({
      ok: false,
      reason: command === '/usr/bin/git' ? XCRUN_ERROR : 'ENOENT',
    }));
    expect(resolution.command).toBeUndefined();
    expect(resolution.tried.map(item => item.command)).toEqual([
      '/opt/homebrew/bin/git',
      '/usr/bin/git',
    ]);
  });
});

describe('找不到 git 时怎么说', () => {
  const message = explainMissingGit([
    { command: '/opt/homebrew/bin/git', reason: 'ENOENT' },
    { command: '/usr/bin/git', reason: XCRUN_ERROR },
  ]);

  it('说的是本机服务找不到，不是用户的 git 坏了', () => {
    expect(message).toContain(MISSING_GIT_PREFIX);
    expect(message).toMatch(/终端里能用不代表这里能用/);
    expect(message).not.toMatch(/xcode-select|命令行工具坏了|没装/);
  });

  it('列出试过的位置，用户拿 which git 一比就知道该软链到哪', () => {
    expect(message).toContain('/opt/homebrew/bin/git');
    expect(message).toContain('/usr/bin/git');
    expect(message).toContain('which git');
  });
});

describe('把 git 报错翻给用户看', () => {
  it('看到 xcrun 不再说「你这台 Mac 坏了」，而是指向服务的环境', () => {
    const message = explainGitFailure('git add', XCRUN_ERROR);
    // 这两句是当初真的写出去过的错误结论，绝不能再出现。
    expect(message).not.toMatch(/xcode-select --install/);
    expect(message).not.toMatch(/命令行工具坏了|命令行工具.*没装/);
    expect(message).toMatch(/本机服务/);
    expect(message).toMatch(/你终端里的 git 是好的/);
  });

  it('我们自己写好的「找不到 git」说明原样透出，不被 xcrun 分支盖掉', () => {
    // 这条说明里就带着 /usr/bin/git 的 xcrun 原文，顺序写反就会被吞掉、丢掉试过的清单。
    const detail = explainMissingGit([{ command: '/usr/bin/git', reason: XCRUN_ERROR }]);
    const message = explainGitFailure('git add', detail);
    expect(message).toContain(MISSING_GIT_PREFIX);
    expect(message).toContain('which git');
  });

  it('认不出来的报错原样带上，不吞', () => {
    expect(explainGitFailure('git push', 'fatal: 某种没见过的错')).toContain('某种没见过的错');
  });
});

/**
 * 自更新（拉代码 + 重新构建）跑在同一个窄 PATH 里，踩的是同一个坑：
 * 裸 `git` / 裸 `npm` 在登录项里解析不到，自更新于是一声不响地不工作，
 * 只往服务日志写一行 warn，插件那边永远等不到「有新版」。
 */
describe('自更新要用的外部命令', () => {
  it('npm 也按绝对路径探，不赌 PATH', () => {
    const candidates = toolCandidates('npm', 'darwin');
    expect(candidates[0]).toBe('/opt/homebrew/bin/npm');
    expect(candidates.indexOf('/opt/homebrew/bin/npm')).toBeLessThan(
      candidates.indexOf('/usr/bin/npm'),
    );
  });

  it('优先顺着跑着我们的那个 node 去找 npm', async () => {
    // nvm / fnm / Volta 把 npm 装在版本目录里，任何固定目录都探不着；
    // 但我们自己就是被那个 node 跑起来的，顺着它找必然对得上。
    const resolved = await resolveNpm('/Users/me/.nvm/versions/node/v22.3.0/bin/node', path =>
      path.endsWith('npm-cli.js'),
    );
    expect(resolved.command).toBe('/Users/me/.nvm/versions/node/v22.3.0/bin/node');
    expect(resolved.args[0]).toContain('npm-cli.js');
    expect(resolved.args[0]).toContain('/Users/me/.nvm/versions/node/v22.3.0/');
  });

  it('两种安装布局都试', () => {
    const candidates = npmCliCandidates('/usr/local/bin/node');
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toContain('lib/node_modules/npm');
  });

  it('找不到 npm 时也说的是「服务这边找不到」，不是「你没装 npm」', () => {
    const message = explainMissingTool('npm', [{ command: '/usr/bin/npm', reason: 'ENOENT' }]);
    expect(message).toContain('本机服务找不到能用的 npm');
    expect(message).toContain('which npm');
    expect(message).not.toMatch(/没装|你的机器/);
  });

  it('超时会终止命令的整棵子进程树，不留下后台构建进程', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'data-collector-process-tree-'));
    const childPidPath = join(directory, 'child.pid');
    const script = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);`,
      `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
      'setInterval(() => {}, 1000);',
    ].join('\n');

    try {
      await expect(runProcessForTool(
        process.execPath,
        ['-e', script],
        directory,
        process.env,
        // 全量 Vitest 会并发启动多个 worker；留足 Node 子进程完成冷启动并写出 PID。
        { timeoutMs: 2_000, killGraceMs: 200 },
      )).rejects.toThrow(/超时/);

      const childPid = Number(await readFile(childPidPath, 'utf8'));
      expect(Number.isInteger(childPid)).toBe(true);
      let gone = false;
      for (let attempt = 0; attempt < 50 && !gone; attempt += 1) {
        try {
          process.kill(childPid, 0);
          await delay(10);
        } catch {
          gone = true;
        }
      }
      expect(gone).toBe(true);
    } finally {
      terminateActiveToolProcesses('SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('Bridge 关闭时会终止仍在运行的更新进程树', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'data-collector-shutdown-tree-'));
    const childPidPath = join(directory, 'child.pid');
    const script = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);`,
      `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
      'setInterval(() => {}, 1000);',
    ].join('\n');

    try {
      const running = runProcessForTool(
        process.execPath,
        ['-e', script],
        directory,
        process.env,
        { timeoutMs: 5_000, killGraceMs: 100 },
      );
      const outcome = running.then(
        () => undefined,
        error => error,
      );
      let childPid = 0;
      for (let attempt = 0; attempt < 50 && childPid === 0; attempt += 1) {
        try {
          childPid = Number(await readFile(childPidPath, 'utf8'));
        } catch {
          await delay(10);
        }
      }
      expect(Number.isInteger(childPid) && childPid > 0).toBe(true);

      terminateActiveToolProcesses();
      expect(await outcome).toBeInstanceOf(Error);
      let gone = false;
      for (let attempt = 0; attempt < 50 && !gone; attempt += 1) {
        try {
          process.kill(childPid, 0);
          await delay(10);
        } catch {
          gone = true;
        }
      }
      expect(gone).toBe(true);
    } finally {
      terminateActiveToolProcesses();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('超时后会强制清理忽略 TERM 的子进程树', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'data-collector-force-kill-tree-'));
    const childPidPath = join(directory, 'child.pid');
    const script = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const childCode = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`;",
      "const child = spawn(process.execPath, ['-e', childCode]);",
      `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
      "process.on('SIGTERM', () => {});",
      'setInterval(() => {}, 1000);',
    ].join('\n');

    try {
      await expect(runProcessForTool(
        process.execPath,
        ['-e', script],
        directory,
        process.env,
        { timeoutMs: 2_000, killGraceMs: 100 },
      )).rejects.toThrow(/超时/);
      const childPid = Number(await readFile(childPidPath, 'utf8'));
      let gone = false;
      for (let attempt = 0; attempt < 50 && !gone; attempt += 1) {
        try {
          process.kill(childPid, 0);
          await delay(10);
        } catch {
          gone = true;
        }
      }
      expect(gone).toBe(true);
    } finally {
      terminateActiveToolProcesses('SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('进程组已 ESRCH 时视为幂等清理成功，不回退杀直接子进程也不添加诊断', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'data-collector-esrch-cleanup-'));
    const markerPath = join(directory, 'natural-exit.txt');
    const goneError = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    const script = [
      "const { writeFileSync } = require('node:fs');",
      `setTimeout(() => writeFileSync(${JSON.stringify(markerPath)}, 'natural'), 100);`,
    ].join('\n');

    try {
      const error = await runProcessForTool(
        process.execPath,
        ['-e', script],
        directory,
        process.env,
        {
          timeoutMs: 30,
          killGraceMs: 500,
          signalTree: () => {
            throw goneError;
          },
        },
      ).then(
        () => undefined,
        reason => reason as Error,
      );

      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toBe('命令执行超时（30ms）');
      expect(await readFile(markerPath, 'utf8')).toBe('natural');
    } finally {
      terminateActiveToolProcesses('SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['EINVAL', Object.assign(new Error('invalid group signal'), { code: 'EINVAL' }), 'EINVAL'],
    ['未知异常', new Error('unexpected group kill'), 'unexpected group kill'],
  ] as const)(
    '进程组信号返回%s时不从 timer 抛出，并随 ToolProcessError 暴露原异常',
    async (_label, signalError, expectedDetail) => {
      const script = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";

      const error = await runProcessForTool(
        process.execPath,
        ['-e', script],
        tmpdir(),
        process.env,
        {
          timeoutMs: 500,
          killGraceMs: 50,
          signalTree: () => {
            throw signalError;
          },
        },
      ).then(
        () => undefined,
        reason => reason as Error,
      );

      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toMatch(/^命令执行超时（500ms）/);
      expect(error?.message).toContain(expectedDetail);
      expect(error?.message).toMatch(/进程组信号/);
    },
  );

  it.each([
    [
      '抛出异常',
      () => {
        throw Object.assign(new Error('direct child kill failed'), { code: 'EIO' });
      },
      'EIO',
    ],
    ['返回 false', () => false, '返回 false'],
  ] as const)(
    '直接子进程 fallback %s 时不从 timer 抛出，并随 ToolProcessError 暴露失败',
    async (_label, signalChild, expectedDetail) => {
      const directSignals: NodeJS.Signals[] = [];
      const permissionError = Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      const script = 'setTimeout(() => {}, 150);';

      const error = await runProcessForTool(
        process.execPath,
        ['-e', script],
        tmpdir(),
        process.env,
        {
          timeoutMs: 30,
          killGraceMs: 20,
          signalTree: () => {
            throw permissionError;
          },
          signalChild: signal => {
            directSignals.push(signal);
            return signalChild();
          },
        },
      ).then(
        () => undefined,
        reason => reason as Error,
      );

      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toMatch(/^命令执行超时（30ms）/);
      expect(error?.message).toContain(expectedDetail);
      expect(error?.message).toMatch(/直接子进程/);
      expect(directSignals).toEqual(['SIGTERM', 'SIGKILL']);
    },
  );

  it('直接子进程 fallback 返回 ESRCH 时视为幂等成功，不追加 fallback 失败噪声', async () => {
    const directSignals: NodeJS.Signals[] = [];
    const permissionError = Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    const goneError = Object.assign(new Error('direct ESRCH'), { code: 'ESRCH' });
    const script = 'setTimeout(() => {}, 150);';

    const error = await runProcessForTool(
      process.execPath,
      ['-e', script],
      tmpdir(),
      process.env,
      {
        timeoutMs: 30,
        killGraceMs: 20,
        signalTree: () => {
          throw permissionError;
        },
        signalChild: signal => {
          directSignals.push(signal);
          throw goneError;
        },
      },
    ).then(
      () => undefined,
      reason => reason as Error,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/^命令执行超时（30ms）/);
    expect(error?.message).toContain('EPERM');
    expect(error?.message).not.toContain('ESRCH');
    expect(directSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it.each(['EPERM', 'EACCES'] as const)(
    '进程组信号返回 %s 时回退终止直接子进程，并在超时主原因后记录降级诊断',
    async code => {
      const signals: NodeJS.Signals[] = [];
      const permissionError = Object.assign(new Error(`kill ${code}`), { code });
      const script = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";

      const running = runProcessForTool(
        process.execPath,
        ['-e', script],
        tmpdir(),
        process.env,
        {
          timeoutMs: 500,
          killGraceMs: 50,
          signalTree: (_pid, signal) => {
            signals.push(signal);
            throw permissionError;
          },
        },
      );

      const error = await running.then(
        () => undefined,
        reason => reason as Error,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toMatch(/^命令执行超时（500ms）/);
      expect(error?.message).toContain(code);
      expect(error?.message).toMatch(/降级.*直接子进程/);
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    },
  );

  it('权限降级诊断不覆盖输出上限主原因', async () => {
    const permissionError = Object.assign(new Error('kill EACCES'), { code: 'EACCES' });
    const script = [
      "process.on('SIGTERM', () => {});",
      "process.stdout.write('too much output');",
      'setInterval(() => {}, 1000);',
    ].join('\n');

    const error = await runProcessForTool(
      process.execPath,
      ['-e', script],
      tmpdir(),
      process.env,
      {
        timeoutMs: 2_000,
        maxBufferBytes: 1,
        killGraceMs: 50,
        signalTree: () => {
          throw permissionError;
        },
      },
    ).then(
      () => undefined,
      reason => reason as Error,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/^命令输出超过 1 字节上限/);
    expect(error?.message).toContain('EACCES');
    expect(error?.message).toMatch(/降级.*直接子进程/);
  });
});
