import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeProjection,
  estimateVolatility,
  buildRecommendation
} from '../src/background/projection-engine.js';
import { extractSignals, fetchProductContext, signalsFromMarkdown, unwrapScrapeResponse } from '../src/background/context-dev.js';
import {
  blendMacro,
  computeMacroSignal,
  contractProbability,
  findSeasonalEvent,
  getMacroSignal,
  simulatePrediction
} from '../src/background/gemini-prediction.js';

test('base formula matches the specification when priceDrift is 0', () => {
  const p = computeProjection({ currentPrice: 100, volatility: 0.1, discountProbability: 0.4, sentimentMultiplier: 0.9 });
  // 100 * (1 + (0.9 - 1) * 0.1 * 0.6) = 99.40
  assert.equal(p.projectedMid, 99.4);
  assert.equal(p.deltaPercentMonth, -0.6);
  assert.equal(p.tiers.lowest, 78); // 100 * (1 - 2.2 * 0.1)
  assert.equal(p.tiers.low, 89); // 100 * (1 - 1.1 * 0.1)
  assert.equal(p.tiers.high, 110); // 100 * (1 + 1.0 * 0.1)
  assert.equal(p.tiers.highest, 121); // 100 * (1 + 2.1 * 0.1)
  assert.equal(p.recommendation.action, 'FAIR_PRICE');
});

test('tiers are always ascending, even with strong drift', () => {
  for (const drift of [-0.15, -0.05, 0, 0.05, 0.15]) {
    const { tiers } = computeProjection({
      currentPrice: 174.99, volatility: 0.05, discountProbability: 0.2, sentimentMultiplier: 1.1, priceDrift: drift
    });
    const v = [tiers.lowest, tiers.low, tiers.mid, tiers.high, tiers.highest];
    assert.deepEqual([...v].sort((a, b) => a - b), v, `drift ${drift}`);
  }
});

test('recommendation thresholds are +/-4%', () => {
  assert.equal(buildRecommendation(-4.0, -4).action, 'WAIT');
  assert.equal(buildRecommendation(-3.9, -3.9).action, 'FAIR_PRICE');
  assert.equal(buildRecommendation(3.9, 3.9).action, 'FAIR_PRICE');
  assert.equal(buildRecommendation(4.0, 4).action, 'BUY_NOW');
  assert.match(buildRecommendation(-8.4, -14.7).message, /drop 8\.4% \(~\$14\.70\)/);
});

test('drift can produce WAIT / BUY NOW', () => {
  const wait = computeProjection({ currentPrice: 174.99, volatility: 0.12, discountProbability: 0.5, sentimentMultiplier: 0.9, priceDrift: -0.08 });
  assert.equal(wait.recommendation.action, 'WAIT');
  assert.ok(wait.deltaPercentMonth < -4);
  const buy = computeProjection({ currentPrice: 50, volatility: 0.12, discountProbability: 0.2, sentimentMultiplier: 1.1, priceDrift: 0.06 });
  assert.equal(buy.recommendation.action, 'BUY_NOW');
});

test('inputs are clamped and invalid price rejected', () => {
  assert.throws(() => computeProjection({ currentPrice: 0, volatility: 0.1, discountProbability: 0.1, sentimentMultiplier: 1 }));
  const p = computeProjection({ currentPrice: 10, volatility: 5, discountProbability: 7, sentimentMultiplier: 9 });
  assert.equal(p.volatility, 0.35);
  assert.ok(p.confidence >= 40 && p.confidence <= 93);
});

test('volatility estimate reacts to category and observed range', () => {
  const book = estimateVolatility({ category: 'Books', price: 20 });
  const tv = estimateVolatility({ category: 'Electronics > Television', price: 600 });
  assert.ok(tv > book);
  const ranged = estimateVolatility({ category: 'Books', price: 20, signals: { lowPrice: 14, highPrice: 26 } });
  assert.ok(ranged > book);
});

