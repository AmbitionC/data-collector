import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { operationDraftImportSchema, operationSourceUrlSchema, stableContentId } from '@data-collector/shared';
import { atomicWriteText } from '../library/writer.js';
import { HttpError } from '../server/http.js';
export const workflowKey = z.string().regex(/^[a-zA-Z0-9_-]{12,100}$/u);
const candidate = z.object({ sourceId: z.string().regex(/^[a-f0-9]{12}$/u), url: operationSourceUrlSchema }).strict()
  .refine(c => stableContentId(c.url) === c.sourceId, '来源ID必须与规范URL一致');
export const workflowRequestSchema = z.discriminatedUnion('kind', [
  z.object({ schemaVersion: z.literal(1), key: workflowKey, kind: z.literal('search'), queries: z.array(z.string().trim().min(1).max(100)).min(1).max(3), limitPerQuery: z.number().int().min(1).max(20).default(8) }).strict(),
  z.object({ schemaVersion: z.literal(1), key: workflowKey, kind: z.literal('prepare'), candidates: z.array(candidate).min(1).max(8), maxPages: z.number().int().min(1).max(3).default(2) }).strict(),
  z.object({ schemaVersion: z.literal(1), key: workflowKey, kind: z.literal('publish'), items: z.array(z.object({ key: workflowKey, draft: operationDraftImportSchema }).strict()).min(1).max(5) }).strict(),
]).superRefine((request, ctx) => {
  const identities = request.kind === 'publish' ? request.items.map(i => i.draft.opportunityId) : request.kind === 'prepare' ? request.candidates.map(c => c.url) : [];
  if (new Set(identities).size !== identities.length || (request.kind === 'publish' && new Set(request.items.map(i => i.key)).size !== request.items.length)) ctx.addIssue({ code: 'custom', message: '批次不允许重复操作ID、URL或发送键' });
});
export type WorkflowRequest = z.infer<typeof workflowRequestSchema>;
export interface WorkflowItem { sourceId?: string; id?: string; status: 'not_executed' | 'running' | 'succeeded' | 'failed'; stages: Array<{ stage: string; startedAt: string; finishedAt?: string; elapsedMs?: number; status: string }>; result?: unknown; recovery?: { packetItem?: unknown; priorResult?: unknown; journalPublication?: unknown; publicationReconciled?: boolean; message?: string } }
export interface WorkflowRun { schemaVersion: 1; runId: string; request: WorkflowRequest; digest: string; status: 'queued' | 'running' | 'completed' | 'needs_attention'; startedAt: string; finishedAt?: string; elapsedMs?: number; items: WorkflowItem[]; resultPath: string; message?: string }
export class WorkflowStore {
  constructor(private readonly root: string) {}
  path(id: string): string { workflowKey.parse(id); return join(this.root, `${id}.json`); }
  resultPath(id: string): string { workflowKey.parse(id); return join(this.root, `${id}.result.private.json`); }
  digest(request: WorkflowRequest): string { return createHash('sha256').update(JSON.stringify(request)).digest('hex'); }
  async save(run: WorkflowRun): Promise<void> { await mkdir(this.root, { recursive: true, mode: 0o700 }); await atomicWriteText(this.root, this.path(run.runId), `${JSON.stringify(run)}\n`); }
  async packet(run: WorkflowRun, result: Record<string, unknown>): Promise<void> { await atomicWriteText(this.root, run.resultPath, `${JSON.stringify({ ...result, runId: run.runId, requestDigest: run.digest }, null, 2)}\n`); }
  async readPacket(run: WorkflowRun): Promise<Record<string, unknown>> {
    try { return JSON.parse(await readFile(run.resultPath, 'utf8')) as Record<string, unknown>; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  }
  async get(id: string): Promise<WorkflowRun> {
    try { return JSON.parse(await readFile(this.path(id), 'utf8')) as WorkflowRun; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'WORKFLOW_NOT_FOUND', '批次不存在'); throw error; }
  }
  async list(): Promise<WorkflowRun[]> {
    let files: string[]; try { files = await readdir(this.root); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
    return Promise.all(files.filter(f => f.endsWith('.json') && !f.endsWith('.result.private.json')).map(f => this.get(f.slice(0, -5))));
  }
}
