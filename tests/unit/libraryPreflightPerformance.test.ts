import { readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const probe = vi.hoisted(() => ({ enabled: false, active: 0, peak: 0, completed: 0 }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'readFile' && probe.enabled && String(args[0]).endsWith('/source.json')) {
            return async (...readArgs: Parameters<typeof handle.readFile>) => {
              probe.active += 1;
              probe.peak = Math.max(probe.peak, probe.active);
              try {
                await new Promise(resolve => setTimeout(resolve, 20));
                return await handle.readFile(...readArgs);
              } finally {
                probe.active -= 1;
                probe.completed += 1;
              }
            };
          }
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});

import { MarkdownLibrary } from '../../packages/bridge/src/library/index.js';
import { organize } from '../../packages/bridge/src/organize/index.js';
import { preflightDirectedLocalLibrary } from '../../packages/bridge/src/library/writer.js';

const directories = createTemporaryDirectoryTracker();
afterEach(async () => {
  probe.enabled = false;
  await directories.cleanup();
});

async function fixtureLibrary(): Promise<string> {
    const root = await directories.create('data-collector-preflight-throughput-');
    const library = new MarkdownLibrary({ root });
    for (let i = 0; i < 12; i += 1) {
      const url = `https://www.nowcoder.com/discuss/${1000 + i}`;
      await library.save(organize({
        schemaVersion: 1, source: 'nowcoder', kind: 'post', url, canonicalUrl: url,
        title: `Agent 面经 ${i}`, collectedAt: '2026-10-01T00:00:00.000Z',
        text: '真实的独立正文快照，用于验证逐条身份检查不被吞掉。',
        html: '<p>真实的独立正文快照，用于验证逐条身份检查不被吞掉。</p>', images: [],
      }));
    }
    return root;
}

describe('directed full-library preflight throughput', () => {
  it('overlaps slow independent snapshot reads while validating every entry with bounded open files', async () => {
    const root = await fixtureLibrary();
    Object.assign(probe, { enabled: true, active: 0, peak: 0, completed: 0 });
    await expect(preflightDirectedLocalLibrary(root)).resolves.toBe(await realpath(root));
    expect(probe.completed).toBe(12);
    expect(probe.active).toBe(0);
    expect(probe.peak).toBeGreaterThan(1);
    expect(probe.peak).toBeLessThanOrEqual(8);
  });

  it('rejects a mismatched source identity and drains started reads before returning failure', async () => {
    const root = await fixtureLibrary();
    const catalog = JSON.parse(await readFile(join(root, '_catalog', 'index.json'), 'utf8'));
    const path = join(dirname(join(root, catalog[0].relativePath)), 'source.json');
    const source = JSON.parse(await readFile(path, 'utf8'));
    source.document.canonicalUrl = 'https://www.nowcoder.com/discuss/9999';
    await writeFile(path, JSON.stringify(source));
    Object.assign(probe, { enabled: true, active: 0, peak: 0, completed: 0 });
    await expect(preflightDirectedLocalLibrary(root)).rejects.toMatchObject({
      code: 'DIRECTED_LOCAL_LIBRARY_CORRUPT',
    });
    expect(probe.active).toBe(0);
    expect(probe.completed).toBe(12);
    expect(probe.peak).toBeLessThanOrEqual(8);
  });
});
