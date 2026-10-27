# 牛客热帖私有素材

手动读取用户当前可正常访问的牛客热榜/讨论列表，供内容线 2「热帖观察」使用。不会生成或发布运营帖。现有面经、自主总结流程独立。

## 使用

1. 在 Chrome 打开牛客首页的热榜或讨论信息流，正常关闭站点弹窗；遇到登录/验证码由用户处理。
2. 现有 Data Collector 侧栏点「热帖素材」→「读取当前牛客列表 / 重试」。不自动滚动、翻页或打开详情，不复制全文。
3. 默认均不勾选。打开原文核对需要的条目，勾选；可将来源短摘标为「发帖人自述（未核实）」，人工勾选焦虑/困惑/不服/反差/释然，填写编辑灵感笔记。
4. 点「保存勾选的 N 条素材」。逐条等候本机库落盘回执；失败保留选择可重试，已成功条目跳过。
5. 在「已入库」查看、打开原文或定位文件；「热帖素材」页的「导出私有素材 JSON」导出所有已入库热帖的精确 source.json 快照，包含此前保存的编辑笔记。

Bridge 和扩展必须支持同一热帖协议。服务通过 `/health.bridgeCapabilities` 明确声明 `nowcoder-hot-material-v1`；扩展在未声明或断线时拒绝预览、保存和导出，不以数字版本高低推断功能。

## 私密用户调研命令

经用户授权的产品用户调研使用 `nowcoder research`，与公开面经交付分开。命令复用既有 JSON 最新搜索适配器，每组最多 6 个词、每词最多 2 页、两组共最多 24 次搜索请求；分别冻结最新讨论和困难讨论的候选。研究不读取或修改面经发布历史，不发起同步或仓库投递；详情仍由已连接扩展按普通本机采集协议读取。

```sh
node packages/bridge/dist/cli.js nowcoder research \
  --query 秋招 --query 求职 --query Agent \
  --complaint-query 吐槽 --complaint-query 简历挂 --complaint-query 迷茫 \
  --latest-target 30 --complaint-target 20 --days 7 \
  --idempotency-key research-YYYYMMDD-unique
```

可选 `--hot-export /absolute/plugin-export.private.json` 接收上述原始插件导出，仅采用一小时内观察的素材。另可用 `--hot-observation /absolute/observation.json` 接收**另行标明来源的公开页面观察**；它不是插件导出，不得伪装成插件预览或宣称未经证明的榜单范围。两种输入互斥。公开观察仅包含实际可见的列表标题、观察时点、范围、真实点击或链接得到的详情地址，以及原样热度；不得从脚本内部状态推导帖子号。登录、验证码、访问限制或工具安全拒绝不得绕过。

公开观察格式为 `schemaVersion:1, type:nowcoder-public-hot-observation, visibility:private, observer:browser-visible-dom, listUrl, listTitle, observedAt, scope, items`；每条 item 为 `{canonicalUrl,title,metrics:{heat,likes,comments,views}}`，未知指标为 null。仅接收 HTTPS 牛客列表及 1–60 个互不重复的规范详情 URL。观察时间不得早于运行开始前一小时，允许的时钟超前最多 60 秒。

运行证据保存在配置目录的 `research/<runId>/`：原始热榜输入、搜索诊断、冻结清单、逐条任务 ID 和 source.json 快照及哈希。相同幂等键只返回已保存运行，不重复提交；中断、失败和样本不足均保留原运行，不自动换词、换浏览器或拼其他运行补数。stdout 只有一个 JSON，进度写 stderr。只有 `status:completed` 可消费为本次完整样本。

搜索命中不等于用户困难：困难样本需在标题或短摘中出现明确困难/求助信号，题单汇编另记排除原因。详情发现付费或截断预览时，保存可见预览作为排除证据，**不计入完整正文**；latest/complaint 仅从本次搜索已冻结的同层候选继续取下一条，以满足原定完整正文配额。详情任务至少间隔 2 秒，整轮最多 160 次尝试。热榜保持原有观察全集，每条给出完整正文或不可读处置，不用其他帖子替代榜内条目。登录、验证码、限流、任务或来源错配仍立即停止整轮。

完成要求为完整 latest/complaint 正文分别达到请求配额、热榜条目均有明确处置、至少一篇完整正文且无失败或未完成任务。付费/截断排除数与完整正文数分列；任何配额不足仍不得作为完成样本。重启新范围必须使用新键并重新采集，先前失败运行保持原样，其已保存内容不混入新轮计数。

调研详情的 `sourceMetadata.collectionJobId` 由 Bridge 绑定到当前任务。读取快照时核对任务身份、采集时间、规范 URL、显式发布时间及截断状态；完整正文只进本机库和私有研究快照。7 天的 latest/complaint 样本与按观察时间记录的 hot 样本分别统计；热榜中更老的帖子不冒充最新帖子。

## 观察范围与限制

每次仅预览当前已加载 DOM 中前 60 条可识别、去重后的真实帖子链接及其卡片内容（热榜条目优先）。提取器排除 hidden/aria-hidden/display:none/visibility:hidden 元素，但不按屏幕可视区域（viewport）过滤，因此已加载到 DOM 中、位于屏幕外的条目也可能被读取。超限有提示；普通长列表滚动后重读可能仍返回相同的前 60 条，不保证覆盖第 61 条及后续条目，也不保证完整采集列表。本版本不自动滚动、翻页或扩大采集范围。

