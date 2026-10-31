# Nowcoder Article Publishing Design

## Intent and authorization

User explicitly requests Data Collector article publishing, with Edge for the older comment account and Chrome for the newer posting account, eventually publishing one concise ByteDance Agent full-stack first-round question compilation with agent-journey.cn. This is end-to-end implementation and sending authorization; do not add redundant publication approval. Current Chrome UI proves the intended owned account through account-settings/edit controls; exact account evidence stays in the private task report. Observe Edge separately before role configuration. Do not copy cookies/tokens between browsers.

Question selection uses checked Agent Journey public content and real post-format evidence. The post clearly says 整理版/备考题单, combines different records, and does not fabricate a personal interview, offer or interviewer. Raw content/evidence is private under the resource repository ignored report directory.

## Implementation choices

Use existing TypeScript/Zod/Vitest/Chrome extension/Node22 components. Work on master per CLAUDE.md. One reviewed release bump0.4.63. No new dependencies or host permissions. Native execution with one final independent code review; independent runtime and page-adapter tasks may run in parallel once their shared contract is frozen. Preserve unrelated source changes and user tabs.

This is a bounded two-channel feature, not a general browser-farm framework. Existing primary extension connection retains collection/comment behavior and legacy replacement semantics. A separate authenticated article WebSocket channel shares the existing loopback auth and trusted-extension origin checks; it never replaces the primary connection. Exactly one active extension per channel. A local extension connectionRole setting chooses collector(default) or articles, saved explicitly through sidepanel settings; switching roles requires that browser's operations be idle. The new article channel advertises browserFamily and runtimeId. Chrome/Edge are detected from the actual extension environment; no spoofing.

Setup occurs only when all existing collection/plan/directed/comment/article operations are idle. Configure Chrome as articles and Edge as collector; verify both channels and own identities. A brief initial default connection during a first Chrome install must not run work; restore Edge's primary connection before enabling sends. Prefer existing installation/update tooling; inspect Chrome extensions UI if initial installation is required.

## Shared wire contract

