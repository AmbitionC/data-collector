# ZSXQ Owner History Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed 15-day/20-item owner scan with a resumable owner-history audit and Shanghai-day ledger, while filtering and deduplicating before expensive body completion and delivering every qualifying complete owner post exactly once.

**Architecture:** Keep the existing `zsxq-chen-teacher` plan and add `daily-ledger` and `owner-history` modes. The Bridge owns an atomic day-ledger/checkpoint file and finalizes days only after the current attempt's jobs are terminal; the extension fetches one signed owner page at a time, processes and awaits that page's job receipts, then reports the safe next cursor. A compact local-library ZSXQ index supplies exact completeness and semantic signatures before any linked-article completion.

**Tech Stack:** TypeScript 5, Node.js 22, Zod, Chrome Extension MV3, signed ZSXQ v2 API, Vitest, JSON atomic persistence.

**Spec:** `docs/superpowers/specs/2026-08-28-zsxq-owner-history-ledger-design.md`

## Global Constraints

- Work only on `master`; preserve and never stage unrelated `delivery-idempotency` work already present in the shared worktree.
- Use `apply_patch` for source and documentation edits.
- Repository scripts must run under Node `>=22.12`; on this host prefix commands with `env PATH="/Users/chenhao/.nvm/versions/node/v22.22.3/bin:/Users/chenhao/Library/pnpm:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"`.
- The owner-history path must prove API exhaustion with a short/empty page; a safety cap, repeated cursor, invalid order, auth failure, incomplete body, or failed save is never success.
- Closed Shanghai days end in `completed_content`, `completed_empty`, or `failed`; the current Shanghai day is provisional and is never finalized.
- Exact complete and high-confidence semantic duplicates must be rejected before linked-article completion; known incomplete/unknown entries must be repaired.
- Existing topic/ad filters remain deterministic and early; relevance is checked only after full-body completion.
- Do not persist cookies, localStorage, complete article bodies, or session credentials in the ledger/checkpoint.
- Every code commit bumps the repository patch version once. Tasks 1–6 therefore keep tested working-tree checkpoints without committing; Task 7 makes one scoped implementation commit after the unrelated delivery-idempotency commit has landed.
- Required final checks are `npm run typecheck`, `npm test`, `npm run package`, and `npm run test:e2e` under Node 22.

---

### Task 1: Shared owner-mode, audit, day, and checkpoint contracts

**Files:**
- Modify: `packages/shared/src/plans.ts`
- Modify: `packages/shared/src/protocol.ts`
- Test: `tests/unit/plans.test.ts`
- Test: `tests/integration/cli.test.ts`

**Interfaces:**
- Produces: `ZsxqCollectionMode = 'daily-ledger' | 'owner-history'`.
- Produces: `ZsxqOwnerAudit`, `ZsxqDayDraft`, `ZsxqOwnerCheckpoint`, and their Zod schemas.
- Extends: `CollectionBatch` with optional `zsxqMode` and `ownerAudit`.
- Extends: `planCollectPayloadSchema` and `extensionPlanResultPayloadSchema` with owner run/checkpoint data.

- [ ] **Step 1: Write failing shared-schema tests**

Add cases that parse a valid history batch/checkpoint and reject a completed audit without exhaustion:

```ts
const checkpoint = zsxqOwnerCheckpointSchema.parse({
  mode: 'owner-history',
  cursor: '2026-08-01T00:00:00.000Z',
  pagesFetched: 3,
  exhausted: false,
  newestObservedAt: '2026-08-28T01:00:00.000Z',
  oldestObservedAt: '2026-08-01T00:00:00.000Z',
});
expect(checkpoint.pagesFetched).toBe(3);
expect(() => zsxqOwnerAuditSchema.parse({
  mode: 'owner-history', pagesFetched: 3, observed: 60, qualifying: 4,
  exactDuplicates: 40, semanticDuplicates: 1, filtered: 15,
  knownComplete: 40, repaired: 0, saved: 3, failed: 0,
  exhausted: false, safetyCapReached: false,
  completedDays: 0, emptyDays: 0, failedDays: 0,
})).not.toThrow();
```

