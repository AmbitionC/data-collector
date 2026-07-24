import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, open, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { descriptorFor, stableContentId } from '@data-collector/shared';
import type { OrganizedDocument } from '../organize/index.js';
import { downloadAssets, type ResolveAddresses } from '../library/assets.js';
import { renderMarkdown } from '../library/markdown.js';
import { assertInsideRoot, assertSafeWritePath, safeSlug } from '../library/paths.js';
import type { ContentSink, SinkResult } from './types.js';

export interface RepoInboxSinkOptions {
  /** sink 标识（路由用）。 */
  id: string;
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

function defaultRunGit(
  repoPath: string,
  args: string[],
): Promise<{ code: number; stderr: string }> {
  return new Promise(resolvePromise => {
    execFile('git', ['-C', repoPath, ...args], { timeout: 30_000 }, (error, _stdout, stderr) => {
      const code =
        error && typeof (error as { code?: unknown }).code === 'number'
          ? ((error as { code: number }).code)
          : error
            ? 1
            : 0;
      resolvePromise({ code, stderr: stderr ?? '' });
    });
  });
}

/**
 * 收件箱 sink：把一篇采集内容原样投递为 `<repo>/<inboxDir>/<source>/<date>-<id>-<slug>/`
 * 下的 `original.md` + `meta.json` + `assets/`，供 Claude Code / Codex 等 Agent 定时扫描后
 * 在仓库内完成归档 / 整理 / 提炼。可选 git 提交（默认提交当前分支、不 push）。
 *
 * life-teachers 与 front-end-journey-resource 复用同一个 sink，仅仓库路径与配置不同。
 */
export class RepoInboxSink implements ContentSink {
  readonly id: string;
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
    this.commit = options.commit ?? true;
    this.push = options.push ?? false;
    this.fetcher = options.fetch ?? fetch;
    this.resolveAddresses = options.resolveAddresses;
    this.runGit = options.runGit ?? defaultRunGit;
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
    const entryName = `${date}-${id}-${safeSlug(document.title)}`;
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
        ...(git.warning ? { gitWarning: git.warning } : {}),
      },
    };
  }

  private async commitEntry(
    relativeEntry: string,
    title: string,
  ): Promise<{ committed: boolean; pushed: boolean; warning?: string }> {
    if (!this.commit) return { committed: false, pushed: false };
    try {
      const add = await this.runGit(this.repoRoot, ['add', '--', relativeEntry]);
      if (add.code !== 0) {
        return { committed: false, pushed: false, warning: `git add 失败：${add.stderr.trim()}` };
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
        ...(push.code === 0 ? {} : { warning: `git push 失败：${push.stderr.trim()}` }),
      };
    } catch (error) {
      return {
        committed: false,
        pushed: false,
        warning: `git 操作异常：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
