import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OrganizedDocument } from '../organize/index.js';
import type { ContentSink } from '../sinks/types.js';
import { assertInsideRoot } from './paths.js';
import { atomicWriteText, SOURCE_FILE, type SyncInfo } from './writer.js';
import { withCatalogTransaction } from './catalogTransaction.js';
import { deliveryRevision } from './deliveryRevision.js';
import { projectOrganized } from './storedDocument.js';
import {
  stableContentId,
  ZSXQ_COMPLETE_CONTENT_CAPABILITY,
  type CollectionPlanId,
} from '@data-collector/shared';

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
  publishedAt?: string;
  contentComplete?: boolean;
  contentCompletenessVersion?: string;
  contentCompletenessBuildId?: string;
  /** Stable semantic revision of the current source snapshot. */
  deliveryRevision?: string;
  /** Fixed-plan delivery intent retained until that delivery batch finalizes. */
  deliveryBatchId?: string;
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

export interface SyncEntriesOptions {
  /** Delivery scope for a pooled fixed-plan item; capture scope remains immutable. */
  deliveryBatchId?: string;
  /** Distinguishes directed delivery from the preset fixed plan for downstream curation. */
  deliveryKind?: 'nowcoder-directed';
  /** Fixed plan responsible for this delivery, including one-off captures without capture metadata. */
  deliveryPlanId?: CollectionPlanId;
  /** Persist catalog delivery state only when every requested entry succeeds. */
  atomic?: boolean;
  /** Automatic plans may treat an unchanged, reliably delivered revision as an idempotent success. */
  skipDelivered?: boolean;
}

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
  try {
    return projectOrganized(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new Error(`source.json 无效：${messageOf(error)}`);
  }
}

function assertZsxqSourceMatchesCatalog(
  entry: LibraryCatalogEntry,
  organized: OrganizedDocument,
): void {
  if (entry.source !== 'zsxq') return;
  const document = organized?.document;
  const metadata = document?.sourceMetadata;
  let sourceId: string | undefined;
  let catalogId: string | undefined;
  try {
    sourceId = typeof document?.canonicalUrl === 'string'
      ? stableContentId(document.canonicalUrl)
      : undefined;
    catalogId = stableContentId(entry.url);
  } catch {
    // The single generic error below is intentionally actionable and does not leak parser details.
  }
  if (
    document?.source !== 'zsxq'
    || document.url !== entry.url
    || document.canonicalUrl !== entry.url
    || sourceId !== entry.id
    || catalogId !== entry.id
    || document.truncated !== false
    || metadata?.contentCompletenessVersion !== ZSXQ_COMPLETE_CONTENT_CAPABILITY
    || metadata.contentCompletenessVersion !== entry.contentCompletenessVersion
    || typeof metadata.contentCompletenessBuildId !== 'string'
    || metadata.contentCompletenessBuildId.length === 0
    || metadata.contentCompletenessBuildId !== entry.contentCompletenessBuildId
  ) {
    throw new Error('source.json 与目录中的知识星球正文完整性证明不一致；请重新采集这一条');
  }
}

