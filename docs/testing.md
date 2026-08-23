# 测试与验收

## 自动化测试

确保使用 Node.js 22.12+，然后执行：

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run test:e2e
npm run test:coverage
npm run package
npm run smoke:wechat
npm run smoke:fe-journey
npm run smoke:plans
```

测试层次：

- 单元：URL 规范化、DOM 提取、固定身份、自动授权、任务状态机、清洗、文件写入、Side Panel 状态、后台 `setPanelBehavior` 与打包白名单；列表页拆条（每条带自己的 `/topic/` 地址、跳过计数、跨轮去重、上限截断）与内容脚本的“标记已处理帖子 → 拟人滚动加载下一批”。
- 交互与错误场景：[`docs/sidepanel-states.md`](sidepanel-states.md) 的错误矩阵逐条有用例（E1 脚本未就绪 / E2 未登录 / E3 空列表 / E4 全部跳过 / E5 服务断开 / E6 单条失败 / E7 主动停止 / E8 后台被回收 / E9 到达上限 / E10 无可采标签页），并强制两条不变量：**失败终态不得被轮询覆盖**、**零产出不得用成功语气**。
- 集成：真实 HTTP/WebSocket Bridge、Origin/token 认证、current-page 不重复派发、queued 重连恢复、`4009/replaced` 单连接接管、CLI 采集和错误退出。
- 端到端：用系统 Chrome 加载构建后的固定 ID 扩展。其一，打开公众号 fixture，验证 Side Panel 无需输入即可进入 ready；从级联下拉里选分类、填标签并点击保存，断言无额外文章 tab、覆盖值进入 Markdown，再覆盖 catalog 去重和 CLI URL collection。其二，打开知识星球列表页 fixture，验证按钮变为“批量保存本页帖子”，一次批量后知识库落两条各自独立的条目、跳过数如实上报、且全程不新开标签页。其三，打开无帖子的列表页，验证零产出被判为“需要你处理”而不是“完成”，并在轮询多轮后终态仍未被覆盖。
- 真实冒烟：请求指定在线公众号文章，复用生产提取器和知识库写入器，验证标题、作者、正文、最终路径和重复采集幂等性。
- 固定计划冒烟：离线夹具验证知识星球三视图 topic 合并、星主过滤、公司上限、真实批次计数和自动同步恰好一次；报告部分要求一个规范问题只有一个问题簇记录，且来源链接全部为 A/B 证据。

合并自动门槛使用离线 fixture E2E，并包含在上述自动化命令中。真实在线冒烟依赖外部站点与网络状态，只在网络可用时作为补充验收，不因其未执行或外部网络失败阻塞合并。

E2E 会依次查找 `CHROME_PATH`、`PUPPETEER_EXECUTABLE_PATH`、macOS Chrome、Linux Chrome/Chromium 和 Windows Chrome。需要指定浏览器时：

```bash
CHROME_PATH='/path/to/chrome' npm run test:e2e
```

### E2E 边界

headless Chrome 不能通过用户手势可靠打开 Edge 原生 Side Panel surface，因此自动化按既定边界直接访问 `chrome-extension://<fixed-id>/sidepanel/index.html`。测试从构建后 service worker URL 解析 ID 并与受信任 ID 比较，截图写入 `artifacts/screenshots/sidepanel-ready.png` 和 `sidepanel-collecting.png`。

为了让被采集文章保持 active tab，测试通过 CDP DOM 域观察后台 Side Panel document，并对真实分类/标签输入框赋值、点击“保存这一页”。测试监听 Chrome page target，确保当前页任务不会再创建同 URL 后台采集 tab。它验证页面、状态机、自动授权和采集链路，但不声称验证 Edge 原生侧栏容器。工具栏点击配置由 background 单元测试对 `sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` 独立约束。

## 手工验收清单

1. 运行 `npm run package`，确认稳定安装目录和 `data-collector-extension-0.4.16.zip` 均生成。
2. 在 `edge://extensions` 删除任何旧 Data Collector，再加载 `artifacts/data-collector-extension`。
3. 启动 Bridge，在公众号文章点击扩展图标；Edge 一步打开 Side Panel，并自动显示“本机在线”。
4. 保存后文件包含标题、来源 URL、摘要、正文；Side Panel 显示最终路径。
5. 重复保存同一文章，返回相同路径，目录索引只有一个稳定 ID。
6. 登录知识星球后验证文章、动态、问答详情；退出后应显示需要登录，不保存登录页。
7. 停止 Bridge 后 Side Panel 显示服务离线；重启并点击“重新连接”后恢复。
8. 安装非正式 ID 时显示身份异常，并提示删除后从正式发布包重新安装。
9. 同时启动第二个已安装实例时，旧 Side Panel 显示“另一个浏览器实例已接管”且不反复重连；点击“在此实例重新连接”后可主动接管。
10. `unzip -l artifacts/data-collector-extension-0.4.16.zip` 只显示八个允许文件。
11. 打开“任务”页，确认两条固定计划显示上次/下次运行、结果计数与四家公司覆盖；“立即运行”后可观察到运行中和终态。
12. 退出牛客或知识星球登录后补跑，对应批次应显示“需处理”并提供站点登录入口；登录后重试可恢复。
13. 在已登录 Edge 对 `zsxq-chen-teacher` 验证“最新 / 精华 / 只看星主”三视图和 topic 去重；对 `nowcoder-agent-market` 验证 A/B 门槛、单公司 4 条上限以及无样本公司明确显示 0。

## 可复现打包

打包脚本从已校验的 `packages/extension/dist/manifest.json` 读取版本，先在临时目录准备完整 ZIP 和已解压目录，再切换稳定安装目录。只有 0.4.16 成品验证完成后才删除旧 ZIP。

```bash
npm run package
shasum -a 256 artifacts/data-collector-extension-0.4.16.zip
npm run package
shasum -a 256 artifacts/data-collector-extension-0.4.16.zip
```

两次 SHA-256 必须完全一致。发布前还应执行任务简报指定的当前源码扫描，并排除历史 `docs/superpowers`；预期没有遗留人工授权或旧入口文本。

## 可选：真实微信公众号在线冒烟

```bash
npm run build
node scripts/smoke-wechat.mjs 'https://mp.weixin.qq.com/s/uW5gUigjslVY24YmCYhg0g'
```

网络可用时可运行此补充验收；它不是合并硬门槛。脚本使用隔离知识库 `artifacts/smoke-library`，连续写入两次同一 URL；两次必须保存到同一路径且 catalog 只有一个条目。结果摘要写入 `artifacts/smoke-wechat.json`。

## 页面结构回归

站点页面变化时，先把去除个人信息后的最小 DOM 保存到 `tests/fixtures`，写一个会失败的提取测试，再修改专用提取器。不要用整页 `innerText` 或无限制选择器掩盖结构变化。
