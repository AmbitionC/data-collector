import { resolve } from 'node:path';
import {
  libraryCatalogLockHeld,
  withLibraryCatalogLock,
} from '../feJourney/fileLock.js';
import { recoverDirectedLibraryTransactions } from './directedTransactionJournal.js';

const catalogQueues = new Map<string, Promise<void>>();

/** Serialize only catalog commits that target the same physical library root. */
export async function withCatalogTransaction<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  const recoveredOperation = async () => {
    await recoverDirectedLibraryTransactions(root);
    return await operation();
  };
  // Candidate persistence is the outer transaction in the directed pipeline. Waiting on the
  // process queue while that async chain already owns the OS lease can deadlock behind a queued
  // writer that is itself waiting for the lease, so an exact same-root lease is reentrant here.
  if (await libraryCatalogLockHeld(root)) return await recoveredOperation();
  const key = resolve(root);
  const previous = catalogQueues.get(key) ?? Promise.resolve();
  const lockedOperation = async () => await withLibraryCatalogLock(root, recoveredOperation);
  const result = previous.then(lockedOperation, lockedOperation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  catalogQueues.set(key, tail);
  try {
    return await result;
  } finally {
    if (catalogQueues.get(key) === tail) catalogQueues.delete(key);
  }
}
