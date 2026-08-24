export type RemoteJobPriority = 'interactive' | 'batch';

interface Pending<T> {
  task: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export class RemoteJobScheduler {
  private active = 0;
  private peak = 0;
  private readonly interactive: Pending<unknown>[] = [];
  private readonly batch: Pending<unknown>[] = [];

  constructor(private readonly limit = 2) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('并发上限必须为正整数');
  }

  get activeCount(): number {
    return this.active;
  }

  get peakActiveCount(): number {
    return this.peak;
  }

  run<T>(task: () => Promise<T>, priority: RemoteJobPriority): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const pending = { task, resolve, reject } as Pending<T>;
      (priority === 'interactive' ? this.interactive : this.batch)
        .push(pending as Pending<unknown>);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.limit) {
      const pending = this.interactive.shift() ?? this.batch.shift();
      if (!pending) return;
      this.active += 1;
      this.peak = Math.max(this.peak, this.active);
      Promise.resolve()
        .then(pending.task)
        .then(pending.resolve, pending.reject)
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }
}
