import { access, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, {
  type Browser,
  type Page,
  type Target,
  type WebWorker,
} from 'puppeteer-core';
import { afterEach, describe, expect, it } from 'vitest';
import { startBridge, type BridgeHandle } from '../../packages/bridge/src/index.js';
import { runCli } from '../../packages/bridge/src/cli.js';
import { TRUSTED_EXTENSION_ID } from '../../packages/shared/src/index.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXTENSION_PATH = join(WORKSPACE, 'packages', 'extension', 'dist');
const TARGET_URL = 'https://mp.weixin.qq.com/s/uW5gUigjslVY24YmCYhg0g';
let browser: Browser | undefined;
let bridge: BridgeHandle | undefined;
const temporaryDirectories = createTemporaryDirectoryTracker();

afterEach(async () => {
  const activeBrowser = browser;
  const activeBridge = bridge;
  browser = undefined;
  bridge = undefined;
  const closeResults = await Promise.allSettled([
    Promise.resolve().then(() => activeBrowser?.close()),
    Promise.resolve().then(() => activeBridge?.close()),
  ]);
  const cleanupResults = await Promise.allSettled([temporaryDirectories.cleanup()]);
  const failures = [...closeResults, ...cleanupResults]
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason);
  if (failures.length) throw new AggregateError(failures, 'E2E 资源清理失败');
});

