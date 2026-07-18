# Data Collector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first Chrome extension, loopback bridge, and CLI that capture WeChat and ZSXQ content into a classified Markdown knowledge base and allow Codex to submit URL jobs.

**Architecture:** A Manifest V3 extension extracts authorized page DOM and communicates with a loopback Node.js bridge through an authenticated WebSocket. The bridge owns durable jobs, sanitization, offline summarization/classification, image download, atomic Markdown storage, and an HTTP/CLI interface. Shared TypeScript contracts keep extension and bridge protocol-compatible.

**Tech Stack:** Node.js >=20, npm workspaces, TypeScript 7.0.2, Zod 4.4.3, ws 8.21.1, sanitize-html 2.17.6, Turndown 7.2.4, esbuild 0.28.1, Vitest 4.1.10, jsdom 29.1.1, Puppeteer 25.3.0.

## Global Constraints

- Chrome Manifest V3; `minimum_chrome_version` is exactly `116`.
- Bridge listens only on `127.0.0.1`, defaults to port `17321`, and requires pairing/authentication for all mutation APIs.
- Supported task URLs are HTTPS WeChat public articles and HTTPS ZSXQ pages only; credentials, cookies, local storage, and page-world scripts are never collected.
- Default library path is `~/Documents/data-collector`; tests always use a temporary directory.
- Content scripts are untrusted inputs; payload size, type, URL, HTML, tags, and image count are validated before writes.
- Classification and summary work offline; user category and tags override automatic suggestions.
- No changes are made to `/Users/chenhao/Code/midway/fe-journey-faas` in version 0.1.0.
- UI copy is simplified Chinese, keyboard accessible, color-independent, responsive from 320px to 440px, and respects reduced motion.

---

## File map

```text
data-collector/
├── package.json                         # workspace scripts and pinned toolchain
├── tsconfig.base.json                   # strict shared compiler options
├── vitest.config.ts                     # Node and jsdom test projects
├── packages/shared/
│   ├── src/model.ts                     # CollectedDocument and job types
│   ├── src/protocol.ts                  # Zod HTTP/WebSocket schemas
│   ├── src/url.ts                       # URL allowlist, canonicalization, stable ID
│   └── src/index.ts                     # public exports
├── packages/extension/
│   ├── manifest.json                    # MV3 permissions and entry points
│   ├── scripts/build.mjs                # esbuild plus static-asset copy
│   ├── src/extractors/{types,wechat,zsxq,index}.ts
│   ├── src/content.ts                    # untrusted DOM extraction message handler
│   ├── src/background/{connection,jobs,index}.ts
│   └── src/popup/{index.html,index.ts,styles.css,state.ts}
├── packages/bridge/
│   ├── src/config.ts                    # path, port, secret-file configuration
│   ├── src/auth.ts                      # pairing and token verification
│   ├── src/jobs/store.ts                # durable job state machine
│   ├── src/organize/{sanitize,summarize,classify}.ts
│   ├── src/library/{paths,assets,writer,index}.ts
│   ├── src/server/{http,websocket,index}.ts
│   ├── src/cli.ts                       # bridge/collect/health command surface
│   └── src/index.ts                     # embeddable startBridge API
├── tests/
│   ├── fixtures/{wechat-article,zsxq-article,zsxq-question}.html
│   ├── unit/{url,extractors,organize,library,jobs}.test.ts
│   ├── integration/bridge.test.ts
│   └── e2e/extension.test.ts
└── docs/{product,protocol,testing}.md
```

---

### Task 1: Workspace and shared contracts

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `vitest.config.ts`, `.gitignore`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`
- Create: `packages/shared/src/model.ts`, `packages/shared/src/protocol.ts`, `packages/shared/src/url.ts`, `packages/shared/src/index.ts`
- Test: `tests/unit/url.test.ts`

**Interfaces:**
- Produces: `CollectedDocument`, `JobRecord`, `WsEnvelope`, `parseSupportedUrl(raw)`, `canonicalizeUrl(url)`, `stableContentId(url)`.

- [ ] **Step 1: Add a failing URL/contract test**

```ts
import { describe, expect, it } from 'vitest';
import { canonicalizeUrl, parseSupportedUrl, stableContentId } from '../../packages/shared/src/index.js';

