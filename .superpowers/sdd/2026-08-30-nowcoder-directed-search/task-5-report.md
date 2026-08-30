# Task 5 report — exact current-run selection and deterministic refill

## Implementation summary

- Added the exact target-aware selector and persisted fill coordinator. Every target from 1–10 starts with 8 details, waits for the whole current round, refills by 4 up to the hard 24-detail budget, stages only an exact target, and otherwise atomically terminalizes with the fixed actionable attention reason.
- Replaced concatenated child request IDs with one private `nowcoder-job-<64 lower-hex>` identity: full SHA-256 over a domain-separated, length-framed UTF-8 encoding of exact run ID, attempt, and canonical URL. Store validation, service dispatch/recovery, ownership checks, and tests all use the same helper; the result is protocol-valid even at maximum public input lengths.
- Extended the public run with the exact scheduled session-candidate prefix and structured progress/rejection/company surfaces. The private store atomically validates cursor/job/prefix/progress/selection/history relationships, fences Task 5 mutations to the current running attempt, clears every Task 5 field on retry, and requires total non-systemic rejection accounting.
- Added strict processed-history loading with canonical root/path checks, regular non-symlink files, genuine-leaf-`ENOENT` handling, byte/record/normalized-set bounds, runtime record validation, canonical byte-sorted snapshots, and SHA-256 digests. The first selection persists its snapshot; refill/restart verifies and reuses it rather than rereading mutable target state.
- Added a strict current-run document loader. It admits only the exact saved current-attempt job and explicit successful Markdown output, independently verifies local and Fe Journey catalogs, root containment, source projection, semantic revision, and complete local lineage, and separates per-document snapshot rejection from systemic catalog/library corruption.
- Added the runtime-validated stored organized-document envelope and pure `projectOrganized` privacy boundary. Directed lineage is derived only after candidate enrichment and organization, stays solely in local `source.json`, never changes the delivery revision, and is stripped before ordinary sync, ZSXQ reads, or Fe Journey rebuild rewrites.
- Made the local Markdown evidence sink an internal reserved instance/capability. Directed persistence now accepts only an object-identity-authorized result from that instance; a configured sink named `markdown` cannot replace it, and a Markdown alias cannot impersonate a directed destination.
- Added the typed `repo-inbox` / `exact-capable` directed target descriptor and wired the coordinator only to that exact repository root. Ordinary router behavior remains compatible, while artifact `repoRoot`, Markdown aliases, and user-controlled sink IDs are never publication/history authority.
- Selection recovery now caches only an explicit committed callback whose claimed fingerprint is reread and proven to be the exact changed durable checkpoint. Paused/guarded/no-mutation callbacks remain replayable. Stale/foreign/uncheckpointed jobs and historical pending pools are never loaded or counted.

## Review-fix closure

