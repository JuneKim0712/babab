/**
 * 5-tier projection engine.
 *
 * Pure functions (no chrome.* or network access) so they are trivially unit
 * testable under plain Node.
 *
 * Core formulas (all prices in the same currency, volatility as a fraction):
 *
 *   projectedMid      = P * (1 + (sentiment - 1) * volatility * (1 - discountProbability))
 *   deltaPercentMonth = (projectedMid - P) / P * 100
 *
 *   Lowest  (P5)  = P * (1 - 2.2 * volatility)
 *   Low     (P25) = P * (1 - 1.1 * volatility)
 *   Mid     (P50) = projectedMid
 *   High    (P75) = P * (1 + 1.0 * volatility)
 *   Highest (P95) = P * (1 + 2.1 * volatility)
 *
 * Note on `priceDrift`: with sentiment bounded to 0.85-1.15 the base formula
 * can only move the mid price by (0.15 * volatility) — typically 1-3% — which
 * can never reach the +/-4% recommendation thresholds. `priceDrift` is an
 * optional additive fraction (e.g. -0.08 = expect an 8% drop) describing mean
 * reversion toward the typical price and seasonal sale events. It defaults to
 * 0, in which case the output is exactly the base formula.
 */

export const BUY_NOW_THRESHOLD_PCT = 4.0;
export const WAIT_THRESHOLD_PCT = -4.0;
export const MIN_VOLATILITY = 0.04;
export const MAX_VOLATILITY = 0.35;

/** Baseline 30-day volatility (fraction of price) by product category keyword. */
const CATEGORY_VOLATILITY = [
  [/video game|gaming|console|playstation|xbox|nintendo/i, 0.13],
  [/electronic|computer|laptop|tablet|camera|headphone|audio|tv|television|monitor|phone|smart home|wearable/i, 0.15],
  [/toys?|games?\b/i, 0.14],
  [/fashion|clothing|shoes|apparel|jewelry|watch|handbag/i, 0.16],
  [/home|kitchen|furniture|garden|patio|appliance|tools/i, 0.11],
  [/sports|outdoor|fitness/i, 0.11],
  [/beauty|personal care|health|household|grocery|pantry|pet/i, 0.07],
  [/book|kindle|office|software|music|movie/i, 0.06]
];
const DEFAULT_VOLATILITY = 0.1;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Estimate 30-day price volatility (as a fraction, e.g. 0.12 = 12%).
 *
 * @param {Object} input
 * @param {string} [input.category]  Category/breadcrumb text.
 * @param {string} [input.title]     Product title (secondary hint).
 * @param {number} input.price       Current price.
 * @param {number} [input.listPrice] Strike-through price from the page.
 * @param {import('./context-dev.js').ContextSignals} [input.signals]
 * @returns {number}
 */
export function estimateVolatility({ category = '', title = '', price, listPrice, signals = {} }) {
  const haystack = `${category} ${signals.category || ''} ${title}`;
  let vol = DEFAULT_VOLATILITY;
  for (const [pattern, base] of CATEGORY_VOLATILITY) {
    if (pattern.test(haystack)) {
      vol = base;
      break;
    }
  }

  // Observed range (high-low) is the strongest evidence of true volatility.
  if (signals.lowPrice && signals.highPrice && price > 0 && signals.highPrice > signals.lowPrice) {
    const rangeFraction = (signals.highPrice - signals.lowPrice) / price;
    vol = vol * 0.4 + (rangeFraction / 3) * 0.6;
  }

  // A visible list-price gap means the item is already in discount cycles.
  const ref = Math.max(listPrice || 0, signals.listPrice || 0);
  if (ref > price && price > 0) vol += Math.min(0.05, ((ref - price) / ref) * 0.25);

  // Very cheap items swing more in percentage terms; premium items less.
  if (price > 0 && price < 15) vol += 0.02;
  if (price > 500) vol -= 0.01;

  return round4(clamp(vol, MIN_VOLATILITY, MAX_VOLATILITY));
}

