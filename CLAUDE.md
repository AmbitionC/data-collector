# CLAUDE.md — data-collector 工作约定

个人自用工具，别过度设计。改动前先看 [`docs/sidepanel-states.md`](docs/sidepanel-states.md)（侧栏状态机与错误矩阵）和 [`docs/sinks.md`](docs/sinks.md)（去向与路由）。

## 一、每次迭代必须 bump 版本号

**只要改了代码并提交，就把补丁号 +1**（`0.2.1` → `0.2.2`）。

原因：用户在浏览器里**无法判断自己加载的是不是最新构建**。侧栏右下角显示
`v<版本> · <短 sha>`（打包时由 `scripts/build.mjs` 烙进产物），版本号不动的话
这个标记就失去意义，只能靠「某个功能怎么没出现」去反推——已经真实踩过一次。

要一起改的地方（`tests/unit/package.test.ts` 会校验三处一致）：

- `package.json`
- `packages/{shared,bridge,extension}/package.json`（含 `@data-collector/shared` 依赖版本）
- `packages/extension/manifest.json`
- `packages/shared/src/identity.ts` 的 `APP_VERSION` + `tests/unit/identity.test.ts`

改完跑 `npm install --package-lock-only` 同步 lockfile。

## 二、只在 `master` 上工作

不开功能分支、不走 PR。这是个人工具，Markdown 和小改动直接落主线。
平台默认开了别的分支就先 `git checkout master`。

## 三、绝不能做的事（回归红线）

1. **绝不刷新用户的页面**。知识星球的分类（精华 / 最新）是应用内状态，不在 URL 里；
   刷新会退回「最新」，用户在精华页发起的采集就采成了别的内容。自愈一律用
   `chrome.scripting.executeScript` 注入，清单见 `packages/extension/src/background/injection.ts`
   ——**两个脚本都要补**（内容脚本 + 主世界帖子号钩子）。
2. **绝不改变页面外观**。处理过的帖子只打不可见属性标记，绝不 `display:none`——
   用户要能肉眼核对采到的内容对不对。
3. **绝不把浏览器的原生英文报错摆给用户看**，也绝不让它盖住写好的终态屏。
4. **绝不猜帖子地址**。对不上号就如实计入「已跳过」——猜错会让两条内容写到同一个文件上。
5. **绝不静默失败**。跳过、截断、打不开文件夹，都要在界面上说出来。

## 四、提交前

```bash
npm run typecheck && npm test && npm run package
```

改到批量采集或注入相关的代码时再加 `npm run test:e2e`（只有它能发现打包产物级别的问题，
比如内容脚本里混进 `export` 导致整个文件语法错误）。

## 五、选题过滤

用户明确不看的类别在采集端就跳过（目前内置**打新 / 楼市 / 相亲**），规则在
`packages/extension/src/topicFilter.ts`。被跳过的条目**照样出现在「本轮明细」里**，
状态是已跳过、原因写明类别——绝不静默丢弃。

判据一律「强信号 + 至少两个不同信号」。**新增规则时先写误伤用例再写规则**：
排除的是以该话题为主线的帖子，不是提到该词的帖子——「背着房贷加杠杆买股票」
主线是投资，必须留下。
