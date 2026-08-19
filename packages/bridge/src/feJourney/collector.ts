import type { CollectedDocument } from '@data-collector/shared';
import { FE_JOURNEY_PRESET } from './preset.js';
import {
  FeJourneyStateStore,
  type FeJourneySource,
  type FeJourneyState,
} from './state.js';

export interface FeJourneyCollectorDependencies {
  stateFile: string;
  enabled: boolean;
  now(): string;
  knownNowcoderUrls(): ReadonlySet<string>;
  discoverNowcoder(knownUrls: ReadonlySet<string>): Promise<string[]>;
  enqueueNowcoder(url: string): Promise<boolean>;
  discoverGithub(): Promise<CollectedDocument[]>;
  saveGithub(document: CollectedDocument): Promise<boolean>;
}

export interface FeJourneyRunOptions {
  force?: boolean;
  nowcoder?: boolean;
  github?: boolean;
}

export interface FeJourneySourceRunReport {
  status: 'completed' | 'skipped' | 'failed' | 'disabled';
  reason?: 'not_due' | 'not_requested';
  discovered?: number;
  enqueued?: number;
  saved?: number;
  failed?: number;
  error?: string;
}

export interface FeJourneyRunReport {
  enabled: boolean;
  forced: boolean;
  startedAt: string;
  finishedAt: string;
  sources: Record<FeJourneySource, FeJourneySourceRunReport>;
}

export interface FeJourneyCollectorStatus {
  enabled: boolean;
  running: boolean;
  state: FeJourneyState;
  nextDueAt: Record<FeJourneySource, string | null>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nextDue(lastAttemptAt: string | undefined, intervalMs: number): string | null {
  if (!lastAttemptAt) return null;
  const timestamp = Date.parse(lastAttemptAt);
  return Number.isFinite(timestamp) ? new Date(timestamp + intervalMs).toISOString() : null;
}

export class FeJourneyCollector {
  private inFlight: Promise<FeJourneyRunReport> | undefined;

  private constructor(
    private readonly dependencies: FeJourneyCollectorDependencies,
    private readonly state: FeJourneyStateStore,
  ) {}

  static async open(dependencies: FeJourneyCollectorDependencies): Promise<FeJourneyCollector> {
    return new FeJourneyCollector(dependencies, await FeJourneyStateStore.open(dependencies.stateFile));
  }

  status(): FeJourneyCollectorStatus {
    const state = this.state.snapshot();
    return {
      enabled: this.dependencies.enabled,
      running: Boolean(this.inFlight),
      state,
      nextDueAt: {
        nowcoder: nextDue(state.sources.nowcoder.lastAttemptAt, FE_JOURNEY_PRESET.nowcoder.intervalMs),
        github: nextDue(state.sources.github.lastAttemptAt, FE_JOURNEY_PRESET.github.intervalMs),
      },
    };
  }

  run(options: FeJourneyRunOptions = {}): Promise<FeJourneyRunReport> {
    if (this.inFlight) return this.inFlight;
    const operation = this.execute(options).finally(() => {
      if (this.inFlight === operation) this.inFlight = undefined;
    });
    this.inFlight = operation;
    return operation;
  }

  private isDue(source: FeJourneySource, now: string, force: boolean): boolean {
    if (force) return true;
    const lastAttemptAt = this.state.snapshot().sources[source].lastAttemptAt;
    if (!lastAttemptAt) return true;
    const last = Date.parse(lastAttemptAt);
    const current = Date.parse(now);
    const interval = FE_JOURNEY_PRESET[source].intervalMs;
    return !Number.isFinite(last) || !Number.isFinite(current) || current - last >= interval;
  }

  private async runNowcoder(attemptedAt: string): Promise<FeJourneySourceRunReport> {
    try {
      const known = this.dependencies.knownNowcoderUrls();
      const urls = await this.dependencies.discoverNowcoder(known);
      let enqueued = 0;
      for (const url of urls) {
        if (await this.dependencies.enqueueNowcoder(url)) enqueued += 1;
      }
      await this.state.record('nowcoder', attemptedAt);
      return { status: 'completed', discovered: urls.length, enqueued };
    } catch (error) {
      const message = errorMessage(error);
      await this.state.record('nowcoder', attemptedAt, message);
      return { status: 'failed', error: message };
    }
  }

  private async runGithub(attemptedAt: string): Promise<FeJourneySourceRunReport> {
    try {
      const documents = await this.dependencies.discoverGithub();
      let saved = 0;
      let failed = 0;
      for (const document of documents) {
        try {
          if (await this.dependencies.saveGithub(document)) saved += 1;
          else failed += 1;
        } catch {
          failed += 1;
        }
      }
      await this.state.record('github', attemptedAt);
      return { status: 'completed', discovered: documents.length, saved, failed };
    } catch (error) {
      const message = errorMessage(error);
      await this.state.record('github', attemptedAt, message);
      return { status: 'failed', error: message };
    }
  }

  private async execute(options: FeJourneyRunOptions): Promise<FeJourneyRunReport> {
    const startedAt = this.dependencies.now();
    const force = options.force ?? false;
    const requested = {
      nowcoder: options.nowcoder ?? true,
      github: options.github ?? true,
    };
    const reports = {} as Record<FeJourneySource, FeJourneySourceRunReport>;

    for (const source of ['nowcoder', 'github'] as const) {
      if (!this.dependencies.enabled) {
        reports[source] = { status: 'disabled' };
      } else if (!requested[source]) {
        reports[source] = { status: 'skipped', reason: 'not_requested' };
      } else if (!this.isDue(source, startedAt, force)) {
        reports[source] = { status: 'skipped', reason: 'not_due' };
      } else {
        reports[source] = source === 'nowcoder'
          ? await this.runNowcoder(startedAt)
          : await this.runGithub(startedAt);
      }
    }

    return {
      enabled: this.dependencies.enabled,
      forced: force,
      startedAt,
      finishedAt: this.dependencies.now(),
      sources: reports,
    };
  }
}
