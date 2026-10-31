# 牛客面经与备考整理帖

Use the plugin CLI for article actions. Browser UI is for explicit role setup, development inspection or a preserved manual handoff. Collection run contracts do not represent article publication.

## Two browser roles

In each browser's Data Collector sidepanel, select and save its connection role:

- Edge old account: **采集与评论** (`collector`, default).
- Chrome posting account: **牛客发文** (`articles`).

There is one connection per role. The articles connection does not replace the collector. Saving roles and reloads require all relevant work to be idle. Never rotate accounts to get around a limit or verification pause. Reuse each browser's existing login; do not export cookies.

A first installation defaults to collector. Save Chrome as articles first. From v0.4.64, a displaced collector keeps checking health/build information once a minute and can first reclaim its empty channel when another browser's article connection is ready. This vacancy-only intent is persisted before connecting and survives worker restarts, failures and reauthorization; subsequent safe reconnects do not require the article browser to stay online. Admission rechecks vacancy so it cannot displace a newer collector, including one still sending its hello. It never replays a publication or clears a verification pause. Older displaced clients stopped their health checks and may require one reload to receive this correction; verify actual runtimes rather than claiming automatic recovery from the code alone. Explicit “重新连接” remains available for intentional manual takeover.

From `/Users/chenhao/code/data-collector`, use the built CLI:

```bash
node packages/bridge/dist/cli.js nowcoder articles runtime
node packages/bridge/dist/cli.js nowcoder articles account --browser chrome --account 123456789
node packages/bridge/dist/cli.js nowcoder articles limits
```

The account command opens the specified own profile and verifies an owner-only settings entry. Require `kind: account` and the intended userId/nickname. The runtime's browser family alone does not establish the website login. The numeric account ID above is an example; replace it with the intended account ID observed in the current task.

## Prepare a private draft

Keep files under an ignored `_inbox/_reports/...` directory outside the public collector repo. Use an absolute local JSON path (at most128KB). Content example:

```json
{
  "schemaVersion": 1,
  "title": "字节 Agent 全栈一面｜备考题单（整理版）",
  "body": "按不同公开面经整理的备考题单，非本人面试实录\n\n1. Agent 工具调用失败怎么处理？\n\n更多题目整理在 agent-journey.cn",
  "browser": "chrome",
  "accountId": "123456789",
  "provenance": "compiled",
  "sourceUrls": ["https://example.com/verified-source"]
}
```

Select questions from verified full sources. Record source URLs privately; distinguish actual questions from editorial follow-ups. Reference real interview-post structure: short introduction, grouped numbered questions, brief useful takeaway. Do not invent an interviewer, duration, result or personal interview experience for compiled material. Label it clearly as 整理版 or 备考题单. Include `agent-journey.cn` naturally; preserve the user's current choice about prefixes and tracking parameters. Check body/title limits and keep prose concise.

```bash
node packages/bridge/dist/cli.js nowcoder articles draft --file /absolute/draft.private.json
node packages/bridge/dist/cli.js nowcoder articles preview --id article-012345abcdef
```

Use the actual returned article ID. Preview prints the exact local title/body and live verified account without creating a remote draft or clicking publish. Require a fresh matching `entry.preview.identity`, correct browser/account, and review the full text. Editing uses the same draft import with `id` and current `revision`; edits invalidate the preview. Published or unresolved entries cannot be overwritten.

## Publish once, then inspect the original receipt

Public posting requires the user's explicit authorization for this destination and purpose. Existing authorization in the active conversation remains valid; do not introduce a redundant approval round. Select a unique key, keep it in the private task manifest, and use the preview's actual revision:

```bash
node packages/bridge/dist/cli.js nowcoder articles publish --id article-012345abcdef --revision 1 --key article-run-unique-key-001 --browser chrome --account 123456789 --send
```

The plugin records the attempt durably, scans visible recent own posts for exact duplicates, refuses a different existing draft and prepares the editor text. After the full editor echo, it loads a fresh owner profile again and checks the editor's scoped rendered account before clicking the unique native publish button once. It then reads the actual detail URL with matching full title, body and author. Unknown dialogs stop for handoff; unresolved editor and challenge tabs both leave the cleanup registry durably.

Only `publication.state: published` with `evidence: observed` and a verified `receipt.url` means success. A clicked button, timeout or no recent match does not. Repeating the original publish key is a local read-only lookup, including while offline. For an unresolved original attempt:

```bash
node packages/bridge/dist/cli.js nowcoder articles verify --id article-012345abcdef --key article-run-unique-key-001
```

`verify` only reads; it never resends. Absence from the bounded recent-post scan stays uncertain. Do not change the key or create another draft to compensate. Report the exact article ID/key/state and retained page when blocked.

## Shared protection

Articles have at most one attempt per rolling24h across accounts. Comments retain their own limits; both channels share at least120s between attempts and one global verification pause. Query limits before new actions. No fixed timing guarantees avoidance of verification.

If a challenge appears, preserve its exact browser/page and stop both publishing channels. The user completes it manually. Read the common status and only after explicit confirmation use its current generation:

```bash
node packages/bridge/dist/cli.js nowcoder ops limits
node packages/bridge/dist/cli.js nowcoder ops resume --id VERIFICATION_ID --verification-completed
```

Resume routes by the saved channel, rechecks the original account and reconciles the old attempt without submitting again. It does not restart a stopped run. A new challenge keeps the pause. Report the real post link, verified author and any conversion attribution limitation; retain draft and receipt privately.
