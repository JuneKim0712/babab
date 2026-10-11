/**
 * End-to-end test: loads the unpacked extension in headless Chrome and drives a
 * mock Amazon product page, a mock context.dev and a mock Gemini prediction markets.
 *
 *   npm install && npm run e2e
 *
 * Needs openssl and Chrome for Testing / Chromium via CHROME_PATH. Branded Google Chrome
 * 137+ ignores --load-extension, so get a test build with:
 *   npx @puppeteer/browsers install chrome@stable
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { createServer, stats } from '../test-page/serve.mjs';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// EXT_DIR lets CI run the same checks against an unzipped PriceOracle.zip.
const root = process.env.EXT_DIR ? path.resolve(process.env.EXT_DIR) : repoDir;
const shots = process.env.SHOT_DIR || path.join(repoDir, 'tests', 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const PORT = 44391;
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const PRODUCT = 'https://www.amazon.com/dp/B0CX23V258';

const server = createServer();
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: chromePath,
  dumpio: Boolean(process.env.DUMPIO),
  headless: true,
  args: [
    '--no-sandbox',
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    `--host-resolver-rules=MAP www.amazon.com 127.0.0.1:${PORT}, MAP api.context.dev 127.0.0.1:${PORT}, MAP api.gemini.com 127.0.0.1:${PORT}`,
    '--ignore-certificate-errors',
    '--window-size=1280,1000'
  ]
});

let failures = 0;
async function step(name, fn) {
  try {
    const t0 = Date.now();
    await fn();
    if (process.env.DUMPIO) console.log('       (' + (Date.now() - t0) + ' ms)');
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

/** Read text/attributes from inside the widget's shadow root. */
const shadow = (page, fn, arg) =>
  page.evaluate((src, a) => {
    const root = document.getElementById('price-oracle-host')?.shadowRoot;
    return root ? new Function('root', 'arg', `return (${src})(root, arg)`)(root, a) : null;
  }, fn.toString(), arg);

async function waitReady(page, timeout = 20000) {
  await page.waitForFunction(
    () => document.getElementById('price-oracle-host')?.shadowRoot?.querySelector('.po-pill'),
    { timeout }
  );
}

