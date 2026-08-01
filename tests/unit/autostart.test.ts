import { describe, expect, it } from 'vitest';
import {
  AUTOSTART_LABEL,
  UnsupportedPlatformError,
  autostartPlan,
} from '../../packages/bridge/src/autostart.js';
import {
  installAutostart,
  uninstallAutostart,
  type AutostartHost,
  type CliIo,
} from '../../packages/bridge/src/cli.js';

const BASE = {
  home: '/Users/chenhao',
  nodePath: '/usr/local/bin/node',
  cliPath: '/Users/chenhao/code/data-collector/packages/bridge/dist/cli.js',
  logFile: '/Users/chenhao/.data-collector/bridge.log',
};

function recorder() {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { stdout: value => out.push(value), stderr: value => err.push(value) };
  return { io, out, err };
}

function host(overrides: Partial<AutostartHost> = {}): AutostartHost & {
  written: { path: string; contents: string }[];
  ran: string[];
  removed: string[];
} {
  const written: { path: string; contents: string }[] = [];
  const ran: string[] = [];
  const removed: string[] = [];
  return {
    platform: 'darwin',
    home: BASE.home,
    nodePath: BASE.nodePath,
    cliPath: BASE.cliPath,
    written,
    ran,
    removed,
    writeFile: async (path, contents) => { written.push({ path, contents }); },
    mkdir: async () => undefined,
    remove: async path => { removed.push(path); },
    run: async (command, args) => { ran.push(`${command} ${args.join(' ')}`); },
    probe: async () => true,
    ...overrides,
  };
}

describe('autostart plan', () => {
  it('builds a macOS LaunchAgent that runs at login and restarts on exit', () => {
    const plan = autostartPlan({ platform: 'darwin', ...BASE });

    expect(plan.file).toBe(`/Users/chenhao/Library/LaunchAgents/${AUTOSTART_LABEL}.plist`);
    expect(plan.contents).toContain('<string>/usr/local/bin/node</string>');
    expect(plan.contents).toContain('<string>bridge</string>');
    expect(plan.contents).toContain('<string>start</string>');
    // 登录即拉起、挂了自动重启——这是「不用再手动启动」的全部依据。
    expect(plan.contents).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plan.contents).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plan.contents).toContain(BASE.logFile);
    expect(plan.commands.map(step => `${step.command} ${step.args[0]}`))
      .toEqual(['launchctl unload', 'launchctl load']);
    // 覆盖安装时旧的可能没装过，unload 失败要能忽略。
    expect(plan.commands[0]?.allowFailure).toBe(true);
  });

  it('builds a systemd user service on Linux', () => {
    const plan = autostartPlan({ platform: 'linux', ...BASE });

    expect(plan.file).toBe('/Users/chenhao/.config/systemd/user/data-collector-bridge.service');
    expect(plan.contents).toContain(`ExecStart=${BASE.nodePath} ${BASE.cliPath} bridge start`);
    expect(plan.contents).toContain('Restart=always');
    expect(plan.contents).toContain('WantedBy=default.target');
    expect(plan.commands.at(-1)?.args).toContain('--now');
  });

  it('escapes paths so a quoted or angled directory name cannot break the plist', () => {
    const plan = autostartPlan({ platform: 'darwin', ...BASE, cliPath: '/tmp/a&b<c>/cli.js' });

    expect(plan.contents).toContain('/tmp/a&amp;b&lt;c&gt;/cli.js');
    expect(plan.contents).not.toContain('a&b<c>');
  });

  it('builds a hidden Startup-folder launcher on Windows', () => {
    const plan = autostartPlan({
      platform: 'win32',
      ...BASE,
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      appData: 'C:\\Users\\chenhao\\AppData\\Roaming',
    });

    expect(plan.file).toContain('Startup\\data-collector-bridge.vbs');
    expect(plan.contents).toContain('bridge start');
    // 第二个参数 0 = 隐藏窗口，登录后静默常驻而不是弹一个黑框。
    expect(plan.contents).toContain(', 0, False');
    expect(plan.commands[0]?.command).toBe('wscript.exe');
  });

  it('refuses genuinely unsupported platforms with a manual fallback', () => {
    expect(() => autostartPlan({ platform: 'aix', ...BASE }))
      .toThrowError(UnsupportedPlatformError);
    expect(() => autostartPlan({ platform: 'aix', ...BASE }))
      .toThrowError(/bridge start/);
  });
});

