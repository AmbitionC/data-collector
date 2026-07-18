# Edge Side Panel Auto Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release Data Collector 0.2.0 as an Edge native side panel that auto-authorizes the one fixed extension identity and contains no pairing-code workflow.

**Architecture:** A manifest public key gives the unpacked extension a deterministic Chromium ID. The loopback Bridge accepts WebSocket bootstrap only from that exact extension Origin, creates or reuses its protected bearer token, and sends the token in a `bridge.authorized` envelope; all HTTP mutations and later sockets retain token authentication. The existing popup becomes one responsive `sidepanel/` UI, while Edge owns the right-side split and webpage resizing.

**Tech Stack:** TypeScript 7, Manifest V3 `chrome.sidePanel`, Node.js HTTP + `ws`, Zod protocol validation, Vitest/JSDOM, esbuild, Puppeteer.

## Global Constraints

- Bind the Bridge only to `127.0.0.1`; do not add Native Messaging, daemons, or dependencies.
- Trust exactly extension ID `ehblgjpcidoabjhojfhiaaobaacphhck` through `chrome-extension://` and `extension://` Origins.
- Commit only the public manifest key; never create or retain a private key in the repository or package.
- Keep the Chromium minimum version at `116` and publish this incompatible UX change as `0.2.0`.
- Remove `pair.submit`, `POST /v1/pair`, six-digit codes, `unpaired`, and every built `popup/` resource.
- Preserve authenticated HTTP jobs/reveal, token file mode `0600`, retry behavior, page extractors, and local Markdown output.
- Develop test-first, run the focused red/green command for each task, and commit each independently testable result.

---

## File Map

- `packages/shared/src/identity.ts`: single source of truth for release version, fixed extension ID, trusted Origins, and manifest public key.
- `packages/shared/src/protocol.ts`: schema for `bridge.authorized` payload.
- `packages/bridge/src/auth.ts`: protected token persistence without pairing-code state.
- `packages/bridge/src/server/websocket.ts`: exact-Origin socket authorization and bootstrap.
- `packages/bridge/src/server/index.ts`: health identity metadata and automatic authorization envelope.
- `packages/bridge/src/cli.ts`: no-pairing startup and pre-authorization guidance.
- `packages/extension/src/background/connection.ts`: health identity check, bootstrap socket, token storage, and reconnection.
- `packages/extension/src/background/index.ts`: Side Panel action configuration and reduced message surface.
- `packages/extension/src/sidepanel/*`: the only extension page and its responsive state renderer.
- `packages/extension/manifest.json`: `sidePanel` permission/path, public key, fixed 0.2.0 version, no popup.
- `packages/extension/scripts/build.mjs`: builds and copies only `sidepanel/` assets.
- `scripts/package-extension.mjs`: allowlist and versioned reproducible 0.2.0 archive.
- `tests/**`: unit, integration, packaging, and browser regression coverage for the new workflow.
- `README.md`, `SECURITY.md`, `docs/{product,protocol,testing}.md`: current operator and security contract.

### Task 1: Fixed Identity and Authorization Protocol

**Files:**
- Create: `packages/shared/src/identity.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/protocol.ts`
- Test: `tests/unit/identity.test.ts`

**Interfaces:**
- Produces: `APP_VERSION`, `TRUSTED_EXTENSION_ID`, `TRUSTED_EXTENSION_ORIGINS`, `MANIFEST_PUBLIC_KEY`.
- Produces: `bridgeAuthorizedPayloadSchema` and `BridgeAuthorizedPayload` with `{ token: string }`.

- [ ] **Step 1: Write the failing identity and payload tests**

