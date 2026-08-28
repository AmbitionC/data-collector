/**
 * 开机自启：让本机服务常驻，用户装一次之后再也不用手动 `bridge start`。
 *
 * 浏览器扩展无法启动本机进程（MV3 没有这个能力），所以「打开插件就自动可用」
 * 只能靠系统的登录项：登录时拉起，进程挂了自动重启。
 */

import { SERVICE_PATH } from './git.js';
import { dirname } from 'node:path';

export const AUTOSTART_LABEL = 'com.data-collector.bridge';

export interface AutostartPlan {
  /** 登录项文件的绝对路径。 */
  file: string;
  contents: string;
  /** 安装后需要执行的命令（依次执行；allowFailure 的失败可忽略）。 */
  commands: { command: string; args: string[]; allowFailure?: boolean }[];
  /** 卸载时执行的命令。 */
  uninstallCommands: { command: string; args: string[]; allowFailure?: boolean }[];
}

export class UnsupportedPlatformError extends Error {
  constructor(platform: string) {
    super(
      `暂不支持在 ${platform} 上自动安装登录项。请手动让这条命令开机运行：\n`
        + '  npm run collector -- bridge start',
    );
    this.name = 'UnsupportedPlatformError';
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * 后台服务必须优先使用启动它的那套 Node 工具链。
 *
 * launchd 的窄 PATH 可能先命中多年未升级的 /usr/local/bin/npm；若 Bridge 本身由
 * nvm 的新 Node 启动，自更新却调用旧 npm，旧 npm 会忽略 workspace 参数并递归执行
 * 根 build 脚本。把 nodePath 的目录放在最前，node / npm / npx 始终来自同一版本。
 */
function servicePathForNode(nodePath: string): string {
  return [...new Set([dirname(nodePath), ...SERVICE_PATH.split(':')])].join(':');
}

function macPlan(input: {
  home: string;
  nodePath: string;
  cliPath: string;
  logFile: string;
}): AutostartPlan {
  const file = `${input.home}/Library/LaunchAgents/${AUTOSTART_LABEL}.plist`;
  const programArguments = [input.nodePath, input.cliPath, 'bridge', 'start']
    .map(value => `      <string>${escapeXml(value)}</string>`)
    .join('\n');
  const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${AUTOSTART_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${programArguments}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${escapeXml(servicePathForNode(input.nodePath))}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(input.logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(input.logFile)}</string>
  </dict>
</plist>
`;
  return {
    file,
    contents,
    commands: [
      // 覆盖安装时先卸掉旧的；没装过会报错，忽略即可。
      { command: 'launchctl', args: ['unload', file], allowFailure: true },
      { command: 'launchctl', args: ['load', '-w', file] },
    ],
    uninstallCommands: [{ command: 'launchctl', args: ['unload', '-w', file], allowFailure: true }],
  };
}

function linuxPlan(input: {
  home: string;
  nodePath: string;
  cliPath: string;
  logFile: string;
}): AutostartPlan {
  const file = `${input.home}/.config/systemd/user/data-collector-bridge.service`;
  const contents = `[Unit]
Description=Data Collector Bridge

[Service]
Environment=PATH=${servicePathForNode(input.nodePath)}
ExecStart=${input.nodePath} ${input.cliPath} bridge start
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
  return {
    file,
    contents,
    commands: [
      { command: 'systemctl', args: ['--user', 'daemon-reload'] },
      { command: 'systemctl', args: ['--user', 'enable', '--now', 'data-collector-bridge.service'] },
    ],
    uninstallCommands: [
      {
        command: 'systemctl',
        args: ['--user', 'disable', '--now', 'data-collector-bridge.service'],
        allowFailure: true,
      },
    ],
  };
}

function windowsPlan(input: {
  appData: string;
  nodePath: string;
  cliPath: string;
}): AutostartPlan {
  const file = `${input.appData}\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\data-collector-bridge.vbs`;
  // WScript.Shell 的第二个参数 0 表示隐藏窗口：登录后静默常驻，不弹黑框。
  const quote = (value: string) => `""${value.replaceAll('"', '')}""`;
  const contents = `Set shell = CreateObject("WScript.Shell")\r
shell.Run "${quote(input.nodePath)} ${quote(input.cliPath)} bridge start", 0, False\r
`;
  return {
    file,
    contents,
    commands: [{ command: 'wscript.exe', args: [file] }],
    uninstallCommands: [],
  };
}

/** 按平台给出登录项的安装方案；不支持的平台抛 UnsupportedPlatformError。 */
export function autostartPlan(input: {
  platform: NodeJS.Platform;
  home: string;
  nodePath: string;
  cliPath: string;
  logFile: string;
  appData?: string;
}): AutostartPlan {
  if (input.platform === 'darwin') return macPlan(input);
  if (input.platform === 'linux') return linuxPlan(input);
  if (input.platform === 'win32') {
    return windowsPlan({
      appData: input.appData ?? `${input.home}\\AppData\\Roaming`,
      nodePath: input.nodePath,
      cliPath: input.cliPath,
    });
  }
  throw new UnsupportedPlatformError(input.platform);
}
