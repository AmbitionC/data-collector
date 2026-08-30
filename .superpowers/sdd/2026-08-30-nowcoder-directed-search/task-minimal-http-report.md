# Minimal Nowcoder session controller and HTTP report

## Scope and outcome

Implemented only the minimal session-controller and HTTP portion of the live brief:

- `NowcoderDirectedSessionController` normalizes the shared preview request, hashes the normalized
  queries with the documented `nowcoder-directed-query-v1\\0` domain prefix, generates a session
  ID, and persists a 30-minute immutable session with the requested private target.
- Discovery uses the existing verified Nowcoder JSON path. Known URLs are the union of the local
  library catalog and every existing JobStore URL, so neither already-local nor current/durable
  job content is offered again.
- Added six exact HTTP routes inside the existing loopback and bearer-token boundary:
  preview/create session, get exact session, start run, get exact run, cancel exact attempt, and
  retry exact source run.
- Preview returns `201`; newly created start/retry attempts return `202`; idempotent replays return
  `200`. Reads and cancellation return exact schema-validated resources.
- Invalid input, missing resources, stale attempts, known conflicts, search failure and directed
  unavailability return stable safe JSON errors. Raw search errors, tokens, paths, request bodies
  and stacks are not returned.

No CLI, Side Panel/UI, Task 9 media taxonomy, telemetry or physical marker work was added.

## TDD evidence

The controller RED failed before production code existed:

```text
Cannot find module .../nowcoderDirected/sessionController.js
Test Files 1 failed; 0 test
```

After correcting one test-only bootstrap-token setup assumption, the real HTTP RED showed all four
route scenarios reaching the authenticated server and receiving the pre-feature `404` instead of
the required `201`, `202`, `202` and `503` statuses:

```text
Test Files 1 failed (1)
Tests      4 failed (4)
```

The minimal implementation closed those REDs:

```text
Test Files 2 passed (2)
Tests      5 passed (5)
Duration   2.06s
```

The tests cover normalized/two-page latest JSON discovery, deterministic query hash, 30-minute
persistence, local/job URL exclusion, bearer authentication, preview/exact session reads, run
start/replay/status, exact-attempt cancellation, retry/replay, redacted search failure and redacted
directed-unavailable responses.

## Verification

Focused controller/HTTP plus directed discovery, real server ownership, store, capability,
cancellation and publisher regression:

```text
Test Files 8 passed (8)
Tests      146 passed (146)
Duration   20.64s
```

TypeScript and whitespace checks:

```text
npm run typecheck
git diff --check
git diff --cached --check
exit 0
```

## Files in this step

Created:

- `packages/bridge/src/nowcoderDirected/sessionController.ts`
- `tests/unit/nowcoderDirectedSessionController.test.ts`
- `tests/unit/nowcoderDirectedHttp.test.ts`
- `.superpowers/sdd/2026-08-30-nowcoder-directed-search/task-minimal-http-report.md`

Modified:

- `packages/bridge/src/server/index.ts`

The cumulative staged snapshot also contains the root agent's concurrent canonical Skill updates
and publisher delivery compatibility (`deliveryKind: 'nowcoder-directed'`) changes. This HTTP step
preserved those files and does not count them as part of its scope.