```ts
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  APP_VERSION,
  MANIFEST_PUBLIC_KEY,
  TRUSTED_EXTENSION_ID,
  TRUSTED_EXTENSION_ORIGINS,
  bridgeAuthorizedPayloadSchema,
} from '@data-collector/shared';

it('derives the fixed extension ID from the manifest public key', () => {
  const digest = createHash('sha256').update(Buffer.from(MANIFEST_PUBLIC_KEY, 'base64')).digest();
  const derived = [...digest.subarray(0, 16)]
    .flatMap(byte => [byte >> 4, byte & 15])
    .map(nibble => String.fromCharCode(97 + nibble)).join('');
  expect(derived).toBe('ehblgjpcidoabjhojfhiaaobaacphhck');
  expect(TRUSTED_EXTENSION_ID).toBe(derived);
  expect(TRUSTED_EXTENSION_ORIGINS).toEqual(new Set([
    `chrome-extension://${derived}`,
    `extension://${derived}`,
  ]));
  expect(APP_VERSION).toBe('0.2.0');
});

it('accepts only strong authorization tokens', () => {
  expect(bridgeAuthorizedPayloadSchema.parse({ token: 'x'.repeat(43) })).toEqual({ token: 'x'.repeat(43) });
  expect(() => bridgeAuthorizedPayloadSchema.parse({ token: 'short' })).toThrow();
});
```

- [ ] **Step 2: Run the focused test and verify the missing exports fail**

Run: `npm test -- tests/unit/identity.test.ts`

Expected: FAIL because `identity.ts` and `bridgeAuthorizedPayloadSchema` do not exist.

- [ ] **Step 3: Implement the shared identity and payload**

```ts
export const APP_VERSION = '0.2.0';
export const TRUSTED_EXTENSION_ID = 'ehblgjpcidoabjhojfhiaaobaacphhck';
export const MANIFEST_PUBLIC_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA5j32H1bhAUPC0m0KrRBNrt+b/aEK4NInYbdOKtnxdtBiXU2sZnw+GvWcHKe7qV5U2182ckYlquJvZWAIecHZmRN4uA/TuadXt0nQt9p0LYLHobquh8G0cBv39N/H7AzHcb+eFTgKJ/rP6F4VPKrXheELstyHwUoGl8kE8zESQxjt0i679tJon/QXsKCwqr8YVGg1Yoc0Rs/0o1EZBWEgNCthuVpD6RcmkmchdTavYhgqAhhB/nISMJv3c1xwM85hypSNBJIeTi685W7FVz/mH5nGNHKatN3wKoahtgb1UKckTDErtRwUJzv9htcvNy6sUoTqVo3fwNTU750olVEzdwIDAQAB';
export const TRUSTED_EXTENSION_ORIGINS = new Set([
  `chrome-extension://${TRUSTED_EXTENSION_ID}`,
  `extension://${TRUSTED_EXTENSION_ID}`,
]);
```

Add `z.object({ token: z.string().min(32).max(512) })` to `protocol.ts`, export its inferred type, and re-export both modules from `index.ts`.

- [ ] **Step 4: Run focused tests and type checking**

Run: `npm test -- tests/unit/identity.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the identity contract**

```bash
git add packages/shared/src tests/unit/identity.test.ts
git commit -m "feat: define fixed extension identity"
```

### Task 2: Replace Pairing State with Protected Token Storage

**Files:**
- Modify: `packages/bridge/src/auth.ts`
- Test: `tests/unit/bridge-auth.test.ts`
- Modify: any test importing `PairingManager`

**Interfaces:**
- Produces: `AccessTokenManager.open(authFile, overrides?)`, `ensureToken(): Promise<string>`, `verify(candidate): boolean`, `token(): string | undefined`.
- Preserves: atomic JSON write, parent mode `0700`, file mode `0600`, minimum token length 32.

- [ ] **Step 1: Write failing persistence tests**

```ts
const manager = await AccessTokenManager.open(authFile, { token: () => 'a'.repeat(43) });
expect(manager.token()).toBeUndefined();
expect(await manager.ensureToken()).toBe('a'.repeat(43));
expect(manager.verify('a'.repeat(43))).toBe(true);

const reopened = await AccessTokenManager.open(authFile);
expect(await reopened.ensureToken()).toBe('a'.repeat(43));
expect((await stat(authFile)).mode & 0o777).toBe(0o600);
```

