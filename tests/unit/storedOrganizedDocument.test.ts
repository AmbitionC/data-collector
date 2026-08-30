import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollectedDocument } from '@data-collector/shared';
import { deliveryRevision } from '../../packages/bridge/src/library/deliveryRevision.js';
import {
  projectOrganized,
  storedOrganizedDocumentSchema,
} from '../../packages/bridge/src/library/storedDocument.js';
import { organize } from '../../packages/bridge/src/organize/index.js';
import { MarkdownLibrary, listLibrary, syncEntries } from '../../packages/bridge/src/library/index.js';
import type { ContentSink } from '../../packages/bridge/src/sinks/types.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const temporaryDirectories = createTemporaryDirectoryTracker();
afterEach(() => temporaryDirectories.cleanup());

const document: CollectedDocument = {
  schemaVersion: 1,
  source: 'nowcoder',
  kind: 'post',
  url: 'https://www.nowcoder.com/discuss/7001',
  canonicalUrl: 'https://www.nowcoder.com/discuss/7001',
  title: '字节 Agent 开发面经',
  publishedAt: '2026-08-29T00:00:00.000Z',
  collectedAt: '2026-08-30T00:00:00.000Z',
  html: '<p>1. Agent Loop？2. RAG？3. Tool Schema？</p>',
  text: '1. Agent Loop？2. RAG？3. Tool Schema？',
  images: [],
  feJourney: {
    candidateKinds: ['interview'], qualityScore: 90, qualitySignals: [],
    contentHash: '0123456789abcdef', simHash: '1111111111111111',
    clusterId: 'cluster-0123456789ab',
  },
};

describe('stored organized document projection', () => {
  it('keeps complete directed evidence local while preserving the pure delivery revision', () => {
    const organized = organize(document);
    const revision = deliveryRevision(organized);
    const stored = storedOrganizedDocumentSchema.parse({
      ...organized,
      localEvidence: {
        nowcoderDirected: {
          runId: 'run-1', attempt: '0123456789abcdef', currentJobId: 'job-1',
          stableContentId: '518db84a7d38', canonicalUrl: document.canonicalUrl,
          contentHash: '0123456789abcdef', clusterId: 'cluster-0123456789ab',
          deliveryRevision: revision,
        },
      },
    });

    const projected = projectOrganized(stored);
    expect(projected).toEqual(organized);
    expect(projected).not.toHaveProperty('localEvidence');
    expect(deliveryRevision(projected)).toBe(revision);
  });

  it('replays only the pure projection to an ordinary synchronization sink', async () => {
    const root = await temporaryDirectories.create('stored-organized-privacy-');
    await mkdir(join(root, '_catalog'), { recursive: true });
    const organized = organize(document);
    const revision = deliveryRevision(organized);
    const library = new MarkdownLibrary({ root });
    await library.save(organized, {
      nowcoderDirected: {
        runId: 'run-private', attempt: '0123456789abcdef', currentJobId: 'nowcoder-job-private',
        stableContentId: '518db84a7d38', canonicalUrl: document.canonicalUrl,
        contentHash: '0123456789abcdef', clusterId: 'cluster-0123456789ab',
        deliveryRevision: revision,
      },
    });
    const entry = (await listLibrary(root))[0]!;
    let received: unknown;
    const save = vi.fn(async input => {
      received = input;
      return { sinkId: 'ordinary', ok: true, outputRef: join(root, 'ordinary.md') };
    });
    const sink: ContentSink = {
      id: 'ordinary', label: 'ordinary', root, categories: [], save,
    };

    await syncEntries(root, [entry.id], () => sink, () => '2026-08-30T00:00:00.000Z');

    expect(save).toHaveBeenCalledOnce();
    expect(received).toEqual(organized);
    expect(JSON.stringify(received)).not.toMatch(/run-private|nowcoder-job-private|localEvidence/u);
  });
});
