import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
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
 * 拿不到 git 信息（比如从压缩包解出来构建）就直接失败且删除半产物；
 * `unknown` 不是可审计的身份，不允许进入部署链路。
 */
function buildStamp() {
  const git = args => execFileSync('git', args, { cwd: workspaceRoot });
  const commit = git(['rev-parse', '--short=7', 'HEAD']).toString('utf8').trim();
  if (!/^[0-9a-f]{7}$/i.test(commit)) {
    throw new Error(`git 返回了无效的构建提交号：${JSON.stringify(commit)}`);
  }
  const trackedDiff = git(['diff', '--binary', 'HEAD', '--']);
  // `--exclude-standard` 遵守 .gitignore/.git/info/exclude/全局 ignore：构建产物和
  // 依赖不能让同一份源码每次生成不同标记。-z 避免文件名换行造成歧义。
  const untrackedOutput = git(['ls-files', '--others', '--exclude-standard', '-z']);
  const untrackedPaths = untrackedOutput
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort();

  if (trackedDiff.length === 0 && untrackedPaths.length === 0) return commit;

  const digest = createHash('sha256');
  updateDigest(digest, 'tracked-diff', trackedDiff);
  for (const relativePath of untrackedPaths) {
    const absolutePath = join(workspaceRoot, relativePath);
    const stat = lstatSync(absolutePath);
    updateDigest(digest, 'untracked-path', Buffer.from(relativePath));
    if (stat.isSymbolicLink()) {
      updateDigest(digest, 'untracked-symlink', Buffer.from(readlinkSync(absolutePath)));
    } else if (stat.isFile()) {
      updateDigest(digest, 'untracked-file', readFileSync(absolutePath));
    } else {
      updateDigest(digest, 'untracked-special', Buffer.from(String(stat.mode)));
    }
  }
  // 同一提交上的不同本地内容必须能区分，否则扩展会把新构建误判为已加载。
  return `${commit}+dirty.${digest.digest('hex').slice(0, 12)}`;
}

function updateDigest(digest, label, value) {
  // 长度前缀使 `ab`+`c` 和 `a`+`bc` 不会落到同一串输入。
  digest.update(`${label}\0${value.length}\0`);
  digest.update(value);
}

await rm(outputDirectory, { recursive: true, force: true });
try {
  const initialStamp = buildStamp();
  const manifest = JSON.parse(await readFile(join(packageRoot, 'manifest.json'), 'utf8'));
  const BUILD_ID = `v${manifest.version} · ${initialStamp}`;

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
  await cp(
    join(packageRoot, 'src', 'sidepanel', 'index.html'),
    join(outputDirectory, 'sidepanel', 'index.html'),
  );
  await cp(
    join(packageRoot, 'src', 'sidepanel', 'styles.css'),
    join(outputDirectory, 'sidepanel', 'styles.css'),
  );

  const finalStamp = buildStamp();
  if (finalStamp !== initialStamp) {
    throw new Error(
      `构建期间源码身份发生变化（${initialStamp} -> ${finalStamp}），已拒绝混合产物`,
    );
  }
  // 构建标记最后才写入：只有前后两次源码指纹完全一致才会出现可部署标记。
  await writeFile(join(outputDirectory, 'build-id.txt'), `${BUILD_ID}\n`, 'utf8');
} catch (error) {
  // 任何无法证明身份的情况都 fail-closed，不留可能被误部署的半产物。
  await rm(outputDirectory, { recursive: true, force: true }).catch(() => undefined);
  throw error;
}
