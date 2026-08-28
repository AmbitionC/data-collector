# Delivery Idempotency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent unchanged recaptures from creating duplicate repository inbox commits while preserving legitimate redelivery.

**Architecture:** Derive a stable semantic delivery revision from each organized document, persist it in the local catalog, and preserve delivery receipts across unchanged recaptures. Automatic ZSXQ plan syncs short-circuit already-delivered matching revisions; explicit manual sync remains an intentional redelivery path.

**Tech Stack:** TypeScript 7, Node.js 22, Vitest 4, Manifest V3 extension build.

**Spec:** `docs/superpowers/specs/2026-08-29-delivery-idempotency-design.md`

## Global Constraints

- Do not rewrite existing `life-teachers` Git history.
- Ignore `collectedAt`, capture/delivery batch IDs, plan IDs, and completeness build IDs in semantic revisions.
- Preserve explicit manual sync behavior.
- Use failing regression tests before every production behavior change.
- Work on and push `master`, as explicitly requested by the user.

---

### Task 1: Stable delivery revision and receipt preservation

**Files:**
- Create: `packages/bridge/src/library/deliveryRevision.ts`
- Modify: `packages/bridge/src/library/writer.ts`
- Test: `tests/unit/library.test.ts`

**Interfaces:**
- Produces: `deliveryRevision(input: OrganizedDocument): string`
- Produces: optional `deliveryRevision` on catalog entries.
- Preserves: existing `sync` and `deliveryBatchId` only when the old and new semantic revisions match.

- [ ] **Step 1: Write failing tests**

Add tests that save an entry, mark it synced, then recapture it with only new `collectedAt`, `batchId`,
and `contentCompletenessBuildId`. Assert that `sync.state` remains `synced`, the receipt fields remain,
and a stable `deliveryRevision` is present. Add a second test that changes正文 and asserts `pending`.

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test -- tests/unit/library.test.ts`

Expected: unchanged recapture reports `pending` instead of `synced` and lacks `deliveryRevision`.

- [ ] **Step 3: Implement the semantic revision**

Create a stable, recursively key-sorted SHA-256 payload covering rendered正文, content fingerprint,
title, author, questioner, source, kind, canonical URL, published time, images, category, tags, summary,
truncation, FE Journey metadata, and non-volatile source metadata. In `MarkdownLibrary.saveNow`, derive
the existing revision from `source.json` for migration, compare it with the incoming revision, and build
the next catalog entry with either the preserved receipt or `{ state: 'pending' }`.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npm test -- tests/unit/library.test.ts`

Expected: all library tests pass.

### Task 2: Automatic plan idempotency

**Files:**
- Modify: `packages/bridge/src/library/sync.ts`
- Modify: `packages/bridge/src/server/index.ts`
- Test: `tests/integration/pipeline.test.ts`

**Interfaces:**
- Extends: `SyncEntriesOptions` with `skipDelivered?: boolean`.
- Behavior: when enabled, an entry with `deliveryRevision`, a reliably delivered receipt, and the same
  sink target returns the existing successful receipt without calling `sink.save`.

- [ ] **Step 1: Write failing integration test**

Use a real temporary Markdown library and a counting in-process sink. Execute first save + automatic
sync, recapture the same semantic content with new transport metadata, then execute automatic sync again.
Assert two sync outcomes but exactly one sink save. Also assert a正文 change produces a second sink save.

- [ ] **Step 2: Run test to verify RED**

Run: `npm test -- tests/integration/pipeline.test.ts`

Expected: the sink save count is 2 for unchanged recapture.

- [ ] **Step 3: Implement and wire the short-circuit**

Add the guarded short-circuit to `syncEntries`. In the server's ZSXQ fixed-plan `syncJob` call, pass
`{ skipDelivered: true }`; leave explicit API sync and Nowcoder delivery-batch calls unchanged.

- [ ] **Step 4: Run test to verify GREEN**

Run: `npm test -- tests/integration/pipeline.test.ts`

Expected: all pipeline tests pass and the unchanged second round does not invoke the sink.

### Task 3: Release and verification

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/shared/package.json`
- Modify: `packages/shared/src/identity.ts`
- Modify: `packages/bridge/package.json`
- Modify: `packages/extension/package.json`
- Modify: `packages/extension/manifest.json`
- Modify: `tests/unit/identity.test.ts`

**Interfaces:**
- Produces: extension and bridge version `0.4.31`.

- [ ] **Step 1: Bump synchronized versions to 0.4.31**

Update every package/manifest version and internal workspace dependency version together.

- [ ] **Step 2: Run complete verification**

Run: `npm test && npm run typecheck && npm run build && npm run smoke:delivery && npm run package`

Expected: every command exits 0 and the package archive is `data-collector-extension-0.4.31.zip`.

- [ ] **Step 3: Commit and push master**

Commit only scoped files with message `fix: make repository delivery idempotent`, push `origin master`,
and verify `git rev-parse HEAD` equals `git rev-parse origin/master`.

- [ ] **Step 4: Install and verify runtime update**

Run `npm run setup`, then verify bridge health reports version `0.4.31` and the Edge Beta extension
connects with the exact new commit build ID. Confirm the target repositories remain clean.
