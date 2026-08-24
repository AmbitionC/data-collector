# Nowcoder Delivery Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut active Nowcoder detail-collection time without lowering evidence quality, reliably fill one exact run with 10 new interview clusters, remove the public interview source section, and publish a measured second batch.

**Architecture:** The Edge extension gains a two-slot priority scheduler for remote detail tabs. The Bridge advances one persisted batch through bounded 8 + 4 target-fill rounds, retries only eligible historical collection failures, and records a metadata-only benchmark. The resource repository keeps private source history for evidence and heat while public interview Markdown no longer renders a source section.

**Tech Stack:** TypeScript 7, Node.js 22, Chrome/Edge Manifest V3, Vitest, Zod, Markdown/JSON content trees, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-24-nowcoder-delivery-optimization-design.md`

## Global Constraints

- Work on the existing clean `master` checkouts because the user explicitly requested final delivery on `master` and asked for no further process questions.
- Never run more than 2 Data Collector remote detail tabs; user-initiated jobs have priority.
- Keep ZSXQ list/linked-article behavior serial and unchanged.
- Keep the 30-day, A/B evidence, target-company, minimum-question, privacy, completeness, URL/content/cluster deduplication, and unique-cluster heat gates.
- Use only public Nowcoder search pages and the existing logged-in browser extraction path.
- Stop a target-fill run with attention rather than lower quality when 10 accepted clusters cannot be obtained within 24 detail pages.
- Remove the public interview `## 来源` section while retaining private source URLs and evidence metadata.
- Do not modify or deploy `fe-journey-faas` unless the existing resource synchronization contract proves broken.
- Write a failing test and observe the expected failure before each production behavior change.

---

### Task 1: Add a bounded priority scheduler for remote detail jobs

**Files:**
- Create: `packages/extension/src/background/remoteJobScheduler.ts`
- Modify: `packages/extension/src/background/jobs.ts`
- Modify: `tests/unit/background.test.ts`
- Create: `tests/unit/remoteJobScheduler.test.ts`

**Interfaces:**
- Produces: `RemoteJobScheduler` with `run<T>(task: () => Promise<T>, priority: 'interactive' | 'batch'): Promise<T>`, `activeCount`, and `peakActiveCount`.
- `JobRunner.runRemoteJob()` consumes the scheduler and maps `interactive=true` to `interactive`, otherwise `batch`.

- [ ] **Step 1: Write failing scheduler tests**

```ts
it('runs at most two tasks and gives the next free slot to an interactive task', async () => {
  const scheduler = new RemoteJobScheduler(2);
  // Block two batch tasks, enqueue a third batch and then an interactive task.
  // Release one slot and assert the interactive task starts before batch three.
  expect(scheduler.peakActiveCount).toBe(2);
});

it('releases capacity after a rejected task', async () => {
  const scheduler = new RemoteJobScheduler(2);
  await expect(scheduler.run(async () => { throw new Error('boom'); }, 'batch')).rejects.toThrow('boom');
  await expect(scheduler.run(async () => 'ok', 'batch')).resolves.toBe('ok');
  expect(scheduler.activeCount).toBe(0);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npm test -- tests/unit/remoteJobScheduler.test.ts`

Expected: FAIL because `RemoteJobScheduler` does not exist.

- [ ] **Step 3: Implement the minimal two-slot priority queue**

```ts
export class RemoteJobScheduler {
  private active = 0;
  private peak = 0;
  private readonly interactive: Pending<unknown>[] = [];
  private readonly batch: Pending<unknown>[] = [];

  constructor(private readonly limit = 2) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('并发上限必须为正整数');
  }

  get activeCount(): number { return this.active; }
  get peakActiveCount(): number { return this.peak; }

  run<T>(task: () => Promise<T>, priority: 'interactive' | 'batch'): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const pending = { task, resolve, reject } as Pending<T>;
      (priority === 'interactive' ? this.interactive : this.batch).push(pending as Pending<unknown>);
      this.drain();
    });
  }
}
```

`drain()` always shifts the interactive queue first, increments active before invoking the task, and decrements/drains in `finally`.

- [ ] **Step 4: Replace `remoteQueue` in `JobRunner` and update the existing burst test**

