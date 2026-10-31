/** Shared across publication stores: check, journal and acknowledge before the next admission. */
export class PublicationAdmissionQueue {
  private pending: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.pending.then(work); this.pending = result.catch(() => undefined); return result;
  }
}
