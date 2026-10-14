import { readOutsideInterviewHistory, OutsideInterviewHistoryError } from './outsideInterviewHistory.js';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalizeUrl, parseSupportedUrl, stableContentId, type CollectedDocument } from '@data-collector/shared';
import { contentFingerprint } from '../feJourney/fingerprint.js';
import type { NowcoderDiscoveryCandidate } from '../feJourney/nowcoderDiscovery.js';
import { projectOrganized } from '../library/storedDocument.js';
import { NOWCODER_COMPANIES, selectNowcoderPlanCandidates, type CompanyId } from './nowcoderPlan.js';

export type CompanyInventory = Record<CompanyId, { published: number; qualifiedPending: number }>;

export class NowcoderInventoryError extends Error {
  constructor(
    public readonly code: 'inventory-invalid' | 'inventory-unavailable' | 'inventory-unverifiable',
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${detail}`, options);
    this.name = 'NowcoderInventoryError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateCompanyOrder(value: unknown): CompanyId[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > NOWCODER_COMPANIES.length
    || value.some(company => !NOWCODER_COMPANIES.includes(company as CompanyId))
    || new Set(value).size !== value.length) {
    throw new RangeError('公司列表必须包含不重复的已知公司');
  }
  return [...value] as CompanyId[];
}

/** Missing or corrupt configured-company stock must never acquire zero priority. */
export function validateCompanyInventory(inventory: CompanyInventory, companies: readonly CompanyId[]): void {
  for (const company of companies) {
    const value = inventory?.[company];
    if (!record(value) || !Number.isSafeInteger(value.published) || (value.published as number) < 0
      || !Number.isSafeInteger(value.qualifiedPending) || (value.qualifiedPending as number) < 0
      || !Number.isSafeInteger((value.published as number) + (value.qualifiedPending as number))) {
      throw new NowcoderInventoryError('inventory-invalid', `${company} published/qualifiedPending stock is unavailable or invalid`);
    }
  }
}

function canonicalNowcoderUrl(value: string): string | undefined {
  try {
    const url = parseSupportedUrl(value);
    if (url.protocol !== 'https:' || !['nowcoder.com', 'www.nowcoder.com'].includes(url.hostname)
      || url.username || url.password || url.port
      || !/^\/(?:discuss\/\d+|feed\/main\/detail\/[A-Za-z0-9_-]+)\/?$/u.test(url.pathname)) return undefined;
    url.hostname = 'www.nowcoder.com';
    url.pathname = url.pathname.replace(/\/$/u, '');
    return canonicalizeUrl(url).href;
  } catch { return undefined; }
}

export function selectCompanyCandidates(
  candidates: readonly NowcoderDiscoveryCandidate[],
  inventory: CompanyInventory,
  order: readonly CompanyId[],
  limit: number,
): NowcoderDiscoveryCandidate[] {
  const companies = validateCompanyOrder(order);
  validateCompanyInventory(inventory, companies);
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('候选数量必须是非负整数');
  const buckets = new Map(companies.map(company => [company, [] as NowcoderDiscoveryCandidate[]]));
  const seenUrls = new Set<string>();
  for (const candidate of candidates) {
    const bucket = buckets.get(candidate.queryCompany);
    if (!bucket) continue;
    const url = canonicalNowcoderUrl(candidate.url);
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    bucket.push(candidate);
  }
  const temporary = new Map(companies.map(company => [company,
    inventory[company].published + inventory[company].qualifiedPending]));
  const selected: NowcoderDiscoveryCandidate[] = [];
  while (selected.length < limit) {
    let next: CompanyId | undefined;
    for (const company of companies) {
      if (buckets.get(company)!.length === 0) continue;
      if (next === undefined || temporary.get(company)! < temporary.get(next)!) next = company;
    }
    if (next === undefined) break;
    selected.push(buckets.get(next)!.shift()!);
    temporary.set(next, temporary.get(next)! + 1);
  }
  return selected;
}

const COMPANY_DIRECTORIES: Readonly<Record<string, CompanyId>> = Object.freeze({
  bytedance: 'bytedance', tencent: 'tencent', alibaba: 'alibaba', antfin: 'ant', ant: 'ant',
  baidu: 'other', kuaishou: 'other', oppo: 'other', pinduoduo: 'other', bilibili: 'other',
  sangfor: 'other', redbook: 'other', dji: 'other', vivo: 'other', huawei: 'other',
  moonshot: 'other', insta360: 'other',
});
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 10_000;

function invalid(detail: string): never { throw new NowcoderInventoryError('inventory-invalid', detail); }

function safeRelativePath(value: string): string {
  if (!value || isAbsolute(value) || value.includes('\\') || value.includes('\0')
    || value.split('/').some(part => !part || part === '.' || part === '..')) invalid('unsafe inventory path');
  return value;
}

async function canonicalRoot(path: string, label: string): Promise<string> {
  try {
    const root = await realpath(path);
    if (!(await lstat(root)).isDirectory()) invalid(`${label} root is not a directory`);
    return root;
  } catch (error) {
    if (error instanceof NowcoderInventoryError) throw error;
    throw new NowcoderInventoryError('inventory-unavailable', `${label} root cannot be read`, { cause: error });
  }
}

/** Read-only: reject symbolic paths rather than recovering or editing the real library. */
async function boundedFile(root: string, path: string, optional = false): Promise<string | undefined> {
  const parts = safeRelativePath(path).split('/');
  let current = root;
  try {
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
        invalid(`${path} is not a regular inventory path`);
      }
      if (index === parts.length - 1 && stat.size > MAX_FILE_BYTES) invalid(`${path} exceeds the inventory read limit`);
    }
    const physical = await realpath(current), location = relative(root, physical);
    if (location === '..' || location.startsWith(`..${sep}`) || isAbsolute(location)) invalid(`${path} escapes its inventory root`);
    const bytes = await readFile(physical);
    if (bytes.byteLength > MAX_FILE_BYTES) invalid(`${path} exceeds the inventory read limit`);
    return bytes.toString('utf8');
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof NowcoderInventoryError) throw error;
    throw new NowcoderInventoryError('inventory-unavailable', `${path} cannot be read`, { cause: error });
  }
}

async function jsonFile(root: string, path: string, optional = false): Promise<unknown> {
  const raw = await boundedFile(root, path, optional);
  if (raw === undefined) return undefined;
  try { return JSON.parse(raw) as unknown; }
  catch (error) { throw new NowcoderInventoryError('inventory-invalid', `${path} is invalid JSON`, { cause: error }); }
}

interface PublishedLeaf { key: string; file: string; company: CompanyId }

function publishedLeaves(value: unknown): PublishedLeaf[] {
  if (!Array.isArray(value)) invalid('interview/_tree.json must be a tree array');
  const leaves: PublishedLeaf[] = [], keys = new Set<string>(), files = new Set<string>();
  let visited = 0;
  const walk = (nodes: unknown[], rootCompany?: CompanyId): void => {
    for (const node of nodes) {
      if (++visited > MAX_ENTRIES || !record(node) || typeof node.key !== 'string' || !node.key) invalid('invalid interview tree node');
      const company = rootCompany ?? COMPANY_DIRECTORIES[node.key.toLowerCase()];
      if (!company) invalid(`unclassified interview company: ${node.key}`);
      if (node.isLeaf === true) {
        if (typeof node.filePath !== 'string' || node.key.includes('/') || node.key.includes('\\')) invalid('invalid interview leaf path');
        const directory = safeRelativePath(node.filePath);
        if (COMPANY_DIRECTORIES[directory.split('/')[0]!] !== company) invalid(`interview company/path mismatch: ${node.key}`);
        const file = `interview/${directory}/${node.key}.md`;
        if (keys.has(node.key) || files.has(file) || node.children !== undefined) invalid(`duplicate or invalid interview leaf: ${node.key}`);
        keys.add(node.key); files.add(file); leaves.push({ key: node.key, file, company });
      } else {
        if (!Array.isArray(node.children)) invalid(`interview branch has no children: ${node.key}`);
        walk(node.children, company);
      }
    }
  };
  walk(value);
  return leaves;
}

interface PublishedIdentities { complete: boolean; urls: Set<string>; hashes: Set<string>; clusters: Set<string> }

function publishedIdentities(value: unknown, leaves: PublishedLeaf[]): PublishedIdentities {
  const result: PublishedIdentities = { complete: leaves.length === 0, urls: new Set(), hashes: new Set(), clusters: new Set() };
  if (value === undefined) return result;
  if (!record(value) || value.schemaVersion !== 1 || !record(value.records)
    || typeof value.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value.updatedAt)) invalid('private interview source history is invalid');
  const leafByKey = new Map(leaves.map(leaf => [leaf.key, leaf]));
  const publicFiles = new Set(leaves.map(leaf => leaf.file));
  const covered = new Set<string>();
  const records = Object.entries(value.records);
  if (records.length > MAX_ENTRIES) invalid('private interview source history exceeds the inventory limit');
  for (const [id, raw] of records) {
    if (!/^[a-f0-9]{12}$/u.test(id) || !record(raw) || raw.source !== 'nowcoder'
      || typeof raw.url !== 'string' || typeof raw.contentHash !== 'string' || !/^[a-f0-9]{16}$/u.test(raw.contentHash)
      || typeof raw.clusterId !== 'string' || !raw.clusterId.trim()
      || !['A', 'B', 'C'].includes(String(raw.evidenceGrade))
      || !['published', 'prepared', 'merged', 'skipped', 'retired', 'needs_review'].includes(String(raw.status))
      || !Array.isArray(raw.publicFiles) || raw.publicFiles.some(file => typeof file !== 'string' || !file)
      || !Array.isArray(raw.knowledgeKeys) || raw.knowledgeKeys.some(key => typeof key !== 'string' || !key)
      || typeof raw.processedAt !== 'string' || !Number.isFinite(Date.parse(raw.processedAt))) invalid('private interview source history record is invalid');
    const url = canonicalNowcoderUrl(raw.url);
    if (!url) invalid('private interview source history URL is invalid');
    if (raw.status !== 'published' && raw.status !== 'merged') continue;
    if (!['A', 'B'].includes(String(raw.evidenceGrade))) invalid('published source evidence is not A/B');
    if (raw.status === 'published') {
      const leaf = typeof raw.articleKey === 'string' ? leafByKey.get(raw.articleKey) : undefined;
      if (!leaf || !raw.publicFiles.includes(leaf.file) || covered.has(leaf.key)) invalid('published source does not match one interview leaf');
      covered.add(leaf.key);
    } else if (!raw.publicFiles.some(file => publicFiles.has(file as string))) continue;
    result.urls.add(url); result.hashes.add(raw.contentHash); result.clusters.add(raw.clusterId);
  }
  result.complete = covered.size === leaves.length;
  return result;
}

async function qualifiedSnapshots(root: string, now: string): Promise<CollectedDocument[]> {
  const catalog = await jsonFile(root, '_catalog/index.json');
  if (!Array.isArray(catalog) || catalog.length > MAX_ENTRIES) invalid('local library catalog is invalid');
  const identities = new Set<string>(), paths = new Set<string>(), documents: CollectedDocument[] = [];
  for (const item of catalog) {
    if (!record(item) || typeof item.id !== 'string' || !item.id || typeof item.source !== 'string'
      || typeof item.title !== 'string' || typeof item.url !== 'string' || typeof item.category !== 'string'
      || typeof item.relativePath !== 'string' || typeof item.updatedAt !== 'string') invalid('local library catalog entry is invalid');
    if (identities.has(item.id) || paths.has(item.relativePath)) invalid('local library catalog contains duplicate identities');
    identities.add(item.id); paths.add(item.relativePath);
    safeRelativePath(item.relativePath);
    if (item.source !== 'nowcoder') continue;
    const url = canonicalNowcoderUrl(item.url);
    if (!url || item.id !== stableContentId(item.url) || !item.relativePath.endsWith('/index.md')) invalid('local Nowcoder catalog identity is invalid');
    await boundedFile(root, item.relativePath);
    const sourcePath = relative(root, join(dirname(resolve(root, item.relativePath)), 'source.json')).split(sep).join('/');
    let document: CollectedDocument;
    try { document = projectOrganized(await jsonFile(root, sourcePath)).document; }
    catch (error) {
      if (error instanceof NowcoderInventoryError) throw error;
      throw new NowcoderInventoryError('inventory-invalid', `${sourcePath} source snapshot is invalid`, { cause: error });
    }
    if (document.source !== 'nowcoder' || canonicalNowcoderUrl(document.canonicalUrl) !== url
      || canonicalNowcoderUrl(document.url) !== url) invalid('local source snapshot/catalog identity mismatch');
    const accepted = selectNowcoderPlanCandidates([document], now, 1).accepted[0];
    if (!accepted) continue;
    if (!accepted.feJourney || !/^[a-f0-9]{16}$/u.test(accepted.feJourney.contentHash)
      || !accepted.feJourney.clusterId.trim()) {
      throw new NowcoderInventoryError('inventory-unverifiable', 'qualified pending source lacks contentHash/cluster identity');
    }
    if (accepted.feJourney.contentHash !== contentFingerprint(accepted.text)) invalid('local source contentHash does not match its body');
    documents.push(accepted);
  }
  return documents.sort((left, right) =>
    (right.publishedAt ?? right.collectedAt).localeCompare(left.publishedAt ?? left.collectedAt)
    || left.canonicalUrl.localeCompare(right.canonicalUrl));
}

export async function readCompanyInventory(
  resourceRoot: string,
  libraryRoot: string,
  now: string,
  historyPath?: string,
): Promise<CompanyInventory> {
  if (!Number.isFinite(Date.parse(now))) invalid('current inventory time is invalid');
  const resource = await canonicalRoot(resourceRoot, 'resource'), library = await canonicalRoot(libraryRoot, 'local library');
  const leaves = publishedLeaves(await jsonFile(resource, 'interview/_tree.json'));
  const inventory = Object.fromEntries(NOWCODER_COMPANIES.map(company => [company,
    { published: 0, qualifiedPending: 0 }])) as CompanyInventory;
  for (const leaf of leaves) {
    if (!(await boundedFile(resource, leaf.file))!.trim()) invalid(`published interview is empty: ${leaf.key}`);
    inventory[leaf.company].published += 1;
  }
  const pending = await qualifiedSnapshots(library, now);
  const published = publishedIdentities(historyPath === undefined ? undefined : await readOutsideInterviewHistory(resource, historyPath).catch(error => {
    if (error instanceof OutsideInterviewHistoryError) throw new NowcoderInventoryError(error.code, error.message, { cause: error });
    throw error;
  }), leaves);
  if (pending.length > 0 && !published.complete) {
    throw new NowcoderInventoryError('inventory-unverifiable',
      'qualified pending stock cannot be checked against all published interviews; an explicit complete outside interview historyPath is required');
  }
  const urls = new Set(published.urls), hashes = new Set(published.hashes), clusters = new Set(published.clusters);
  const accepted: CollectedDocument[] = [];
  for (const document of pending) {
    const url = canonicalNowcoderUrl(document.canonicalUrl)!;
    const { contentHash, clusterId } = document.feJourney!;
    if (urls.has(url) || hashes.has(contentHash) || clusters.has(clusterId)) continue;
    // The selector has a ten-item target. Pairwise checks preserve its sequence-dedupe
    // rule across the entire inventory, without truncating the pending stock to ten.
    if (accepted.some(previous => selectNowcoderPlanCandidates([previous, document], now, 2).accepted.length < 2)) continue;
    const company = document.sourceMetadata?.company as CompanyId;
    if (!NOWCODER_COMPANIES.includes(company)) invalid('qualified pending source has no grounded company');
    inventory[company].qualifiedPending += 1;
    urls.add(url); hashes.add(contentHash); clusters.add(clusterId); accepted.push(document);
  }
  return inventory;
}