Also assert a dependency token shorter than 32 characters rejects and no API named `createPairingCode` or `exchange` remains.

- [ ] **Step 2: Run the focused test and verify the new class is absent**

Run: `npm test -- tests/unit/bridge-auth.test.ts`

Expected: FAIL importing `AccessTokenManager`.

- [ ] **Step 3: Implement `AccessTokenManager`**

Keep `writeProtectedJson()` and digest-based constant-time verification. Replace pairing dependencies with:

```ts
interface AccessTokenDependencies { token: () => string }
const DEFAULT_DEPENDENCIES = { token: () => randomBytes(32).toString('base64url') };

async ensureToken(): Promise<string> {
  if (this.currentToken) return this.currentToken;
  const token = this.dependencies.token();
  if (token.length < 32) throw new Error('访问令牌长度不足');
  await writeProtectedJson(this.authFile, { version: 1, token });
  this.currentToken = token;
  return token;
}
```

- [ ] **Step 4: Run auth tests**

Run: `npm test -- tests/unit/bridge-auth.test.ts`

Expected: PASS with no six-digit-code assertions.

- [ ] **Step 5: Commit token storage**

```bash
git add packages/bridge/src/auth.ts tests/unit/bridge-auth.test.ts
git commit -m "refactor: replace pairing codes with access tokens"
```

### Task 3: Exact-Origin WebSocket Bootstrap and Bridge API

**Files:**
- Modify: `packages/bridge/src/server/websocket.ts`
- Modify: `packages/bridge/src/server/index.ts`
- Modify: `packages/bridge/src/cli.ts`
- Modify: `tests/integration/bridge.test.ts`
- Modify: `tests/integration/cli.test.ts`

**Interfaces:**
- Consumes: `AccessTokenManager`, `TRUSTED_EXTENSION_ORIGINS`, `APP_VERSION`, `TRUSTED_EXTENSION_ID`.
- Produces: `onConnection(socket, { bootstrapToken?: string })`.
- Produces: `GET /health -> { ok, version, trustedExtensionId, extensionConnected }`.
- Removes: `BridgeHandle.pairingCode` and `POST /v1/pair`.

- [ ] **Step 1: Replace integration setup with a failing bootstrap helper**

