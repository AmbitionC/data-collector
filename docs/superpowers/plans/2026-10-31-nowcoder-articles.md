# Nowcoder Articles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Ship account-bound Chrome article publishing alongside the existing Edge collector/comment channel, then publish one verified question-compilation post.

**Architecture:** Add an isolated articles WebSocket channel and a strict private article journal/CLI. Both publication kinds share global verification and admission serialization, but retain separate attempt budgets. Keep deterministic account/editor/receipt steps inside the extension.

**Tech Stack:** Existing TypeScript, Zod, Vitest, Node22, Chrome extension APIs. No new dependencies or host permissions.

**Spec:** docs/superpowers/specs/2026-10-31-nowcoder-article-publishing-design.md

**Execution decisions:** preview is POST `/v1/nowcoder/articles/:id/preview` because it performs a live identity probe and saves its binding. Internal page preparation (`article-prepare`/`article-prepared`) cannot cross the public transport; a fresh own-profile proof follows full editor echo before the only send-capable call. The editor's scoped rendered account is a corroborating contradiction fence (its account menu is hidden by the site's normal layout). Review found and regression-tested immediate pause observation, word-boundary normalization and durable retention of both editor/challenge tabs. Current base includes the unrelated docs-only merge d96a907; it is preserved.

## Global Constraints

- master only; preserve unrelated changes. One version0.4.63 code commit and exact-SHA build/release.
- Comments120000ms/5rolling-hour/20rolling24h; articles1attempt/rolling24h across accounts; common minimum120000ms and global verification pause.
- Chrome target account verified in owned-profile UI; verify the distinct Edge identity separately. Account/browser mismatch always refuses.
- No cookie/token export, CAPTCHA solving or account routing to evade restrictions.
- Only one final authorized public article; no other live send tests. The content is explicitly a compilation, uses agent-journey.cn, and invents no personal interview.
- All campaign/raw content/evidence stay in ignored private reports. No public model calls or new permissions.
- No packaging or reload while any job/plan/directed/comment/article activity is running.

## Review Focus

- Secondary connect/reconnect cannot kick primary, resolve its RPC, or send collection messages.
- Account changes/dirty editor/foreign detail page must stop before sending or claiming a receipt.
- Cross-store concurrent admissions must share the interval; history loss/restart must not reset allowances.
- A verification appearing during account/navigation/receipt, or failing handoff, cannot be erased; stale resume cannot clear new pause.
- Existing default-role clients and scheduled Edge comment workflow remain compatible, and both runtimes fence updates/reloads.

---

### Task1: Shared contracts and dual-channel runtime

**Files:** packages/shared/src/nowcoderArticles.ts,index.ts,protocol.ts; packages/bridge/src/server/websocket.ts; packages/bridge/src/articles/transport.ts; packages/extension/src/background/connection.ts,index.ts; packages/extension/src/sidepanel/index.ts,index.html; docs/sidepanel-states.md; focused shared/transport/connection/panel tests.

**Interfaces:** Export NOWCODER_ARTICLE_CAPABILITY='nowcoder-article-publishing-v1', browserFamilySchema, NowcoderAccountIdentity, articleDraftSchema, ArticleAction, ArticleResult, articleActionSchema, articleResultSchema. Internal page result adds kind:'article-clicked' with diagnostics, never accepted as a public published receipt. All unions/names match the spec. The secondary channel query is channel=articles; omitted channel is legacy collector. WebSocket authorization metadata gains channel:'collector'|'articles'.

ArticleTransport constructor(runtime:()=>{socket?:WebSocket,ready:boolean,capabilities:string[],browserFamily?:'chrome'|'edge',runtimeId?:string},timeout=90000); assertAvailable(browser?), execute(action,requestId,browser?), receive(socket,requestId,raw), disconnect(socket?), busy getter. It uses article.execute/result and only resolves the original socket. Backend server integration is owned by root after the transport patch lands.

BridgeConnection gains optional dependencies.browserFamily and setConnectionRole(role:'collector'|'articles'):Promise<void> plus setArticleHandler(handler:(action:ArticleAction)=>Promise<ArticleResult>). Store key connectionRole defaults collector. Articles WebSocket URL adds channel=articles; hello advertises browserFamily and new capability only for new compatible Bridge. Role switching is blocked by background active-operation checks before invoking setConnectionRole; primary collection behavior unchanged. Sidepanel role selector saves explicitly and shows errors without overriding drafts. Root adds final article runner hookup after runtime worker finishes background/index.ts.

- [x] Write contract/role/channel/request-isolation tests; run targeted RED before implementation.
- [x] Implement strict shared contracts in root, then freeze exported interfaces for runtime/page tasks.
- [x] Implement isolated authenticated channel, extension role persistence and minimal settings UI; update sidepanel-states before UI edits.
- [x] Verify targeted GREEN, legacy connection tests and type safety. No commits/build/package by workers.

### Task2: Deterministic account, composer and receipt adapter

