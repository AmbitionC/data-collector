export type RemoteJobPriority = 'interactive' | 'batch';

interface Pending<T> {
  task: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

function abortError(): Error {
  const error = new Error('远程采集任务已取消');
  error.name = 'AbortError';
  return error;
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

  run<T>(
    task: () => Promise<T>,
    priority: RemoteJobPriority,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
      const queue = priority === 'interactive' ? this.interactive : this.batch;
      const pending = {
        task,
        resolve,
        reject,
        ...(options.signal ? { signal: options.signal } : {}),
      } as Pending<T>;
      if (options.signal) {
        const onAbort = () => {
          const index = queue.indexOf(pending as Pending<unknown>);
          if (index < 0) return;
          queue.splice(index, 1);
          options.signal?.removeEventListener('abort', onAbort);
          delete pending.onAbort;
          reject(abortError());
        };
        pending.onAbort = onAbort;
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
      queue.push(pending as Pending<unknown>);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.limit) {
      const pending = this.interactive.shift() ?? this.batch.shift();
      if (!pending) return;
      if (pending.signal && pending.onAbort) {
        pending.signal.removeEventListener('abort', pending.onAbort);
        delete pending.onAbort;
      }
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
