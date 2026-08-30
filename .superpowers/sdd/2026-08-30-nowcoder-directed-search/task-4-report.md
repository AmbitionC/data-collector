# Task 4 report — frozen build evidence and coordinated artifact readers

## Implementation summary

- Replaced free-form directed build evidence with a strict shared `NowcoderDirectedBuildEvidence`: application/extension versions, Bridge startup artifact build ID, current disk artifact build ID, online extension build ID, normalized capabilities, and freeze time. Public runs carry authenticated evidence and a structured safe attention reason; private runs additionally retain ordered unique runtime UUIDs. Runtime IDs never enter public projections or `/health`.
- Made new start/retry creation service-owned and atomic. Exact idempotent replay is returned before the online gate; a genuinely new attempt synchronously reserves start intent, acquires a logical run reader, validates live evidence, then persists the run/evidence/runtime/idempotency map in one serialized store mutation. The store's `{ run, created }` result is authoritative for concurrent same-key callers, and provisional replay readers release without replacing the owned handle.
- Added a Bridge-local reference-counted artifact-reader coordinator. The first logical reader takes the existing cross-process physical lease; run-lifetime, directed-result, and ZSXQ-persistence readers share it. Pending readers and start/update/restart intent are visible synchronously, handles are idempotent, the final release provides exactly one deferred-update opportunity, and update-to-restart handoff has no unowned gap.
- Routed every directed live boundary through one service guard: hello/restart recovery, dispatch transition, final `job.collect` send, progress/result/error acceptance, result save/index, refill/cursor, selection/staging, and publisher recovery. Offline mid-run pauses without releasing or caching skipped callbacks. Runtime replacement with unchanged evidence is appended once; validated build/version/capability/artifact drift durably attentions before external work and releases the run handle.
- Kept publisher recovery marker-first: a verified exact marker gets the future Task 8 convergence seam before any live gate; absent/unverified markers still require the common boundary guard.
- Reordered full `extension.hello` handling without removing existing behavior: record authenticated evidence while not ready, validate/append/attention, recover jobs, mark ready and flush terminal notices, drain accepted persistence, honor restart handoff, reconnect fixed plans, then reconcile directed work and finally dispatch queued work.
- Added short `nowcoder-directed-persistence` and `zsxq-persistence` logical readers in `job.result`. Each reader is acquired before sink/index, survives terminal notice plus selection/finalization, and releases in the outer `finally` only after `persistingJobIds` is removed. Terminal notification never waits on the global persistence drain.
- Startup reacquires an active run reader before the first update check or reconciliation. Graceful close drains accepted work, closes the directed service/run handles, releases restart intent, then closes the coordinator. `/health` exposes only `directedRunActive`; the extension persists that boolean and treats it as auto-reload busy.
- Removed the unfenced generic store terminal helper. Production directed attention is uniquely reached through `NowcoderDirectedService.attention()` and normal `cancelled`/`completed`/`failed` finalization through `NowcoderDirectedService.finalizeRun()`. The store mutations remain attempt-fenced implementation details used by that service.
- Fix round 1 now serializes idempotency replay reads behind the store mutation queue, so only atomically committed start/retry mappings are visible. A failed write rolls the mutable envelope back before the waiting caller can decide whether to replay or enter a fresh live gate.
- Publisher recovery is marker-first at startup, replacement hello, and ordinary reconciliation. The marker probe receives only the durable run snapshot; a verified-marker publisher context is explicitly typed and carries no `JobStore` jobs, while absent/non-valid marker recovery alone may acquire a reader, build strict job context, and apply the live/build gate.
- Physical acquisition, held lease, and asynchronous physical release are all coordinator-busy state. One edge-triggered idle notifier covers start/update intent release, acquisition failure, and final physical release; the server uses that edge to retry both deferred update and restart.
- The final directed evidence sample is socket-fenced across its awaited artifact read. Dispatch then rechecks socket identity/readiness, durable job status, current run ownership, and attempt fence immediately before `job.collect`, requeueing a current dispatched job if the socket changed.
- Once atomic attempt persistence and reader transfer succeed, immediate reconciliation failure is quarantined with the fixed redacted `DIRECTED_RECOVERY_FAILED` health payload. Creation/retry still returns `{ created: true }`, retains its reader, and remains exactly replayable.
- Fix round 2 routes every staging/publishing entry through one run-attempt keyed flight covering the entire marker decision, verified or ordinary publisher recovery, and completion bookkeeping. Joined hello/startup/reconciliation callers share success or rejection; the exact flight deletes itself by identity so a later retry or phase can run.
- A rejected physical lease release now permanently quarantines the coordinator. The exact lease remains retained, `physicalBusy` and `physicalFaulted` stay true, new start/update/readers are refused, no idle edge wakes updater/restart, and close reports the same stable quarantine instead of pretending ownership was released.
- Fix round 3 caches one release promise per logical handle, so its first, concurrent, and later callers observe the exact same fulfillment or stable quarantine rejection while the reader count decrements once.
- Reader reacquisition is now fenced against service close and fresh durable run-attempt identity before acquisition, after acquisition, and immediately before installation. A terminalized/replaced run or closing service releases the returned handle without attention, publisher work, or map repopulation.
- Service close atomically fences new work, drains tracked reconciliation/evidence/publisher/reader operations to quiescence, then all-settled releases every run reader. Ordinary and verified publisher callbacks already in progress retain their reader until settlement; post-close direct calls receive one stable service-closed error.
- Restart wakeups now reapply the common physical-reader deferral gate even when a changed updater outcome has already established restart intent. Physical quarantine therefore blocks idle, socket-close, and shutdown wake paths from reaching `exit`.
- Fix round 4 identity-tracks every logical reader release promise independently from the run-reader registry and retains any rejected outcome for the shared service close result. Finalize, attention, stale/duplicate acquisition cleanup, provisional creation cleanup, and close-owned handles all use the same release tracker; removing a map entry or swallowing an operation rejection cannot fabricate close success.
- Server close now attempts endpoint/operation drain, directed-service close, restart-intent release, and coordinator close in order even when an earlier cleanup rejects. `closing` remains fenced throughout, every authority gets one attempt, and all raw cleanup failures normalize to one shared `本机服务未能安全关闭` result after cleanup.

