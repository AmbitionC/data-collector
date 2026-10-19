import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { JobRecord } from '@data-collector/shared';
import { canonicalNowcoderDetailUrl, objectRecord } from '../feJourney/nowcoderSearchRecord.js';
import { loadStrictProcessedNowcoderHistory } from '../plans/nowcoderProcessedHistory.js';
import { readKnownNowcoderLocalSources } from './documentLoader.js';
import { assertInsideRoot } from '../library/paths.js';

/** One URL identity set for local/pending/history search gates; explicit retry runs remain separate. */
export async function knownNowcoderSources(input: {
  libraryRoot: string; targetRoot?: string | undefined; inboxDir?: string | undefined; jobs: readonly JobRecord[]; excludeRunId?: string;
  historyPath?: string | undefined; historyRoot?: string | undefined; historyCommit?: string | undefined;
}): Promise<{ urls: Set<string>; reasons: Map<string, string>; warnings: Record<string, number> }> {
  const reasons = new Map<string, string>();
  const warnings: Record<string, number> = {};
  const add = (raw: unknown, reason: string): void => {
    const url = canonicalNowcoderDetailUrl(raw);
    if (url && !reasons.has(url)) reasons.set(url, reason);
  };
  for (const entry of await readKnownNowcoderLocalSources(input.libraryRoot)) add(entry.url, entry.reason);
  for (const job of input.jobs) {
    if (job.materialKind === 'nowcoder-hot') continue;
    if (job.directedRunId === input.excludeRunId && input.excludeRunId) continue;
    if (['queued', 'dispatched', 'collecting', 'saved'].includes(job.status)) add(job.url, 'active_or_saved_job');
  }
  if (input.historyRoot && !input.historyPath) throw new Error('Explicit published inventory root requires an outside source history');
  const historyRoot = input.historyRoot ?? input.targetRoot;
  if (input.historyPath && !historyRoot) throw new Error('Configured source history requires a published inventory root');
  if (historyRoot) {
    const {snapshot} = await loadStrictProcessedNowcoderHistory(historyRoot, input.historyPath, input.historyCommit);
    for (const entry of snapshot.hashesByUrl) add(entry.url, 'processed_history');
  }
  if (input.targetRoot) {
    const root = await realpath(input.targetRoot);
    const directory = assertInsideRoot(root, join(root, input.inboxDir ?? '_inbox', 'nowcoder'));
    let entries: string[] = [];
    try {
      let part = root;
      for (const component of relative(root, directory).split(sep)) {
        part = join(part, component);
        const stat = await lstat(part);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('pending source directory unsafe');
      }
      entries = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (entries.length > 500) throw new Error('pending source index exceeds search budget');
    for (const name of entries.sort()) {
      if (name.startsWith('.')) continue; // writer-owned incomplete transaction stages are not source entries
      const entryPath = join(directory, name);
      const metadata = await lstat(entryPath);
      if (metadata.isSymbolicLink()) throw new Error('pending source entry unsafe');
      if (!metadata.isDirectory()) continue;
      let source: Record<string, unknown> | undefined;
      // RepoInboxSink writes meta.json; source.json remains supported for legacy review entries.
      for (const filename of ['meta.json', 'source.json']) {
        const sourcePath = join(entryPath, filename);
        try {
          const stat = await lstat(sourcePath);
          if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('pending source file unsafe');
          source = objectRecord(JSON.parse(await readFile(sourcePath, 'utf8')));
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      if (!source) {
        warnings.pending_entry_unavailable = (warnings.pending_entry_unavailable ?? 0) + 1;
        continue;
      }
      const document = objectRecord(source?.document);
      const url = document?.canonicalUrl ?? document?.url ?? source?.canonicalUrl ?? source?.url;
      if (!canonicalNowcoderDetailUrl(url)) {
        warnings.pending_source_missing_url = (warnings.pending_source_missing_url ?? 0) + 1;
        continue;
      }
      add(url, 'pending_inbox');
    }
  }
  return {urls: new Set(reasons.keys()), reasons, warnings};
}
