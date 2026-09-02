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

### Task 1: Complete Nowcoder tab-loop safety fix

**Files:**
- Modify: `packages/shared/src/model.ts`
- Modify: `packages/bridge/src/jobs/store.ts`
- Modify: `packages/bridge/src/plans/service.ts`
- Modify: `packages/bridge/src/server/index.ts`
- Modify: `packages/bridge/src/nowcoderDirected/service.ts`
- Modify: `packages/extension/src/background/connection.ts`
- Modify: `packages/extension/src/background/index.ts`
- Modify: `packages/extension/src/background/jobs.ts`
- Modify: `packages/extension/src/sidepanel/index.ts`
- Modify: `packages/extension/src/sidepanel/state.ts`
- Modify: `packages/extension/src/sidepanel/index.html`
- Modify: root/shared/bridge/extension package versions, shared dependency versions, `packages/extension/manifest.json`, `packages/shared/src/identity.ts`, `package-lock.json`
- Test: `tests/unit/background.test.ts`
- Test: `tests/unit/jobs.test.ts`
- Test: `tests/unit/collectionPlanService.test.ts`
- Test: `tests/unit/nowcoderDirectedOwnership.test.ts`
- Test: `tests/integration/bridge.test.ts`
- Test: `tests/unit/connection.test.ts`
- Test: `tests/unit/sidepanel.test.ts`
- Test: `tests/unit/identity.test.ts`

**Interfaces:**
- Produces: `TAB_CLOSED_BY_USER` in the existing `job.error` payload; optional persisted `JobRecord.recoveryCount`; `JobStore.recover()` terminal results; single-in-flight fixed-plan dispatch; fixed-plan ingress/dispatch fences; directed cancellation on close; and plans-side `directedRunActive` visibility.
- Consumes: existing owned-tab registry, fixed-plan store, directed cancellation state machine, Bridge `/health.directedRunActive`, and plans status response.

- [ ] **Step 1: Write and run the failing owned-tab test**

Add a `JobRunner` test whose `waitForTabComplete` throws an error named
`CollectorTabClosedError`. Assert exactly one `job.error`, code
`TAB_CLOSED_BY_USER`, `needsAttention: false`, and exactly one owned-tab cleanup attempt.

Run: `npm test -- --run tests/unit/background.test.ts -t "reports an owned tab close as an explicit user stop"`

Expected: FAIL because the current payload code is `COLLECTION_FAILED`.

- [ ] **Step 2: Implement and verify the close signal**

Name the `tabs.onRemoved` error `CollectorTabClosedError`. In `jobs.ts`, recognize that name or Chrome's exact missing-tab message and select `TAB_CLOSED_BY_USER` before generic `COLLECTION_FAILED`.

Run: `npm test -- --run tests/unit/background.test.ts`

Expected: PASS.

- [ ] **Step 3: Write and run failing recovery tests**

Create a fixed Nowcoder in-flight job and assert first recovery returns it to `queued` with
`recoveryCount: 1`; a second recovery returns `needs_attention` with
`RECOVERY_LIMIT_EXCEEDED`. Assert a legacy fixed Nowcoder child without the field is terminalized immediately, explicit retry resets the field, directed excluded jobs are unchanged, and ZSXQ recovery retains its current behavior.

Run: `npm test -- --run tests/unit/jobs.test.ts`

Expected: FAIL because the persisted counter and structured recovery result do not exist.

- [ ] **Step 4: Implement the bounded recovery model**

Add and validate the optional non-negative safe integer field. Initialize new fixed Nowcoder jobs to 0, reset it on explicit retry, and make `recover()` return `{ requeued, terminalized }`. First recovery requeues; the next terminalizes as `needs_attention/RECOVERY_LIMIT_EXCEEDED`. Treat a legacy in-flight fixed Nowcoder job without the field as already having used its recovery. Keep directed jobs excluded and ZSXQ unchanged.

Run: `npm test -- --run tests/unit/jobs.test.ts`

Expected: PASS.

- [ ] **Step 5: Write and run failing parent-stop and fence tests**

Assert `TAB_CLOSED_BY_USER` moves a fixed Nowcoder batch to `completed_with_attention`, terminalizes queued siblings, and moves a directed run into its existing cancellation flow. Assert only one fixed Nowcoder child is in-flight, the next starts only after terminal, terminal parents cannot dispatch queued children, late progress/result/error is rejected before sink persistence, and recovery-exhausted jobs notify/reconcile before any queued dispatch.

Run: `npm test -- --run tests/unit/collectionPlanService.test.ts tests/unit/nowcoderDirectedOwnership.test.ts tests/integration/bridge.test.ts`

Expected: FAIL before stop, sequencing, recovery notification, and fences exist.

- [ ] **Step 6: Implement parent stop, sequencing, and all fences**

Use existing `completed_with_attention` for fixed-plan stop. Fixed Nowcoder plans dispatch one child at a time and release the next from terminal handling. Terminalize queued siblings with `PLAN_STOPPED_BY_USER`. At dispatch and message ingress, require the fixed-plan parent to remain `running`; otherwise terminalize the child as `STALE_PLAN_RUN` without sink writes. Feed exhausted recovery terminals through durable notices and plan reconciliation before `dispatchQueued()`. In directed terminal handling, call the existing durable cancellation path on `TAB_CLOSED_BY_USER`.

Run: `npm test -- --run tests/unit/jobs.test.ts tests/unit/collectionPlanService.test.ts tests/unit/nowcoderDirectedOwnership.test.ts tests/integration/bridge.test.ts`

Expected: PASS.

- [ ] **Step 7: Write and run failing status visibility tests**

Assert `plans.status` carries `directedRunActive`, and the plans page shows a concise active notice only when true.

Run: `npm test -- --run tests/unit/connection.test.ts tests/unit/sidepanel.test.ts`

Expected: FAIL because plans state does not expose the field.

- [ ] **Step 8: Implement status visibility**

Thread the boolean through existing status calls and render one static notice; do not add a second run state machine or scheduler.

Run: `npm test -- --run tests/unit/connection.test.ts tests/unit/sidepanel.test.ts`

Expected: PASS.

- [ ] **Step 9: Bump patch version and refresh lockfile**

Update every location required by `CLAUDE.md` from `0.4.33` to `0.4.34`, then run `npm install --package-lock-only`.

- [ ] **Step 10: Run focused and full verification**

Run focused changed-area tests with one worker:

`npx vitest run tests/unit/background.test.ts tests/unit/jobs.test.ts tests/unit/collectionPlanService.test.ts tests/unit/nowcoderDirectedOwnership.test.ts tests/integration/bridge.test.ts tests/unit/connection.test.ts tests/unit/sidepanel.test.ts tests/unit/identity.test.ts --maxWorkers=1`

Expected: all focused tests pass.

Run: `npm run typecheck && npm test && npm run package && npm run test:e2e`

Expected: all commands exit 0.

- [ ] **Step 11: Commit**

Commit all implementation, test, version, lockfile, and plan adjustments as:

`fix: stop nowcoder tab recovery loops`

- [ ] **Step 12: Reinstall and validate live safety**

Reinstall/start the packaged Bridge and reload the unpacked Edge Beta extension through the repository's existing update flow. Verify the legacy batch becomes terminal/attention, Bridge is healthy, Edge contains no Data Collector-owned Nowcoder tab, and it remains absent across a reconnect observation window.