describe('bridge install', () => {
  it('writes the login item, loads it, and only reports success once health answers', async () => {
    const { io, out } = recorder();
    const target = host();

    const code = await installAutostart([], io, target);

    expect(code).toBe(0);
    expect(target.written[0]?.path).toContain('LaunchAgents');
    expect(target.ran).toEqual([
      `launchctl unload ${target.written[0]?.path}`,
      `launchctl load -w ${target.written[0]?.path}`,
    ]);
    expect(out.join('')).toContain('开机自动运行');
    expect(out.join('')).toContain('不需要再手动启动');
  });

  it('does not claim success when the service never answers', async () => {
    const { io, err } = recorder();
    // 装上了但起不来（端口占用、构建产物缺失等）——必须说实话并指向日志。
    const target = host({ probe: async () => false });

    const code = await installAutostart([], io, target);

    expect(code).toBe(1);
    expect(err.join('')).toContain('没有在预期时间内就绪');
    expect(err.join('')).toContain('bridge.log');
  }, 20_000);

  it('explains a real load failure and the manual fallback instead of pretending it installed', async () => {
    const { io, err } = recorder();
    // 容器 / WSL / 无桌面会话上很常见：系统没有可用的登录项机制。
    const target = host({
      run: async () => { throw new Error('Failed to connect to bus: No medium found'); },
    });

    const code = await installAutostart([], io, target);

    expect(code).toBe(1);
    const text = err.join('');
    expect(text).toContain('无法把本机服务装成登录项');
    expect(text).toContain('No medium found');
    // 必须给出这台机器上仍然可用的办法。
    expect(text).toContain('npm run collector -- bridge start');
  });

  it('installs on Windows through the Startup folder', async () => {
    const { io, out } = recorder();
    const target = host({ platform: 'win32', appData: 'C:\\Users\\chenhao\\AppData\\Roaming' });

    const code = await installAutostart([], io, target);

    expect(code).toBe(0);
    expect(target.written[0]?.path).toContain('Startup');
    expect(target.ran[0]).toContain('wscript.exe');
    expect(out.join('')).toContain('开机自动运行');
  });

  it('tells a genuinely unsupported platform what to do rather than failing obscurely', async () => {
    const { io, err } = recorder();

    const code = await installAutostart([], io, host({ platform: 'aix' }));

    expect(code).toBe(1);
    expect(err.join('')).toContain('bridge start');
  });

  it('uninstall unloads and removes the login item, tolerating a missing one', async () => {
    const { io, out } = recorder();
    const target = host({
      run: async () => { throw new Error('Could not find specified service'); },
    });

    const code = await uninstallAutostart([], io, target);

    expect(code).toBe(0);
    expect(target.removed[0]).toContain(`${AUTOSTART_LABEL}.plist`);
    expect(out.join('')).toContain('已取消开机自动运行');
  });
});

describe('登录项要带一份够用的 PATH', () => {
  // launchd / systemd 默认只给 /usr/bin:/bin:/usr/sbin:/sbin，看不见 Homebrew，
  // 服务里 git 就只剩 macOS 那层需要 xcrun 的壳——用户点同步 16 条全失败过一次。
  it('macOS 的 plist 里写死 EnvironmentVariables，Homebrew 排在系统目录前', () => {
    const plan = autostartPlan({ platform: 'darwin', ...BASE });
    expect(plan.contents).toContain('<key>EnvironmentVariables</key>');
    const path = /<key>PATH<\/key>\s*<string>([^<]+)<\/string>/.exec(plan.contents)?.[1] ?? '';
    expect(path.split(':').indexOf('/opt/homebrew/bin')).toBeGreaterThanOrEqual(0);
    expect(path.split(':').indexOf('/opt/homebrew/bin')).toBeLessThan(path.split(':').indexOf('/usr/bin'));
  });

  it('systemd 的 service 里同样带上 PATH', () => {
    const plan = autostartPlan({ platform: 'linux', ...BASE });
    expect(plan.contents).toMatch(/^Environment=PATH=.*\/opt\/homebrew\/bin/m);
  });
});
