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
    `--host-resolver-rules=MAP www.amazon.com 127.0.0.1:${PORT}, MAP api.context.dev 127.0.0.1:${PORT}, MAP api.gemini.com 127.0.0.1:${PORT}, MAP xylm-306e6.web.app 127.0.0.1:${PORT}`,
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
    const text = await shadow(page, (root) => root.querySelector('.po-foot .po-status')?.textContent);
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
    assert.equal(styles.size, '14px');
    assert.equal(styles.letterSpacing, 'normal');
    assert.equal(styles.color, 'rgb(15, 17, 17)');
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

  const SEARCH = 'https://www.amazon.com/s?k=echo+dot&i=amazon-devices&crid=108B55GQBXYNS&sprefix=echo+d%2Camazon-devices%2C229&ref=nb_sb_noss_2';
  const search = await browser.newPage();
  await search.setViewport({ width: 1280, height: 1000 });
  search.on('pageerror', (e) => console.log('  page error:', e.message));
  const chipHosts = (pg) => pg.evaluate(() => [...document.querySelectorAll('[data-price-oracle-chip]')].length);
  const waitChips = (pg, count) =>
    pg.waitForFunction(
      (n) => {
        const hosts = [...document.querySelectorAll('[data-price-oracle-chip]')];
        return hosts.length === n && hosts.every((h) => h.shadowRoot?.querySelector('button.pc-chip:not(.error)'));
      },
      { timeout: 20000 },
      count
    );
  const extractBefore = stats.extract;

  await step('search page: every card with a price gets a chip right after its price row', async () => {
    await search.goto(SEARCH, { waitUntil: 'load' });
    await waitChips(search, 3); // the "See options" card has no price, so no chip
    const info = await search.evaluate(() =>
      [...document.querySelectorAll('[data-price-oracle-chip]')].map((h) => ({
        asin: h.closest('[data-asin]').getAttribute('data-asin'),
        after: h.previousElementSibling?.getAttribute('data-cy') || h.previousElementSibling?.className,
        mode: h.shadowRoot.mode,
        chip: h.shadowRoot.querySelector('.pc-chip').textContent.replace(/\s+/g, ' ').trim()
      }))
    );
    console.log('       ', JSON.stringify(info));
    assert.deepEqual(info.map((i) => i.asin), ['B0SEARCH01', 'B0SEARCH02', 'B0SEARCH04']);
    assert.equal(info[0].after, 'price-recipe');
    assert.equal(info[1].after, 'a-row');
    for (const i of info) {
      assert.equal(i.mode, 'open');
      assert.match(i.chip, /(WAIT|BUY NOW|FAIR PRICE) [+-]?\d+\.\d% \/ 30d/);
    }
  });

  await step('search page: analysis is light (no context.dev credits) and reuses one Gemini markets call', async () => {
    assert.equal(stats.extract, extractBefore);
    assert.equal(stats.markets, 1);
  });

  await step('search page: chip styles are isolated from Amazon CSS', async () => {
    const styles = await search.evaluate(() => {
      const chip = document.querySelector('[data-price-oracle-chip]').shadowRoot.querySelector('.pc-chip');
      const cs = getComputedStyle(chip);
      return { size: cs.fontSize, spacing: cs.letterSpacing };
    });
    assert.equal(styles.size, '12px');
    assert.equal(styles.spacing, 'normal');
  });

  await step('search page: clicking a chip expands tiers; deep analysis calls context.dev once', async () => {
    await search.evaluate(() => document.querySelector('[data-price-oracle-chip]').shadowRoot.querySelector('.pc-chip').click());
    const panel = await search.evaluate(() => {
      const root = document.querySelector('[data-price-oracle-chip]').shadowRoot;
      return {
        tiers: root.querySelectorAll('.pc-tier').length,
        quick: /Quick estimate/.test(root.textContent),
        deep: root.querySelector('[data-action="deep"]')?.textContent.trim()
      };
    });
    assert.equal(panel.tiers, 5);
    assert.equal(panel.quick, true);
    assert.match(panel.deep, /Deep analysis/);
    await search.screenshot({ path: path.join(shots, '06-search-results.png'), clip: { x: 0, y: 0, width: 1100, height: 520 } });

    await search.evaluate(() => document.querySelector('[data-price-oracle-chip]').shadowRoot.querySelector('[data-action="deep"]').click());
    await search.waitForFunction(
      () => !document.querySelector('[data-price-oracle-chip]').shadowRoot.querySelector('[data-action="deep"]'),
      { timeout: 20000 }
    );
    assert.equal(stats.extract, extractBefore + 1);
    assert.equal(stats.lastExtractBody.url, 'https://www.amazon.com/dp/B0SEARCH01');
    assert.equal(await chipHosts(search), 3);
  });

  await step('search page: lazily loaded cards get a chip too', async () => {
    await search.click('#load-more');
    await waitChips(search, 4);
  });

  await search.close();
  await page.bringToFront();

  const opts = await browser.newPage();
  await opts.setViewport({ width: 900, height: 900 });
  await opts.goto(`chrome-extension://${extId}/src/options/options.html`);

  await step('options page pre-fills the context.dev key and has no Gemini key field', async () => {
    assert.equal(await opts.$eval('#context-key', (el) => el.value), 'ctxt_secret_7390b0f7f788470c85aa687254599803');
    assert.equal(await opts.$('#gemini-key'), null);
    assert.doesNotMatch(await opts.$eval('body', (el) => el.textContent), /Gemini API key/);
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

  await step('saving settings clears the macro cache; Gemini markets is called without any key', async () => {
    await opts.click('#save');
    await opts.waitForFunction(() => /Settings saved/.test(document.getElementById('banner').textContent));
    await page.bringToFront();
    await page.goto(PRODUCT, { waitUntil: 'load' });
    await waitReady(page);
    assert.equal(stats.markets, 2);
    assert.equal(stats.lastGeminiKeyHeader, null);
  });

  await step('options switches add and remove the product card live', async () => {
    await opts.bringToFront();
    await opts.click('#show-product-card');
    await page.waitForFunction(() => !document.getElementById('price-oracle-host'), { timeout: 10000 });
    await opts.click('#show-product-card');
    await page.bringToFront();
    await waitReady(page);
    assert.equal(await page.evaluate(() => document.querySelectorAll('#price-oracle-host').length), 1);
  });

  await step('options switch hides search chips live, keeps them off on new pages, and restores them', async () => {
    await opts.bringToFront();
    await opts.click('#show-search-chips');
    const search2 = await browser.newPage();
    await search2.setViewport({ width: 1280, height: 1000 });
    await search2.goto(SEARCH, { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await chipHosts(search2), 0);
    await opts.bringToFront();
    await opts.click('#show-search-chips');
    await search2.bringToFront();
    await waitChips(search2, 3);
    await opts.bringToFront();
    await opts.click('#show-search-chips');
    await search2.bringToFront();
    await search2.waitForFunction(() => document.querySelectorAll('[data-price-oracle-chip]').length === 0, { timeout: 10000 });
    await opts.bringToFront();
    await opts.click('#show-search-chips');
    await search2.close();
    await page.bringToFront();
  });

  await step('chip is keyboard accessible: Enter expands, Escape collapses', async () => {
    const search3 = await browser.newPage();
    await search3.setViewport({ width: 1280, height: 1000 });
    await search3.goto(SEARCH, { waitUntil: 'load' });
    await waitChips(search3, 3);
    const expanded = () => search3.evaluate(() => document.querySelector('[data-price-oracle-chip]').shadowRoot.querySelector('.pc-chip').getAttribute('aria-expanded'));
    await search3.evaluate(() => document.querySelector('[data-price-oracle-chip]').shadowRoot.querySelector('.pc-chip').focus());
    await search3.keyboard.press('Enter');
    await search3.waitForFunction(() => document.querySelector('[data-price-oracle-chip]').shadowRoot.querySelector('.pc-panel'), { timeout: 5000 });
    assert.equal(await expanded(), 'true');
    await search3.keyboard.press('Escape');
    await search3.waitForFunction(() => !document.querySelector('[data-price-oracle-chip]').shadowRoot.querySelector('.pc-panel'), { timeout: 5000 });
    assert.equal(await expanded(), 'false');
    await search3.close();
    await page.bringToFront();
  });

  await step('remembered prices show up on the card and "Clear price history" empties them', async () => {
    await opts.bringToFront();
    await opts.evaluate(() => {
      const d = 24 * 60 * 60 * 1000;
      const now = Date.now();
      return chrome.storage.local.set({ price_history: { B0CX23V258: [[now - 10 * d, 189], [now - 6 * d, 199], [now - 2 * d, 179]] } });
    });
    await page.bringToFront();
    await page.goto(PRODUCT, { waitUntil: 'load' });
    await waitReady(page);
    const row = await shadow(page, (root) => [...root.querySelectorAll('.po-row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()).find((t) => /price history/i.test(t)));
    assert.match(row, /Seen 4 times over 10 days · low \$174\.99 · high \$199\.00/);
    await opts.bringToFront();
    await opts.click('#clear-history');
    await opts.waitForFunction(() => /Price history cleared/.test(document.getElementById('banner').textContent));
    const left = await opts.evaluate(() => chrome.storage.local.get('price_history'));
    assert.deepEqual(left, {});
    await opts.click('#show-product-card'); // leave the switches as they were
    await opts.click('#show-product-card');
    await page.bringToFront();
  });

  await step('if Gemini markets is down the card falls back to the heuristic model', async () => {
    stats.marketsDown = true;
    await opts.bringToFront();
    await opts.click('#save'); // clears the macro cache
    await opts.waitForFunction(() => /Settings saved/.test(document.getElementById('banner').textContent));
    await page.bringToFront();
    await page.goto('https://www.amazon.com/dp/B0CX23V259', { waitUntil: 'load' });
    await waitReady(page);
    const text = await shadow(page, (root) => root.querySelector('.po-foot .po-status')?.textContent);
    assert.equal(text, 'Gemini Markets: Offline — running on heuristic model');
    assert.match(await shadow(page, (root) => root.querySelector('.po-pill')?.className), /po-pill (WAIT|BUY_NOW|FAIR_PRICE)/);
    await page.screenshot({ path: path.join(shots, '03-widget-gemini-offline.png'), clip: { x: 0, y: 0, width: 1100, height: 760 } });
    stats.marketsDown = false;
  });

  await step('a rejected context.dev key pauses calls for all products until Test Connection succeeds', async () => {
    const waitPin = (text) =>
      page.waitForFunction(
        (t) => document.getElementById('price-oracle-host')?.shadowRoot?.querySelector('.po-pin-label')?.textContent === t,
        { timeout: 15000 },
        text
      );
    await opts.bringToFront();
    await opts.evaluate(() => chrome.storage.local.remove(['context_cache', 'gemini_macro_backoff']));
    stats.contextStatus = 401;
    const before = stats.extract;
    await page.bringToFront();
    await page.goto(PRODUCT, { waitUntil: 'load' });
    await waitReady(page);
    assert.match(await shadow(page, (root) => root.querySelector('.po-chip')?.textContent.trim()), /context\.dev: Offline/);
    await page.click('button[data-asin="B0CX23V259"]');
    await waitPin('Current: $239.00');
    assert.equal(stats.extract, before + 1); // the second product never reached the API
    assert.match(await shadow(page, (root) => root.querySelector('.po-chip')?.getAttribute('title')), /paused until/);

    stats.contextStatus = 0;
    await opts.bringToFront();
    await opts.evaluate(() => { document.getElementById('res-context').textContent = ''; }); // drop the previous run's result
    await opts.click('#test');
    await opts.waitForFunction(() => /Connected/.test(document.getElementById('res-context').textContent), { timeout: 20000 });
    assert.deepEqual(await opts.evaluate(() => chrome.storage.local.get('context_pause')), {});
    await page.bringToFront();
    await page.click('button[data-asin="B0CX23V260"]');
    await waitPin('Current: $129.50');
    assert.match(await shadow(page, (root) => root.querySelector('.po-chip')?.textContent.trim()), /context\.dev: Connected/);
    assert.equal(stats.extract, before + 2);
  });

  await step('a rate-limited context.dev key (429) goes offline for under 5 minutes and recovers on its own', async () => {
    await opts.bringToFront();
    await opts.evaluate(() => chrome.storage.local.remove(['context_cache', 'context_pause']));
    stats.contextStatus = 429;
    await page.bringToFront();
    await page.goto(PRODUCT, { waitUntil: 'load' });
    await waitReady(page);
    assert.match(await shadow(page, (root) => root.querySelector('.po-chip')?.textContent.trim()), /context\.dev: Offline/);
    await opts.bringToFront();
    const { context_pause: pause } = await opts.evaluate(() => chrome.storage.local.get('context_pause'));
    const wait = pause.until - Date.now();
    assert.ok(wait > 0 && wait <= 5 * 60 * 1000, `a 429 pause must be short, was ${Math.round(wait / 1000)} s`);

    stats.contextStatus = 0;
    await opts.evaluate(() => chrome.storage.local.remove('context_pause'));
    await page.bringToFront();
    await page.goto(PRODUCT, { waitUntil: 'load' });
    await waitReady(page);
    assert.match(await shadow(page, (root) => root.querySelector('.po-chip')?.textContent.trim()), /context\.dev: Connected/);
  });

  // ---- Local price alerts (no account): card, notification, badge, popup, search bell, website page ------
  const EXPECTED_EXT_ID = 'gnckobeflimeehgaaliiibfliebjapbe';
  const SITE = 'https://xylm-306e6.web.app';
  const ASIN = 'B0CX23V258';
  const waitAlert = (pg, phase) =>
    pg.waitForFunction(
      (ph) => document.getElementById('price-oracle-host')?.shadowRoot?.querySelector(`.po-alert[data-phase="${ph}"]`),
      { timeout: 15000 },
      phase
    );
  const waitAlertText = (pg, re, timeout = 15000) =>
    pg.waitForFunction(
      (src) => new RegExp(src, 'i').test(document.getElementById('price-oracle-host')?.shadowRoot?.querySelector('.po-alert')?.textContent || ''),
      { timeout },
      re.source
    );
  const alertText = (pg) => shadow(pg, (root) => root.querySelector('.po-alert')?.textContent.replace(/\s+/g, ' ').trim());
  const clickAlert = (pg, action) => shadow(pg, (root, a) => root.querySelector(`[data-action="${a}"]`).click(), action);
  const typeTarget = (pg, value) => shadow(pg, (root, v) => { root.querySelector('[data-field="alert-target"]').value = v; }, value);
  const reloadProduct = async () => {
    await page.bringToFront();
    await page.goto(PRODUCT, { waitUntil: 'load' });
    await waitReady(page);
  };
  const stored = () => opts.evaluate(() => chrome.storage.local.get('price_alerts').then((s) => s.price_alerts || []));
  const mine = async () => (await stored()).find((a) => a.asin === ASIN);
  const send = (message) => opts.evaluate((m) => chrome.runtime.sendMessage(m), message);
  const badge = (pg) => pg.evaluate(() => chrome.action.getBadgeText({}));
  const waitBadge = (pg, text) => pg.waitForFunction((t) => chrome.action.getBadgeText({}).then((b) => b === t), { timeout: 10000, polling: 100 }, text);
  const notifications = () => opts.evaluate(() => new Promise((r) => chrome.notifications.getAll(r)));
  const clearNotifications = () => opts.evaluate(async () => {
    for (const id of Object.keys(await new Promise((r) => chrome.notifications.getAll(r)))) await chrome.notifications.clear(id);
  });
  /** What visiting a product page does: the page price goes through the same analysis the card uses. */
  const seePrice = (asin, price) => send({ type: 'PO_ANALYZE_PRODUCT', payload: { asin, price, title: `Item ${asin}` } });
  const resetAlerts = () => opts.evaluate(() => chrome.storage.local.remove('price_alerts'));

  await step('the extension id is stable (manifest key), so the extension keeps its local data across reinstalls', async () => {
    assert.equal(extId, EXPECTED_EXT_ID);
  });

  await step('Settings has an email field, a background-check switch and no account or sign-in', async () => {
    await opts.bringToFront();
    await opts.reload({ waitUntil: 'load' });
    assert.equal(await opts.$('#account-signin'), null);
    assert.doesNotMatch(await opts.$eval('body', (el) => el.textContent), /Google account|Sign in with Google|Firebase/);
    assert.equal(await opts.$eval('#alert-email', (el) => el.value), '');
    assert.equal(await opts.$eval('#alert-background', (el) => el.checked), true);
    assert.match(await opts.$eval('#alerts-title', (el) => el.parentElement.textContent), /saved in this browser/);
  });

  await step('Settings: an invalid email is refused; a valid one is saved on this device', async () => {
    await opts.type('#alert-email', 'not-an-email');
    await opts.click('#save');
    await opts.waitForFunction(() => /does not look right/.test(document.getElementById('banner').textContent), { timeout: 5000 });
    assert.deepEqual(await opts.evaluate(() => chrome.storage.local.get('alert_email')), {});
    await opts.$eval('#alert-email', (el) => { el.value = ''; });
    await opts.type('#alert-email', 'june@example.com');
    await opts.click('#save');
    await opts.waitForFunction(() => /Settings saved/.test(document.getElementById('banner').textContent), { timeout: 5000 });
    assert.equal((await opts.evaluate(() => chrome.storage.local.get('alert_email'))).alert_email, 'june@example.com');
    await opts.screenshot({ path: path.join(shots, '02-options.png'), fullPage: true });
  });

  await step('Settings: "Send a test notification" shows a Chrome notification', async () => {
    await clearNotifications();
    await opts.click('#test-notification');
    await opts.waitForFunction(() => /Test notification sent/.test(document.getElementById('banner').textContent), { timeout: 5000 });
    assert.ok(Object.keys(await notifications()).includes('po-alert-TEST'));
    await clearNotifications();
  });

  await step('card: no alert yet; nothing is stored or requested until the user clicks', async () => {
    await resetAlerts();
    await reloadProduct();
    await waitAlert(page, 'ready');
    const html = await alertText(page);
    assert.match(html, /Tell me when the price is at or below/);
    assert.match(html, /Saved on this device\. Chrome notifies you, with an "Email me this" button for june@example\.com/);
    assert.deepEqual(await stored(), []);
    const suggested = await shadow(page, (root) => root.querySelector('[data-field="alert-target"]').value);
    assert.match(suggested, /^\d+\.\d\d$/);
    assert.ok(Number(suggested) < 174.99);
  });

  await step('card: Set alert saves it locally and shows "Alert on"', async () => {
    const calls = stats.extract;
    await typeTarget(page, '150');
    await clickAlert(page, 'alert-save');
    await waitAlertText(page, /Alert on/);
    assert.match(await alertText(page), /notifying you at or below \$150\.00 · price when set \$174\.99/);
    const alert = await mine();
    assert.equal(alert.targetPrice, 150);
    assert.equal(alert.status, 'active');
    assert.equal(alert.priceAtCreation, 174.99);
    assert.equal(alert.id, `po-${ASIN}`);
    assert.match(alert.title, /\S/);
    assert.equal(stats.extract, calls, 'saving an alert makes no network request');
    await page.screenshot({ path: path.join(shots, '07-price-alert.png'), clip: { x: 0, y: 200, width: 1100, height: 780 } });
  });

  await step('invalid targets are rejected and nothing changes', async () => {
    for (const [value, message] of [['999', /below the current price/], ['abc', /above \$0/], ['', /above \$0/]]) {
      await typeTarget(page, value);
      await clickAlert(page, 'alert-save');
      await waitAlertText(page, message, 10000);
    }
    assert.equal((await mine()).targetPrice, 150);
  });

  await step('changing the target (Enter key too) updates the alert without leaking keys to Amazon', async () => {
    await page.evaluate(() => {
      window.__leakedKeys = 0;
      document.addEventListener('keydown', () => window.__leakedKeys++);
      const input = document.getElementById('price-oracle-host').shadowRoot.querySelector('[data-field="alert-target"]');
      input.focus();
      input.select();
    });
    await page.keyboard.type('145');
    assert.equal(await page.evaluate(() => window.__leakedKeys), 0);
    await page.keyboard.press('Enter');
    await waitAlertText(page, /notifying you at or below \$145\.00/);
    assert.equal((await mine()).targetPrice, 145);
    assert.equal((await stored()).length, 1);
  });

  await step('Turn off pauses, survives a reload, and Turn on re-arms', async () => {
    await clickAlert(page, 'alert-toggle');
    await waitAlertText(page, /Alert paused/);
    assert.equal((await mine()).status, 'paused');
    await reloadProduct();
    await waitAlert(page, 'ready');
    assert.match(await alertText(page), /Alert paused.*would notify you at or below \$145\.00/);
    assert.equal(await shadow(page, (root) => root.querySelector('[data-action="alert-toggle"]').textContent), 'Turn on');
    await seePrice(ASIN, 100);
    assert.equal((await mine()).status, 'paused', 'a paused alert never fires');
    assert.deepEqual(await notifications(), {});
    await clickAlert(page, 'alert-toggle');
    await waitAlertText(page, /Alert on/);
    assert.equal((await mine()).status, 'active');
  });

  await step('price at or below the target fires once: notification, badge, and the open card updates live', async () => {
    await clearNotifications();
    assert.equal(await badge(opts), '');
    await seePrice(ASIN, 146);
    assert.equal((await mine()).status, 'active', 'above the $145 target: nothing happens');
    assert.deepEqual(await notifications(), {});
    await seePrice(ASIN, 144);
    const alert = await mine();
    assert.equal(alert.status, 'triggered');
    assert.equal(alert.triggeredPrice, 144);
    const shown = await notifications();
    assert.deepEqual(Object.keys(shown), [`po-alert-${ASIN}`]);
    await waitBadge(opts, '1');
    assert.match(await opts.evaluate(() => chrome.action.getTitle({})), /1 price alert reached your target/);
    await waitAlertText(page, /Target reached.*the price hit \$144\.00/); // the card on the open tab updated without a reload

    await clearNotifications();
    await seePrice(ASIN, 120);
    assert.deepEqual(await notifications(), {}, 'it does not notify twice');
    assert.equal((await mine()).triggeredPrice, 144);
  });

  await step('a fired alert survives a reload and can be re-armed, which clears the badge', async () => {
    await reloadProduct();
    await waitAlert(page, 'ready');
    assert.match(await alertText(page), /Target reached.*Re-arm to be told again/);
    assert.equal(await shadow(page, (root) => root.querySelector('[data-action="alert-toggle"]').textContent), 'Re-arm');
    await clickAlert(page, 'alert-toggle');
    await waitAlertText(page, /Alert on/);
    assert.equal((await mine()).status, 'active');
    assert.equal((await mine()).triggeredPrice, null);
    await waitBadge(opts, '');
  });

  await step('a notification click opens the product; the email button opens a message to the address in Settings', async () => {
    await seePrice(ASIN, 120);
    await waitBadge(opts, '1');
    const opened = await opts.evaluate(async (asin) => {
      const alerts = await import(chrome.runtime.getURL('src/background/alerts.js'));
      const api = await import(chrome.runtime.getURL('src/background/alerts-api.js'));
      const before = (await chrome.tabs.query({})).length;
      await alerts.handleNotificationClick(`po-alert-${asin}`, 0);
      const tabs = await chrome.tabs.query({ url: `https://www.amazon.com/dp/${asin}*` });
      const { alerts: list, email } = await alerts.getAlertsOverview();
      const link = api.mailtoUrl(email, list[0]);
      return { before, tabs: tabs.length, link };
    }, ASIN);
    assert.ok(opened.tabs >= 2, 'a new tab opened on the product page');
    assert.match(opened.link, /^mailto:june@example\.com\?subject=PriceOracle%3A%20price%20target%20reached&body=/);
    const extra = (await browser.pages()).filter((p) => p.url() === PRODUCT && p !== page);
    for (const p of extra) await p.close();
    await resetAlerts();
    await waitBadge(opts, '');
    await page.bringToFront();
  });

  await step('Remove deletes the alert and the card goes back to "Set alert"', async () => {
    await reloadProduct();
    await waitAlert(page, 'ready');
    await typeTarget(page, '150');
    await clickAlert(page, 'alert-save');
    await waitAlertText(page, /Alert on/);
    await clickAlert(page, 'alert-remove');
    await waitAlertText(page, /Tell me when the price is at or below/);
    assert.deepEqual(await stored(), []);
  });

  await step('two tabs saving the same item at once keep a single alert', async () => {
    const results = await opts.evaluate(() => Promise.all([120, 110].map((price) =>
      chrome.runtime.sendMessage({ type: 'PO_ALERT_CREATE', payload: { asin: 'B0CX23V258', title: 'Headphones', currentPrice: 174.99, targetPrice: price } }))));
    assert.ok(results.every((r) => r.ok), JSON.stringify(results));
    const list = await stored();
    assert.equal(list.length, 1);
    assert.equal(list[0].targetPrice, 110);
    assert.equal(results[0].data.id, results[1].data.id);
  });

  await step('an alert deleted elsewhere: the card refreshes and says why', async () => {
    await reloadProduct();
    await waitAlert(page, 'ready');
    assert.match(await alertText(page), /Alert on/);
    await resetAlerts();
    await waitAlertText(page, /Tell me when the price is at or below/); // live update from storage
    await send({ type: 'PO_ALERT_CREATE', payload: { asin: ASIN, title: 'x', currentPrice: 174.99, targetPrice: 100 } });
    await waitAlertText(page, /Alert on/);
    await resetAlerts();
    await waitAlertText(page, /Tell me when/);
    assert.equal(await shadow(page, (root) => root.querySelector('[data-action="alert-save"]').disabled), false);
  });

  await step('background check: looks up stale alerts, fires when the live price is at the target, never hammers', async () => {
    const OLD = Date.now() - 6 * 3600 * 1000;
    const seedAlert = (asin, extra = {}) => ({ id: `po-${asin}`, asin, title: `Item ${asin}`, targetPrice: 100, status: 'active', priceAtCreation: 130, lastPrice: 130, lastCheckedAt: OLD, createdAt: OLD, ...extra });
    await opts.evaluate((list) => chrome.storage.local.set({ price_alerts: list, context_cache: {} }), [
      seedAlert('B0BGCHECK1'),
      seedAlert('B0BGCHECK2'),
      seedAlert('B0BGCHECK3', { lastCheckedAt: Date.now() - 1000 }),
      seedAlert('B0BGCHECK4', { status: 'paused' })
    ]);
    stats.extractByAsin.B0BGCHECK1 = 95;
    stats.extractByAsin.B0BGCHECK2 = 120;
    stats.extractByAsin.B0BGCHECK3 = 50;
    stats.extractByAsin.B0BGCHECK4 = 50;
    await clearNotifications();
    const before = stats.extract;
    const result = await opts.evaluate(async () => (await import(chrome.runtime.getURL('src/background/alerts.js'))).runBackgroundCheck());
    assert.equal(result.checked, 2);
    assert.equal(stats.extract - before, 2, 'only the two stale active alerts were looked up');
    const list = await stored();
    const by = (asin) => list.find((a) => a.asin === asin);
    assert.equal(by('B0BGCHECK1').status, 'triggered');
    assert.equal(by('B0BGCHECK1').triggeredPrice, 95);
    assert.equal(by('B0BGCHECK2').status, 'active');
    assert.equal(by('B0BGCHECK2').lastPrice, 120);
    assert.ok(by('B0BGCHECK2').lastCheckedAt > OLD);
    assert.equal(by('B0BGCHECK3').lastPrice, 130, 'recently checked: left alone');
    assert.equal(by('B0BGCHECK4').lastPrice, 130, 'paused: left alone');
    assert.deepEqual(Object.keys(await notifications()), ['po-alert-B0BGCHECK1']);
    await waitBadge(opts, '1');

    const again = await opts.evaluate(async () => (await import(chrome.runtime.getURL('src/background/alerts.js'))).runBackgroundCheck());
    assert.equal(again.checked, 0, 'nothing is due right after a check');
    const alarm = await opts.evaluate(() => chrome.alarms.get('po-alert-check'));
    assert.equal(alarm.periodInMinutes, 60);
    await clearNotifications();
  });

  await step('background check can be switched off in Settings', async () => {
    const OLD = Date.now() - 6 * 3600 * 1000;
    await opts.evaluate((t) => chrome.storage.local.set({
      alert_background_checks: false,
      price_alerts: [{ id: 'po-B0BGCHECK9', asin: 'B0BGCHECK9', title: 'x', targetPrice: 10, status: 'active', lastCheckedAt: t, createdAt: t }]
    }), OLD);
    const before = stats.extract;
    const result = await opts.evaluate(async () => (await import(chrome.runtime.getURL('src/background/alerts.js'))).runBackgroundCheck());
    assert.equal(result.checked, 0);
    assert.equal(stats.extract, before);
    await opts.evaluate(() => chrome.storage.local.remove('alert_background_checks'));
    await resetAlerts();
  });

  const seed = (asin, status, extra = {}) => ({
    id: `po-${asin}`, asin, title: `Seeded ${asin}`, targetPrice: 80, status, priceAtCreation: 100, lastPrice: 100, lastCheckedAt: Date.now() - 600000,
    createdAt: Date.now(), triggeredAt: status === 'triggered' ? Date.now() : null, triggeredPrice: status === 'triggered' ? 55 : null, ...extra
  });

  await step('popup lists the alerts (reached first) with Re-arm; the badge counts reached alerts', async () => {
    await opts.evaluate((list) => chrome.storage.local.set({ price_alerts: list }), [
      seed('B0AAAAAAA3', 'paused', { createdAt: 1 }),
      seed('B0AAAAAAA2', 'active', { createdAt: 2 }),
      seed('B0AAAAAAA1', 'triggered', { targetPrice: 55.5, createdAt: 3 })
    ]);
    const pop = await browser.newPage();
    await pop.setViewport({ width: 360, height: 900 });
    await pop.goto(`chrome-extension://${extId}/src/popup/popup.html`);
    await pop.waitForFunction(() => document.querySelectorAll('#alerts-list li').length === 3, { timeout: 10000 });
    const rows = await pop.$$eval('#alerts-list li', (lis) => lis.map((li) => ({
      title: li.querySelector('a').textContent,
      href: li.querySelector('a').getAttribute('href'),
      meta: [...li.querySelector('.alert-meta').children].map((c) => c.textContent).join(' | '),
      rearm: Boolean(li.querySelector('button'))
    })));
    assert.deepEqual(rows.map((r) => r.title), ['Seeded B0AAAAAAA1', 'Seeded B0AAAAAAA2', 'Seeded B0AAAAAAA3']);
    assert.equal(rows[0].meta, 'Target reached | hit $55.00, target $55.50 | Re-arm');
    assert.equal(rows[1].meta, 'Alert on | at or below $80.00');
    assert.equal(rows[2].meta, 'Paused | at or below $80.00');
    assert.deepEqual(rows.map((r) => r.rearm), [true, false, false]);
    assert.equal(rows[0].href, 'https://www.amazon.com/dp/B0AAAAAAA1');
    assert.match(await pop.$eval('#alerts-status', (el) => el.textContent), /1 reached/);
    assert.equal(await pop.$eval('#site-alerts', (a) => a.getAttribute('href')), 'https://xylm-306e6.web.app/alerts/');
    await waitBadge(pop, '1');
    await pop.screenshot({ path: path.join(shots, '08-popup-alerts.png') });

    await pop.click('#alerts-list li button');
    await pop.waitForFunction(() => !document.querySelector('#alerts-list li button'), { timeout: 10000 });
    assert.equal((await stored()).find((a) => a.asin === 'B0AAAAAAA1').status, 'active');
    await waitBadge(pop, '');
    await pop.close();
    await page.bringToFront();
  });

  await step('search results show a bell on products with an alert and nothing on the others', async () => {
    await opts.evaluate((list) => chrome.storage.local.set({ price_alerts: list }), [
      seed('B0SEARCH01', 'active', { targetPrice: 40 }),
      seed('B0SEARCH02', 'paused', { targetPrice: 99 })
    ]);
    const search = await browser.newPage();
    await search.setViewport({ width: 1280, height: 1000 });
    await search.goto(SEARCH, { waitUntil: 'load' });
    await search.waitForFunction(
      () => [...document.querySelectorAll('[data-price-oracle-chip]')].filter((h) => h.shadowRoot.querySelector('.pc-chip.BUY_NOW, .pc-chip.WAIT, .pc-chip.FAIR_PRICE')).length === 3 &&
        document.querySelectorAll('[data-price-oracle-chip]')[0].shadowRoot.querySelector('.pc-bell'),
      { timeout: 20000 }
    );
    const bells = await search.evaluate(() => [...document.querySelectorAll('[data-price-oracle-chip]')].map((h) => h.shadowRoot.querySelector('.pc-bell')?.textContent.trim() || null));
    assert.deepEqual(bells, ['Alert $40.00', 'Alert paused', null]);
    await search.evaluate(() => document.querySelectorAll('[data-price-oracle-chip]')[0].shadowRoot.querySelector('.pc-chip').click());
    await search.waitForFunction(() => /Price alert on: you will be notified at or below \$40\.00/.test(document.querySelectorAll('[data-price-oracle-chip]')[0].shadowRoot.textContent), { timeout: 5000 });
    await search.screenshot({ path: path.join(shots, '09-search-alert-bell.png'), clip: { x: 0, y: 0, width: 1100, height: 520 } });
    assert.equal((await stored()).find((a) => a.asin === 'B0SEARCH01').status, 'active', 'seeing $49.99 does not fire a $40 alert');
    await search.close();
    await page.bringToFront();
  });

  await step('a search result price at or below the target fires the alert too', async () => {
    await opts.evaluate((list) => chrome.storage.local.set({ price_alerts: list }), [seed('B0SEARCH02', 'active', { targetPrice: 150 })]);
    await clearNotifications();
    const search = await browser.newPage();
    await search.setViewport({ width: 1280, height: 1000 });
    await search.goto(SEARCH, { waitUntil: 'load' });
    await waitBadge(opts, '1');
    assert.equal((await stored())[0].status, 'triggered');
    assert.equal((await stored())[0].triggeredPrice, 149.99);
    assert.deepEqual(Object.keys(await notifications()), ['po-alert-B0SEARCH02']);
    await search.close();
    await clearNotifications();
    await resetAlerts();
    await page.bringToFront();
  });

  // ---- The PriceOracle website's alerts page ---------------------------------------------------------
  const siteCards = (pg) => pg.$$eval('#price-oracle-extension-alerts [data-po-alert]', (els) => els.map((el) => ({
    asin: el.getAttribute('data-po-alert'),
    text: el.textContent.replace(/\s+/g, ' ').trim(),
    status: el.querySelector('[data-po-status]').getAttribute('data-po-status'),
    after: Boolean(document.querySelector('#site-list').compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
  })));
  const waitSiteCards = (pg, n) =>
    pg.waitForFunction((count) => document.querySelectorAll('#price-oracle-extension-alerts [data-po-alert]').length === count, { timeout: 10000 }, n);
  const siteOwn = (pg) => pg.$$eval('[data-site-alert]', (els) => els.map((el) => el.getAttribute('data-site-alert')));

  await step('website /alerts/: the extension alerts appear after the alerts already there', async () => {
    await opts.evaluate((list) => chrome.storage.local.set({ price_alerts: list }), [
      seed('B0AAAAAAA2', 'active', { createdAt: 2, title: 'Echo Dot (5th Gen)' }),
      seed('B0AAAAAAA1', 'triggered', { createdAt: 3, targetPrice: 55.5, triggeredPrice: 54.25, title: '<img src=x onerror="window.__xss=1"> Fire Stick' })
    ]);
    const site = await browser.newPage();
    await site.setViewport({ width: 1100, height: 900 });
    await site.goto(`${SITE}/alerts/`, { waitUntil: 'load' });
    await waitSiteCards(site, 2);
    assert.deepEqual(await siteOwn(site), ['demo-2', 'demo-1'], "the site's own alerts are untouched");
    const cards = await siteCards(site);
    assert.deepEqual(cards.map((c) => c.asin), ['B0AAAAAAA1', 'B0AAAAAAA2']);
    assert.ok(cards.every((c) => c.after), 'extension alerts come after the existing list');
    assert.match(cards[0].text, /target reached.*Set in extension.*Fire Stick.*Target: \$55\.50.*Reached at: \$54\.25.*Notify: Chrome and june@example\.com.*Re-arm/i);
    assert.match(cards[1].text, /active.*Echo Dot \(5th Gen\).*Initial: \$100\.00.*Target: \$80\.00.*Last seen: \$100\.00 \(10 min ago\).*Pause/i);
    assert.match(await site.$eval('#price-oracle-extension-alerts', (el) => el.firstElementChild.textContent), /Set in your PriceOracle extension \(2\)/);
    assert.equal(await site.evaluate(() => window.__xss), undefined, 'titles are text, never markup');
    assert.match(cards[0].text, /<img src=x/);
    assert.equal(await site.$eval('#price-oracle-extension-alerts [data-po-alert] a', (a) => a.getAttribute('href')), 'https://www.amazon.com/dp/B0AAAAAAA1');
    await site.screenshot({ path: path.join(shots, '10-website-alerts.png') });
    await site.close();
  });

  await step('website /alerts/: pause, change target, re-arm and delete write to the extension, not the site', async () => {
    const site = await browser.newPage();
    await site.goto(`${SITE}/alerts/`, { waitUntil: 'load' });
    await waitSiteCards(site, 2);
    const act = (asin, action) => site.$eval(`[data-po-alert="${asin}"] [data-po-action="${action}"]`, (b) => b.click());
    const status = async (asin) => (await stored()).find((a) => a.asin === asin);

    await act('B0AAAAAAA2', 'toggle');
    await site.waitForFunction(() => document.querySelector('[data-po-alert="B0AAAAAAA2"] [data-po-status]').getAttribute('data-po-status') === 'paused', { timeout: 5000 });
    assert.equal((await status('B0AAAAAAA2')).status, 'paused');
    await act('B0AAAAAAA2', 'toggle');
    await site.waitForFunction(() => document.querySelector('[data-po-alert="B0AAAAAAA2"] [data-po-status]').getAttribute('data-po-status') === 'active', { timeout: 5000 });

    await act('B0AAAAAAA2', 'edit');
    await site.waitForSelector('[data-po-field="target"]');
    await site.$eval('[data-po-field="target"]', (el) => { el.value = ''; });
    await site.type('[data-po-field="target"]', '0');
    await site.click('[data-po-action="save"]');
    await site.waitForFunction(() => /above \$0/.test(document.querySelector('#price-oracle-extension-alerts [role="alert"]')?.textContent || ''), { timeout: 5000 });
    await site.$eval('[data-po-field="target"]', (el) => { el.value = ''; });
    await site.type('[data-po-field="target"]', '72.5');
    await site.click('[data-po-action="save"]');
    await site.waitForFunction(() => /Target: \$72\.50/.test(document.querySelector('[data-po-alert="B0AAAAAAA2"]')?.textContent || ''), { timeout: 5000 });
    assert.equal((await status('B0AAAAAAA2')).targetPrice, 72.5);

    await act('B0AAAAAAA1', 'toggle');
    await site.waitForFunction(() => document.querySelector('[data-po-alert="B0AAAAAAA1"] [data-po-status]').getAttribute('data-po-status') === 'active', { timeout: 5000 });
    assert.equal((await status('B0AAAAAAA1')).triggeredPrice, null);
    await waitBadge(opts, '');

    await act('B0AAAAAAA1', 'delete');
    await waitSiteCards(site, 1);
    assert.equal((await stored()).length, 1);
    assert.deepEqual(await siteOwn(site), ['demo-2', 'demo-1']);

    await site.$eval('[data-site-delete="demo-1"]', (b) => b.click()); // the site's own delete still works and keeps ours
    await site.waitForFunction(() => document.querySelectorAll('[data-site-alert]').length === 1, { timeout: 5000 });
    await waitSiteCards(site, 1);
    assert.deepEqual(await siteOwn(site), ['demo-2']);
    await site.close();
  });

  await step('website: alerts set in the extension appear live, in a client-side route change, and vanish with the last alert', async () => {
    await resetAlerts();
    const site = await browser.newPage();
    await site.goto(`${SITE}/`, { waitUntil: 'load' });
    assert.equal(await site.$('#price-oracle-extension-alerts'), null, 'not shown outside /alerts');
    await send({ type: 'PO_ALERT_CREATE', payload: { asin: ASIN, title: 'Live headphones', currentPrice: 174.99, targetPrice: 120 } });
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await site.$('#price-oracle-extension-alerts'), null);
    await site.click('#nav-alerts'); // single-page navigation: the page is not reloaded
    await waitSiteCards(site, 1);
    assert.match((await siteCards(site))[0].text, /Live headphones/);

    await send({ type: 'PO_ALERT_CREATE', payload: { asin: 'B0LIVEADD1', title: 'Added later', currentPrice: 50, targetPrice: 30 } });
    await waitSiteCards(site, 2);

    await site.click('#nav-home');
    await site.waitForFunction(() => !document.getElementById('price-oracle-extension-alerts'), { timeout: 5000 });
    await site.click('#nav-alerts');
    await waitSiteCards(site, 2);

    await send({ type: 'PO_ALERT_REMOVE', payload: { alertId: 'po-B0LIVEADD1' } });
    await send({ type: 'PO_ALERT_REMOVE', payload: { alertId: `po-${ASIN}` } });
    await site.waitForFunction(() => !document.getElementById('price-oracle-extension-alerts'), { timeout: 5000 });
    assert.deepEqual(await siteOwn(site), ['demo-2', 'demo-1']);
    await site.close();
  });

  await step('the website is never called, and nothing about Google or Firebase remains', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    assert.ok(!manifest.host_permissions.some((h) => /xylm|googleapis|google\.com/.test(h)));
    assert.ok(!manifest.permissions.includes('identity'));
    const files = manifest.content_scripts.flatMap((c) => c.js).map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
    assert.doesNotMatch(files, /fetch\(|XMLHttpRequest|sendBeacon/);
    const worker = fs.readFileSync(path.join(root, 'src/background/alerts.js'), 'utf8') + fs.readFileSync(path.join(root, 'src/background/alerts-api.js'), 'utf8');
    assert.doesNotMatch(worker, /fetch\(|xylm|firebase|identitytoolkit/i);
  });

  const popup = await browser.newPage();
  await popup.setViewport({ width: 360, height: 640 });
  await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`);

  await step('popup shows last analysis, stats and connections; no Gemini key controls', async () => {
    await popup.waitForFunction(() => !document.getElementById('last-body').hidden, { timeout: 10000 });
    assert.ok(Number(await popup.$eval('#stat-count', (el) => el.textContent)) >= 3);
    assert.match(await popup.$eval('#ctx-status', (el) => el.textContent), /Default key active/);
    assert.match(await popup.$eval('#gem-status', (el) => el.textContent), /Live/);
    assert.equal(await popup.$eval('#recent-card', (el) => el.hidden), false);
    const links = await popup.$$eval('#recent-list a', (as) => as.map((a) => a.getAttribute('href')));
    assert.ok(links.length >= 1 && links.every((h) => /^https:\/\/www\.amazon\.com\/dp\/[A-Z0-9]{10}$/.test(h)), JSON.stringify(links));
    assert.equal(await popup.$('#add-gemini'), null);
    assert.equal(await popup.$('#modal'), null);
    await popup.screenshot({ path: path.join(shots, '05-popup.png') });
  });
} finally {
  await browser.close();
  server.close();
}

console.log(failures ? `\n${failures} e2e check(s) failed` : '\nall e2e checks passed');
process.exit(failures ? 1 : 0);
