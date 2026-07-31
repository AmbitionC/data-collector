import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { descriptorFor, stableContentId, type Source } from '@data-collector/shared';
import { renderMarkdown } from './markdown.js';
import type { OrganizedDocument } from '../organize/index.js';
import { downloadAssets } from './assets.js';
import type { ResolveAddresses } from './assets.js';
import { assertInsideRoot, assertSafeWritePath, safeSlug } from './paths.js';

/**
 * 同步状态。本机库是唯一落点与去重依据，投递到仓库收件箱是**之后**的显式动作。
 * 采集时一律 pending：内容先落本地，由用户核对后再决定同步哪些。
 */
export type SyncState = 'pending' | 'synced' | 'failed';

export interface SyncInfo {
  state: SyncState;
  /** 同步到了哪个去向（sink id）。 */
  target?: string;
  /** 同步完成时刻。 */
  at?: string;
  /** 已提交到目标仓库的当前分支。 */
  committed?: boolean;
  /** 已推送到远端；未推送不算失败（本机 Agent 直接读工作区就够）。 */
  pushed?: boolean;
  /** 失败原因，或推送失败之类的告警，如实展示。 */
  error?: string;
}

interface CatalogEntry {
  id: string;
  source: Source;
  title: string;
  url: string;
  category: string;
  relativePath: string;
  updatedAt: string;
  sync?: SyncInfo;
}

/** 整理结果的留存文件名：同步到收件箱时原样重放它。 */
export const SOURCE_FILE = 'source.json';

export interface SavedContent {
  id: string;
  markdownPath: string;
  downloadedImages: number;
  failedImages: number;
}

export interface MarkdownLibraryOptions {
  root: string;
  fetch?: typeof fetch;
  resolveAddresses?: ResolveAddresses;
}

export async function atomicWriteText(root: string, path: string, contents: string): Promise<void> {
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

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function frontMatter(input: OrganizedDocument, id: string, failedImages: number): string {
  const document = input.document;
  const lines = [
    '---',
    `id: ${yamlString(id)}`,
    'schema_version: 1',
    `source: ${yamlString(document.source)}`,
    `kind: ${yamlString(document.kind)}`,
    `title: ${yamlString(document.title)}`,
    `url: ${yamlString(document.canonicalUrl)}`,
    ...(document.author ? [`author: ${yamlString(document.author)}`] : []),
    ...(document.publishedAt ? [`published_at: ${yamlString(document.publishedAt)}`] : []),
    `collected_at: ${yamlString(document.collectedAt)}`,
    `updated_at: ${yamlString(document.collectedAt)}`,
    `category: ${yamlString(input.category)}`,
    'tags:',
    ...input.tags.map(tag => `  - ${yamlString(tag)}`),
    `summary: ${yamlString(input.summary)}`,
    `failed_images: ${failedImages}`,
    '---',
    '',
  ];
  return lines.join('\n');
}

export class MarkdownLibrary {
  private readonly root: string;
  private readonly fetcher: typeof fetch;
  private readonly resolveAddresses: ResolveAddresses | undefined;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(options: MarkdownLibraryOptions) {
    this.root = options.root;
    this.fetcher = options.fetch ?? fetch;
    this.resolveAddresses = options.resolveAddresses;
  }

  async save(input: OrganizedDocument): Promise<SavedContent> {
    const result = this.saveQueue.then(() => this.saveNow(input));
    this.saveQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async saveNow(input: OrganizedDocument): Promise<SavedContent> {
    await mkdir(this.root, { recursive: true });
    await assertSafeWritePath(this.root, this.root);
    const catalogPath = assertInsideRoot(this.root, join(this.root, '_catalog', 'index.json'));
    await assertSafeWritePath(this.root, catalogPath);
    const catalog = await this.readCatalog(catalogPath);
    const id = stableContentId(input.document.canonicalUrl);
    const existing = catalog.find(entry => entry.id === id);
    const year = (input.document.publishedAt ?? input.document.collectedAt).slice(0, 4);
    const relativePath =
      existing?.relativePath ??
      join(
        descriptorFor(input.document.source).label,
        safeSlug(input.category),
        year,
        `${id}-${safeSlug(input.document.title)}`,
        'index.md',
      );
    const markdownPath = assertInsideRoot(this.root, join(this.root, relativePath));
    const entryDirectory = dirname(markdownPath);
    await assertSafeWritePath(this.root, entryDirectory);
    await mkdir(entryDirectory, { recursive: true });
    await assertSafeWritePath(this.root, markdownPath);

    const assets = await downloadAssets({
      html: input.sanitizedHtml,
      images: input.document.images,
      entryDirectory,
      libraryRoot: this.root,
      fetch: this.fetcher,
      ...(this.resolveAddresses ? { resolveAddresses: this.resolveAddresses } : {}),
    });
    const markdown = `${frontMatter(input, id, assets.failed)}# ${input.document.title}\n\n${renderMarkdown(assets.html)}\n`;
    await atomicWriteText(this.root, markdownPath, markdown);

    // 同步到收件箱时要原样重放这份内容，因此把整理结果一并留在条目目录里。
    // 不留的话就只能从 Markdown 反解，那是有损的。
    await atomicWriteText(
      this.root,
      join(entryDirectory, SOURCE_FILE),
      `${JSON.stringify(input, null, 2)}\n`,
    );

    const nextEntry: CatalogEntry = {
      id,
      source: input.document.source,
      title: input.document.title,
      url: input.document.canonicalUrl,
      category: input.category,
      relativePath: relative(this.root, markdownPath),
      updatedAt: input.document.collectedAt,
      // 重新采集同一地址说明内容可能变了，同步状态回到未同步，等用户再确认一次。
      sync: { state: 'pending' },
    };
    const nextCatalog = catalog
      .filter(entry => entry.id !== id)
      .concat(nextEntry)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    await atomicWriteText(this.root, catalogPath, `${JSON.stringify(nextCatalog, null, 2)}\n`);

    return {
      id,
      markdownPath,
      downloadedImages: assets.downloaded,
      failedImages: assets.failed,
    };
  }

  private async readCatalog(path: string): Promise<CatalogEntry[]> {
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
      return Array.isArray(value) ? (value as CatalogEntry[]) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}
