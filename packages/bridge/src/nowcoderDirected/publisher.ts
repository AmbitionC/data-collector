import type {
  NowcoderDirectedRunAttempt,
  PublicNowcoderDirectedRun,
} from '@data-collector/shared';
import {
  syncEntries,
  type ResolveTarget,
} from '../library/sync.js';
import type { NowcoderDirectedPublisherRecoveryContext } from './service.js';
import type { NowcoderDirectedStore } from './store.js';

export interface NowcoderDirectedPublisherOptions {
  store: NowcoderDirectedStore;
  libraryRoot: string;
  resolveTarget: ResolveTarget;
  finalizePublished: (
    runId: string,
    attempt: NowcoderDirectedRunAttempt,
  ) => Promise<PublicNowcoderDirectedRun>;
  now?: () => string;
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('牛客定向发布已取消');
  error.name = 'AbortError';
  return error;
}

function exactIds(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const wanted = new Set(expected);
  return wanted.size === expected.length && actual.every(id => wanted.has(id));
}

/**
 * Minimal durable publisher for the exact delivery set frozen by selection.
 * Staging is cancellable; after the store linearizes `publishing`, restart
 * recovery deliberately replays the same idempotent atomic sync.
 */
export class NowcoderDirectedPublisher {
  constructor(private readonly options: NowcoderDirectedPublisherOptions) {}

  async recover(
    context: NowcoderDirectedPublisherRecoveryContext,
  ): Promise<PublicNowcoderDirectedRun> {
    let snapshot = this.options.store.publisherSnapshotCurrent(
      context.run.id,
      context.run.attempt,
    );
    if (snapshot.status === 'completed') {
      const completed = this.options.store.getRun(snapshot.id);
      if (!completed) throw new Error('定向发布运行不存在');
      return completed;
    }

    if (snapshot.status === 'running') {
      const signal = 'signal' in context ? context.signal : undefined;
      if (signal?.aborted) throw abortReason(signal);
      if (!this.options.store.hasCompleteTabClearEvidence(snapshot.id, snapshot.attempt)) {
        throw new Error('定向发布缺少完整关页证据');
      }
      await this.options.store.beginPublishingCurrent(snapshot.id, snapshot.attempt);
      snapshot = this.options.store.publisherSnapshotCurrent(snapshot.id, snapshot.attempt);
    }

    if (snapshot.status !== 'publishing' || snapshot.phase !== 'publishing') {
      throw new Error('定向发布状态无效');
    }
    const deliveryIds = snapshot.deliveryItems.map(item => item.stableContentId);
    if (deliveryIds.length !== snapshot.target || new Set(deliveryIds).size !== snapshot.target) {
      throw new Error('定向发布清单不等于精确目标');
    }

    const outcome = await syncEntries(
      this.options.libraryRoot,
      deliveryIds,
      this.options.resolveTarget,
      this.options.now,
      {
        deliveryBatchId: snapshot.id,
        deliveryKind: 'nowcoder-directed',
        atomic: true,
      },
    );
    const syncedIds = outcome.entries
      .filter(entry => entry.sync.state === 'synced')
      .map(entry => entry.id);
    if (
      outcome.synced !== snapshot.target
      || outcome.failed !== 0
      || outcome.entries.length !== snapshot.target
      || !exactIds(syncedIds, deliveryIds)
    ) {
      throw new Error('定向发布未完成精确同步');
    }
    return await this.options.finalizePublished(snapshot.id, snapshot.attempt);
  }
}