describe('supported URLs', () => {
  it('canonicalizes a WeChat article and keeps a stable identity', () => {
    const a = canonicalizeUrl(parseSupportedUrl('https://mp.weixin.qq.com/s/abc?scene=1#rd'));
    const b = canonicalizeUrl(parseSupportedUrl('https://mp.weixin.qq.com/s/abc'));
    expect(a.href).toBe('https://mp.weixin.qq.com/s/abc');
    expect(stableContentId(a)).toBe(stableContentId(b));
  });

  it.each(['http://mp.weixin.qq.com/s/x', 'file:///tmp/x', 'https://example.com/x'])('rejects %s', value => {
    expect(() => parseSupportedUrl(value)).toThrow(/不支持的采集地址/);
  });
});
```

- [ ] **Step 2: Run `npm test -- tests/unit/url.test.ts`; expect failure because workspace files do not exist**

- [ ] **Step 3: Add the workspace and strict compiler configuration**

```json
{
  "name": "data-collector",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "workspaces": ["packages/*"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "npm run build -ws --if-present",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage",
    "typecheck": "tsc -b packages/shared packages/bridge --pretty false && tsc -p packages/extension/tsconfig.json --noEmit",
    "lint": "tsc -p tsconfig.base.json --noEmit",
    "collector": "node packages/bridge/dist/cli.js"
  }
}
```

- [ ] **Step 4: Implement URL validation, canonicalization, SHA-256-based 12-character IDs, data types, and strict Zod message schemas**

```ts
export function parseSupportedUrl(raw: string): URL {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  const supported = url.protocol === 'https:' &&
    (host === 'mp.weixin.qq.com' || host === 'wx.zsxq.com' || host.endsWith('.zsxq.com'));
  if (!supported) throw new Error('不支持的采集地址：仅支持微信公众号和知识星球 HTTPS 页面');
  return url;
}
```

- [ ] **Step 5: Run `npm test -- tests/unit/url.test.ts` and `npm run typecheck`; expect all passing**

- [ ] **Step 6: Commit with `feat: add shared collection contracts`**

---

### Task 2: Page extractors with stable fixtures

**Files:**
- Create: `packages/extension/package.json`, `packages/extension/tsconfig.json`
- Create: `packages/extension/src/extractors/types.ts`, `wechat.ts`, `zsxq.ts`, `index.ts`
- Create: `tests/fixtures/wechat-article.html`, `tests/fixtures/zsxq-article.html`, `tests/fixtures/zsxq-question.html`
- Test: `tests/unit/extractors.test.ts`

**Interfaces:**
- Consumes: `CollectedDocument`, `parseSupportedUrl`.
- Produces: `detectSource(url)`, `extractDocument(document, url, now)`, `ExtractionError(code, message)`.

- [ ] **Step 1: Add failing jsdom tests for WeChat article, ZSXQ article, question/answer, and unsupported layout**

```ts
const result = extractDocument(dom.window.document, WECHAT_URL, () => '2026-07-18T00:00:00.000Z');
expect(result).toMatchObject({
  source: 'wechat',
  kind: 'article',
  title: '一夜之间，通胀的玩笑这次开大了',
  author: '重远投资观',
});
expect(result.html).toContain('通胀');
expect(result.images[0]?.url).toMatch(/^https:\/\/mmbiz/);
```

- [ ] **Step 2: Run `npm test -- tests/unit/extractors.test.ts`; expect missing extractor failure**

- [ ] **Step 3: Implement pure DOM extractors**

```ts
export function extractWechat(doc: Document, url: URL, now: Clock): CollectedDocument {
  const content = doc.querySelector<HTMLElement>('#js_content');
  const title = text(doc.querySelector('#activity-name')) || text(doc.querySelector('h1'));
  if (!content || !title || content.innerText.trim().length < 80) {
    throw new ExtractionError('CONTENT_EMPTY', '未找到可保存的公众号正文');
  }
  normalizeLazyImages(content, url);
  return buildDocument({ source: 'wechat', kind: 'article', title, content, url, now,
    author: text(doc.querySelector('#js_name')),
    publishedAt: parseVisibleDate(text(doc.querySelector('#publish_time'))) });
}
```

ZSXQ implements known selectors first, then a scored visible-candidate fallback; it throws `AUTH_REQUIRED` for login UI and `UNSUPPORTED_LAYOUT` when there is no unique detail candidate.

- [ ] **Step 4: Run extractor tests and typecheck; expect passing**

- [ ] **Step 5: Commit with `feat: extract wechat and zsxq content`**

---

### Task 3: Durable authenticated job core

**Files:**
- Create: `packages/bridge/package.json`, `packages/bridge/tsconfig.json`
- Create: `packages/bridge/src/config.ts`, `packages/bridge/src/auth.ts`
- Create: `packages/bridge/src/jobs/store.ts`
- Test: `tests/unit/jobs.test.ts`

**Interfaces:**
- Consumes: shared job schemas and `stableContentId`.
- Produces: `loadConfig(overrides)`, `PairingManager`, `JobStore.create/get/transition/recover`, `JobStateError`.

- [ ] **Step 1: Add failing tests for one-time pairing, constant-time token checks, legal job transitions, recovery, and duplicate request IDs**

```ts
const jobs = await JobStore.open(join(tmp, '_catalog/jobs.json'));
const job = await jobs.create({ url: WECHAT_URL, requestedBy: 'codex' });
await jobs.transition(job.id, 'dispatched');
await jobs.transition(job.id, 'collecting');
await jobs.transition(job.id, 'saved', { outputPath: '/tmp/index.md' });
await expect(jobs.transition(job.id, 'collecting')).rejects.toThrow(/非法任务状态/);
expect((await JobStore.open(jobs.path)).get(job.id)?.status).toBe('saved');
```

- [ ] **Step 2: Run the job tests; expect missing bridge modules**

- [ ] **Step 3: Implement config resolution and secret file mode `0600`**

`loadConfig` resolves `~` via `os.homedir()`, uses `DATA_COLLECTOR_LIBRARY`, `DATA_COLLECTOR_PORT`, and explicit overrides in that precedence, and never accepts a non-loopback host.

- [ ] **Step 4: Implement pairing and append-safe atomic JSON job persistence**

Pair codes are six decimal digits, expire after ten minutes, are consumed once, and exchange for `randomBytes(32).toString('base64url')`. Comparisons hash both tokens and use `timingSafeEqual`.

- [ ] **Step 5: Run job tests and typecheck; expect passing**

- [ ] **Step 6: Commit with `feat: add authenticated durable job store`**

---

### Task 4: Offline organization pipeline

**Files:**
- Create: `packages/bridge/src/organize/sanitize.ts`, `summarize.ts`, `classify.ts`, `index.ts`
- Test: `tests/unit/organize.test.ts`

**Interfaces:**
- Consumes: validated `CollectedDocument`.
- Produces: `sanitizeCollectedHtml(html, baseUrl)`, `summarize(text, title)`, `keywords(text, title)`, `classify(input)`, `organize(document)`.

- [ ] **Step 1: Add failing tests proving script/event/form removal, relative URL resolution, Chinese summary limits, deterministic tags, and user override precedence**

```ts
expect(sanitizeCollectedHtml('<p onclick="x()">正文</p><script>x()</script>', WECHAT_URL))
  .toBe('<p>正文</p>');
