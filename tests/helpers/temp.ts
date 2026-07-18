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
        pending.map(directory => rm(directory, { recursive: true, force: true })),
      );
    },
  };
}
