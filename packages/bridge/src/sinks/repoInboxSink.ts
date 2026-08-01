import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { descriptorFor, stableContentId } from '@data-collector/shared';
import { MISSING_GIT_PREFIX, runGit } from '../git.js';
import type { OrganizedDocument } from '../organize/index.js';
import { downloadAssets, type ResolveAddresses } from '../library/assets.js';
import { renderMarkdown } from '../library/markdown.js';
import { assertInsideRoot, assertSafeWritePath, safeSlug } from '../library/paths.js';
import type { ContentSink, SinkResult } from './types.js';

export interface RepoInboxSinkOptions {
  /** sink 标识（路由用）。 */
  id: string;
  /** 面向用户的去向名称；缺省由仓库目录名派生（如「life-teachers 收件箱」）。 */
  label?: string;
  /** 该目标仓库的分类清单（侧边栏下拉选项）；缺省为空表示交给下游 Agent 判定。 */
  categories?: readonly string[];
  /** 目标仓库根目录（支持 ~ 展开）。 */
  repoPath: string;
  /** 收件箱子目录（相对仓库根），默认 `_inbox`。 */
  inboxDir?: string;
  /** 写入后是否 git 提交（默认 true）。 */
  commit?: boolean;
  /** 提交后是否 git push（默认 false；本机 Agent 无需，云端 Routine 需要）。 */
  push?: boolean;
  fetch?: typeof fetch;
  resolveAddresses?: ResolveAddresses;
  /** 可注入的 git 执行器（测试用）。 */
  runGit?: (repoPath: string, args: string[]) => Promise<{ code: number; stderr: string }>;
}

