import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { operationPublishSchema, type NowcoderOperationAction, type NowcoderOperationResult } from '@data-collector/shared';
import { discoverNowcoderDirectedCandidates } from '../nowcoderDirected/discovery.js';
import { HttpError } from '../server/http.js';
import type { NowcoderOperationsStore } from './store.js';

interface Transport {
  assertAvailable(): void;
  execute(action: NowcoderOperationAction, requestId: string): Promise<NowcoderOperationResult>;
}
export class NowcoderOperationsActivity {
  private active = 0;
  private readonly publishing = new Set<string>();
  constructor(private readonly store: NowcoderOperationsStore, private readonly transport: Transport, private readonly fetcher: typeof fetch) {}
  get busy(): boolean { return this.active > 0; }
  isPublishing(id: string): boolean { return this.publishing.has(id); }

  async search(query: string, limit = 10): Promise<unknown> {
    z.string().trim().min(1).max(100).parse(query); z.number().int().min(1).max(20).parse(limit);
    const replied = new Set((await this.store.list()).filter(e => e.status === 'replied').map(e => e.canonicalUrl));
    const found = await discoverNowcoderDirectedCandidates(this.fetcher, { queries: [query], target: Math.min(10, limit), sort: 'latest', maxPagesPerQuery: 1, maxRequests: 1 }, replied, new Date());
    return { provider: 'nowcoder-json', sort: 'latest', requestBudget: 1,
      candidates: found.candidates.slice(0, limit).map(c => ({ sourceId: c.id, url: c.canonicalUrl, title: c.title, snippet: c.snippet?.slice(0, 240) ?? '', publishedAt: c.publishedAt })),
      hasMore: found.candidates.length > limit || found.diagnostics.stops.some(s => s.reason !== 'end_of_results' && s.reason !== 'empty_page'),
      diagnostics: found.diagnostics };
  }

  async context(id: string, maxPages = 1): Promise<unknown> {
    z.number().int().min(1).max(3).parse(maxPages);
    this.active++;
    try {
      this.transport.assertAvailable();
      const entry = await this.store.get(id);
      if (!entry) throw new HttpError(404, 'OPERATIONS_NOT_FOUND', '运营记录不存在');
      const result = await this.transport.execute({ kind: 'context', url: entry.canonicalUrl, maxPages }, randomUUID());
      if (result.kind === 'attention') return result;
      if (result.kind !== 'context') throw new HttpError(409, 'OPERATIONS_RESULT_INVALID', '插件返回了错误的操作结果');
      if (entry.publicationAttempts?.some(a => a.state === 'dispatching' || a.state === 'uncertain')) {
        return { id, revision: entry.revision, contextHash: entry.contextHash, verificationOnly: true, sourceUntrusted: result.snapshot };
      }
      const saved = await this.store.saveConversation(id, result.snapshot);
      return { id, revision: saved.revision, contextHash: saved.contextHash, conversationHash: saved.conversation!.hash,
        sourceUntrusted: saved.conversation!.snapshot };
    } finally { this.active--; }
  }

  async publish(id: string, raw: unknown): Promise<unknown> {
    const input = operationPublishSchema.parse(raw);
    this.active++;
    if (this.publishing.has(id)) { this.active--; throw new HttpError(409, 'OPERATIONS_BUSY', '该帖发送仍在执行，请等待回执'); }
    this.publishing.add(id);
    try {
      // An existing durable attempt can be inspected even while the extension is offline.
      const existing = await this.store.get(id);
      if (!existing?.publicationAttempts?.some(a => a.key === input.key)) this.transport.assertAvailable();
      const started = await this.store.beginPublication(id, input, randomUUID());
      if (!started.dispatch) return { id, revision: started.entry.revision, publication: started.publication };
      let result: NowcoderOperationResult;
      try {
        result = await this.transport.execute({ kind: 'publish', url: started.entry.canonicalUrl,
          text: started.entry.drafts!.primary, expected: started.entry.conversation!.snapshot }, started.publication.requestId);
      } catch {
        result = { kind: 'attention', code: 'PUBLICATION_INTERRUPTED', message: '插件发送中断，结果待核验，禁止自动重发', submission: 'uncertain' };
      }
      const publication = await this.store.finishPublication(id, input.key, result);
      return { id, revision: (await this.store.get(id))!.revision, publication,
        ...(publication.state === 'published' && result.kind === 'published' ? { receipt: result.receipt } : result.kind === 'attention' ? { attention: result } : {}) };
    } finally { this.active--; this.publishing.delete(id); }
  }

  async verify(id: string, key: string, maxPages = 1): Promise<unknown> {
    z.string().regex(/^[a-zA-Z0-9_-]{12,100}$/u).parse(key);
    z.number().int().min(1).max(3).parse(maxPages);
    if (this.publishing.has(id)) throw new HttpError(409, 'OPERATIONS_BUSY', '该帖发送仍在执行，请等待回执');
    this.active++;
    try {
      const entry = await this.store.get(id), publication = entry?.publicationAttempts?.find(a => a.key === key);
      if (!entry || !publication) throw new HttpError(404, 'OPERATIONS_ATTEMPT_REQUIRED', '未找到指定发送记录');
      if (publication.state === 'published' || publication.state === 'rejected') return { id, publication };
      this.transport.assertAvailable();
      const result = await this.transport.execute({ kind: 'context', url: entry.canonicalUrl, maxPages }, randomUUID());
      if (result.kind === 'attention') return { id, publication, attention: result };
      if (result.kind !== 'context') throw new HttpError(409, 'OPERATIONS_RESULT_INVALID', '核验必须返回只读上下文');
      return { id, publication: await this.store.reconcilePublication(id, key, result.snapshot), coverage: result.snapshot.coverage };
    } finally { this.active--; }
  }
}
