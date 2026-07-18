# Edge Side Panel Reviewer Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four final reviewer findings around stale authorization, job-state races, current-page duplicate dispatch, and replacement reconnect ping-pong.

**Architecture:** Keep the existing generation-aware connection and job-transition channels as the single persistence authority. Treat a rejected stored-token socket as a delayed re-bootstrap event, distinguish the shared application-level replacement close from ordinary failures, and let extension-originated current-page jobs advance directly from queued to collecting while retaining reconnect recovery.

**Tech Stack:** TypeScript 7, Vitest 4, `ws`, Chrome Extension Manifest V3, Puppeteer Core.

## Global Constraints

- Preserve the exact fixed extension ID and exact trusted Origins.
- Preserve bearer authentication for protected HTTP routes and `0600` authentication/job files.
- Preserve Side Panel delivery, version `0.2.0`, and the absence of pairing/popup flows.
- Add no dependencies.
- Use `/Users/chenhao/.nvm/versions/node/v22.22.3/bin/node` and its adjacent npm.

---

### Task 1: Stored-token rejection falls back through health and one bootstrap

**Files:**
- Modify: `tests/unit/connection.test.ts`
- Modify: `packages/extension/src/background/connection.ts`
- Modify: `packages/extension/src/background/index.ts`

**Interfaces:**
- Consumes: `BridgeConnection.start()`, the existing reconnect timer, and `chrome.storage.local`.
- Produces: `ExtensionStorage.remove(keys)` and a stored-token invalidation path that runs before `markDisconnected()`.

- [ ] **Step 1: Write failing stale-token tests**

Add deterministic cases that open an authenticated URL, close before `extension.hello`, assert `bridgeToken` removal and one scheduled retry, invoke that retry, then assert `/health`, bootstrap authorization, token persistence, and `extension.hello`. Add a mismatch variant ending in `identity_error` with no second timer, plus a bootstrap-socket failure variant proving one delayed retry and no token-removal loop.

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- tests/unit/connection.test.ts
```

Expected: stale `bridgeToken` remains present and the retry creates another token-authenticated socket instead of checking health.

- [ ] **Step 3: Implement minimal invalidation**

Extend storage with:

```ts
remove(keys: string | string[]): Promise<void>;
```

For a non-bootstrap socket that disconnects before its announcement commits, serialize removal of `bridgeToken`, then call the existing disconnected/backoff transition. Do not immediately recurse and do not invalidate a bootstrap socket.

- [ ] **Step 4: Verify GREEN**

Run the focused connection tests and typecheck the extension.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/connection.test.ts packages/extension/src/background/connection.ts packages/extension/src/background/index.ts
git commit -m "fix: recover from rejected stored bridge tokens"
```

### Task 2: All outgoing job snapshots use the reconciliation channel

**Files:**
- Modify: `tests/unit/connection.test.ts`
- Modify: `packages/extension/src/background/connection.ts`

**Interfaces:**
- Consumes: `transitionJob(generation, isCurrent, values)`.
- Produces: reconciled queued/collecting/organizing/error snapshots without changing synchronous socket-send failure behavior.

- [ ] **Step 1: Write failing deferred-storage tests**

Pause an outgoing `organizing` write, accept `job.saved`, release the old write, and require the final ID/status/URL/path to remain saved. Repeat with a paused `queued` write followed by collecting and saved. Assert a failed synchronous `send()` performs no job-state write.

- [ ] **Step 2: Verify RED**

Run the named connection tests. Expected: the released direct write overwrites the saved status with `organizing` or `queued`.

- [ ] **Step 3: Route local state through `transitionJob`**

After a successful `socket.send`, capture the current socket/generation and call `transitionJob`. After a successful job POST, persist queued state through the same channel and await it before returning the job ID.

- [ ] **Step 4: Verify GREEN and commit**

```bash
npm test -- tests/unit/connection.test.ts
git add tests/unit/connection.test.ts packages/extension/src/background/connection.ts
git commit -m "fix: reconcile outgoing extension job state"
```

### Task 3: Current-page extension jobs are not immediately redispatched

**Files:**
- Modify: `tests/integration/bridge.test.ts`
- Modify: `tests/unit/jobs.test.ts`
- Modify: `tests/e2e/extension.test.ts`
- Modify: `packages/bridge/src/server/index.ts`
- Modify: `packages/bridge/src/jobs/store.ts`

**Interfaces:**
- Consumes: `requestedBy`, `dispatchQueued()`, `job.progress`, and `job.result`.
- Produces: direct `queued -> collecting` for an extension current-page runner; unchanged immediate dispatch for CLI/Codex; queued extension recovery on reconnect.

