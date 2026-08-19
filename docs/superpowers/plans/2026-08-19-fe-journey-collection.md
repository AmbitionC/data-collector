# fe-journey Collection Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a personal, fixed-schedule fe-journey collection pipeline for Nowcoder and GitHub with deterministic quality scoring, duplicate clustering, Codex-ready inbox metadata, regression protection, and real-source verification.

**Architecture:** The Bridge owns fixed discovery schedules and direct GitHub collection; Edge remains responsible for browser-authenticated Nowcoder detail extraction. A fe-journey-only enrichment/index module adds optional metadata and similarity clusters before the unchanged Markdown library path saves content. Public content is produced later by a resource-repository Codex skill from a local ignored inbox.

**Tech Stack:** TypeScript 7, Node.js 22, Vitest 4, Edge Manifest V3, local HTTP/WebSocket Bridge, GitHub REST API, Markdown/Git resource repository.

**Spec:** `docs/superpowers/specs/2026-08-19-fe-journey-collection-design.md`

## Global Constraints

- Do not change WeChat or ZSXQ extractor, list collection, filters, linked-article completion, or routing behavior.
- Do not add user-facing subscription configuration, a database, an intelligence platform, diagnostics, job-search features, or membership behavior.
- New network work is enabled only when the built-in `fe-journey` sink exists.
- Raw inbox content stays local and untracked; only reviewed resource content enters Git.
- Every production behavior follows a failing-test-first red/green cycle.

---

### Task 1: Stabilize the environment-independent Bridge baseline

**Files:**
- Modify: `tests/integration/bridge.test.ts`

**Interfaces:**
- Consumes: explicit `sinks.json` schema `{ sinks, routes }`.
- Produces: a Bridge integration fixture that never reads real repositories from the developer home directory.

- [x] **Step 1: Reproduce the failing full suite on a machine containing both built-in target repositories**

Run: `npm test`  
Expected before the fixture change: the health assertion receives `life-teachers` and `fe-journey` instead of Markdown-only routing.

- [x] **Step 2: Write an explicit Markdown-only `sinks.json` in the temporary config directory**

```ts
await writeFile(
  join(configDir, 'sinks.json'),
  `${JSON.stringify({ sinks: { markdown: { type: 'markdown' } }, routes: {} }, null, 2)}\n`,
  'utf8',
);
```

- [x] **Step 3: Verify focused and full tests**

Run: `npx vitest run tests/integration/bridge.test.ts && npm test`  
Expected: 12 focused and 394 total tests pass.

### Task 2: Add the optional fe-journey candidate contract and GitHub source

**Files:**
- Modify: `packages/shared/src/model.ts`
- Modify: `packages/shared/src/protocol.ts`
- Modify: `packages/shared/src/sources.ts`
- Modify: `packages/shared/src/url.ts`
- Modify: `packages/extension/src/extractors/index.ts`
- Test: `tests/unit/url.test.ts`
- Test: `tests/unit/extractors.test.ts`

**Interfaces:**
- Produces: `FeJourneyCandidateKind`, `FeJourneyCandidateMetadata`, optional `CollectedDocument.feJourney`, and source id `github`.
- Produces: GitHub canonical repository URLs with query and fragment removed.

- [ ] **Step 1: Add failing schema and URL tests**

```ts
expect(collectedDocumentSchema.parse({ ...githubDocument, feJourney: metadata }).feJourney)
  .toEqual(metadata);
expect(canonicalizeUrl(new URL('https://github.com/acme/agent?tab=readme#x')).href)
  .toBe('https://github.com/acme/agent');
```

- [ ] **Step 2: Run the tests and confirm GitHub and `feJourney` are rejected**

Run: `npx vitest run tests/unit/url.test.ts tests/unit/extractors.test.ts`  
Expected: FAIL because `github` and `feJourney` are not defined.

- [ ] **Step 3: Implement the optional types/schema and GitHub descriptor**

Add exact candidate kinds `interview`, `knowledge`, `operation`, `project`; bound scores to integers `0..100`, hashes to lowercase hexadecimal strings, and arrays to at most 20 evidence strings.

- [ ] **Step 4: Add an explicit extractor error for GitHub browser pages**

```ts
case 'github':
  throw new ExtractionError('UNSUPPORTED_LAYOUT', 'GitHub 项目由 fe-journey 定时任务采集');
```

