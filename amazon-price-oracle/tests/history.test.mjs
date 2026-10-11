import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ASINS,
  MAX_POINTS_PER_ASIN,
  addObservation,
  clearPriceHistory,
  countTrackedProducts,
  historySignals,
  recordPrice,
  summarize
} from '../src/background/price-history.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);

function stubChrome() {
  const store = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: async (k) => (k in store ? { [k]: structuredClone(store[k]) } : {}),
        set: async (o) => Object.assign(store, structuredClone(o)),
        remove: async (k) => delete store[k]
      }
    }
  };
  return store;
}

test('same price within 6 hours is not stored twice; a new price or a later day is', () => {
  let pts = addObservation([], 10, T0);
  pts = addObservation(pts, 10, T0 + 3600e3);
  assert.equal(pts.length, 1);
  pts = addObservation(pts, 9, T0 + 3600e3);
  assert.equal(pts.length, 2);
  pts = addObservation(pts, 9, T0 + DAY);
  assert.equal(pts.length, 3);
});

test('points are capped per ASIN and old points expire', () => {
  let pts = [];
  for (let i = 0; i < MAX_POINTS_PER_ASIN + 10; i++) pts = addObservation(pts, 10 + i, T0 + i * DAY);
  assert.equal(pts.length <= MAX_POINTS_PER_ASIN, true);
  const old = addObservation([[T0, 5]], 6, T0 + 130 * DAY);
  assert.deepEqual(old.map(([, p]) => p), [6]);
});

test('summarize reports count, range, average and span', () => {
  const s = summarize([[T0, 10], [T0 + DAY, 14], [T0 + 3 * DAY, 12]], T0 + 3 * DAY);
  assert.deepEqual(s, { count: 3, low: 10, high: 14, avg: 12, spanDays: 3 });
  assert.equal(summarize([], T0), null);
});

test('history only becomes a signal with enough points over enough days', () => {
  assert.deepEqual(historySignals(null), {});
  assert.deepEqual(historySignals({ count: 2, low: 1, high: 2, avg: 1.5, spanDays: 9 }), {});
  assert.deepEqual(historySignals({ count: 5, low: 1, high: 2, avg: 1.5, spanDays: 1 }), {});
  assert.deepEqual(historySignals({ count: 4, low: 10, high: 14, avg: 12, spanDays: 6 }), { lowPrice: 10, highPrice: 14, avgPrice: 12 });
  assert.deepEqual(historySignals({ count: 4, low: 10, high: 10, avg: 10, spanDays: 6 }), { avgPrice: 10 }); // flat: no range
});

test('recordPrice persists, summarises and survives concurrent writes', async () => {
  const store = stubChrome();
  await Promise.all(Array.from({ length: 30 }, (_, i) => recordPrice(`B0HIST${String(i).padStart(4, '0')}`, 20 + i, T0)));
  assert.equal(await countTrackedProducts(), 30);
  const s = await recordPrice('B0HIST0000', 18, T0 + DAY);
  assert.equal(s.count, 2);
  assert.equal(s.low, 18);
  assert.equal(Object.keys(store.price_history).length, 30);
});

test('least recently seen products are evicted beyond the limit', async () => {
  stubChrome();
  for (let i = 0; i < MAX_ASINS + 5; i++) await recordPrice(`B0EVIC${String(i).padStart(4, '0')}`, 10, T0 + i * 1000);
  assert.equal(await countTrackedProducts(), MAX_ASINS);
});

test('clearPriceHistory removes everything', async () => {
  stubChrome();
  await recordPrice('B0CLEAR001', 10, T0);
  await clearPriceHistory();
  assert.equal(await countTrackedProducts(), 0);
});

test('revisiting an unchanged product does not write to storage again', async () => {
  const store = stubChrome();
  let sets = 0;
  const realSet = chrome.storage.local.set;
  chrome.storage.local.set = async (o) => {
    sets++;
    return realSet(o);
  };
  await recordPrice('B0NOOP0001', 10, T0);
  assert.equal(sets, 1);
  const again = await recordPrice('B0NOOP0001', 10, T0 + 3600e3);
  assert.equal(sets, 1);
  assert.equal(again.count, 1);
  await recordPrice('B0NOOP0001', 11, T0 + 3600e3);
  assert.equal(sets, 2);
  assert.equal(store.price_history.B0NOOP0001.length, 2);
});