/**
 * Compute the full projection.
 *
 * @param {Object} input
 * @param {number} input.currentPrice
 * @param {number} input.volatility           Fraction (0.04-0.35).
 * @param {number} input.discountProbability  0-1.
 * @param {number} input.sentimentMultiplier  0.85-1.15 (<1 prices falling, >1 rising).
 * @param {number} [input.priceDrift]         Optional additive fraction, see file header.
 * @param {Object} [input.quality]            Inputs for the confidence score.
 * @param {boolean} [input.quality.hasContext]
 * @param {number}  [input.quality.signalCount]
 * @param {boolean} [input.quality.isSimulated]
 * @returns {Projection}
 *
 * @typedef {Object} Projection
 * @property {number} currentPrice
 * @property {number} volatility
 * @property {number} projectedMid
 * @property {number} deltaPercentMonth
 * @property {number} deltaAmount        projectedMid - currentPrice (signed).
 * @property {{lowest:number,low:number,mid:number,high:number,highest:number}} tiers
 * @property {{action:'WAIT'|'BUY_NOW'|'FAIR_PRICE', label:string, message:string}} recommendation
 * @property {number} confidence         Integer percent.
 */
export function computeProjection({
  currentPrice,
  volatility,
  discountProbability,
  sentimentMultiplier,
  priceDrift = 0,
  quality = {}
}) {
  if (!(currentPrice > 0)) throw new RangeError('currentPrice must be a positive number');

  const vol = clamp(Number(volatility) || DEFAULT_VOLATILITY, MIN_VOLATILITY, MAX_VOLATILITY);
  const dp = clamp(Number.isFinite(discountProbability) ? discountProbability : 0.3, 0, 1);
  const sentiment = clamp(Number.isFinite(sentimentMultiplier) ? sentimentMultiplier : 1, 0.85, 1.15);
  const drift = clamp(Number.isFinite(priceDrift) ? priceDrift : 0, -0.2, 0.2);

  const projectedMidRaw = currentPrice * (1 + (sentiment - 1.0) * vol * (1 - dp) + drift);
  const deltaPercentMonth = ((projectedMidRaw - currentPrice) / currentPrice) * 100;

  let lowest = currentPrice * (1 - 2.2 * vol);
  let low = currentPrice * (1 - 1.1 * vol);
  const mid = projectedMidRaw;
  let high = currentPrice * (1 + 1.0 * vol);
  let highest = currentPrice * (1 + 2.1 * vol);

  // A strong drift can push the mid outside the volatility band; widen the
  // neighbouring tiers so the five prices always read in ascending order.
  low = Math.min(low, mid * 0.98);
  high = Math.max(high, mid * 1.02);
  lowest = Math.min(lowest, low * 0.97);
  highest = Math.max(highest, high * 1.03);

  const tiers = {
    lowest: round2(Math.max(0.01, lowest)),
    low: round2(Math.max(0.01, low)),
    mid: round2(Math.max(0.01, mid)),
    high: round2(high),
    highest: round2(highest)
  };

  const projectedMid = tiers.mid;
  const deltaAmount = round2(projectedMid - currentPrice);

  return {
    currentPrice: round2(currentPrice),
    volatility: vol,
    projectedMid,
    deltaPercentMonth: round1(deltaPercentMonth),
    deltaAmount,
    tiers,
    recommendation: buildRecommendation(deltaPercentMonth, deltaAmount),
    confidence: computeConfidence(deltaPercentMonth, quality)
  };
}

/**
 * Map the expected 30-day change to a timing recommendation.
 * @param {number} deltaPercentMonth
 * @param {number} deltaAmount
 */
export function buildRecommendation(deltaPercentMonth, deltaAmount) {
  const pct = Math.abs(round1(deltaPercentMonth)).toFixed(1);
  const dollars = formatUsd(Math.abs(deltaAmount));
  if (deltaPercentMonth <= WAIT_THRESHOLD_PCT) {
    return {
      action: 'WAIT',
      label: 'WAIT',
      message: `Expected to drop ${pct}% (~${dollars}) in 30 days`
    };
  }
  if (deltaPercentMonth >= BUY_NOW_THRESHOLD_PCT) {
    return {
      action: 'BUY_NOW',
      label: 'BUY NOW',
      message: `Projected to increase ${pct}% (~${dollars}) soon`
    };
  }
  return { action: 'FAIR_PRICE', label: 'FAIR PRICE', message: 'Stable price zone' };
}

/**
 * Heuristic confidence from data quality and signal strength: 40-82% for the
 * heuristic-only model, up to 88% when live Gemini market odds back it.
 * @returns {number} Integer percent.
 */
export function computeConfidence(deltaPercentMonth, { hasContext = false, signalCount = 0, isSimulated = true } = {}) {
  let score = 46;
  if (hasContext) score += 12;
  score += Math.min(12, signalCount * 3);
  score += Math.min(16, Math.abs(deltaPercentMonth) * 1.6);
  score += isSimulated ? 0 : 5;
  return Math.round(clamp(score, 40, isSimulated ? 82 : 88));
}

/** Format a number as US dollars. */
export function formatUsd(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}
