import { describe, expect, it, vi } from 'vitest';
import { PlanStartAcks } from '../../packages/bridge/src/plans/planStartAcks.js';

describe('PlanStartAcks', () => {
  it('retries the identical plan dispatch until the extension acknowledges it', async () => {
    vi.useFakeTimers();
    try {
      const acks = new PlanStartAcks({ attempts: 3, timeoutMs: 1_000 });
      const send = vi.fn(() => {
        if (send.mock.calls.length === 2) acks.ack('batch:attempt');
      });

      const pending = acks.dispatch('batch:attempt', send);
      await vi.advanceTimersByTimeAsync(1_001);
      await pending;

      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails explicitly after the bounded acknowledgement budget is exhausted', async () => {
    vi.useFakeTimers();
    try {
      const acks = new PlanStartAcks({ attempts: 3, timeoutMs: 1_000 });
      const send = vi.fn();
      const pending = acks.dispatch('batch:attempt', send);
      const rejected = expect(pending).rejects.toThrow(/接单确认.*3 次/u);

      await vi.advanceTimersByTimeAsync(3_001);
      await rejected;
      expect(send).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
