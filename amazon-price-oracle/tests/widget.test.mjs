import test from 'node:test';
import assert from 'node:assert/strict';
import { computeProjection } from '../src/background/projection-engine.js';

await import('../src/content/widget-template.js');
const { Widget } = globalThis.PriceOracle;

function sample(overrides = {}) {
  const projection = computeProjection({ currentPrice: 100, volatility: 0.1, discountProbability: 0.4, sentimentMultiplier: 0.9, priceDrift: -0.06 });
  return {
    asin: 'B0TEST0001',
    title: 'Thing',
    light: false,
    projection,
    meta: {
      context: { status: 'connected', fromCache: false, fetchedAt: Date.now(), signalCount: 3 },
      gemini: { status: 'live', isSimulated: false, rationale: 'because', summary: 'Fed hike odds 10%', stale: false },
      ...overrides
    }
  };
}

test('pinPosition is monotonic and clamped to the bar', () => {
  const tiers = [78, 89, 99, 110, 121];
  const positions = [60, 78, 85, 89, 99, 105, 121, 150].map((p) => Widget.pinPosition(p, tiers));
  for (let i = 1; i < positions.length; i++) assert.ok(positions[i] >= positions[i - 1]);
  assert.ok(positions[0] >= 3 && positions.at(-1) <= 97);
  assert.equal(Widget.pinPosition(99, tiers), 50);
});

