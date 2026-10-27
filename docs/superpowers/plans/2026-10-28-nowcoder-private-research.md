# Nowcoder Private Research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the authorized private Nowcoder user research without weakening interview publication checks.

**Architecture:** Reuse the existing JSON latest-search adapter and extension-backed detail jobs. A separate CLI orchestrator freezes an exact private research manifest, snapshots each returned local document, and never invokes delivery or synchronization. It accepts an original hot-material export or a separately typed, fresh public DOM observation, retaining original input bytes. Directed interview search retains its source-history gate and reports history failures accurately.

**Tech Stack:** TypeScript, Node 22, existing Data Collector Bridge and extension, Vitest.

**Spec:** User authorization on 2026-10-28 to repair search, add private research collection, and complete the original report; existing `docs/nowcoder-hot-materials.md` supplies the hot-observation contract.

## Global Constraints

- Work in the clean master checkout per CLAUDE.md; preserve the historical failed preview.
- No publication, repository inbox delivery, external model uploads, credential export, or invented URLs.
- Keep strict interview history checks. Research is explicitly a separate purpose with no public inventory dependency.
- Reuse the official latest-search adapter and the connected extension for details; stop on authentication or systemic collection failures.
- Keep a frozen run manifest, raw discovery diagnostics, job IDs, exact document snapshots, hashes, and shortfall status. Reusing a key must not repeat submissions.
- Observe up to 30 latest and 20 complaint discussions in the preceding 7 days, deduplicate across strata, and preserve the actual accessible hot-list scope.

## Review Focus

- A configured invalid interview history must retain its specific error, without running external discovery.
- Replayed keys or interrupted manifests must not submit duplicate jobs.
- Old or future publication dates must not count as latest samples.
- Returned document URL and output paths must match the requested job and stay inside the library.
- Login walls, disconnected extensions, unfinished jobs, and insufficient samples must never become a completed report batch.

### Task 1 Search diagnostics and private research orchestration

**Files:** Modify `packages/bridge/src/nowcoderDirected/sessionController.ts`, `packages/bridge/src/cli.ts`; create `packages/bridge/src/nowcoderResearch.ts`; test `tests/unit/nowcoderResearch.test.ts` and `tests/unit/nowcoderDirectedSessionController.test.ts`.

**Interfaces:** `parseResearchArgs(args)` validates the private grammar and the existing CLI authenticates only in memory; `runPrivateNowcoderResearch(spec, dependencies)` produces one persistent research manifest and isolated evidence snapshots. The CLI emits one JSON stdout object and progress only to stderr.

- [x] Add a regression test for a corrupt configured publication history preserving `DIRECTED_HISTORY_CORRUPT`, and observe failure.
- [x] Add research tests for date/URL validation, exact local-only detail payloads, persisted success and replay, and a failed detail preserving a stopped manifest; observe failure.
- [x] Implement the separate bounded research command and accurate diagnostic propagation.
- [x] Run targeted tests, typecheck, the repository suite and package validation. Do not add extension permissions. Final validation: 89 files / 1807 tests and 6 extension E2E tests passed; reviewer findings closed.
- [x] Bump all required version fields to 0.4.50 and prepare the reviewed master commit. Record the resulting commit and final artifact verification in the private execution ledger.

### Task 2 Exact private collection and research delivery

**Files:** Update `docs/nowcoder-hot-materials.md`, `.codex/skills/data-collector-delivery/references/operation-candidates.md`; private output only under the resource repository `_inbox/_reports/`.

**Interfaces:** The existing hot-material UI exports original `CollectedDocument` snapshots; alternatively, the CLI accepts an explicitly typed public DOM observation, never pretending it is a plugin export. Successful detail jobs supply source snapshots for analysis.

- [x] Obtain the current public hot-list observation; retain scope and unknown metrics. Privileged extension UI navigation was denied, so it was not retried through another surface. Public HTTPS observation supplied 20 real links; configured Data Collector jobs captured all details.
- [x] Start a fresh persisted research key; collect and verify the exact manifest before consuming evidence. Completed run `nowcoder-research-5775c46b9df71865af30`: 70 saved, 0 failed, 0 delivered. Failed earlier runs remain unchanged and unused.
- [x] Analyze recurring tasks, alternatives, counterexamples, relevance and willingness-to-act signals; retain original links. All 70 accessible text bodies read; 69 normalized bodies, manual primary classes and explicit limitations retained.
- [x] Deliver a private report, source appendix and JSON manifest with priorities, small experiments and stopping conditions; distinguish observations from inference. Output: resource repository `_inbox/_reports/operation-topics-2026-10-28.{md,json}` plus a private evidence folder. No publication or report/raw-data push.