- Every store mutation now runs the same complete private-envelope validator before atomic write. It validates the frozen prefix, cursor and rounds, exact derived current-job identities, full private/public rejection audit, normalized history digest/limits, and delivery identities; every successful envelope is immediately reopenable. Generic checkpoints cannot enter `publishing`: the exact validated staging-to-publishing cutover has its own atomic method.
- Checkpoints carry an explicit durable `selectionAuditComplete` state. Every running/cancelling phase (including collecting), publishing/completed/failed runs, and `DIRECTED_TARGET_UNAVAILABLE` require `sum(rejectionCounts) = detailScheduled - accepted`; only the dedicated cancelled cleared-audit state or a fixed systemic attention state may clear the audit. Private rejections have fixed code/message contracts, exact current-prefix job/URL ownership, uniqueness, and exact public counts.
- Post-guard selection reconstructs `detailSaved`, inspected/qualified/accepted counters, private rejections, and delivery items from a freshly reloaded exact scheduled prefix. A concurrent rewrite of an unaccepted snapshot therefore changes the committed rejection audit instead of preserving stale pre-guard state.
- Optional Nowcoder evidence metadata is no longer authoritative: company/role/round/date/access/grade/reasons/count fields are stripped before body analysis and overwritten from the document. Recency uses finite timestamps only; an invalid interview date falls back to a valid publication time, otherwise rejects as `OUTSIDE_30_DAYS`.
- Persisted history is normalized, size/record bounded, and its exact digest is recomputed during reopen only while selection can still consume it. Corrupt/oversized running pre-publish checkpoints atomically converge to fixed attention; cancelling, publishing, and terminal envelopes remain byte-authoritative so Task 6/8 recovery and terminal evidence are not rewritten. No global fallback is read.
- Systemic exits recompute immutable `detailSaved` only from exact current-prefix JobRecords owned by the current run/attempt with a valid Markdown output proof. Persistent directed pin sets protect those JobRecords across restart and terminal pruning. Legacy jobs files now use an explicit startup bootstrap: pruning is deferred until the directed store installs and persists the exact active pin set; unpin occurs only after a durable terminal checkpoint.
- Directed local/candidate catalog preflight is read-only and happens before directory, lock, or content writes. It checks canonical roots, ancestor/leaf symlinks, genuine leaf absence, containment, canonical URL/source/stable-ID identity, uniqueness, regular entry files, each existing entry's `source.json` sibling, and candidate representative identity; the catalogs are revalidated after acquiring a canonical in-root lock. Later directed local failures also map to the fixed local systemic code. Catalog paths use a platform-independent POSIX-slash protocol, safely normalize new Windows writer output, and still reject mixed separators, absolute/UNC paths, and traversal.
- The authoritative locked catalog/source read now uses `O_NOFOLLOW` file descriptors with device/inode comparison, binds a missing leaf to the same validated parent inode, and carries the complete normalized catalog plus source presence/inode/contents fingerprint into `saveNow`. Outer and locked fingerprints must match, so deletion, inode replacement, symlink swaps, and a shape-valid catalog substitution cannot be reinterpreted as a fresh empty library or overwrite a different entry.
- Legacy private rejection rows without `message` are validated in their old `{jobId,url,code,detail}` shape and atomically migrated by deriving the canonical fixed message from `code`; invalid codes, extra shapes, identities, and incomplete public/private totals still fail closed. Publishing/completed exact partitions, the cancelled cleared-audit state, and the public/private status-phase matrix are all checked again during every mutation and reopen.
- Envelope-v1 checkpoints from before rejection totality are now recognized before the current run schema is applied. Only an exact frozen/current scheduled prefix with `detailSaved=inspected=qualified=accepted=delivered=0` in running/cancelling/failed state can migrate: every consumed job is deterministically reconstructed as `DETAIL_NOT_SAVED`, the public/private totals and audit flag are persisted, and the resulting bytes reopen unchanged. Any saved/inspected/qualified/accepted progress or identity-unprovable legacy state is rejected with the original bytes unchanged rather than guessing a hard-gate, duplicate, or history reason.
- Dedicated cancellation completion preserves immutable inspected work together with discovered/scheduled/saved counters and the exact scheduled candidate/job prefix. It clears only selection, rejection, company and delivery state; selecting and staging cancellation checkpoints both reopen with the original inspected count.
- When no exact local catalog entry exists, directed preflight now treats deterministic `index.md` and `source.json` as a paired orphan boundary. Any pre-existing regular, protected, directory, symlink or mismatched artifact fails with the fixed local-library code before the candidate lock or any catalog/content/assets mutation; exact registered updates and genuinely new entries remain supported.
- A genuinely new directed entry is now assembled under one unpredictable transaction-owned staging directory inside the bound catalog directory. Its stable-ID/content-hash final leaf is absent until the complete asset/Markdown/source tree has been descriptor-validated and closed; the complete directory is then published under the cooperative directed lock. Assets use a unique staging directory and are deduplicated by final filename plus exact bytes/MIME. Cleanup moves a provably owned published tree back to a unique name and recursively removes only the exact tracked tree; any unexpected inode or child is preserved.
- Directed catalog updates never truncate or restore the live file. The writer requires `nlink=1`, binds the catalog parent and exact inode/bytes/hash, writes and syncs one unpredictable complete sibling, revalidates immediately before commit, then uses one atomic rename for both existing and absent catalogs. Rename is the commit point; post-commit diagnostics cannot convert an authoritative local receipt into a reported failure. File handles become closed only after `close()` resolves, commit uses strict close, and cleanup retries a transient close before touching its unique artifacts.
- The transaction threat boundary is explicit: all data-collector writers cooperate through the outer directed library lock and the in-process catalog queue. Stable-path absence plus rename is safe under that authority and ordinary readers never see partial catalog JSON. A same-UID process that deliberately ignores the lock is outside the protocol because Node exposes no portable directory `RENAME_NOREPLACE`/filesystem compare-and-swap primitive; obsolete tests that simulated such an actor by writing directly through the lock were removed rather than claiming an impossible guarantee.
- Directed `job.collect` is explicitly non-interactive at both the Bridge dispatch site and shared payload contract, independent of `batchId`. Task 6 owns the subsequent browser-tab cancellation/physical-close mechanics.

## Files

Created:

- `packages/bridge/src/library/storedDocument.ts`
- `packages/bridge/src/nowcoderDirected/documentLoader.ts`
- `packages/bridge/src/nowcoderDirected/jobIdentity.ts`
- `packages/bridge/src/nowcoderDirected/selection.ts`
- `tests/unit/nowcoderDirectedFill.test.ts`
- `tests/unit/storedOrganizedDocument.test.ts`
- `.superpowers/sdd/2026-08-30-nowcoder-directed-search/task-5-report.md`