test('extractSignals reads structured JSON and markdown', () => {
  const signals = extractSignals({
    json: { product: { title: 'X', price: '$174.99', listPrice: '$219.00', rating: 4.5, reviewCount: '12,345', category: ['Electronics', 'Audio'] } },
    markdown: 'Lowest price in the last 30 days: $149.00\n-20% off\n4.5 out of 5 stars\n2,000+ bought in past month'
  });
  assert.equal(signals.currentPrice, 174.99);
  assert.equal(signals.listPrice, 219);
  assert.equal(signals.reviewCount, 12345);
  assert.equal(signals.category, 'Electronics > Audio');
  assert.equal(signals.lowPrice, 149);
  assert.equal(signals.discountPct, 20);
  assert.equal(signals.boughtPastMonth, 2000);
  assert.deepEqual(extractSignals(null), {});
});

test('markdown parser handles list price phrasing', () => {
  assert.equal(signalsFromMarkdown('List Price: $1,299.00').listPrice, 1299);
});

const contract = (label, bestBid, bestAsk, lastTradePrice) => ({ label, prices: { bestBid, bestAsk, lastTradePrice } });
// Shaped like GET /v1/prediction-markets/events?category=Economics (prices are strings).
const ECONOMICS = [
  {
    ticker: 'FED260917', title: 'Fed decision in September?', expiryDate: '2026-09-17T18:00:00.000Z',
    contracts: [contract('Fed maintains rate', '0.9', '0.92', '0.9')]
  },
  {
    ticker: 'FED261211', title: 'Fed decision in December?', expiryDate: '2026-12-11T05:00:00.000Z',
    contracts: [
      contract('Hike 25bps', '0.60', '0.80', '0.66'),
      contract('Fed maintains rate', '0.22', '0.29', '0.28'),
      contract('Cut 25bps', null, '0.05', null),
      contract('Hike >25bps', null, null, null)
    ]
  },
  { ticker: 'RECESSION26', title: 'Recession this year?', expiryDate: '2027-02-01T00:00:00.000Z', contracts: [contract('Yes', '0.30', '0.40', '0.35')] }
];

test('contractProbability uses mid, then last trade, else null', () => {
  assert.equal(contractProbability(contract('x', '0.82', '0.86', '0.1')), 0.84);
  assert.equal(contractProbability(contract('x', null, '0.05', '0.66')), 0.66);
  assert.equal(contractProbability(contract('x', null, null, null)), null);
  assert.equal(contractProbability({}), null);
});

test('computeMacroSignal picks the next upcoming Fed market and the recession market', () => {
  const macro = computeMacroSignal(ECONOMICS, new Date(Date.UTC(2026, 9, 11)));
  assert.equal(macro.fedEvent, 'Fed decision in December?'); // September already expired
  assert.equal(macro.hike, 0.7); // mid(0.60, 0.80)
  assert.equal(macro.cut, 0); // the only cut contract has no bid and no trades
  assert.equal(macro.recession, 0.35);
  // 1 + 0.10 * (0.70 - 0) - 0.50 * 0.35 = 0.895
  assert.ok(Math.abs(macro.sentimentMultiplier - 0.895) < 1e-3);
  assert.ok(macro.sentimentMultiplier >= 0.85 && macro.sentimentMultiplier <= 1.15);
  assert.ok(macro.discountProbabilityBoost > 0 && macro.discountProbabilityBoost <= 0.2);
  assert.match(macro.summary, /Fed hike odds 70%.*recession odds 35%/);
  assert.throws(() => computeMacroSignal([], new Date()), /No Fed or recession/);
});

test('blendMacro marks the prediction live and stays within bounds', () => {
  const base = simulatePrediction({ asin: 'B09B8V1LZ3', price: 79.99, category: 'Electronics', volatility: 0.15, now: new Date(Date.UTC(2026, 2, 3)) });
  const macro = computeMacroSignal(ECONOMICS, new Date(Date.UTC(2026, 9, 11)));
  const blended = blendMacro(base, macro);
  assert.equal(blended.isSimulated, false);
  assert.equal(blended.marketsStatus, 'live');
  assert.equal(blended.source, 'gemini-markets');
  assert.ok(blended.discountProbability >= base.discountProbability);
  assert.ok(blended.sentimentMultiplier < base.sentimentMultiplier); // recession odds pull prices down
  assert.match(blended.rationale, /Gemini markets: Fed hike odds/);
});

