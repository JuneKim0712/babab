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
