export type { ContentSink, SinkResult } from './types.js';
export { MarkdownLibrarySink } from './markdownLibrarySink.js';
export { RepoInboxSink, type RepoInboxSinkOptions } from './repoInboxSink.js';
export {
  SinkRouter,
  type BuildSinksOptions,
  type RouterWarn,
} from './router.js';
export {
  loadSinksConfig,
  builtInSinksConfig,
  sinksConfigSchema,
  sinkDefinitionSchema,
  DEFAULT_SINKS_CONFIG,
  type SinksConfig,
  type SinkDefinition,
} from './config.js';