function sameCatalogRevision(
  current: LibraryCatalogEntry,
  snapshot: LibraryCatalogEntry,
): boolean {
  return current.source === snapshot.source
    && current.title === snapshot.title
    && current.url === snapshot.url
    && current.category === snapshot.category
    && current.relativePath === snapshot.relativePath
    && current.updatedAt === snapshot.updatedAt
    && current.publishedAt === snapshot.publishedAt
    && current.contentComplete === snapshot.contentComplete
    && current.contentCompletenessVersion === snapshot.contentCompletenessVersion
    && current.contentCompletenessBuildId === snapshot.contentCompletenessBuildId
    && current.deliveryRevision === snapshot.deliveryRevision;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function deliveredRevisionStillCurrent(
  root: string,
  entryId: string,
  sinkId: string,
  revision: string,
): Promise<boolean> {
  return withCatalogTransaction(root, async () => {
    const latest = await readCatalog(root);
    const current = latest.find(entry => entry.id === entryId);
    if (
      !current
      || current.deliveryRevision !== revision
      || current.sync?.target !== sinkId
      || !isDelivered(current.sync)
    ) return false;
    const organized = await readOrganized(root, current);
    assertZsxqSourceMatchesCatalog(current, organized);
    return deliveryRevision(organized) === revision;
  });
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
  options: SyncEntriesOptions = {},
): Promise<SyncOutcome> {
  if (ids.length === 0) return { synced: 0, failed: 0, entries: [] };
  const catalog = await readCatalog(root);
  const wanted = new Set(ids);
  const results: SyncOutcome['entries'] = [];
  const changedIds = new Set<string>();

  for (const entry of catalog) {
    if (!wanted.has(entry.id)) continue;
    // 知识星球历史数据里有「明确截断」与「旧版未记录完整性」两种情形。
    // 两者都不能进交付 sink；留在 pending 队列，供新版重采后收敛为 true。
    if (
      entry.source === 'zsxq'
      && (
        entry.contentComplete !== true
        || entry.contentCompletenessVersion !== ZSXQ_COMPLETE_CONTENT_CAPABILITY
      )
    ) {
      const sync: SyncInfo = {
        state: 'failed',
        at: now(),
        error: '知识星球正文尚未确认完整，已阻止同步；请用新版重新采集该条',
      };
      entry.sync = sync;
      changedIds.add(entry.id);
      results.push({ id: entry.id, title: entry.title, sync });
      continue;
    }
    const sink = resolveTarget(entry.source);
    if (!sink) {
      const sync: SyncInfo = {
        state: 'failed',
        at: now(),
        error: `没有为「${entry.source}」配置同步去向`,
      };
      entry.sync = sync;
      changedIds.add(entry.id);
      results.push({ id: entry.id, title: entry.title, sync });
      continue;
    }
    try {
      const organized = await readOrganized(root, entry);
      assertZsxqSourceMatchesCatalog(entry, organized);
      if (
        options.skipDelivered
        && typeof entry.deliveryRevision === 'string'
        && entry.deliveryRevision.length > 0
        && entry.sync?.target === sink.id
        && isDelivered(entry.sync)
      ) {
        let confirmed = false;
        try {
          confirmed = deliveryRevision(organized) === entry.deliveryRevision
            && await deliveredRevisionStillCurrent(
              root,
              entry.id,
              sink.id,
              entry.deliveryRevision,
            );
        } catch {
          confirmed = false;
        }
        if (!confirmed) {
          const sync: SyncInfo = {
            state: 'failed',
            target: sink.id,
            at: now(),
            error: '本机快照与已投递版本不一致，已停止使用旧回执；请重新采集后重试',
          };
          results.push({ id: entry.id, title: entry.title, sync });
          continue;
        }
        results.push({ id: entry.id, title: entry.title, sync: { ...entry.sync } });
        continue;
      }
      const captureBatchId = organized.document.sourceMetadata?.batchId;
      const delivered = options.deliveryBatchId
        ? {
            ...organized,
            document: {
              ...organized.document,
              sourceMetadata: {
                ...(organized.document.sourceMetadata ?? {}),
                ...(typeof captureBatchId === 'string'
                  ? { sourceBatchId: captureBatchId }
                  : {}),
                ...(options.deliveryPlanId ? { planId: options.deliveryPlanId } : {}),
                ...(options.deliveryKind ? { deliveryKind: options.deliveryKind } : {}),
                deliveryBatchId: options.deliveryBatchId,
              },
            },
          }
        : organized;
      const result = await sink.save(delivered);
      const detail = (result.detail ?? {}) as {
        committed?: boolean;
        pushed?: boolean;
        commitFailed?: boolean;
        pushFailed?: boolean;
        gitWarning?: string;
      };
      /*
       * 「同步成功」= 内容真的到了 Agent 读得到的地方。三种情况都不算成功：
       *
       * - sink 自己报失败；
       * - add / commit 失败——这条根本没进仓库（实测：git 跑不起来时 16 条全失败，
       *   却显示「已同步 16 条」）；
       * - **push 失败**——用户的 Agent 是从 GitHub 读收件箱的，只提交到本机仓库
       *   等于没送到。他真在 Agent 里问「处理收件箱」，得到的是「没有新的」，
       *   而侧栏那边二十条全绿。这一条按用户明确要求改成失败（原先只当告警）。
       *
       * 失败的条目会留在「未同步」里，点一次同步就重试——绝不让人以为已经送到了。
       */
      const sync: SyncInfo = {
        state: result.ok && !detail.commitFailed && !detail.pushFailed ? 'synced' : 'failed',
        target: sink.id,
        at: now(),
        ...(detail.committed !== undefined ? { committed: detail.committed } : {}),
        ...(detail.pushed !== undefined ? { pushed: detail.pushed } : {}),
        ...(detail.pushFailed ? { pushFailed: true } : {}),
        ...(detail.gitWarning ? { error: detail.gitWarning } : {}),
      };
      entry.sync = sync;
      changedIds.add(entry.id);
      if (sync.state === 'synced' && options.deliveryBatchId) {
        entry.deliveryBatchId = options.deliveryBatchId;
      }
      results.push({ id: entry.id, title: entry.title, sync });
    } catch (error) {
      const sync: SyncInfo = { state: 'failed', target: sink.id, at: now(), error: messageOf(error) };
      entry.sync = sync;
      changedIds.add(entry.id);
      results.push({ id: entry.id, title: entry.title, sync });
    }
  }

  if (changedIds.size > 0 && (!options.atomic || results.every(item => item.sync.state === 'synced'))) {
    const snapshots = new Map(catalog.map(entry => [entry.id, entry]));
    await withCatalogTransaction(root, async () => {
      const latest = await readCatalog(root);
      for (const current of latest) {
        const update = snapshots.get(current.id);
        if (!update || !changedIds.has(current.id) || !sameCatalogRevision(current, update)) continue;
        if (update.sync) current.sync = { ...update.sync };
        else delete current.sync;
        if (update.deliveryBatchId) current.deliveryBatchId = update.deliveryBatchId;
        else delete current.deliveryBatchId;
      }
      await atomicWriteText(root, catalogPathOf(root), `${JSON.stringify(latest, null, 2)}\n`);
    });
  }
  return {
    synced: results.filter(item => item.sync.state === 'synced').length,
    failed: results.filter(item => item.sync.state === 'failed').length,
    entries: results,
  };
}

/**
 * 这一条真的送到 Agent 读得到的地方了吗。
 *
 * **「已提交但没推上去」不算送到。** 用户的 Agent 从远端读收件箱，只提交到本机
 * 仓库等于没送到——这是他定下的口径：全部推送上去才算同步完成。
 *
 * 还要顾及 0.3.14 之前写下的旧记录：那时推送失败只算告警，条目被记成
 * `synced` + `pushed: false`。不在这里归一的话，那批条目既不算已完成也不进
 * 待办队列，「同步未同步的」一条都展开不出来，用户想补推却没有入口。
 */
export function isDelivered(sync: SyncInfo | undefined): boolean {
  if (sync?.state !== 'synced') return false;
  // `pushed: false` 有两种含义，**绝不能一概当没送到**：
  // 推了但失败（有 pushFailed 或错误说明）；以及压根没配置要推（什么都没有）。
  // 后者是有意为之的配置，条目就在本机仓库工作区，算送到了。
  return !sync.pushFailed && !(sync.pushed === false && Boolean(sync.error));
}

/** 尚未送达（未同步、失败、以及已提交但没推上去）的条目 id，供「同步全部未同步」展开使用。 */
export async function pendingIds(root: string, deliveryBatchId?: string): Promise<string[]> {
  return (await readCatalog(root))
    .filter(entry =>
      !isDelivered(entry.sync)
      || (deliveryBatchId !== undefined && entry.deliveryBatchId === deliveryBatchId))
    .map(entry => entry.id);
}