The burst test must hold the first two page waits, assert exactly two tabs were created, enqueue an interactive third job plus a normal fourth job, release one slot, and assert the interactive request starts next. Existing assertions that every non-handoff tab is removed remain.

- [ ] **Step 5: Run focused extension tests and commit**

Run: `npm test -- tests/unit/remoteJobScheduler.test.ts tests/unit/background.test.ts tests/unit/ownedTabs.test.ts`

Expected: PASS with zero leaked tasks and no warnings.

Commit: `feat: bound remote collection concurrency`

---

### Task 2: Make candidate exclusion retry-aware and selection target exactly 10

**Files:**
- Create: `packages/bridge/src/plans/nowcoderHistory.ts`
- Modify: `packages/bridge/src/feJourney/preset.ts`
- Modify: `packages/bridge/src/plans/nowcoderPlan.ts`
- Modify: `packages/bridge/src/feJourney/nowcoderDiscovery.ts`
- Create: `tests/unit/nowcoderHistory.test.ts`
- Modify: `tests/unit/nowcoderPlan.test.ts`
- Modify: `tests/unit/feJourneyNowcoderDiscovery.test.ts`

**Interfaces:**
- Produces: `knownNowcoderPlanUrls(jobs: readonly JobRecord[], currentBatchId: string, now: string): Set<string>`.
- Produces constants `planTargetAccepted: 10`, `planInitialRoundSize: 8`, `planRefillRoundSize: 4`, `planDetailBudget: 24`, and `recoverableFailureCooldownMs: 60 * 60 * 1000` in the existing preset.
- `selectNowcoderPlanCandidates()` continues returning `NowcoderPlanSelection`, but round-robin diversity no longer has a per-company hard cap.

- [ ] **Step 1: Write failing retry-history tests**

```ts
expect(knownNowcoderPlanUrls([savedJob], 'new-batch', now)).toContain(savedJob.url);
expect(knownNowcoderPlanUrls([freshFailedJob], 'new-batch', now)).toContain(freshFailedJob.url);
expect(knownNowcoderPlanUrls([cooledFailedJob], 'new-batch', now)).not.toContain(cooledFailedJob.url);
expect(knownNowcoderPlanUrls([firstFailure, secondFailure], 'new-batch', now)).toContain(firstFailure.url);
expect(knownNowcoderPlanUrls([currentBatchFailure], currentBatchFailure.batchId!, now)).toContain(currentBatchFailure.url);
```

- [ ] **Step 2: Run the history test and confirm RED**

