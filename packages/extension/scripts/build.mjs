import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(packageRoot, '..', '..');
const outputDirectory = join(packageRoot, 'dist');

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: {
    background: join(packageRoot, 'src', 'background', 'index.ts'),
    content: join(packageRoot, 'src', 'content.ts'),
  },
  outdir: outputDirectory,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome116',
  sourcemap: false,
  legalComments: 'none',
  alias: {
    '@data-collector/shared': join(workspaceRoot, 'packages', 'shared', 'src', 'index.ts'),
  },
});
await cp(join(packageRoot, 'manifest.json'), join(outputDirectory, 'manifest.json'));