- [ ] **Step 2: Run the focused tests and confirm contract symbols are missing**

Run: `npm test -- tests/unit/plans.test.ts tests/integration/cli.test.ts`

Expected: FAIL because the owner-mode contracts and CLI flag do not exist.

- [ ] **Step 3: Add exact contracts and schema invariants**

Define these public shapes in `plans.ts`:

```ts
export type ZsxqCollectionMode = 'daily-ledger' | 'owner-history';
export interface ZsxqDayDraft {
  day: string;
  rawOwnerCount: number;
  qualifyingCount: number;
  filteredCount: number;
  exactDuplicateCount: number;
  semanticDuplicateCount: number;
  knownCompleteCount: number;
  repairCount: number;
  candidateCount: number;
  savedCount: number;
  failedCount: number;
  crossedDayBoundary: boolean;
}
export interface ZsxqOwnerCheckpoint {
  mode: ZsxqCollectionMode;
  cursor?: string;
  pagesFetched: number;
  newestObservedAt?: string;
  oldestObservedAt?: string;
  exhausted: boolean;
}
```

Define `ZsxqOwnerAudit` with every metric named in the spec. Extend protocol payloads with:

```ts
zsxqMode: z.enum(['daily-ledger', 'owner-history']).optional(),
targetDays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/u)).max(3660).optional(),
resumeCursor: z.iso.datetime().optional(),
checkpoint: zsxqOwnerCheckpointSchema.optional(),
dayDrafts: z.array(zsxqDayDraftSchema).max(3660).optional(),
ownerAudit: zsxqOwnerAuditSchema.optional(),
```