expect(classify({ title: 'React 性能优化', text: '组件 渲染 前端', userCategory: '个人收藏' }).category)
  .toBe('个人收藏');
expect(summarize(longChineseText, '浏览器插件').length).toBeLessThanOrEqual(280);
```

- [ ] **Step 2: Run organize tests; expect missing functions**

- [ ] **Step 3: Implement allowlist sanitization and deterministic sentence/keyword scoring**

Allowed tags are headings, paragraphs, emphasis, links, images, lists, blockquotes, pre/code, tables and line breaks. URLs are HTTP(S) only. Summaries choose 2–4 de-duplicated sentences by position, title token overlap, length, and punctuation completeness.

- [ ] **Step 4: Implement exact category map and user overrides**

```ts
const CATEGORY_RULES = [
  ['前端开发', ['javascript', 'typescript', 'react', 'vue', '浏览器', 'css', '前端']],
  ['人工智能', ['ai', '大模型', 'llm', '智能体', '提示词', '机器学习']],
  ['产品与设计', ['产品', '交互', '设计', '用户体验']],
  ['商业与投资', ['投资', '通胀', '股票', '商业', '利率', '估值']],
  ['效率与工具', ['效率', '工具', '自动化', '工作流']],
  ['生活与随笔', ['生活', '旅行', '随笔', '成长']],
] as const;
```

- [ ] **Step 5: Run tests and typecheck; expect passing**

- [ ] **Step 6: Commit with `feat: add offline content organization`**

---

### Task 5: Atomic Markdown library and image assets

**Files:**
- Create: `packages/bridge/src/library/paths.ts`, `assets.ts`, `writer.ts`, `index.ts`
- Test: `tests/unit/library.test.ts`

**Interfaces:**
- Consumes: organized document and Bridge config.
- Produces: `ContentSink.save(document) -> SavedContent`, `MarkdownLibrary`, `safeSlug`, `resolveEntryPath`.

- [ ] **Step 1: Add failing tests for safe paths, stable update paths, YAML metadata, image rewrite/fallback, atomic catalog update, and traversal rejection**

```ts
const first = await library.save(wechatDocument({ title: '../../危险标题' }));
const second = await library.save(wechatDocument({ title: '改过的标题' }));
expect(first.markdownPath).toBe(second.markdownPath);
expect(first.markdownPath.startsWith(tmp)).toBe(true);
expect(await readFile(first.markdownPath, 'utf8')).toContain('source: wechat');
expect(JSON.parse(await readFile(join(tmp, '_catalog/index.json'), 'utf8'))).toHaveLength(1);
```

- [ ] **Step 2: Run library tests; expect missing writer**

- [ ] **Step 3: Implement stable source/category/year/slug-hash paths and atomic writes**

Use a sibling `.<name>.<random>.tmp` file, `fsync`, then `rename`. Verify every resolved path begins with `realpath(libraryRoot) + sep` before creating or replacing it.

- [ ] **Step 4: Implement image download with 10-second timeout, 10 MB per image, 30-image limit, MIME allowlist, SHA-256 filenames, and remote-URL fallback**

- [ ] **Step 5: Convert sanitized HTML with Turndown, prepend YAML front matter, and update sorted `_catalog/index.json` idempotently**

- [ ] **Step 6: Run library tests and typecheck; expect passing**

- [ ] **Step 7: Commit with `feat: write atomic markdown knowledge library`**

---

### Task 6: Loopback HTTP/WebSocket bridge and CLI

**Files:**
- Create: `packages/bridge/src/server/http.ts`, `websocket.ts`, `index.ts`
- Create: `packages/bridge/src/cli.ts`, `packages/bridge/src/index.ts`
- Test: `tests/integration/bridge.test.ts`

**Interfaces:**
- Consumes: `PairingManager`, `JobStore`, `MarkdownLibrary`, shared protocol schemas.
- Produces: `startBridge(options) -> BridgeHandle`, HTTP routes, authenticated extension socket, CLI commands `bridge`, `collect`, `health`.

- [ ] **Step 1: Add failing integration test for health, pair, rejected auth, job dispatch, progress/result, Markdown output, duplicate result, and restart recovery**

```ts
const bridge = await startBridge({ host: '127.0.0.1', port: 0, libraryRoot: tmp });
const token = await pair(bridge.url, bridge.pairingCode);
const socket = await connectExtension(bridge.wsUrl, token);
const job = await postJob(bridge.url, token, WECHAT_URL);
expect((await nextJson(socket)).type).toBe('job.collect');
socket.send(JSON.stringify(jobResult(job.id, fixtureDocument)));
await vi.waitFor(async () => expect((await getJob(bridge.url, token, job.id)).status).toBe('saved'));
```

- [ ] **Step 2: Run integration test; expect missing server**

- [ ] **Step 3: Implement strict JSON HTTP routing with 1 MB request limit, Bearer auth, loopback-only remote address check, and stable error JSON**

- [ ] **Step 4: Implement `ws` no-server upgrade handling**

Only `/v1/extension` may upgrade. Verify token before `handleUpgrade`, accept only Origin matching `^chrome-extension://[a-p]{32}$` outside tests, parse every incoming frame through Zod, cap payload at 12 MB, and close invalid peers with code `1008`.