- [ ] **Step 5: Run focused tests, typecheck shared/extension, and commit**

Run: `npx vitest run tests/unit/url.test.ts tests/unit/extractors.test.ts && npm run typecheck`  
Expected: PASS.

### Task 3: Implement deterministic classification, scoring, and similarity fingerprints

**Files:**
- Create: `packages/bridge/src/feJourney/quality.ts`
- Create: `packages/bridge/src/feJourney/fingerprint.ts`
- Create: `packages/bridge/src/feJourney/index.ts`
- Test: `tests/unit/feJourneyQuality.test.ts`

**Interfaces:**
- Produces: `contentFingerprint(text): string`.
- Produces: `simHash64(text): string` and `hammingDistance64(left, right): number`.
- Produces: `scoreFeJourneyCandidate(document): Omit<FeJourneyCandidateMetadata, 'clusterId' | 'duplicateOf'>`.

- [ ] **Step 1: Write failing tests for four candidate kinds and promotional/noise penalties**

Use one real-shaped first-person interview sample, one engineering article, one trend post, one GitHub project, and one short job-wish post. Assert exact candidate kinds, score bands, and exclusion reasons.

- [ ] **Step 2: Write failing fingerprint tests**

Assert punctuation/case/whitespace variants share a content hash, lightly rewritten text has a small SimHash distance, and unrelated text has a larger distance.

- [ ] **Step 3: Run and verify RED**

Run: `npx vitest run tests/unit/feJourneyQuality.test.ts`  
Expected: FAIL because the modules do not exist.

- [ ] **Step 4: Implement minimal deterministic rules and 64-bit SimHash**

Use fixed rule tables and no LLM/network calls. Keep all functions pure.

- [ ] **Step 5: Run focused tests and commit**

Run: `npx vitest run tests/unit/feJourneyQuality.test.ts`  
Expected: PASS.

### Task 4: Persist fe-journey clusters without changing other sources

**Files:**
- Create: `packages/bridge/src/feJourney/candidateIndex.ts`
- Modify: `packages/bridge/src/server/index.ts`
- Modify: `packages/bridge/src/sinks/repoInboxSink.ts`
- Test: `tests/unit/feJourneyIndex.test.ts`
- Test: `tests/unit/sinks.test.ts`
- Test: `tests/integration/pipeline.test.ts`

**Interfaces:**
- Produces: `FeJourneyCandidateIndex.open(path)`.
- Produces: `prepare(document): { document: CollectedDocument; commit(): Promise<void> }`.
- Persists: `<library>/_catalog/fe-journey.json` version 1.

- [ ] **Step 1: Write failing tests for exact and near-duplicate clusters**

Assert same text across two URLs shares `clusterId`, the second has `duplicateOf`, and unrelated text creates a new cluster.

- [ ] **Step 2: Write a failing compatibility test**

Save a ZSXQ document and assert it has no `feJourney` metadata and does not create a fe-journey index entry.

- [ ] **Step 3: Run and verify RED**

Run: `npx vitest run tests/unit/feJourneyIndex.test.ts tests/integration/pipeline.test.ts`  
Expected: FAIL because the index does not exist.

- [ ] **Step 4: Implement serialized atomic index updates and Bridge enrichment**

Prepare metadata only for `nowcoder` and `github`; commit index state only after the Markdown sink succeeds.

- [ ] **Step 5: Include `document.feJourney` and primitive `sourceMetadata` in inbox `meta.json`**

Do not change existing keys.

- [ ] **Step 6: Run focused tests and commit**

Run: `npx vitest run tests/unit/feJourneyIndex.test.ts tests/unit/sinks.test.ts tests/integration/pipeline.test.ts`  
Expected: PASS.

### Task 5: Discover Nowcoder detail URLs from fixed public search pages

**Files:**
- Create: `packages/bridge/src/feJourney/preset.ts`
- Create: `packages/bridge/src/feJourney/nowcoderDiscovery.ts`
- Test: `tests/unit/feJourneyNowcoder.test.ts`
- Fixture: `tests/fixtures/nowcoder-search.html`

**Interfaces:**
- Produces: `FE_JOURNEY_PRESET` fixed query/cadence/limit values.
- Produces: `discoverNowcoderUrls(fetcher, knownUrls): Promise<string[]>`.