Use `superRefine` to reject owner-history terminal success claims in later consumers when `exhausted !== true` or `safetyCapReached === true`; do not require exhaustion for a partial checkpoint message.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- tests/unit/plans.test.ts tests/integration/cli.test.ts`

Expected: PASS.

- [ ] **Step 5: Record a clean working-tree checkpoint without committing**

```bash
git diff --check -- packages/shared/src/plans.ts packages/shared/src/protocol.ts tests/unit/plans.test.ts tests/integration/cli.test.ts
```

---

### Task 2: Atomic Shanghai-day ledger and resumable checkpoint store

**Files:**
- Create: `packages/bridge/src/plans/zsxqLedger.ts`
- Modify: `packages/bridge/src/config.ts`
- Test: `tests/unit/zsxqLedger.test.ts`

**Interfaces:**
- Consumes: `ZsxqDayDraft`, `ZsxqOwnerCheckpoint`, and `ZsxqOwnerAudit` from Task 1.
- Produces: `ZsxqDayLedgerStore.open(path, now?)`.
- Produces: `requestFor(mode, now)` returning `{ targetDays, resumeCursor? }`.
- Produces: `recordPage(batchId, attempt, checkpoint, dayDrafts, audit)` and `finalize(batchId, attempt, outcome)`.

- [ ] **Step 1: Write failing ledger tests**

Cover atomic reopen, explicit zero days, gap selection, current-day exclusion, resume, stale attempt rejection, and failed finalization:

```ts
const ledger = await ZsxqDayLedgerStore.open(path, () => '2026-08-29T00:00:00.000Z');
expect(ledger.requestFor('daily-ledger')).toEqual({ targetDays: ['2026-08-28'] });
await ledger.recordPage('batch-a', 'attempt-a', checkpoint, [{
  day: '2026-08-28', rawOwnerCount: 0, qualifyingCount: 0,
  filteredCount: 0, exactDuplicateCount: 0, semanticDuplicateCount: 0,
  knownCompleteCount: 0, repairCount: 0, candidateCount: 0,
  savedCount: 0, failedCount: 0, crossedDayBoundary: true,
}], audit);
await ledger.finalize('batch-a', 'attempt-a', { status: 'completed' });
expect(ledger.snapshot().days['2026-08-28']?.status).toBe('completed_empty');
```

Also assert that `2026-08-29` is absent, an un-crossed day cannot complete, and a stale attempt cannot overwrite a newer one.

- [ ] **Step 2: Run the ledger test and confirm the module is absent**

Run: `npm test -- tests/unit/zsxqLedger.test.ts`

Expected: FAIL because `zsxqLedger.ts` does not exist.

- [ ] **Step 3: Implement versioned atomic storage**

Use a versioned file:

```ts
interface StoredLedger {
  version: 1;
  planId: 'zsxq-chen-teacher';
  timeZone: 'Asia/Shanghai';
  days: Record<string, ZsxqDayLedgerEntry>;
  active?: {
    batchId: string;
    attempt: CollectionPlanAttempt;
    checkpoint: ZsxqOwnerCheckpoint;
    drafts: Record<string, ZsxqDayDraft>;
    audit: ZsxqOwnerAudit;
  };
}
```

Write with mode `0o600`, `fsync`, and atomic rename, following `packages/bridge/src/plans/store.ts`. Merge page drafts by summing disjoint page counts and OR-ing `crossedDayBoundary`; protect idempotence by storing the last processed cursor/page number and ignoring an exact replay. `finalize(...completed)` emits `completed_content` when `qualifyingCount > 0`, otherwise `completed_empty`; any failed job, missing boundary proof, non-exhausted history audit, or failed batch emits `failed`.

`requestFor('daily-ledger')` starts at yesterday in Shanghai and walks backward through missing/failed entries until the first completed entry. `requestFor('owner-history')` returns the active safe cursor when present. Never synthesize days older than the oldest observed owner post.

- [ ] **Step 4: Add the config path**

Extend `BridgeConfig` and `loadConfig()` with:

```ts
zsxqLedgerFile: join(configDir, 'zsxq-day-ledger.json'),
```

- [ ] **Step 5: Run focused tests**

Run: `npm test -- tests/unit/zsxqLedger.test.ts tests/unit/config.test.ts`

Expected: PASS.

- [ ] **Step 6: Record a clean working-tree checkpoint without committing**

```bash
git diff --check -- packages/bridge/src/plans/zsxqLedger.ts packages/bridge/src/config.ts tests/unit/zsxqLedger.test.ts tests/unit/config.test.ts
```

---

### Task 3: Compact local-library exact and semantic dedupe index

**Files:**
- Create: `packages/shared/src/zsxqDedupe.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `packages/bridge/src/library/zsxqIndex.ts`
- Modify: `packages/bridge/src/server/index.ts`
- Modify: `packages/extension/src/background/connection.ts`
- Modify: `packages/extension/src/background/index.ts`
- Modify: `packages/extension/src/background/jobs.ts`
- Test: `tests/unit/zsxqDedupe.test.ts`
- Test: `tests/unit/zsxqIndex.test.ts`
- Test: `tests/integration/bridge.test.ts`

**Interfaces:**
- Produces: `zsxqSemanticSignature(document)` and `isHighConfidenceZsxqDuplicate(left, right)`.
- Produces: `loadZsxqLibraryIndex(libraryRoot)` returning compact entries with URL, topic ID, completeness, publication timestamp, and semantic signature.
- Replaces: `knownContent()` with `knownZsxqIndex()` in the fixed-plan runner.

- [ ] **Step 1: Write failing signature tests**

Use the known cross-URL case shape: exact same owner publication timestamp, slightly different title/whitespace, and at least 90% overlapping normalized body must match; same body on a different timestamp or low-overlap text must not match.

```ts
expect(isHighConfidenceZsxqDuplicate(
  signature('2026-08-11T03:00:00.000Z', longBody),
  signature('2026-08-11T03:00:00.000Z', `${longBody} 补充一句`),
)).toBe(true);
expect(isHighConfidenceZsxqDuplicate(
  signature('2026-08-11T03:00:00.000Z', longBody),
  signature('2026-08-11T03:00:01.000Z', longBody),
)).toBe(false);
```