- [ ] **Step 5: Implement dispatcher/resume behavior and wire successful `job.result` through organization and `ContentSink.save`**

- [ ] **Step 6: Implement dependency-free CLI parsing**

`bridge start [--port N] [--library PATH]`, `collect URL [--wait MS]`, and `health` use the local config token. Successful `collect` writes only the absolute Markdown path to stdout; actionable diagnostics go to stderr with non-zero status.

- [ ] **Step 7: Run integration tests, typecheck, and a subprocess CLI health test; expect passing**

- [ ] **Step 8: Commit with `feat: connect codex through local bridge`**

---

### Task 7: Extension build, connection, and automated job runner

**Files:**
- Create: `packages/extension/manifest.json`, `packages/extension/scripts/build.mjs`
- Create: `packages/extension/src/content.ts`
- Create: `packages/extension/src/background/connection.ts`, `jobs.ts`, `index.ts`
- Test: `tests/unit/background.test.ts`

**Interfaces:**
- Consumes: shared protocol and extractors.
- Produces: loadable `packages/extension/dist`, resilient socket client, `runRemoteJob`, current-tab capture messages.

- [ ] **Step 1: Add failing tests around a mocked Chrome API for reconnect persistence, `job.collect`, tab load timeout, content-script response, needs-attention activation, and successful tab cleanup**

