# Nowcoder Directed Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable, cancellable, auditable keyword/latest workflow to the Data Collector browser extension and CLI, then prove it by publishing one exact current run of 10 Agent-development interview posts without Codex Browser Use.

**Architecture:** `NowcoderDirectedStore` owns frozen search sessions and directed runs without adding a fake fixed plan. Bridge performs verified JSON `order=create` discovery, the trusted extension collects only detail pages, a restart-safe service fills from the frozen candidate set, and an exact-batch publisher exposes inbox entries only after one durable marker linearization point.

**Tech Stack:** TypeScript 7, Zod 4, Node 22 fetch/HTTP, Manifest V3 Edge extension APIs, Vitest, packaged-extension E2E.

**Spec:** `docs/superpowers/specs/2026-08-30-nowcoder-directed-search-design.md`

## Global Constraints

- Work on `master`; repository `CLAUDE.md` explicitly forbids feature branches. Preserve unrelated changes.
- Run Node/npm with `env PATH=/Users/chenhao/.nvm/versions/node/v22.22.3/bin:/usr/bin:/bin`; the login shell defaults to unsupported Node 8.
- Repository versioning permits one patch bump per implementation iteration. Keep task checkpoints uncommitted, review them through pre/post `git stash create` snapshot SHAs, and make one final code commit at `0.4.33` after all task/final reviews. Design/plan-only commits do not trigger a bump.
- Each task implementer writes the test first, runs it and records the expected RED, writes minimal production code, runs GREEN, self-reviews, stages only its files, and does not commit.
- Search is Bridge fetch to the Nowcoder JSON endpoint with body `type: "post"`, `order: "create"`; directed runs never consume an unverified SSR fallback.
- The extension opens only canonical Nowcoder detail URLs through existing remote-job machinery; it never opens `/search`, types a keyword into Nowcoder, clicks sort, invokes Browser Use, or performs model inference.
- Directed selection uses only jobs owned by the current run/attempt. Historical pending pools and cross-batch manual pooling are forbidden.
- Private stored `completed` state requires `deliveryIds.length === deliveryItems.length === publicDeliveryItems.length === accepted === delivered === target`, unique stable IDs/URLs/clusters, current run/attempt ownership, and a verified exact-batch marker. Public responses contain only redacted `publicDeliveryItems`.
- Target is 1–10, default 10; initial detail round 8, refill 4, distinct detail budget 24, extension remote concurrency at most 2.
- At most one directed run is active globally. Idempotent replay returns that run; a different start/retry conflicts until the active run reaches a terminal state.
- Cancellation succeeds only before the persisted transition into `publishing`, fences late results/refill/publish, and closes only current-run owned tabs. Once `publishing` begins, cancel returns 409 and the run finishes/reconciles instead of lying that it cancelled. The later marker write is the separate manifest-consumption linearization point.
- No manifest permission, `<all_urls>`, cookie permission, or CSP external connection expansion.
- Audit fixes `executionEngine: "bridge-fetch+edge-extension"`, `codexBrowserUse: false`, `llmCalls: 0`, `llmTokens: 0`; it stores no body, HTML, Cookie, auth header, author or local source path.
- Bridge freezes extension build/capability at run start, holds the active-run artifact lease, permits same-build runtime restart, and attentions on build/capability drift.
- UI interaction contract in `docs/sidepanel-states.md` must be changed before Side Panel code.

## Review Checkpoint Procedure

For every task:

1. Controller records `PRE=$(git stash create "pre-task-N")`; if clean, use current `HEAD`.
2. Implementer changes only task files, records RED/GREEN commands in its report, stages those files, and returns without committing.
3. Controller records `POST=$(git stash create "post-task-N")` and generates the task review package from `PRE..POST`.
4. A separate reviewer checks spec compliance and quality. Critical/Important findings return to the same implementer and receive a scoped re-review.
5. Only after a clean task review does execution move forward. The accumulated staged tree stays in place.

---

