# Minimal live publisher/finalizer report

## Scope and outcome

Implemented only step 2 of the streamlined live brief:

- `NowcoderDirectedStore` exposes an attempt-fenced private publisher snapshot and an
  attempt-fenced `completePublishedCurrent` transition.
- Completion exposes exactly the frozen target-sized public delivery set and receipt. Public
  lineage IDs and the receipt `markerHash` are deterministic SHA-256 values; private job IDs and
  local paths stay outside the public run.
- `NowcoderDirectedPublisher` validates the complete Task 6 tab-clear proof before crossing the
  persisted `publishing` cutoff, then calls the existing `syncEntries` once with the frozen stable
  IDs, `deliveryBatchId: runId` and `atomic: true`.
- A failed or incomplete exact sync leaves the run in `publishing`. Recovery repeats the same
  stable-ID sync and the existing repo-inbox sink reuses those IDs without duplicate entries.
- The Bridge server wires publisher recovery into `NowcoderDirectedService`. Durable completion is
  followed by clearing the exact JobStore pins and releasing the run's artifact reader.

No HTTP/CLI route, Side Panel UI, Task 7 telemetry, Task 8 physical marker or additional
filesystem failure model was added.

## TDD evidence

The following focused REDs were observed before production implementation:

- `completePublishedCurrent`: one store test failed with
  `TypeError: fixture.store.completePublishedCurrent is not a function`.
- exact private publisher snapshot: one store test failed with
  `TypeError: fixture.store.publisherSnapshotCurrent is not a function`.
- publisher/finalizer: the new four-case suite failed to load with
  `Cannot find module .../nowcoderDirected/publisher.js` and `0 test`, proving the production
  publisher did not yet exist.
- persisted-cutoff restart: the service regression failed with `expected [] to deeply equal
  [ 'publisher' ]` while the extension was offline. The minimal fix keeps the live build gate for
  `running/staging` only; a durable `publishing` run now immediately replays its local exact sync.

After the minimal implementation, the focused store/publisher run passed:

```text
Test Files  2 passed (2)
Tests       74 passed (74)
Duration    9.21s
```

The four publisher cases cover normal exact-target delivery, sync failure remaining in
`publishing` and succeeding on retry, restart after the publishing cutoff without duplicate inbox
entries, and final reader/pin release. The store case covers deterministic exact public delivery,
receipt privacy, completion idempotency and stale-attempt rejection.

## Regression verification

Task 4-6 plus publisher regression matrix:

```text
Test Files  12 passed (12)
Tests       415 passed (415)
Duration    45.59s
```

TypeScript verification:

```text
npm run typecheck
tsc -b packages/shared packages/bridge --pretty false
tsc -p packages/extension/tsconfig.json --pretty false
exit 0
```

Final whitespace checks:

```text
git diff --check
git diff --cached --check
exit 0
```

## Files in this step

Created:

- `packages/bridge/src/nowcoderDirected/publisher.ts`
- `tests/unit/nowcoderDirectedPublisher.test.ts`
- `.superpowers/sdd/2026-08-30-nowcoder-directed-search/task-minimal-publisher-report.md`

Modified:

- `packages/bridge/src/nowcoderDirected/store.ts`
- `packages/bridge/src/nowcoderDirected/service.ts`
- `packages/bridge/src/server/index.ts`
- `tests/unit/nowcoderDirectedStore.test.ts`

The same cumulative snapshot also contains the two canonical Data Collector Skill documentation
updates staged concurrently by the root agent. This step preserved those files without rewriting
them.
