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
    `--host-resolver-rules=MAP www.amazon.com 127.0.0.1:${PORT}, MAP api.context.dev 127.0.0.1:${PORT}, MAP api.gemini.com 127.0.0.1:${PORT}, MAP baba.test 127.0.0.1:${PORT}`,
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

/** Flip a switch on the mock website, e.g. `tokenValid=0`. */
const fetchControl = (query) => {
  const [key, value] = query.split('=');
  stats.site[key] = value === '1';
};

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
    await opts.click('#test');
    await opts.waitForFunction(() => /Connected/.test(document.getElementById('res-context').textContent), { timeout: 20000 });
    assert.deepEqual(await opts.evaluate(() => chrome.storage.local.get('context_pause')), {});
    await page.bringToFront();
    await page.click('button[data-asin="B0CX23V260"]');
    await waitPin('Current: $129.50');
    assert.match(await shadow(page, (root) => root.querySelector('.po-chip')?.textContent.trim()), /context\.dev: Connected/);
    assert.equal(stats.extract, before + 2);
  });

  // ---- Website integration: Google sign-in via the website + price alerts --------------------------------
  const waitAlert = (pg, phase) =>
    pg.waitForFunction(
      (ph) => document.getElementById('price-oracle-host')?.shadowRoot?.querySelector(`.po-alert[data-phase="${ph}"]`),
      { timeout: 15000 },
      phase
    );
  const alertText = (pg) => shadow(pg, (root) => root.querySelector('.po-alert')?.textContent.replace(/\s+/g, ' ').trim());
  const clickAlert = (pg, action) => shadow(pg, (root, a) => root.querySelector(`[data-action="${a}"]`).click(), action);
  const typeTarget = (pg, value) => shadow(pg, (root, v) => { root.querySelector('[data-field="alert-target"]').value = v; }, value);
  const reloadProduct = async () => {
    await page.bringToFront();
    await page.goto(PRODUCT, { waitUntil: 'load' });
    await waitReady(page);
  };
  const siteStats = () => stats.site;

  await step('without a connected website the card offers to set up alerts (no request is made)', async () => {
    await reloadProduct();
    await waitAlert(page, 'not_configured');
    assert.match(await alertText(page), /Connect your PriceOracle website/);
    assert.equal(siteStats().connects, 0);
  });

  await step('Settings: Sign in with Google opens the website bridge and stores a session', async () => {
    await opts.bringToFront();
    await opts.click('#site-url', { clickCount: 3 });
    await opts.type('#site-url', 'baba.test');
    await opts.click('#site-connect');
    await opts.waitForFunction(() => /Signed in as june@example\.com/.test(document.getElementById('site-state').textContent), { timeout: 20000 });
    assert.equal(siteStats().connects, 1);
    assert.match(siteStats().lastRedirectUri, /^https:\/\/[a-p]{32}\.chromiumapp\.org\/site$/);
    assert.equal(await opts.$eval('#site-url', (el) => el.value), 'https://baba.test');
    assert.equal(await opts.$eval('#site-disconnect', (el) => el.hidden), false);
    const stored = await opts.evaluate(() => chrome.storage.local.get(['site_url', 'site_session']));
    assert.equal(stored.site_url, 'https://baba.test');
    assert.equal(stored.site_session.token, 'po_site_token_123');
  });

  await step('a refused website sign-in shows an error and keeps the previous session', async () => {
    await fetchControl('refuseLogin=1');
    await opts.click('#site-connect');
    await opts.waitForFunction(() => /Sign-in failed: The website refused sign-in/.test(document.getElementById('banner').textContent), { timeout: 20000 });
    await fetchControl('refuseLogin=0');
    assert.equal((await opts.evaluate(() => chrome.storage.local.get('site_session'))).site_session.token, 'po_site_token_123');
  });

  await step('product card: set a price alert; the website receives asin, title, target and price', async () => {
    await reloadProduct();
    await waitAlert(page, 'ready');
    const suggested = await shadow(page, (root) => root.querySelector('[data-field="alert-target"]').value);
    assert.match(suggested, /^\d+\.\d\d$/);
    assert.ok(Number(suggested) < 174.99);
    await typeTarget(page, '150');
    await clickAlert(page, 'alert-save');
    await page.waitForFunction(() => /Alert on/.test(document.getElementById('price-oracle-host').shadowRoot.querySelector('.po-alert').textContent), { timeout: 10000 });
    const put = siteStats().lastPut;
    assert.equal(put.asin, 'B0CX23V258');
    assert.equal(put.targetPrice, 150);
    assert.equal(put.currentPrice, 174.99);
    assert.equal(put.enabled, true);
    assert.equal(put.url, 'https://www.amazon.com/dp/B0CX23V258');
    assert.ok(put.title.length > 3);
    assert.match(await alertText(page), /notifying at or below \$150\.00/);
    await page.screenshot({ path: path.join(shots, '07-price-alert.png'), clip: { x: 0, y: 200, width: 1100, height: 780 } });
  });

  await step('a target at or above the current price is rejected without calling the website', async () => {
    const puts = siteStats().puts;
    await typeTarget(page, '999');
    await clickAlert(page, 'alert-save');
    await page.waitForFunction(() => /below the current price/.test(document.getElementById('price-oracle-host').shadowRoot.querySelector('.po-alert').textContent), { timeout: 10000 });
    assert.equal(siteStats().puts, puts);
    assert.equal(await shadow(page, (root) => root.querySelector('[data-field="alert-target"]').value), '999');
    await typeTarget(page, 'abc');
    await clickAlert(page, 'alert-save');
    await page.waitForFunction(() => /above \$0/.test(document.getElementById('price-oracle-host').shadowRoot.querySelector('.po-alert').textContent), { timeout: 10000 });
    assert.equal(siteStats().puts, puts);
  });

  await step('the alert can be turned off and on again, and is remembered across reloads', async () => {
    await typeTarget(page, '150.00');
    await clickAlert(page, 'alert-toggle');
    await page.waitForFunction(() => /Alert paused/.test(document.getElementById('price-oracle-host').shadowRoot.querySelector('.po-alert').textContent), { timeout: 10000 });
    assert.equal(siteStats().lastPut.enabled, false);
    assert.equal(siteStats().alerts.B0CX23V258.enabled, false);
    await reloadProduct();
    await waitAlert(page, 'ready');
    assert.match(await alertText(page), /Alert paused.*would notify at or below \$150\.00/);
    assert.equal(await shadow(page, (root) => root.querySelector('[data-action="alert-toggle"]').textContent), 'Turn on');
    await clickAlert(page, 'alert-toggle');
    await page.waitForFunction(() => /Alert on/.test(document.getElementById('price-oracle-host').shadowRoot.querySelector('.po-alert').textContent), { timeout: 10000 });
    assert.equal(siteStats().alerts.B0CX23V258.enabled, true);
  });

  await step('updating the target and removing the alert are sent to the website', async () => {
    await typeTarget(page, '140');
    await clickAlert(page, 'alert-save');
    await page.waitForFunction(() => /\$140\.00/.test(document.getElementById('price-oracle-host').shadowRoot.querySelector('.po-alert').textContent), { timeout: 10000 });
    assert.equal(siteStats().alerts.B0CX23V258.targetPrice, 140);
    await clickAlert(page, 'alert-remove');
    await page.waitForFunction(() => /Alert me when the price is at or below/.test(document.getElementById('price-oracle-host').shadowRoot.querySelector('.po-alert').textContent), { timeout: 10000 });
    assert.equal(siteStats().deletes, 1);
    assert.deepEqual(Object.keys(siteStats().alerts), []);
  });

  await step('typing a price in the alert field does not trigger Amazon keyboard shortcuts and Enter saves', async () => {
    await page.evaluate(() => {
      window.__leakedKeys = 0;
      document.addEventListener('keydown', () => window.__leakedKeys++);
    });
    await page.evaluate(() => {
      const input = document.getElementById('price-oracle-host').shadowRoot.querySelector('[data-field="alert-target"]');
      input.focus();
      input.select();
    });
    await page.keyboard.type('145');
    assert.equal(await page.evaluate(() => window.__leakedKeys), 0); // nothing typed in the field reaches Amazon's page
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /Alert on/.test(document.getElementById('price-oracle-host').shadowRoot.querySelector('.po-alert').textContent), { timeout: 10000 });
    assert.equal(siteStats().alerts.B0CX23V258.targetPrice, 145);
  });

  await step('popup shows the signed-in website account and active alert count', async () => {
    const pop = await browser.newPage();
    await pop.setViewport({ width: 360, height: 760 });
    await pop.goto(`chrome-extension://${extId}/src/popup/popup.html`);
    await pop.waitForFunction(() => /Signed in/.test(document.getElementById('site-status').textContent), { timeout: 10000 });
    assert.match(await pop.$eval('#site-hint', (el) => el.textContent), /june@example\.com · 1 active alert$/);
    await pop.close();
    await page.bringToFront();
  });

  await step('an expired website token sends the card back to "Sign in with Google"', async () => {
    await fetchControl('tokenValid=0');
    await reloadProduct();
    await waitAlert(page, 'signed_out');
    assert.match(await alertText(page), /sign-in expired.*Sign in with Google/);
    assert.equal((await opts.evaluate(() => chrome.storage.local.get('site_session'))).site_session.token, undefined);
    await fetchControl('tokenValid=1');
  });

  await step('signing in from Settings updates an open product page without a reload', async () => {
    await opts.bringToFront();
    await opts.click('#site-connect');
    await opts.waitForFunction(() => /Signed in as/.test(document.getElementById('site-state').textContent), { timeout: 20000 });
    await page.bringToFront();
    await waitAlert(page, 'ready');
    assert.equal(await shadow(page, (root) => root.querySelector('[data-field="alert-target"]').value), '145.00');
  });

  await step('a website without CORS headers is reported with a clear message', async () => {
    await fetchControl('corsBroken=1');
    await reloadProduct();
    await waitAlert(page, 'error');
    assert.match(await alertText(page), /allow cross-origin requests/);
    await fetchControl('corsBroken=0');
  });

  await step('Sign out in Settings removes the token and hides alert controls', async () => {
    await opts.bringToFront();
    await opts.click('#site-disconnect');
    await opts.waitForFunction(() => /Not connected|Signed out/.test(document.getElementById('banner').textContent + document.getElementById('site-state').textContent), { timeout: 10000 });
    assert.deepEqual(await opts.evaluate(() => chrome.storage.local.get('site_session')), {});
    assert.equal(await opts.$eval('#site-disconnect', (el) => el.hidden), true);
    await reloadProduct();
    await waitAlert(page, 'signed_out');
    await opts.bringToFront();
    await opts.click('#site-connect'); // leave the account connected for the popup check below
    await opts.waitForFunction(() => /Signed in as/.test(document.getElementById('site-state').textContent), { timeout: 20000 });
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
