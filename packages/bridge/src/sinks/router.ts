import type { Source } from '@data-collector/shared';
import type { OrganizedDocument } from '../organize/index.js';
import type { ResolveAddresses } from '../library/assets.js';
import { MarkdownLibrarySink } from './markdownLibrarySink.js';
import { RepoInboxSink } from './repoInboxSink.js';
import type { ContentSink, SinkResult } from './types.js';
import { DEFAULT_SINKS_CONFIG, type SinksConfig } from './config.js';

const FALLBACK_SINK_ID = 'markdown';

export interface BuildSinksOptions {
  /** 本机 Markdown 库根目录（markdown sink 用）。 */
  libraryRoot: string;
  fetch?: typeof fetch;
  resolveAddresses?: ResolveAddresses;
}

/** 记录未识别路由/目标的告警（不中断，仅记日志）。 */
export type RouterWarn = (message: string) => void;

/**
 * 按来源把整理后的内容分发到一个或多个 sink。
 * 未在路由表中的来源回退到本机 Markdown 库（保持 0.2.0 行为）。
 */
export class SinkRouter {
  private constructor(
    private readonly sinks: Map<string, ContentSink>,
    private readonly routes: Record<string, string[]>,
    private readonly warn: RouterWarn,
  ) {}

  static build(
    config: SinksConfig = DEFAULT_SINKS_CONFIG,
    options: BuildSinksOptions = { libraryRoot: '' },
    warn: RouterWarn = () => {},
  ): SinkRouter {
    const sinks = new Map<string, ContentSink>();
    for (const [id, definition] of Object.entries(config.sinks)) {
      if (definition.type === 'markdown') {
        sinks.set(
          id,
          new MarkdownLibrarySink({
            root: options.libraryRoot,
            ...(options.fetch ? { fetch: options.fetch } : {}),
            ...(options.resolveAddresses ? { resolveAddresses: options.resolveAddresses } : {}),
          }),
        );
      } else {
        sinks.set(
          id,
          new RepoInboxSink({
            id,
            repoPath: definition.repoPath,
            ...(definition.inboxDir ? { inboxDir: definition.inboxDir } : {}),
            ...(definition.commit !== undefined ? { commit: definition.commit } : {}),
            ...(definition.push !== undefined ? { push: definition.push } : {}),
            ...(options.fetch ? { fetch: options.fetch } : {}),
            ...(options.resolveAddresses ? { resolveAddresses: options.resolveAddresses } : {}),
          }),
        );
      }
    }
    if (!sinks.has(FALLBACK_SINK_ID)) {
      sinks.set(FALLBACK_SINK_ID, new MarkdownLibrarySink({
        root: options.libraryRoot,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.resolveAddresses ? { resolveAddresses: options.resolveAddresses } : {}),
      }));
    }
    return new SinkRouter(sinks, config.routes, warn);
  }

  /** 解析某来源要用的 sink id 列表（去重、剔除未定义项，空则回退 markdown）。 */
  resolveSinkIds(source: Source, override?: readonly string[]): string[] {
    const requested = override ?? this.routes[source] ?? [FALLBACK_SINK_ID];
    const resolved: string[] = [];
    for (const id of requested) {
      if (!this.sinks.has(id)) {
        this.warn(`未定义的 sink：${id}（来源 ${source}）已跳过`);
        continue;
      }
      if (!resolved.includes(id)) resolved.push(id);
    }
    if (resolved.length === 0) resolved.push(FALLBACK_SINK_ID);
    return resolved;
  }

  /**
   * 把内容落到该来源路由到的每个 sink。单个 sink 抛错不影响其他 sink；
   * 结果数组按 sink 顺序返回，调用方据 `ok` 判断整体成败。
   */
  async save(input: OrganizedDocument, override?: readonly string[]): Promise<SinkResult[]> {
    const ids = this.resolveSinkIds(input.document.source, override);
    const results: SinkResult[] = [];
    for (const id of ids) {
      const sink = this.sinks.get(id);
      if (!sink) continue;
      try {
        results.push(await sink.save(input));
      } catch (error) {
        results.push({
          sinkId: id,
          ok: false,
          outputRef: '',
          detail: { error: error instanceof Error ? error.message : String(error) },
        });
      }
    }
    return results;
  }
}