- [ ] **Step 2: Run signature tests and confirm failure**

Run: `npm test -- tests/unit/zsxqDedupe.test.ts`

Expected: FAIL because the dedupe module does not exist.

- [ ] **Step 3: Implement deterministic compact signatures**

Normalize to lowercase CJK/alphanumeric characters, build 5-character shingles, hash them with a deterministic 32-bit FNV-1a, and retain the 64 minimum unique hashes. For bodies shorter than 80 normalized characters, require exact normalized equality. A semantic duplicate requires exact `publishedAt`, owner role, length ratio `>= 0.85`, and estimated signature Jaccard `>= 0.82`.

Do not include complete body text in the returned index or logs.

- [ ] **Step 4: Write failing library-index and endpoint tests**

Create one complete current-proof entry, one `contentComplete=false` entry, and one legacy unknown entry. Assert `/v1/library/zsxq-index` returns three compact records, no `text`/`html`, and correct three-state completeness.

- [ ] **Step 5: Implement the Bridge index and extension client**

`loadZsxqLibraryIndex()` reads `_catalog/index.json` and each ZSXQ `source.json`, verifies canonical URL and stable ID, computes signatures, and fails the entire index request if a catalog entry cannot be safely read. Add authenticated `GET /v1/library/zsxq-index`.

Add `BridgeConnection.zsxqIndex()` and expose it to `JobRunnerOptions.knownZsxqIndex`. Build URL/topic maps once per run. Do not change the unrelated writer/sync delivery-revision implementation.

- [ ] **Step 6: Run focused tests**

Run: `npm test -- tests/unit/zsxqDedupe.test.ts tests/unit/zsxqIndex.test.ts tests/integration/bridge.test.ts`

Expected: PASS.

- [ ] **Step 7: Record a clean working-tree checkpoint without committing**

```bash
git diff --check -- packages/shared/src/zsxqDedupe.ts packages/shared/src/index.ts packages/bridge/src/library/zsxqIndex.ts packages/bridge/src/server/index.ts packages/extension/src/background/connection.ts packages/extension/src/background/index.ts packages/extension/src/background/jobs.ts tests/unit/zsxqDedupe.test.ts tests/unit/zsxqIndex.test.ts tests/integration/bridge.test.ts
```

---

### Task 4: One-page signed owner API with cursor and boundary proof

**Files:**
- Modify: `packages/extension/src/zsxqApiFallback.ts`
- Modify: `packages/extension/src/content.ts`
- Modify: `packages/extension/src/contentProtocol.ts`
- Test: `tests/unit/zsxq-api-fallback.test.ts`
- Test: `tests/unit/content.test.ts`

**Interfaces:**
- Produces: `collectZsxqApiOwnerPage(groupId, dependencies, request): Promise<ZsxqOwnerPage>`.
- `ZsxqOwnerPage` returns verified owner documents, dated business skips, raw count, `nextCursor`, `exhausted`, newest/oldest timestamps, and a reusable verified owner/scope context.

- [ ] **Step 1: Add failing pagination tests**

Test a 20-topic first page followed by a short page, cursor `oldest - 1ms`, exact descending order, duplicate cursor rejection, non-owner result rejection, invalid `by_owner` menu rejection, and empty-page exhaustion.

```ts
const first = await collectZsxqApiOwnerPage(GROUP_ID, deps, {});
expect(first).toMatchObject({ rawCount: 20, exhausted: false });
expect(first.nextCursor).toBe('2026-08-20T03:59:59.999Z');
const last = await collectZsxqApiOwnerPage(GROUP_ID, deps, {
  cursor: first.nextCursor,
  context: first.context,
});
expect(last.exhausted).toBe(true);
```

- [ ] **Step 2: Run focused tests and confirm the page API is absent**