- [ ] **Step 1: Add an SSR search fixture with duplicate tracked links and unrelated links**

- [ ] **Step 2: Write a failing test**

Assert only `/discuss/<id>` and `/feed/main/detail/<id>` links survive, tracking parameters are stripped, duplicates/known URLs are removed, and the run limit is enforced.

- [ ] **Step 3: Run and verify RED**

Run: `npx vitest run tests/unit/feJourneyNowcoder.test.ts`  
Expected: FAIL because discovery is absent.

- [ ] **Step 4: Implement fixed-URL fetch and conservative href extraction**

Reject non-200 responses and never accept a caller-provided host.

- [ ] **Step 5: Run focused tests and commit**

Run: `npx vitest run tests/unit/feJourneyNowcoder.test.ts`  
Expected: PASS.

### Task 6: Discover and save GitHub project candidates

**Files:**
- Create: `packages/bridge/src/feJourney/githubDiscovery.ts`
- Test: `tests/unit/feJourneyGithub.test.ts`

**Interfaces:**
- Produces: `discoverGithubProjects(fetcher, now): Promise<CollectedDocument[]>`.
- Consumes: GitHub Search API JSON and raw README responses.

- [ ] **Step 1: Write failing tests for fork rejection, repository dedupe, README fetch, source metadata, and limits**

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run tests/unit/feJourneyGithub.test.ts`  
Expected: FAIL because discovery is absent.

- [ ] **Step 3: Implement fixed GitHub searches and document mapping**

Send an explicit `User-Agent`, request public JSON/raw Markdown, ignore forks and malformed responses, and preserve per-project failures without aborting the batch.

- [ ] **Step 4: Run focused tests and commit**

Run: `npx vitest run tests/unit/feJourneyGithub.test.ts`  
Expected: PASS.

### Task 7: Add the fixed scheduler, immediate-run API, and CLI command

**Files:**
- Create: `packages/bridge/src/feJourney/collector.ts`
- Create: `packages/bridge/src/feJourney/state.ts`
- Modify: `packages/bridge/src/server/index.ts`
- Modify: `packages/bridge/src/server/http.ts`
- Modify: `packages/bridge/src/cli.ts`
- Modify: `packages/bridge/src/sinks/config.ts`
- Test: `tests/unit/feJourneyCollector.test.ts`
- Test: `tests/integration/bridge.test.ts`
- Test: `tests/integration/cli.test.ts`

**Interfaces:**
- Produces: `FeJourneyCollector.run({ nowcoder, github, force }): Promise<FeJourneyRunReport>`.
- Persists: `<configDir>/fe-journey-state.json`.
- Adds: authenticated `POST /v1/fe-journey/collect` and `GET /v1/fe-journey/status`.
- Adds: `collector fe-journey collect` and `collector fe-journey status`.

- [ ] **Step 1: Write failing scheduler tests**

Assert due runs execute, early runs skip, `force` bypasses cadence, concurrent calls coalesce, and partial source failure appears in the report.

- [ ] **Step 2: Write failing Bridge/CLI tests**

Assert the feature is disabled without the fe-journey sink, enabled with it, endpoints require the bearer token, and no settings payload is accepted.

- [ ] **Step 3: Run and verify RED**

Run: `npx vitest run tests/unit/feJourneyCollector.test.ts tests/integration/bridge.test.ts tests/integration/cli.test.ts`  
Expected: FAIL because collector/endpoints/commands are absent.

- [ ] **Step 4: Implement state, collector orchestration, lifecycle timer, endpoints, and CLI**

The Bridge enqueues stable-ID Nowcoder jobs for Edge and saves GitHub documents through the same Markdown sink/enrichment path. Clear the timer in `BridgeHandle.close()`.

- [ ] **Step 5: Make the built-in fe-journey inbox local-only and route GitHub to it**

Set `commit:false`, `push:false` only for `fe-journey`; keep `life-teachers` defaults unchanged.

- [ ] **Step 6: Run focused tests and commit**

Run: `npx vitest run tests/unit/feJourneyCollector.test.ts tests/integration/bridge.test.ts tests/integration/cli.test.ts tests/unit/sinks.test.ts`  
Expected: PASS.

### Task 8: Add regression smoke coverage and operator documentation

**Files:**
- Create: `scripts/smoke-fe-journey.mjs`
- Modify: `package.json`
- Modify: `docs/product.md`
- Modify: `docs/sinks.md`
- Modify: `docs/protocol.md`
- Modify: `README.md`
- Test: `tests/e2e/extension.test.ts`

**Interfaces:**
- Adds: `npm run smoke:fe-journey` using fixtures by default and `LIVE=1` for public live discovery.

- [ ] **Step 1: Write a failing smoke test for the fixture path**

Assert the script discovers Nowcoder URLs, maps a GitHub project, assigns candidate metadata, clusters a duplicate, and writes a Codex-ready inbox entry.

- [ ] **Step 2: Run and verify RED**

Run: `npm run smoke:fe-journey`  
Expected: FAIL because the script is absent.

- [ ] **Step 3: Implement the smoke script and document exact operation/recovery**

- [ ] **Step 4: Run all compatibility gates**

Run: `npm test && npm run typecheck && npm run build && npm run test:e2e && npm run smoke:fe-journey`  
Expected: every command exits 0, including existing ZSXQ E2E cases.

- [ ] **Step 5: Commit the verified Data Collector implementation**

Commit only after fresh verification output is recorded.

### Task 9: Add the resource-repository Codex consumption skill

**Files:**
- Create in `front-end-journey-resource`: `.codex/skills/curate-fe-journey-inbox/SKILL.md`
- Create: `.codex/skills/curate-fe-journey-inbox/agents/openai.yaml`
- Create: `.codex/skills/curate-fe-journey-inbox/references/quality-and-dedup.md`
- Create: `.codex/skills/curate-fe-journey-inbox/scripts/inbox-inventory.mjs`
- Modify: `.gitignore`
- Modify: `package.json`

**Interfaces:**
- Consumes: local `_inbox/{nowcoder,github}/**/{original.md,meta.json}`.
- Produces: grouped inventory JSON, local `_inbox/_reports/*.md`, and reviewed `interview/`/`knowledge/` changes.

- [ ] **Step 1: Use the skill-creator and writing-skills instructions before authoring the skill**

- [ ] **Step 2: Write failing inventory-script tests or verifier fixtures**

Assert invalid metadata fails, clusters are grouped once, excluded items are reported, and public output paths remain outside `_inbox`.

- [ ] **Step 3: Implement the script, skill, references, and ignored local inbox**

- [ ] **Step 4: Run resource repository validation and skill smoke**

Run: `npm install && npm run validate:tree && node .codex/skills/curate-fe-journey-inbox/scripts/inbox-inventory.mjs --check-fixture`  
Expected: PASS.

### Task 10: Review, live collection, content update, and final evidence report

**Files:**
- Create: `docs/reports/2026-08-19-fe-journey-collection-delivery.md`
- Modify as evidence requires: real resource `interview/` or `knowledge/` Markdown and `_tree.json`.

**Interfaces:**
- Produces: requirement-by-requirement delivery evidence and final content paths/URLs.

- [ ] **Step 1: Request an independent code review and fix all Critical/Important findings**

- [ ] **Step 2: Run fixture smoke, then live public discovery**

Run: `npm run smoke:fe-journey` and `LIVE=1 npm run smoke:fe-journey`  
Expected: both exit 0; live report contains current Nowcoder detail URLs and at least one GitHub project.

- [ ] **Step 3: Collect a real Nowcoder detail through Bridge + Edge and sync it locally**

Verify the inbox contains `original.md`, `meta.json`, quality score, candidate kinds, content hash, SimHash, and cluster id.

- [ ] **Step 4: Run the resource skill on the real batch**

Verify similar sources are grouped, operation/project reports are local, and at least one evidence-backed interview or knowledge update passes tree validation.

- [ ] **Step 5: Verify final product consumption**

Build the frontend or use the existing production-shaped content read path to prove the updated resource is consumable; do not claim deployment without an actual reachable runtime check.

- [ ] **Step 6: Run final fresh verification**

Run all Data Collector and resource commands again from clean working trees and record exit codes/counts in the report.

- [ ] **Step 7: Complete the delivery report and completion audit**

Map every user requirement to direct file, test, runtime, review, live-source, and content-output evidence; list any external deployment state honestly instead of inferring it.