- [ ] **Step 1: Write failing Bridge tests**

Create an extension-requested job on a ready socket and assert no immediate `job.collect`. Send progress/result and require `saved`. Create another extension job, disconnect before progress, reconnect/hello, and require `job.collect`. Preserve the existing Codex/CLI dispatch assertions.

- [ ] **Step 2: Verify RED**

Run the Bridge integration and job-store unit tests. Expected: extension creation emits `job.collect`, and direct progress cannot legally transition the queued job to collecting.

- [ ] **Step 3: Implement requester-aware dispatch**

Use:

```ts
if (job.requestedBy !== 'extension') await dispatch(job);
```

Allow `queued -> collecting` in the durable state machine and only apply it to queued extension jobs in the socket handler. Leave `dispatchQueued()` requester-agnostic so reconnect recovery can pick up abandoned current-page jobs.

- [ ] **Step 4: Strengthen E2E before production acceptance**

Drive the actual category/tags inputs and save button, observe page targets to prove no second article tab was created, and assert the chosen category/tags in Markdown plus one catalog entry.

- [ ] **Step 5: Verify GREEN and commit**

```bash
npm test -- tests/unit/jobs.test.ts tests/integration/bridge.test.ts
npm run test:e2e
git add tests/integration/bridge.test.ts tests/unit/jobs.test.ts tests/e2e/extension.test.ts packages/bridge/src/server/index.ts packages/bridge/src/jobs/store.ts
git commit -m "fix: keep current-page collection on its active tab"
```

### Task 4: Replacement is an explicit standby state

**Files:**
- Modify: `tests/unit/connection.test.ts`
- Modify: `tests/integration/bridge.test.ts`
- Modify: `tests/unit/sidepanel.test.ts`
- Modify: `packages/shared/src/protocol.ts`
- Modify: `packages/bridge/src/server/index.ts`
- Modify: `packages/extension/src/background/connection.ts`
- Modify: `packages/extension/src/background/index.ts`
- Modify: `packages/extension/src/sidepanel/state.ts`
- Modify: `packages/extension/src/sidepanel/index.html`

**Interfaces:**
- Produces: shared close code `4009`, reason `replaced`, persisted `bridgeStatus: 'replaced'`, automatic-start suppression, and `BridgeConnection.retry()`.

- [ ] **Step 1: Write failing replacement tests**

Connect two real peers and require A to close with code `4009`/reason `replaced` while B remains usable. In connection units, emit that close and require no timer, no socket on automatic `start()`, and a new socket on manual `retry()`. In Side Panel units, require the dedicated Chinese message `另一个浏览器实例已接管` and retry action.

- [ ] **Step 2: Verify RED**

Run the focused connection, Side Panel, and Bridge integration tests. Expected: Bridge emits `1012`, extension schedules reconnect, and UI maps the state to service offline.

- [ ] **Step 3: Implement shared replacement semantics**

Export:

```ts
export const EXTENSION_REPLACED_CLOSE_CODE = 4009;
export const EXTENSION_REPLACED_CLOSE_REASON = 'replaced';
```

Persist `replaced` without `markDisconnected()`, cancel timers, suppress automatic starts based on both memory and stored status, and let `retry()` force a new attempt. Wire the background retry message to `connection.retry()` and add the dedicated Side Panel panel/copy.

- [ ] **Step 4: Verify GREEN and commit**

Run focused tests and commit the protocol, Bridge, extension, and UI changes.

### Task 5: Documentation, release artifacts, and complete verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-19-edge-sidepanel-auto-auth-design.md`
- Modify: `docs/protocol.md`
- Modify: `docs/testing.md`
- Modify: `docs/product.md`
- Modify: `README.md`
- Create: `.superpowers/sdd/final-fixes-report.md`

- [ ] **Step 1: Document the revised state machines**

Describe stale-token delayed bootstrap, current-page `queued -> collecting`, reconnect dispatch of abandoned extension jobs, close `4009/replaced`, standby behavior, and explicit retry.

- [ ] **Step 2: Run focused and complete verification**

Run the task-required command sequence, `git diff --check`, temp-directory before/after scans, live pairing scan, stable/ZIP six-file inspection, fixed-ID derivation, auth mode verification, and two-run ZIP SHA-256 comparison.

- [ ] **Step 3: Write the report and final commit**

Record root cause, exact RED/GREEN evidence, commits, verification output, artifact hash/contents/ID, and remaining concerns in `.superpowers/sdd/final-fixes-report.md`, then commit all documentation and generated release artifacts intentionally.