Run: `npm test -- tests/unit/nowcoderHistory.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement canonical URL grouping and one cooled retry**

Group jobs by canonical URL. A URL is known when it belongs to the current batch, has any non-failure state, has two terminal failure records, or its most recent failure is inside the one-hour cooldown. Only one older failed/attention record is eligible to re-enter discovery.

- [ ] **Step 4: Write failing selector and discovery tests**

The selector fixture supplies 10 Alibaba candidates plus one ByteDance candidate and asserts all 10 accepted slots can be filled while the available ByteDance candidate is still selected by round-robin ordering. Discovery tests assert the new Code Agent and AI engineering query variants are public fixed strings and normalized URLs remain unique.

- [ ] **Step 5: Update preset and selector minimally**

Set the accepted target to 10, remove the hard four-per-company stop, retain date-based rotated round robin, and add only explicit company + `Code Agent`, `AI 工程`, and `智能体` query variants needed to reduce first-page exhaustion.

- [ ] **Step 6: Run focused Bridge tests and commit**

Run: `npm test -- tests/unit/nowcoderHistory.test.ts tests/unit/nowcoderPlan.test.ts tests/unit/feJourneyNowcoderDiscovery.test.ts`

Expected: PASS.

Commit: `feat: refresh nowcoder candidate eligibility`

---

### Task 3: Advance one persisted batch through bounded target-fill rounds

**Files:**
- Modify: `packages/bridge/src/plans/service.ts`
- Modify: `packages/bridge/src/plans/store.ts`
- Modify: `packages/shared/src/plans.ts`
- Modify: `tests/unit/collectionPlanService.test.ts`
- Modify: `tests/unit/collectionPlanStore.test.ts`

**Interfaces:**
- `CollectionPlanStore.resumeCollection(batchId)` sets a non-finalized Nowcoder batch back to `status: 'running'`, clears `finishedAt`, and sets `selectionStatus: 'collecting'`.
- `CollectionPlanService.advanceNowcoderBatch(batch)` selects saved jobs, finalizes at 10 accepted, otherwise discovers and dispatches the next bounded round.
- `CollectionBatch.rounds?: number` persists the number of dispatched target-fill rounds for restart-safe reporting.

- [ ] **Step 1: Write failing store lifecycle tests**

Create a terminal-looking pending batch, call `resumeCollection`, reopen the JSON store, and assert it is running with no `finishedAt`, `selectionStatus: 'collecting'`, and the incremented round count remains valid under `collectionBatchSchema`.

- [ ] **Step 2: Run the store test and confirm RED**

Run: `npm test -- tests/unit/collectionPlanStore.test.ts`

Expected: FAIL because `resumeCollection` and `rounds` do not exist.

- [ ] **Step 3: Implement the minimal persisted lifecycle**

Add optional non-negative `rounds` to the shared schema, initialize it to zero for Nowcoder, increment it when a round is attached, and allow `resumeCollection` only while selection is not completed.

- [ ] **Step 4: Write failing target-fill service tests**

Cover these observable cases:

1. initial run dispatches 8 jobs;
2. six qualifying saved jobs cause a second round of 4;
3. reaching 10 causes exactly 10 sync calls and one finalized delivery list;
4. a third/fourth/fifth round never exceeds 24 attached detail jobs;
5. fewer than 10 after candidate exhaustion ends `completed_with_attention` with no delivery IDs;
6. reconnect after a terminal round resumes selection/refill instead of prematurely finalizing;
7. a previous cooled failure may be retried, but never twice;
8. content-layout failures are reclassified only when at least one page saved, preserving whole-batch outage signals.

- [ ] **Step 5: Implement `advanceNowcoderBatch`**

Replace the direct `finalizeNowcoderBatch` call at a terminal round with:

```ts
const selection = await selectSaved(batch);
if (selection.accepted.length >= target) return finalizeExactTen(batch, selection);
if (attached.length >= budget) return attentionWithoutDelivery(batch, selection);
const next = await discoverAndSelectRound(batch, attached.length === 0 ? 8 : 4);
if (next.length === 0) return attentionWithoutDelivery(batch, selection);
await store.resumeCollection(batch.id);
await createAttachAndDispatch(next);
```

The final synchronization receives only the first 10 accepted jobs in deterministic round-robin/date order. No partial delivery occurs when the run cannot reach 10.

- [ ] **Step 6: Run plan tests and commit**

Run: `npm test -- tests/unit/collectionPlanService.test.ts tests/unit/collectionPlanStore.test.ts tests/unit/nowcoderPlan.test.ts`

Expected: PASS.

Commit: `feat: fill nowcoder batches to ten`

---

### Task 4: Persist a metadata-only delivery benchmark

**Files:**
- Create: `packages/bridge/src/plans/benchmark.ts`
- Modify: `packages/bridge/src/plans/service.ts`
- Modify: `packages/bridge/src/server/index.ts`
- Create: `tests/unit/planBenchmark.test.ts`
- Modify: `tests/unit/collectionPlanService.test.ts`
- Modify: `docs/testing.md`

**Interfaces:**
- Produces `writePlanBenchmark(root: string, batch: CollectionBatch, jobs: readonly JobRecord[], options): Promise<string>`.
- Report path: `<configDir>/benchmarks/<batch-id>.json` with schema version 1.
- Report includes batch/run IDs, round count, stable content IDs, company/evidence/question/cluster metadata supplied by stored documents, active duration, per-job P50/P90, terminal counts, configured tab limit 2, and delivery IDs; it never includes article text, HTML, author, or credentials.

- [ ] **Step 1: Write a failing benchmark privacy and metric test**

Construct three timed jobs and metadata records, write the report, and assert exact total/P50/P90 values, stable IDs, and absence of `text`, `html`, `author`, raw cookies, or local source document paths.

- [ ] **Step 2: Run the benchmark test and confirm RED**

Run: `npm test -- tests/unit/planBenchmark.test.ts`

Expected: FAIL because the writer does not exist.

- [ ] **Step 3: Implement atomic benchmark writing**

Use a mode-0600 temporary file plus rename, calculate percentiles from `createdAt`/`updatedAt`, and accept a metadata callback rather than reading arbitrary files inside the pure formatter.

- [ ] **Step 4: Wire terminal report creation**

Create the report after final selection or attention is persisted. Benchmark-write failure changes the batch to attention because the requested comparison would otherwise be unauditable, but it must not delete saved evidence.

- [ ] **Step 5: Run focused tests and commit**

Run: `npm test -- tests/unit/planBenchmark.test.ts tests/unit/collectionPlanService.test.ts tests/integration/bridge.test.ts`

Expected: PASS.

Commit: `feat: record collection benchmarks`

---

### Task 5: Remove the public interview source module while preserving private traceability

**Files:**
- Modify in `/Users/chenhao/Code/front-end-journey-resource`: `.codex/skills/curate-interview-posts/SKILL.md`
- Modify: `.codex/skills/curate-interview-posts/references/fe-journey-integration.md`
- Modify: `scripts/validate-tree.mjs`
- Modify: `test/interview-source-history.test.mjs`
- Modify: `test/validate-tree.test.mjs`
- Modify: all current `interview/**/*.md` files containing `## 来源`