```ts
await runner.handleCollect({ requestId: 'job-1', payload: { url: WECHAT_URL } });
expect(chrome.tabs.create).toHaveBeenCalledWith({ url: WECHAT_URL, active: false });
expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('job.result'));
expect(chrome.tabs.remove).toHaveBeenCalledWith(42);
```

- [ ] **Step 2: Run background tests; expect missing modules**

- [ ] **Step 3: Create MV3 manifest**

```json
{
  "manifest_version": 3,
  "name": "Data Collector",
  "version": "0.1.0",
  "minimum_chrome_version": "116",
  "permissions": ["activeTab", "alarms", "storage"],
  "host_permissions": [
    "https://mp.weixin.qq.com/*",
    "https://wx.zsxq.com/*",
    "https://*.zsxq.com/*",
    "http://127.0.0.1/*"
  ],
  "background": { "service_worker": "background.js", "type": "module" },
  "content_scripts": [{
    "matches": ["https://mp.weixin.qq.com/*", "https://wx.zsxq.com/*", "https://*.zsxq.com/*"],
    "js": ["content.js"],
    "run_at": "document_idle"
  }],
  "action": { "default_popup": "popup/index.html", "default_title": "保存到 Data Collector" }
}
```

- [ ] **Step 4: Implement a WebSocket client with 20-second ping, bounded exponential reconnect, `chrome.storage.local` state, and one-minute `chrome.alarms` recovery**

- [ ] **Step 5: Implement remote and current-tab jobs**

Wait for `tabs.onUpdated` complete, ask content script for extraction, send validated result to Bridge. On `AUTH_REQUIRED` or `UNSUPPORTED_LAYOUT`, keep and activate the tab; otherwise close tabs the extension created.

- [ ] **Step 6: Build with esbuild and verify `dist/manifest.json`, `background.js`, `content.js` contain no remote code or source-map paths**

- [ ] **Step 7: Run background tests, build, and typecheck; expect passing**

- [ ] **Step 8: Commit with `feat: automate browser collection jobs`**

---

### Task 8: Popup product experience

**Files:**
- Create: `packages/extension/src/popup/index.html`, `index.ts`, `styles.css`, `state.ts`
- Test: `tests/unit/popup.test.ts`

**Interfaces:**
- Consumes: background messages `status.get`, `pair.submit`, `capture.current`, `job.get`.
- Produces: accessible pairing, capture, progress, saved, and actionable `needs_attention`/error states.

- [ ] **Step 1: Add failing jsdom tests for disconnected, ready, collecting, saved, and needs-attention states plus keyboard labels**

```ts
renderPopup({ phase: 'ready', sourceLabel: '微信公众号', title: '测试文章', category: '商业与投资' });
expect(screen.getByRole('button', { name: '保存这一页' })).toBeEnabled();
expect(screen.getByLabelText('分类')).toHaveValue('商业与投资');
```