### Task 1: Establish the authorized product boundary, strict contracts, and version

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/sinks.md`
- Modify: `docs/protocol.md`
- Create: `packages/shared/src/nowcoderDirected.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/model.ts`
- Modify: `packages/shared/src/protocol.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/shared/package.json`
- Modify: `packages/bridge/package.json`
- Modify: `packages/extension/package.json`
- Modify: `packages/extension/manifest.json`
- Modify: `packages/shared/src/identity.ts`
- Create: `tests/unit/nowcoderDirected.test.ts`
- Modify: `tests/unit/plans.test.ts`
- Modify: `tests/unit/package.test.ts`
- Modify: `tests/unit/identity.test.ts`

**Interfaces:**
- `normalizeNowcoderDirectedQueries(values)` applies NFKC, whitespace collapse, first-occurrence dedupe and exact input limits.
- `StoredNowcoderDirectedRun` is the private persistence contract and contains current job IDs/idempotency lineage. `PublicNowcoderDirectedRun` is the HTTP/CLI contract, omits job IDs and local paths, and exposes redacted delivery items with an irreversible `lineageId`.
- Strict public types/schemas cover search request/session/candidate, directed spec/public run/status/phase, public delivery item, public publish receipt, preview/start/cancel/retry HTTP bodies and responses. Separate private schemas validate stored run, private delivery items and publisher recovery state.
- `NOWCODER_DETAIL_CAPABILITY = 'nowcoder-detail-v1'`.
- `JobRecord` gains paired optional `directedRunId`/`directedRunAttempt`.
- WebSocket schemas support paired directed ownership on `job.collect`, fenced `job.cancel`, and per-run owned-tab telemetry.

- [ ] **Step 1: Update the product boundary before implementing behavior**

Document this exact exception in `CLAUDE.md` and `docs/sinks.md`: ordinary current-page/list capture still stops in the local library, while a directed Nowcoder run may auto-publish an exact inbox batch only when Side Panel explicitly checks delivery authorization or CLI passes `--deliver`. Marker-less staging/partial inbox content is never consumable.

- [ ] **Step 2: Write normalization and cross-field RED tests**

```ts
expect(normalizeNowcoderDirectedQueries([' 字节  Agent　面经 ', '字节 Agent 面经']))
  .toEqual(['字节 Agent 面经']);
