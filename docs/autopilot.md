# 无人值守发布任务

评论、发文都建在 `packages/bridge/src/autopilot/core.ts` 上。一个任务就是一个短进程：加锁、读小状态、跑一轮、写日志。调度和重试是代码，模型只通过 `codexJson` 在全新无工具上下文里写一次内容。

## 公共部分

- `runJob`：单机锁、私有状态、异常转失败记录、日志，闲置轮次不写日志。
- `codexJson`：一次性结构化生成，带超时。
- `jobStatus` / `jobIssues`：按日志汇总近 24 小时，发现 token 超预期、连续失败、长时间没有成功时，由在线任务每小时最多通知一次。随时可看 `nowcoder ops autopilot-status`。

## 接入新渠道

每个渠道只写三件事：

1. 取材：从哪里拿下一条内容，已用过的怎么排除。
2. 生成与校验：提示词、JSON 结构、确定性规则。规则挡不住的内容不发。
3. 发送：走渠道自己的台账，先落记录再点击，只认观察到的回执，结果不确定绝不重发。

约定：发送前先计入尝试次数，失败的渠道不能每分钟调用模型；默认只演练，`--send` 才发布；验证码、登录、限制一律停下交给用户。

## 投资产品（Invest Journey）

发布层已有 `packages/bridge/src/outreach/service.ts`，保护规则同上，并要求用户逐篇批准，详见 [invest-outreach.md](invest-outreach.md)。接入 `runJob` 时只替换取材和生成，生成结果进入待批准稿件，**不绕过逐篇批准**。雪球和公众号的页面操作尚未核对（`OUTREACH_READY_CHANNELS` 为空），这一步要先做。评论类互动没有对应的发送台账，需要另行实现。

## 阻塞提醒

需要用户处理的阻塞（验证码、风控、授权、登录、连续失败、结果不确定）会发 Mac 通知并发邮件：优先走 fe-journey-faas 的 `POST /pos/notify/alert`（运维告警发信，收件人为 faas 的 PAY_NOTIFY_EMAIL，配置 `<config>/notify-faas.json`），没配时才用 `<config>/notify-email.json` 的 SMTP，每个事件只发一次，记录在 `nowcoder-autopilot/notify.log.jsonl`。用户自己运行 `scripts/setup-email-alerts.sh` 填入 HEALTH_API_TOKEN。面经采集会话把这类阻塞写成交接文件中以「需要用户：」开头的一行，运行器据此提醒。