Modified:

- `packages/bridge/src/feJourney/candidateIndex.ts`
- `packages/bridge/src/feJourney/fileLock.ts`
- `packages/bridge/src/feJourney/nowcoderEvidence.ts`
- `packages/bridge/src/feJourney/rebuildIndex.ts`
- `packages/bridge/src/feJourney/save.ts`
- `packages/bridge/src/jobs/store.ts`
- `packages/bridge/src/library/sync.ts`
- `packages/bridge/src/library/assets.ts`
- `packages/bridge/src/library/writer.ts`
- `packages/bridge/src/library/zsxqIndex.ts`
- `packages/bridge/src/nowcoderDirected/service.ts`
- `packages/bridge/src/nowcoderDirected/store.ts`
- `packages/bridge/src/plans/nowcoderPlan.ts`
- `packages/bridge/src/plans/nowcoderProcessedHistory.ts`
- `packages/bridge/src/server/index.ts`
- `packages/bridge/src/sinks/markdownLibrarySink.ts`
- `packages/bridge/src/sinks/router.ts`
- `packages/shared/src/model.ts`
- `packages/shared/src/nowcoderDirected.ts`
- `packages/shared/src/protocol.ts`
- `tests/unit/feJourneyRebuildIndex.test.ts`
- `tests/unit/jobs.test.ts`
- `tests/unit/library.test.ts`
- `tests/unit/nowcoderDirected.test.ts`
- `tests/unit/nowcoderDirectedCapability.test.ts`
- `tests/unit/nowcoderDirectedOwnership.test.ts`
- `tests/unit/nowcoderDirectedRecovery.test.ts`
- `tests/unit/nowcoderDirectedStore.test.ts`
- `tests/unit/nowcoderPlan.test.ts`
- `tests/unit/nowcoderProcessedHistory.test.ts`
- `tests/unit/plans.test.ts`
- `tests/unit/sinks.test.ts`

## Witnessed TDD evidence

Every npm command used Node 22 through:

```sh
env PATH=/Users/chenhao/.nvm/versions/node/v22.22.3/bin:/usr/bin:/bin
```

### Initial Task 5 RED

Before production implementation, the first focused matrix covering selector targets, strict history, shared public progress, store/recovery, stored projection, and fill behavior produced:

```text
Test Files  5 failed
Tests  4 failed | 17 passed
2 additional suites failed to load because the Task 5 modules/APIs did not exist
```

The observed gaps were the hard-coded selector target, absent public progress contract, absent strict history APIs, and missing selection/stored-envelope modules.

### Deterministic child-ID RED

After adding the maximum-length lineage regression, temporarily restoring the old concatenated derivation produced:

```text
Test Files  1 failed (1)
Tests  1 failed
```

The received ID was the oversized run/attempt/URL concatenation instead of `^nowcoder-job-[a-f0-9]{64}$`. Restoring the full SHA-256 helper made the request ID protocol-valid and exactly reproducible after reopen; a one-byte URL change produces a different ID.

### Review-amendment REDs

The Task 4 compatibility matrix initially exposed five deterministic regressions from Task 5 staging/finalization behavior:

```text
Test Files  2 failed (2)
Tests  5 failed | 46 passed
```

Updating the fixtures to a valid exact staging checkpoint and isolating the persistence-reader ordering assertion produced 51/51 GREEN.

Mutation witnesses for strict normalized history, exact attention code/message, non-systemic rejection totality, and wrong-entry directed catalog preflight produced four behavioral failures (three in one 65-test matrix plus the isolated writer regression). Restoring the defenses produced:

```text
Test Files  6 passed (6)
Tests  80 passed (80)
```

Additional direct REDs witnessed:

- a saved foreign/old-attempt job incorrectly triggered local catalog access (`1 failed | 7 passed`); exact ownership filtering now returns zero loaded/saved without touching catalogs;
- an oversized persisted normalized history set was misclassified as corruption (`1 failed`); it now yields `DIRECTED_HISTORY_LIMIT_EXCEEDED`;
- a malformed directed local catalog error lacked the stable systemic code (`1 failed`); it now yields `DIRECTED_LOCAL_LIBRARY_CORRUPT` and preserves the corrupt bytes.
- removing the post-staging-guard lineage revalidation produced one isolated deterministic failure: the coordinator staged a document whose accepted local lineage was overwritten while the guard was pending. Restoring the revalidation pauses the pass and leaves the selection checkpoint unchanged.
- weakening the strict directed-catalog catch to accept an invalid identity made `fails closed on directed strict-catalog case identity` resolve instead of reject (`1 failed`); restoring fail-closed preflight returns `DIRECTED_LOCAL_LIBRARY_CORRUPT` before any lock/write.
- allowing configured key `markdown` to overwrite the reserved local sink made the malicious repo-inbox receive the document (`1 failed`); restoring the reserved instance and object-identity authority keeps local evidence inside the configured library.
- the cancellation audit regression proves a `cancelling` selecting run with an empty rejection audit is rejected, while the same run with total fixed audit and the dedicated `cancelled` zero state parse successfully.

