# Invest Journey 引流发布（雪球引流 + 公众号深度）

2026-11-05 用户定：雪球负责引流、公众号负责深度文章，全程自动化、用户不做手动操作；
已一次性授权「云端机器审核通过即自动发布」。小红书排除（无法浏览器自动化）。

## 链路

```
invest-model outreach.yml（云端出稿 + 审核闸）→ <invest-model>/outreach/outbox/<id>/
Bridge 每 15 分钟：git pull → 选到期稿件 → 再核 → 发文连接上的插件发布 → outreach/receipts/<id>.json → 只提交回执目录并 push
```

稿件与回执契约以 invest-model `outreach/README.md` 为准。本机工作区默认 `~/code/invest-model`，
不存在则不启用（`investOutreachRepoPath` 可改）。私有台账在配置目录 `invest-outreach.json`。

## 保护（与牛客发布同一套思路）

- 发前先落 dispatching；只认页面上观察到的成功。点了但没看到 → uncertain，**整体暂停、不重发**；
- 登录失效 / 验证码 / 限制 → 整体暂停，原稿保留，用户处理后 `POST /v1/outreach/resume {"handled":true}`；
  台账里仍有 uncertain 时恢复后会重新暂停，必须先到平台核对；
- 晚于 notAfter 写 expired、复核不过写 refused，均不发；明确没点发布的失败最多试 3 次再写 failed；
- 两次发布间隔 ≥120 秒、每渠道滚动 24 小时 ≤3 篇（`PUT /v1/outreach/policy`）。
- 发布走「发文」连接（同一浏览器、同一认证通道），消息 `outreach.execute / outreach.result`，能力
  `invest-outreach-publishing-v1`；页面只在插件自开的标签页里操作，出问题时交接保留。

## 渠道就绪

`OUTREACH_READY_CHANNELS`（shared/investOutreach.ts）是随版本发布的可发渠道清单，**页面操作在真实已登录
后台核对过之后才加入**。0.4.72 时为空：只有登录状态核对，发布一律返回 CHANNEL_NOT_READY，Bridge 不碰稿件。

接口：`GET /v1/outreach`（状态与台账）、`POST /v1/outreach/run`（立即跑一轮）。
