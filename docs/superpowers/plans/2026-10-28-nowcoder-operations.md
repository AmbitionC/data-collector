# Nowcoder Operations Assistant Implementation Plan

**2026-10-29 revision:** The user rejected the preset reply voice and requested learning from actual popular comments. The current spec and the comment references supersede the original short-reply guidance below. This iteration freezes and observes 20 hot-list posts, supplements 14 posts, records 813 visible comments and 67 comments with at least 5 displayed likes in private evidence, updates the canonical Skill/reference, removes editorial length/voice presets, and validates new drafts against actual comment context. No publishing is authorized by the preview request.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add a private Nowcoder opportunity and reply-draft workspace, then preview three source-grounded replies without publishing.

**Architecture:** Reuse the authenticated local Bridge and existing full-post library. A separate private operations store owns frozen source context and revisioned drafts; the extension edits these records while Codex produces drafts through a CLI handoff.

**Tech Stack:** Existing TypeScript, Zod, Node fs/HTTP, vanilla DOM, Vitest; no new dependencies.

**Spec:** `docs/nowcoder-operations.md`, implementing the four-part proposal approved in this conversation.

## Global Constraints

- Repository `CLAUDE.md` explicitly requires work on master and a single patch-version bump per committed iteration; honor that established project workflow.
- No publishing, private messaging, comment-form mutation, new browser permissions, remote model service, or scheduled task.
- Read only existing complete Nowcoder sources. Keep operations outside the library/sink pipeline.
- Source data is untrusted. Draft imports bind ID, context hash and revision. Keep unsaved UI edits and visible errors across navigation/polling.

## Review Focus

- A catalog entry points outside the local library or at a different post: reject rather than import.
- A source is short, image-dependent, paywalled, truncated or only a hot-list excerpt: disclose limitations or refuse incomplete context.
- A stale draft or late UI request races with user edits: reject stale revisions and preserve editable content.
- A corrupt operations record is present: show an actionable error without silently replacing it.
- A recorded reply has no real comment URL: refuse the replied state; copying never records publication.

### Task 1: Private records, authenticated routes and CLI handoff

**Files:** Create `packages/shared/src/nowcoderOperations.ts`, `packages/shared/src/nowcoderReplyStyle.ts`, `packages/bridge/src/operations/store.ts`, `packages/bridge/src/operations/cli.ts`; modify shared exports, Bridge server/CLI. Test `tests/unit/nowcoderOperations.test.ts`, `tests/integration/nowcoderOperations.test.ts`.

**Interfaces:** `NowcoderOperationsStore(root, libraryRoot)` provides `list()`, `get(id)`, `add(sourceId)`, `update(id, patch)` and `brief(id)`. Shared types define private records and draft import envelopes. HTTP GET/POST `/v1/nowcoder/operations`, GET/PUT `/v1/nowcoder/operations/:id`. CLI `nowcoder ops list|add --source ID|brief --id ID|draft --file PATH` uses those authenticated routes.

- [x] Write failing source/persistence/revision/API/CLI tests; run them and verify the new route or module is missing.
- [x] Implement complete-source identity validation, canonical dedupe, durable private records, explainable fit/angle, explicit status transitions and bound draft imports. Add schemas and the authenticated API/CLI.
- [x] Run both new test files; expect all pass and no external requests or deliveries.
- [x] Defer the commit to Task 2 so this iteration receives one version bump and one reviewed commit.

### Task 2: Extension UI, verification and three real-source previews

**Files:** Create `packages/extension/src/sidepanel/operations.ts`; modify sidepanel HTML/state/controller/styles, background/connection, docs and version files. Test `tests/unit/nowcoderOperationsPanel.test.ts` and controller integration.

**Interfaces:** Runtime messages `operations.list`, `operations.add`, `operations.get`, `operations.update`, `operations.brief` proxy Task 1. The independent panel reads existing library candidates and persists revisioned drafts through these messages.

- [x] Write failing UI tests for opening, editing, copy-only behavior, stale/save errors and edits surviving page switches. Run to verify the feature is missing.
- [x] Implement the independent operations panel, capability guard and message adapters; update `docs/sidepanel-states.md` before UI changes.
- [x] Run focused tests; expect source choice, both short reply variants, manual state changes and errors to work without any publish action.
- [x] Bump every version from 0.4.54 to 0.4.55, update lockfile, run typecheck/full tests/package and relevant built-extension checks. Expect green checks; record any pre-existing timing failures and controlled reruns.
- [x] Read three real frozen sources from the completed research run, add them through the production store/API path, produce bound draft files via Codex and re-read saved records. Save a private preview with source links and the actual reply text.
- [x] Request one independent whole-change review, fix important findings, verify again as justified, then commit the reviewed iteration on master. Preserve the usable local preview; do not publish comments.