**Files:** packages/extension/src/background/nowcoderArticles.ts,nowcoderArticlesPage.ts; tests/unit/nowcoderArticlesRunner.test.ts,nowcoderArticlesPage.test.ts; fixture HTML if useful.

**Interfaces:** export runNowcoderArticlePage(action:ArticleAction):Promise<ArticlePageResult> (serialized helpers stay inside function). export NowcoderArticlesRunner with constructor(tabs:{create(url):Promise<{id?:number}>,wait(id):Promise<void>,execute(id,action):Promise<unknown>,get?(id):Promise<{url?:string}>,close(id):Promise<unknown>,handoff(id,url):Promise<unknown>}); run(action):Promise<ArticleResult>,busy getter. Runner performs readonly own-account probe immediately before publish, checks expectedAccountId, owns editor/detail tabs, and translates internal clicked proof to only a full observed published receipt or attention. It does not access cookies or hidden application auth state.

Known Chrome editor: canonical /creation/write/article; native UI has title text field(max50), Slate contenteditable #nc-e-textarea-1, MD编辑器, 存草稿, footer发布. Publishing may navigate; preserve actual clicked diagnostics when available and only read afterward. Account profile namespace /users/ID has an owner-only /profile/ID/account link; document title gives nickname. Expected account is mandatory for publishing. Preserve owned pages on all attention including failed focus.

- [x] Write RED cases for missing login/ownership, mismatched account, dirty editor, exact draft echo, click once, compiler disclosure, no duplicate, challenge before/after and during waits, foreign source/author/body, navigation interruption and failed handoff.
- [x] Implement minimum deterministic helpers and bounded waits. No raw authenticated site requests or guessed UI final-confirmation clicks.
- [x] Verify targeted GREEN using local fixtures only. Return DOM assumptions/limits for root live check; no browser or public publishing by workers.

### Task3: Article journal, shared protection and authenticated CLI

**Files:** packages/bridge/src/articles/store.ts,activity.ts,cli.ts; packages/bridge/src/operations/publishingControl.ts,store.ts,activity.ts; packages/shared/src/nowcoderPublishing.ts,nowcoderOperations.ts; server/index.ts and bridge/cli.ts; article/control/integration tests; operations docs and canonical skill reference.

**Interfaces:** ArticleStore(root,admissionQueue,hooks) provides list,get,create/update,beginPublication,finishPublication,reconcile; strict version/hash/revision/identity bound records, OperationPublication plus optional postUrl. Common PublicationAdmissionQueue.run<T>(()=>Promise<T>) shared by both stores. PublishingControl history accepts comment(default)/article channels with ops-/article- owner IDs and validated reference URLs, status()/articleStatus()/assertCapacity()/assertArticleCapacity(), same persistent known-request-ID checks and global pause. Verification pause optionally carries channel/articleId/browser/account and accepts canonical editor; common ops resume dispatches to article readonly reconciliation when channel article.

ArticleActivity(store,transport,control) exposes account,preview,publish,verify,resumeVerification and busy, with a final synchronous pause fence before execute. Preview hashes/revisions bind live expected account; no remote draft write. Publish import/browser/account/--send validations happen before HTTP; key replay readonly even offline. Runtime route gets only article socket, build/capability/browser checked. A failed/uncertain attempt stays stopped.

- [x] Add RED tests for idempotency, malformed journal, missing send, account-bound preview expiry/content revisions, postURL/author receipt mismatch, per-kind budgets, concurrent common interval, missing histories, original-key replay during pause, generation-safe article resume and cross-channel update fences.
- [x] Implement journal+protection+activity and wire server routes described in spec. Keep secondary handlers entirely separate from main collection socket.
- [x] Add CLI article subcommands and authenticated API integration with fake extension WebSockets; verify both runtimes stay connected and requests reach only intended channel.
- [x] Add runner hookup/role busy to extension auto-reload. Keep editor UI without send button. Update skill/runbook/docs after reading applicable skill-edit guidance.
- [x] Run targeted GREEN and one independent full-diff review; fix Important findings with regression checks.

### Task4: Exact release and authorized live post

**Files:** version manifests/identity/lockfile, extension artifacts, private source/draft/publication/verification report, public release notes.

- [x] Bump all required versions to0.4.63; npm install --package-lock-only with Node22.
- [x] Run typecheck, full tests, package and packaged E2E; verify all active jobs/plans/runtime work are idle before artifact swap.
- [ ] Commit reviewed code master, rebuild exact SHA, push, verify exact CI and publish release/ZIP; download and verify hash.
- [ ] Verify Chrome extension installed and configured articles, Edge collector restored, both exact builds; readonly account probes match expected distinct users. Preserve unrelated tabs/drafts.
- [ ] Import the edited concise compiled question post from private evidence, preview account and exact content, publish once via article CLI --send under user authorization, retain original key/run.
- [ ] Readonly verify actual full post/title/body/author and real link. Save proof screenshot via supported browser API, report release+post URL. If verification/manual step blocks, preserve page and exact evidence; never claim success or resend.