## Files

Created:

- `packages/bridge/src/artifactReaderCoordinator.ts`
- `tests/unit/artifactReaderCoordinator.test.ts`
- `tests/unit/nowcoderDirectedCapability.test.ts`
- `.superpowers/sdd/2026-08-30-nowcoder-directed-search/task-4-report.md`

Modified:

- `packages/shared/src/nowcoderDirected.ts`
- `packages/bridge/src/nowcoderDirected/store.ts`
- `packages/bridge/src/nowcoderDirected/service.ts`
- `packages/bridge/src/server/index.ts`
- `packages/bridge/src/autoUpdate.ts`
- `packages/extension/src/background/connection.ts`
- `packages/extension/src/background/index.ts`
- `packages/extension/src/background/autoReload.ts`
- `tests/unit/nowcoderDirected.test.ts`
- `tests/unit/nowcoderDirectedStore.test.ts`
- `tests/unit/nowcoderDirectedRecovery.test.ts`
- `tests/unit/nowcoderDirectedOwnership.test.ts`
- `tests/unit/connection.test.ts`
- `tests/unit/auto-update.test.ts`
- `tests/unit/auto-reload.test.ts`

## Witnessed TDD evidence

All npm commands used Node 22 through:

```sh
PATH=/Users/chenhao/.nvm/versions/node/v22.22.3/bin:/usr/bin:/bin
```

### Initial RED — strict evidence, coordinator, server/extension busy gates

Command before implementation:

