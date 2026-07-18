import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface BridgeConfig {
  host: '127.0.0.1';
  port: number;
  libraryRoot: string;
  configDir: string;
  authFile: string;
  jobsFile: string;
}

export interface ConfigOverrides {
  host?: string;
  port?: number;
  libraryRoot?: string;
  configDir?: string;
}

function expandPath(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return isAbsolute(value) ? value : resolve(value);
}

function envPort(): number | undefined {
  const value = process.env.DATA_COLLECTOR_PORT;
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

export function loadConfig(overrides: ConfigOverrides = {}): BridgeConfig {
  const host = overrides.host ?? '127.0.0.1';
  if (host !== '127.0.0.1') {
    throw new Error('Data Collector 只允许监听 127.0.0.1');
  }
  const port = overrides.port ?? envPort() ?? 17321;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('端口必须是 0 到 65535 之间的整数');
  }
  const libraryRoot = expandPath(
    overrides.libraryRoot ?? process.env.DATA_COLLECTOR_LIBRARY ?? '~/Documents/data-collector',
  );
  const configDir = expandPath(
    overrides.configDir ?? process.env.DATA_COLLECTOR_CONFIG ?? '~/.data-collector',
  );
  return {
    host,
    port,
    libraryRoot,
    configDir,
    authFile: join(configDir, 'auth.json'),
    jobsFile: join(libraryRoot, '_catalog', 'jobs.json'),
  };
}
