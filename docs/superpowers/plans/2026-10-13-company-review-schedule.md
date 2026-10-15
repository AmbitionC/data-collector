# Cross-company Review-only Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add opt-in daily company-inventory collection that saves an exact review batch locally, with no automatic delivery or publication.

**Architecture:** Extend existing CollectionPlanService and persistent batch/job state. A separate schedule/inventory module selects low-stock companies with persisted equal-stock rotation; a durable review-only marker isolates captures from existing delivery/pending pooling. Processing remains in the resource repository and must produce real skill and quality evidence before publishing.

**Tech Stack:** TypeScript, Node 22, Zod, Vitest, existing Chromium extension and local Markdown library.

**Spec:** `docs/superpowers/specs/2026-10-13-company-review-schedule.md`.

## Global Constraints

- Original checkouts and hot PR1 remain untouched; only this independent branch changes.
- New schedule defaults disabled, daily 09:00 Asia/Shanghai, existing 15-minute Bridge checks; no new manifest permission or extension collection alarm.
- No installation, actual collection, continuous activation, merge, or publication in this task.
- Persist mode before job creation; review-only batches cannot call syncEntries or leak into later pending pooling after restart.
- Inventory uses grounded published plus qualified-pending stock, URL/contentHash/cluster dedupe; unreadable inventory fails closed.
- User has authorized implementation; preserve that method and continue after this plan without requesting redundant approval.

## Review Focus

1. A review-only batch with ten accepted jobs must retain reviewIds and empty deliveryIds across reopen, with no sync mutation.
2. An ordinary run must never pool held review jobs, including catalog marker loss where source.json still holds the marker.
3. Disconnected or sleeping computers must not claim a run was collected; schedule defaults disabled and is changed only by explicit settings save.
4. Equal inventory must rotate durably; missing source identity must not silently count duplicated stock.
5. Captcha/login/429 must stop the batch before dispatching another child; request pacing must survive concurrent calls.

## Task 1: Persist review mode and isolate local evidence

Files: shared `model.ts`/`plans.ts`, Bridge `plans/store.ts`, `plans/service.ts`, `plans/nowcoderHistory.ts`, `library/writer.ts`, `library/sync.ts`.

Interfaces: batch `nowcoderReviewOnly?: true`, `nowcoderCompanies?: CompanyId[]`, `reviewIds?: string[]`; job `nowcoderReviewOnly?: true`; sourceMetadata/catalog `nowcoderReviewOnly: true`. `CollectionPlanStore.finalizeSelection` accepts trailing review IDs without changing legacy callers.

- [x] Add actual RED cases to collectionPlanService/nowcoderHistory and local library tests: ten local review saves cause no delivery, restart retains mode, pending isolation remains.
- [x] Run focused tests and verify assertion failures before production edits.
- [x] Persist batch/job mode before dispatch and enforce source metadata from durable job state.
- [x] Finalize review batches without sync, using exact local IDs:

```ts
if (batch.nowcoderReviewOnly) {
  await store.finalizeSelection(batch.id, accepted.length, coverage, rejections,
    undefined, reclassifiedFailures, [], accepted.map(job => stableContentId(job.url)));
  return;
}
```

- [x] Exclude held sources from generic pending IDs and automatic sync; explicit human sync remains a separate action.
- [x] Commit validated changes with one coordinated version bump; existing service/store/history and new focused tests have passed.

## Task 2: Company inventory and disabled schedule

Files owned by independent module worker: `plans/nowcoderSchedule.ts`, `plans/nowcoderInventory.ts` and their unit tests. Root integration: `config.ts`, `server/index.ts`, `plans/service.ts`, CLI and existing sidepanel plan settings.

Interfaces:

```ts
type NowcoderScheduleConfig = { enabled: boolean; companies: CompanyId[]; reviewOnly: true };
// NowcoderScheduleStore.open(path), settings(), configure(input), prioritize(inventory, companies)
// readCompanyInventory(resourceRoot, libraryRoot, now)
// selectCompanyCandidates(candidates, inventory, order, limit)
```

- [x] Test disabled default, strict company settings, low-stock priority, persisted ties, unknown inventory and dedupe.
- [x] Integrate settings store into runDuePlans; scheduled runs snapshot config into review-only batch state.
- [x] Add authenticated GET/PUT `/v1/plans/nowcoder-schedule`; saving config does not dispatch an immediate run.
- [x] Add explicit `--review-only` manual mode and schedule status/settings controls; show timezone, wake-up limitation and local-only pending result.
- [x] Keep the existing legacy preset/manual delivery behavior for runs without the new review mode.

## Task 3: Rate-limit and challenge stop

Files: focused pacing helper/test, Nowcoder extraction challenge checks, server dispatch/search integration and plan stop tests.

- [x] Add RED for sequential/concurrent pacing and actual visible challenge/429 stop; no source request or detail dispatch follows stop.
- [x] Apply fixed conservative spacing to the new review mode and propagate explicit stop codes into durable parent stop.
- [x] Verify no browser permissions, refresh, login, bypass or automatic activation was introduced.

## Task 4: Verification and reviewable delivery

- [x] Run typecheck, complete unit suite, package, and affected temporary-profile E2E without real capture.
- [x] Independently review durable isolation, retry/recovery boundaries and processing handoff.
- [x] Record full head and local test evidence; draft branches only, never merge or publish.

## Verification notes

- Review-only core: 4 actual RED assertion failures, then GREEN; library isolation 2 RED then GREEN.
- Schedule integration 2 RED then GREEN; HTTP authentication/config persistence 3 GREEN using disposable loopback ports.
- UI/CLI 14 initial RED failures; 296 directly related tests GREEN, including old-poll/save race, stale external draft, company snapshot and disabled cadence.
- Pacing/search/extraction real RED for access-stop and serialization; 120 initial focused GREEN. Detail429/403 follow-up 6 RED then 97 GREEN.
- Fresh independent review found five Important issues and no Critical. Fixes cover source hold inheritance, explicit outside ledger, unavailable-settings guard, detail429 stop and partial-terminal exact review lists. A follow-up exposed benchmark failure clearing a sealed list; one regression failed, then the final five terminal-list cases passed. No completed skill run or reviewer identity is synthesized.
- First full default-concurrency run: 1576/1580, four failures (two15s timeouts and two delayed persistence polls). Four-worker run after initial review fixes: 1598/1599, one15s fsync-heavy directed-fixture timeout. Final complete unit run: 83 files / 1600 tests passed, four workers and a60s framework timeout,143.78s. Typecheck and package passed. E2E: all five cases passed across the unchanged four original cases and the corrected new settings/save case (one test-only helper name fix; focused new case passed6.29s). Assertions are unchanged.
- The App tool call to attach resource draftPR49 returned no confirmation within the bounded wait; the GitHub draft itself is confirmed.

Final preservation: manifest permissions/hosts unchanged, no installation/activation/actual capture. ResourcePR49 CI validate-pr succeeded (publication job skipped for PR events). Collector delivery is draft-only. Final code head and artifact SHA are recorded outside Git in artifacts/verification-company-review-schedule.md.