```sh
npm test -- tests/unit/artifactReaderCoordinator.test.ts tests/unit/nowcoderDirectedCapability.test.ts tests/unit/nowcoderDirected.test.ts tests/unit/connection.test.ts tests/unit/auto-update.test.ts tests/unit/auto-reload.test.ts tests/unit/nowcoderDirectedStore.test.ts
```

Observed result:

```text
Test Files  7 failed (7)
Tests  11 failed | 88 passed (99)
```

The failures witnessed the missing coordinator/module, absent strict build/attention/private-runtime contracts, missing atomic store creation API, absent hello capability, missing health busy persistence, missing update deferral predicate, and missing directed auto-reload busy gate.

### Focused debugging regression

The stricter hello order initially exposed a deterministic test deadlock: the replacement-hello assertion waited for directed reconciliation before releasing the blocked sink, while the approved order deliberately reconciles only after persistence drains. The fixture now witnesses authenticated evidence first, proves the hello is parked at the drain with the short reader still held, releases the sink gate, and uses a queued ping/pong barrier to prove terminal-notice flushing, fixed-plan reconnect, directed reconciliation, and final completion ordering without sleeps or package timing.

### Additional RED/GREEN — retry isolation

Command after adding a regression for retrying an attention attempt:

```sh
npm test -- tests/unit/nowcoderDirectedStore.test.ts -t "clears source-attempt attention state"
```

RED:

```text
Test Files  1 failed (1)
Tests  1 failed | 15 skipped (16)
ZodError: 只有需处理运行可携带 attentionReason
```

Root cause: retry correctly froze fresh build/runtime evidence but the source spread still retained terminal attention/marker/publisher fields. Retry now explicitly clears `attentionReason`, `publishReceipt`, `verifiedMarkerHash`, and recovery state.

GREEN:

```text
Test Files  1 passed (1)
Tests  1 passed | 15 skipped (16)
```

### Final focused GREEN

Command:

```sh
npm test -- tests/unit/nowcoderDirectedRecovery.test.ts tests/unit/nowcoderDirectedOwnership.test.ts tests/unit/build-stamp.test.ts tests/unit/auto-reload.test.ts tests/unit/artifactReaderCoordinator.test.ts tests/unit/nowcoderDirectedCapability.test.ts tests/unit/nowcoderDirected.test.ts tests/unit/nowcoderDirectedStore.test.ts tests/unit/auto-update.test.ts tests/unit/connection.test.ts
```

Fresh result:

```text
Test Files  10 passed (10)
Tests  167 passed (167)
```

The focused matrix includes deterministic event logs for exact start order, concurrent replay-handle transfer, runtime append/dedupe, drift at dispatch/result/refill/staging boundaries, result-drift no-sink behavior, marker precedence, restart reacquisition, operation-reader lifetime, one physical lease shared by an active directed run and ZSXQ persistence, update/start arbitration, health privacy, and extension auto-reload busy behavior.

Type verification:

```sh
npm run typecheck
```

Fresh result: exit 0.

Final tree checks after staging the cumulative Task 4 tree:

```sh
git diff --check
git diff --cached --check
```

Fresh result: both exit 0 with no output.

### Fix round 1 witnessed RED/GREEN

Initial regression command, before the fix implementation:

```sh
npm test -- tests/unit/nowcoderDirectedStore.test.ts tests/unit/nowcoderDirectedCapability.test.ts tests/unit/artifactReaderCoordinator.test.ts tests/unit/auto-update.test.ts tests/unit/nowcoderDirectedOwnership.test.ts
```

Observed RED:

```text
Test Files  5 failed (5)
Tests  14 failed | 67 passed (81)
```

Thirteen failures directly witnessed uncommitted replay visibility, marker recovery touching live/reader/JobStore first, missing physical-release busy/idle state, and post-commit reconciliation rejection. The operation-reader fixture initially attempted the schema-invalid terminal state `completed` without Task 8's exact delivery receipt; that fixture was corrected to the valid Task 4 terminal state `failed` before production changes. Its isolated deterministic RED then was:

```text
Test Files  1 failed (1)
Tests  1 failed | 11 skipped (12)
AssertionError: runUpdate was called while physical release was still blocked
```

First GREEN checkpoint after the store/service/coordinator fixes:

```sh
npm test -- tests/unit/nowcoderDirectedStore.test.ts tests/unit/nowcoderDirectedCapability.test.ts tests/unit/artifactReaderCoordinator.test.ts tests/unit/auto-update.test.ts
```

```text
Test Files  4 passed (4)
Tests  69 passed (69)
```

Server race GREEN after the stale-socket and terminal-operation-reader fixes:

```sh
npm test -- tests/unit/nowcoderDirectedOwnership.test.ts
```

```text
Test Files  1 passed (1)
Tests  12 passed (12)
```

The final 10-file command shown above was rerun after all fix-round changes and passed 167/167. Its deterministic barriers prove: a blocked atomic write never leaks a replay; valid marker recovery runs without a reader or JobStore context; physical release blocks package/restart until settled; stale sockets receive no `job.collect` and leave the job queued; committed start/retry survives a throwing reconciliation callback with only redacted health quarantine; and a terminalized run reader cannot expose the artifact while the short persistence reader remains active.

### Fix round 1 review adjudication

The request to require `zsxq-complete-content-v1` was dismissed. Direct inspection of baseline `7d9cedb` shows:

```text
packages/shared/src/protocol.ts: ZSXQ_COMPLETE_CONTENT_CAPABILITY = 'zsxq-complete-content-v2'
```

Current protocol documentation, extension extraction metadata, Bridge sink validation, and positive tests all use the shared v2 constant. Remaining v1 literals are negative regression fixtures proving obsolete evidence is rejected. No production capability was changed.

### Fix round 2 witnessed RED/GREEN

Deterministic RED command on cumulative snapshot `e24b3deed7a9d07c98d368b1532340b180d4c2b5`:

```sh
npm test -- tests/unit/nowcoderDirectedCapability.test.ts tests/unit/artifactReaderCoordinator.test.ts tests/unit/nowcoderDirectedOwnership.test.ts
```

Observed result:

```text
Test Files  3 failed (3)
Tests  6 failed | 43 passed (49)
```

The failures witnessed two concurrent verified probes, two absent-marker probes, attention during a blocked publisher that later linearized its marker, an independently resolving caller instead of a joined rejected flight, raw release-failure propagation with false idle state, and a server start edge waking deferred update/restart after uncertain physical release.

The same targeted command after the minimal implementation:

```text
Test Files  3 passed (3)
Tests  49 passed (49)
```

Final complete Task 4 focused matrix:

```sh
npm test -- tests/unit/nowcoderDirectedRecovery.test.ts tests/unit/nowcoderDirectedOwnership.test.ts tests/unit/build-stamp.test.ts tests/unit/auto-reload.test.ts tests/unit/artifactReaderCoordinator.test.ts tests/unit/nowcoderDirectedCapability.test.ts tests/unit/nowcoderDirected.test.ts tests/unit/nowcoderDirectedStore.test.ts tests/unit/auto-update.test.ts tests/unit/connection.test.ts
```

```text
Test Files  10 passed (10)
Tests  173 passed (173)
```

Fresh `npm run typecheck` result: exit 0.

The full repository suite was intentionally not run because the approved Task 4 brief requested the focused matrix unless it exposed a wider regression; it did not.

### Fix round 3 witnessed RED/GREEN

Deterministic RED command on cumulative snapshot `adc60546577e3ea9e2d91be0a1b5c8f73e1f9459`:

```sh
npm test -- tests/unit/artifactReaderCoordinator.test.ts tests/unit/nowcoderDirectedCapability.test.ts tests/unit/nowcoderDirectedOwnership.test.ts
```

Observed result before production changes:

```text
Test Files  3 failed (3)
Tests  8 failed | 48 passed (56)
```

