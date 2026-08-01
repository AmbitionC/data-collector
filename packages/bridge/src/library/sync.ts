import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OrganizedDocument } from '../organize/index.js';
import type { ContentSink } from '../sinks/types.js';
import { assertInsideRoot } from './paths.js';
import { atomicWriteText, SOURCE_FILE, type SyncInfo } from './writer.js';

/**
 * 把已在本机库里的条目同步到目标仓库的收件箱。
 *
 * 产品链路是三段：**采集只落本机库** → 人工核对 → **显式同步** → Agent 从收件箱归档。
 * 采集时就直接投递会让用户失去中间那道审阅，而且本机库不再是唯一的去重依据。
 *
 * 这里守两条线：
 * - **一条失败不影响其余**。逐条记录成败与原因，绝不因为一条炸掉整批。
 * - **推送失败不算同步失败**。条目已经写进仓库并提交，本机 Agent 直接读工作区就够；
 *   推不上去只作为告警如实呈现（可能没配远端、没有凭证）。
 */

export interface LibraryCatalogEntry {
  id: string;
  source: string;
  title: string;
  url: string;
  category: string;
  relativePath: string;
  updatedAt: string;
  sync?: SyncInfo;
}

export interface SyncOutcome {
  synced: number;
  failed: number;
  /** 逐条结果，供侧栏如实展示（而不是只给个总数）。 */
  entries: { id: string; title: string; sync: SyncInfo }[];
}

/** 按来源解析同步去向：给不出目标就不是「成功」，而是明确的失败原因。 */
export type ResolveTarget = (source: string) => ContentSink | undefined;

function catalogPathOf(root: string): string {
  return join(root, '_catalog', 'index.json');
}

async function readCatalog(root: string): Promise<LibraryCatalogEntry[]> {
  try {
    const value = JSON.parse(await readFile(catalogPathOf(root), 'utf8')) as unknown;
    return Array.isArray(value) ? (value as LibraryCatalogEntry[]) : [];
  } catch {
    return [];
  }
}

/** 读回采集时留下的整理结果；缺了它就无法忠实重放，只能如实报错。 */
async function readOrganized(root: string, entry: LibraryCatalogEntry): Promise<OrganizedDocument> {
  // relativePath 来自目录索引，是外部数据，必须过越界校验后再拼路径。
  const markdownPath = assertInsideRoot(root, join(root, entry.relativePath));
  const sourcePath = assertInsideRoot(root, join(dirname(markdownPath), SOURCE_FILE));
  let raw: string;
  try {
    raw = await readFile(sourcePath, 'utf8');
  } catch (error) {
    // 0.3.0 之前采集的条目没有留这份文件（当时不需要）。甩一个 ENOENT 给用户毫无意义，
    // 直接说清是什么情况、该怎么办。
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('这一条是旧版本采集的，缺少同步所需的原始数据；请重新采集这一条，或删掉它');
    }
    throw error;
  }
  return JSON.parse(raw) as OrganizedDocument;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 同步指定条目。`ids` 为空是安全的空操作——「同步全部」必须由调用方显式展开成 id 列表，
 * 这里绝不把「没传 ids」理解成「同步全部」。
 */
export async function syncEntries(
  root: string,
  ids: readonly string[],
  resolveTarget: ResolveTarget,
  now: () => string = () => new Date().toISOString(),
): Promise<SyncOutcome> {
  if (ids.length === 0) return { synced: 0, failed: 0, entries: [] };
  const catalog = await readCatalog(root);
  const wanted = new Set(ids);
  const results: SyncOutcome['entries'] = [];

  for (const entry of catalog) {
    if (!wanted.has(entry.id)) continue;
    const sink = resolveTarget(entry.source);
    if (!sink) {
      const sync: SyncInfo = {
        state: 'failed',
        at: now(),
        error: `没有为「${entry.source}」配置同步去向`,
      };
      entry.sync = sync;
      results.push({ id: entry.id, title: entry.title, sync });
      continue;
    }
    try {
      const organized = await readOrganized(root, entry);
      const result = await sink.save(organized);
      const detail = (result.detail ?? {}) as {
        committed?: boolean;
        pushed?: boolean;
        gitWarning?: string;
      };
      const sync: SyncInfo = {
        state: result.ok ? 'synced' : 'failed',
        target: sink.id,
        at: now(),
        ...(detail.committed !== undefined ? { committed: detail.committed } : {}),
        ...(detail.pushed !== undefined ? { pushed: detail.pushed } : {}),
        // 推送失败只是告警：条目已经写进仓库了，别把它报成同步失败。
        ...(detail.gitWarning ? { error: detail.gitWarning } : {}),
      };
      entry.sync = sync;
      results.push({ id: entry.id, title: entry.title, sync });
    } catch (error) {
      const sync: SyncInfo = { state: 'failed', target: sink.id, at: now(), error: messageOf(error) };
      entry.sync = sync;
      results.push({ id: entry.id, title: entry.title, sync });
    }
  }

  if (results.length > 0) {
    await atomicWriteText(root, catalogPathOf(root), `${JSON.stringify(catalog, null, 2)}\n`);
  }
  return {
    synced: results.filter(item => item.sync.state === 'synced').length,
    failed: results.filter(item => item.sync.state === 'failed').length,
    entries: results,
  };
}

/** 尚未同步（含上次失败）的条目 id，供「同步全部未同步」展开使用。 */
export async function pendingIds(root: string): Promise<string[]> {
  return (await readCatalog(root))
    .filter(entry => (entry.sync?.state ?? 'pending') !== 'synced')
    .map(entry => entry.id);
}
