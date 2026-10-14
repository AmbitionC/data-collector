import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export class OutsideInterviewHistoryError extends Error {
  constructor(public readonly code: 'inventory-invalid' | 'inventory-unavailable', detail: string, options?: ErrorOptions) {
    super(detail, options); this.name = 'OutsideInterviewHistoryError';
  }
}
const MAX_FILE_BYTES = 16 * 1024 * 1024;
function invalid(detail: string): never { throw new OutsideInterviewHistoryError('inventory-invalid', detail); }

function inside(root: string, path: string): boolean {
  const location = relative(root, path);
  return location === '' || (location !== '..' && !location.startsWith(`..${sep}`) && !isAbsolute(location));
}

/** The resource ledger is private input, explicitly selected outside the public repository. */
export async function readOutsideInterviewHistory(resourceRoot: string, historyPath: string): Promise<unknown> {
  if (!isAbsolute(historyPath) || historyPath.includes('\0')
    || historyPath.split(sep).some(part => part === '.' || part === '..')) {
    invalid('private interview historyPath must be an explicit absolute path');
  }
  const path = resolve(historyPath);
  if (inside(resourceRoot, path)) invalid('private interview historyPath must be outside the resource repository');
  try {
    const root = parse(path).root;
    const parts = path.slice(root.length).split(sep);
    let current = root;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
        invalid('private interview historyPath must be a regular file without symbolic path components');
      }
    }
    const physical = await realpath(path);
    if (inside(resourceRoot, physical)) invalid('private interview historyPath resolves inside the resource repository');
    const expected = await lstat(physical);
    if (!expected.isFile() || expected.isSymbolicLink() || expected.size > MAX_FILE_BYTES) {
      invalid('private interview source history exceeds the inventory read limit or is not a regular file');
    }
    const handle = await open(physical, constants.O_RDONLY | constants.O_NOFOLLOW);
    let contents: string;
    try {
      const observed = await handle.stat();
      if (!observed.isFile() || observed.dev !== expected.dev || observed.ino !== expected.ino
        || observed.size > MAX_FILE_BYTES || await realpath(path) !== physical) {
        invalid('private interview source history changed while opening');
      }
      const bytes = await handle.readFile();
      if (bytes.byteLength > MAX_FILE_BYTES) invalid('private interview source history exceeds the inventory read limit');
      contents = bytes.toString('utf8');
    } finally { await handle.close(); }
    try { return JSON.parse(contents) as unknown; }
    catch (error) { throw new OutsideInterviewHistoryError('inventory-invalid', 'private interview source history is invalid JSON', { cause: error }); }
  } catch (error) {
    if (error instanceof OutsideInterviewHistoryError) throw error;
    throw new OutsideInterviewHistoryError('inventory-unavailable', 'explicit outside interview source history cannot be read', { cause: error });
  }
}