### Review-fix round 2 RED/GREEN

The round-2 compatibility/state matrix first produced 10 deterministic failures across the shared/store suites. The witnessed gaps were legacy rows without `message`, collecting totality, non-running history rewrite, publishing/status phase mismatches, completed partition overlap, and cancelled private residue. After the canonical migration and validator changes:

```text
Test Files  2 passed (2)
Tests  48 passed (48)
```

Additional root-cause witnesses were run independently before implementation:

- legacy jobs without pins and 1,005 newer terminal jobs pruned the oldest active directed proof (`1 failed`); the deferred bootstrap/reconcile protocol made both the focused retention/unpin pair and a real `startBridge` startup regression pass;
- a route whose Markdown aliases preceded a valid repo inbox returned `markdown`/`undefined` (`1 failed`); both ordinary `syncTarget` and directed exact-target lookup now skip every Markdown instance and select the first `RepoInboxSink`;
- the Windows-native relative-path encoder was absent (`1 failed`); writer output now normalizes to the POSIX catalog protocol, the pure Windows fixture is host-independent, and an ordinary catalog survives two consecutive directed saves;
- existing `source.json` symlink/directory cases leaked raw filesystem errors and changed Markdown before failure (`2 failed`); symlink, directory, unreadable-file, and true-leaf-missing cases now pass, and the candidate-index integration proves corrupt source evidence fails before `fe-journey.lock` creation with both catalogs unchanged;
- a trusted local sink failure without a caller-visible code incorrectly resolved (`1 failed`); object-identity authority now maps every trusted directed local failure to `DIRECTED_LOCAL_LIBRARY_CORRUPT`;
- failed scheduled envelopes with erased audit passed both public and private validation (`2 failed`); failed terminal runs now retain the same exact scheduled-prefix partition, while explicit systemic attention and the dedicated cancelled cleared-audit state remain the only audit exemptions.
- an `ENOENT` thrown by the legacy directed-store migration write was swallowed as “store absent” (`1 failed`); only the initial read may now establish absence, while migration-write failure propagates without replacing the durable envelope;
- a marker-verified attention envelope with cursor greater than target could not migrate its retained audit, and publishing/attention private delivery could disagree with public items, receipt, recovery IDs, or marker hashes (`4 failed`); post-marker attention now retains the total accepted/rejected partition and every publication evidence surface is cross-checked;
- a host-independent Windows legacy path, cross-cluster/chained candidate representatives, and an unbootstrapped pin set surviving an unrelated mutation/restart produced five deterministic failures; the POSIX migration seam, representative self-root invariant, and explicit durable `directedPinsBootstrapped` state close them;
- startup pruning swallowed an injected `ENOENT` from its persist step (`1 failed`); `JobStore.open` now isolates initial-read absence and propagates every later write failure;
- candidate catalog inode substitution and parent-directory replacement are covered by deterministic injected-I/O regressions. Both candidate and Markdown catalog readers bind the opened descriptor/optional absence to the originally validated inode, and locked Markdown save consumes the validated source snapshot without a second optional-leaf observation.

Strengthening collecting totality deliberately exposed old test fixtures that created a scheduled prefix without its already-required conservative `DETAIL_NOT_SAVED` audit. The first cumulative runs showed `16 failed | 193 passed` in Task 5 and `6 failed | 204 passed` in Task 4. The fixtures were upgraded without weakening production validation; the final matrices below are fully green.

### Review-fix round 3 RED/GREEN

The round-3 regressions were added before production changes and produced 11 deterministic failures across three focused files:

```text
Test Files  3 failed (3)
Tests  11 failed | 93 passed (104)
```

The failures witnessed all three remaining roots: current-schema validation ran before a provable legacy totality migration (three lifecycle states), cancelled schema/mutation erased `inspected` (shared plus selecting/staging store cases), and an unmatched deterministic local artifact was overwritten or reached the candidate lock (four index leaf forms plus source identity). After the envelope-v1 migration, cancellation invariant, and paired orphan preflight changes, the same fresh command passed:

```text
Test Files  3 passed (3)
Tests  104 passed (104)
```