Create packages/shared/src/nowcoderArticles.ts and export it. BrowserFamily is chrome|edge; connectionRole is collector|articles. Account identity: {userId:string digits, nickname:string, profileUrl:https://www.nowcoder.com/users/ID, observedAt:ISO}. ArticleDraft: {schemaVersion:1,id:article-<12hex>,revision:positive,title:1..50 Unicode chars,body:2..24000 chars,browser:BrowserFamily,accountId:digits,provenance:'compiled'|'personal',sourceUrls:https[]<=30}. Store a SHA256 contentHash over title/body/identity binding. Imported drafts may omit id/revision for creation; IDs are generated locally, never from guessed site IDs.

ArticleAction discriminated union:
- account: {kind:'account',expectedAccountId?:digits}; page probe navigates only own UI.
- publish: {kind:'article-publish',title,body,expectedAccountId,provenance}; only sent after durable admission and --send.
- verify: {kind:'article-verify',title,body,expectedAccountId,postUrl?:validated Nowcoder detail URL}; read-only.
ArticleResult union: account {kind:'account',identity}; published {kind:'article-published',receipt:{url,title,body,accountId,observedAt},diagnostics?}; verified/not-found {kind:'article-verified',identity,receipt?:...}; attention uses existing diagnostics/submission fields and optional actual tabUrl. A receipt must be bound to exact normalized title/body and expected author. Wire names article.execute/article.result, hello remains extension.hello with new capability nowcoder-article-publishing-v1 and browserFamily(optional for legacy). Shared schemas stay strict and legacy packets remain valid.

## Article lifecycle and API/CLI

New private article store in configDir/nowcoder-articles. Strict records, revision/content hash binding, draft edits invalidate preview; atomic0700/0600 persistence. Reuse OperationPublication with optional postUrl for article attempts. Same key returns original durable result even offline/paused; changed content/revision with reused key rejects. Uncertain/dispatching prevents new keys. Write dispatching before any potentially publishing action. Never infer success from clicking/toast alone.

Authenticated routes under /v1/nowcoder/articles: GET list, POST import/create, GET /ID preview, PUT /ID edit, POST /ID/publish {revision,contentHash,key,send:true}, POST /ID/verify {key}, GET /runtime, POST /account {expectedAccountId?}, GET /limits. Preview is local content plus live account identity; it does not write a remote draft. Publish again probes account through the selected article channel; mismatches/login/verification/dirty editor refuse safely. CLI: nowcoder article list|draft --file ABS|preview --id ID|account --browser chrome [--account ID]|publish --id ID --revision N --key KEY --browser chrome --account ID --send|verify --id ID --key KEY|limits|runtime. Browser/account must match saved draft; publish needs explicit --send and required flags are validated before any HTTP request. Read-only original-key inspection remains possible while offline.

The extension owns temporary account/editor/detail tabs, never refreshes/closes user tabs. Account probe identifies the current user's own profile using navigation/avatar and own account-settings/edit controls, not post-author text or hidden credentials. The account is rechecked immediately before publication. Only empty or exactly matching draft contents may be used; never overwrite another draft. Use supported Slate beforeinput/input events and exact text/button enabled checks, compatible with the actual composer. The observed canonical editor is https://www.nowcoder.com/creation/write/article. No guessed alternate publishing URLs or raw authenticated site API requests. If the site has a distinct final confirmation stage, inspect it and click once at each semantically distinct stage; never blindly click publish twice. CAPTCHA, access restriction, draft conflict, account mismatch or ambiguous UI stops with preserved owned handoff page. Handoff/focus failures cannot erase original verification evidence.

Verify uses only the exact saved post URL when available, otherwise the expected user's own recent posts plus one unique matching candidate. Require exact full post title/body/author, not just a profile card excerpt. If ambiguous or missing, keep uncertain, do not resend. Preserve observed timing only.

## Limits, verification and concurrency

Retain comment policy120s/5rolling-hour/20rolling24h. Add article cap1attempt/rolling24h across all accounts; changing account does not reset it. A common minimum120s between admissions uses both channels. Global verification pause covers both channels; a challenge never causes automatic account/browser switching.

Extend publishing history with channel(comment default for legacy, article for posts), article owner IDs and validated composer/detail references. Both channels feed known-request-ID durability validation. Comment usage counts only comment attempts; article usage counts only article attempts. Global interval uses all attempts. A shared publication-admission queue spans both stores around budget check -> durable attempt -> known-history acknowledgement, closing concurrent cross-channel admission races. Corrupt/missing-after-use histories fail closed. Old journals are not reset or rewritten wholesale.

Extend verification pause with optional channel/articleId/browser/account binding and a reference schema that accepts the canonical editor. Common ops resume requires explicit user-completed=true and current generation ID; route article pauses to article readonly verify and comment pauses to existing context reconciliation. Repeated challenge generations retain linkage to the original attempt; stale resume cannot clear a newer challenge. Synchronous in-memory pause fence is checked immediately before both transports dispatch. Updating drafts, quota, reconnecting, or starting another channel never clears a pause. Recovery never resumes a stopped run.

## Integration and delivery

Article activity can coexist with an Edge comment workflow; article routes do not take the comment workflow mutation fence, but share global update/restart protection and verification latch. Article busy is included in auto-update/restart/extension reload fences and read-only health. Existing collection remains primary-only. Secondary cannot submit collection results to primary handlers or resolve another socket's pending RPC.

Sidepanel adds only explicit connection-role settings and status (no new send button); preserve dirty text and sticky errors. CLI is the publishing surface. Update docs/sidepanel-states.md before settings UI edits, operations docs and canonical skill reference. Do not package/update while any plan/job/persistence/runtime operation is active; verify all sources, not just comment health.

Run focused RED/GREEN (account mismatch, dirty editor, missing send, invalid receipt, click once, challenge before/after click and during waits, handoff failure, wrong-socket result, both sockets coexist, role-switch busy, cross-channel budgets, history loss, restart/replay/stale resume). Then typecheck, full tests, package, packaged E2E and independent full-diff review. Commit one0.4.63 release, rebuild exact SHA, push master, exact CI and release asset hash. Configure both browsers only while idle and prove runtime/build/identity before one live article publish. No other live publishing tests. Confirm real post full body/link and show a proof screenshot; stop for manual verification if required.