Run: `npm test -- tests/unit/zsxq-api-fallback.test.ts tests/unit/content.test.ts`

Expected: FAIL because the one-page API/request type does not exist.

- [ ] **Step 3: Refactor shared parsing without changing the existing fallback**

Extract group/menu bootstrap and topic conversion helpers from `collectZsxqApiViews`. Keep all existing three-view tests green. The owner-page function fetches only `scope=by_owner&count=20`, verifies all returned documents have `authorRole='owner'`, attributes every deterministic skip to its Shanghai publication day, and sets `exhausted` only for `<20` raw topics.

The safety cap is enforced by the background page loop, not by this single-page function. A repeated topic ID, non-descending timestamp, cursor violation, or malformed entry throws a coverage error.

- [ ] **Step 4: Route the exact content request**

Add `list.apiCollectOwnerPage` to the content protocol. Its request carries only cursor plus the compact verified context; its response is one `ZsxqOwnerPage`. Keep `list.apiCollect` unchanged for the existing three-view fallback.

- [ ] **Step 5: Run focused tests**

Run: `npm test -- tests/unit/zsxq-api-fallback.test.ts tests/unit/content.test.ts`

Expected: PASS, including all pre-existing fallback cases.

- [ ] **Step 6: Record a clean working-tree checkpoint without committing**

```bash
git diff --check -- packages/extension/src/zsxqApiFallback.ts packages/extension/src/content.ts packages/extension/src/contentProtocol.ts tests/unit/zsxq-api-fallback.test.ts tests/unit/content.test.ts
```

---

### Task 5: Page-wise extension pipeline with early dedupe and durable progress reports

**Files:**
- Modify: `packages/extension/src/background/jobs.ts`
- Modify: `packages/extension/src/background/index.ts`
- Modify: `packages/extension/src/background/connection.ts`
- Test: `tests/unit/background.test.ts`
- Test: `tests/unit/connection.test.ts`

**Interfaces:**
- Consumes: Task 1 run/checkpoint contracts, Task 3 compact index, Task 4 owner-page API.
- Produces: `runZsxqOwnerPages(...)` used by both daily and history modes.
- Reports: a `plan.result` checkpoint only after every candidate job on that page has a matching persisted terminal receipt.

- [ ] **Step 1: Write failing pipeline-order tests**

Create spies for `knownZsxqIndex`, `withLinkedArticle`, `createJob`, `waitForJobTerminal`, and phase reporting. Assert this sequence:

1. complete exact URL skips without `withLinkedArticle`;
2. high-confidence semantic duplicate skips without `withLinkedArticle`;
3. deterministic topic/ad skip never reaches background completion;
4. known incomplete URL is completed and saved;
5. new relevant content is completed and saved;
6. irrelevant content is rejected after completion;
7. checkpoint page 1 is reported only after page-1 terminal receipts;
8. page 2 is not requested if a page-1 receipt fails.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npm test -- tests/unit/background.test.ts tests/unit/connection.test.ts`

Expected: FAIL because the page loop and richer index are not wired.

- [ ] **Step 3: Implement page processing and per-day counters**

Add a focused helper in `jobs.ts` that:

```ts
while (pagesFetched < OWNER_HISTORY_MAX_PAGES) {
  const page = await askOwnerPage(cursor, context);
  const pageResult = await processOwnerPage(page, knownIndex);
  await Promise.all(pageResult.jobs.map(job => bridge.waitForJobTerminal(job.id, attempt)));
  await reportPhase({ checkpoint, dayDrafts: pageResult.days, ownerAudit, prepared: false });
  if (page.exhausted || crossedOldestTarget(page, targetDays)) break;
  cursor = page.nextCursor;
}
```

Use a high explicit safety cap of 10,000 pages. Hitting it reports `safetyCapReached=true` and throws. Update the in-memory exact and semantic indexes after a successful page so later pages cannot duplicate newly saved content.

For exact complete duplicates, increment both `qualifyingCount` and `knownCompleteCount`; they make a day `completed_content`, not empty. For semantic duplicates increment `qualifyingCount` and `semanticDuplicateCount`. For rejected topics increment `filteredCount`. Only successfully completed relevant items increment `candidateCount`; successful job receipts increment `savedCount`.

- [ ] **Step 4: Preserve normal-plan behavior around the owner path**

Daily mode continues collecting `最新` and `精华` through the existing bounded path, but excludes the old bounded `只看星主` result from owner coverage and appends the page-wise owner results. Remove the global 15-day owner rejection and 60-item owner truncation. Keep current-day owner results provisional; `targetDays` controls only which closed days require boundary proof.

History mode calls only the signed owner-page loop and never selects DOM tabs or the other two views.

- [ ] **Step 5: Run focused tests**

Run: `npm test -- tests/unit/background.test.ts tests/unit/connection.test.ts tests/unit/zsxq-api-fallback.test.ts`

Expected: PASS.

- [ ] **Step 6: Record a clean working-tree checkpoint without committing**

```bash
git diff --check -- packages/extension/src/background/jobs.ts packages/extension/src/background/index.ts packages/extension/src/background/connection.ts tests/unit/background.test.ts tests/unit/connection.test.ts
```

---

### Task 6: Bridge mode dispatch, checkpoint persistence, and day finalization

**Files:**
- Modify: `packages/bridge/src/plans/store.ts`
- Modify: `packages/bridge/src/plans/service.ts`
- Modify: `packages/bridge/src/server/index.ts`
- Modify: `packages/bridge/src/cli.ts`
- Test: `tests/unit/collectionPlanStore.test.ts`
- Test: `tests/unit/collectionPlanService.test.ts`
- Test: `tests/integration/bridge.test.ts`
- Test: `tests/integration/cli.test.ts`

**Interfaces:**
- Consumes: `ZsxqDayLedgerStore` and owner protocol results.
- Extends: `CollectionPlanService.run(planId, { force?, trigger?, zsxqMode? })`.
- Adds: CLI `plans run zsxq-chen-teacher --owner-history --force --wait 1800000`.

- [ ] **Step 1: Write failing CLI/service/ledger integration tests**

Assert:

- `--owner-history` is accepted only for `zsxq-chen-teacher` and serializes `zsxqMode`;
- scheduled runs always use `daily-ledger`;
- manual history does not consume the scheduled daily slot;
- the service passes ledger `targetDays` and safe `resumeCursor` to `plan.collect`;
- each checkpoint is atomically recorded for only the current attempt;
- terminal completed batch finalizes crossed closed days;
- failed/attention batch marks drafts failed and retains a resumable cursor;
- history completion without `exhausted=true` becomes attention, never completed.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npm test -- tests/unit/collectionPlanStore.test.ts tests/unit/collectionPlanService.test.ts tests/integration/bridge.test.ts tests/integration/cli.test.ts`

Expected: FAIL because the mode and ledger dependency are absent.

- [ ] **Step 3: Store batch mode and typed audit**

Extend `CollectionPlanStore.start()` and preparation reset to retain `zsxqMode`; persist `ownerAudit` from current-attempt results. Do not store full day drafts or article bodies in `collection-plans.json`; those belong to `ZsxqDayLedgerStore`.

- [ ] **Step 4: Wire ledger lifecycle into the service**

Add `zsxqLedger` to service dependencies. Before dispatch, compute request data from the ledger. On every current-attempt extension result, persist checkpoint/drafts before updating batch preparation state. After `reconcileZsxqBatch()` reaches terminal, finalize ledger exactly once. If ledger persistence/finalization fails, surface `completed_with_attention` or failed state rather than leaving a green batch.

- [ ] **Step 5: Wire config, server, protocol, and CLI**

Open `ZsxqDayLedgerStore` next to `CollectionPlanStore`. Extend `/v1/plans/run` body with optional `zsxqMode`, rejecting it for other plans. Send mode, target days, and cursor in `plan.collect`. Add `--owner-history` to CLI usage and JSON body.

