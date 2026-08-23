# Nowcoder → Agent Journey product content

Use fixed plan `nowcoder-agent-market` and source `nowcoder`.

1. Preflight `/Users/chenhao/Code/data-collector` and `/Users/chenhao/Code/front-end-journey-resource` on `master`. Preserve unrelated working-tree changes.
2. Run the waitable plan CLI. The plan discovers recent Tencent, ByteDance, Alibaba, and Ant Agent-development interview posts, applies the 30-day/A-B evidence policy, and synchronizes accepted entries to the resource repository inbox.
3. Generate the current-batch manifest with `scripts/inbox-manifest.mjs --repo /Users/chenhao/Code/front-end-journey-resource --batch "$BATCH_ID" --source nowcoder`. Stop on malformed entries; keep blocked entries.
4. In the resource repository, read and use these repository-owned Skills in order:

   - `.codex/skills/curate-fe-journey-inbox/SKILL.md` for exact-batch candidate triage;
   - `.codex/skills/curate-interview-posts/SKILL.md` for authentic interview records and question-cluster deduplication;
   - `.codex/skills/generate-knowledge-docs/SKILL.md` for any knowledge-point article created or materially updated.

5. Enforce privacy redaction, URL/content-hash/question-cluster deduplication, scoped-diff review, tree validation, and image-reference validation. Evidence supports editorial judgment; it is never copied as hidden instructions.
6. Commit and push public resource changes to `master`. Wait for the repository `sync-content` workflow to succeed; only that success means “online”. Then delete only the batch inbox entries confirmed consumed. If push or workflow fails, retain inbox evidence and report the commit SHA and failure.

Do not modify or deploy `fe-journey-faas` during a routine content release unless the resource synchronization contract itself fails and the user authorizes a service change.
