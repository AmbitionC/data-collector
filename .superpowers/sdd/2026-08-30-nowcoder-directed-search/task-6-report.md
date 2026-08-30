# Task 6 report — bounded persisted cancellation through owned browser work

## Implementation summary

- Added the atomic cancellation/publishing cutoff and the dedicated cancelled transition. A run
  persists `cancelling` before any cancel frame or local child failure; generic checkpoints,
  history, attention/runtime writes and generic terminalization cannot overwrite that intent.
  Only the dedicated completion path may create `cancelled`, and it clears selection/publication
  state while preserving the scheduled prefix, peak tabs and immutable work counters.
- Added private exact-attempt dispatch and tab-clear evidence. `dispatchedJobIds` commits before the
  collect frame; each current child obtains exactly one `never_dispatched`,
  `remote_terminal_after_close` or `cancelled_after_close` proof. Cancellation completion requires
  all exact JobRecords terminal plus all exact proofs and refuses nonzero owned-tab counters.
- Added the Bridge cancellation service with a per-run first-writer queue, run-scoped abort signal
  and cancellable-operation barrier. Restart and extension-evidence recovery route by cancelling
  status before phase, reacquire/retain the run reader, bypass live build gates, resend only exact
  dispatched tuples lacking proof, and release the run handle only after durable convergence.
- Enforced proof-before-JobStore-before-ack ordering for every directed terminal. Late result,
  ordinary error, `AUTH_REQUIRED` and `CANCELLED` while cancelling are evidence-only and never enter
  a sink, auth handoff, selection, refill or publisher. Proof-before-JobStore crash recovery repairs
  the single local `failed/CANCELLED` transition without redispatch. Proven durable terminals are
  re-acknowledged after reconnect.
- Added strict `job.cancel` routing with envelope request ID as job ID and required paired run ID /
  attempt. The maximum-length lineage regression proves both collect and cancel use the same fixed
  `nowcoder-job-<64hex>` identity under the 100-character protocol bound.
- Made the extension scheduler signal-aware and added a bounded tuple lifecycle retained through
  durable acknowledgement. Cancel-before-collect, queued/active abort, duplicate collect/cancel,
  reconnect replay and wrong-tuple isolation share one cached terminal. Directed work is always
  noninteractive and cannot create an auth handoff.
- Threaded abort through tab waits, extraction/retries, ask/timeouts, topic API recovery and linked
  articles. Request-owned tabs are registered before the next abort boundary and are forgotten only
  after physical removal succeeds or the browser authoritatively reports them absent. Removal
  failure retains the owned/lifecycle records and leaves the run cancelling for retry.
- Closed the normal/restart recovery gaps found by the final integration pass. A collecting child
  with durable `remote_terminal_after_close` proof is never redispatched: Bridge asks the exact
  extension tuple to replay its cached terminal, completes JobStore/sink persistence, then
  acknowledges it. The extension retains a terminal across transient physical-close failure and a
  duplicate collect retries that close without opening another tab.
- Kept cancel-before-collect tombstones through an acknowledgement that can race a delayed collect;
  the tombstone becomes releasable only after that exact collect is observed and replayed. Startup,
  install, alarm and manual reconnect paths now share the same stale-owned-tab cleanup gate, so a
  transient cleanup failure is retried before any socket can accept more browser work.
- Covered all six service races: before first dispatch, between dispatches, two dispatched tabs,
  immediately before refill, after exact selection/before staging, and cancellation versus the
  atomic publishing cutoff. The matrix also covers repeated/wrong attempt, offline cancellation,
  proof-before-JobStore restart and lost terminal acknowledgement replay.

## Witnessed TDD evidence

Every command used Node 22 through:

```sh
env PATH=/Users/chenhao/.nvm/versions/node/v22.22.3/bin:/usr/bin:/bin
```

The deterministic production-gap REDs were observed before their corresponding implementation:

- abortable scheduler: `2 failed | 4 passed`;
- strict connection collect/cancel/ack routing: `3 failed | 43 passed`;
- tuple lifecycle and physical cancel behavior: `6 failed | 135 passed`;
- physical owned-tab removal retention: `2 failed | 4 passed`;
- persisted store cutoff/evidence operations: `3 failed | 65 passed`;
- initial service cancellation protocol: `4 failed | 0 passed`;
- cancel-between-dispatches barrier deadlock: isolated `1 failed` because no cancel frame could be
  emitted while the cancellation writer held the queue;
- normal terminal reconnect acknowledgement: isolated `1 failed` because no durable ack replayed;
- post-intent generic terminal overwrite: isolated `1 failed` because `cancelling` became `failed`.
- proven pre-JobStore terminal restart: isolated `1 failed` by WebSocket timeout because recovery
  attempted ordinary redispatch after exact close proof;
- normal terminal physical-close retry: isolated `1 failed` because `remove` remained at one call;
- acknowledged cancel-before-collect tombstone: isolated `1 failed` because the delayed collect
  opened one new tab;
- stale cleanup reconnect gate: isolated `1 failed` because the alarm left `remove` at one call and
  bypassed the failed cleanup (the RED also exposed the unhandled fire-and-forget rejection);
- cleanup-flight settlement during delayed Side Panel setup: isolated `1 failed` because the shared
  promise slot cleared before the caller awaited it and one socket opened after failed cleanup.

Each RED was closed by the smallest corresponding production change. The cancellation queue now
releases immediately after durable intent before waiting on the run barrier; reconnect recovery
re-acknowledges only exact proven terminal tuples; generic terminalization requires `running`.

## Final verification

Focused Task 6 plus Task 4/5 regression matrix:

```text
Test Files  11 passed (11)
Tests       409 passed (409)
Duration    39.39s
```

The matrix contains scheduler, extension runner, connection, owned tabs, cancel service, shared
contract, store, recovery, capability/reader lifecycle, real Bridge ownership/WebSocket behavior,
and Task 5 selection/fill suites.

```text
npm run typecheck
tsc -b packages/shared packages/bridge --pretty false
tsc -p packages/extension/tsconfig.json --pretty false
exit 0

git diff --check
git diff --cached --check
exit 0
```

Task 7 remains the owner of authoritative telemetry counters. Task 6 exposes the typed
`ownedTabsClear` seam and uses only its bounded exact per-job proof predicate; it does not fabricate
telemetry zero or implement Task 7 fields.

## Task 6 files

Created:

- `tests/unit/nowcoderDirectedCancel.test.ts`
- `.superpowers/sdd/2026-08-30-nowcoder-directed-search/task-6-report.md`

Modified:

- `packages/bridge/src/nowcoderDirected/service.ts`
- `packages/bridge/src/nowcoderDirected/store.ts`
- `packages/bridge/src/server/index.ts`
- `packages/extension/src/background/connection.ts`
- `packages/extension/src/background/index.ts`
- `packages/extension/src/background/jobs.ts`
- `packages/extension/src/background/ownedTabs.ts`
- `packages/extension/src/background/remoteJobScheduler.ts`
- `packages/shared/src/nowcoderDirected.ts`
- `packages/shared/src/protocol.ts`
- `tests/unit/background.test.ts`
- `tests/unit/connection.test.ts`
- `tests/unit/nowcoderDirected.test.ts`
- `tests/unit/nowcoderDirectedOwnership.test.ts`
- `tests/unit/nowcoderDirectedRecovery.test.ts`
- `tests/unit/nowcoderDirectedStore.test.ts`
- `tests/unit/ownedTabs.test.ts`
- `tests/unit/remoteJobScheduler.test.ts`