**Interfaces:**
- Public interview Markdown contract: no heading equal to `## 来源` and no `nowcoder.com` URL.
- Private history contract remains unchanged: every published record has canonical source URL, A/B evidence grade, cluster ID, article key, and knowledge keys.

- [ ] **Step 1: Write a failing public/private contract test**

The test scans every public interview Markdown file and rejects `## 来源` or `nowcoder.com`; the same test reads `.codex/interview-source-history.json` and requires traceability for every published article key.

- [ ] **Step 2: Run the resource test and confirm RED**

Run: `npm test -- --runInBand`

Expected: FAIL on the existing public `## 来源` sections.

- [ ] **Step 3: Update the repository-owned curation contract**

Require sources only in private history and review evidence. Explicitly preserve company/role/round/month background and knowledge navigation links, while forbidding a public source module and raw Nowcoder URL.

- [ ] **Step 4: Remove current public source sections**

Delete only the final `## 来源` block from each current public interview. Do not alter question/answer content or knowledge links in this mechanical step.

- [ ] **Step 5: Run resource validation and commit in the resource repository**

Run: `npm test && npm run validate:tree && npm run validate:images && npm run build`

Expected: PASS.

Commit: `feat: hide interview source sections`

---

### Task 6: Build, install, and run the optimized real collection

**Files:**
- Modify: package versions and lockfile only if the repository's release scripts require an extension/Bridge version bump.
- Generate locally: `~/.data-collector/benchmarks/<batch-id>.json`
- Generate in the resource inbox: exact current-batch Nowcoder entries.

**Interfaces:**
- Uses CLI: `node packages/bridge/dist/cli.js plans run nowcoder-agent-market --force --wait 1800000`.
- Uses exact manifest: `node scripts/inbox-manifest.mjs --repo /Users/chenhao/Code/front-end-journey-resource --batch "$BATCH_ID" --source nowcoder`.

- [ ] **Step 1: Run Data Collector full preflight**

Run: `npm test && npm run typecheck && npm run build && npm run smoke:plans && npm run smoke:delivery`.

Expected: all commands exit 0.

- [ ] **Step 2: Package/install the update and verify connection**

Run the repository's package/setup/update flow, confirm Bridge health reports the new version and the installed Edge extension reconnects. Do not ask the user unless Edge reports a hard offline/login state after automated recovery.

- [ ] **Step 3: Execute one target-fill run**

Capture the CLI's single JSON object. Continue only when status is `completed`, `deliveryIds` has exactly 10 unique IDs, and the benchmark shows no more than 24 detail jobs. Preserve and diagnose any attention batch before retrying through a new run.

- [ ] **Step 4: Build the exact manifest**

Reject malformed, missing, out-of-batch, non-A/B, old, duplicate-URL, or duplicate-cluster entries. The manifest must contain exactly 10 consumable entries.

- [ ] **Step 5: Commit Data Collector implementation**

Commit: `feat: optimize nowcoder delivery pipeline`

