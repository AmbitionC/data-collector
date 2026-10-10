# 牛客热帖私有素材（v0.4.42）

手动读取用户当前可正常访问的牛客热榜/讨论列表，供内容线 2「热帖观察」使用。不会生成或发布运营帖。现有面经、自主总结流程独立。

## 使用

1. 在 Chrome 打开牛客首页的热榜或讨论信息流，正常关闭站点弹窗；遇到登录/验证码由用户处理。
2. 现有 Data Collector 侧栏点「热帖素材」→「读取当前牛客列表 / 重试」。不自动滚动、翻页或打开详情，不复制全文。
3. 默认均不勾选。打开原文核对需要的条目，勾选；可将来源短摘标为「发帖人自述（未核实）」，人工勾选焦虑/困惑/不服/反差/释然，填写编辑灵感笔记。
4. 点「保存勾选的 N 条素材」。逐条等候本机库落盘回执；失败保留选择可重试，已成功条目跳过。
5. 在「已入库」查看、打开原文或定位文件；「热帖素材」页的「导出私有素材 JSON」导出所有已入库热帖的精确 source.json 快照，包含此前保存的编辑笔记。

Bridge 和扩展需一起更新至本次构建。旧 Bridge 的 schema 会丢弃新增字段，所以扩展在服务版本低于 0.4.42 时拒绝素材预览/保存/导出。与原 checkout 正在开发的 0.4.41 错开版本，便于辨认构建。开发分支与其他未提交工作隔离，实际部署仍需人工审阅 draft PR。

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
- 固定分类 `热帖素材`，目录索引标 `materialKind: nowcoder-hot`。素材不参与面经去重、fe-journey 候选索引/重建、通用 pending 同步列表。
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
