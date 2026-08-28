export interface PlanStartAckOptions {
  attempts?: number;
  timeoutMs?: number;
}

interface PlanStartWaiter {
  resolve: () => void;
}

/** WebSocket send 不是接单证明；用显式回执有界重发完全相同的 attempt。 */
export class PlanStartAcks {
  private readonly attempts: number;
  private readonly timeoutMs: number;
  private readonly waiters = new Map<string, PlanStartWaiter>();

  constructor(options: PlanStartAckOptions = {}) {
    this.attempts = options.attempts ?? 3;
    this.timeoutMs = options.timeoutMs ?? 3_000;
  }

  ack(key: string): boolean {
    const waiter = this.waiters.get(key);
    if (!waiter) return false;
    waiter.resolve();
    return true;
  }

  async dispatch(key: string, send: () => void): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let waiter: PlanStartWaiter | undefined;
      const acknowledged = new Promise<void>((resolve, reject) => {
        waiter = { resolve };
        this.waiters.set(key, waiter);
        timer = setTimeout(() => {
          if (this.waiters.get(key) === waiter) this.waiters.delete(key);
          reject(new Error(`第 ${attempt} 次接单确认超时`));
        }, this.timeoutMs);
      });
      try {
        send();
        await acknowledged;
        return;
      } catch (error) {
        lastError = error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (this.waiters.get(key) === waiter) this.waiters.delete(key);
      }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`知识星球计划未收到扩展接单确认（已尝试 ${this.attempts} 次）：${detail}`);
  }
}

export function planStartAckKey(batchId: string, attempt: string): string {
  return `${batchId}\u0000${attempt}`;
}
