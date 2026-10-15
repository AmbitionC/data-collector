import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { canonicalNowcoderDetailUrl } from '../feJourney/nowcoderSearchRecord.js';
import { contentFingerprint } from '../feJourney/fingerprint.js';
import { readSafeInterviewFile } from './outsideInterviewHistory.js';

const runFile = promisify(execFile);
const HEX64 = /^[a-f0-9]{64}$/u, HEX40 = /^[a-f0-9]{40}$/u, HEX16 = /^[a-f0-9]{16}$/u, ID = /^[a-f0-9]{12}$/u;
const STATUSES = new Set(['published', 'prepared', 'merged', 'skipped', 'retired', 'needs_review']);
const GRADES = new Set(['A', 'B', 'C', 'B-partial']);
const MAX_ENTRIES = 10_000;
type RecordValue = Record<string, unknown>;
export interface IdentityProjectionIssue { code: string; articleKey?: string; sourceId?: string; recovery: string }
export interface ProjectedNowcoderIdentity {
  id: string; url: string; contentHash: string; clusterId: string;
  status: string; evidenceGrade: string; origin: 'capture' | 'recorded';
  originalSha256?: string; normalizedBodySha256?: string; rawRecord: RecordValue;
}
export interface IdentityProjectionAudit {
  complete: boolean; publishedCommit: string; identities: ProjectedNowcoderIdentity[];
  articles: Array<{ articleKey: string; path: string; sha256: string; sourceIds: string[]; bindingVerified: boolean }>;
  issues: IdentityProjectionIssue[];
}
export class NowcoderIdentityProjectionError extends Error {
  constructor(public readonly code: 'PROJECTION_INVALID' | 'PROJECTION_STALE' | 'PROJECTION_INCOMPLETE', message: string,
    public readonly issues: IdentityProjectionIssue[] = []) { super(message); this.name = 'NowcoderIdentityProjectionError'; }
}
function invalid(message: string): never { throw new NowcoderIdentityProjectionError('PROJECTION_INVALID', message); }
function stale(message: string): never { throw new NowcoderIdentityProjectionError('PROJECTION_STALE', message); }
function object(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('projection object is invalid');
  return value as RecordValue;
}
function fields(value: RecordValue, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid('unexpected identity projection field');
}
function string(value: unknown): string { if (typeof value !== 'string' || !value.trim()) invalid('missing projection string'); return value; }
function hash(value: unknown, pattern = HEX64): string { const text = string(value); if (!pattern.test(text)) invalid('invalid typed identity hash'); return text; }
function array(value: unknown): unknown[] { if (!Array.isArray(value) || value.length > MAX_ENTRIES) invalid('projection array limit/shape invalid'); return value; }
function sourceIds(value: unknown): string[] {
  const ids = array(value).map(id => hash(id, ID));
  if (!ids.length || new Set(ids).size !== ids.length) invalid('invalid/duplicate source aliases'); return ids;
}
function same(left: readonly string[], right: readonly string[]): boolean { return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort()); }
function path(value: unknown): string {
  const result = string(value);
  if (isAbsolute(result) || result.includes('\\') || result.includes('\0') || result.split('/').some(part => !part || part === '.' || part === '..')) invalid('unsafe publication path');
  return result;
}
function url(value: unknown): string {
  const text = string(value); let parsed: URL;
  try { parsed = new URL(text); } catch { return invalid('invalid source URL'); }
  if (parsed.username || parsed.password || parsed.port) invalid('source URL contains credentials or port');
  const canonical = canonicalNowcoderDetailUrl(text); if (!canonical) invalid('unsupported source URL'); return canonical;
}
function json(bytes: Buffer): unknown { try { return JSON.parse(bytes.toString('utf8')) as unknown; } catch { return invalid('identity input is invalid JSON'); } }
function timestamp(value: unknown): string { const text = string(value); if (!Number.isFinite(Date.parse(text))) invalid('invalid identity timestamp'); return text; }
function normalizedBody(text: string): string { return text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '').normalize('NFKC').replace(/\s/gu, ''); }
function leaves(value: unknown): Map<string, string> {
  const result = new Map<string, string>(), paths = new Set<string>(); let visited = 0;
  const walk = (nodes: unknown[]): void => {
    for (const node of nodes) {
      if (++visited > MAX_ENTRIES) invalid('published tree exceeds entry limit');
      const item = object(node), key = string(item.key);
      if (item.isLeaf === true) {
        if (key.includes('/') || key.includes('\\') || key === '.' || key === '..') invalid('invalid article key');
        const file = `interview/${path(item.filePath)}/${key}.md`;
        if (result.has(key) || paths.has(file) || item.children !== undefined) invalid('duplicate published leaf');
        result.set(key, file); paths.add(file);
      } else walk(array(item.children));
    }
  }; walk(array(value)); return result;
}