```ts
async function authorize(bridge: BridgeHandle, origin = `chrome-extension://${TRUSTED_EXTENSION_ID}`) {
  const socket = new WebSocket(`${bridge.wsUrl}?bootstrap=1`, { origin });
  const message = await nextMessage<{ token: string }>(socket);
  expect(message.type).toBe('bridge.authorized');
  return { socket, token: message.payload.token };
}
```

Assert the trusted Origin receives a 32+ character token, that token authenticates `/v1/jobs`, reopening the same config returns the same token, random extension and webpage Origins receive `unexpected-response` status `401`, and `POST /v1/pair` returns `404`.

- [ ] **Step 2: Run integration tests and verify the old pair endpoint makes them fail**

Run: `npm test -- tests/integration/bridge.test.ts tests/integration/cli.test.ts`

Expected: FAIL because `?bootstrap=1` is unauthorized and `pairingCode` is still required.

- [ ] **Step 3: Implement exact-Origin bootstrap**

In the upgrade callback, require `TRUSTED_EXTENSION_ORIGINS.has(origin)`. Accept either a verified `token` query or `bootstrap=1`; for bootstrap, await `access.ensureToken()` before calling `handleUpgrade`. Pass the token only in the second callback argument:

```ts
onConnection: (socket, authorization) => {
  if (authorization.bootstrapToken) {
    socket.send(JSON.stringify(envelope('bridge.authorized', 'authorization', {
      token: authorization.bootstrapToken,
    })));
  }
  // attach the existing protocol handlers
}
```

The listener must catch asynchronous authorization errors and reject the raw socket with `500` without calling `handleUpgrade` twice.

- [ ] **Step 4: Remove HTTP pairing and update CLI messages**

Return `APP_VERSION` and `TRUSTED_EXTENSION_ID` from `/health`. Remove `pairSchema`, `/v1/pair`, `pairingCode`, and CLI printing. `bridge start` prints the Bridge URL and `等待受信任的 Data Collector 扩展自动连接`. When no token exists, `collect` returns `扩展尚未自动连接，请先启动 Bridge 并在 Edge 中打开 Data Collector 侧边栏`.

- [ ] **Step 5: Run integration and type tests**

Run: `npm test -- tests/integration/bridge.test.ts tests/integration/cli.test.ts && npm run typecheck`

Expected: PASS; untrusted Origins cannot create `auth.json`.

- [ ] **Step 6: Commit Bridge auto authorization**

```bash
git add packages/bridge packages/shared tests/integration
git commit -m "feat: auto authorize the fixed browser extension"
```

### Task 4: Extension Bootstrap Connection and Side Panel Action

**Files:**
- Modify: `packages/extension/src/background/connection.ts`
- Modify: `packages/extension/src/background/index.ts`
- Modify: `tests/unit/connection.test.ts`
- Modify: `tests/unit/background.test.ts`

**Interfaces:**
- Consumes: `bridge.authorized`, `APP_VERSION`, `TRUSTED_EXTENSION_ID`.
- Adds dependency: `extensionId: string` to `ConnectionDependencies`.
- Stores bridge statuses: `connecting`, `connected`, `disconnected`, `identity_error`, `protocol_error`.

- [ ] **Step 1: Write failing automatic connection tests**

Build `BridgeConnection` with empty storage and `extensionId: TRUSTED_EXTENSION_ID`. Assert it requests `/health`, opens `ws://127.0.0.1:17321/v1/extension?bootstrap=1`, saves the token from `bridge.authorized`, sends `extension.hello` with version `0.2.0`, and never calls `/v1/pair`. Add tests that a different health `trustedExtensionId` stores `identity_error` without opening a socket, and an existing token opens `?token=` directly.

- [ ] **Step 2: Run connection/background tests and verify red state**

Run: `npm test -- tests/unit/connection.test.ts tests/unit/background.test.ts`

Expected: FAIL because no-token state becomes `unpaired`, `pair()` still exists, and Side Panel behavior is not configured.

- [ ] **Step 3: Implement bootstrap connection**

Before a no-token socket, fetch `/health`; compare `trustedExtensionId` with `dependencies.extensionId`. Open bootstrap on match. In `handleMessage`, parse `bridgeAuthorizedPayloadSchema`, persist `{ bridgeToken, bridgeStatus: 'connected' }`, then call:

```ts
this.send('extension.hello', 'extension', { version: APP_VERSION });
this.startKeepalive();
```

Existing-token sockets send hello on `open`. Remove `pair()`. Change missing-token errors in `createJob()` and `reveal()` to say the extension is still automatically connecting.

- [ ] **Step 4: Configure the native Side Panel**

Remove the `pair.submit` runtime branch. Construct `BridgeConnection` with `extensionId: chrome.runtime.id`. Define a guarded, idempotent `configureSidePanel()` that calls:

```ts
await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
```

Call it at module initialization, `onInstalled`, and `onStartup`; preserve the reconnect alarm.

- [ ] **Step 5: Run focused tests and type checking**

Run: `npm test -- tests/unit/connection.test.ts tests/unit/background.test.ts && npm run typecheck`

Expected: PASS with no `pair.submit` or `unpaired` status.

- [ ] **Step 6: Commit extension connection behavior**

```bash
git add packages/extension/src/background tests/unit/connection.test.ts tests/unit/background.test.ts
git commit -m "feat: auto connect the browser side panel"
```

### Task 5: Manifest and Responsive Side Panel UI