async function sidePanelFor(targetPage: Page): Promise<{ page: Page; worker: WebWorker }> {
  const workerTarget = await browser!.waitForTarget(
    target => target.type() === 'service_worker' && target.url().endsWith('background.js'),
    { timeout: 20_000 },
  );
  const worker = await workerTarget.worker();
  if (!worker) throw new Error('扩展 Service Worker 未启动');
  const extensionId = new URL(workerTarget.url()).host;
  expect(extensionId).toBe(TRUSTED_EXTENSION_ID);
  const sidePanel = await browser!.newPage();
  await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel/index.html`, {
    waitUntil: 'domcontentloaded',
  });
  await targetPage.bringToFront();
  return { page: sidePanel, worker };
}

async function waitForVisiblePanel(page: Page, selector: string, timeout: number): Promise<void> {
  const session = await page.createCDPSession();
  const deadline = Date.now() + timeout;
  try {
    while (Date.now() < deadline) {
      const { root } = await session.send('DOM.getDocument');
      const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      const { attributes } = await session.send('DOM.getAttributes', { nodeId });
      if (!attributes.includes('hidden')) return;
      await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    }
  } finally {
    await session.detach();
  }
  throw new Error(`等待侧栏状态超时：${selector}`);
}

async function elementText(page: Page, selector: string): Promise<string> {
  const session = await page.createCDPSession();
  try {
    const { root } = await session.send('DOM.getDocument');
    const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    const { outerHTML } = await session.send('DOM.getOuterHTML', { nodeId });
    return outerHTML
      .replace(/^<[^>]+>|<\/[^>]+>$/g, '')
      .replaceAll('&amp;', '&')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .trim();
  } finally {
    await session.detach();
  }
}

async function captureCurrentFromSidePanel(
  page: Page,
  overrides: { userCategory: string; userTags: string[] },
): Promise<void> {
  const session = await page.createCDPSession();
  try {
    const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
      expression: `(() => {
        const category = document.querySelector('#category');
        const tags = document.querySelector('#tags');
        const capture = document.querySelector('#capture-button');
        if (!(category instanceof HTMLInputElement) ||
            !(tags instanceof HTMLInputElement) ||
            !(capture instanceof HTMLButtonElement)) {
          throw new Error('Side Panel capture controls are missing');
        }
        category.value = ${JSON.stringify(overrides.userCategory)};
        tags.value = ${JSON.stringify(overrides.userTags.join(', '))};
        capture.click();
        return true;
      })()`,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text);
    if (result.value !== true) throw new Error('Side Panel capture click failed');
  } finally {
    await session.detach();
  }
}

async function waitForExtensionReady(worker: WebWorker, url: string, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ready = await worker.evaluate(async expectedUrl => {
      const values = await chrome.storage.local.get(['bridgeStatus']);
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return values.bridgeStatus === 'connected' && tab?.url === expectedUrl;
    }, url);
    if (ready) return;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  throw new Error(`扩展没有在目标文章上完成自动授权：${url}`);
}

async function preferredChrome(): Promise<string | undefined> {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function serveArticleFixture(page: Page, fixture: string): Promise<void> {
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.isNavigationRequest() && request.url().startsWith(TARGET_URL)) {
      void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture });
    } else {
      void request.continue();
    }
  });
}

describe('built Chrome extension', () => {
  it('automatically authorizes the side panel, captures the current page, then updates it through the Codex CLI', async () => {
    const libraryRoot = await temporaryDirectories.create('data-collector-e2e-');
    bridge = await startBridge({
      port: 17321,
      libraryRoot,
      configDir: join(libraryRoot, '.config'),
      fetch: async () => {
        await new Promise(resolveDelay => setTimeout(resolveDelay, 1_200));
        return new Response(null, { status: 404 });
      },
    });
    const executablePath = await preferredChrome();
    if (!executablePath) {
      throw new Error('未找到 Chrome；请设置 PUPPETEER_EXECUTABLE_PATH 后重试');
    }
    browser = await puppeteer.launch({
      pipe: true,
      headless: true,
      enableExtensions: [EXTENSION_PATH],
      executablePath,
      timeout: 20_000,
      protocolTimeout: 20_000,
      signal: AbortSignal.timeout(25_000),
    });

    const fixture = await readFile(join(WORKSPACE, 'tests', 'fixtures', 'wechat-article.html'), 'utf8');
    const articlePage = await browser.newPage();
    await serveArticleFixture(articlePage, fixture);
    await articlePage.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

    const { page: sidePanel, worker } = await sidePanelFor(articlePage);
    await waitForExtensionReady(worker, TARGET_URL, 10_000);
    await waitForVisiblePanel(sidePanel, '#ready-panel', 10_000);
    expect(await elementText(sidePanel, '#page-title')).toContain('一夜之间');

    const screenshotDirectory = join(WORKSPACE, 'artifacts', 'screenshots');
    await mkdir(screenshotDirectory, { recursive: true });
    await sidePanel.screenshot({ path: join(screenshotDirectory, 'sidepanel-ready.png') });
    const openedArticleTargets: string[] = [];
    const recordArticleTarget = (target: Target) => {
      if (target.type() === 'page' && target.url().startsWith(TARGET_URL)) {
        openedArticleTargets.push(target.url());
      }
    };
    browser.on('targetcreated', recordArticleTarget);
    browser.on('targetchanged', recordArticleTarget);
    await captureCurrentFromSidePanel(sidePanel, {
      userCategory: 'E2E 指定分类',
      userTags: ['E2E 标签', '当前页面'],
    });
    await waitForVisiblePanel(sidePanel, '#collecting-panel', 10_000);
    await sidePanel.screenshot({ path: join(screenshotDirectory, 'sidepanel-collecting.png') });
    await waitForVisiblePanel(sidePanel, '#saved-panel', 15_000);

    const outputPath = await elementText(sidePanel, '#saved-path');
    expect(outputPath).toMatch(/index\.md$/);
    const markdown = await readFile(outputPath, 'utf8');
    expect(markdown).toContain('一夜之间，通胀的玩笑这次开大了');
    expect(markdown).toContain('重远投资观');
    expect(markdown).toContain(TARGET_URL);
    expect(markdown).toContain('category: "E2E 指定分类"');
    expect(markdown).toContain('  - "E2E 标签"');
    expect(markdown).toContain('  - "当前页面"');
    expect(openedArticleTargets).toEqual([]);
    expect((await browser.pages()).filter(page => page.url().startsWith(TARGET_URL)))
      .toHaveLength(1);
    browser.off('targetcreated', recordArticleTarget);
    browser.off('targetchanged', recordArticleTarget);

    let cliOutput = '';
    let cliError = '';
    const remoteFixtureSetups: Promise<void>[] = [];
    const interceptRemotePage = (target: Target) => {
      if (target.type() !== 'page') return;
      remoteFixtureSetups.push(
        target.page().then(async page => {
          if (page) await serveArticleFixture(page, fixture);
        }),
      );
    };
    browser.on('targetcreated', interceptRemotePage);
    const cliCode = await runCli(
      [
        'collect',
        TARGET_URL,
        '--wait',
        '30000',
        '--port',
        new URL(bridge.url).port,
        '--library',
        libraryRoot,
        '--config',
        join(libraryRoot, '.config'),
      ],
      {
        stdout: value => { cliOutput += value; },
        stderr: value => { cliError += value; },
      },
    );
    browser.off('targetcreated', interceptRemotePage);
    await Promise.all(remoteFixtureSetups);
    expect({ code: cliCode, error: cliError }).toEqual({ code: 0, error: '' });
    expect(cliOutput.trim()).toBe(outputPath);
    const catalog = JSON.parse(
      await readFile(join(libraryRoot, '_catalog', 'index.json'), 'utf8'),
    ) as unknown[];
    expect(catalog).toHaveLength(1);
  });
});