- [ ] **Step 6: Run focused tests**

Run: `npm test -- tests/unit/collectionPlanStore.test.ts tests/unit/collectionPlanService.test.ts tests/integration/bridge.test.ts tests/integration/cli.test.ts`

Expected: PASS.

- [ ] **Step 7: Record a clean working-tree checkpoint without committing**

```bash
git diff --check -- packages/bridge/src/plans/store.ts packages/bridge/src/plans/service.ts packages/bridge/src/server/index.ts packages/bridge/src/cli.ts tests/unit/collectionPlanStore.test.ts tests/unit/collectionPlanService.test.ts tests/integration/bridge.test.ts tests/integration/cli.test.ts
```

---

### Task 7: Documentation, skill contract, version, and regression suite

**Files:**
- Modify: `.codex/skills/data-collector-delivery/references/zsxq-delivery.md`
- Modify: `docs/superpowers/specs/2026-08-23-scheduled-source-plans-design.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/shared/package.json`
- Modify: `packages/bridge/package.json`
- Modify: `packages/extension/package.json`
- Modify: `packages/extension/manifest.json`
- Modify: `packages/shared/src/identity.ts`
- Test: `tests/unit/deliverySkill.test.ts`
- Test: `tests/unit/identity.test.ts`

**Interfaces:**
- Documents: daily-ledger default and `--owner-history` operational command.
- Updates: installed canonical delivery contract so it no longer claims a 15-day owner window.

- [ ] **Step 1: Invoke the required writing-skills workflow before editing the repository skill**

Read and follow `superpowers:writing-skills`; treat the current ZSXQ reference assertion about “last 15 days” as the failing behavior to replace.

- [ ] **Step 2: Write failing documentation/identity tests**

Assert the delivery reference contains `--owner-history`, `zsxq-day-ledger.json`, and no claim that owner collection is limited to the last 15 days. Assert all package/manifest/shared versions agree.

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `npm test -- tests/unit/deliverySkill.test.ts tests/unit/identity.test.ts`

Expected: FAIL on the old delivery reference/version.

- [ ] **Step 4: Update the operational contract and patch version**

Document the normal command and history command, terminal success requirements, ledger location, and exact-batch manifest rule. Add an explicit amendment to the older scheduled-plan design pointing to the 2026-08-28 owner-ledger spec.

Before touching version files, confirm the unrelated delivery-idempotency work is terminal and its commit is now part of `HEAD`; do not overwrite or absorb an uncommitted version. If it lands as `0.4.31`, bump this feature to `0.4.32` in every version surface.

- [ ] **Step 5: Run the full automated verification**

```bash
npm run typecheck
npm test
npm run package
npm run test:e2e
```

Expected: typecheck PASS; all unit/integration tests PASS; extension ZIP produced; E2E PASS.

- [ ] **Step 6: Commit only this task and push master**

```bash
git add .codex/skills/data-collector-delivery/references/zsxq-delivery.md docs/superpowers/specs/2026-08-23-scheduled-source-plans-design.md package.json package-lock.json packages/shared/package.json packages/bridge/package.json packages/extension/package.json packages/extension/manifest.json packages/shared/src/identity.ts packages/shared/src/plans.ts packages/shared/src/protocol.ts packages/shared/src/zsxqDedupe.ts packages/shared/src/index.ts packages/bridge/src/config.ts packages/bridge/src/plans/zsxqLedger.ts packages/bridge/src/plans/store.ts packages/bridge/src/plans/service.ts packages/bridge/src/library/zsxqIndex.ts packages/bridge/src/server/index.ts packages/bridge/src/cli.ts packages/extension/src/zsxqApiFallback.ts packages/extension/src/content.ts packages/extension/src/contentProtocol.ts packages/extension/src/background/jobs.ts packages/extension/src/background/index.ts packages/extension/src/background/connection.ts tests/unit/plans.test.ts tests/unit/zsxqLedger.test.ts tests/unit/config.test.ts tests/unit/zsxqDedupe.test.ts tests/unit/zsxqIndex.test.ts tests/unit/zsxq-api-fallback.test.ts tests/unit/content.test.ts tests/unit/background.test.ts tests/unit/connection.test.ts tests/unit/collectionPlanStore.test.ts tests/unit/collectionPlanService.test.ts tests/unit/deliverySkill.test.ts tests/unit/identity.test.ts tests/integration/bridge.test.ts tests/integration/cli.test.ts
git diff --cached --check
git commit -m "feat: ship zsxq owner history audit"
git push origin master
```

