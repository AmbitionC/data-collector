import { resolve } from 'node:path';

const catalogQueues = new Map<string, Promise<void>>();

/** Serialize only catalog commits that target the same physical library root. */
export async function withCatalogTransaction<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = resolve(root);
  const previous = catalogQueues.get(key) ?? Promise.resolve();
  const result = previous.then(operation, operation);
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