expect(() => nowcoderSearchRequestSchema.parse({ queries: ['Agent\u0000面经'], target: 10, sort: 'latest' })).toThrow();
expect(() => nowcoderSearchRequestSchema.parse({ queries: Array.from({ length: 13 }, (_, i) => `Agent ${i}`), target: 10, sort: 'latest' })).toThrow();
expect(() => nowcoderSearchRequestSchema.parse({ queries: ['Agent 面经'], target: 11, sort: 'latest' })).toThrow();
```

Run: `npm test -- tests/unit/nowcoderDirected.test.ts`

Expected RED: module/schema does not exist.

- [ ] **Step 3: Implement exact limits and run invariants**

Use: query count 1–12, query length 1–80, total normalized length <=480, target 1–10, max details exactly 24, attempt exactly 16 lower-hex. Statuses are `running`, `cancelling`, `publishing`, `cancelled`, `completed`, `completed_with_attention`, `failed`; phases are `collecting`, `selecting`, `staging`, `publishing`.

The private `completed` schema requires target-equal accepted/delivered/private/public delivery arrays, unique stable IDs/canonical URLs/cluster IDs, current job ownership, and publish receipt IDs/hashes equal private delivery items. The public schema independently requires target-equal accepted/delivered/IDs/redacted items with unique irreversible lineage IDs and no `jobId`. Non-completed runs have empty public delivery arrays unless a verified marker proves recovery must converge to completed.

- [ ] **Step 4: Test and implement paired job/cancel/telemetry ownership**

```ts
expect(jobCancelPayloadSchema.parse({
  directedRunId: 'directed-1', directedRunAttempt: '0123456789abcdef',
})).toEqual({ directedRunId: 'directed-1', directedRunAttempt: '0123456789abcdef' });
expect(() => directedTelemetryPayloadSchema.parse({
  directedRunId: 'directed-1', directedRunAttempt: '0123456789abcdef',
  activeOwnedTabs: 1, peakOwnedTabs: 3,
})).toThrow();
```

All directed ownership fields are both-present-or-both-absent. Protocol external fields consistently use `directedRunAttempt`.

- [ ] **Step 5: Bump all required version locations once**

Set root/workspace/manifest/shared-dependency/identity values to `0.4.33`, then run `npm install --package-lock-only` with Node 22 PATH.

- [ ] **Step 6: Run focused GREEN and stage checkpoint**

Run: `npm test -- tests/unit/nowcoderDirected.test.ts tests/unit/plans.test.ts tests/unit/package.test.ts tests/unit/identity.test.ts`

Expected: PASS; stage Task 1 files, no commit.

---

### Task 2: Perform verified-latest discovery and freeze durable search sessions

**Files:**
- Create: `packages/bridge/src/nowcoderDirected/discovery.ts`
- Create: `packages/bridge/src/nowcoderDirected/store.ts`
- Modify: `packages/bridge/src/feJourney/nowcoderDiscovery.ts`
- Create: `tests/unit/nowcoderDirectedDiscovery.test.ts`
- Create: `tests/unit/nowcoderDirectedStore.test.ts`
- Modify: `tests/unit/feJourneyNowcoderDiscovery.test.ts`

**Interfaces:**
- `discoverNowcoderDirectedCandidates(fetcher, request, knownUrls, now)` returns candidates plus provider/order/sort/request audit.
- `NowcoderDirectedStore` atomically stores sessions, runs, run-private candidate cursor/job IDs/checkpoints, start/retry idempotency maps and publish receipts in a 0600 versioned file.

- [ ] **Step 1: Write complete-envelope search RED tests**

Use a fixture with `success: true`, `code: 0`, `data.totalPage: 2`, and a record containing a real `/feed/main/detail/<opaque-id>` URL plus a conflicting numeric ID. Assert page 1/2 request bodies are exactly `{ type:'post', query, order:'create', page }`, and the real URL wins over guessed `/discuss/<id>`.

Also cover cross-query/page global descending time, duplicate URL merge, missing/invalid time preview-only status, stable ties `(queryIndex,page,rank,url)`, official detail allowlist, known URL exclusion and JSON failure with error text `无法验证最新排序` and no SSR result.

Run: `npm test -- tests/unit/nowcoderDirectedDiscovery.test.ts`

Expected RED: directed discovery module missing.

- [ ] **Step 2: Implement JSON-only directed discovery**

Reuse bounded two-page/two-request concurrency and canonical parsing without changing fixed-plan fallback behavior. Audit is fixed to `{ provider:'nowcoder-json', requestedSort:'latest', order:'create', sortVerified:true, codexBrowserUse:false }` only after every consumed result satisfies the JSON contract.

- [ ] **Step 3: Write persistence/expiry/idempotency/rollback RED tests**

Reopen the store and assert frozen candidate order survives. First start rejects expired session; retry from an existing run is permitted after session expiry. Same start key/body replays one run; same key/different body conflicts. Retry requires a new key, creates one new run/attempt with `retryOf`, and repeated retry key replays that new run. Atomic write failure rolls memory back.

- [ ] **Step 4: Implement the private store and checkpoints**

Session TTL is 30 minutes. `startRun` validates selected IDs belong to the session, selected candidates only change priority, and delivery authorization is explicit. Run private state stores frozen candidates, cursor, current round IDs, exact phase, job ownership and start build evidence. Public getters map `StoredNowcoderDirectedRun` to `PublicNowcoderDirectedRun`, redact private job IDs/idempotency maps/local paths, and emit only irreversible lineage IDs. The store permits one globally active directed run; another body/key conflicts while exact idempotent replay returns the existing run.

- [ ] **Step 5: Run GREEN and stage checkpoint**

Run: `npm test -- tests/unit/nowcoderDirectedDiscovery.test.ts tests/unit/nowcoderDirectedStore.test.ts tests/unit/feJourneyNowcoderDiscovery.test.ts`

Expected: PASS; stage, no commit.

---

### Task 3: Add directed job ownership, result fences, and restart reconciliation

**Files:**
- Create: `packages/bridge/src/nowcoderDirected/service.ts`
- Modify: `packages/bridge/src/jobs/store.ts`
- Modify: `packages/bridge/src/server/index.ts`
- Create: `tests/unit/nowcoderDirectedOwnership.test.ts`
- Create: `tests/unit/nowcoderDirectedRecovery.test.ts`
- Modify: `tests/unit/jobs.test.ts`

**Interfaces:**
- JobStore persists directed run/attempt and rejects plan+directed ownership together.
- `NowcoderDirectedService.reconcileAll()` and `onJobTerminal()` operate only on current attempts.
- Server checks the run fence before result save/candidate-index commit and notifies both fixed-plan and directed services after terminals.

- [ ] **Step 1: Write job ownership/result fence RED tests**

Create an old-attempt and current-attempt job for the same canonical URL. Assert the old result may remain local evidence but cannot change run counters, candidate selection, cursor or publish calls. Assert a job cannot set both `planId` and `directedRunId`.

Run: `npm test -- tests/unit/nowcoderDirectedOwnership.test.ts tests/unit/jobs.test.ts`

Expected RED: directed job ownership unsupported.

- [ ] **Step 2: Implement ownership at create/dispatch/result/terminal boundaries**

Directed child ID is `${run.id}-${run.attempt}-${stableContentId(url)}`. Before result processing, stored-document preparation, terminal advancement and reconnect dispatch, compare both run ID and attempt. Old attempt messages receive no run state mutation.

- [ ] **Step 3: Write restart checkpoint RED tests**

Reopen JobStore and directed store during: first round in progress, refill in progress, all-round terminal before selection, selection complete before staging, and publishing checkpoint. Assert recovery does not re-search, does not exceed 24, does not attach historical jobs, requeues only same-attempt unfinished jobs and never duplicates a terminal job.

- [ ] **Step 4: Implement deterministic reconciliation**

`reconcileAll()` compares persisted phase/current round/job IDs with JobStore. `collecting` resumes or advances only when the current round is terminal; `selecting` reruns deterministic selection; `staging/publishing` delegates to Task 8 publisher recovery. Search session candidates/cursor never change.

- [ ] **Step 5: Run GREEN and stage checkpoint**

Run: `npm test -- tests/unit/nowcoderDirectedOwnership.test.ts tests/unit/nowcoderDirectedRecovery.test.ts tests/unit/jobs.test.ts tests/unit/collectionPlanService.test.ts`

Expected: PASS; stage, no commit.

---

### Task 4: Freeze extension capability/build evidence and protect active runs from updates

**Files:**
- Modify: `packages/extension/src/background/connection.ts`
- Modify: `packages/extension/src/background/index.ts`
- Modify: `packages/bridge/src/server/index.ts`
- Modify: `packages/bridge/src/autoUpdate.ts`
- Modify: `tests/unit/connection.test.ts`
- Modify: `tests/unit/auto-update.test.ts`
- Create: `tests/unit/nowcoderDirectedCapability.test.ts`

**Interfaces:**
- Extension hello contains (not equals-only) both ZSXQ and `nowcoder-detail-v1` capabilities without duplicates.
- Service start freezes extension version/build/capability; same-build runtime IDs append to audit, different build/capability attentions.
- Active directed runs participate in the artifact lease/update gate.

- [ ] **Step 1: Write capability/build drift RED tests**

Cover offline extension, missing capability, disk/online build mismatch, artifact change mid-round, different-build reconnect, same-build runtime restart and active-update attempt. Different build must stop before further dispatch/result/refill/publish; same build may recover and records both runtime IDs.

Run: `npm test -- tests/unit/nowcoderDirectedCapability.test.ts tests/unit/connection.test.ts tests/unit/auto-update.test.ts`

Expected RED: capability/build gate absent.

- [ ] **Step 2: Implement start and per-boundary build verification**

Verify at start, each dispatch, result acceptance, refill, staging and marker publish. Hold/release the existing artifact lease with run lifetime. Do not use git HEAD as build proof.

- [ ] **Step 3: Run GREEN and stage checkpoint**

Run the same focused files plus `tests/unit/build-stamp.test.ts` and `tests/unit/auto-reload.test.ts`.

Expected: PASS; stage, no commit.

---

### Task 5: Fill only current-run candidates to an exact target and recover selection

**Files:**
- Modify: `packages/bridge/src/nowcoderDirected/service.ts`
- Modify: `packages/bridge/src/plans/nowcoderPlan.ts`
- Modify: `packages/bridge/src/plans/nowcoderProcessedHistory.ts`
- Create: `tests/unit/nowcoderDirectedFill.test.ts`
- Modify: `tests/unit/nowcoderPlan.test.ts`
- Modify: `tests/unit/nowcoderProcessedHistory.test.ts`

**Interfaces:**
- `selectNowcoderPlanCandidates(documents, now, target = 10)` preserves fixed-plan default.
- Directed selection only reads run job IDs; it never calls `pendingNowcoderPlanJobs`.
- Strict processed history treats ENOENT as empty and malformed/schema/I/O failure as attention.

- [ ] **Step 1: Write 8+4/24/current-run RED tests**

Assert target 1, 7 and 10; initial 8, refill 4, max 24; wait for all current-round terminals; deterministic accepted order. Nine eligible current jobs plus twenty historical pending jobs must finish attention with no delivery arrays. Duplicate ID/URL/cluster and a cross-run job are rejected before staging.

Run: `npm test -- tests/unit/nowcoderDirectedFill.test.ts`

Expected RED: target-fill behavior missing.

- [ ] **Step 2: Implement target fill and structured delivery items**

Persist cursor/round before job creation, then attach job IDs before dispatch. Build `deliveryItems` from exactly target accepted current jobs: `{ jobId, stableContentId, canonicalUrl, contentHash, clusterId }`. Validate current run/attempt ownership and uniqueness before phase becomes `staging`.

- [ ] **Step 3: Add strict history tests and behavior**

Tests pass a repository root, not a history file path. Missing `.codex/interview-source-history.json` is empty; malformed envelope, invalid record or read error is fatal in strict directed mode. Fixed scheduled mode keeps its documented compatibility unless explicitly changed.

- [ ] **Step 4: Run GREEN and stage checkpoint**

Run: `npm test -- tests/unit/nowcoderDirectedFill.test.ts tests/unit/nowcoderPlan.test.ts tests/unit/nowcoderProcessedHistory.test.ts tests/unit/collectionPlanService.test.ts`

Expected: PASS; stage, no commit.

---

### Task 6: Cancel queued and active detail work with a bounded stop path

**Files:**
- Modify: `packages/extension/src/background/remoteJobScheduler.ts`
- Modify: `packages/extension/src/background/jobs.ts`
- Modify: `packages/extension/src/background/connection.ts`
- Modify: `packages/extension/src/background/index.ts`
- Modify: `packages/bridge/src/nowcoderDirected/service.ts`
- Modify: `packages/bridge/src/server/index.ts`
- Modify: `tests/unit/remoteJobScheduler.test.ts`
- Modify: `tests/unit/background.test.ts`
- Modify: `tests/unit/connection.test.ts`
- Create: `tests/unit/nowcoderDirectedCancel.test.ts`

**Interfaces:**
- `RemoteJobScheduler.run(task, priority, { signal })` removes queued aborted work and releases active capacity.
- `JobRunner.cancelRemoteJob(requestId, runId, attempt)` immediately closes that request's owned tab and aborts all long waits.
- Service cancellation persists intent first and fences all later external actions.

- [ ] **Step 1: Write queued and active abort RED tests**

Hold two scheduler tasks, abort a queued third and prove it never starts. For active tab-complete wait, extraction retry and linked-article wait, cancel and assert the tab closes and capacity reaches zero within a test-clock bound of one second; no raw abort error reaches UI.

Run: `npm test -- tests/unit/remoteJobScheduler.test.ts tests/unit/background.test.ts -t "cancel"`

Expected RED: active operations do not accept abort signals.

- [ ] **Step 2: Implement signal races and immediate owned-tab close**

Every long wait races `AbortSignal`; scheduler/runner cleanup is idempotent. Repeated/wrong-attempt cancel does nothing. Aborted directed jobs report `CANCELLED` without triggering login handoff.

- [ ] **Step 3: Write six service cancellation-race RED tests**

Cancel before first dispatch, between dispatches, during two active tabs, before refill, after selection before staging, and immediately before the persisted transition into `publishing`. Assert no later refill/staging/marker, empty delivery arrays, old result fenced and current-run tabs zero. Once `publishing` is persisted, cancellation returns 409 even when the marker does not yet exist, and the run cannot become cancelled.

- [ ] **Step 4: Implement persisted cancellation convergence**

Transition `running -> cancelling` before sending `job.cancel`. Fail never-dispatched queued children as `CANCELLED`, await/observe active terminal/telemetry, then persist `cancelled`. Side Panel close has no cancellation effect.

- [ ] **Step 5: Run GREEN and stage checkpoint**

Run: `npm test -- tests/unit/remoteJobScheduler.test.ts tests/unit/background.test.ts tests/unit/connection.test.ts tests/unit/nowcoderDirectedCancel.test.ts`

Expected: PASS with no leaked timers/promises; stage, no commit.

---

### Task 7: Attribute real owned tabs and persist per-run telemetry

**Files:**
- Modify: `packages/extension/src/background/ownedTabs.ts`
- Modify: `packages/extension/src/background/jobs.ts`
- Modify: `packages/extension/src/background/connection.ts`
- Modify: `packages/bridge/src/nowcoderDirected/service.ts`
- Modify: `tests/unit/ownedTabs.test.ts`
- Modify: `tests/unit/background.test.ts`
- Create: `tests/unit/nowcoderDirectedTelemetry.test.ts`

**Interfaces:**
- `OwnedTabRegistry` records purpose plus optional request/run/attempt owner and emits per-run snapshots.
- Telemetry fields are `activeOwnedTabs`, `peakOwnedTabs`, `terminalOwnedTabs`; scheduler counts are not used as tab evidence.

- [ ] **Step 1: Write per-run ownership RED tests**

Run an ordinary remote job and one directed run concurrently. Assert the run observes only its own tabs, peak <=2 globally, cleanup removes stale owned tabs after worker restart, handoff user tabs are excluded, and the terminal run stores zero active/terminal tabs. Assert a second directed start conflicts while the first is active.

Run: `npm test -- tests/unit/ownedTabs.test.ts tests/unit/nowcoderDirectedTelemetry.test.ts`

Expected RED: registry has no directed ownership metadata.

- [ ] **Step 2: Implement registry snapshots and fenced telemetry**

Track before navigation; if tracking fails, close immediately. Emit on create/close/cleanup. Bridge accepts telemetry only for current run/attempt and persists monotonic peak plus current count. A completed/cancelled run requires `terminalOwnedTabs === 0`.

- [ ] **Step 3: Run GREEN and stage checkpoint**

Run focused files plus `tests/unit/remoteJobScheduler.test.ts` and `tests/unit/background.test.ts`.

Expected: PASS; stage, no commit.

---

### Task 8: Publish an exact inbox batch behind one durable marker

**Files:**
- Create: `packages/bridge/src/nowcoderDirected/publisher.ts`
- Modify: `packages/bridge/src/nowcoderDirected/service.ts`
- Modify: `packages/bridge/src/sinks/repoInboxSink.ts`
- Modify: `packages/bridge/src/library/sync.ts`
- Modify: `packages/bridge/src/server/index.ts`
- Modify: `.codex/skills/data-collector-delivery/scripts/inbox-manifest.mjs`
- Create: `tests/unit/nowcoderDirectedPublisher.test.ts`
- Modify: `tests/unit/sinks.test.ts`
- Modify: `tests/unit/feJourneySmokeValidation.test.ts`
- Modify: `tests/unit/deliverySkill.test.ts`
- Modify: `tests/integration/pipeline.test.ts`

**Interfaces:**
- `publishNowcoderExactBatch(input)` stages all entries, moves them idempotently, writes marker last, and returns a durable `publishReceipt`.
- Marker contains run/attempt, exact stable IDs, final relative directories, per-entry hashes, whole-set hash and timestamp.
- Directed manifest requires and verifies this marker; legacy fixed plan manifests remain compatible.

- [ ] **Step 1: Write failure-injection and marker RED tests**

For targets 1, 7 and 10, inject failure at every staging item N=1..target, every move N, marker write, after marker/before run finalize, and restart. Before marker, manifest returns an explicit non-consumable error and zero items. After marker, restart reconciles exactly the same target-sized set and completes without duplicate directories. Extra/missing/hash-mismatched files fail manifest.

Run: `npm test -- tests/unit/nowcoderDirectedPublisher.test.ts`

Expected RED: exact publisher/marker absent.

- [ ] **Step 2: Implement staging and linearization**

Use a target-repo lock. Stage outside consumable `_inbox/nowcoder` paths. Verify all `run.spec.target` source revisions/hashes first. Move idempotently to final entry directories while marker is absent. Atomically write the target-sized marker last. Do not treat current `syncEntries(...,{atomic:true})` as an external transaction.

- [ ] **Step 3: Persist exact source lineage**

Every local/source entry records `directedRunId`, `directedRunAttempt`, `currentJobId`; delivery metadata uses `deliveryKind: 'nowcoder-directed'` and `deliveryBatchId: run.id`, never a fake fixed-plan ID. Private store/marker/audit retains current job IDs. Public run items omit job IDs/local paths and carry irreversible lineage IDs. Manifest returns only marker IDs and rejects historical/other-attempt entries.

- [ ] **Step 4: Test cancellation linearization and recovery**

Cancel before the persisted `publishing` transition succeeds and leaves no consumable batch. Cancel after `publishing` starts returns 409 even before the marker; recovery must complete or attention. Marker publication separately makes the target-sized batch consumable. Private publish receipt/delivery items/IDs and public redacted items are persisted after marker, and their respective schemas validate all exact equalities.

- [ ] **Step 5: Run GREEN and stage checkpoint**

Run: `npm test -- tests/unit/nowcoderDirectedPublisher.test.ts tests/unit/sinks.test.ts tests/unit/feJourneySmokeValidation.test.ts tests/unit/deliverySkill.test.ts tests/integration/pipeline.test.ts`

Expected: PASS; stage, no commit.

---

### Task 9: Expose authenticated HTTP and exact-ID CLI workflows

**Files:**
- Modify: `packages/bridge/src/server/index.ts`
- Modify: `packages/bridge/src/cli.ts`
- Modify: `tests/integration/bridge.test.ts`
- Modify: `tests/integration/cli.test.ts`

**Interfaces:**
- HTTP: create/get search session; start/get/cancel/retry directed run.
- CLI: `nowcoder preview|run|status|cancel|retry`; run requires either session or repeated query, plus `--latest --deliver`.

- [ ] **Step 1: Write authenticated route RED tests**

POST without bearer is 401; strict unknown body fields are 400; GET unknown query params are 400; unknown IDs 404; start/retry idempotency conflict 409; publishing cancel 409. Responses parse shared schemas and contain no token, Cookie, body, author, repo/config path or private job IDs.

Run: `npm test -- tests/integration/bridge.test.ts -t "nowcoder directed"`

Expected RED: routes do not exist.

- [ ] **Step 2: Implement routes behind existing loopback/auth guard**

Return 202 for a new run and 200 for idempotent replay. Do not route start until capability/build gate passes. Retry body carries a new idempotency key.

- [ ] **Step 3: Write CLI RED tests**

```ts
const code = await runCli([
  'nowcoder', 'run', '--query', '字节 Agent 面经', '--query', '腾讯 Agent 面经',
  '--target', '10', '--latest', '--deliver', '--idempotency-key', KEY, '--wait', '1800000',
], io);
expect(code).toBe(0);
expect(JSON.parse(io.stdout.join(''))).toMatchObject({ status: 'completed', accepted: 10, delivered: 10 });
expect(io.stdout).toHaveLength(1);
```

Missing latest/deliver/query-or-session, duplicate scalar flags, target 0/11 and unexpected positional args exit non-zero without secrets.

- [ ] **Step 4: Implement exact run polling**

`run --query` creates one frozen session then starts it. `--wait` polls only `/v1/nowcoder/runs/:id`, never recent lists. Attention/failed/cancelled print one terminal JSON object and exit non-zero.

- [ ] **Step 5: Run GREEN and stage checkpoint**

Run: `npm test -- tests/integration/bridge.test.ts tests/integration/cli.test.ts`

Expected: PASS; stage, no commit.

---

### Task 10: Define and build the Side Panel directed-search state machine

**Files:**
- Modify first: `docs/sidepanel-states.md`
- Modify: `packages/extension/src/sidepanel/index.html`
- Modify: `packages/extension/src/sidepanel/styles.css`
- Modify: `packages/extension/src/sidepanel/state.ts`
- Modify: `packages/extension/src/sidepanel/index.ts`
- Modify: `packages/extension/src/background/index.ts`
- Modify: `packages/extension/src/background/connection.ts`
- Modify: `tests/unit/sidepanel.test.ts`
- Modify: `tests/unit/sidepanel-controller.test.ts`
- Modify: `tests/unit/connection.test.ts`

**Interfaces:**
- Directed form is above/outside `#plans-list` in the Tasks page.
- Draft, generation, session, selected IDs and exact run state are independent from one-second fixed-plan renders.
- Internal messages are preview/start/status/cancel/retry and map to typed connection methods.

