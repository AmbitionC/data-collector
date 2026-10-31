# Nowcoder Publishing Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable publication limits, verification pause/recovery and truthful timing evidence, then release the plugin.

**Architecture:** Keep operations journals as the usage ledger. A shared private control store handles policy and verification state; authoritative admission lives inside the existing serialized journal mutation. Extend existing CLI, server and editor status rather than adding a sending UI.

**Tech Stack:** Existing TypeScript, Zod, Vitest, Chrome extension and Node 22 toolchain; no dependency additions.

**Spec:** docs/superpowers/specs/2026-10-31-nowcoder-publish-control-design.md

## Global Constraints

- master only; preserve unrelated work. One release bump to 0.4.62 after reviewed implementation.
- Defaults: minimum interval 120000 ms, 5 attempts/rolling hour, 20 attempts/rolling 24 hours; configurable operating policy, not site exemption.
- No live comment submission, CAPTCHA solving, account switching or verification bypass during development.
- Existing journals and stopped runs remain intact; old keys never resend.
- Node executable: /Users/chenhao/.nvm/versions/node/v22.22.3/bin/node.

## Review Focus

- Concurrent new keys on different posts share the same budget and pause, including direct CLI versus workflows.
- Corrupt or missing-after-use state/history cannot silently reset publishing protection.
- Restart/replay/clock rollback cannot erase usage, unknown submissions or verification generations.
- Explicit resume performs only readonly original-source checking; incomplete receipt coverage stays uncertain.
- Diagnostics distinguish actual click/receipt/challenge timing and never fill unobserved legacy events.

---

### Task 1: Implement the three controls as one integrated feature

**Files:** new shared control schemas and bridge operations control store; existing operations store/activity/workflow/CLI/server, shared conversation/publication schemas, extension page runner and editor status/bridge proxy, focused tests and operations docs.

**Interfaces:** The control store consumes strict operations journal history and returns policy/status/admission decisions. Operations store calls admission before a new journal write. Activity records verification and readonly resume. Workflow waits only for minimum intervals and stops on hard budgets. Extension reports observed timing; editor reads status.

- [x] Add behavior tests for cross-post/concurrent/history/restart limits; blocked and generation-safe readonly resume; invalid state and stale context; page timing and no duplicate submissions. Run relevant Vitest files and inspect expected RED failures.
- [x] Implement shared schemas/control store and serialized admission, then activity/workflow/server/CLI integration. Run focused tests to GREEN.
- [x] Add RED tests for timing persistence, local page challenges, compact workflow diagnostics and editor status preserving dirty text. Implement extension/schema/UI changes and verify GREEN.
- [x] Update sidepanel-states.md before UI changes, operational docs/runbook, and version contracts/lockfile. No new dependencies.
- [x] Run typecheck, full tests, package and packaged E2E. Keep logs in this plan's private workspace.

### Task 2: Review and publish the verified release

**Files:** release archive/build stamp, public release notes and verification evidence.

- [x] Independent full-diff review (including new files) using requesting-code-review; resolve important findings with RED/GREEN checks before committing.
- [ ] Commit reviewed implementation on master with all version files at 0.4.62, rebuild exact-commit artifact and verify build stamp/archive hash.
- [ ] Push master; confirm exact-commit CI, publish GitHub v0.4.62 and archive asset, verify release metadata.
- [ ] When no collection/publication is active, activate built Bridge/extension through existing update/install workflow and verify read-only health plus limits status. Do not submit a test comment.
