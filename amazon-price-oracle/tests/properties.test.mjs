/**
 * Property-style tests: thousands of seeded pseudo-random inputs checked against
 * invariants the UI relies on. Deterministic (fixed seed), so failures reproduce.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecommendation, computeConfidence, computeProjection, estimateVolatility } from '../src/background/projection-engine.js';
import { findSeasonalEvent, simulatePrediction } from '../src/background/gemini-prediction.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CATEGORIES = ['', 'Electronics > Headphones', 'Grocery & Gourmet Food', 'Toys & Games', 'Books', 'Home & Kitchen', 'Clothing', 'amazon devices', 'Video Games'];
const pick = (r, list) => list[Math.floor(r() * list.length)];
/** Log-uniform price between 1 cent and 1,000,000 dollars. */
const price = (r) => Math.round(10 ** (r() * 8 - 2) * 100) / 100 || 0.01;

test('tiers always ascend, are finite and positive, whatever the inputs', () => {
  const r = rng(1);
  for (let i = 0; i < 5000; i++) {
    const p = computeProjection({
      currentPrice: price(r),
      volatility: r() * 0.6 - 0.1,
      discountProbability: r() * 1.4 - 0.2,
      sentimentMultiplier: 0.7 + r() * 0.6,
      priceDrift: r() * 0.6 - 0.3
    });
    const t = p.tiers;
    const seq = [t.lowest, t.low, t.mid, t.high, t.highest];
    assert.ok(seq.every((n) => Number.isFinite(n) && n > 0), JSON.stringify(p));
    for (let k = 1; k < seq.length; k++) assert.ok(seq[k] >= seq[k - 1], `not ascending: ${JSON.stringify(p)}`);
    assert.ok(p.volatility >= 0.04 && p.volatility <= 0.35);
    assert.equal(JSON.parse(JSON.stringify(p)).tiers.mid, t.mid);
  }
});

test('with zero drift the spec formulas hold to the cent', () => {
  const r = rng(2);
  for (let i = 0; i < 3000; i++) {
    const P = Math.round((5 + r() * 995) * 100) / 100;
    const v = 0.04 + r() * 0.31;
    const dp = r();
    const s = 0.85 + r() * 0.3;
    const p = computeProjection({ currentPrice: P, volatility: v, discountProbability: dp, sentimentMultiplier: s });
    const cents = (n) => Math.round(n * 100) / 100;
    assert.equal(p.tiers.mid, cents(P * (1 + (s - 1) * v * (1 - dp))));
    assert.equal(p.tiers.highest, cents(P * (1 + 2.1 * v)));
    assert.equal(p.tiers.lowest, cents(P * (1 - 2.2 * v)));
  }
});

test('the recommendation follows the -4% / +4% thresholds on the unrounded change', () => {
  const r = rng(3);
  for (let i = 0; i < 5000; i++) {
    const delta = (r() - 0.5) * 40;
    const { action } = buildRecommendation(delta, delta);
    assert.equal(action, delta <= -4 ? 'WAIT' : delta >= 4 ? 'BUY_NOW' : 'FAIR_PRICE', String(delta));
  }
  assert.equal(buildRecommendation(-4, -4).action, 'WAIT');
  assert.equal(buildRecommendation(4, 4).action, 'BUY_NOW');
  assert.equal(buildRecommendation(-3.999, -4).action, 'FAIR_PRICE');
  assert.equal(buildRecommendation(3.999, 4).action, 'FAIR_PRICE');
});

test('confidence is an integer in range: at most 82 when simulated, 88 with live markets', () => {
  const r = rng(4);
  for (let i = 0; i < 3000; i++) {
    const simulated = r() < 0.5;
    const c = computeConfidence((r() - 0.5) * 60, { hasContext: r() < 0.5, signalCount: Math.floor(r() * 12), isSimulated: simulated });
    assert.ok(Number.isInteger(c) && c >= 40 && c <= (simulated ? 82 : 88), String(c));
  }
});

test('volatility estimate is bounded for any category, price and signals', () => {
  const r = rng(5);
  for (let i = 0; i < 3000; i++) {
    const p = price(r);
    const v = estimateVolatility({
      category: pick(r, CATEGORIES),
      title: 'Some product',
      price: p,
      listPrice: r() < 0.5 ? p * (0.5 + r() * 3) : undefined,
      signals: r() < 0.5 ? { lowPrice: p * r(), highPrice: p * (1 + r() * 3), listPrice: p * (0.5 + r() * 3) } : {}
    });
    assert.ok(v >= 0.04 && v <= 0.35, String(v));
  }
});

test('the heuristic model stays within its bounds and is deterministic for any product and date', () => {
  const r = rng(6);
  for (let i = 0; i < 4000; i++) {
    const p = price(r);
    const input = {
      asin: `B0${Math.floor(r() * 1e8).toString(36).toUpperCase().padEnd(8, 'X').slice(0, 8)}`,
      price: p,
      listPrice: r() < 0.6 ? p * (0.2 + r() * 4) : null,
      category: pick(r, CATEGORIES),
      title: pick(r, ['', 'Gift set', 'Noise cancelling headphones', 'LEGO set']),
      volatility: 0.04 + r() * 0.31,
      signals: r() < 0.4 ? { avgPrice: p * (0.3 + r() * 3), lowPrice: p * r(), highPrice: p * (1 + r()) } : {},
      now: new Date(Date.UTC(2024 + Math.floor(r() * 4), Math.floor(r() * 12), 1 + Math.floor(r() * 28)))
    };
    const out = simulatePrediction(input);
    assert.ok(out.sentimentMultiplier >= 0.85 && out.sentimentMultiplier <= 1.15, JSON.stringify(out));
    assert.ok(out.discountProbability >= 0.05 && out.discountProbability <= 0.95);
    assert.ok(out.priceDrift >= -0.15 && out.priceDrift <= 0.15);
    assert.equal(out.isSimulated, true);
    assert.ok(typeof out.rationale === 'string' && out.rationale.length > 0);
    assert.deepEqual(simulatePrediction(input), out);

    const projection = computeProjection({
      currentPrice: p,
      volatility: input.volatility,
      discountProbability: out.discountProbability,
      sentimentMultiplier: out.sentimentMultiplier,
      priceDrift: out.priceDrift,
      quality: { isSimulated: true }
    });
    assert.ok(Number.isFinite(projection.deltaPercentMonth));
    assert.ok(projection.tiers.lowest <= projection.tiers.mid && projection.tiers.mid <= projection.tiers.highest);
  }
});

test('seasonal lookup never throws and reports sane values for every day of the year', () => {
  for (let day = 0; day < 366; day++) {
    const now = new Date(Date.UTC(2026, 0, 1 + day));
    for (const category of ['', 'Electronics', 'Toys', 'Books']) {
      const e = findSeasonalEvent(now, category);
      if (!e) continue;
      assert.ok(e.depth > 0 && e.depth < 1 && e.relevance > 0 && e.relevance <= 1, JSON.stringify(e));
      assert.ok(typeof e.inProgress === 'boolean');
      if (!e.inProgress) assert.ok(e.daysUntil >= 0);
    }
  }
});