The two coordinator failures proved concurrent and later calls on one logical handle did not share its release promise. Two stale-run acquisition failures retained a reader after terminalization/replacement; the close/acquisition failure showed `service:close:end` before the physical acquisition returned and no subsequent physical release. Ordinary and verified publisher failures showed close had already reduced `activeReaders` to zero while the callback remained blocked.

The server RED used the real updater path and an observable restart-intent event rather than private state. Its witnessed order was `update:start` → `physical:release:start` → `update:changed` → `restart:pending`; after release rejection, the socket/idle wake printed `[update] 新版本已构建，本机服务重启以生效` and invoked `exit` once. Removing the production `physicalBusy` restart guard reproduces that exact failure, so the assertion is not vacuous.

The same targeted command after the minimal implementation:

```text
Test Files  3 passed (3)
Tests  56 passed (56)
```

The release-rejection regression installs settlement observers before rejecting the physical gate, proves the first/concurrent/later calls return the exact same promise and rejection identity, and completed without an unhandled rejection. The server GREEN retains `physicalBusy: true` and `physicalFaulted: true`, runs the updater once, never exits, releases restart intent before coordinator close, and reports the stable quarantine only after safe cleanup.

Final complete Task 4 focused matrix:

```sh
npm test -- tests/unit/nowcoderDirectedRecovery.test.ts tests/unit/nowcoderDirectedOwnership.test.ts tests/unit/build-stamp.test.ts tests/unit/auto-reload.test.ts tests/unit/artifactReaderCoordinator.test.ts tests/unit/nowcoderDirectedCapability.test.ts tests/unit/nowcoderDirected.test.ts tests/unit/nowcoderDirectedStore.test.ts tests/unit/auto-update.test.ts tests/unit/connection.test.ts
```

```text
Test Files  10 passed (10)
Tests  180 passed (180)
```

Fresh `npm run typecheck` result: exit 0.

### Fix round 4 witnessed RED/GREEN

Deterministic RED command on cumulative snapshot `cc4a91e880befdece7a8be66708b902637a06ea1`:

```sh
npm test -- tests/unit/nowcoderDirectedCapability.test.ts tests/unit/nowcoderDirectedOwnership.test.ts
```

Observed result before production changes:

```text
Test Files  2 failed (2)
Tests  5 failed | 46 passed (51)
```

Three service failures proved that finalize, attention, and close-fenced stale-acquisition cleanup release rejections were discarded: the terminal/acquisition operation settled, the handle was absent from `runReaders`, and `close()` incorrectly fulfilled. Two server failures proved the sequential shutdown short-circuit: coordinator quarantine leaked its raw message, while a directed-service close rejection returned early without attempting restart-intent release or coordinator close.

Every rejecting gate had a rejection observer installed before it was triggered. The mutations are direct and deterministic: remove release-flight outcome retention and all three service close assertions fulfill; restore sequential server awaits and the restart/coordinator call-count assertions remain zero while a non-normalized error escapes.

The same two focused suites after the minimal implementation:

```text
Test Files  2 passed (2)
Tests  51 passed (51)
```

The service regressions prove close waits for the blocked release, returns the exact same close promise before and after settlement, rejects with the same stable `牛客定向服务未能安全关闭` error, retains durable finalize/attention state, and never exposes private release text. The server regression establishes a real active directed reader plus changed-update restart intent, proves socket teardown happens while close is fenced, then observes exactly one restart-intent release and coordinator-close attempt, no `exit`, and one shared redacted server-close rejection after both failing cleanups.

Final complete Task 4 focused matrix:

```sh
npm test -- tests/unit/nowcoderDirectedRecovery.test.ts tests/unit/nowcoderDirectedOwnership.test.ts tests/unit/build-stamp.test.ts tests/unit/auto-reload.test.ts tests/unit/artifactReaderCoordinator.test.ts tests/unit/nowcoderDirectedCapability.test.ts tests/unit/nowcoderDirected.test.ts tests/unit/nowcoderDirectedStore.test.ts tests/unit/auto-update.test.ts tests/unit/connection.test.ts
```

