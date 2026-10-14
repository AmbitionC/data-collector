# 跨公司面经定期采集与知识加工：恢复检查点

日期：2026-10-13。用户已授权实现；本文件记录已核对的接口与边界，不代表功能已实现或测试通过。

## 已保存的隔离环境

- Data Collector：本 checkout 的 `codex/company-review-schedule`，基线 `65eb01ad83e6838411e4834e2a0d491147d2e93c`。
- 资源仓库：`../resource-interview-knowledge` 的 `codex/interview-knowledge-idempotency`，基线 `3552091e8e3fe1407d62668183e752624125a534`。
- 原仓库的未提交修改不得覆盖；现有热帖 PR1 与本次任务保持独立。

## 用户已批准的功能边界

1. 定期跨公司采集面经，按每公司的已上架数量与合格待审库存总量优先补低库存；同库存持久化轮转。
2. 面经加工联动现有 `generate-knowledge-docs`，相似知识复用；来源幂等增权，分类内高权重在前、同权重稳定。
3. 复用 Bridge 每日北京时间 09:00 与 15 分钟检查，不新增 manifest 权限或扩展定时采集；电脑休眠不采。
4. 新调度默认关闭，新增公司目标与仅待审核模式；本轮不启用持续采集，不合并、发布、安装或重启用户进程。
5. 复用 URL/contentHash/cluster 去重。明确限速，登录、验证码、429 停批，保留批次证据。

## Bridge 已核对的最小接入位置

- `packages/bridge/src/plans/service.ts`：`planDueState`、`runDuePlans`、`discoverRound`、`selectSaved`、`createAttachAndDispatch`、`dispatchNextNowcoderJob`、`finalizeExactTen`。
- `packages/bridge/src/plans/store.ts` 与 `packages/shared/src/plans.ts`：批次、模式、公司目标必须持久化并校验，重启不能降回自动交付。
- `packages/bridge/src/plans/nowcoderHistory.ts`：新待审核批次的 job 不能被以后普通计划的 pending 池选中。
- `packages/bridge/src/server/index.ts`：现有依赖注入已提供 pending 本机库、来源筛选、原子同步等链路。
- `finalizeExactTen` 当前确实调用 `syncNowcoderJobs` 或 `syncJob`，会进入 commit/push；新 review-only 模式必须在这一边界隔离，deliveryIds 保持空。
- `selectSaved` 当前混入 `pendingNowcoderJobs(batch.id)`；待审核模式应固定本批来源，其他计划也必须排除被待审核批次占用的来源。
- 现有选择以四家主公司日期轮转。库存优先和同库存轮转应使用可检查的持久状态，不靠随机或只按当天日期。

## 资源侧交付合同

- 复用 `heat`、`interviewBaseHeat`、`interviewCount`，不新增 weight 字段。
- 核对 `scripts/interview-source-history.mjs` 的 cluster/process 计数：相同证据簇/转载只计一次，不同簇即使同 process 也分别计数。
- `scripts/sync-interview-topic-weights.mjs` 的 prepared 来源投影只允许本批明确审核的 sourceId/articleKey；独立检测 treeOrderChanged，修复数值未变但顺序失效的情况。
- 新知识显式 interviewBaseHeat=0，旧知识保留 legacy 基线；撤销来源后重算。
- skill 的真实执行证据接在加工阶段；浏览器采集阶段不得假称已执行知识 skill。
- `content-review.mjs` 对逐题来源/知识关联证据做一致性校验；缺质量/skill 证据必须阻断发布。

## 恢复后首先固定的行为测试

- 默认调度关闭；未授权不采；同日不重复；离线/休眠不制造虚假完成记录。
- 低库存公司先选；同库存轮转重启后仍有效；库存未知不得当零或回退为字节优先。
- review-only 即使达到十条也不会调用同步/commit/push；后续普通 pending 池和重启恢复不能带走这些条目。
- 限速、验证码、429 立即停止本批，保留精确原因和未执行项。
- 同源/转载去重，重跑零 diff，别批 prepared 不计，撤销重算，同权重稳定，缺质量审核阻断发布。

## 初始恢复状态

- 初次 pwd/date 成功：2026-10-13 16:32:40 UTC。
- 源码读取期间出现一次 `CreateProcess: Failed to create unified exec process: exec-server transport disconnected`。
- 单次最小恢复检查成功：2026-10-13 16:39:13 UTC；之后源码读取继续成功。
- 未调用 Chrome；未能据此确定底层故障根因。
- 主任务尚未写生产代码或运行新测试；不把源码阅读或隔离 checkout 当成实现完成。

## 实施进展

隔离分支生产代码与实际RED/GREEN回归已落地。上述“主任务尚未写生产代码”仅描述初始恢复检查点，后续状态以implementation plan与验证报告为准。库存私有账本按资源合同从显式仓外绝对路径读取；新调度仍默认关闭。资源草稿PR49确认HEAD f7d206bfaa3dc1a5c80b286afca766edb3950058，133测试通过，未修改公开文章、目录或图片。