**Files:**
- Modify: `packages/extension/manifest.json`
- Modify: `packages/extension/scripts/build.mjs`
- Rename: `packages/extension/src/popup/index.html` to `packages/extension/src/sidepanel/index.html`
- Rename: `packages/extension/src/popup/index.ts` to `packages/extension/src/sidepanel/index.ts`
- Rename: `packages/extension/src/popup/state.ts` to `packages/extension/src/sidepanel/state.ts`
- Rename: `packages/extension/src/popup/styles.css` to `packages/extension/src/sidepanel/styles.css`
- Modify: `tests/unit/popup.test.ts` and rename it to `tests/unit/sidepanel.test.ts`
- Modify: `tests/unit/package.test.ts`

**Interfaces:**
- Produces only `sidepanel/index.{html,js}` and `sidepanel/styles.css` in extension dist.
- UI phases: `loading`, `connecting`, `unsupported`, `ready`, `collecting`, `saved`, `needs_attention`, `job_error`, `bridge_unavailable`, `identity_error`.

- [ ] **Step 1: Write failing manifest/package assertions**

```ts
expect(manifest.permissions).toContain('sidePanel');
expect(manifest.side_panel).toEqual({ default_path: 'sidepanel/index.html' });
expect(manifest.action.default_popup).toBeUndefined();
expect(manifest.key).toBe(MANIFEST_PUBLIC_KEY);
expect(files).toEqual([
  'background.js', 'content.js', 'manifest.json',
  'sidepanel/index.html', 'sidepanel/index.js', 'sidepanel/styles.css',
]);
```

Assert the derived manifest ID equals `TRUSTED_EXTENSION_ID`, the manifest version is `0.2.0`, and no file path or built text contains `popup`, `pair`, `配对码`, or `unpaired`.

- [ ] **Step 2: Write failing UI state tests**

Assert `connecting` renders a persistent connection panel, `disconnected` maps to `bridge_unavailable` with a retry action, `identity_error` maps to its reinstall guidance, ready/saved behavior remains, the HTML has no `pair-form`, and the stylesheet includes `width: 100%`, `min-width: 280px`, `min-height: 100vh` with no absolute footer.

- [ ] **Step 3: Run focused tests and verify old popup behavior fails**

Run: `npm test -- tests/unit/package.test.ts tests/unit/sidepanel.test.ts`

Expected: FAIL until the files are renamed and manifest/UI contracts change.

- [ ] **Step 4: Move and simplify the UI**

Use `SidePanelState`, `SidePanelActions`, `sidePanelStateFromStatus`, and `renderSidePanel` names. Remove the pair form/action. Map connection statuses before job states. Keep polling at 250ms while connecting, 700ms while collecting, and 1000ms otherwise so a persistent panel follows active-tab changes. Use normal document flow, a sticky top status strip, `clamp()` spacing, single-column buttons below 420px, and two columns above 420px while preserving the archive-slip visual language.

- [ ] **Step 5: Update manifest and build output**

Set version `0.2.0`, public `key`, permission `sidePanel`, `side_panel.default_path`, and remove `action.default_popup`. Change the esbuild entry and asset-copy paths from `popup` to `sidepanel`.

- [ ] **Step 6: Run UI/package tests and build inspection**

Run: `npm test -- tests/unit/package.test.ts tests/unit/sidepanel.test.ts && npm run build`

Expected: PASS and `find packages/extension/dist -type f | sort` lists exactly six approved files under the new paths.

- [ ] **Step 7: Commit the Side Panel UI**

```bash
git add packages/extension tests/unit/package.test.ts tests/unit/sidepanel.test.ts
git commit -m "feat: replace popup with responsive Edge side panel"
```

### Task 6: Browser E2E, Versioned Package, and Documentation

**Files:**
- Modify: `tests/e2e/extension.test.ts`
- Modify: `scripts/package-extension.mjs`
- Modify: `package.json`, `package-lock.json`, `packages/*/package.json`
- Modify: `README.md`, `SECURITY.md`, `docs/product.md`, `docs/protocol.md`, `docs/testing.md`

**Interfaces:**
- Produces: `artifacts/data-collector-extension` and reproducible `artifacts/data-collector-extension-0.2.0.zip`.
- Documents: one-click Side Panel launch, automatic fixed-ID authorization, manual reload migration, and local-process security boundary.