- [ ] **Step 1: Update the state priority/error matrix before UI code**

Document task-page directed state, explicit delivery authorization, sticky transport/server errors, preview/run generations, cancelling/publishing terminal rules, Side Panel close semantics and recovery from Bridge truth.

- [ ] **Step 2: Write stable form/semantic RED tests**

Render, focus and type into `#nowcoder-directed-queries`, then run repeated fixed-plan renders; value, focus and candidate checks stay. Cover preview, running, cancelling, publishing, cancelled, completed, attention, empty and failed. Only completed is success. Publishing has no Stop button.

Run: `npm test -- tests/unit/sidepanel.test.ts -t "定向搜索"`

Expected RED: form/state absent.

- [ ] **Step 3: Add stable markup and restrained fresh styling**

Form contains labelled multiline queries, target 1–10, read-only latest chip, explicit delivery checkbox, preview, candidate checklist, “采集并交付 N 篇”, Stop/Retry, metrics/rejections and live region. Reuse current tokens: white/soft-green surfaces, one accent, compact hierarchy, no decorative gradients or meaning-only animation.

- [ ] **Step 4: Write controller race/recovery RED tests**

Old preview generation cannot overwrite new; double start reuses one key/run; selection IDs must belong to visible session; polling cannot erase draft/terminal; reopen fetches exact session/run; persisted server truth wins over raw transport English; cancel disabled during publishing; Side Panel close does not cancel.

