# ZSXQ date-range backfill implementation plan

> **For agentic workers:** Execute inline using superpowers:executing-plans. Preserve the repository's master-only convention and the user's instruction to proceed without approval checkpoints.

**Goal:** Collect the owner's relevant September posts through the existing extension and deliver only new, complete bodies to the inbox.

**Architecture:** Add an explicit, persisted `zsxqDateRange: { since, until }` to the fixed plan. In this mode the extension pages signed latest/digest/owner feeds to the Shanghai date boundary instead of stopping after 20 candidates. Keep discovery dates separate from owner-ledger target dates so complete ledger history and today's unfinished day are not rewritten.

**Tech Stack:** Existing TypeScript, Zod, Vitest, Chromium extension, local Bridge.

**Spec:** User request dated 2026-09-09; this document records its bounded design.

## Global constraints

- No schedules or auto-update jobs are re-enabled.
- Existing filters, author proof, complete-body proof, and pre-detail exact/semantic deduplication remain mandatory.
- At most 31 inclusive Shanghai days; reject future, reversed, invalid, or history-mode ranges.
- Preserve cursor/order, payload, and page safety failures; never truncate to claim success.
- No page reload of user-owned tabs; no extension-internal UI access.

### Task 1: Date-bounded feed collection

Files: `packages/extension/src/zsxqApiFallback.ts`, `tests/unit/zsxq-api-fallback.test.ts`.

- [x] Write and run a failing test: a first page of 20 September 8 posts followed by September 1 and August 31 yields 21 September documents, requests page 2, excludes August and proves every view boundary.
- [x] Validate the shared range schema; for explicit ranges use Shanghai midnight cutoff and next-day exclusive end, no 20-document stop or final slice. Record per-view fetched-page and crossed-range proof in coverage.
- [x] Run existing API tests plus the regression and invalid-range cases; include overlapping timestamp-boundary proof.

### Task 2: Fixed-plan transport and early deduplication

Files: shared plans/protocol; Bridge CLI, server, plan service/store; extension connection/index/jobs/content; background and CLI integration tests.

- [x] Test exact persisted and dispatched range from `plans run zsxq-chen-teacher --since 2026-09-01 --until 2026-09-09`.
- [x] Test range mode bypasses bounded DOM extraction, passes the range to signed API collection and skips known complete September documents before detail jobs even when ledger target days are empty; include owner-only candidates.
- [x] Carry the optional range through all existing layers, keeping default daily-ledger behavior unchanged. Copy API business-skip details into the phase audit.
- [x] Run focused tests and typecheck.

### Task 3: Release and live acceptance

- [x] Document the CLI range and bump 0.4.37 to 0.4.38 in all prescribed locations; update lockfile.
- Verification: full suite 76 files / 1,497 tests passed with two workers; browser E2E 4/4 passed; independent review's two important boundary issues fixed and regression tested. Default full-suite concurrency produced timeout-sensitive failures, so final verification used bounded concurrency.
- [ ] Run `npm run typecheck`, `npm test`, `npm run package`, `npm run test:e2e`; inspect diff.
- [ ] Commit and push scoped code; package again for the clean commit build stamp. Restart only the temporary manual Bridge and verify connected extension/build identity.
- [ ] Run explicit September range; accept only the exact completed batch with no failures, per-view boundary proof and matched inbox IDs. Run the same range once more to verify no duplicate deliveries.
- [ ] Verify target master is clean/pushed and no current-day ledger finalization. Stop the temporary Bridge, preserving the user's paused schedulers.