- [ ] **Step 1: Rewrite the browser E2E expectation before production packaging changes**

Launch the built extension with the Bridge, navigate the fixture, resolve its extension ID, open `chrome-extension://<id>/sidepanel/index.html` as the testable Side Panel document, and assert it reaches `#ready-panel` without typing a code. Keep capture, saved Markdown, catalog de-duplication, and CLI collection assertions. Save screenshots as `sidepanel-ready.png` and `sidepanel-collecting.png`.

- [ ] **Step 2: Run the E2E test and verify it fails on missing sidepanel output**

Run: `npm run test:e2e`

Expected: FAIL before the build and E2E helpers fully use `sidepanel/index.html` and auto authorization.

- [ ] **Step 3: Complete E2E and packaging**

Derive the archive filename from `manifest.version` so the exact result is `data-collector-extension-0.2.0.zip`. Replace the stable unpacked directory atomically from the validated `packages/extension/dist`. Remove only the obsolete `data-collector-extension-0.1.0.zip` artifact after 0.2.0 validates.

- [ ] **Step 4: Bump workspace versions and update docs**

Set root and every workspace package to `0.2.0`, with internal dependency ranges exactly `0.2.0`, then run `npm install --package-lock-only`. Rewrite all live instructions to use the Side Panel and automatic authorization. State that WebSocket Origin blocks webpages/other extensions, but same-user local malware is outside the security boundary. Keep historical design files unchanged except where they claim to be current instructions.

- [ ] **Step 5: Run E2E, documentation scans, and reproducibility checks**

Run: `npm run test:e2e && npm run package && rg -n 'pair\.submit|/v1/pair|配对码|popup/index|unpaired' README.md SECURITY.md docs packages scripts tests --glob '!docs/superpowers/**'`

Expected: E2E PASS; the live-source scan has no matches; packaging prints the 0.2.0 ZIP path. Run packaging twice and compare SHA-256 values; they must match.

- [ ] **Step 6: Commit release/docs**

```bash
git add package.json package-lock.json packages scripts tests/e2e README.md SECURITY.md docs
git commit -m "release: package Data Collector side panel 0.2.0"
```

### Task 7: Full Verification, Cleanup, and Delivery

**Files:**
- Verify all tracked files
- Refresh ignored artifacts under `artifacts/`

**Interfaces:**
- Produces: a clean pushed branch and a validated reload directory for Edge Beta.

- [ ] **Step 1: Run the complete verification matrix**

Run: `npm test && npm run typecheck && npm run build && npm run test:coverage && npm run test:e2e && npm run package && git diff --check`

Expected: all tests pass, coverage meets existing thresholds, build/package succeeds, and diff check is empty.

- [ ] **Step 2: Audit generated and installed scope**

Run: `git status --short && git ls-files | rg '(private|\.pem$|auth\.json|node_modules|artifacts/)' || true && npm prune --dry-run`

Expected: no private key/auth/generated artifacts are tracked; no new runtime dependency or extra package is required.

- [ ] **Step 3: Review the aggregate diff against the design**

Check exact-Origin comparison, absence of the pairing route/UI, persisted-token authorization on every HTTP write, Side Panel resource allowlist, version consistency, test temp cleanup, and user-facing reload instructions. Correct any issue with a failing regression test before changing production code.

- [ ] **Step 4: Refresh the stable installation directory**

Run the validated packaging workflow so `artifacts/data-collector-extension` contains the six 0.2.0 files and `artifacts/data-collector-extension-0.2.0.zip` is reproducible. Inspect `artifacts/data-collector-extension/manifest.json` and derive its extension ID again.

- [ ] **Step 5: Push and report the exact Edge action**

Push the final commit to `origin/master`. Tell the user to remove the currently loaded old-ID extension once, load `/Users/chenhao/Code/data-collector/artifacts/data-collector-extension`, pin it, start the Bridge, and click the toolbar icon; no pairing field should appear.