- [ ] **Step 5: Implement controller and typed background proxy**

Persist only normalized draft, target, delivery authorization, selected IDs, last session/run IDs and idempotency key in extension storage. Never persist search snippets/body/credentials. Feature works from any active tab; background detail tabs provide the browser session.

- [ ] **Step 6: Run GREEN and stage checkpoint**

Run: `npm test -- tests/unit/sidepanel.test.ts tests/unit/sidepanel-controller.test.ts tests/unit/connection.test.ts`

Expected: PASS; stage, no commit.

---

### Task 11: Update delivery Skill/docs, package artifact E2E, smoke and final code review

**Files:**
- Modify: `docs/product.md`
- Modify: `docs/protocol.md`
- Modify: `docs/testing.md`
- Modify: `docs/sinks.md`
- Modify: `.codex/skills/data-collector-delivery/SKILL.md`
- Modify: `.codex/skills/data-collector-delivery/references/nowcoder-content-delivery.md`
- Modify: `tests/unit/deliverySkill.test.ts`
- Modify: `tests/unit/package.test.ts`
- Modify: `tests/e2e/extension.test.ts`
- Modify: `package.json`
- Create: `scripts/smoke-nowcoder-directed.mjs`
- Create: `scripts/lib/nowcoder-directed-smoke.mjs`
- Create: `scripts/verify-packaged-extension.mjs`
- Create: `tests/unit/smokeNowcoderDirected.test.ts`

