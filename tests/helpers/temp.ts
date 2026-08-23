import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function createTemporaryDirectoryTracker() {
  const directories = new Set<string>();

  return {
    async create(prefix: string): Promise<string> {
      const directory = await mkdtemp(join(tmpdir(), prefix));
      directories.add(directory);
      return directory;
    },

    async cleanup(): Promise<void> {
      const pending = [...directories];
      directories.clear();
      await Promise.all(
        // macOS 上并行关闭 socket/文件句柄时，递归 rm 偶尔会在目录项刚变化的瞬间
        // 抛 ENOTEMPTY；Node 原生重试正是为这种竞态准备的。
        pending.map(directory => rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 20,
        })),
      );
    },
  };
}