---

### Task 7: Curate and publish the second batch of 10 interviews

**Files:**
- Modify in `/Users/chenhao/Code/front-end-journey-resource`: `interview/_tree.json`
- Create/Modify: exact public `interview/**/*.md` files chosen from the current manifest
- Create/Modify: evidence-backed `knowledge/**/*.md` files
- Modify: knowledge `_tree.json` files affected by heat ordering
- Modify: `.codex/interview-source-history.json`
- Create: `.codex/reports/interview-batch-comparison-2026-08-24.json`

**Interfaces:**
- Consumes the exact manifest and repository-owned curation/generation Skills.
- Produces exactly 10 new public article keys, private history entries, and unique-cluster heat updates.

- [ ] **Step 1: Triage the exact manifest**

For each source, record company, role, round, date, A/B grade, complete question list, privacy/promotional removals, content hash, and cluster ID. Stop individual candidates that fail a hard gate; if fewer than 10 remain, return to a new target-fill collection run rather than lowering standards.

- [ ] **Step 2: Draft 10 public interview articles**

Use the source questions faithfully, group only semantically related questions, add technically verified answers and failure boundaries, link existing knowledge articles where useful, and do not include a public source section or raw Nowcoder URL.

- [ ] **Step 3: Expand knowledge and heat by unique cluster**

Reuse semantically existing knowledge keys. Create a knowledge page only for a genuinely missing reusable concept with enough source support. Add each new cluster once to `knowledgeKeys`; repeated URLs/reposts never increment heat.

- [ ] **Step 4: Update private source history and comparison data**

Upsert all selected, merged, skipped, and needs-review outcomes. Record old/new batch evidence distribution, company distribution, unique clusters, article lengths, question sections, knowledge links, hard-gate failures, rubric scores, and collection benchmark metrics.

- [ ] **Step 5: Run scoped and full resource verification**

Run: `npm test && npm run report:interview-topics && npm run validate:tree && npm run validate:images && npm run build`.

Expected: all commands exit 0; exactly 10 new public keys; zero public source modules; private history validates; duplicate run is heat-idempotent.

- [ ] **Step 6: Commit and push resource content**

Commit: `content: publish ten current agent interviews`

Push `master`, wait for `sync-content` success, and inspect public samples from every represented company plus affected knowledge links.

---

### Task 8: Independent review, final verification, cleanup, and delivery report

**Files:**
- Modify only files required to fix review findings.
- Remove only exact consumed inbox entries after online success.

**Interfaces:**
- Review range begins at Data Collector commit `3058b06` and the resource repository pre-change HEAD.
- Completion produces clean `master` branches, pushed commits, online workflow evidence, and a side-by-side time/quality report.

- [ ] **Step 1: Request an independent code and data review**

Give a reviewer the spec, implementation plan, exact commit ranges, benchmark JSON, manifest, and quality rubric. Require findings grouped as Critical, Important, and Minor, including concurrency races, restart state, accidental evidence deletion, duplicate heat, and public source leakage.

- [ ] **Step 2: Fix every Critical and Important finding with TDD**

For each valid finding, add or tighten a regression test, observe RED, implement the minimal fix, and rerun the focused suite.

- [ ] **Step 3: Run fresh final verification**

Data Collector: `npm test && npm run typecheck && npm run build && npm run smoke:plans && npm run smoke:delivery`.

Resource repository: `npm test && npm run report:interview-topics && npm run validate:tree && npm run validate:images && npm run build`.

Also confirm both `git status --short` outputs are clean, both branches are `master`, and local HEADs equal `origin/master` after push.

- [ ] **Step 4: Verify real browser and online invariants**

Confirm Bridge health/extension connection, target batch terminal status, exactly 10 delivery IDs, configured/observed remote-tab peak at most 2, zero owned tabs after completion, no public source module, and successful `sync-content` workflow.

- [ ] **Step 5: Clean only consumed evidence and report**

Delete only the exact current-batch inbox entries confirmed published. Preserve rejected, malformed, failed, needs-review, local raw evidence, benchmarks, and permanent history. Report old/new active time, throughput, P50/P90, quality rubric, company/grade/cluster coverage, knowledge additions/weight increments, commits, workflow ID, and all exclusions.
