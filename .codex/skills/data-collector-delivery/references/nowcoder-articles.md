# 牛客面经与备考整理帖

写法和情绪表达另见 [活人感与情绪](nowcoder-voice.md)（2026-11-09 用户要求评论和文章都带点情绪和活人感）。

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

Keep files under an ignored `_inbox/_reports/...` directory outside the public collector repo. Use an absolute local JSON path (at most128KB).

### 标题、复盘与网站承接（2026-11-01 用户反馈）

- **标题只写公司、岗位、轮次**，例如 `腾讯 Agent 开发一面`。不加 `｜我的备考题单`、`整理版`、`复盘` 等后缀。compiled 内容需要的准备/模拟语境和 `备考题单` 标识放在正文自然表达，不挤进标题，也不写资料来源式开场。
- **复盘让读者知道具体在补什么。** 一两句话点出题目、没讲清的具体内容或准备补的做法。仅写“我先补第3、5题”“效果好不好得有验证方法”“怎么收场”，读者仍不知道测什么、停下以后做什么。按实际语境直说，例如：`RAG 评测这题，我准备拿同一组问题比两套方案，分别看资料有没有找对、答案有没有答对`。涉及步数上限，就说保存什么结果、如何说明还没完成、用户下一步能做什么；不堆抽象总结，不捏造个人表现。
- **网站入口承接一个具体问题。** 确需且适用规则允许自荐时，先核对能帮助读者继续复习的已上线全文，在讲对应题目或练习时简短说明自己整理或维护的具体内容，入口只写一次 `agent-journey.cn`，随后继续把方法讲清楚。文章结尾落在具体复习动作，不固定追加资料、访问或注册尾句。完整回答留在本站，不靠留半截答案换点击；不能把题单加域名当成有深度的分享，也不冒充无关路人亲测。按 [推荐参考](nowcoder-recommendations.md) 核对需求、关系与规则；这不是每篇照抄的文案，没有合适承接时可以不带入口。
- 写完通读标题、复盘和带域名的段落：读者能否直接说出“这是什么面试”“哪道题需要补什么”“网站能接着帮什么”。保持已认可的第一人称口吻、短段落和实际空行。用户说“本次先这样、下次注意”时，只更新后续规范，不改已发文章。

Content example (adapt the specific questions and site use to verified sources):

```json
{
  "schemaVersion": 1,
  "title": "腾讯 Agent 开发一面",
  "body": "我的备考题单先记这两问\n\n1. RAG 的效果怎么测，检索结果和最终答案分别看什么？\n\n2. Agent 用完步数还没完成，哪些结果要保留，怎么告诉用户？\n\nRAG 评测这题，我准备拿同一组问题比两套方案，分别记录资料有没有找对、答案有没有答对。我在 agent-journey.cn 整理的评测拆解也按这两个环节展开；练的时候先留住答错的那几条，逐条查是哪一步出了问题",
  "browser": "chrome",
  "accountId": "123456789",
  "provenance": "compiled",
  "sourceUrls": ["https://example.com/verified-source"]
}
```

Select questions from verified full sources. Record source URLs privately; distinguish actual questions from editorial follow-ups. Reference real interview-post structure: short introduction, grouped numbered questions, brief useful takeaway. Use the account's first-person preparation/practice voice without a source-library opening. Do not invent an interviewer, duration, result or personal interview experience for compiled material. Keep its preparation/practice context clear in the body, including a natural 备考题单 label where required; keep the title to company, role and round. When a site mention is warranted and allowed, use `agent-journey.cn` with a concrete, verified use and truthful relationship; preserve the user's choice of no prefix or tracking parameters. Check body/title limits and keep prose concise. The example illustrates wording, not a preapproved public post; verify the stated content for each actual draft.

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

Articles have no fixed daily maximum (`policy.maxPer24Hours: null`); the rolling24h count remains an audit metric. The user corrected this policy on 2026-11-01: “一天至少发一次” is an operating target, not a daily maximum. Publish when explicitly requested. Do not defer an immediate request into an automatic overnight post, or create a posting schedule without the user's timing instruction. Comments retain their own limits; both channels share at least120s between attempts and one global verification pause. Query limits before new actions. No fixed timing guarantees avoidance of verification.

The company scope includes Alibaba, Tencent, ByteDance, Meituan, Kuaishou and Pinduoduo; choose verified relevant sources across companies. Use short section labels, an actual blank line between sections, and one question or point per paragraph. Check the rendered post's real line breaks after publishing, not only whitespace-normalized body equality. One or two closing sentences may convey a source author's recorded interview impression (attributed) or an editorial preparation reflection. Keep compiled notes identified as compiled; only confirmed firsthand material supports personal performance claims.

If a challenge appears, preserve its exact browser/page and stop both publishing channels. The user completes it manually. Read the common status and only after explicit confirmation use its current generation:

```bash
node packages/bridge/dist/cli.js nowcoder ops limits
node packages/bridge/dist/cli.js nowcoder ops resume --id VERIFICATION_ID --verification-completed
```

Resume routes by the saved channel, rechecks the original account and reconciles the old attempt without submitting again. It does not restart a stopped run. A new challenge keeps the pause. Report the real post link, verified author and any conversion attribution limitation; retain draft and receipt privately.
