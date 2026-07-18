import { access, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { afterEach, describe, expect, it } from 'vitest';
import { startBridge, type BridgeHandle } from '../../packages/bridge/src/index.js';

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXTENSION_PATH = join(WORKSPACE, 'packages', 'extension', 'dist');
const TARGET_URL = 'https://mp.weixin.qq.com/s/uW5gUigjslVY24YmCYhg0g';
let browser: Browser | undefined;
let bridge: BridgeHandle | undefined;

afterEach(async () => {
  await browser?.close();
  await bridge?.close();
  browser = undefined;
  bridge = undefined;
});

async function popupFor(targetPage: Page): Promise<Page> {
  const workerTarget = await browser!.waitForTarget(
    target => target.type() === 'service_worker' && target.url().endsWith('background.js'),
    { timeout: 20_000 },
  );
  const worker = await workerTarget.worker();
  if (!worker) throw new Error('扩展 Service Worker 未启动');
  await targetPage.bringToFront();
  await worker.evaluate(() => (globalThis as { chrome: { action: { openPopup(): Promise<void> } } }).chrome.action.openPopup());
  const popupTarget = await browser!.waitForTarget(
    target => target.type() === 'page' && target.url().endsWith('popup/index.html'),
    { timeout: 10_000 },
  );
  const page = popupTarget.asPage();
  if (!page) throw new Error('扩展弹窗没有可交互页面');
  return page;
}

async function preferredChrome(): Promise<string | undefined> {
  const candidates = [
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

describe('built Chrome extension', () => {
  it('pairs, captures a WeChat page, and writes visible output', async () => {
    const libraryRoot = await mkdtemp(join(tmpdir(), 'data-collector-e2e-'));
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
    });

    const fixture = await readFile(join(WORKSPACE, 'tests', 'fixtures', 'wechat-article.html'), 'utf8');
    const articlePage = await browser.newPage();
    await articlePage.setRequestInterception(true);
    articlePage.on('request', request => {
      if (request.isNavigationRequest() && request.url().startsWith(TARGET_URL)) {
        void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture });
      } else {
        void request.continue();
      }
    });
    await articlePage.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

    const popup = await popupFor(articlePage);
    await popup.waitForSelector('#unpaired-panel:not([hidden])', { timeout: 10_000 });
    await popup.type('#pair-code', bridge.pairingCode);
    await popup.click('#pair-form button[type="submit"]');
    await popup.waitForSelector('#ready-panel:not([hidden])', { timeout: 10_000 });
    expect(await popup.$eval('#page-title', element => element.textContent)).toContain('一夜之间');

    const screenshotDirectory = join(WORKSPACE, 'artifacts', 'screenshots');
    await mkdir(screenshotDirectory, { recursive: true });
    await popup.screenshot({ path: join(screenshotDirectory, 'popup-ready.png') });
    await popup.click('#capture-button');
    await popup.waitForSelector('#collecting-panel:not([hidden])', { timeout: 10_000 });
    await popup.screenshot({ path: join(screenshotDirectory, 'popup-collecting.png') });
    await popup.waitForSelector('#saved-panel:not([hidden])', { timeout: 15_000 });

    const outputPath = (await popup.$eval('#saved-path', element => element.textContent ?? '')).trim();
    expect(outputPath).toMatch(/index\.md$/);
    const markdown = await readFile(outputPath, 'utf8');
    expect(markdown).toContain('一夜之间，通胀的玩笑这次开大了');
    expect(markdown).toContain('重远投资观');
    expect(markdown).toContain(TARGET_URL);
  });
});
