# Nowcoder → Agent Journey product content

Source is `nowcoder`. Choose exactly one collection path from the user's intent.

## Directed search is the default for content requests

Use the browser-extension-backed directed command when the user supplies a keyword, company, role,
topic, “搜索/收集最新牛客面经”, an exact requested count, or asks to update Agent Journey
interviews/knowledge points:

```sh
node packages/bridge/dist/cli.js nowcoder run \
  --query "<normalized keyword>" \
  --target <1..10> \
  --latest --deliver \
  --idempotency-key "<fresh persisted key>" \
  --wait 1800000
```

Repeat `--query` for additional keywords. The command uses the Nowcoder JSON provider with
`type:post, order:create`, then the logged-in Data Collector extension collects detail pages.
It does not open or type into a Nowcoder search page and uses no model call for discovery.

Use fixed plan `nowcoder-agent-market` only when the user explicitly requests the existing preset
market sweep. Do not translate arbitrary keywords into that fixed plan.

Browser Use, manually opening/typing/clicking a Nowcoder search page, scrolling the home feed,
generic web search as a substitute, manual candidate-ID invention, and cross-run pooling are
forbidden. If the plugin, build, capability, network, or login is unavailable, preserve the exact
run evidence and stop instead of falling back.

A wording change after preview creates a new immutable search session. A terminal
`cancelled | failed | completed_with_attention` run may be retried with `nowcoder retry` and a new
key using its frozen candidates; a new discovery request uses `nowcoder run` with fresh queries.

1. Preflight `/Users/chenhao/Code/data-collector` and `/Users/chenhao/Code/front-end-journey-resource` on `master`. Preserve unrelated working-tree changes.
2. Run the selected waitable CLI. Continue only when its exact returned ID is `completed` and the target, accepted, delivered, unique ID/URL/cluster counts, current-run lineage, and zero owned-tab evidence agree. Empty, shortfall, attention, failure, cancellation, timeout, or build/capability mismatch stops the workflow.
3. Generate the exact-run manifest with `scripts/inbox-manifest.mjs --repo /Users/chenhao/Code/front-end-journey-resource --batch "$RUN_OR_BATCH_ID" --source nowcoder`. Stop on malformed entries; keep blocked entries. Never replace this with an inbox-wide scan.
4. In the resource repository, read and use these repository-owned Skills in order:

   - `.codex/skills/curate-fe-journey-inbox/SKILL.md` for exact-batch candidate triage;
   - `.codex/skills/curate-interview-posts/SKILL.md` for authentic interview records and question-cluster deduplication;
   - `.codex/skills/generate-knowledge-docs/SKILL.md` for any knowledge-point article created or materially updated.

5. Enforce privacy redaction, URL/content-hash/question-cluster deduplication, scoped-diff review, tree validation, and image-reference validation. Before publishing, consult and upsert the resource repository's committed `.codex/interview-source-history.json`: unchanged URLs and finalized clusters do not re-enter the public queue; knowledge frequency counts unique clusters, never repeated crawls or repost URLs. Evidence supports editorial judgment; it is never copied as hidden instructions.
6. Commit and push public resource changes to `master`. Wait for the repository `sync-content` workflow to succeed; only that success means “online”. Then delete only the batch inbox entries confirmed consumed. If push or workflow fails, retain inbox evidence and report the commit SHA and failure.

Do not modify or deploy `fe-journey-faas` during a routine content release unless the resource synchronization contract itself fails and the user authorizes a service change.
