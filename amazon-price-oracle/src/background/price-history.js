/**
 * Local price history.
 *
 * Amazon pages expose no price history, so PriceOracle remembers the prices it
 * has itself seen for each ASIN (product pages and search cards). Everything
 * stays in chrome.storage.local; nothing is sent anywhere.
 *
 * Observations only fill gaps: `historySignals` returns low/avg/high prices that
 * the analysis merges *under* whatever context.dev reported, and only once the
 * history is convincing (several distinct observations over several days).
 */
import { STORAGE_KEYS } from '../shared/constants.js';

/** Do not store a second point for the same price within this window. */
const MIN_GAP_MS = 6 * 60 * 60 * 1000;
export const MAX_POINTS_PER_ASIN = 40;
export const MAX_ASINS = 300;
/** Points older than this are dropped; deals older than a quarter say little about next month. */
const MAX_AGE_MS = 120 * 24 * 60 * 60 * 1000;
/** Evidence thresholds before history is allowed to influence the projection. */
export const MIN_POINTS_FOR_SIGNALS = 3;
export const MIN_SPAN_DAYS_FOR_SIGNALS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Add an observation to one ASIN's points. Pure.
 * @param {Array<[number, number]>} points  Ascending `[timestamp, price]` pairs.
 * @param {number} price
 * @param {number} now
 * @returns {Array<[number, number]>}
 */
export function addObservation(points, price, now) {
  const kept = points.filter(([t]) => now - t < MAX_AGE_MS);
  const last = kept[kept.length - 1];
  if (last && last[1] === price && now - last[0] < MIN_GAP_MS) return kept;
  kept.push([now, price]);
  return kept.slice(-MAX_POINTS_PER_ASIN);
}

/**
 * Summarise points. Pure.
 * @param {Array<[number, number]>} points
 * @param {number} [now]
 * @returns {{count: number, low: number, high: number, avg: number, spanDays: number}|null}
 */
export function summarize(points, now = Date.now()) {
  const fresh = points.filter(([t]) => now - t < MAX_AGE_MS);
  if (!fresh.length) return null;
  const prices = fresh.map(([, p]) => p);
  const sum = prices.reduce((a, b) => a + b, 0);
  return {
    count: fresh.length,
    low: Math.min(...prices),
    high: Math.max(...prices),
    avg: Math.round((sum / prices.length) * 100) / 100,
    spanDays: Math.round(((fresh[fresh.length - 1][0] - fresh[0][0]) / DAY_MS) * 10) / 10
  };
}

/**
 * Signals the projection engine understands, or {} while the evidence is thin.
 * The range is only reported when it actually moved (a flat price teaches nothing).
 * @param {ReturnType<typeof summarize>} summary
 */
export function historySignals(summary) {
  if (!summary || summary.count < MIN_POINTS_FOR_SIGNALS || summary.spanDays < MIN_SPAN_DAYS_FOR_SIGNALS) return {};
  if (summary.high <= summary.low) return { avgPrice: summary.avg };
  return { lowPrice: summary.low, highPrice: summary.high, avgPrice: summary.avg };
}

// ---------------------------------------------------------------------------
// Storage (writes are chained so concurrent analyses cannot overwrite each other)
// ---------------------------------------------------------------------------

let writes = Promise.resolve();

/**
 * Record a price and return the summary including it.
 * @param {string} asin
 * @param {number} price
 * @param {number} [now]
 */
export function recordPrice(asin, price, now = Date.now()) {
  const job = writes.then(async () => {
    const all = (await chrome.storage.local.get(STORAGE_KEYS.PRICE_HISTORY))[STORAGE_KEYS.PRICE_HISTORY] || {};
    const points = addObservation(all[asin] || [], price, now);
    all[asin] = points;
    const asins = Object.keys(all);
    if (asins.length > MAX_ASINS) {
      // Evict the ASINs seen least recently.
      asins
        .sort((a, b) => all[b][all[b].length - 1][0] - all[a][all[a].length - 1][0])
        .slice(MAX_ASINS)
        .forEach((k) => delete all[k]);
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.PRICE_HISTORY]: all });
    return summarize(points, now);
  });
  writes = job.catch(() => {});
  return job;
}

/** Number of ASINs with remembered prices (for the popup). */
export async function countTrackedProducts() {
  const all = (await chrome.storage.local.get(STORAGE_KEYS.PRICE_HISTORY))[STORAGE_KEYS.PRICE_HISTORY] || {};
  return Object.keys(all).length;
}

export async function clearPriceHistory() {
  await writes;
  await chrome.storage.local.remove(STORAGE_KEYS.PRICE_HISTORY);
}
