# P1 Fixed Collection Plans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run recoverable daily `zsxq-chen-teacher` and `nowcoder-agent-market` plans through the existing local Bridge and logged-in Edge, with honest terminal batch counts and company coverage.

**Architecture:** A small Bridge plan service owns cadence, batch state, job membership, and inbox sync. The extension owns page interaction for ZSXQ views and sends ordinary collected documents through existing jobs. Existing GitHub cadence remains in `FeJourneyCollector`.

**Tech Stack:** TypeScript 7, Node.js 22, Chrome Extension MV3, WebSocket, Vitest 4, JSDOM.

**Spec:** `docs/superpowers/specs/2026-08-23-scheduled-source-plans-design.md`

## Global Constraints

- Only two code-defined plan IDs exist; no rule DSL or settings UI.
- Reuse Edge login state; never persist site credentials.
- A batch completes only after every child job is terminal.
- Edge offline means pending/catch-up, not false failure.
- ZSXQ performs no private API requests; it observes page traffic already made by the site.
- A/B candidates may auto-sync to private inboxes; C candidates stay local only.
- Every behavior follows RED → GREEN tests.

---

### Task 1: Shared plan and batch contracts

**Files:**
- Create: `packages/shared/src/plans.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/model.ts`
- Modify: `packages/shared/src/protocol.ts`
- Create: `tests/unit/plans.test.ts`

**Interfaces:**

```ts
export const COLLECTION_PLAN_IDS = ['zsxq-chen-teacher', 'nowcoder-agent-market'] as const;
export type CollectionPlanId = typeof COLLECTION_PLAN_IDS[number];
export type BatchStatus = 'running' | 'completed' | 'completed_with_attention' | 'failed';
export interface CollectionBatch {
  id: string;
  planId: CollectionPlanId;
  status: BatchStatus;
  startedAt: string;
  finishedAt?: string;
  discovered: number;
  accepted: number;
  saved: number;
  skipped: number;
  failed: number;
  needsAttention: number;
  coverage?: Record<string, number>;
  error?: string;
}
```

`JobRecord` gains optional `batchId` and `planId`; WebSocket adds validated `plan.collect` and `plan.result` envelopes.

- [ ] Write schema tests for valid batches and rejection of unknown plan IDs.
- [ ] Run `npm test -- tests/unit/plans.test.ts` and verify RED.
- [ ] Implement contracts and exports.
- [ ] Run the test and `npm run typecheck`; verify GREEN.
- [ ] Commit with `git commit -m "feat: define fixed collection plan contracts"`.

### Task 2: Atomic batch store and terminal reconciliation

**Files:**
- Create: `packages/bridge/src/plans/store.ts`
- Create: `packages/bridge/src/plans/index.ts`
- Create: `tests/unit/collectionPlanStore.test.ts`
- Modify: `packages/bridge/src/jobs/store.ts`

**Interfaces:**

```ts
class CollectionPlanStore {
  static open(path: string, now?: () => string): Promise<CollectionPlanStore>;
  start(planId: CollectionPlanId): Promise<CollectionBatch>;
  attachJob(batchId: string, jobId: string): Promise<void>;
  reconcile(batchId: string, jobs: readonly JobRecord[]): Promise<CollectionBatch>;
  markDiscovery(batchId: string, discovered: number, coverage?: Record<string, number>): Promise<void>;
  fail(batchId: string, message: string): Promise<CollectionBatch>;
  latest(planId?: CollectionPlanId, limit?: number): CollectionBatch[];
}
```

- [ ] Write failing tests proving queued/dispatched/collecting children keep a batch running, terminal mixtures produce exact saved/skipped/failed/attention counts, state corruption is preserved, and writes survive reopen.
- [ ] Run `npm test -- tests/unit/collectionPlanStore.test.ts` and verify RED.
- [ ] Implement version-1 atomic store at `~/.data-collector/collection-plans.json` and optional JobRecord membership.
- [ ] Run tests and verify GREEN.
- [ ] Commit with `git commit -m "feat: persist collection batch state"`.

### Task 3: Company-aware Nowcoder daily discovery

**Files:**
- Modify: `packages/bridge/src/feJourney/preset.ts`
- Modify: `packages/bridge/src/feJourney/nowcoderDiscovery.ts`
- Modify: `tests/fixtures/nowcoder-search.html`
- Modify: `tests/unit/feJourneyNowcoder.test.ts`
- Create: `packages/bridge/src/plans/nowcoderPlan.ts`
- Create: `tests/unit/nowcoderPlan.test.ts`