- [ ] **Step 2: Run popup tests; expect missing UI**

- [ ] **Step 3: Implement the 380px semantic HTML state shell and exact Chinese error guidance**

- [ ] **Step 4: Implement design tokens and capture-track CSS**

Use `#14213D`, `#F7F8FA`, `#2F6BFF`, `#0E9F8A`, `#D97706`, and `#394150`; include `:focus-visible`, text status labels, responsive rules, and `@media (prefers-reduced-motion: reduce)`.

- [ ] **Step 5: Wire pairing, editable category/tags, current capture, copied path, and folder reveal through background messages without `innerHTML`**

- [ ] **Step 6: Run popup tests, build, and typecheck; expect passing**

- [ ] **Step 7: Commit with `feat: add collection popup experience`**

---

### Task 9: Full integration and browser E2E

**Files:**
- Create: `tests/e2e/extension.test.ts`
- Modify: `vitest.config.ts`, root `package.json`
- Create: `tests/helpers/test-bridge.ts`, `tests/helpers/fixture-server.ts`

**Interfaces:**
- Consumes: final extension build and `startBridge`.
- Produces: repeatable end-to-end verification using Puppeteer `pipe: true` and `enableExtensions: [distPath]`.

- [ ] **Step 1: Add an E2E test that builds and loads the actual extension, pairs through the popup, serves a fixture under an allowed test mapping, submits a job, and checks the generated file**

```ts
const browser = await puppeteer.launch({ pipe: true, headless: true, enableExtensions: [extensionPath] });
const workerTarget = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().endsWith('background.js'));
const extensionId = new URL(workerTarget.url()).host;
const popup = await browser.newPage();
await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
await popup.locator('#pair-code').fill(bridge.pairingCode);
await popup.locator('button[type=submit]').click();
```

- [ ] **Step 2: Run E2E; expect the first failure and record whether it is extension loading, host mapping, or UI wiring**

- [ ] **Step 3: Add a test-only host override at Bridge/runner dependency boundaries; production builds still enforce the exact allowlist**

- [ ] **Step 4: Cover current-tab capture, CLI remote job, repeated URL update, and needs-attention behavior**

- [ ] **Step 5: Run `npm run build && npm test`; expect every unit, integration, and E2E test passing**

- [ ] **Step 6: Commit with `test: cover end-to-end collection flow`**

---

### Task 10: Documentation, packaging, and real WeChat smoke test

**Files:**
- Create: `README.md`, `docs/product.md`, `docs/protocol.md`, `docs/testing.md`, `SECURITY.md`, `LICENSE`
- Create: `scripts/package-extension.mjs`, `scripts/smoke-wechat.mjs`
- Modify: root `package.json`

**Interfaces:**
- Consumes: built bridge/CLI/extension and the supplied public WeChat URL.
- Produces: installable zip, operator docs, smoke report, and an actual local Markdown entry.

- [ ] **Step 1: Add package verification that rejects missing manifest entries, source maps, `.env`, tokens, fixture private content, and files outside the dist allowlist**

- [ ] **Step 2: Write README quick start with exact commands**

```bash
npm install
npm run build
npm run collector -- bridge start
# Chrome → chrome://extensions → Developer mode → Load unpacked
# choose packages/extension/dist and enter the printed pairing code
npm run collector -- collect 'https://mp.weixin.qq.com/s/uW5gUigjslVY24YmCYhg0g' --wait 60000
```

- [ ] **Step 3: Document architecture, protocol/versioning, permissions, privacy, troubleshooting, output schema, Codex invocation, and future `FaasSink` integration boundary**

- [ ] **Step 4: Build `artifacts/data-collector-extension-0.1.0.zip` reproducibly and inspect its file list**

- [ ] **Step 5: Run the supplied URL through the real extension and Bridge**

Assert title `一夜之间，通胀的玩笑这次开大了`, author `重远投资观`, non-empty body, original URL, image success or explicit remote fallback, and stable path/index after a second run. Save only the generated knowledge entry and a sanitized smoke summary, never browser credentials.

- [ ] **Step 6: Run final verification**

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run test:coverage
npm run package
git diff --check
git status --short
```

- [ ] **Step 7: Commit with `docs: ship data collector 0.1.0`**
