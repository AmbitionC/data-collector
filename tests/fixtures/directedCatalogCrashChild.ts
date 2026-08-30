import { stableContentId, type CollectedDocument } from '@data-collector/shared';
import { organize } from '../../packages/bridge/src/organize/index.js';
import {
  MarkdownLibrary,
  type DirectedTransactionBoundaryContext,
} from '../../packages/bridge/src/library/writer.js';
import { deliveryRevision } from '../../packages/bridge/src/library/deliveryRevision.js';

interface CrashConfig {
  root: string;
  url: string;
  checkpoint:
    | 'afterIntentCommit'
    | 'catalogTempExclusiveOpen'
    | 'markerExclusiveOpen'
    | 'beforeMarkerInstall'
    | 'beforeEntryCommit'
    | 'beforeCatalogCommit'
    | 'afterCatalogCommit';
}

const config = JSON.parse(process.argv[2] ?? '') as CrashConfig;
const document: CollectedDocument = {
  schemaVersion: 1,
  source: 'nowcoder',
  kind: 'post',
  url: config.url,
  canonicalUrl: config.url,
  title: `崩溃恢复 ${config.checkpoint}`,
  publishedAt: '2026-08-29T00:00:00.000Z',
  collectedAt: '2026-08-30T00:00:00.000Z',
  html: `<p>崩溃恢复 ${config.checkpoint}，包含 Agent 架构、工具调用、记忆与评测。</p>`,
  text: `崩溃恢复 ${config.checkpoint}，包含 Agent 架构、工具调用、记忆与评测。`,
  images: [],
  feJourney: {
    candidateKinds: ['interview'],
    qualityScore: 90,
    qualitySignals: [],
    exclusionReasons: [],
    contentHash: '0123456789abcdef',
    simHash: '1111111111111111',
    clusterId: 'cluster-durability',
  },
};
const input = organize(document);
const evidence = {
  nowcoderDirected: {
    runId: 'run-catalog-durability',
    attempt: '0123456789abcdef' as const,
    currentJobId: `job-${stableContentId(config.url)}`,
    stableContentId: stableContentId(config.url),
    canonicalUrl: config.url,
    contentHash: '0123456789abcdef',
    clusterId: 'cluster-durability',
    deliveryRevision: deliveryRevision(input),
  },
};

function stopAt(checkpoint: CrashConfig['checkpoint'], context: Record<string, string>): Promise<void> {
  if (config.checkpoint !== checkpoint) return Promise.resolve();
  process.stdout.write(`CHECKPOINT ${JSON.stringify(context)}\n`);
  return new Promise(() => undefined);
}

const library = new MarkdownLibrary({
  root: config.root,
  directedTransactionIo: {
    afterIntentCommit: async pointerPath => {
      await stopAt('afterIntentCommit', { pointerPath });
    },
    afterExclusiveOpen: async (kind, path) => {
      if (kind === 'catalog-temp') await stopAt('catalogTempExclusiveOpen', { path });
      if (kind === 'transaction-marker') await stopAt('markerExclusiveOpen', { path });
    },
    beforeManifestInstall: async (kind, temporaryPath, finalPath) => {
      if (kind === 'transaction-marker') {
        await stopAt('beforeMarkerInstall', { temporaryPath, finalPath });
      }
    },
    beforeEntryCommit: async (context: DirectedTransactionBoundaryContext) => {
      await stopAt('beforeEntryCommit', { ...context } as unknown as Record<string, string>);
    },
    beforeCatalogCommit: async (context: DirectedTransactionBoundaryContext) => {
      await stopAt('beforeCatalogCommit', { ...context } as unknown as Record<string, string>);
    },
    afterCatalogCommit: async (catalogPath, catalogTemporaryPath) => {
      await stopAt('afterCatalogCommit', { catalogPath, catalogTemporaryPath });
    },
  },
});

void library.save(input, evidence).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