**Interfaces:**
- Keyword-based delivery defaults to directed CLI with exact run marker/manifest and explicitly forbids Browser Use; scheduled fixed delivery remains fixed-plan CLI.
- E2E loads the packaged artifact path and verifies bundle build ID equals artifact marker.

- [ ] **Step 1: Write Skill contract and artifact E2E RED tests**

Skill test executes/parses the CLI/manifest contract, not prose grep. E2E runs `npm run package`, loads the stable packaged extension directory, enters keywords, previews frozen latest candidates, starts target 10, drives fixture detail pages, observes marker completion, and asserts no owned `/search` URL/type/click, peak <=2, terminal tabs 0, exact current-run 10 and `codexBrowserUse=false`.

Run: `npm test -- tests/unit/deliverySkill.test.ts tests/unit/package.test.ts tests/unit/smokeNowcoderDirected.test.ts && npm run package && npm run verify:package && npm run test:e2e -- -t "nowcoder directed"`

Expected RED: Skill/artifact fixture absent.

- [ ] **Step 2: Update product/protocol/testing/Skill docs**

Remove stale “tasks page has no keywords”, old 12/four-per-company claims and ambiguous atomic wording. Document explicit delivery authorization, marker, retry key, exact manifest, build freeze, cancellation boundary and default no-Browser-Use workflow.

