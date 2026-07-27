import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(packageRoot, '..', '..');
const outputDirectory = join(packageRoot, 'dist');

/**
 * 把「这一份是从哪个提交构建的」烙进产物。
 *
 * 侧栏右下角会显示它。没有这个标记，用户在浏览器里根本无从判断自己加载的是不是
 * 最新构建 —— 实际就发生过：新功能全都做完了，用户看到的却还是旧版，
 * 只能靠「功能怎么没出现」来反推，非常难受。
 * 拿不到 git 信息（比如从压缩包解出来构建）就写 unknown，绝不编一个假的。
 */
function buildStamp() {
  const git = args => execFileSync('git', args, { cwd: workspaceRoot, encoding: 'utf8' }).trim();
  try {
    const commit = git(['rev-parse', '--short=7', 'HEAD']);
    // 有未提交改动时明确标出来，免得把本地魔改误认成某个提交。
    const dirty = git(['status', '--porcelain']).length > 0;
    return dirty ? `${commit}+本地改动` : commit;
  } catch {
    return 'unknown';
  }
}

const manifest = JSON.parse(await readFile(join(packageRoot, 'manifest.json'), 'utf8'));
const BUILD_ID = `v${manifest.version} · ${buildStamp()}`;

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: {
    background: join(packageRoot, 'src', 'background', 'index.ts'),
    content: join(packageRoot, 'src', 'content.ts'),
    // 页面主世界脚本：旁观应用自己的接口响应，取回帖子号（DOM 上没有）。
    inject: join(packageRoot, 'src', 'inject.ts'),
    'sidepanel/index': join(packageRoot, 'src', 'sidepanel', 'index.ts'),
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
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
});
await cp(join(packageRoot, 'manifest.json'), join(outputDirectory, 'manifest.json'));
// 构建标记也写成文件：打包校验和排查时不必去反查 bundle。
await writeFile(join(outputDirectory, 'build-id.txt'), `${BUILD_ID}\n`, 'utf8');
await cp(join(packageRoot, 'src', 'sidepanel', 'index.html'), join(outputDirectory, 'sidepanel', 'index.html'));
await cp(join(packageRoot, 'src', 'sidepanel', 'styles.css'), join(outputDirectory, 'sidepanel', 'styles.css'));
