# ZSXQ owner comment collection plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan inline, with TDD and one final independent review.

**Goal:** Explicit date-range collection includes readable Chen Teacher comments on the selected posts, preserving their context and exact IDs.

**Architecture:** Use the authenticated extension's existing signed GET transport. Verify the group and parent topic, page the official ascending comments endpoint, select only the verified group owner, then append new comment IDs to the complete stored parent document. Existing article bodies, assets, canonical URLs and stable IDs remain authoritative. Normal daily/history collection remains unchanged in this iteration.

**Recovery amendment:** A live service restart interrupted the baseline run's synchronization. Explicit range runs also re-stage complete stored parents whose local sync state is explicitly pending/failed. A fresh batch proves comment coverage and delivery; old failed batch records remain unchanged. Existing archives are deduplicated by the target Skill. The compact index carries an optional `deliveryPending` fact; normal daily/history behavior remains unchanged.

**Tech Stack:** Existing TypeScript extension, Bridge library reader, Vitest.

**Spec:** The user requested posts and replies since 2026-10-15 and explicitly included ordinary comment threads. A selected parent is in the publication window; read all currently available comments on that parent, including later replies. Do not claim discovery of new comments on older, unselected parents.

## Global Constraints

- Master only; preserve the concurrently modified original checkout. Implement in this separate clean clone.
- No cookie export, browser switching to bypass access failures, guessed comment URLs, or increased safety caps.
- Keep stopped/failed batches unchanged. New runs receive new IDs and exact manifests.
- Retain original body and resources; append only verified, previously unseen owner comment IDs. Preserve earlier saved replies even when the source later deletes them.
- The official web client uses `comments?sort=asc&count=30&with_sticky=true`, then `begin_time` equal to the last root comment's `create_time`; nested `replied_comments` are inline. Counts can include unavailable/deleted replies; record that discrepancy without manufacturing text.

## Review Focus

- Numeric comment IDs exceed JS safe integers: preserve exact decimal strings.
- Wrong group/topic/owner and access errors must fail closed.
- Repeated cursors, conflicting duplicate comments, malformed bodies and resource payloads must never appear complete.
- Stored full longform must survive comment updates byte for byte as a prefix.
- Existing reply IDs must not be delivered twice; member names matching the owner are insufficient identity proof.

### Task 1: Collect and append verified comments

**Files:** `zsxqApiFallback.ts` (signed reader), new `zsxqOwnerComments.ts` (types and append), `contentProtocol.ts`, `content.ts`, `background/jobs.ts`, `background/index.ts`, focused unit tests, README and patch-version files.

**Interfaces:** `collectZsxqApiOwnerComments(groupId, topicId, dependencies): Promise<ZsxqOwnerComments>`; `appendZsxqOwnerComments(document, comments): {document, added}`; `JobRunnerOptions.storedDocument(id): Promise<CollectedDocument>` uses existing authenticated `libraryEntry`.

- [x] Write API and append tests: exact large IDs, owner-ID selection with question context, pagination, duplicate/conflict, denial, wrong parent, malformed media, unchanged stored prefix and repeated-run idempotence.
- [x] Run targeted Vitest and observe the missing-feature failures.
- [x] Implement the signed reader and append helper; wire explicit date-range jobs before complete-document skipping. Count comment parents/pages/owner replies/new replies in batch coverage. Reuse stored documents for updates.
- [x] Add runner tests showing an existing complete article receives its new comment while retaining its canonical identity/body, minute-precision article dates match the exact observed article link, unchanged second runs create no job, member context retains owner delivery eligibility, nested questions survive and pending delivery is re-staged only in explicit ranges.
- [x] Run targeted tests, typecheck, full suite with two workers, package and e2e. Base0.4.49 passed1811/1811 tests and browser e2e6/6. The concurrent task published0.4.50 as52a02b8; this feature was rebased without conflicts and bumped to0.4.51. Merged typecheck,1835/1835 tests, package and browser e2e6/6 all passed before publication.
- [x] Independent review and RED→GREEN fixes: standalone article matching, member ownership, daily-mode regression, nested question context, unique-root diagnostics, retained replies and recovery receipt idempotence. Re-read the current pending state before re-staging from an earlier index snapshot.
- [ ] Commit/push master, verify live extension/Bridge build IDs before using the feature. The concurrent task has published its clean0.4.50 build. Preserve its collection work; use the normal safe update lifecycle for0.4.51.
- [ ] Run two exact weekly date windows, validate manifests/audits, curate only eligible delivered IDs and push target master; retain source counters and exclusions in the receipt.

## Review rulings

- The exact observed article link binds a standalone article to its parent; publication times must agree to the minute because the article page exposes minute precision while the signed topic timestamp includes seconds. Preserve the article's original date and store the parent's full timestamp separately.
- A nested reply exposes a replied-to user but not a unique replied-to comment. Preserve the root and that user's earlier visible questions with their IDs/times rather than guessing which one was answered.
- A stale source reply count can include unavailable/deleted text. Keep a per-unique-root diagnostic discrepancy; never manufacture that text. Previously verified saved owner replies remain recoverable after deletion.
- `deliveryRecovery` and `recoveredFromBatch` are attempt facts, excluded from semantic delivery revisions. A successful sync after the initial index snapshot must prevent an unchanged recovery job.
- Missing/corrupt stored source is a hard failure for recovery, preserving complete bodies rather than replacing them with feed previews. Live delivery/coverage acceptance remains pending; passing tests alone do not complete the user's collection request.