try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('service-worker.js'), { timeout: 15000 });
  const extId = new URL(swTarget.url()).host;
  console.log(`extension id: ${extId}`);

  await step('installing opens the welcome page', async () => {
    const welcome = await browser.waitForTarget((t) => t.url().endsWith('/src/welcome/welcome.html'), { timeout: 10000 });
    const welcomePage = await welcome.asPage();
    assert.match(await welcomePage.$eval('h1', (el) => el.textContent), /PriceOracle is ready/);
    assert.equal(await welcomePage.$eval('.cta', (el) => el.getAttribute('href')), 'https://www.amazon.com/dp/B09B8V1LZ3');
    await welcomePage.screenshot({ path: path.join(shots, '00-welcome.png') });
    await welcomePage.close(); // it steals focus; background tabs do not paint, which stalls the test
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  page.on('pageerror', (e) => console.log('  page error:', e.message));

  await step('widget is injected right after the price block inside a shadow root', async () => {
    await page.goto(PRODUCT, { waitUntil: 'load' });
    await waitReady(page);
    const placement = await page.evaluate(() => {
      const host = document.getElementById('price-oracle-host');
      return {
        afterPrice: host.previousElementSibling?.id === 'corePriceDisplay_desktop_feature_div',
        mode: host.shadowRoot.mode
      };
    });
    assert.equal(placement.afterPrice, true);
    assert.equal(placement.mode, 'open');
  });

  await step('card shows recommendation, 5 tiers, pin, delta and context.dev chip', async () => {
    const info = await shadow(page, (root) => ({
      pill: root.querySelector('.po-pill')?.className,
      tiers: [...root.querySelectorAll('.po-tier')].map((t) => t.textContent.replace(/\s+/g, ' ').trim()),
      ticks: root.querySelectorAll('.po-tick').length,
      pin: root.querySelector('.po-pin-label')?.textContent,
      delta: root.querySelector('.po-delta')?.textContent,
      chip: root.querySelector('.po-chip')?.textContent.trim(),
      confidence: root.querySelector('.po-confidence')?.textContent
    }));
    console.log('       ', JSON.stringify(info));
    assert.match(info.pill, /po-pill (WAIT|BUY_NOW|FAIR_PRICE)/);
    assert.equal(info.tiers.length, 5);
    assert.ok(info.tiers[0].endsWith('LOWEST') && info.tiers[4].endsWith('HIGHEST'));
    assert.equal(info.ticks, 5);
    assert.equal(info.pin, 'Current: $174.99');
    assert.match(info.delta, /[▼▲▬] [+-]?\d+\.\d%/);
    assert.match(info.chip, /context\.dev: Connected/);
    assert.match(info.confidence, /\d+% confidence/);
  });

  await step('context.dev was called with Bearer key, ASIN url and formats', async () => {
    assert.equal(stats.extract, 1);
    assert.equal(stats.extractAuthOk, 1);
    assert.equal(stats.lastExtractBody.url, 'https://www.amazon.com/dp/B0CX23V258');
    assert.deepEqual(stats.lastExtractBody.formats, { json: true, markdown: true });
    assert.ok(stats.lastExtractBody.jsonParams.schema.properties.listPrice);
  });

  await step('Gemini markets is live with no key and summarised in the card', async () => {
    const text = await shadow(page, (root) => root.querySelector('.po-foot .po-btn')?.textContent);
    assert.match(text, /^Gemini Markets: Live — Fed hike odds \d+%, cut odds \d+% · recession odds \d+%$/);
    assert.equal(stats.markets, 1);
    assert.equal(stats.lastGeminiKeyHeader, null);
  });

  await step('Amazon page CSS does not leak into the widget', async () => {
    const styles = await shadow(page, (root) => {
      const cs = getComputedStyle(root.querySelector('.po-tier-price'));
      const card = getComputedStyle(root.querySelector('.po-card'));
      return { letterSpacing: card.letterSpacing, color: cs.color, size: cs.fontSize };
    });
    assert.equal(styles.size, '13px');
    assert.equal(styles.letterSpacing, 'normal');
    assert.equal(styles.color, 'rgb(15, 23, 42)');
  });

  await page.screenshot({ path: path.join(shots, '01-widget-gemini-live.png'), clip: { x: 0, y: 0, width: 1100, height: 760 } });

  await step('second visit is served from the 24h ASIN cache (no new context.dev call)', async () => {
    await page.reload({ waitUntil: 'load' });
    await waitReady(page);
    assert.equal(stats.extract, 1);
    assert.equal(stats.markets, 1); // macro odds are cached for 3 hours too
    const chip = await shadow(page, (root) => root.querySelector('.po-chip')?.textContent.trim());
    assert.match(chip, /\(cached\)/);
  });

  await step('selecting another variant re-renders without a page reload', async () => {
    await page.evaluate(() => (window.__marker = 'same-document'));
    await page.click('button[data-asin="B0CX23V260"]');
    await page.waitForFunction(
      () => document.getElementById('price-oracle-host')?.shadowRoot?.querySelector('.po-pin-label')?.textContent === 'Current: $129.50',
      { timeout: 15000 }
    );
    assert.equal(await page.evaluate(() => window.__marker), 'same-document');
    assert.equal(stats.extract, 2); // new ASIN -> one new context.dev call
    assert.equal(await page.evaluate(() => document.querySelectorAll('#price-oracle-host').length), 1);
  });

  const opts = await browser.newPage();
  await opts.setViewport({ width: 900, height: 900 });
  await opts.goto(`chrome-extension://${extId}/src/options/options.html`);

  await step('options page pre-fills the context.dev key; Gemini key is optional', async () => {
    assert.equal(await opts.$eval('#context-key', (el) => el.value), 'ctxt_secret_7390b0f7f788470c85aa687254599803');
    assert.equal(await opts.$eval('#gemini-key', (el) => el.value), '');
    assert.match(await opts.$eval('#gemini-state', (el) => el.textContent), /no key/i);
  });

  await step('Test Connection reaches context.dev and Gemini prediction markets', async () => {
    await opts.click('#test');
    await opts.waitForFunction(
      () => /Connected/.test(document.getElementById('res-context').textContent) && /Connected/.test(document.getElementById('res-gemini').textContent),
      { timeout: 20000 }
    );
    assert.match(await opts.$eval('#res-context', (el) => el.textContent), /989 credits remaining/);
    assert.match(await opts.$eval('#res-gemini', (el) => el.textContent), /prediction markets reachable/);
    await opts.screenshot({ path: path.join(shots, '02-options.png') });
  });

  await step('an optional Gemini key is saved and sent as X-GEMINI-APIKEY', async () => {
    await opts.type('#gemini-key', 'my-gemini-key');
    await opts.click('#save');
    await opts.waitForFunction(() => /Settings saved/.test(document.getElementById('banner').textContent));
    await page.bringToFront();
    await page.goto(PRODUCT, { waitUntil: 'load' });
    await waitReady(page);
    assert.equal(stats.markets, 2); // saving a key clears the macro cache
    assert.equal(stats.lastGeminiKeyHeader, 'my-gemini-key');
  });

  await step('if Gemini markets is down the card falls back to the heuristic model', async () => {
    stats.marketsDown = true;
    await opts.bringToFront();
    await opts.click('#save'); // clears the macro cache
    await opts.waitForFunction(() => /Settings saved/.test(document.getElementById('banner').textContent));
    await page.bringToFront();
    await page.goto('https://www.amazon.com/dp/B0CX23V259', { waitUntil: 'load' });
    await waitReady(page);
    const text = await shadow(page, (root) => root.querySelector('.po-foot .po-btn')?.textContent);
    assert.equal(text, 'Gemini Markets: Offline — running on heuristic model');
    assert.match(await shadow(page, (root) => root.querySelector('.po-pill')?.className), /po-pill (WAIT|BUY_NOW|FAIR_PRICE)/);
    await page.screenshot({ path: path.join(shots, '03-widget-gemini-offline.png'), clip: { x: 0, y: 0, width: 1100, height: 760 } });
    stats.marketsDown = false;
  });

  const popup = await browser.newPage();
  await popup.setViewport({ width: 360, height: 640 });
  await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`);

  await step('popup shows last analysis, stats and key status; modal saves a key', async () => {
    await popup.waitForFunction(() => !document.getElementById('last-body').hidden, { timeout: 10000 });
    assert.ok(Number(await popup.$eval('#stat-count', (el) => el.textContent)) >= 3);
    assert.match(await popup.$eval('#ctx-status', (el) => el.textContent), /Default key active/);
    await popup.click('#add-gemini');
    assert.equal(await popup.$eval('#modal', (el) => el.hidden), false);
    await popup.screenshot({ path: path.join(shots, '04-popup-modal.png') });
    await popup.type("#gemini-input", "popup-key");
    await popup.click('#modal-save');
    await popup.waitForFunction(() => document.getElementById('modal').hidden, { timeout: 5000 });
    assert.match(await popup.$eval('#gem-status', (el) => el.textContent), /Offline/); // last analysis ran while markets were down
    assert.match(await popup.$eval('#gem-key-status', (el) => el.textContent), /Saved/);
    await popup.screenshot({ path: path.join(shots, '05-popup.png') });
  });
} finally {
  await browser.close();
  server.close();
}

console.log(failures ? `\n${failures} e2e check(s) failed` : '\nall e2e checks passed');
process.exit(failures ? 1 : 0);