---

### Task 8: Install the exact build, run the live history audit, and accept the feature

**Files:**
- Runtime output: `~/.data-collector/zsxq-day-ledger.json`
- Runtime output: `~/.data-collector/collection-plans.json`
- Runtime output: local library `_catalog/index.json`
- Runtime output: `life-teachers/_inbox/zsxq`

**Interfaces:**
- Consumes: the packaged extension and waitable CLI from Tasks 1–7.
- Produces: a terminal history batch, continuous day ledger, exact manifest, and final reconciliation evidence.

- [ ] **Step 1: Preflight both repositories and the running Bridge/extension build**

Verify `data-collector` and `life-teachers` are on `master`, fetch without overwriting local work, and confirm the running extension build ID equals the package artifact build ID. Do not reload a user-owned ZSXQ page; use the plan-owned background tab.

- [ ] **Step 2: Run the owner-history audit with the exact command**

```bash
node packages/bridge/dist/cli.js plans run zsxq-chen-teacher \
  --owner-history --force --wait 1800000
```

Capture the single JSON stdout object. Continue only when `status === 'completed'`, `ownerAudit.exhausted === true`, `ownerAudit.safetyCapReached === false`, and `failed === 0`.

- [ ] **Step 3: Generate and validate the exact delivery manifest**

```bash
node .codex/skills/data-collector-delivery/scripts/inbox-manifest.mjs \
  --repo /Users/chenhao/Code/life-teachers --batch "$BATCH_ID" --source zsxq
```

Stop on malformed or blocked entries. If matched is nonempty, read and follow `life-teachers/.codex/skills/curate-life-teachers-inbox/SKILL.md` for only those IDs, remove only successfully consumed inbox directories, validate, commit, push, and verify the remote commit.

- [ ] **Step 4: Reconcile every qualifying owner topic**

Run a read-only audit command/script that compares the live audit's qualifying topic IDs against the local ZSXQ index. Accept an item only when it has either an exact canonical mapping or a recorded high-confidence semantic duplicate mapping. Require:

```text
unmappedQualifying = 0
incompleteQualifying = 0
duplicateDeliveryIds = 0
failedDays = 0
ledgerGaps(oldestObservedDay..yesterday) = 0
```

- [ ] **Step 5: Run the daily mode a second time**

```bash
node packages/bridge/dist/cli.js plans run zsxq-chen-teacher --force --wait 1800000
```

Verify it does not rescan the historical range, processes only current provisional content plus yesterday/ledger gaps, leaves current day unfinalized, and produces no duplicate delivery IDs.

- [ ] **Step 6: Fix and repeat on any acceptance failure**

For any failed invariant, capture the batch ID, exact ledger/audit mismatch, and failing test fixture; use `superpowers:systematic-debugging`, add the regression test first, implement the smallest root-cause fix, rerun all Task 7 checks, reinstall the exact build, and repeat Tasks 8.2–8.5.

- [ ] **Step 7: Record final evidence and complete the goal**

Report discovered, qualifying, exact duplicates, semantic duplicates, filtered, repaired, saved, delivered, consumed, blocked, failed, completed days, empty days, oldest/newest observed timestamps, batch ID, data-collector commit, life-teachers commit/workflow (if any), and the second-run no-duplicate result.