页面可见并不等于全站完整榜单。即使模块标题是「全站热榜」，也不生成排名字段、不声称全站榜首；热度/赞/评论/浏览保留站点显示字符串，例如 `1.1W`，没有指标写 `null`，不把它们合成总热度。

发布时间只在站点明确给出年份或 ISO datetime 时解析。仅月日、今天/昨天、编辑时间保留原始 `publishedAtText`，`publishedAt` 缺省；采集/观察时间独立保存。热榜卡未显示日期和短摘时保留未知/空值，不自动开详情补全文。

短摘最多 180 字符（JS 字符串计数），不提取头像、昵称、学校/身份卡等独立资料字段或图片。标题与短摘中的姓名、联系方式等个人信息不会自动识别或脱敏，使用前须人工核验；公开使用前须去除个人信息。本文版没有截图按钮，不调用截图 API，不新增权限。界面提示截图只进私有素材、公开使用前去除昵称头像联系方式等信息并核实消息。需要后续截图功能时应独立审查准确权限范围。

源标题与短摘是原文的可见记录，内容观点默认未核实。编辑标签/灵感笔记与来源记录分别存储；标签只供选题参考，不自动诊断或推断敏感身份。人工改写和核查属于后续工作。

## 本机库和导出兼容

沿用 `CollectedDocument` schemaVersion 1、`job.result` / `job.saved`、本机 Markdown 库的 `index.md` + `source.json` + `_catalog/index.json`，没有新增站点权限、采集服务或后台分支。

- `source: nowcoder`, `kind: post`，来源 URL 仍为规范化牛客真实链接。
- 新增可选 `operationMaterial`；普通面经文档不带该字段。
- 素材 ID：`hot-` + 现有 `stableContentId(canonicalUrl)`。同一链接的面经仍用原 ID，不会互相覆盖；热帖重采保留一条。
- 固定分类 `热帖素材`，目录索引标 `materialKind: nowcoder-hot`。素材不参与面经去重、公司合格库存、fe-journey 候选索引/重建或通用 pending 同步列表。目录身份和对应source.json仍须校验，损坏素材不会被静默排除。
- 保存任务持久化 `materialKind: nowcoder-hot`，并验证回传文档与任务类型一致。扩展重启/服务重启中断保存时进入 `needs_attention`，只能回到素材预览手动重试；不会自动打开详情页采全文。
- Bridge 强制素材只写内部 `markdown` sink，拒绝定向面经交付。普通同步和所有 RepoInboxSink 均拒绝素材，即使用户配置了其他去向。
- `library.entry` 对素材追加经过 schema/身份校验的 `document`，用于读取精确私有导出；普通条目的现有形状不变。

## 运营后台导入接口约定

导出文件名：`nowcoder-hot-materials-YYYY-MM-DD.private.json`。外层：

```ts
{
  schemaVersion: 1,
  type: 'nowcoder-hot-materials',
  visibility: 'private',
  exportedAt: string, // ISO UTC
  materials: Array<{ id: string; document: CollectedDocument }>
}
```

`document.operationMaterial` 字段：

| 字段 | 含义 |
| --- | --- |
| `schemaVersion: 1`, `purpose: nowcoder-hot` | 素材协议与内容线 |
| `visibility: private`, `verificationStatus: unverified` | 默认私有、未核实；当前协议禁止改成 public/verified |
| `observation.listUrl`, `listTitle` | 当次实际读取列表的 URL/标题 |
| `observation.publishedAtText` | 可见时间原样字符串或 null |
| `observation.metrics.{heat,likes,comments,views}` | 当时可见字符串或 null，不归一成排名 |
| `observation.observedAt` | 指标观察时间 ISO UTC |
| `evidence.excerpt` | 0–180 字符的必要短摘 |
| `evidence.attribution` | source-quote / author-self-report，均未核实 |
| `editorial.emotionTags` | 人工选择枚举：焦虑/困惑/不服/反差/释然 |
| `editorial.inspirationNote` | 人工笔记，最多 1000 字符 |
| `screenshotPolicy: redact-before-public-use` | 去标识要求；当前导出不含截图或图片 |

后台可实现 `importNowcoderHotMaterials(payload)`，先验证外层和每个 `collectedDocumentSchema`，再核对 `id === hotMaterialId(document.canonicalUrl)`，按 `purpose + canonicalUrl` 幂等 upsert 到**私有运营素材**。保留观察时间及原样指标，不能将发布时间未知改成采集时间，也不能把自述当核实事实。素材与公共题库使用不同数据集合和访问策略；禁止自动公开。

此 PR 只提供字段和可调用的 shared 校验器，不修改正在开发的运营后台，不提供自动上传/同步。`source.json` 中嵌套字段与导出 `document` 相同。原文始终通过 `canonicalUrl` 链接核对。

## 验证

新增测试覆盖真实 DOM 结构的脱敏简化夹具、DOM 改版/空列表、未知指标、重复链接、无年份时间、来源/自述/编辑字段、标签枚举、拒绝夹带全文、勾选/重试、worker 重启去重、同 URL 面经隔离、候选索引排除、公开 sink 拒绝和敏感截图提示。完整验证沿用 `typecheck`、`npm test`、`package` 和 `test:e2e`。
