import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import TurndownService from 'turndown';
import { stableContentId } from '@data-collector/shared';
import type { OrganizedDocument } from '../organize/index.js';
import { downloadAssets } from './assets.js';
import { assertInsideRoot, safeSlug } from './paths.js';

interface CatalogEntry {
  id: string;
  source: 'wechat' | 'zsxq';
  title: string;
  url: string;
  category: string;
  relativePath: string;
  updatedAt: string;
}

export interface SavedContent {
  id: string;
  markdownPath: string;
  downloadedImages: number;
  failedImages: number;
}

export interface MarkdownLibraryOptions {
  root: string;
  fetch?: typeof fetch;
}

const SOURCE_DIRECTORIES = {
  wechat: '微信公众号',
  zsxq: '知识星球',
} as const;

async function atomicWriteText(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
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

function toMarkdown(html: string): string {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
  });
  return service.turndown(html).trim();
}

export class MarkdownLibrary {
  private readonly root: string;
  private readonly fetcher: typeof fetch;

  constructor(options: MarkdownLibraryOptions) {
    this.root = options.root;
    this.fetcher = options.fetch ?? fetch;
  }

  async save(input: OrganizedDocument): Promise<SavedContent> {
    await mkdir(this.root, { recursive: true });
    const catalogPath = assertInsideRoot(this.root, join(this.root, '_catalog', 'index.json'));
    const catalog = await this.readCatalog(catalogPath);
    const id = stableContentId(input.document.canonicalUrl);
    const existing = catalog.find(entry => entry.id === id);
    const year = (input.document.publishedAt ?? input.document.collectedAt).slice(0, 4);
    const relativePath =
      existing?.relativePath ??
      join(
        SOURCE_DIRECTORIES[input.document.source],
        safeSlug(input.category),
        year,
        `${id}-${safeSlug(input.document.title)}`,
        'index.md',
      );
    const markdownPath = assertInsideRoot(this.root, join(this.root, relativePath));
    const entryDirectory = dirname(markdownPath);
    await mkdir(entryDirectory, { recursive: true });

    const assets = await downloadAssets({
      html: input.sanitizedHtml,
      images: input.document.images,
      entryDirectory,
      libraryRoot: this.root,
      fetch: this.fetcher,
    });
    const markdown = `${frontMatter(input, id, assets.failed)}# ${input.document.title}\n\n${toMarkdown(assets.html)}\n`;
    await atomicWriteText(markdownPath, markdown);

    const nextEntry: CatalogEntry = {
      id,
      source: input.document.source,
      title: input.document.title,
      url: input.document.canonicalUrl,
      category: input.category,
      relativePath: relative(this.root, markdownPath),
      updatedAt: input.document.collectedAt,
    };
    const nextCatalog = catalog
      .filter(entry => entry.id !== id)
      .concat(nextEntry)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    await atomicWriteText(catalogPath, `${JSON.stringify(nextCatalog, null, 2)}\n`);

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
