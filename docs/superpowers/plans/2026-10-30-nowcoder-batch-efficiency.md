# Nowcoder Batch Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. User already approved implementation, release and five live comments; proceed within that scope.

**Goal:** Ship deterministic plugin batches, actionable context checks and reproducible measurements, then compare five live comments with the previous run.

**Architecture:** A durable Bridge coordinator wraps the existing authenticated operations and configured collection queue. CLI waits and emits a compact private artifact reference; model judgment runs against the prepared packet. Existing single-comment store remains authoritative for publication idempotency.

**Tech Stack:** Existing TypeScript/Node22/Zod/extension, Vitest and existing E2E harness. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-30-nowcoder-batch-efficiency-design.md`

## Global Constraints

- Work on existing master; no branch/worktree, no unrelated edits, no credential export.
- One final code commit bumps 0.4.59 to 0.4.60 in all required version locations and lockfile.
- No extra model service, browser scraping fallback, inbox delivery or automatic send retry.
- Exact source/body/comment/revision bindings, dispatching journal, explicit --send and observed receipt remain authoritative.
- Workflow busy covers entire asynchronous run and its gaps. Login/verification/restriction stops and preserves context.
- Up to3 queries, 8 prepare candidates, 5 publish items, 3 pages; unknown likes/total remain unknown.
- Runtime/model usage metric windows are explicit; development/release excluded from production comparison.

## Review Focus

- Two workflow starters race on the same/different key: only one sender and a durable prior result.
- A fresh CLI reconnects after partial send or Bridge crash: never repeats an uncertain item.
- Comments arrive after a header/child expand placeholder: no silent partial baseline labelled complete.
- User modifies a draft or refreshes context during a batch: stale binding stops before clicking.
- Multi-session usage logs contain duplicate events/malformed counters: no double count or silent zero substitution.

### Task 1: Optimized workflow implementation and evidence

**Files:**
- Create `packages/bridge/src/operations/workflow.ts`, `workflowStore.ts` and focused schemas/helpers as justified.
- Modify `packages/bridge/src/server/index.ts`, `packages/bridge/src/operations/cli.ts`, `activity.ts`, shared conversation result schema and extension page reader.
- Create `scripts/codex-run-usage.mjs` and a unit-testable helper if needed.
- Modify delivery references/docs and create a compact production runbook.
- Tests: focused workflow/CLI/integration/page/usage unit tests and existing E2E fixture coverage.

**Interfaces:**
- Consumes existing NowcoderOperationsStore, Activity, job queue and transport. Do not duplicate sender/collector.
- Produces `ops workflow --file [--send] [--wait]`, `ops stats --id`, private result packets, contextual change details and offline usage CLI exactly as the spec.
- Actual internal class/function names are builder decisions; document them in the completion report for release/operator tasks.

- [x] Read spec, relevant server/job routes and existing operations tests; record implementation decisions in this plan's private ledger.
- [x] Write tests that fail for missing batch search/prepare/publish, duplicate key / changed manifest, stale/duplicate items, no --send, failed-item stop, restart/uncertain, busy fencing, delayed empty/child readiness and structured diff. Run focused tests; expect RED for the new behavior.
- [x] Implement the smallest compatible coordinator/CLI/reader changes; preserve existing per-item safeguards and precise collection evidence. Add further RED→GREEN tests for exposed races.
- [x] Write usage fixtures for two sessions, duplicate response IDs, exact from/to, reasoning subset, missing/invalid fields. Run RED; implement streaming aggregation; run GREEN.
- [x] Run focused tests and typecheck to GREEN. Record commands, counts, failure diagnostics and private packet format. Do not commit, push, publish or make live comments; the parent performs one final versioned integration commit after global checks.

### Task 2: Review, verify and release v0.4.60

**Files:** version metadata/lockfile, release artifact and private execution evidence.

**Interfaces:** Consumes Task1 command contracts and tests. Produces a stable GitHub release, CI success and matching live Bridge/extension build ID.

- [x] Fresh reviewer checks Task1 diff against spec and all Review Focus cases; fix important findings with RED→GREEN tests.
- [x] Bump all required metadata to0.4.60 and lockfile. Run typecheck, all unit/integration tests, package and E2E; inspect real results.
- [ ] Commit and push master only after checks; rebuild exact clean commit, verify archive manifest/build/digest, publish GitHub release and verify exact CI head success.
- [ ] Update/restart matching idle Bridge through established CLI, verify extension connection and exact artifact/Bridge/extension build identity. No user-page refresh or forbidden extension URL access.

### Task 3: Five-comment benchmark through released commands

**Files:** Resource repo ignored `_inbox/_reports/nowcoder-optimized-five-<date>/` only; private workflow store.

**Interfaces:** Consumes Task2 runtime. Uses a fresh isolated operator under subagent-driven execution, reading only the short runbook, required quality references and this batch's actual packets.

- [ ] Mark benchmark start before operator instruction/first search. Record parent/operator session paths and begin usage window.
- [ ] Plugin workflow search, choose useful new opportunities, prepare actual sources/comments. Record skip reasons and important image limitations.
- [ ] Draft five contextual primary replies; retain original source anchors and evidence. Parent reviews the packet and five drafts before publication; user already authorized sending.
- [ ] Explicit workflow publish; inspect every observed unique receipt, handle attention with existing stop/verify rules. Count exactly five new comments, then stop.

### Task 4: Comparison and delivery

**Interfaces:** Consumes all Task3 session paths, start marker and fifth receipt time, plus prior run audit/raw session.

- [ ] Aggregate prior and new usages with the same selection→fifth-receipt boundaries; include all participating parent/operator responses, cached/uncached/output and response counts.
- [ ] Report release/CI, five exact comment texts/links and measured before/after times/tokens; show development/release elapsed separately. Label snapshot boundaries and unmeasured quality/conversion honestly.

## Execution notes

The one integration code commit is deliberate: the repository patch-bump and full pre-commit check contract applies once to the complete feature. Task1 working diff will be packaged to a private review artifact; original files and commit base remain intact. The prior user approval covers this implementation method and normal master/release actions; no new user confirmation is needed.
