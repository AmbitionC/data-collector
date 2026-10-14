import { createHash, randomUUID } from 'node:crypto';
import {
  nowcoderSearchPreviewRequestSchema,
  type NowcoderSearchPreviewRequest,
  type NowcoderSearchSession,
} from '@data-collector/shared';
import type { JobStore } from '../jobs/store.js';
import { knownNowcoderSources } from './knownSources.js';
import { discoverNowcoderDirectedCandidates } from './discovery.js';
import type { NowcoderDirectedStore } from './store.js';

const QUERY_HASH_PREFIX = 'nowcoder-directed-query-v1\\0';
const SESSION_TTL_MS = 30 * 60_000;

export class NowcoderDirectedSearchError extends Error {
  override readonly name = 'NowcoderDirectedSearchError';
  readonly code = 'NOWCODER_SEARCH_UNAVAILABLE';

  constructor() {
    super('牛客最新搜索暂时不可用');
  }
}

export interface NowcoderDirectedSessionControllerOptions {
  store: NowcoderDirectedStore;
  jobs: JobStore;
  libraryRoot: string;
  targetRoot?: string;
  historyRoot?: string;
  historyPath?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  id?: () => string;
}

/** Creates one immutable preview session from the verified JSON latest-search path. */
export class NowcoderDirectedSessionController {
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly id: () => string;

  constructor(private readonly options: NowcoderDirectedSessionControllerOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  async create(rawRequest: NowcoderSearchPreviewRequest): Promise<NowcoderSearchSession> {
    const request = nowcoderSearchPreviewRequestSchema.parse(rawRequest);
    const now = new Date(this.now().getTime());
    let discovery: Awaited<ReturnType<typeof discoverNowcoderDirectedCandidates>>;
    try {
      const known = await knownNowcoderSources({ libraryRoot: this.options.libraryRoot,
        targetRoot: this.options.targetRoot, historyRoot: this.options.historyRoot, historyPath: this.options.historyPath, jobs: this.options.jobs.list() });
      discovery = await discoverNowcoderDirectedCandidates(
        this.fetcher,
        request,
        known.urls,
        now,
        known.reasons,
      );
      discovery.diagnostics.sourceIndexWarnings = known.warnings;
    } catch {
      throw new NowcoderDirectedSearchError();
    }
    const session: NowcoderSearchSession = {
      id: this.id(),
      queries: request.queries,
      queryHash: createHash('sha256')
        .update(`${QUERY_HASH_PREFIX}${JSON.stringify(request.queries)}`)
        .digest('hex'),
      requestedSort: discovery.audit.requestedSort,
      provider: discovery.audit.provider,
      sortVerified: discovery.audit.sortVerified,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
      candidates: discovery.candidates,
      discovery: discovery.diagnostics,
      reviewOnlyCandidates: discovery.previewOnly,
    };
    return await this.options.store.createSession(session, { target: request.target });
  }
}
