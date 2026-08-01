import { readdir, readFile, rm, rmdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { atomicWriteText } from './writer.js';
import { assertInsideRoot } from './paths.js';

/**
 * 已入库内容的查看与管理。
 *
 * 删除是不可逆的破坏性操作，因此这里守两条线：
 * - **只删知识库根目录之内的东西**。路径一律经过 assertInsideRoot 校验，
 *   目录索引里的 relativePath 是外部数据，不能直接拿来拼路径就删。
 * - **删条目就连同它的目录一起删**（正文 + assets 同在一个目录），
 *   并同步更新目录索引，不留下指向空目录的僵尸记录。
 */

export interface LibraryEntry {
  id: string;
  source: string;
  title: string;
  url: string;
  category: string;
  relativePath: string;
  updatedAt: string;
}

function catalogPathOf(root: string): string {
  return join(root, '_catalog', 'index.json');
}

async function readCatalog(root: string): Promise<LibraryEntry[]> {
  try {
    const value = JSON.parse(await readFile(catalogPathOf(root), 'utf8')) as unknown;
    return Array.isArray(value) ? (value as LibraryEntry[]) : [];
  } catch {
    return [];
  }
}

async function writeCatalog(root: string, entries: LibraryEntry[]): Promise<void> {
  await atomicWriteText(root, catalogPathOf(root), `${JSON.stringify(entries, null, 2)}\n`);
}

/** 列出已入库内容，最近的排在前面。 */
export async function listLibrary(root: string): Promise<LibraryEntry[]> {
  const entries = await readCatalog(root);
  return [...entries].sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
  );
}

/** 一条已入库内容的正文（供侧栏「查看内容」）。 */
export interface LibraryEntryContent extends LibraryEntry {
  /** Markdown 全文；超长会截断，并置 truncated。 */
  markdown: string;
  truncated: boolean;
  /** 正文文件的绝对路径，便于「在文件夹中查看」。 */
  absolutePath: string;
}

/** 单条正文的读取上限：侧栏是个窄面板，读进来几百 KB 毫无意义还会卡住渲染。 */
const MAX_CONTENT_BYTES = 200_000;

/**
 * 读一条已入库内容的正文。
 *
 * relativePath 来自目录索引，是**外部数据**，因此和删除走同一条越界校验：
 * 只允许读知识库根目录之内的文件。
 */
export async function readEntry(
  root: string,
  id: string,
): Promise<LibraryEntryContent | undefined> {
  const entry = (await readCatalog(root)).find(candidate => candidate.id === id);
  if (!entry) return undefined;
  let absolutePath: string;
  try {
    absolutePath = assertInsideRoot(root, join(root, entry.relativePath));
  } catch {
    return undefined;
  }
  let markdown: string;
  try {
    markdown = await readFile(absolutePath, 'utf8');
  } catch {
    // 索引里有、文件没了：如实说不出内容，而不是渲染一片空白。
    return undefined;
  }
  const truncated = markdown.length > MAX_CONTENT_BYTES;
  return {
    ...entry,
    absolutePath,
    truncated,
    markdown: truncated ? markdown.slice(0, MAX_CONTENT_BYTES) : markdown,
  };
}

export interface DeleteOutcome {
  deleted: number;
  /** 索引里有、但文件已经不在了的条目数（照样从索引里清掉）。 */
  missing: number;
}

/**
 * 删除若干条目：连同各自的目录（正文 + assets）一起删，并更新索引。
 * ids 为空数组时不做任何事；传 'all' 由调用方展开成全部 id，这里不接受隐式全删。
 */
export async function deleteEntries(root: string, ids: readonly string[]): Promise<DeleteOutcome> {
  if (ids.length === 0) return { deleted: 0, missing: 0 };
  const wanted = new Set(ids);
  const entries = await readCatalog(root);
  let deleted = 0;
  let missing = 0;

  for (const entry of entries) {
    if (!wanted.has(entry.id)) continue;
    // relativePath 来自索引文件（外部数据），必须校验它确实落在库内再删。
    let directory: string;
    try {
      const markdownPath = assertInsideRoot(root, join(root, entry.relativePath));
      directory = assertInsideRoot(root, dirname(markdownPath));
    } catch {
      missing += 1;
      continue;
    }
    // 不允许把库根目录本身删掉。
    if (relative(root, directory) === '') {
      missing += 1;
      continue;
    }
    try {
      await rm(directory, { recursive: true, force: true });
      await pruneEmptyParents(root, dirname(directory));
      deleted += 1;
    } catch {
      missing += 1;
    }
  }

  await writeCatalog(root, entries.filter(entry => !wanted.has(entry.id)));
  return { deleted, missing };
}

/**
 * 条目删掉之后，把因此变空的上级目录一并收走。
 *
 * 库的结构是 `<来源>/<分类>/<年份>/<条目>/`，只删条目目录会留下一串空壳，
 * 「清空全部」之后目录树看着还是满的——用户说的「脏数据」正是这些。
 * 只往上走到库根为止，且**只删空目录**（rmdir 遇到非空会失败，正好当作天然的保险）。
 */
async function pruneEmptyParents(root: string, from: string): Promise<void> {
  let directory = from;
  while (relative(root, directory) !== '' && !relative(root, directory).startsWith('..')) {
    try {
      if ((await readdir(directory)).length > 0) return;
      await rmdir(directory);
    } catch {
      // 目录不存在、非空、或没权限：到此为止，不是错误。
      return;
    }
    directory = dirname(directory);
  }
}

/** 一键清空：删掉索引里的每一条。空库时是安全的空操作。 */
export async function clearLibrary(root: string): Promise<DeleteOutcome> {
  const entries = await readCatalog(root);
  return deleteEntries(root, entries.map(entry => entry.id));
}
