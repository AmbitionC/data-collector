# Nowcoder Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan inline, task by task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Keep the authorized comment campaign scheduled through ordinary failures while preserving one-attempt publication and human verification boundaries.

**Architecture:** Fix publishing snapshots to use one clock sample. Add an authenticated, read-only recovery advisor and a CLI command that reports readiness and bounded backoff; the existing heartbeat owns scheduling and fresh editorial review. No recovery request opens a site page or publishes anything.

**Tech Stack:** Existing TypeScript, Node 22, Zod, Vitest and Bridge HTTP APIs; no new dependency.

**Spec:** `docs/nowcoder-operations.md`, existing publishing contracts and the behavior agreement below, based on the user's latest request.

## Behavior agreement

- An advancing clock must not produce a fictitious future publishing interval.
- Recovery reports `ready`, `waiting`, or `needs_user`, a reason code and the next check time.
- Temporary busy/update/disconnection/build mismatch uses 5, 15, then at most 30 minutes between checks. Real quota waits use the actual ledger time.
- Verification remains an explicit human handoff. The scheduled task stays active as a read-only monitor; no automatic challenge completion, pause clearance or account rotation.
- Old failed runs stay failed/stopped. Uncertain or interrupted publications use the original key for read-only verification; never compensate with another key.
- Keep comments at 120000ms minimum, five per rolling hour, twenty per rolling day; keep campaign cadence 510000ms and the 08:00–22:00 window.
- The recovery command rejects send/configuration flags and returns structured waiting information when the local Bridge is unavailable.

## Global Constraints

- Work on the existing clean `master`, per this repository's explicit delivery preference.
- Publish one patch release, 0.4.68, after required checks and one independent final review.
- Private operational evidence and state stay outside public Git.
- Preserve the separate Chrome article schedule and both browser role bindings.
- All automatic operations remain subject to account, context, quota and verification guards.

## Review Focus

- A clock crossing a millisecond or rolling-day boundary must yield a coherent snapshot.
- Recovery must remain read-only when a verification or a corrupt publishing journal exists.
- Ready transport must not be reported during collection, updates or artifact mismatch.
- CLI outages and invalid flags must not issue any publishing or resume request.
- Scheduler continuity must not replay stopped runs or restart uncertain comments.

### Task 1: Correct publishing time snapshots

**Files:** `packages/bridge/src/operations/publishingControl.ts`, `tests/unit/nowcoderPublishingControl.test.ts`.

**Interfaces:** Existing `status()`, `assertCapacity()` and `articleStatus()` remain unchanged; calculate each status with a single sampled timestamp.

- [x] Add regressions: with a clock advancing by 1ms, an empty comment history has `nextAllowedAt === null` and admission succeeds. At the article rolling-day boundary, usage is evaluated at the same timestamp as readiness.
- [x] Run these tests against the old implementation; expect the false interval rejection and inconsistent article usage to fail.
- [x] Pass the sampled timestamp into the internal interval calculation; retain actual interval, quota and backwards-clock protection.
- [x] Run the full publishing-control test file; expect all tests to pass.

### Task 2: Read-only recovery advisor and CLI

**Files:** new `packages/bridge/src/operations/recovery.ts`; modify `packages/bridge/src/server/index.ts`, `packages/bridge/src/operations/cli.ts`; new unit/CLI tests and additions to `tests/integration/nowcoderOperations.test.ts`.

**Interfaces:** Authenticated `GET /v1/nowcoder/operations/recovery?attempt=0`; `nowcoder ops recovery [--attempt N]`; pure advisor consumes current publishing status and transport readiness. Output has `schemaVersion`, `status`, `code`, `message`, `nextCheckAt`, `canPrepareNewWork`, `requiresUser`, and the current verification when present. It never grants direct publication or clears verification.

- [x] Add failing tests for ready, temporary busy/update/disconnected/build mismatch, real quota time, verification, corrupt state, authenticated routing, CLI offline output, and rejected send/resume flags.
- [x] Implement the smallest advisor and authenticated route using real transport/job/update guards.
- [x] Implement CLI recovery output and outage backoff without adding a publishing side effect.
- [x] Run advisor, CLI and authenticated API tests; expect all passing and no browser action from recovery requests.

### Task 3: Deliver and restore scheduled operations

**Files:** version files required by `CLAUDE.md`, operations/runbook documentation; private comment prompt/state and existing `08-00-22-00` automation.

- [x] Document active waiting/monitoring, 5/15/30 minute backoff, quota scheduling, original-key verification and human challenge handoff.
- [x] Bump all required version references and lockfile to 0.4.68.
- [x] Run typecheck, full tests and package; perform the independent final review and address meaningful findings.
- [ ] Commit/push the one release; verify installed Bridge and both extension build IDs match the artifact.
- [ ] Update the existing comment automation and private state, keeping the original failed run and uncertain entries intact. Verify a fresh suitable single-comment operation if the current window/guards allow it; otherwise schedule its real next window.
- [ ] Report the released version, recovery behavior, remaining human verification boundary and actual restored scheduling state.