test('simulation is deterministic, bounded and flagged as simulated', () => {
  const now = new Date(Date.UTC(2026, 9, 11));
  const input = { asin: 'B0CX23V258', price: 174.99, listPrice: 219, category: 'Electronics', volatility: 0.15, now };
  const a = simulatePrediction(input);
  const b = simulatePrediction(input);
  assert.deepEqual(a, b);
  assert.equal(a.isSimulated, true);
  assert.ok(a.sentimentMultiplier >= 0.85 && a.sentimentMultiplier <= 1.15);
  assert.ok(a.discountProbability >= 0.05 && a.discountProbability <= 0.95);
  assert.ok(a.priceDrift >= -0.15 && a.priceDrift <= 0.15);
});

test('price far above list-derived reference pushes drift negative', () => {
  const now = new Date(Date.UTC(2026, 2, 3));
  const high = simulatePrediction({ asin: 'B000000001', price: 120, category: 'Home', volatility: 0.1, signals: { avgPrice: 90 }, now });
  const low = simulatePrediction({ asin: 'B000000001', price: 80, category: 'Home', volatility: 0.1, signals: { avgPrice: 90 }, now });
  assert.ok(high.priceDrift < 0);
  assert.ok(low.priceDrift > high.priceDrift);
});

test('seasonal calendar finds Black Friday ahead of time', () => {
  const ev = findSeasonalEvent(new Date(Date.UTC(2026, 10, 1)), 'Electronics');
  assert.match(ev.name, /Black Friday/);
  assert.equal(findSeasonalEvent(new Date(Date.UTC(2026, 2, 3)), 'Books'), null);
});

test('scrape response wrapper is unwrapped and failures surface clearly', () => {
  const ok = unwrapScrapeResponse({
    json: { requested: true, success: true, data: { currentPrice: 79.99, listPrice: null, rating: 4.7, reviewCount: 200753, boughtPastMonth: 10000, category: 'Amazon Devices > Echo' } },
    markdown: { requested: true, success: true, data: '# Echo' }
  });
  const signals = extractSignals(ok);
  assert.equal(signals.currentPrice, 79.99);
  assert.equal(signals.listPrice, undefined);
  assert.equal(signals.boughtPastMonth, 10000);
  assert.equal(signals.category, 'Amazon Devices > Echo');

  const partial = unwrapScrapeResponse({
    json: { requested: true, success: false, data: null, message: 'x' },
    markdown: { requested: true, success: true, data: 'List Price: $50.00' }
  });
  assert.equal(extractSignals(partial).listPrice, 50);

  assert.throws(
    () => unwrapScrapeResponse({
      json: { requested: true, success: false, data: null, message: 'The page returned HTTP 404.' },
      markdown: { requested: true, success: false, data: null, message: 'The page returned HTTP 404.' }
    }),
    /HTTP 404/
  );
});

/** Minimal in-memory chrome.storage.local + fetch stubs for background modules. */
function stubChrome() {
  const store = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, store[k]]));
        },
        set: async (obj) => Object.assign(store, obj),
        remove: async (keys) => [].concat(keys).forEach((k) => delete store[k])
      }
    }
  };
  return store;
}

test('light mode (cacheOnly) never calls context.dev and reports "skipped"', async () => {
  stubChrome();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('network must not be used');
  };
  const result = await fetchProductContext('B0SEARCH01', { cacheOnly: true });
  assert.equal(result.status, 'skipped');
  assert.deepEqual(result.signals, {});
  assert.equal(calls, 0);
});

test('concurrent macro lookups share a single Gemini markets request', async () => {
  stubChrome();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return { ok: true, status: 200, json: async () => ({
        data: [
          {
            ticker: 'RECESSION26',
            title: 'Recession this year?',
            expiryDate: '2099-02-01T00:00:00.000Z',
            contracts: [{ label: 'Yes', prices: { bestBid: '0.03', bestAsk: '0.05', lastTradePrice: '0.04' } }]
          }
        ]
      })
    };
  };
  const results = await Promise.all(Array.from({ length: 20 }, () => getMacroSignal(new Date('2026-01-15'))));
  assert.equal(calls, 1);
  assert.ok(results.every((r) => r.sentimentMultiplier === results[0].sentimentMultiplier));
  await getMacroSignal(new Date('2026-01-15')); // now served from the 3h cache
  assert.equal(calls, 1);
});
