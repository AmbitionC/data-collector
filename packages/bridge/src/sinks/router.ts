import { SOURCES, type Source } from '@data-collector/shared';
import type { OrganizedDocument } from '../organize/index.js';
import type { ResolveAddresses } from '../library/assets.js';
import { MarkdownLibrarySink } from './markdownLibrarySink.js';
import { RepoInboxSink } from './repoInboxSink.js';
import type { ContentSink, SinkResult } from './types.js';
import type { LocalDocumentEvidence } from '../library/storedDocument.js';
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
  private readonly trustedLocalResults = new WeakSet<object>();

  private constructor(
    private readonly sinks: Map<string, ContentSink>,
    private readonly localEvidenceSink: MarkdownLibrarySink,
    private readonly routes: Record<string, string[]>,
    private readonly warn: RouterWarn,
  ) {}

  static build(
    config: SinksConfig = DEFAULT_SINKS_CONFIG,
    options: BuildSinksOptions = { libraryRoot: '' },
    warn: RouterWarn = () => {},
  ): SinkRouter {
    const sinks = new Map<string, ContentSink>();
    const localEvidenceSink = new MarkdownLibrarySink({
      root: options.libraryRoot,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.resolveAddresses ? { resolveAddresses: options.resolveAddresses } : {}),
    });
    // `markdown` is a reserved internal capability. Configuration may neither
    // replace it with a repo sink nor manufacture another trusted instance.
    sinks.set(FALLBACK_SINK_ID, localEvidenceSink);
    for (const [id, definition] of Object.entries(config.sinks)) {
      if (id === FALLBACK_SINK_ID) continue;
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
            ...(definition.label ? { label: definition.label } : {}),
            ...(definition.categories ? { categories: definition.categories } : {}),
            ...(definition.inboxDir ? { inboxDir: definition.inboxDir } : {}),
            ...(definition.commit !== undefined ? { commit: definition.commit } : {}),
            ...(definition.push !== undefined ? { push: definition.push } : {}),
            ...(options.fetch ? { fetch: options.fetch } : {}),
            ...(options.resolveAddresses ? { resolveAddresses: options.resolveAddresses } : {}),
          }),
        );
      }
    }
    return new SinkRouter(sinks, localEvidenceSink, config.routes, warn);
  }

  /**
   * 路由说明：可选去向（含各自的分类清单）+ 每个来源的默认去向。
   * 供侧边栏渲染「去向 / 分类」级联选择与「保存去向」提示。
   * 只暴露面向用户的名称与分类，**不含本机路径、凭证等敏感信息**。
   */
  describeRouting(): {
    sinks: { id: string; label: string; categories: string[] }[];
    defaults: Record<Source, string[]>;
  } {
    const defaults = {} as Record<Source, string[]>;
    for (const source of SOURCES) defaults[source] = this.resolveSinkIds(source);
    return {
      sinks: [...this.sinks.entries()].map(([id, sink]) => ({
        id,
        label: sink.label,
        categories: [...sink.categories],
      })),
      defaults,
    };
  }

  /**
   * 所有 sink 的写入根目录，供「在文件夹中查看」做越界校验。
   * **只在 Bridge 内部使用**，不经 describeRouting 暴露给扩展（那份刻意不含本机路径）。
   */
  revealRoots(): string[] {
    return [...new Set([...this.sinks.values()].map(sink => sink.root).filter(Boolean))];
  }

  /**
   * 某来源的**同步去向**（本机库之外的那些）。
   *
   * 采集只落本机库，投递到仓库收件箱是之后的显式动作，因此这里刻意排除 markdown：
   * 它是起点，不是同步目标。没有配置任何仓库去向时返回 undefined，
   * 同步会如实报「没有为该来源配置同步去向」，而不是假装成功。
   */
  syncTarget(source: string): ContentSink | undefined {
    const ids = this.routes[source] ?? [];
    for (const id of ids) {
      const sink = this.sinks.get(id);
      if (sink && !(sink instanceof MarkdownLibrarySink)) return sink;
    }
    return undefined;
  }

  /** Trusted directed destination: an exact-capable repo inbox, never a Markdown alias. */
  directedSyncTarget(source: string): {
    type: 'repo-inbox';
    exactCapable: true;
    id: string;
    root: string;
    sink: RepoInboxSink;
  } | undefined {
    for (const id of this.routes[source] ?? []) {
      const sink = this.sinks.get(id);
      if (!(sink instanceof RepoInboxSink)) continue;
      return {
        type: 'repo-inbox',
        exactCapable: true,
        id: sink.id,
        root: sink.root,
        sink,
      };
    }
    return undefined;
  }

  /** Object-identity authority; a user-controlled sinkId cannot satisfy it. */
  isTrustedLocalEvidenceResult(result: SinkResult): boolean {
    return this.trustedLocalResults.has(result);
  }

  /** 可选的同步去向说明（供侧栏展示「这一条会同步到哪」）。 */
  describeSyncTargets(): Record<string, { id: string; label: string }> {
    const targets: Record<string, { id: string; label: string }> = {};
    for (const source of SOURCES) {
      const sink = this.syncTarget(source);
      if (sink) targets[source] = { id: sink.id, label: sink.label };
    }
    return targets;
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
   * 采集落地：**只写本机库**。
   *
   * 本机库是唯一落点，也是去重与「已入库」列表的唯一依据；投递到仓库收件箱改由
   * 用户在「已入库」页显式发起（见 library/sync.ts）。采集时就直接投递会让用户
   * 失去中间那道核对，出问题也分不清是采错了还是投错了。
   */
  async save(
    input: OrganizedDocument,
    override?: readonly string[],
    localEvidence?: LocalDocumentEvidence,
  ): Promise<SinkResult[]> {
    const ids = override && override.length > 0
      ? this.resolveSinkIds(input.document.source, override)
      : [FALLBACK_SINK_ID];
    const results: SinkResult[] = [];
    for (const id of ids) {
      const sink = this.sinks.get(id);
      if (!sink) continue;
      try {
        const result = sink === this.localEvidenceSink
          ? await this.localEvidenceSink.saveLocal(input, localEvidence)
          : await sink.save(input);
        if (sink === this.localEvidenceSink) this.trustedLocalResults.add(result);
        results.push(result);
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error
          && typeof error.code === 'string'
          ? error.code
          : undefined;
        const result: SinkResult = {
          sinkId: id,
          ok: false,
          outputRef: '',
          detail: {
            error: error instanceof Error ? error.message : String(error),
            ...(code ? { code } : {}),
          },
        };
        if (sink === this.localEvidenceSink) this.trustedLocalResults.add(result);
        results.push(result);
      }
    }
    return results;
  }
}
