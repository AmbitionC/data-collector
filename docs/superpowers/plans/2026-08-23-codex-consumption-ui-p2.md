# P2 Codex Consumption and Task UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make plan status controllable from Codex and visible in the Side Panel, and make accepted source clusters produce traceable local interview-gap and operation-topic reports.

**Architecture:** The Bridge exposes token-protected plan status/run/batch routes and CLI commands. The extension renders a minimal task page. The resource repository curator consumes private inbox metadata by cluster and writes ignored reports; publication remains a separate reviewed content action.

**Tech Stack:** TypeScript 7, Node.js 22, Chrome Extension MV3, Vitest 4, Markdown, local Codex skills.

**Spec:** `docs/superpowers/specs/2026-08-23-scheduled-source-plans-design.md`

## Global Constraints

- No new server, cloud credential, model API, database, or vector store.
- All `/v1/*` routes remain loopback-only and bearer protected.
- Reports stay under ignored `_inbox/_reports`; third-party source bodies are never committed automatically.
- Side Panel remains a right-side panel and does not resize or replace the source page.
- Public interview/knowledge changes require later human review.

---

### Task 1: Protected plan HTTP API and CLI

**Files:**
- Modify: `packages/bridge/src/server/index.ts`
- Modify: `packages/bridge/src/cli.ts`
- Modify: `tests/integration/bridge.test.ts`
- Modify: `tests/integration/cli.test.ts`
- Modify: `docs/protocol.md`

**Interfaces:**

```text
GET  /v1/plans/status
POST /v1/plans/run                 { planId, force }
GET  /v1/plans/batches?limit=20

data-collector plans status
data-collector plans run <plan-id> --force
data-collector plans batches --limit 20
```

- [ ] Write failing authorization, validation, response, and CLI exit-code tests.
- [ ] Run Bridge/CLI tests and verify RED.
- [ ] Implement routes and CLI formatting without exposing local paths or credentials.
- [ ] Run tests and verify GREEN.
- [ ] Commit with `git commit -m "feat: expose collection plans to Codex"`.

### Task 2: Minimal Side Panel task page

**Required skill:** Read and follow `frontend-design:frontend-design` before this task.

**Files:**
- Modify: `packages/extension/src/background/connection.ts`
- Modify: `packages/extension/src/sidepanel/index.html`
- Modify: `packages/extension/src/sidepanel/index.ts`
- Modify: `packages/extension/src/sidepanel/state.ts`
- Modify: `packages/extension/src/sidepanel/styles.css`
- Modify: `tests/unit/connection.test.ts`
- Modify: `tests/unit/sidepanel-controller.test.ts`
- Modify: `tests/unit/sidepanel.test.ts`

- [ ] Write failing tests for the “任务” navigation item, two plan cards, last/next run, saved/skipped/failed/attention counts, four-company coverage, immediate run, retry, and login link.
- [ ] Run focused tests and verify RED.
- [ ] Implement a compact task page using existing typography, spacing, button, error, and polling patterns; do not add charts, settings, logs, or query editing.
- [ ] Run focused tests and verify GREEN.
- [ ] Commit with `git commit -m "feat: show fixed plan status in side panel"`.

### Task 3: Curator question-cluster and report contract

**Required skills:** Read and follow `skill-creator` and `superpowers:writing-skills` before editing the curator skill.

**Files in `/Users/chenhao/Code/front-end-journey-resource`:**
- Modify: `.codex/skills/curate-fe-journey-inbox/SKILL.md`
- Create: `.codex/skills/curate-fe-journey-inbox/references/interview-gap-contract.md`
- Create: `.codex/skills/curate-fe-journey-inbox/scripts/build-interview-gap.mjs`
- Create: `.codex/skills/curate-fe-journey-inbox/scripts/build-interview-gap.test.mjs`

**Interfaces:**

```text
build-interview-gap.mjs <resource-root> [--date YYYY-MM-DD]
outputs:
  _inbox/_reports/interview-gap-YYYY-MM-DD.md
  _inbox/_reports/operation-topics-YYYY-MM-DD.md
```

- [ ] Write a failing script test with A/B/C candidates, two cross-URL duplicates, and literal expected `covered/evolved/new` rows and source links.
- [ ] Run the script test and verify RED.
- [ ] Implement deterministic parsing/cluster input and instruct Codex to perform semantic confirmation only after candidate metadata validation; C-only evidence cannot create a recommendation.
- [ ] Run script tests and the skill pressure scenarios required by `writing-skills`; verify GREEN.
- [ ] Commit resource-repository changes with `git commit -m "feat: generate interview evidence gap reports"`.

### Task 4: End-to-end local acceptance

**Files:**
- Modify: `scripts/smoke-collection-plans.mjs`
- Modify: `docs/testing.md`
- Modify: `docs/product.md`
- Modify: `docs/fe-journey-collection.md`

- [ ] Add a failing acceptance assertion that fixtures produce one record per question cluster and link only A/B evidence.
- [ ] Run `npm run smoke:plans` and verify RED.
- [ ] Wire report generation into the smoke and update user-facing documentation.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, `npm run test:e2e`, `npm run smoke:wechat`, `npm run smoke:fe-journey`, and `npm run smoke:plans`; verify GREEN.
- [ ] Commit with `git commit -m "docs: complete scheduled collection workflow"`.

### Task 5: Real Edge smoke, cleanup, package, and deployment

**Files:**
- Modify: `package.json` version and generated package artifacts only after all tests pass.

- [ ] Run the ten August URLs and assert ten URL records but nine initial content clusters; replace the duplicate sample with one additional qualifying August source so final acceptance has ten independent clusters.
- [ ] Run `zsxq-chen-teacher` against the logged-in Edge group and verify all three view labels, owner enforcement, topic-ID dedupe, and private life-teachers inbox output.
- [ ] Run `nowcoder-agent-market` and verify company caps, explicit Ant coverage gap when applicable, full-body checks, and private fe-journey inbox output.
- [ ] Generate the live interview gap report and compare it to the manual 2026-08-23 audit.
- [ ] Review `git status`, tracked artifacts, local library/catalog residue, launch agents, and installed software; remove only task-created unnecessary residue through supported APIs.
- [ ] Bump the extension patch version, run `npm run package`, commit all intended changes on `master`, push `origin/master`, restart the Bridge, and verify `/health` reports the new build and `extensionConnected: true`.

