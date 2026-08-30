import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { z } from 'zod';
import {
  stableContentId,
  type CollectedDocument,
  type JobRecord,
  type NowcoderDirectedAttentionCode,
} from '@data-collector/shared';
import { deliveryRevision } from '../library/deliveryRevision.js';
import {
  projectOrganized,
  storedOrganizedDocumentSchema,
} from '../library/storedDocument.js';
import type { NowcoderDirectedReconciliationSnapshot } from './store.js';

const hash16 = z.string().regex(/^[a-f0-9]{16}$/u);
const hash64 = z.string().regex(/^[a-f0-9]{64}$/u);
const localCatalogEntrySchema = z.object({
  id: z.string().min(1),
  source: z.enum(['wechat', 'zsxq', 'nowcoder', 'github']),
  title: z.string(),
  url: z.string().url(),
  category: z.string(),
  relativePath: z.string().min(1),
  updatedAt: z.string(),
  publishedAt: z.string().optional(),
  contentComplete: z.boolean().optional(),
  contentCompletenessVersion: z.string().optional(),
  contentCompletenessBuildId: z.string().optional(),
  deliveryRevision: hash64.optional(),
  deliveryBatchId: z.string().optional(),
  sync: z.object({
    state: z.enum(['pending', 'synced', 'failed']),
    target: z.string().optional(),
    at: z.string().optional(),
    committed: z.boolean().optional(),
    pushed: z.boolean().optional(),
    pushFailed: z.boolean().optional(),
    error: z.string().optional(),
  }).strict().optional(),
}).strict();
const localCatalogSchema = z.array(localCatalogEntrySchema);

const candidateEntrySchema = z.object({
  id: z.string().min(1),
  source: z.enum(['nowcoder', 'github']),
  url: z.string().url(),
  contentHash: hash16,
  simHash: hash16,
  questionHash: hash16.optional(),
  company: z.string().optional(),
  authorKey: z.string().optional(),
  evidenceGrade: z.string().optional(),
  questionCount: z.number().optional(),
  clusterId: z.string().min(1),
  representativeId: z.string().min(1),
  qualityScore: z.number(),
  projectScore: z.number().optional(),
  updatedAt: z.string(),
}).strict();
const candidateCatalogSchema = z.object({
  version: z.literal(1),
  entries: z.array(candidateEntrySchema),
}).strict();

export class NowcoderDirectedDocumentError extends Error {
  constructor(public readonly code: Extract<NowcoderDirectedAttentionCode,
    'DIRECTED_LOCAL_LIBRARY_CORRUPT' | 'DIRECTED_CANDIDATE_CATALOG_CORRUPT'>) {
    super(code === 'DIRECTED_LOCAL_LIBRARY_CORRUPT'
      ? '本地面经库无法安全读取'
      : '候选目录无法安全读取');
    this.name = 'NowcoderDirectedDocumentError';
  }
}

export interface LoadedNowcoderDirectedDocument {
  job: JobRecord;
  document: CollectedDocument;
}

export interface InvalidNowcoderDirectedDocument {
  job: JobRecord;
  detail: string;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep));
}

async function strictFile(root: string, path: string): Promise<string> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('not a regular file');
  const canonical = await realpath(path);
  if (!inside(root, canonical)) throw new Error('path escaped root');
  return canonical;
}

async function readCatalog<T>(
  root: string,
  path: string,
  schema: z.ZodType<T>,
  code: NowcoderDirectedDocumentError['code'],
): Promise<T> {
  try {
    return schema.parse(JSON.parse(await readFile(await strictFile(root, path), 'utf8')) as unknown);
  } catch {
    throw new NowcoderDirectedDocumentError(code);
  }
}

