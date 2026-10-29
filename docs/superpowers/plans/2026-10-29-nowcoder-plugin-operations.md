# Nowcoder Plugin Operations Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. Follow RED → GREEN per component; use one independent final review.

**Goal:** Let the Agent search, read context and publish a single authorized Nowcoder reply through compact plugin/CLI contracts.

**Architecture:** Reuse JSON discovery and existing authenticated Bridge transport. A bounded extension RPC owns its temporary tab and reads/submits visible DOM. The private operation store fences publication before dispatch and records only observed receipts.

**Tech Stack:** Existing TypeScript, Zod, Chrome extension APIs, WebSocket and Vitest; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-29-nowcoder-plugin-operations-design.md`

## Global Constraints

- Work on master per repository/user instructions; ship one integrated patch version 0.4.58.
- No source-page refresh, credential export, arbitrary browser execution, bulk posting or raw DOM in CLI output.
- Require explicit `--send`, a stored draft/current revision and an idempotency key.
- Persist an attempt before dispatch; uncertain results never trigger another automatic click.
- Keep the two pending live comments unsubmitted until this path is verified.

## Review Focus

- Socket/runtime replacement cannot accept a result from an old connection or redispatch a publication.
- Rich text, child replies and unknown like counts retain their meaning without counting ads or quick-reply suggestions as comments.
- A returned URL must identify an observed new matching comment; a matching pre-existing comment does not prove publication.
- Updaters cannot restart the service/worker during a publication; a crash leaves a durable unresolved attempt.
- Source drift, pending user edits, login/verification and pagination limits must be explicit and must not widen actions.

## Tasks

### Task 1: Typed context and page actions

**Files:** new shared conversation schemas; new extension page/background operations modules; focused page and orchestration tests.

**Interfaces:** Produce `NowcoderOperationAction`, `NowcoderConversationSnapshot` and `NowcoderPublishReceipt`, plus a pure injected page action and a dependency-injected tab runner.

- [x] Write tests for nested comments/author flags/unknown likes, bounded coverage, URL binding, existing drafts, duplicate content, login/verification and exactly one send click; run and observe failures.
- [x] Implement the schemas and self-contained DOM action; keep selectors derived from the already observed Nowcoder pages.
- [x] Add owned-tab orchestration and cleanup/attention behavior; verify focused tests.

### Task 2: Durable Bridge workflow

**Files:** private operations activity/transport modules; operation store/schema extensions; HTTP integration tests.

**Interfaces:** Consume typed extension actions and receipts. Produce compact search/context and revision/key-bound publication methods for HTTP/CLI.

- [x] Test authenticated RPC/capabilities, context persistence, search limits, stale revisions and idempotency/uncertain outcomes before implementation.
- [x] Implement bounded RPC, private context snapshots, publication fencing and actual-receipt state updates.
- [x] Wire routes and active-operation update/restart guards; run focused integration tests.

### Task 3: CLI and real two-comment exercise

**Files:** operations CLI; connection/background wiring; docs/Skill references; version metadata; CLI and end-to-end tests.

**Interfaces:** Expose `ops search`, `ops context`, `ops publish` with compact JSON and existing local authentication.

- [x] Test explicit send authorization, argument validation, concise output and round trip through a mocked connected extension, then implement CLI/wiring.
- [x] Update operational guidance so normal work uses CLI; retain browser interaction for necessary login/verification or developer inspection.
- [x] Run typecheck, full tests, package and E2E; get one fresh final review and fix material findings.
- [ ] Commit/push the integrated version, verify CI/artifacts/runtime, then publish the two already prepared comments via CLI and retain real receipts.

Commit once at the integrated release gate; do not expose partial remote functionality between these coupled tasks.
