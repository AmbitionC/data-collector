# Nowcoder Tab Loop Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a user-closed Nowcoder collection tab from reopening indefinitely while preserving one bounded crash recovery.

**Architecture:** The extension emits a typed user-close error. The Bridge terminalizes the owning Nowcoder run before any new dispatch, fences children whose fixed-plan parent is terminal, and persists a one-recovery budget for ordinary jobs. The plans view exposes the already-existing directed-active fact without duplicating the directed state machine.

**Tech Stack:** TypeScript, Chrome Extension MV3, Node.js Bridge, Vitest, WebSocket integration tests.

**Spec:** `docs/superpowers/specs/2026-09-02-nowcoder-tab-loop-safety-design.md`

## Global Constraints

- Work only on `master`; the user explicitly authorized implementation on the repository's required branch.
- Do not refresh user pages or close tabs not owned by Data Collector.
- Preserve ZSXQ attempt, completeness, ledger, and update-reload safety behavior.
- Directed jobs remain excluded from generic `JobStore.recover()`.
- This release is `0.4.34`: update root/shared/bridge/extension package versions, shared dependency versions, extension manifest, shared `APP_VERSION`, and identity tests; then run `npm install --package-lock-only`.
- Required final verification: `npm run typecheck && npm test && npm run package && npm run test:e2e`.

---

### Task 1: Typed owned-tab close signal

**Files:**
- Modify: `packages/extension/src/background/index.ts`
- Modify: `packages/extension/src/background/jobs.ts`
- Test: `tests/unit/background.test.ts`

**Interfaces:**
- Produces: `TAB_CLOSED_BY_USER` in the existing `job.error` payload when an extension-owned remote tab is authoritatively gone.
- Consumes: existing `waitForTabComplete()` and `JobRunner.runRemoteJobNow()` error path.

- [ ] **Step 1: Write the failing test**

