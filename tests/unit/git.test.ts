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
});