- [ ] **Step 3: Add deterministic public-surface smoke**

The script starts an isolated Bridge with fake Nowcoder JSON/detail/target repo, invokes CLI preview/run/wait, and invokes the real consumer as `node .codex/skills/data-collector-delivery/scripts/inbox-manifest.mjs --repo <repo> --batch <deliveryBatchId> --source nowcoder`. It asserts non-zero exit plus zero consumable items before marker publication, then exactly `run.spec.target` items after the marker. It also validates current-run lineage/audit, restarts in each checkpoint phase, tests cancellation idempotency/publishing conflict and scans output/store/marker/manifest for sensitive fields. It must not reconstruct a manifest by reading marker files directly.

- [ ] **Step 4: Run fresh full verification**

Run in order with Node 22 PATH:

```text
npm run typecheck
npm test
npm run package
npm run verify:package
npm run test:e2e
npm run smoke:nowcoder-directed
git diff --check
```

Expected: all exit 0, package/identity stay exactly `0.4.33`, no leaked handles/tabs.

- [ ] **Step 5: Dispatch final whole-change reviewers before committing**

Three independent reviewers inspect: protocol/security/recovery; extension/UI/cancel/owned tabs/build artifact; exact publisher/marker/current-run privacy. One fix implementer handles the consolidated Critical/Important findings, adds witnessed regression REDs, and receives one scoped re-review.

