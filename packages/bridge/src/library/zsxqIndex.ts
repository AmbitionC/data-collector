import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import sanitizeHtml from 'sanitize-html';
import {
  collectedDocumentSchema,
  hasZsxqApiPreviewTail,
  stableContentId,
  zsxqSemanticSignature,
  ZSXQ_COMPLETE_CONTENT_CAPABILITY,
  type ZsxqLibraryIndexEntry,
} from '@data-collector/shared';
import { assertInsideRoot } from './paths.js';

interface CatalogCandidate {
  id: string;
  source: string;
  url: string;
  relativePath: string;
  contentComplete?: boolean;
  contentCompletenessVersion?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function catalogCandidate(value: unknown): CatalogCandidate | undefined {
  if (!isRecord(value) || value.source !== 'zsxq') return undefined;
  if (
    typeof value.id !== 'string'
    || typeof value.url !== 'string'
    || typeof value.relativePath !== 'string'
  ) throw new Error('知识星球目录条目字段不完整');
  if (value.contentComplete !== undefined && typeof value.contentComplete !== 'boolean') {
    throw new Error('知识星球目录正文完整性字段无效');
  }
  if (
    value.contentCompletenessVersion !== undefined
    && typeof value.contentCompletenessVersion !== 'string'
  ) throw new Error('知识星球目录正文完整性版本无效');
  return value as unknown as CatalogCandidate;
}

function trustedCompleteness(entry: CatalogCandidate): boolean | undefined {
  if (entry.contentComplete === false) return false;
  if (
    entry.contentComplete === true
    && entry.contentCompletenessVersion === ZSXQ_COMPLETE_CONTENT_CAPABILITY
  ) return true;
  return undefined;
}

function topicIdOf(url: string, metadata: Record<string, string | number | boolean | null>): string | undefined {
  const metadataId = metadata.topicId;
  if (typeof metadataId === 'string' && /^\d+$/.test(metadataId)) return metadataId;
  return new URL(url).pathname.match(/\/topic\/(\d+)(?:\/|$)/)?.[1];
}

/**
 * 星球会把关联帖标题截成 `...`，并同时放进正文行和独立链接行。
 * 这是链接标签的展示省略，不是当前帖子的正文残片。紧凑索引仍要
 * 检查真正的 API 预览尾，因此只从该次检查的文本副本里拿掉锚点标签。
 */
function withoutLinkedPreviewTitles(text: string, html: string): string {
  let body = text;
  for (const match of html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/giu)) {
    const label = sanitizeHtml(match[1] ?? '', {
      allowedTags: [],
      allowedAttributes: {},
    }).replace(/\s+/gu, ' ').trim();
    if (!/\.\.\.\s*$/u.test(label)) continue;
    body = body.split(label).join('');
  }
  return body;
}

/**
 * Builds the compact, body-free index sent to the extension before collection.
 *
 * A broken ZSXQ entry aborts the complete index. Silently omitting it would turn an
 * unreadable local record into an apparent cache miss and could archive duplicates.
 */
export async function loadZsxqLibraryIndex(root: string): Promise<ZsxqLibraryIndexEntry[]> {
  let catalogText: string;
  try {
    catalogText = await readFile(join(root, '_catalog', 'index.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`知识星球本机索引无法安全读取：${message}`);
  }
  try {
    const rawCatalog = JSON.parse(catalogText) as unknown;
    if (!Array.isArray(rawCatalog)) throw new Error('目录不是数组');
    const realRoot = await realpath(root);
    const result: ZsxqLibraryIndexEntry[] = [];
    const seenIds = new Set<string>();

    for (const rawEntry of rawCatalog) {
      const entry = catalogCandidate(rawEntry);
      if (!entry) continue;
      if (stableContentId(entry.url) !== entry.id) throw new Error(`目录身份不一致：${entry.id}`);
      if (seenIds.has(entry.id)) throw new Error(`目录存在重复身份：${entry.id}`);
      seenIds.add(entry.id);

      const markdownPath = assertInsideRoot(root, join(root, entry.relativePath));
      const sourcePath = assertInsideRoot(root, join(dirname(markdownPath), 'source.json'));
      const realSourcePath = await realpath(sourcePath);
      assertInsideRoot(realRoot, realSourcePath);
      const stored = JSON.parse(await readFile(realSourcePath, 'utf8')) as unknown;
      if (!isRecord(stored)) throw new Error(`留存快照不是对象：${entry.id}`);
      const document = collectedDocumentSchema.parse(stored.document);
      if (
        document.source !== 'zsxq'
        || document.canonicalUrl !== entry.url
        || stableContentId(document.canonicalUrl) !== entry.id
      ) throw new Error(`留存快照身份不一致：${entry.id}`);

      const metadata = document.sourceMetadata ?? {};
      const role = metadata.authorRole === 'owner' || metadata.authorRole === 'member'
        ? metadata.authorRole
        : undefined;
      const topicId = topicIdOf(entry.url, metadata);
      const contentComplete = hasZsxqApiPreviewTail(
        withoutLinkedPreviewTitles(document.text, document.html),
      )
        ? false
        : trustedCompleteness(entry);
      const compact: ZsxqLibraryIndexEntry = {
        id: entry.id,
        url: entry.url,
        ...(topicId ? { topicId } : {}),
        ...(document.publishedAt ? { publishedAt: document.publishedAt } : {}),
        ...(role ? { authorRole: role } : {}),
        ...(contentComplete === undefined ? {} : { contentComplete }),
      };
      if (document.publishedAt && role) {
        compact.semanticSignature = zsxqSemanticSignature({
          publishedAt: document.publishedAt,
          authorRole: role,
          text: document.text,
        });
      }
      result.push(compact);
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`知识星球本机索引无法安全读取：${message}`);
  }
}
