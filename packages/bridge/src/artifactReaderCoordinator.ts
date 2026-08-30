export interface ArtifactPhysicalLease {
  release(): Promise<void>;
}

export interface ArtifactReaderHandle {
  release(): Promise<void>;
}

export interface ArtifactStartIntent {
  release(): void;
}

export interface ArtifactUpdateIntent {
  handoffToRestart(): void;
  release(): void;
}

export interface ArtifactReaderCoordinatorSnapshot {
  startIntents: number;
  pendingReaders: number;
  activeReaders: number;
  physicalBusy?: boolean;
  physicalFaulted?: boolean;
  updateState: 'idle' | 'update' | 'restart';
}

export interface ArtifactReaderCoordinatorLike {
  tryBeginStart(): ArtifactStartIntent | undefined;
  tryBeginUpdate(activeDirectedRun: boolean): ArtifactUpdateIntent | undefined;
  acquireReader(role: string): Promise<ArtifactReaderHandle>;
  snapshot(): ArtifactReaderCoordinatorSnapshot;
  setOnIdle(handler: () => void): void;
  close(): Promise<void>;
}

export interface ArtifactReaderCoordinatorOptions {
  acquirePhysical: (role: string) => Promise<ArtifactPhysicalLease>;
  onIdle?: () => void;
}

const PHYSICAL_RELEASE_QUARANTINE_MESSAGE = 'artifact physical lease release is quarantined';

/**
 * One process-local reader authority over the cross-process artifact lease.
 *
 * The first logical reader owns the one physical lease. Run-lifetime readers and short sink
 * readers then share it without trying to reacquire the exclusive filesystem lock from the same
 * process. Pending readers and start/update intents are published synchronously before their first
 * await so packaging cannot pass a stale "idle" check.
 */
export class ArtifactReaderCoordinator implements ArtifactReaderCoordinatorLike {
  private readonly startTokens = new Set<symbol>();
  private pendingReaders = 0;
  private activeReaders = 0;
  private updateState: ArtifactReaderCoordinatorSnapshot['updateState'] = 'idle';
  private physicalLease: ArtifactPhysicalLease | undefined;
  private physicalAcquisition: Promise<ArtifactPhysicalLease> | undefined;
  private physicalRelease: Promise<void> | undefined;
  private physicalFault: Error | undefined;
  private idleEdgeArmed = false;
  private onIdle: (() => void) | undefined;
  private closed = false;

  constructor(private readonly options: ArtifactReaderCoordinatorOptions) {
    this.onIdle = options.onIdle;
  }

