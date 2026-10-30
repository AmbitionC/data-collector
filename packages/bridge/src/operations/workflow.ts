import { createHash, randomUUID } from 'node:crypto';
import { nowcoderPublishReceiptSchema, type NowcoderOperation } from '@data-collector/shared';
import { HttpError } from '../server/http.js';
import type { NowcoderOperationsStore } from './store.js';
import type { NowcoderOperationsActivity } from './activity.js';
import { WorkflowStore, workflowRequestSchema, type WorkflowRun, type WorkflowItem, type WorkflowRequest } from './workflowStore.js';
export { workflowRequestSchema } from './workflowStore.js';
export interface WorkflowCollection { jobId: string; status: string; [key: string]: unknown }
export type WorkflowCollector = (candidate: { sourceId: string; url: string }, observe: (proof: WorkflowCollection) => Promise<void>) => Promise<WorkflowCollection>;
const now = () => new Date().toISOString();
const normalize = (s: string) => s.replace(/\s+/gu, '');
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export class NowcoderOperationsWorkflow {
  private readonly disk: WorkflowStore;
  private active = false;
  private completion: Promise<void> = Promise.resolve();
  async drain(): Promise<void> { await this.completion; }
  private activeIdentity?: { key: string; digest: string; ready: Promise<string | undefined> };
  constructor(root: string, private readonly operations: NowcoderOperationsStore, private readonly activity: NowcoderOperationsActivity, private readonly collect: WorkflowCollector) { this.disk = new WorkflowStore(root); }
  get busy(): boolean { return this.active; }
  async recover(): Promise<void> {
    for (const run of await this.disk.list()) if (run.status === 'queued' || run.status === 'running') {
      const packet = await this.disk.readPacket(run);
      if (this.disk.digest(run.request) !== run.digest) throw new HttpError(409, 'WORKFLOW_CORRUPT', '批次清单摘要不匹配，保留原始证据，禁止重跑');
      const packetItems: unknown[] = Array.isArray(packet.items) ? packet.items : [];
      const packetBound = packet.runId === run.runId && (packet.requestDigest === undefined || packet.requestDigest === run.digest) && packetItems.length === run.items.length;
      const unmatched = Array.isArray(packet.recoveryUnmatchedItems) ? [...packet.recoveryUnmatchedItems] : [];
      run.status = 'needs_attention'; run.finishedAt = now(); run.elapsedMs = Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt));
      run.message = 'Bridge重启，保留精确证据；发布结果须只读verify，禁止自动重跑';
      for (let index = 0; index < run.items.length; index++) {
        const item = run.items[index]!, packetItem = object(packetItems[index]);
        const manifest = run.request.kind === 'publish' ? run.request.items[index] : undefined;
        const source = run.request.kind === 'prepare' ? run.request.candidates[index] : undefined;
        const entry = manifest ? await this.operations.get(manifest.draft.opportunityId) : undefined;
        const packetResult = object(packetItem?.result), previousResult = object(item.result);
        let bound = packetBound && packetItem !== undefined && packetItem.id === item.id && packetItem.sourceId === item.sourceId
          && (!manifest || item.id === manifest.draft.opportunityId) && (!source || item.sourceId === source.sourceId);
        if (manifest && packetResult) {
          const publication = object(packetResult.publication);
          if ((packetResult.id !== undefined && packetResult.id !== manifest.draft.opportunityId) || (publication && publication.key !== manifest.key)) bound = false;
          if (packetResult.receipt !== undefined) {
            const parsed = nowcoderPublishReceiptSchema.safeParse(packetResult.receipt);
            if (!parsed.success || !entry || parsed.data.sourceUrl !== entry.canonicalUrl || parsed.data.text !== manifest.draft.drafts.primary
              || (publication?.replyUrl !== undefined && publication.replyUrl !== parsed.data.url)) bound = false;
          }
        }
        if (source && previousResult?.jobId !== undefined && packetResult?.jobId !== undefined && previousResult.jobId !== packetResult.jobId) bound = false;
        if (packetItem && !bound) unmatched.push({ index, item: packetItem, reason: 'packet/request/index identity mismatch; evidence retained without attribution' });
        if (bound && packetItem && JSON.stringify(packetItem) !== JSON.stringify(item)) {
          item.recovery = { ...item.recovery, packetItem };
          if (packetItem.result !== undefined) {
            if (item.result !== undefined && JSON.stringify(item.result) !== JSON.stringify(packetItem.result)) item.recovery.priorResult = item.result;
            // A previously saved exact job proof cannot be downgraded by an older queued packet.
            if (!(source && previousResult?.status === 'saved' && packetResult?.status !== 'saved')) item.result = packetItem.result;
          }
        }
        if (item.status === 'running' || item.stages.some(stage => !stage.finishedAt)) item.status = 'failed';
        for (const stage of item.stages) if (!stage.finishedAt) {
          stage.finishedAt = run.finishedAt; stage.status = 'interrupted';
          stage.elapsedMs = Math.max(0, Date.parse(stage.finishedAt) - Date.parse(stage.startedAt));
        }
        if (manifest) {
          const publication = entry?.publicationAttempts?.find(attempt => attempt.key === manifest.key);
          if (publication) item.recovery = { ...item.recovery, journalPublication: publication, publicationReconciled: false };
          const exact = publication?.state === 'published' && publication.evidence === 'observed'
            && publication.requestedRevision === manifest.draft.revision + 1 && publication.replyUrl
            && publication.draftHash === createHash('sha256').update(manifest.draft.drafts.primary).digest('hex')
            && entry?.contextHash === manifest.draft.contextHash && item.id === manifest.draft.opportunityId;
          if (exact) {
            item.status = 'succeeded';
            item.result = { ...object(item.result), id: entry!.id, revision: entry!.revision, publication };
            item.recovery = { ...item.recovery, publicationReconciled: true,
              message: '单条台账确认已观察发布；批次保持停止，未续跑。没有原始回执时不补造receipt/observedAt。' };
          }
        }
      }
      await this.disk.packet(run, { ...(packetBound ? packet : { recoveryUnmatchedPacket: packet }), runId: run.runId, status: run.status, finishedAt: run.finishedAt, elapsedMs: run.elapsedMs, items: run.items,
        ...(unmatched.length ? { recoveryUnmatchedItems: unmatched } : {}) });
      await this.disk.save(run);
    }
  }
  private summary(run: WorkflowRun) {
    const counts = { rejected: run.items.filter(i => i.stages.some(s => s.stage === 'preflight' && s.status === 'failed') || (i.result as { publication?: { state: string } } | undefined)?.publication?.state === 'rejected').length, succeeded: run.items.filter(i => i.status === 'succeeded').length, failed: run.items.filter(i => i.status === 'failed').length, notExecuted: run.items.filter(i => i.status === 'not_executed').length, running: run.items.filter(i => i.status === 'running').length };
    return { runId: run.runId, kind: run.request.kind, status: run.status, counts, startedAt: run.startedAt, finishedAt: run.finishedAt,
      elapsedMs: Math.max(0, Date.parse(run.finishedAt ?? now()) - Date.parse(run.startedAt)), resultPath: run.resultPath, message: run.message,
      items: run.items.map(({ result, recovery, ...item }) => { void result; return { ...item, ...(recovery ? { recovery: { publicationReconciled: recovery.publicationReconciled, message: recovery.message } } : {}) }; }) };
  }
  async get(id: string) {
    const run = await this.disk.get(id);
    // A terminal status must not escape before its last durable write has drained.
    if (run.status !== 'queued' && run.status !== 'running' && this.active && await this.activeIdentity?.ready === id) await this.completion;
    return this.summary(run);
  }
  async stats(id: string) { return this.get(id); }
  async start(raw: unknown, send = false) {
    const request = workflowRequestSchema.parse(raw);
    if (request.kind === 'publish' && !send) throw new HttpError(400, 'WORKFLOW_SEND_REQUIRED', '发布批次必须显式 --send');
    // Fence before the first await: covers key lookup, creation and every inter-item gap.
    const digest = this.disk.digest(request);
    if (this.active) {
      if (this.activeIdentity?.key === request.key) {
        if (this.activeIdentity.digest !== digest) throw new HttpError(409, 'WORKFLOW_KEY_CONFLICT', '批次key已绑定其他清单');
        const id = await this.activeIdentity.ready;
        if (id) return this.get(id);
      }
      throw new HttpError(409, 'WORKFLOW_BUSY', '已有批次正在执行');
    }
    this.active = true;
    let announce!: (id: string | undefined) => void;
    this.activeIdentity = { key: request.key, digest, ready: new Promise(resolve => { announce = resolve; }) };
    let launched = false;
    try {
      const prior = (await this.disk.list()).find(r => r.request.key === request.key);
      if (prior) {
        if (prior.digest !== digest) throw new HttpError(409, 'WORKFLOW_KEY_CONFLICT', '批次key已绑定其他清单');
        announce(prior.runId); return this.summary(prior);
      }
      const runId = `workflow-${randomUUID()}`;
      const identities = request.kind === 'search' ? request.queries.map(() => ({})) : request.kind === 'prepare' ? request.candidates.map(c => ({ sourceId: c.sourceId })) : request.items.map(i => ({ id: i.draft.opportunityId }));
      const run: WorkflowRun = { schemaVersion: 1, runId, request, digest, status: 'running', startedAt: now(), items: identities.map(identity => ({ ...identity, status: 'not_executed', stages: [] })), resultPath: this.disk.resultPath(runId) };
      await this.disk.save(run); await this.disk.packet(run, { runId, items: run.items });
      launched = true; announce(runId);
      this.completion = this.execute(run).finally(() => { this.active = false; }).catch(error => console.warn('[workflow] 持久化失败，保留运行记录待核验', error instanceof Error ? error.message : 'unknown'));
      return this.summary(run);
    } finally { if (!launched) { announce(undefined); this.active = false; } }
  }
  private async preflight(request: Extract<WorkflowRequest, { kind: 'publish' }>): Promise<void> {
    for (const { key, draft } of request.items) {
      const entry = await this.operations.get(draft.opportunityId);
      if (!entry || ['replied', 'skipped'].includes(entry.status)) throw new Error('来源状态不能发布');
      if (entry.revision !== draft.revision || entry.contextHash !== draft.contextHash) throw new Error('草稿修订或正文已变化');
      if (!entry.conversation || !draft.conversationHash || entry.conversation.hash !== draft.conversationHash) throw new Error('草稿评论绑定已变化或缺失');
      if (Date.now() - Date.parse(entry.conversation.snapshot.readAt) > 30 * 60_000) throw new Error('评论上下文超过30分钟');
      if (!normalize(`${entry.title}\n${entry.body}`).includes(normalize(draft.drafts.anchor))) throw new Error('原文锚点不在冻结正文中');
      if (normalize(entry.title) !== normalize(entry.conversation.snapshot.post.title) || normalize(entry.body) !== normalize(entry.conversation.snapshot.post.body)) throw new Error('当前正文与冻结来源冲突，请暂停核对或跳过；重采不会自动覆盖冻结记录');
      if (entry.publicationAttempts?.some(a => a.key === key || a.state !== 'rejected') || (entry.publicationAttempts?.length ?? 0) >= 20) throw new Error('来源已有发送记录，请只读核验，禁止重发');
    }
  }
  private async execute(run: WorkflowRun): Promise<void> {
    const candidates = new Map<string, Record<string, unknown>>(), prepared: unknown[] = [];
    const packet = () => this.disk.packet(run, { schemaVersion: 1, visibility: 'private', runId: run.runId, items: run.items, ...(run.request.kind === 'search' ? { candidates: [...candidates.values()] } : {}), ...(run.request.kind === 'prepare' ? { prepared } : {}) });
    const stage = async (item: WorkflowItem, name: string, work: () => Promise<unknown>) => {
      const phase: WorkflowItem['stages'][number] = { stage: name, startedAt: now(), status: 'running' }; item.stages.push(phase); await this.disk.save(run);
      try { const result = await work(); phase.status = 'succeeded'; return result; } catch (e) { phase.status = 'failed'; throw e; }
      finally { phase.finishedAt = now(); phase.elapsedMs = Date.parse(phase.finishedAt) - Date.parse(phase.startedAt); await this.disk.save(run); }
    };
    try {
      if (run.request.kind === 'publish') {
        const request = run.request;
        for (let index = 0; index < request.items.length; index++) {
          const item = run.items[index]!;
          try { await stage(item, 'preflight', () => this.preflight({ ...request, items: [request.items[index]!] })); }
          catch (error) { item.status = 'failed'; throw error; }
        }
      }
      for (let index = 0; index < run.items.length; index++) {
        const item = run.items[index]!; item.status = 'running'; await this.disk.save(run);
        try {
          if (run.request.kind === 'search') {
            const result = await stage(item, 'search', () => this.activity.search(run.request.kind === 'search' ? run.request.queries[index]! : '', run.request.kind === 'search' ? run.request.limitPerQuery : 8)) as { candidates: Array<Record<string, unknown> & { url: string }> };
            item.result = result;
            for (const c of result.candidates) { const existing = candidates.get(c.url); const query = run.request.queries[index]!;
              candidates.set(c.url, { ...c, queries: [...(existing?.queries as string[] ?? []), query] }); }
          } else if (run.request.kind === 'prepare') {
            const candidate = run.request.candidates[index]!;
            const proof = await stage(item, 'collect', () => this.collect(candidate, async result => { item.result = result; await packet(); await this.disk.save(run); })) as WorkflowCollection;
            item.result = proof; if (proof.status !== 'saved') throw new Error(`采集${proof.status}，保留job ${proof.jobId}`);
            const entry = await stage(item, 'add', () => this.operations.add(candidate.sourceId)) as NowcoderOperation;
            const context = await stage(item, 'context', () => this.activity.context(entry.id, run.request.kind === 'prepare' ? run.request.maxPages : 2)) as { kind?: string; verificationOnly?: boolean };
            if (context.kind === 'attention' || context.verificationOnly) { item.result = { ...proof, context }; throw new Error('评论读取待处理或来源发送结果待核验'); }
            prepared.push(await this.operations.preparationPacket(entry.id));
          } else {
            const input = run.request.items[index]!, { schemaVersion, opportunityId, ...draft } = input.draft; void schemaVersion;
            const saved = await stage(item, 'draft', () => this.operations.update(opportunityId, draft)) as NowcoderOperation;
            item.result = await stage(item, 'publish', () => this.activity.publish(opportunityId, { key: input.key, revision: saved.revision, contextHash: saved.contextHash, send: true }));
            const published = item.result as { publication?: { state: string; evidence?: string } };
            if (published.publication?.state !== 'published' || published.publication.evidence !== 'observed') throw new Error('未观察到published回执，停止批次并只读核验');
          }
          item.status = 'succeeded'; await packet(); await this.disk.save(run);
        } catch (error) { item.status = 'failed'; run.message = error instanceof Error ? error.message : '批次失败'; await packet(); throw error; }
      }
      run.status = 'completed';
    } catch (error) { run.status = 'needs_attention'; run.message = error instanceof Error ? error.message : '批次失败'; }
    finally { run.finishedAt = now(); run.elapsedMs = Date.parse(run.finishedAt) - Date.parse(run.startedAt); await packet(); await this.disk.save(run); }
  }
}