export async function loadNowcoderDirectedDocuments(input: {
  libraryRoot: string;
  run: NowcoderDirectedReconciliationSnapshot;
  jobs: readonly JobRecord[];
}): Promise<{
  loaded: LoadedNowcoderDirectedDocument[];
  invalid: InvalidNowcoderDirectedDocument[];
  detailSaved: number;
}> {
  const expected = new Map(input.run.frozenCandidates.slice(0, input.run.candidateCursor).map((candidate, index) => [
    input.run.currentJobIds[index], candidate,
  ]));
  const exactSavedJobs = input.jobs.filter(job => {
    const candidate = expected.get(job.id);
    return Boolean(candidate
      && job.status === 'saved'
      && job.markdownOutput?.sinkId === 'markdown'
      && job.directedRunId === input.run.id
      && job.directedRunAttempt === input.run.attempt
      && job.url === candidate.canonicalUrl);
  });
  const detailSaved = exactSavedJobs.length;
  if (detailSaved === 0) return { loaded: [], invalid: [], detailSaved };
  let root: string;
  try {
    root = await realpath(input.libraryRoot);
    if (!(await lstat(root)).isDirectory()) throw new Error('root is not a directory');
  } catch {
    throw new NowcoderDirectedDocumentError('DIRECTED_LOCAL_LIBRARY_CORRUPT');
  }
  const localCatalog = await readCatalog(
    root,
    join(root, '_catalog', 'index.json'),
    localCatalogSchema,
    'DIRECTED_LOCAL_LIBRARY_CORRUPT',
  );
  const candidateCatalog = await readCatalog(
    root,
    join(root, '_catalog', 'fe-journey.json'),
    candidateCatalogSchema,
    'DIRECTED_CANDIDATE_CATALOG_CORRUPT',
  );
  const loaded: LoadedNowcoderDirectedDocument[] = [];
  const invalid: InvalidNowcoderDirectedDocument[] = [];
  for (const job of exactSavedJobs) {
    const reject = (detail: string): void => { invalid.push({ job, detail }); };
    const candidate = expected.get(job.id);
    const markdownOutput = job.markdownOutput;
    if (!candidate || !markdownOutput) continue;
    const id = stableContentId(job.url);
    const local = localCatalog.find(entry => entry.id === id);
    const indexed = candidateCatalog.entries.find(entry => entry.id === id);
    if (!local || !indexed) {
      reject('目录缺少当前任务的精确条目');
      continue;
    }
    try {
      if (local.source !== 'nowcoder' || local.url !== job.url || !local.deliveryRevision
        || indexed.source !== 'nowcoder' || indexed.url !== job.url) throw new Error('catalog identity mismatch');
      const markdownPath = await strictFile(root, join(root, local.relativePath));
      const checkpointedPath = await strictFile(root, markdownOutput.outputPath);
      if (markdownPath !== checkpointedPath) throw new Error('markdown output mismatch');
      const sourcePath = await strictFile(root, join(dirname(markdownPath), 'source.json'));
      const stored = storedOrganizedDocumentSchema.parse(
        JSON.parse(await readFile(sourcePath, 'utf8')) as unknown,
      );
      const organized = projectOrganized(stored);
      const document = organized.document;
      const evidence = stored.localEvidence?.nowcoderDirected;
      const revision = deliveryRevision(organized);
      const representativeId = document.feJourney?.duplicateOf ?? id;
      if (
        document.source !== 'nowcoder'
        || document.canonicalUrl !== job.url
        || stableContentId(document.canonicalUrl) !== id
        || document.feJourney?.contentHash !== indexed.contentHash
        || document.feJourney.clusterId !== indexed.clusterId
        || indexed.representativeId !== representativeId
        || evidence?.runId !== input.run.id
        || evidence.attempt !== input.run.attempt
        || evidence.currentJobId !== job.id
        || evidence.stableContentId !== id
        || evidence.canonicalUrl !== job.url
        || evidence.contentHash !== indexed.contentHash
        || evidence.clusterId !== indexed.clusterId
        || evidence.deliveryRevision !== revision
        || local.deliveryRevision !== revision
      ) throw new Error('snapshot lineage mismatch');
      loaded.push({ job, document });
    } catch {
      reject('本机来源快照与当前任务证据不一致');
    }
  }
  return { loaded, invalid, detailSaved };
}