test('card renders five tiers and the recommendation', () => {
  const html = Widget.render({ status: 'ready', data: sample() });
  assert.equal((html.match(/class="po-tier /g) || []).length, 5);
  assert.match(html, /po-pill (WAIT|BUY_NOW|FAIR_PRICE)/);
  assert.match(html, /Current: \$100\.00/);
  assert.match(html, /Gemini Markets: Live/);
});

test('dynamic strings are HTML-escaped in the card and the chip', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const data = sample({ gemini: { status: 'live', isSimulated: false, rationale: evil, summary: evil, stale: false } });
  data.projection.recommendation.message = evil;
  for (const html of [Widget.render({ status: 'ready', data }), Widget.renderChip({ status: 'ready', data, expanded: true })]) {
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img src=x/);
  }
  assert.doesNotMatch(Widget.render({ status: 'error', error: evil }), /<img src=x/);
});

test('context chip variants: connected, cached, skipped, error', () => {
  const chip = (context) => Widget.render({ status: 'ready', data: sample({ context, gemini: { status: 'offline', isSimulated: true, rationale: '' } }) });
  assert.match(chip({ status: 'connected', signalCount: 2 }), /context\.dev: Connected</);
  assert.match(chip({ status: 'cached', fromCache: true, signalCount: 2 }), /Connected \(cached\)/);
  assert.match(chip({ status: 'skipped', signalCount: 0 }), /Not used \(quick estimate\)/);
  assert.match(chip({ status: 'error', error: 'boom', signalCount: 0 }), /Offline — using page data/);
  assert.match(chip({ status: 'error', error: 'boom', signalCount: 0 }), /Gemini Markets: Offline/);
});

test('search chip: loading, error, collapsed and expanded states', () => {
  const data = sample();
  assert.match(Widget.renderChip({ status: 'loading' }), /pc-chip pending/);
  assert.match(Widget.renderChip({ status: 'error', error: 'x' }), /data-action="retry"/);
  const collapsed = Widget.renderChip({ status: 'ready', data, expanded: false });
  assert.match(collapsed, /aria-expanded="false"/);
  assert.doesNotMatch(collapsed, /class="pc-panel"/);
  const expanded = Widget.renderChip({ status: 'ready', data, expanded: true });
  assert.match(expanded, /aria-expanded="true"/);
  assert.equal((expanded.match(/class="pc-tier /g) || []).length, 5);
});

test('deep-analysis button only appears for quick (skipped) estimates', () => {
  const quick = sample({ context: { status: 'skipped', signalCount: 0 }, gemini: { status: 'live', summary: '', rationale: '' } });
  quick.light = true;
  assert.match(Widget.renderChip({ status: 'ready', data: quick, expanded: true }), /data-action="deep"/);
  assert.match(Widget.renderChip({ status: 'ready', data: quick, expanded: true, deepLoading: true }), /disabled/);
  assert.doesNotMatch(Widget.renderChip({ status: 'ready', data: sample(), expanded: true }), /data-action="deep"/);
});

test('price history row appears only when history exists, in card and chip', () => {
  const none = sample();
  assert.doesNotMatch(Widget.render({ status: 'ready', data: none }), /Your price history/);
  const withHistory = sample({ history: { count: 4, low: 90, high: 120, avg: 100, spanDays: 10 } });
  assert.match(Widget.render({ status: 'ready', data: withHistory }), /Seen 4 times over 10 days · low \$90\.00 · high \$120\.00/);
  assert.match(Widget.renderChip({ status: 'ready', data: withHistory, expanded: true }), /Seen 4 times over 10 days/);
  withHistory.meta.history.spanDays = 0.2;
  assert.match(Widget.render({ status: 'ready', data: withHistory }), /Seen 4 times · low/);
});

test('the card is a labelled region and exposes its busy state', () => {
  assert.match(Widget.render({ status: 'loading' }), /role="region"[^>]*aria-busy="true"/);
  assert.match(Widget.render({ status: 'ready', data: sample() }), /aria-busy="false"/);
});

const alertHtml = (alert) => Widget.render({ status: 'ready', data: sample(), alert });
const alertDoc = (over = {}) => ({ id: 'al_1', targetPrice: 90, status: 'active', priceAtCreation: 101.5, ...over });

test('no alert section unless the content script supplies an alert view', () => {
  assert.doesNotMatch(Widget.render({ status: 'ready', data: sample() }), /class="po-section po-alert"/);
});

test('alert section: loading, signed out (with expired wording), error', () => {
  assert.match(alertHtml({ phase: 'loading' }), /Checking your alerts/);
  const out = alertHtml({ phase: 'signed_out' });
  assert.match(out, /data-action="alert-signin"[^>]*>Sign in with Google</);
  assert.match(out, /emailed to your Google account address/);
  assert.doesNotMatch(out, /sign-in expired/i);
  assert.match(alertHtml({ phase: 'signed_out', expired: true }), /Your sign-in expired\./);
  assert.match(alertHtml({ phase: 'signed_out', busy: true }), /Waiting for Google/);
  const err = alertHtml({ phase: 'error', error: '<b>boom</b>' });
  assert.match(err, /data-action="alert-retry"/);
  assert.doesNotMatch(err, /<b>boom/);
});

test('alert section: no alert yet shows the suggested target and a Set alert button', () => {
  const html = alertHtml({ phase: 'ready', suggested: 94.5, email: 'a@b.co' });
  assert.match(html, /data-field="alert-target"[^>]*value="94\.50"/);
  assert.match(html, /data-action="alert-save"[^>]*>Set alert</);
  assert.doesNotMatch(html, /alert-toggle|alert-remove/);
  assert.match(html, /Alerts go to a@b\.co/);
  assert.match(html, /data-action="alert-account"/);
});

test('alert section: creating shows the slow-lookup notice and disables the form', () => {
  const html = alertHtml({ phase: 'ready', suggested: 94.5, busy: true, creating: true });
  assert.match(html, /Looking up a product for the first time can take up to a minute/);
  assert.match(html, /Saving…/);
  assert.match(html, /data-action="alert-save"[^>]* disabled/);
});

test('alert section: active alert offers update, Turn off (to paused) and remove', () => {
  const html = alertHtml({ phase: 'ready', suggested: 94.5, alert: alertDoc() });
  assert.match(html, /Alert on/);
  assert.match(html, /value="90\.00"/);
  assert.match(html, /emailing at or below <strong>\$90\.00<\/strong> · price when set \$101\.50/);
  assert.match(html, /data-action="alert-toggle" data-next-status="paused"[^>]*>Turn off</);
  assert.match(html, /alert-remove/);
});

test('alert section: paused can be turned on; triggered can be re-armed; both set status active', () => {
  const paused = alertHtml({ phase: 'ready', alert: alertDoc({ status: 'paused' }) });
  assert.match(paused, /Alert paused/);
  assert.match(paused, /would email at or below <strong>\$90\.00/);
  assert.match(paused, /data-next-status="active"[^>]*>Turn on</);
  const sent = alertHtml({ phase: 'ready', alert: alertDoc({ status: 'triggered' }) });
  assert.match(sent, /Alert sent/);
  assert.match(sent, /Re-arm to be told again/);
  assert.match(sent, /data-next-status="active"[^>]*>Re-arm</);
});

test('alert section: an alert without a price target (set on the website) still renders', () => {
  const html = alertHtml({ phase: 'ready', suggested: 94.5, alert: alertDoc({ targetPrice: null, priceAtCreation: null }) });
  assert.match(html, /emailing at or below a price drop/);
  assert.match(html, /value="94\.50"/);
});

test('alert section: shows "Target reached" only for an active alert whose target is at or above the price', () => {
  assert.match(alertHtml({ phase: 'ready', alert: alertDoc({ targetPrice: 120 }) }), /Target reached/);
  assert.doesNotMatch(alertHtml({ phase: 'ready', alert: alertDoc({ targetPrice: 120, status: 'paused' }) }), /Target reached/);
  assert.doesNotMatch(alertHtml({ phase: 'ready', alert: alertDoc({ targetPrice: 80 }) }), /Target reached/);
});

test('alert section: busy disables controls and a draft value and error are kept', () => {
  const html = alertHtml({ phase: 'ready', alert: alertDoc({ targetPrice: 80 }), busy: true, draft: '999', error: 'Pick a target below the current price.' });
  assert.equal((html.match(/ disabled/g) || []).length, 4);
  assert.match(html, /value="999"/);
  assert.match(html, /role="alert">Pick a target below/);
});

test('alert section escapes the account email', () => {
  assert.doesNotMatch(alertHtml({ phase: 'ready', suggested: 9, email: '<i>x</i>@b.co' }), /<i>x<\/i>/);
});

test('suggestTarget stays below the current price and above zero', () => {
  assert.equal(Widget.suggestTarget(100, 80), 80);
  assert.equal(Widget.suggestTarget(100, 99), 95);
  assert.equal(Widget.suggestTarget(100, NaN), 95);
  assert.equal(Widget.suggestTarget(0.01, 0.001), 0.01);
  assert.equal(Widget.suggestTarget(174.99, 136.49), 136.49);
});