The migration test persists and reopens exact canonical bytes for running, cancelling, and failed collecting checkpoints; a legacy `accepted>0` state without private identity proof remains fail-closed. The Task 6 reader/owned-tab proof work is explicitly recorded in its brief and ledger and was not implemented early.

### Review-fix round 4 RED/GREEN

The legacy totality matrix first showed nine deterministic failures: running, cancelling, and failed checkpoints with saved, inspected, or qualified progress were incorrectly migrated as `DETAIL_NOT_SAVED`. The three truly zero-progress lifecycle fixtures remained green. Requiring all five post-schedule progress fields to be zero made the complete focused matrix pass:

```text
Tests  12 passed (12)
```

The first no-clobber regressions then showed four failures: leaf replacement and parent replacement during blocked asset work were committed, while competing exclusive creates proved the transaction had not reserved either leaf. After the initial reservation implementation those four passed. A second deterministic review witness exercised the exact pre-`O_EXCL` boundary, owned-removal boundary, and long asset-window catalog replacement; it produced five failures while the already-safe foreign asset-directory case passed. The descriptor-bound catalog/leaf/asset transaction and exact downloader manifest made the final focused boundary matrix pass:

```text
Tests  10 passed | 29 skipped (39)
```

The tests prove that a foreign index/source/catalog or replacement parent retains its exact bytes, the candidate catalog is not committed, only transaction-owned artifacts are removed, missing catalogs are created exclusively, and successful ordinary/new directed saves remain compatible.

### Review-fix round 5 RED/GREEN

Round 5 replaced the accumulated per-path rollback protocol rather than adding another removal check. Eleven deterministic tests were added first for unique staging visibility, same-inode catalog mutation, hard-linked catalog rejection, catalog-parent replacement, post-open initialization failure, duplicate images, foreign staging assets, cleanup replacement, pre-catalog-commit rollback, and atomic whole-catalog visibility. Before the replacement they produced:

```text
Test Files  1 failed (1)
Tests  11 failed | 39 skipped (50)
```

The coherent staging/atomic-catalog transaction made the same focused matrix pass 11/11. Obsolete Round 4 fixtures that required final `index.md`/`source.json` to exist during a blocked fetch, or injected a same-UID writer that ignored the already-held application lock, were removed. Their useful ownership assertions were replaced by unique-name/descriptor tests; the blocked-fetch test now also proves the final hierarchy is absent.

The final transaction audit then found two post-commit/descriptor-lifecycle gaps. Deterministic regressions witnessed both before the fix:

```text
Test Files  1 failed (1)
Tests  2 failed | 41 skipped (43)
```

One showed that a first `close()` failure was swallowed and never retried; the other showed that an absent-catalog hard-link commit could report failure after becoming authoritative and leave `nlink=2`. Strict close with exact cleanup retry and a single rename commit point made both tests pass 2/2. A catalog-parent replacement is now injected at the final pre-catalog boundary; the complete published tree retreats to a new unique sibling under its still-bound final parent before cleanup, while the foreign catalog parent remains byte-for-byte untouched.

The resulting full fill suite passes 43/43, including ordinary registered-entry updates and genuinely new entries. Round 4 legacy totality/cancellation/orphan tests remain unchanged and green. The final independent read-only transaction audit reported no Critical or Important findings.

### Review-fix round 6 RED/GREEN

Round 6 closes the remaining application-level durability boundary instead of treating the
process-local catalog queue as a cross-process transaction. The first two deterministic
regressions failed before implementation:

```text
Test Files  1 failed (1)
Tests  2 failed (2)
```

The real `lockf`/`flock` child held `_catalog/fe-journey.lock`, then committed an entry from its
old catalog snapshot while an ordinary `MarkdownLibrary.save` ran concurrently; the ordinary
entry was lost. A second regression let `deleteEntries` finish while a directed save was blocked
at `beforeCatalogCommit`; the directed transaction then failed its stale-catalog check. The library
transaction now uses the same legacy-named OS lock as Fe Journey so old and new application
versions cooperate. A module-private `AsyncLocalStorage` lease makes exact same-physical-root
nesting reentrant, invalidates detached stale contexts before unlock, and checks ownership before
either the main catalog queue or candidate queue. This prevents both OS-lock/catalog-queue and
OS-lock/candidate-queue ABBA. Ordinary save, directed save, sync finalization, delete/clear,
candidate writes and rebuild all hold the one authority over their complete read-modify-write
window. The focused lock/manage matrix is green, including a candidate waiter ahead of a nested
manage callback and a detached-continuation lease regression.