```text
Test Files  10 passed (10)
Tests  184 passed (184)
```

Fresh `npm run typecheck` result: exit 0.

## Design and safety audit

- `bridgeBuildId` is the deployment-source artifact ID captured at Bridge process start; no code uses Git HEAD as evidence.
- Exact replay is the only path that bypasses the live gate. The serialized store mutation remains final authority, so concurrent new keys still obey the single-active-run invariant.
- Replay preflight itself is now a committed read: it waits for the current atomic mutation to commit or roll back, then returns the durable replay or allows a genuinely fresh gate. It never returns the mutable in-flight envelope.
- The run reader and every short operation reader share one physical lease; no same-process re-acquisition of the exclusive filesystem lock remains in ZSXQ or directed result persistence.
- Coordinator idle excludes pending physical acquisition, a held physical lease, and unresolved asynchronous release. Update/restart cannot enter any of those states, and only the busy-to-fully-idle edge wakes deferred work.
- Directed result readers stay held through `notifyJobTerminal()` and its selection/finalization seam, then release only after the server clears persistence ownership. There is no persistence-drain wait inside terminal notification.
- Verified-marker recovery probes only durable run identity/snapshot and runs before startup/hello reader reacquisition, live evidence, or strict JobStore context. Ordinary unverified recovery retains every existing guard.
- Staging/publishing recovery has no direct alternate path: hello evidence and queued reconciliation both enter the same whole-decision flight. It re-reads durable attempt/phase after the probe, reader acquisition, and live guard; terminal/replaced attempts exit without callback or attention.
- Publisher flight rejection is shared by joiners and removes only its own map identity in `finally`; a later call reprobes and may recover once. Completed recovery sets remain the idempotency fence after a successful flight.
- Physical release fulfillment clears the exact retained lease and exact release promise before emitting the idle edge. Rejection retains the lease identity plus a stable fault, never emits idle, and all concurrent/future callers observe quarantine rather than reacquiring.
- Every logical handle retains its own exact release promise across fulfillment or rejection. Reference decrement and physical release initiation execute only once; repeated calls cannot fabricate an early successful settlement or underflow the count.
- Service shutdown is a closed-state fence followed by an identity-tracked drain. Operations can remove only their own promise, publisher flights cannot be added beyond the fence, a newly acquired stale handle is released before any map write, and run readers are released only after the drain reaches a fixed point.
- Logical release flights have a separate identity registry and persistent failure outcome. Close drains non-release work and existing release flights, attempts every still-owned handle, then re-drains operations and newly registered release flights before deciding its stable result. A handle's coordinator-cached promise remains authoritative, so replayed cleanup never starts a second physical release.
- Restart intent alone is not treated as proof that physical ownership is safe: every restart wake reads the current coordinator snapshot and refuses exit while a physical lease, release, or fault remains busy.
- Bridge shutdown aggregates only after ordered cleanup. A directed-service rejection cannot skip restart authority release or coordinator close, and a coordinator rejection cannot expose its physical/private text; the shared Bridge close promise settles once with the normalized server error.
- Public projections exclude runtime IDs, current job IDs, local paths, recovery state, and private delivery identity. Health returns one redacted active boolean plus the pre-existing online/disk build and capability fields.
- Ordinary and fixed-plan hellos remain schema-compatible without directed capabilities. Missing directed evidence affects only an active/new directed run; ordinary work remains dispatchable.
- No Task 5 selection/fill, Task 6 cancellation, Task 7 telemetry/tab stop, Task 8 publisher/marker implementation, or Task 9 HTTP/CLI surface was added.

## Remaining cross-task boundary

Task 7 must later replace the single service attention seam with its persisted stop-intent → close/observe owned tabs to zero → durable attention/final release sequence. Task 4 intentionally does not fabricate that telemetry/cancellation behavior. Because server code has no direct directed-run attention/terminal write and the generic raw store terminal helper was removed, that later change has one production seam to update.