**Interfaces:**

```ts
export interface NowcoderDiscoveryCandidate { url: string; queryCompany: CompanyId; }
export function selectNowcoderPlanCandidates(
  documents: readonly CollectedDocument[], now: string,
): { accepted: CollectedDocument[]; coverage: Record<CompanyId, number>; rejected: Rejection[] };
```

- [ ] Write failing tests for 60-candidate discovery, 30-day cutoff, A/B-only acceptance, max 12, max 4/company, rotating company start, and `ant: 0` coverage without quota filling.
- [ ] Run discovery/plan tests and verify RED.
- [ ] Implement finite company × role query families and deterministic selection.
- [ ] Run tests and verify GREEN.
- [ ] Commit with `git commit -m "feat: discover company-aware Nowcoder interviews"`.

### Task 4: ZSXQ view selection and owner evidence

**Files:**
- Modify: `packages/extension/src/extractors/zsxq.ts`
- Modify: `packages/extension/src/content.ts`
- Modify: `packages/extension/src/background/jobs.ts`
- Create: `tests/fixtures/zsxq-three-views.html`
- Modify: `tests/unit/extractors.test.ts`
- Modify: `tests/unit/content-script.test.ts`
- Modify: `tests/unit/background.test.ts`

**Interfaces:**

```ts
type ZsxqPlanView = '最新' | '精华' | '只看星主';
// content message
{ type: 'list.selectView'; label: ZsxqPlanView }
// response only after selected label and topic set become stable
{ ok: true; payload: { selected: ZsxqPlanView } }
```

Every extracted item sets primitive source metadata `authorRole`, `topicId`, and `viewLabels`; automated plan acceptance requires `authorRole: 'owner'`.

- [ ] Write failing tests for clicking exact menu labels, waiting for changed topic IDs, owner/member distinction, questioner preservation, and view-label union.
- [ ] Run the three focused test files and verify RED.
- [ ] Implement narrow menu interaction and an extraction-only list pass that does not save until all selected views are unioned by canonical topic URL.
- [ ] Run tests and verify GREEN.
- [ ] Commit with `git commit -m "feat: collect ZSXQ owner posts across views"`.

### Task 5: Plan service, catch-up, retries, and private inbox sync

**Files:**
- Create: `packages/bridge/src/plans/service.ts`
- Create: `tests/unit/collectionPlanService.test.ts`
- Modify: `packages/bridge/src/server/index.ts`
- Modify: `packages/extension/src/background/connection.ts`
- Modify: `packages/extension/src/background/index.ts`
- Modify: `packages/extension/src/background/jobs.ts`
- Modify: `tests/integration/bridge.test.ts`

**Interfaces:**

```ts
class CollectionPlanService {
  status(): CollectionPlanStatus;
  run(planId: CollectionPlanId, options?: { force?: boolean }): Promise<CollectionBatch>;
  onExtensionConnected(): Promise<void>;
  onJobTerminal(job: JobRecord): Promise<void>;
}
```

- [ ] Write failing tests for 08:00/09:00 Asia/Shanghai due calculations, offline pending catch-up, 1/3/9-second tab retry, AUTH_REQUIRED attention, end-to-end terminal reconciliation, and A/B/owner-only `syncEntries` calls.
- [ ] Run unit and Bridge integration tests; verify RED.
- [ ] Implement the service and WebSocket dispatch while leaving existing URL jobs and GitHub cadence unchanged.
- [ ] Run focused tests and verify GREEN.
- [ ] Commit with `git commit -m "feat: run recoverable daily collection plans"`.

### Task 6: P1 regression and fixture smoke

**Files:**
- Create: `scripts/smoke-collection-plans.mjs`
- Modify: `package.json`
- Create: `tests/unit/collectionPlanSmoke.test.ts`

- [ ] Write a failing smoke validator that runs both profiles against local fixtures and requires topic union, company caps, honest zero coverage, terminal counts, and exactly-once inbox sync.
- [ ] Run `npm test -- tests/unit/collectionPlanSmoke.test.ts` and verify RED.
- [ ] Implement `npm run smoke:plans` with temporary directories and no network.
- [ ] Run `npm run smoke:plans`, `npm test`, `npm run typecheck`, and `npm run build`; verify GREEN.
- [ ] Commit with `git commit -m "test: add fixed collection plan smoke"`.