The durable directed-entry transaction now writes a versioned marker inside its unique staging
tree and an exact pointer inside `_catalog` before publishing the entry. The canonical journal
contains a random transaction ID, stable content/source/URL identity, platform-independent entry,
Markdown/source/catalog-stage paths, the catalog-before and catalog-after SHA-256 digests, the
exact catalog entry, and a sorted full-SHA-256/byte-length manifest for Markdown, source and every
asset. Both copies and their directories are synced before entry publication. The marker is
private transaction metadata and is removed before a successful save becomes visible to delivery.

A bundled real child process was killed with `SIGKILL` at three production boundaries:

- after marker/catalog staging but before entry publication;
- after entry publication but before catalog commit;
- after catalog commit but before marker cleanup.

The first pre-implementation checkpoint witness failed because no durable journal pointer existed.
Under the shared OS lock, reopen now validates every marker, source identity, tree leaf, full hash,
catalog stage and before/after digest. It resumes the exact marker-owned hidden stage by first
establishing a durable pointer, resumes the atomic catalog rename for a complete published entry,
or removes a stale marker after proving the catalog already committed. It never enters a second
multi-path rollback after the journal becomes durable. Unmarked or mismatched deterministic
orphans remain fixed-code corruption and are neither adopted nor deleted. All three killed-child
cases then reopen/retry to exactly one catalog entry and one receipt path with no `.directed-*` or
marker leaf; a separate mismatched-marker regression preserves the foreign bytes and fails closed.

The immutable replacement path is also used for an already registered directed entry. Its old
Markdown/source/assets directory remains byte-stable until the catalog rename commits. The journal
records the exact previous catalog entry; catalog-after finalization renames that old directory to
the transaction-owned retired name and removes it before clearing marker/pointer authority. A crash
at any point replays that retirement, so repeated repair does not accumulate invisible old entry
directories.

The asset filename collision tracker no longer stores response `Uint8Array`s. Each sequentially
written asset leaves only filename, full SHA-256, byte length, MIME and relative URL metadata.
An exact repeated filename reuses the staged asset; a full-hash/length/MIME mismatch fails closed.
The initial instrumentation test failed because the bounded tracker did not exist. Its GREEN form
injects thirty synthetic 10 MiB fingerprints without allocating 300 MiB, inspects all retained
production records, and proves that their serialized state is O(n) fixed-size metadata with no
`bytes` field.

The transaction threat boundary remains cooperative and explicit. The OS lock is authority for
all data-collector processes using this library. Every live catalog is installed by one complete
atomic rename; readers never observe partial JSON. Symlink, hard-link, path/parent substitution,
journal mismatch and hash mismatch fail closed. A same-UID actor that deliberately ignores the
application lock is still outside the portable Node filesystem protocol; Round 6 does not claim a
kernel compare-and-swap primitive that does not exist.

The final external transaction review produced three additional deterministic RED witnesses before
freeze:

- a registered-entry child killed before catalog commit had already changed the old Markdown byte;
- a pre-commit cleanup could remove the catalog temp after a later cleanup cut failed, leaving an
  unrecoverable journal state;
- a `journal-pointer` exclusive-open/init interruption left a partial pointer that preflight could
  not reopen (`1 failed` in the isolated pointer regression).
- the durable marker-only cut recovered under the lock but was not recognized by the earlier
  read-only preflight, so the same `save()` incorrectly returned fixed corruption after committing
  its catalog (`1 failed`); exact stage-marker discovery now marks that recovery authoritative.

The final protocol keeps every pre-commit journal component intact and resumes it, binds the pointer
descriptor at `O_EXCL` registration time, and repairs only an exact transaction-ID partial pointer
from a fully validated durable stage marker. Marker and catalog-temp parent entries are fsynced
before pointer creation. Both source `_catalog` and destination parent directories are fsynced after
the cross-directory stage-to-final rename, and the catalog directory is fsynced immediately after
the catalog rename before marker-first cleanup. Catalog-after plus pointer-only, marker-only plus
catalog-before, partial-pointer plus exact stage, and registered replacement retirement all have
focused reopen coverage. The final Round 6 focused matrix is:

```text
Test Files  5 passed (5)
Tests  121 passed (121)
```

Round 6 created:

- `packages/bridge/src/library/directedTransactionJournal.ts`
- `tests/fixtures/directedCatalogCrashChild.ts`
- `tests/unit/libraryCatalogDurability.test.ts`

It additionally modified the shared lock/candidate/catalog transaction paths, library
writer/manage/assets code, and their focused compatibility tests.

### Final focused GREEN