Add a `JobRunner` test whose `waitForTabComplete` throws an error named
`CollectorTabClosedError`. Assert exactly one `job.error`, code
`TAB_CLOSED_BY_USER`, `needsAttention: false`, and exactly one owned-tab cleanup attempt.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/unit/background.test.ts -t "reports an owned tab close as an explicit user stop"`

Expected: FAIL because the current payload code is `COLLECTION_FAILED`.

- [ ] **Step 3: Implement the minimal signal mapping**

Name the `tabs.onRemoved` error `CollectorTabClosedError`. Add one helper in `jobs.ts` that recognizes that name or Chrome's exact missing-tab message and selects `TAB_CLOSED_BY_USER` before the generic `COLLECTION_FAILED` branch.

- [ ] **Step 4: Run task tests**

Run: `npm test -- --run tests/unit/background.test.ts`

Expected: PASS.

### Task 2: Durable stop fence and bounded ordinary recovery

**Files:**
- Modify: `packages/shared/src/model.ts`
- Modify: `packages/bridge/src/jobs/store.ts`
- Modify: `packages/bridge/src/plans/service.ts`
- Modify: `packages/bridge/src/server/index.ts`
- Modify: `packages/bridge/src/nowcoderDirected/service.ts`
- Test: `tests/unit/jobs.test.ts`
- Test: `tests/unit/collectionPlanService.test.ts`
- Test: `tests/unit/nowcoderDirectedOwnership.test.ts`
- Test: `tests/integration/bridge.test.ts`

**Interfaces:**
- Consumes: Task 1 error code `TAB_CLOSED_BY_USER`.
- Produces: optional persisted `JobRecord.recoveryCount`, `JobStore.recover()` terminal results, single-in-flight fixed-plan dispatch, ingress/dispatch fences, and parent-level stop behavior.

- [ ] **Step 1: Write failing store recovery tests**

Create one ordinary in-flight job and assert the first recovery returns it to `queued` with
`recoveryCount: 1`; transition it in-flight again and assert the second recovery returns it as
`needs_attention` with `RECOVERY_LIMIT_EXCEEDED`. Assert a legacy
`nowcoder-agent-market` child without the field is terminalized on recovery. Assert directed jobs remain excluded when passed in `excludedIds`.

- [ ] **Step 2: Run store tests and confirm RED**

Run: `npm test -- --run tests/unit/jobs.test.ts`

Expected: FAIL because `recoveryCount` and terminal recovery results do not exist.

- [ ] **Step 3: Implement persisted recovery budget**

Add the optional non-negative integer field, validate legacy/new values, clear it only on explicit terminal retry, and make `recover()` return newly terminal jobs. New ordinary jobs start at `recoveryCount: 0`; legacy in-flight fixed-plan Nowcoder jobs without the field are treated as having consumed one recovery.

- [ ] **Step 4: Write and run failing parent-stop tests**

Add tests asserting `TAB_CLOSED_BY_USER` moves a fixed Nowcoder batch to
`completed_with_attention`, terminalizes its queued children, moves a directed run into its existing cancellation flow, and a terminal fixed-plan parent prevents a queued child from producing `job.collect` after reconnect. Assert a Nowcoder fixed-plan round has only one `dispatched|collecting` child at a time and dispatches the next child only after the first terminalizes. Assert a late result after parent stop is rejected before sink persistence.

Run: `npm test -- --run tests/unit/collectionPlanService.test.ts tests/unit/nowcoderDirectedOwnership.test.ts tests/integration/bridge.test.ts`

Expected: FAIL before the parent stop and dispatch fence are implemented.

- [ ] **Step 5: Implement parent stop and dispatch fence**

Handle the typed terminal in each existing service. Change fixed Nowcoder collection to one in-flight child and release the next child from `onJobTerminal()`. At Bridge dispatch and incoming progress/result/error boundaries, verify every fixed-plan child still belongs to a `running` batch; otherwise terminalize it as `STALE_PLAN_RUN` without sink writes. After startup/hello recovery, call `notifyJobTerminal()` for jobs that exhausted their recovery budget before calling `dispatchQueued()`.

- [ ] **Step 6: Run focused task tests**

Run: `npm test -- --run tests/unit/jobs.test.ts tests/unit/collectionPlanService.test.ts tests/unit/nowcoderDirectedOwnership.test.ts tests/integration/bridge.test.ts`

Expected: PASS.

### Task 3: Status visibility, versioning, packaging, and live recovery

**Files:**
- Modify: `packages/extension/src/background/connection.ts`
- Modify: `packages/extension/src/background/index.ts`
- Modify: `packages/extension/src/sidepanel/index.ts`
- Modify: `packages/extension/src/sidepanel/state.ts`
- Modify: `packages/extension/src/sidepanel/index.html`
- Modify: version and identity files required by `CLAUDE.md`
- Test: `tests/unit/connection.test.ts`
- Test: `tests/unit/sidepanel.test.ts`
- Test: identity tests required by the repository

**Interfaces:**
- Consumes: Bridge `/health` field `directedRunActive` and existing plans status response.
- Produces: plans-side visibility for an active directed run; release version with no stale batch redispatch.

- [ ] **Step 1: Write failing status and rendering tests**

Assert `plans.status` carries `directedRunActive`, and the plans page shows a concise active notice only when true.

- [ ] **Step 2: Run tests and confirm RED**

Run: `npm test -- --run tests/unit/connection.test.ts tests/unit/sidepanel.test.ts`

Expected: FAIL because the plans state does not expose the field.

- [ ] **Step 3: Implement the visibility change**

Thread the boolean through existing status calls and render one static notice; do not add a second run state machine or a new scheduler.

- [ ] **Step 4: Bump patch version and refresh lockfile**

Update every location required by `CLAUDE.md` from `0.4.33` to `0.4.34`, then run `npm install --package-lock-only`.

- [ ] **Step 5: Run full verification and package**

Run: `npm run typecheck && npm test && npm run package && npm run test:e2e`

Expected: all commands exit 0.

- [ ] **Step 6: Reinstall and validate live safety**

Reinstall/start the packaged Bridge and reload the unpacked Edge Beta extension through the repository's existing update flow. Verify the legacy batch becomes terminal/attention, Bridge is healthy, Edge contains no Data Collector-owned Nowcoder tab, and it remains absent across a reconnect observation window.