/** A projection is an identity index, never editorial permission or a pending-stock contribution. */
export async function auditNowcoderIdentityProjection(resourceRoot: string, projectionPath: string,
  expectedPublishedCommit?: string): Promise<IdentityProjectionAudit> {
  const root = await realpath(resourceRoot);
  const privateCache = new Map<string, Promise<{ value: unknown; sha256: string }>>();
  const privateJson = async (filename: string, expected?: string) => {
    let pending = privateCache.get(filename);
    if (!pending) {
      pending = readSafeInterviewFile(root, filename).then(file => ({ value: json(file.bytes), sha256: file.sha256 }));
      privateCache.set(filename, pending);
    }
    const value = await pending;
    if (expected !== undefined && value.sha256 !== hash(expected)) invalid('private evidence file SHA256 mismatch');
    return value.value;
  };
  const projection = object(await privateJson(projectionPath));
  fields(projection, ['schemaVersion', 'kind', 'generatedAt', 'rawHistory', 'published', 'bindings']);
  if (projection.schemaVersion !== 2 || projection.kind !== 'nowcoder-identity-projection') invalid('unsupported identity projection version/kind');
  timestamp(projection.generatedAt);
  const publication = object(projection.published); fields(publication, ['commit', 'treeSha256']);
  const commit = hash(publication.commit, HEX40);
  if (!expectedPublishedCommit || !HEX40.test(expectedPublishedCommit) || expectedPublishedCommit !== commit) stale('explicit expected publication commit is missing or stale');
  const treeFile = await readSafeInterviewFile(root, join(root, 'interview/_tree.json'), 'inside');
  if (treeFile.sha256 !== hash(publication.treeSha256)) stale('published interview tree SHA256 changed');
  let hasGit = false;
  try { const metadata = await lstat(join(root, '.git')); if (metadata.isSymbolicLink()) invalid('symbolic git authority'); hasGit = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (hasGit) {
    const actual = await runFile('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 5000, maxBuffer: 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    if (actual.stdout.trim() !== commit) stale('published checkout HEAD differs from expected commit');
  } else {
    const marker = object(json((await readSafeInterviewFile(root, join(root, '.collector-published-snapshot.json'), 'inside')).bytes));
    fields(marker, ['schemaVersion', 'commit', 'treeSha256']);
    if (marker.schemaVersion !== 1 || marker.commit !== commit || marker.treeSha256 !== treeFile.sha256) stale('published snapshot authority differs from expected commit/tree');
  }
  const rawRef = object(projection.rawHistory); fields(rawRef, ['path', 'sha256']);
  const raw = object(await privateJson(string(rawRef.path), hash(rawRef.sha256)));
  if (raw.schemaVersion !== 1) invalid('raw history schema unsupported'); timestamp(raw.updatedAt);
  const records = object(raw.records), entries = Object.entries(records);
  if (entries.length > MAX_ENTRIES) invalid('source history exceeds entry limit');
  const identities: ProjectedNowcoderIdentity[] = [];
  for (const [id, value] of entries) {
    hash(id, ID); const item = object(value), canonical = url(item.url);
    const status = string(item.status), evidenceGrade = string(item.evidenceGrade);
    if (item.source !== 'nowcoder' || !STATUSES.has(status) || !GRADES.has(evidenceGrade)) invalid('raw status/grade/source is invalid');
    timestamp(item.processedAt);
    let contentHash: string, clusterId: string, origin: 'capture' | 'recorded' = 'recorded', originalSha256: string | undefined, normalizedBodySha256: string | undefined;
    if (item.originalBodyEvidenceFile !== undefined) {
      originalSha256 = hash(item.originalBodySha256);
      const evidence = object(await privateJson(string(item.originalBodyEvidenceFile), originalSha256));
      if (item.originalBodyDocumentJson !== true) invalid('capture evidence format is unsupported');
      const document = object(evidence.document), capture = object(document.feJourney);
      if (document.source !== 'nowcoder' || url(document.canonicalUrl ?? document.url) !== canonical) invalid('capture source URL mismatch');
      const text = string(document.text); contentHash = hash(capture.contentHash, HEX16); clusterId = string(capture.clusterId);
      if (contentFingerprint(text) !== contentHash) invalid('captured runtime fingerprint does not match original text');
      if ((item.contentHash !== undefined && item.contentHash !== contentHash) || (item.clusterId !== undefined && item.clusterId !== clusterId)) invalid('recorded identity disagrees with capture');
      normalizedBodySha256 = createHash('sha256').update(normalizedBody(text)).digest('hex');
      if (item.normalizedBodySha256 !== undefined && normalizedBodySha256 !== hash(item.normalizedBodySha256)) invalid('normalized source body SHA256 mismatch');
      origin = 'capture';
    } else {
      contentHash = hash(item.contentHash, HEX16); clusterId = string(item.clusterId);
    }
    identities.push({ id, url: canonical, contentHash, clusterId, status, evidenceGrade,
      origin, ...(originalSha256 ? { originalSha256 } : {}), ...(normalizedBodySha256 ? { normalizedBodySha256 } : {}), rawRecord: structuredClone(item) });
  }
  const identityById = new Map(identities.map(item => [item.id, item]));
  const recordedReviewMatches = async (identity: ProjectedNowcoderIdentity, key: string, articleSha256: string): Promise<boolean> => {
    const item = identity.rawRecord;
    // Reuse existing approval only for its exact recorded/current version; drafts and partial
    // records require an explicit association review and never inherit publication eligibility.
    if (item.status !== 'published' || !['A', 'B'].includes(identity.evidenceGrade)
      || (item.privateReviewStatus !== undefined && item.privateReviewStatus !== 'approved')) return false;
    if (item.editorialReview && typeof item.editorialReview === 'object' && !Array.isArray(item.editorialReview)) {
      const review = object(item.editorialReview);
      if (review.contentSha256 === articleSha256 && review.decision === 'publishable_with_source_limits'
        && review.editorialEvidenceGrade === item.evidenceGrade) {
        timestamp(review.reviewedAt); string(review.reason);
        if (review.fiveGates !== undefined) {
          const gates = object(review.fiveGates), names = ['correctness', 'timeliness', 'evidence', 'comprehensibility', 'interviewTransfer'];
          if (!same(Object.keys(gates), names) || names.some(name => gates[name] !== 'passed')) return false;
        }
        return true;
      }
    }
    if (item.privateReviewStatus !== 'approved' || item.reviewedArticleSha256 !== articleSha256
      || !item.privateReviewReceiptFile || !item.privateReviewReceiptSha256) return false;
    const receipt = object(await privateJson(string(item.privateReviewReceiptFile), hash(item.privateReviewReceiptSha256)));
    if (receipt.schemaVersion !== 1 || receipt.contentConclusion !== 'pass_after_repairs_for_reviewed_scope') return false;
    string(receipt.reviewer); timestamp(receipt.reviewedAtUTC);
    const entries = array(receipt.interviews).map(object), matches = entries.filter(entry => entry.key === key);
    if (matches.length !== 1) return false;
    const entry = matches[0]!, file = object(entry.file);
    if (entry.verdict !== 'pass_after_repairs' || entry.questionCoverage !== 'pass'
      || entry.originalDocumentTextByteMatch !== 'pass' || file.sha256 !== articleSha256) return false;
    const original = object(entry.frozenOriginal);
    const frozen = await readSafeInterviewFile(root, string(original.path));
    return frozen.sha256 === hash(original.sha256)
      && createHash('sha256').update(normalizedBody(frozen.bytes.toString('utf8'))).digest('hex') === identity.normalizedBodySha256;
  };
  const leafMap = leaves(json(treeFile.bytes));
  const issues: IdentityProjectionIssue[] = [], articles: IdentityProjectionAudit['articles'] = [];
  const bindings = new Map<string, RecordValue>();
  for (const value of array(projection.bindings)) {
    const binding = object(value); fields(binding, ['articleKey', 'path', 'articleSha256', 'sourceIds', 'review']);
    const key = string(binding.articleKey);
    if (bindings.has(key) || !leafMap.has(key)) invalid('duplicate or unknown projected article binding'); bindings.set(key, binding);
  }
  for (const [key, file] of leafMap) {
    const publicFile = await readSafeInterviewFile(root, join(root, file), 'inside');
    if (!publicFile.bytes.toString('utf8').trim()) invalid('published article is empty');
    const binding = bindings.get(key);
    const actualIds = entries.filter(([, value]) => {
      const item = object(value); return item.articleKey === key || (Array.isArray(item.publicFiles) && item.publicFiles.includes(file));
    }).map(([id]) => id);
    const article = { articleKey: key, path: file, sha256: publicFile.sha256, sourceIds: actualIds, bindingVerified: false }; articles.push(article);
    const issue = (code: string, recovery: string): void => { issues.push({ code, articleKey: key, recovery }); };
    if (!binding) { issue('MISSING_BINDING', 'Recover an explicit current article/source mapping and a pinned binding-review receipt.'); continue; }
    if (path(binding.path) !== file || hash(binding.articleSha256) !== publicFile.sha256) stale(`current article path/body changed: ${key}`);
    const ids = sourceIds(binding.sourceIds);
    if (!same(ids, actualIds)) { issue('SOURCE_ALIAS_MISMATCH', 'Restore every source alias recorded for this article; do not drop or invent one.'); continue; }
    if (ids.some(id => identityById.get(id)?.origin !== 'capture')) { issue('MISSING_FROZEN_CAPTURE', 'Recover each bound source original and its real capture identity before binding review.'); continue; }
    const review = object(binding.review);
    if (review.status === 'pending') { fields(review, ['status', 'reason']); issue('PENDING_BINDING_REVIEW', string(review.reason)); continue; }
    if (review.status === 'recorded') {
      fields(review, ['status', 'basis']);
      if (review.basis !== 'raw-history') invalid('unsupported recorded review basis');
      let verified = true;
      for (const id of ids) {
        try { if (!await recordedReviewMatches(identityById.get(id)!, key, publicFile.sha256)) verified = false; }
        catch { verified = false; }
      }
      if (!verified) issue('RECORDED_REVIEW_NOT_CURRENT', 'Recover the pinned existing receipt/original for this exact article version, or perform a real current association review. Do not promote prepared/partial records.');
      else article.bindingVerified = true;
      continue;
    }
    if (review.status !== 'verified') invalid('unknown binding review status'); fields(review, ['status', 'receipt']);
    const ref = object(review.receipt); fields(ref, ['path', 'sha256']);
    const receipt = object(await privateJson(string(ref.path), hash(ref.sha256)));
    fields(receipt, ['schemaVersion', 'kind', 'reviewer', 'reviewedAt', 'entries']);
    if (receipt.schemaVersion !== 1 || receipt.kind !== 'nowcoder-source-binding-review') invalid('binding receipt format unsupported');
    string(receipt.reviewer); timestamp(receipt.reviewedAt);
    const receiptEntries = array(receipt.entries).map(object);
    if (new Set(receiptEntries.map(entry => string(entry.articleKey))).size !== receiptEntries.length) invalid('duplicate review receipt article');
    const approved = receiptEntries.find(entry => entry.articleKey === key);
    if (!approved) { issue('MISSING_REVIEW_ENTRY', 'Recover the actual review receipt entry for this current article hash.'); continue; }
    fields(approved, ['articleKey', 'path', 'articleSha256', 'sourceIds', 'sourceSha256', 'decision', 'reason']);
    string(approved.reason);
    const originalHashes = object(approved.sourceSha256);
    if (approved.path !== file || approved.articleSha256 !== publicFile.sha256 || !same(sourceIds(approved.sourceIds), ids)
      || !same(Object.keys(originalHashes), ids) || ids.some(id => originalHashes[id] !== identityById.get(id)?.originalSha256)) {
      issue('STALE_BINDING_RECEIPT', 'Re-review current article bytes against the exact frozen source aliases; retain original status/grade.'); continue;
    }
    if (approved.decision !== 'verified') { issue('UNAPPROVED_BINDING', 'Complete the missing source-to-current-article binding review.'); continue; }
    article.bindingVerified = true;
  }
  return { complete: issues.length === 0, publishedCommit: commit, identities, articles, issues };
}

export async function loadNowcoderIdentityProjection(resourceRoot: string, projectionPath: string, expectedPublishedCommit?: string): Promise<IdentityProjectionAudit> {
  const audit = await auditNowcoderIdentityProjection(resourceRoot, projectionPath, expectedPublishedCommit);
  if (!audit.complete) throw new NowcoderIdentityProjectionError('PROJECTION_INCOMPLETE',
    `published identity bindings incomplete (${audit.issues.length}); qualified pending inventory is unknown`, audit.issues);
  return audit;
}