- [ ] **Step 6: Make the single code commit and push only after clean review**

Commit all accumulated implementation changes once as `feat: add nowcoder directed search`, then rerun full verification on the committed tree. Do not push until Task 12 live setup is ready; no amend after push.

---

### Task 12: Install, run a real exact-10 validation, curate, publish and clean up

**Files:**
- Generate private Data Collector run/audit evidence.
- Generate marker-scoped inbox entries in `/Users/chenhao/Code/front-end-journey-resource`.
- Resource changes are determined only after reading the exact manifest and repository-owned Skills.

**Interfaces:**
- Real run uses repeated queries, `--latest --deliver --target 10 --wait 1800000`.
- Exact manifest is scoped by directed run ID and marker.
- Resource repository owns editorial/tree/history/knowledge/SVG/publication rules.

- [ ] **Step 1: Package/install and verify live capability**

Use repository setup/install flow. `/health` must show version `0.4.33`, artifact/online build exact match, trusted extension online and `nowcoder-detail-v1`. A mismatch is a stop condition, not a Browser Use fallback.

- [ ] **Step 2: Run real broad-but-directed queries**

Use up to these 12 query families: 字节/腾讯/阿里/蚂蚁/美团/小红书/百度/京东/快手/华为 + `大模型应用开发 面经` + `AI Agent 研发 面经`. Adjust only exact wording after preview; every executed query remains frozen/audited.

Continue only for completed with 10 unique current-run delivery items, verified `order=create`, no historical pool, no Browser Use/model calls, per-run tab peak <=2/terminal 0 and valid marker. Preserve/diagnose attention/failed/cancelled attempts; never pool them into success.

- [ ] **Step 3: Generate the marker-scoped exact manifest**

Invoke the repository's real consumer as `node .codex/skills/data-collector-delivery/scripts/inbox-manifest.mjs --repo /Users/chenhao/Code/front-end-journey-resource --batch <deliveryBatchId> --source nowcoder`; do not independently read the marker and assemble a substitute manifest. Require its output to contain exactly 10 marker IDs/directories/hashes with matching `directedRunId`, attempt and current private job lineage. Reject missing/extra/hash mismatch, stale/non-A-B/incomplete/promotional/duplicate URL or cluster. If curation hard gates reduce usable count below 10, run a fresh directed session rather than lower quality or combine unrelated runs.

- [ ] **Step 4: Read and use resource repository Skills in order**

Use `.codex/skills/curate-fe-journey-inbox/SKILL.md`, then `curate-interview-posts/SKILL.md`, then `generate-knowledge-docs/SKILL.md` for any created/materially updated knowledge article. Framework/flow images must be hand-authored SVG, simple/fresh, clear hierarchy and reasonable layout; raster image generation is not used for these diagrams.

- [ ] **Step 5: Multi-Agent content validation and online publication**

Assign independent reviewers for source/question fidelity/privacy, knowledge technical accuracy/SVG rendering, and tree/history/heat/manifest consistency. Fix all blocking findings, run full resource tests/validators/link/SVG checks, commit and push resource `master`, wait for `sync-content` success and inspect public samples.

- [ ] **Step 6: Push Data Collector and clean exact evidence**

Freshly verify committed Data Collector, push `master`, and confirm local/remote HEAD equality. Only after resource workflow success remove marker-scoped inbox entries confirmed consumed; preserve rejected, malformed, failed, cancelled, attention and private audit evidence.

- [ ] **Step 7: Complete the goal with evidence**

Report discovered/scheduled/saved/accepted/delivered/consumed/blocked/failed counts; queries/order/browser/model audit; tab peak; marker/run ID; 10 public article keys; knowledge/SVG changes; Data Collector/resource commits; workflow ID/link; and all exclusions/rulings.
