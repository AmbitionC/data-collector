# 牛客私有来源身份投影

0.4.45新增schemaVersion2身份读取契约。投影只提供去重身份，不贡献qualifiedPending，也不替代内容发布审批。原schemaVersion1输入仍兼容。

## 显式配置

- `DATA_COLLECTOR_INTERVIEW_INVENTORY_ROOT`：只读的已发布文章checkout或冻结快照目录，独立于交付inbox。
- `DATA_COLLECTOR_INTERVIEW_HISTORY`：资源目录外的投影JSON绝对路径。
- `DATA_COLLECTOR_INTERVIEW_INVENTORY_COMMIT`：本次核实的完整40位已发布commit，现代契约必填。切换前必须只读核实真实远程master；这些本地字段不能自行证明远程没有更新。

checkout必须有自身`.git`且HEAD匹配。非Git快照必须有`.collector-published-snapshot.json`：`schemaVersion:1`、`commit`和`treeSha256`，三个值均与投影及实际树文件一致。父目录里的Git仓库不能充当快照authority。

## 投影格式

```json
{
  "schemaVersion": 2,
  "kind": "nowcoder-identity-projection",
  "generatedAt": "2026-10-14T18:00:00.000Z",
  "rawHistory": { "path": "/absolute/private/raw-history.json", "sha256": "<64 hex>" },
  "published": { "commit": "<40 hex>", "treeSha256": "<64 hex>" },
  "bindings": [{
    "articleKey": "tencent-ai-1",
    "path": "interview/tencent/ai/tencent-ai-1.md",
    "articleSha256": "<64 hex>",
    "sourceIds": ["0123456789ab"],
    "review": { "status": "pending", "reason": "说明真实缺项和恢复路径" }
  }]
}
```

读取器重新核验文件SHA、原件、原始记录、当前文章和完整树覆盖，不接受自报consumerReady标记。私有文件必须位于资源根目录外，且绝对路径每一层均非符号链接；单文件上限16MiB。

原始台账逐条保留状态、等级、publication、editorialLimits、bodySha256与processUnitId。runtime contentHash必须来自真实原件中的16位指纹，并重新计算正文验证；clusterId必须来自原件。64位编辑正文SHA和编辑单元ID不能代替它们。原件不足的历史非公开记录仅标为recorded；绑定公开文章的每个来源别名都必须有验证过的冻结原件。

### 无采集器增强字段的既有原文档案

0.4.52支持显式 `originalBodyIdentityMode: "archived-text-v1"`。仅用于有真实冻结JSON原件、但 `document.feJourney` 不存在的历史原文；不能给既有采集器元数据换一个模式来跳过核验。仍必须核对文件SHA、牛客规范URL、非空正文，且必须提供并复算完整的 `normalizedBodySha256`。运行时指纹由实际原文按既有 `contentFingerprint` 算法计算，cluster按该指纹前12位生成；原台账中的编辑指纹、状态、等级与过程记录保持原值，不作为伪造的采集器字段。

该类型的实际origin为 `archive`，与 `capture`、无原件的 `recorded` 分开。它只提供去重排除身份，不增加qualifiedPending，也不是公开许可。绑定公开叶子时必须有真实、当前版本的 `verified` 关联回执，绑定全部来源别名与原件SHA；不能继承台账内的 `recorded` 审核声明。未显式标记的缺失增强字段、未知模式、原件/正文SHA不符或回执缺失仍然失败关闭。

prepared/B-partial只有去重身份；它们不直接变成published、A/B或qualifiedPending。公开篇数来自当前树，合格待审数来自本地真实源快照的既有质量/日期门禁，并排除历史URL/hash/cluster。台账异常时整个库存读取失败，不能返回假0。

## 三种绑定状态

- `pending`：保留真实缺项；审计可列出，但inventory、搜索、派发与选择读取均失败关闭。
- `recorded`，`basis:"raw-history"`：只复用精确对应当前文章的既有证据。支持原台账中的`editorialReview`及既有私有independent-batch回执；须原状态published、等级A/B、当前文章SHA一致，并验证实际回执/原文。旧回执未匹配、prepared/partial或缺项不会自动通过。
- `verified`，`receipt:{path,sha256}`：指向真实完成的当前来源关联审查。回执必须逐篇绑定当前articleSHA及所有sourceIds、冻结原件SHA，决定为verified。这里只认可关联，不改变原记录的编辑审核、公开许可或证据等级。

新关联回执格式：schemaVersion1、kind`nowcoder-source-binding-review`、reviewer、reviewedAt、entries。每条entry含articleKey、path、articleSha256、完整sourceIds、sourceSha256映射、decision及reason。不能为了启用调度生成虚假的verified回执。

审计函数`auditNowcoderIdentityProjection`返回实际identities、文章SHA、bindingVerified和带恢复说明的issues；`loadNowcoderIdentityProjection`仅接受完整通过的结果。所有公开叶子必须覆盖，别名不能遗漏。更改树、文章、rawHistory、原件或关联回执都需要重新核验；远程master变化后先刷新只读快照和commit pin，只对变化版本恢复或补做真实关联审查。

本功能不安装扩展、不改用户Chrome、launchd或定时器，不自动采集/交付。完成代码验证不等于真实私有输入已可运行。