```sh
npm test -- tests/unit/nowcoderDirectedFill.test.ts tests/unit/nowcoderPlan.test.ts tests/unit/nowcoderProcessedHistory.test.ts tests/unit/storedOrganizedDocument.test.ts tests/unit/nowcoderDirected.test.ts tests/unit/nowcoderDirectedStore.test.ts tests/unit/nowcoderDirectedRecovery.test.ts tests/unit/collectionPlanService.test.ts tests/unit/library.test.ts tests/unit/feJourneyRebuildIndex.test.ts tests/unit/jobs.test.ts
```

Fresh result:

```text
Test Files  11 passed (11)
Tests  276 passed (276)
```

This matrix includes target 1/7/10 fill decisions, 8+4/max-24 behavior, whole-round waiting, current-run-only loading, nine current jobs plus twenty unrelated historical jobs, exact lineage/revision/catalog checks, corrupt catalog systemic codes, snapshot/digest tamper attention, privacy projection and rebuild stripping, explicit Markdown output/retry clearing, committed-versus-paused recovery caching, public schema totality, and strict-history limits.

The cumulative Task 4 regression matrix also passed after Task 5:

```text
Test Files  10 passed (10)
Tests  250 passed (250)
```

Command:

```sh
npm test -- tests/unit/nowcoderDirectedRecovery.test.ts tests/unit/nowcoderDirectedOwnership.test.ts tests/unit/build-stamp.test.ts tests/unit/auto-reload.test.ts tests/unit/artifactReaderCoordinator.test.ts tests/unit/nowcoderDirectedCapability.test.ts tests/unit/nowcoderDirected.test.ts tests/unit/nowcoderDirectedStore.test.ts tests/unit/auto-update.test.ts tests/unit/connection.test.ts
```

Additional catalog/router/server/job-store coverage passed:

```sh
npm test -- tests/unit/sinks.test.ts tests/unit/plans.test.ts tests/unit/feJourneyIndex.test.ts tests/unit/remoteJobScheduler.test.ts tests/unit/background.test.ts
```

```text
Test Files  5 passed (5)
Tests  208 passed (208)
```

Fresh `npm run typecheck` completed with exit code 0 after the final production and test changes. Final unstaged and cached diff checks are run after this report update and staging, respectively; their exact results accompany the immutable snapshot handoff.

## Round 7 — intent-first crash recovery and exact replacement retirement

The final durability review found four application-level gaps. Focused regressions were written
before their production changes and witnessed `5 failed | 2 passed`: recovery occurred after an
unrelated directed baseline had already been frozen, no durable intent existed before staging,
valid-short pointer bytes were rejected, and both an unexpected registered-tree file and a file
added after inventory could be removed during retirement. The first cumulative Task 5 run later
exposed two expected compatibility REDs (`2 failed | 274 passed`) where safe, descriptor-owned
in-process initialization failures left an intent for restart recovery instead of eagerly removing
their exact files. Cleanup now retains crash durability while still closing/removing those fully
owned pre-manifest leaves.

Round 7 establishes this order under the one shared cross-process catalog lease:

1. Recover every pending library transaction before rebuilding any directed candidate/catalog
   baseline.
2. Inventory a registered old tree as a sorted relative-path/type/byte-length/full-SHA-256
   manifest before creating transaction bytes. Only `index.md`, optional `source.json`, and direct
   regular single-link `assets/*` leaves are application-owned. Unknown, linked, changed, or
   replaced bytes fail closed and remain untouched.
3. Atomically install and fsync a minimal non-content intent before creating the hidden staging
   directory, Markdown/source/assets, or catalog stage. The full transaction marker is written to
   an unpredictable staging temp, fsynced, then atomically renamed; the full catalog pointer is
   upgraded the same way from the exact intent. No full manifest is exposed incrementally.
4. Under the lease, an exact marker may repair only its own zero/prefix/valid-short pointer or an
   identity-matching intent. A valid-JSON pointer with a different identity remains byte-for-byte
   unchanged and raises fixed local-library corruption. Intent-only and partial-marker crash states
   remove only transaction-reserved names; published states resume the entry/catalog commit.
5. After catalog commit, old-tree retirement re-inventories and compares the complete persisted
   manifest before its single rename into the unique retired namespace. User-added or modified
   bytes preserve the old tree and the recovery journal instead of being recursively deleted.

Four real child-process `SIGKILL` checkpoints cover immediately after intent durability,
catalog-temp exclusive-open, marker exclusive-open, and a complete marker temp immediately before
its atomic install. The existing child matrix still covers pre-entry-commit, pre-catalog-commit and
post-catalog-commit. Retry converges to one catalog entry/receipt and removes all reserved journal
names. The focused durability file finished:

```text
Test Files  1 passed (1)
Tests  27 passed (27)
```

Fresh cumulative Round 7 verification:

```text
Task 5:     Test Files 11 passed (11), Tests 276 passed (276)
Task 4:     Test Files 10 passed (10), Tests 250 passed (250)
Additional: Test Files  5 passed (5),  Tests 208 passed (208)
Typecheck:  exit 0
git diff --check: exit 0
```

The documented threat boundary remains cooperative application writers under the shared OS lease.
A same-UID process deliberately mutating paths while ignoring that lease is not presented as a
portable kernel compare-and-swap guarantee. Within the application boundary, path substitution,
symlink/hard-link identities, journal/pointer identity mismatches, content changes and incomplete
transaction states all fail closed or recover from exact durable authority.

## Round 8 — independent final-marker authority and resumed retirement proof

Two independently confirmed recovery gaps produced three deterministic focused REDs:

```text
Test Files  1 failed (1)
Tests  3 failed | 26 skipped (29)
```

- Both corrupt JSON and a structurally valid but foreign final marker were accepted by a
  tautological pointer comparison, replacing the previously authoritative pointer bytes before the
  later recovery failure.
- A crash state that had already renamed the old registered tree into the unique retired namespace
  could receive `user-notes.txt`; resumed recovery then recursively deleted it without rechecking
  the persisted retirement manifest.

Recovery now parses a final marker as an independent journal before any repair write. Its version,
transaction identity, stable content identity, catalog/entry paths, catalog hashes and file hashes
must all validate, and its bytes must be authorized by the exact/prefix pointer or the exact bound
intent. The old `parseJournal(pointer) === pointer-derived-journal` fallback no longer exists.
Corrupt and foreign markers therefore leave both marker and pointer byte-for-byte unchanged and
surface fixed local-library corruption even when an unrelated directed document triggers recovery.

Old-tree deletion now applies the same proof at both retirement cuts. After a fresh rename and when
resuming from a pre-existing retired directory, recovery immediately re-inventories the retired
tree, streams full SHA-256 hashes, compares the exact sorted type/path/size/hash manifest, and
revalidates the retired-directory and parent inodes before recursive removal. Unknown, changed or
replaced bytes preserve both the retired tree and journal.

Focused Round 8 GREEN:

```text
Test Files  1 passed (1)
Tests  29 passed (29)
```

Fresh cumulative Round 8 verification after the production changes:

```text
Task 5:     Test Files 11 passed (11), Tests 276 passed (276)
Task 4:     Test Files 10 passed (10), Tests 250 passed (250)
Additional: Test Files  5 passed (5),  Tests 208 passed (208)
Typecheck:  exit 0
```

An initial Task 5 run executed concurrently with the Task 4 matrix exhausted the existing
15-second timeout in the unrelated JobStore concurrency stress test (`1 failed | 275 passed`). The
exact test passed alone in 1.95 seconds, and the full Task 5 matrix then passed sequentially as shown
above; no timeout or JobStore production code was changed. Final unstaged/cached diff checks and
the immutable tree identity accompany the Round 8 snapshot.

## Round 9 — resumable retired-tree recursive deletion

The last targeted durability review identified the power-loss cut inside recursive deletion itself.
After the old tree had passed its full manifest check and entered the unique retired namespace,
`rm({ recursive: true })` could delete only a prefix of leaves before `SIGKILL`. The next recovery
incorrectly required the original complete manifest and therefore could not finish deleting an
otherwise wholly owned remainder.

Four real partial-tree fixtures were RED before the production change:

```text
Test Files  1 failed (1)
Tests  4 failed | 2 passed | 28 skipped (34)
```

They cover an already deleted `index.md`, one deleted asset while the assets directory remains
nonempty, every asset leaf deleted while the empty assets directory remains, and the whole assets
subtree already removed. Separate unknown-path and changed-source fixtures remained fail-closed
throughout.

Retired-tree recovery now inventories every remaining directory and leaf with the same strict
rules used by the original retirement proof. Each observed path must exist in
`journal.replacedTree` with exactly the same type, byte length and streamed full SHA-256. Missing
manifest members are accepted only as an already retired prefix; unknown paths, symlinks,
hardlinks, unexpected directories and changed bytes still preserve the retired tree and journal.
After this exact subset proof, recursive removal can continue, and any later crash produces another
valid strict subset.

Focused Round 9 GREEN:

```text
Test Files  1 passed (1)
Tests  34 passed (34)
```

Fresh cumulative Round 9 verification:

```text
Task 5:     Test Files 11 passed (11), Tests 276 passed (276)
Task 4:     Test Files 10 passed (10), Tests 250 passed (250)
Additional: Test Files  5 passed (5),  Tests 208 passed (208)
Typecheck:  exit 0
```

Final unstaged/cached diff checks and the exact tree identity accompany the Round 9 immutable
snapshot.