function expandPath(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return isAbsolute(value) ? value : resolve(value);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * 正文内容指纹：对纯文本做归一化（去空白、标点、大小写）后取 SHA-256。
 * 同一篇文章在不同 URL 被再次发布（转载/搬运）时指纹一致，便于加工阶段做原文去重
 *（同 URL 由稳定内容 ID 幂等覆盖，跨 URL 的重复由本指纹识别）。
 */
function contentFingerprint(text: string): string {
  const normalized = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[，。！？、；：""''（）()[\]{}<>·—…,.!?;:'"]/g, '');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

async function atomicWriteText(root: string, path: string, contents: string): Promise<void> {
  await assertSafeWritePath(root, dirname(path));
  await mkdir(dirname(path), { recursive: true });
  await assertSafeWritePath(root, path);
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

// git 怎么找、跑在什么环境里，见 ../git.ts 顶部那段注释（登录项的 PATH 和终端不是一回事）。
const defaultRunGit = runGit;

/**
 * 收件箱 sink：把一篇采集内容原样投递为 `<repo>/<inboxDir>/<source>/<date>-<id>-<slug>/`
 * 下的 `original.md` + `meta.json` + `assets/`，供 Claude Code / Codex 等 Agent 定时扫描后
 * 在仓库内完成归档 / 整理 / 提炼。可选 git 提交（默认提交当前分支、不 push）。
 *
 * life-teachers 与 front-end-journey-resource 复用同一个 sink，仅仓库路径与配置不同。
 */
export class RepoInboxSink implements ContentSink {
  readonly id: string;
  readonly label: string;
  readonly categories: readonly string[];
  private readonly repoRoot: string;
  private readonly inboxDir: string;
  private readonly commit: boolean;
  private readonly push: boolean;
  private readonly fetcher: typeof fetch;
  private readonly resolveAddresses: ResolveAddresses | undefined;
  private readonly runGit: (repoPath: string, args: string[]) => Promise<{ code: number; stderr: string }>;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(options: RepoInboxSinkOptions) {
    this.id = options.id;
    this.repoRoot = expandPath(options.repoPath);
    this.inboxDir = options.inboxDir ?? '_inbox';
    this.categories = options.categories ?? [];
    this.label = options.label ?? `${this.repoRoot.split(/[\\/]/).filter(Boolean).pop() ?? '仓库'} 收件箱`;
    this.commit = options.commit ?? true;
    this.push = options.push ?? false;
    this.fetcher = options.fetch ?? fetch;
    this.resolveAddresses = options.resolveAddresses;
    this.runGit = options.runGit ?? defaultRunGit;
  }

  /**
   * 按稳定内容 ID 找回这条内容已有的收件箱目录。
   * 目录不存在、或读不动，都按「没有」处理——大不了新建一个，绝不因此让同步失败。
   */
  private async findEntryById(directory: string, id: string): Promise<string | undefined> {
    try {
      return (await readdir(directory)).find(name => name.includes(`-${id}-`));
    } catch {
      return undefined;
    }
  }

  /** 写入根目录：这里投出去的条目也应当能「在文件夹中查看」。 */
  get root(): string {
    return this.repoRoot;
  }

  async save(input: OrganizedDocument): Promise<SinkResult> {
    const result = this.saveQueue.then(() => this.saveNow(input));
    this.saveQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async saveNow(input: OrganizedDocument): Promise<SinkResult> {
    const document = input.document;
    const id = stableContentId(document.canonicalUrl);
    const date = (document.publishedAt ?? document.collectedAt).slice(0, 10);
    // 目录名里只有 id 是稳定的：date 在没有发布时间时退化成采集日期，
    // title 取自正文首句（「展开全文」点没点上都会变）。重采同一条再同步时，
    // 若按当次的日期和标题重算目录名，收件箱里就会长出第二份，
    // 而本机库仍是一条——Agent 会把同一篇文章归档两遍。
    // 所以先按 id 找回既有目录，找到就沿用。
    const inboxDirectory = join(this.repoRoot, this.inboxDir, document.source);
    const existing = await this.findEntryById(inboxDirectory, id);
    const entryName = existing ?? `${date}-${id}-${safeSlug(document.title)}`;
    const relativeEntry = join(this.inboxDir, document.source, entryName);
    const entryDirectory = assertInsideRoot(this.repoRoot, join(this.repoRoot, relativeEntry));
    await assertSafeWritePath(this.repoRoot, entryDirectory);
    await mkdir(entryDirectory, { recursive: true });

    const assets = await downloadAssets({
      html: input.sanitizedHtml,
      images: document.images,
      entryDirectory,
      libraryRoot: this.repoRoot,
      fetch: this.fetcher,
      ...(this.resolveAddresses ? { resolveAddresses: this.resolveAddresses } : {}),
    });

    const dateKnown = Boolean(document.publishedAt);
    const frontMatter = [
      '---',
      `title: ${yamlString(document.title)}`,
      ...(document.author ? [`author: ${yamlString(document.author)}`] : []),
      `date: ${date}`,
      `date_source: ${dateKnown ? 'published' : 'collected'}`,
      `source: ${yamlString(descriptorFor(document.source).label)}`,
      `source_url: ${yamlString(document.canonicalUrl)}`,
      `collected_at: ${yamlString(document.collectedAt)}`,
      'archived_at: ""',
      `kind: ${yamlString(document.kind)}`,
      '---',
      '',
    ].join('\n');
    const originalMarkdown = `${frontMatter}# ${document.title}\n\n${renderMarkdown(assets.html)}\n`;

    const meta = {
      id,
      contentHash: contentFingerprint(document.text),
      source: document.source,
      kind: document.kind,
      title: document.title,
      ...(document.author ? { author: document.author } : {}),
      url: document.canonicalUrl,
      ...(document.publishedAt ? { publishedAt: document.publishedAt } : {}),
      collectedAt: document.collectedAt,
      suggestedCategory: input.category,
      suggestedTags: input.tags,
      summary: input.summary,
      images: document.images.map(image => image.url),
      downloadedImages: assets.downloaded,
      failedImages: assets.failed,
    };

    const originalPath = join(entryDirectory, 'original.md');
    const metaPath = join(entryDirectory, 'meta.json');
    await atomicWriteText(this.repoRoot, originalPath, originalMarkdown);
    await atomicWriteText(this.repoRoot, metaPath, `${JSON.stringify(meta, null, 2)}\n`);

    const git = await this.commitEntry(relativeEntry, document.title);

    return {
      sinkId: this.id,
      ok: true,
      outputRef: entryDirectory,
      detail: {
        downloadedImages: assets.downloaded,
        failedImages: assets.failed,
        committed: git.committed,
        pushed: git.pushed,
        ...(git.commitFailed ? { commitFailed: true } : {}),
        ...(git.warning ? { gitWarning: git.warning } : {}),
      },
    };
  }

  private async commitEntry(
    relativeEntry: string,
    title: string,
  ): Promise<{ committed: boolean; pushed: boolean; warning?: string; commitFailed?: boolean }> {
    if (!this.commit) return { committed: false, pushed: false };
    try {
      const add = await this.runGit(this.repoRoot, ['add', '--', relativeEntry]);
      if (add.code !== 0) {
        // **提交失败和推送失败是两回事**：推不上去只是没同步到远端（文件已经提交了），
        // 而 add/commit 失败意味着这条根本没进仓库，绝不能算「已同步」。
        return {
          committed: false,
          pushed: false,
          commitFailed: true,
          warning: explainGitFailure('git add', add.stderr),
        };
      }
      const message = `采集: ${title}`;
      const commit = await this.runGit(this.repoRoot, ['commit', '-m', message, '--', relativeEntry]);
      // 无改动可提交时 git commit 返回非 0；视为幂等成功（内容已在库中）。
      const committed = commit.code === 0;
      if (!this.push) return { committed, pushed: false };
      const push = await this.runGit(this.repoRoot, ['push']);
      return {
        committed,
        pushed: push.code === 0,
        ...(push.code === 0 ? {} : { warning: explainGitFailure('git push', push.stderr) }),
      };
    } catch (error) {
      return {
        committed: false,
        pushed: false,
        commitFailed: true,
        warning: explainGitFailure('git', error instanceof Error ? error.message : String(error)),
      };
    }
  }
}

/**
 * 把 git 的原始报错翻成人能照着做的一句话。
 *
 * 直接把 stderr 摆给用户没有意义——`xcrun: error: invalid active developer path`
 * 这种话不告诉任何人该干什么。常见成因就那么几个，认出来就直说。
 *
 * 但**认错了比不认更糟**：上面那条我一度翻成「这台 Mac 的命令行工具坏了，去 xcode-select --install」，
 * 而用户终端里的 git 好得很。真正的原因是服务这边的 PATH 找不到用户那份 git（见 ../git.ts）。
 * 翻译要指向真正能动手的地方，不能把锅甩给用户的机器。
 */
export function explainGitFailure(step: string, stderr: string): string {
  const raw = stderr.trim();
  // 我们自己写好的说明（带着试过哪些路径），原样透出，别被下面的 xcrun 分支盖掉。
  if (raw.startsWith(MISSING_GIT_PREFIX)) return `${step} 失败：${raw}`;
  if (/xcrun|CommandLineTools|xcode-select/i.test(raw)) {
    return `${step} 失败：本机服务跑不起来 git——它以登录项常驻，拿到的 PATH 比你终端里的窄，`
      + '只找到了 macOS 自带的那层 git 壳（那东西得先经 xcrun 才能干活）。'
      + '你终端里的 git 是好的，这是服务这边的环境问题：'
      + '重启本机服务（`npm run collector -- bridge install`）后会重新去 Homebrew 等位置找 git。';
  }
  if (/not a git repository/i.test(raw)) {
    return `${step} 失败：目标目录不是一个 git 仓库。请确认同步去向指向的是克隆下来的仓库。`;
  }
  if (/Please tell me who you are|user\.email/i.test(raw)) {
    return `${step} 失败：这个仓库还没配置提交身份。`
      + '在仓库里执行 `git config user.email 你的邮箱` 和 `git config user.name 你的名字`。';
  }
  if (/could not read Username|Authentication failed|Permission denied \(publickey\)/i.test(raw)) {
    return `${step} 失败：没有推送权限（凭证缺失或过期）。内容已经提交到本地仓库，`
      + '你也可以自己 `git push` 一次。';
  }
  if (/no upstream|does not appear to be a git repository|couldn't find remote/i.test(raw)) {
    return `${step} 失败：这个仓库没有配置远端。内容已经提交到本地仓库，本机 Agent 直接读工作区即可。`;
  }
  return `${step} 失败：${raw || '未知错误'}`;
}