  tryBeginStart(): ArtifactStartIntent | undefined {
    if (this.closed || this.physicalFault || this.updateState !== 'idle') return undefined;
    const token = Symbol('artifact-start');
    this.armIdleEdge();
    this.startTokens.add(token);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.startTokens.delete(token);
        this.notifyIdleEdge();
      },
    };
  }

  tryBeginUpdate(activeDirectedRun: boolean): ArtifactUpdateIntent | undefined {
    if (
      this.closed
      || this.updateState !== 'idle'
      || activeDirectedRun
      || this.startTokens.size > 0
      || this.pendingReaders > 0
      || this.activeReaders > 0
      || this.isPhysicalBusy()
    ) return undefined;
    this.armIdleEdge();
    this.updateState = 'update';
    let released = false;
    return {
      handoffToRestart: () => {
        if (!released && this.updateState === 'update') this.updateState = 'restart';
      },
      release: () => {
        if (released) return;
        released = true;
        this.updateState = 'idle';
        this.notifyIdleEdge();
      },
    };
  }

  async acquireReader(role: string): Promise<ArtifactReaderHandle> {
    if (this.closed) throw new Error('artifact reader coordinator is closed');
    if (this.physicalFault) throw this.physicalFault;
    if (this.updateState !== 'idle') throw new Error('artifact update or restart is in progress');
    this.armIdleEdge();
    this.pendingReaders += 1;
    try {
      await this.ensurePhysicalLease(role);
      this.pendingReaders -= 1;
      this.activeReaders += 1;
    } catch (error) {
      this.pendingReaders -= 1;
      this.notifyIdleEdge();
      throw error;
    }

    let releasePromise: Promise<void> | undefined;
    return {
      release: () => {
        if (!releasePromise) {
          releasePromise = (async () => {
            this.activeReaders -= 1;
            if (this.activeReaders < 0) {
              this.activeReaders = 0;
              throw new Error('artifact reader reference count underflow');
            }
            await this.releasePhysicalIfIdle();
            this.notifyIdleEdge();
          })();
        }
        return releasePromise;
      },
    };
  }

  snapshot(): ArtifactReaderCoordinatorSnapshot {
    return {
      startIntents: this.startTokens.size,
      pendingReaders: this.pendingReaders,
      activeReaders: this.activeReaders,
      physicalBusy: this.isPhysicalBusy(),
      physicalFaulted: this.physicalFault !== undefined,
      updateState: this.updateState,
    };
  }

  setOnIdle(handler: () => void): void {
    this.onIdle = handler;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (
      this.startTokens.size > 0
      || this.pendingReaders > 0
      || this.activeReaders > 0
      || this.updateState !== 'idle'
    ) {
      throw new Error('artifact reader coordinator closed with active work');
    }
    if (this.physicalFault) throw this.physicalFault;
    if (this.physicalAcquisition) await this.physicalAcquisition;
    await this.releasePhysicalIfIdle();
    if (this.physicalRelease) await this.physicalRelease;
  }

  private async ensurePhysicalLease(role: string): Promise<void> {
    if (this.physicalFault) throw this.physicalFault;
    if (this.physicalRelease) await this.physicalRelease;
    if (this.physicalFault) throw this.physicalFault;
    if (this.physicalLease) return;
    if (!this.physicalAcquisition) {
      const acquisition = this.options.acquirePhysical(role);
      this.physicalAcquisition = acquisition;
      void acquisition.then(
        lease => {
          if (this.physicalAcquisition === acquisition) {
            this.physicalLease = lease;
            this.physicalAcquisition = undefined;
          }
        },
        () => {
          if (this.physicalAcquisition === acquisition) this.physicalAcquisition = undefined;
        },
      );
    }
    await this.physicalAcquisition;
  }

  private async releasePhysicalIfIdle(): Promise<void> {
    if (this.physicalFault) throw this.physicalFault;
    if (this.activeReaders > 0 || this.pendingReaders > 0 || this.physicalAcquisition) return;
    if (this.physicalRelease) {
      await this.physicalRelease;
      return;
    }
    const lease = this.physicalLease;
    if (!lease) return;
    let release!: Promise<void>;
    release = Promise.resolve()
      .then(() => lease.release())
      .then(
        () => {
          if (this.physicalLease === lease && this.physicalRelease === release) {
            this.physicalLease = undefined;
            this.physicalRelease = undefined;
          }
          this.notifyIdleEdge();
        },
        () => {
          const fault = this.physicalFault
            ?? new Error(PHYSICAL_RELEASE_QUARANTINE_MESSAGE);
          if (this.physicalLease === lease && this.physicalRelease === release) {
            this.physicalFault = fault;
            this.physicalRelease = undefined;
          }
          throw fault;
        },
      );
    this.physicalRelease = release;
    await release;
  }

  private isPhysicalBusy(): boolean {
    return Boolean(
      this.physicalFault
      || this.physicalAcquisition
      || this.physicalLease
      || this.physicalRelease,
    );
  }

  private armIdleEdge(): void {
    this.idleEdgeArmed = true;
  }

  private notifyIdleEdge(): void {
    if (
      !this.idleEdgeArmed
      || this.closed
      || this.startTokens.size > 0
      || this.pendingReaders > 0
      || this.activeReaders > 0
      || this.updateState !== 'idle'
      || this.isPhysicalBusy()
    ) return;
    this.idleEdgeArmed = false;
    this.onIdle?.();
  }
}
