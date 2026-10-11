/**
 * Gemini prediction-markets client + heuristic model.
 *
 * Data source: https://developer.gemini.com/prediction-markets-spec/markets
 * (`GET /v1/prediction-markets/events`). These market-data endpoints are public;
 * contract prices are probabilities (0-1). PriceOracle reads the "Economics"
 * category once, extracts
 *   - the next Fed decision (probability of a hike vs. a cut), and
 *   - the "Recession this year?" market,
 * and turns them into a sentiment multiplier (0.85-1.15) and a discount-
 * probability boost that are blended into the per-product heuristic model.
 * Rate-hike odds mean inflation pressure (prices up); recession odds mean weaker
 * demand (more discounts).
 *
 * No API key is needed. If Gemini markets cannot be reached, the
 * extension falls back to the heuristic model alone ("Prediction Simulation
 * Mode", `isSimulated: true`) and never breaks.
 */
import {
  GEMINI_MARKETS_BASE,
  MACRO_CACHE_TTL_MS,
  MACRO_STALE_MAX_MS,
  STORAGE_KEYS
} from '../shared/constants.js';

const REQUEST_TIMEOUT_MS = 15000;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * @typedef {Object} MacroSignal
 * @property {string|null} fedEvent        Title of the next Fed-decision market.
 * @property {number} hike                 Summed probability of any hike (0-1).
 * @property {number} cut                  Summed probability of any cut (0-1).
 * @property {number|null} recession       Probability of recession (0-1), null if no market found.
 * @property {number} sentimentMultiplier  0.85-1.15.
 * @property {number} discountProbabilityBoost  0-0.2.
 * @property {string} summary              Human-readable one-liner.
 * @property {number} fetchedAt
 * @property {boolean} [stale]             True when served from an old cache after a failed refresh.
 *
 * @typedef {Object} Prediction
 * @property {number} sentimentMultiplier  0.85-1.15 (<1 = prices expected to fall).
 * @property {number} discountProbability  0-1 chance of a notable discount within 30 days.
 * @property {number} priceDrift           Additive fraction applied to the mid price (-0.15..0.15).
 * @property {boolean} isSimulated         True when no live Gemini market data was available.
 * @property {'gemini-markets'|'heuristic'} source
 * @property {'live'|'offline'} marketsStatus
 * @property {string} rationale            One-line explanation shown in tooltips.
 * @property {MacroSignal|null} macro
 * @property {string} [error]              Why Gemini markets was bypassed.
 */

/**
 * Get a prediction for a product: heuristic model + live Gemini market odds.
 *
 * @param {Object} input
 * @param {string} input.asin
 * @param {number} input.price
 * @param {number} [input.listPrice]
 * @param {string} [input.title]
 * @param {string} [input.category]
 * @param {number} input.volatility
 * @param {import('./context-dev.js').ContextSignals} [input.signals]
 * @param {Date} [input.now]
 * @returns {Promise<Prediction>}
 */
export async function getPrediction(input) {
  const base = simulatePrediction(input);
  try {
    const macro = await getMacroSignal(input.now);
    return blendMacro(base, macro);
  } catch (err) {
    return {
      ...base,
      marketsStatus: 'offline',
      macro: null,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

/**
 * Blend a macro signal into the heuristic forecast.
 * @param {Prediction} base
 * @param {MacroSignal} macro
 * @returns {Prediction}
 */
export function blendMacro(base, macro) {
  return {
    ...base,
    sentimentMultiplier: round(clamp(base.sentimentMultiplier * macro.sentimentMultiplier, 0.85, 1.15), 3),
    discountProbability: round(clamp(base.discountProbability + macro.discountProbabilityBoost, 0.05, 0.95), 3),
    priceDrift: round(clamp(base.priceDrift + (macro.sentimentMultiplier - 1) * 0.5, -0.15, 0.15), 4),
    isSimulated: false,
    source: 'gemini-markets',
    marketsStatus: 'live',
    macro,
    rationale: `${base.rationale} Gemini markets: ${macro.summary}.`
  };
}

// ---------------------------------------------------------------------------
// Gemini prediction markets (live)
// ---------------------------------------------------------------------------

/**
 * Read the macro signal, using a 3-hour cache. Falls back to a stale cached
 * reading (up to 24 h old) if Gemini cannot be reached.
 * @param {Date} [now]
 * @returns {Promise<MacroSignal>}
 */
export async function getMacroSignal(now = new Date()) {
  const cached = (await chrome.storage.local.get(STORAGE_KEYS.MACRO_CACHE))[STORAGE_KEYS.MACRO_CACHE];
  const age = cached ? Date.now() - cached.fetchedAt : Infinity;
  if (cached && age < MACRO_CACHE_TTL_MS) return cached;

  // A search page analyses dozens of cards at once; they must share one network call.
  if (!macroInflight) {
    macroInflight = refreshMacroSignal(now).finally(() => {
      macroInflight = null;
    });
  }
  try {
    return await macroInflight;
  } catch (err) {
    if (cached && age < MACRO_STALE_MAX_MS) return { ...cached, stale: true };
    throw err;
  }
}

let macroInflight = null;

async function refreshMacroSignal(now) {
  const events = await fetchEconomicsEvents();
  const macro = computeMacroSignal(events, now);
  await chrome.storage.local.set({ [STORAGE_KEYS.MACRO_CACHE]: macro });
  return macro;
}

/**
 * GET /v1/prediction-markets/events?status=active&category=Economics
 * @returns {Promise<any[]>} The `data` array of events.
 */
export async function fetchEconomicsEvents() {
  const url = `${GEMINI_MARKETS_BASE}/events?status=active&category=Economics&limit=50`;
  const body = await geminiGet(url);
  if (!Array.isArray(body?.data)) throw new Error('Gemini markets returned an unexpected response');
  return body.data;
}

async function geminiGet(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 429) throw new Error('Gemini markets rate limit reached (HTTP 429)');
    if (!res.ok) throw new Error(`Gemini markets request failed (HTTP ${res.status})`);
    return await res.json();
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('Gemini markets request timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probability (0-1) of a contract's "yes" side: bid/ask midpoint, else the last
 * trade, else null (illiquid contracts often have no quotes).
 * Prices arrive as strings, e.g. "0.86".
 * @param {{prices?: {bestBid?: string|null, bestAsk?: string|null, lastTradePrice?: string|null}}} contract
 * @returns {number|null}
 */
export function contractProbability(contract) {
  const { bestBid, bestAsk, lastTradePrice } = contract?.prices || {};
  const bid = parseFloat(bestBid);
  const ask = parseFloat(bestAsk);
  if (Number.isFinite(bid) && Number.isFinite(ask)) return clamp((bid + ask) / 2, 0, 1);
  const last = parseFloat(lastTradePrice);
  return Number.isFinite(last) ? clamp(last, 0, 1) : null;
}

/**
 * Turn Economics events into the macro signal. Pure; unit tested.
 *
 *   inflationPressure = P(hike) - P(cut)                       (-1..1)
 *   sentiment         = 1 + 0.10 * inflationPressure - 0.50 * P(recession)
 *   discountBoost     = 0.40 * P(recession) + 0.10 * max(0, -inflationPressure)
 *
 * @param {any[]} events
 * @param {Date} [now]
 * @returns {MacroSignal}
 */
export function computeMacroSignal(events, now = new Date()) {
  const upcoming = (e) => !e.expiryDate || new Date(e.expiryDate) >= now;

  const fed = events
    .filter((e) => /^FED\d/i.test(e.ticker || '') && upcoming(e))
    .sort((a, b) => String(a.expiryDate).localeCompare(String(b.expiryDate)))[0];
  const recessionEvent = events.find((e) => /^RECESSION/i.test(e.ticker || '') || /recession/i.test(e.title || ''));

  if (!fed && !recessionEvent) throw new Error('No Fed or recession markets found on Gemini');

  let hike = 0;
  let cut = 0;
  for (const contract of fed?.contracts || []) {
    const p = contractProbability(contract) ?? 0;
    if (/hike|raise/i.test(contract.label || '')) hike += p;
    else if (/cut|lower/i.test(contract.label || '')) cut += p;
  }
  hike = clamp(hike, 0, 1);
  cut = clamp(cut, 0, 1);

  const yes = recessionEvent?.contracts?.find((c) => /^yes$/i.test(c.label || '')) || recessionEvent?.contracts?.[0];
  const recession = yes ? contractProbability(yes) : null;

  const inflationPressure = clamp(hike - cut, -1, 1);
  const r = recession ?? 0;
  const pct = (n) => `${Math.round(n * 100)}%`;
  const parts = [];
  if (fed) parts.push(`Fed hike odds ${pct(hike)}, cut odds ${pct(cut)}`);
  if (recession !== null) parts.push(`recession odds ${pct(recession)}`);

  return {
    fedEvent: fed?.title ?? null,
    hike: round(hike, 3),
    cut: round(cut, 3),
    recession: recession === null ? null : round(recession, 3),
    sentimentMultiplier: round(clamp(1 + 0.1 * inflationPressure - 0.5 * r, 0.85, 1.15), 4),
    discountProbabilityBoost: round(clamp(0.4 * r + 0.1 * Math.max(0, -inflationPressure), 0, 0.2), 4),
    summary: parts.join(' · '),
    fetchedAt: Date.now()
  };
}

/**
 * Reachability check for "Test Connection". Calls the lightweight categories
 * endpoint (public market data, no key).
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function testGeminiConnection() {
  try {
    const body = await geminiGet(`${GEMINI_MARKETS_BASE}/categories`);
    const count = Array.isArray(body?.categories) ? body.categories.length : 0;
    return {
      ok: true,
      message: `Connected — Gemini prediction markets reachable (${count} categories). Market data is public; no key needed.`
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: /abort|fetch|network/i.test(message) ? 'Network error — api.gemini.com unreachable' : message };
  }
}

// ---------------------------------------------------------------------------
// Prediction Simulation Mode (heuristic)
// ---------------------------------------------------------------------------

/** Typical depth of a sale (fraction off) and category relevance per seasonal event. */
function seasonalEvents(year) {
  const thanksgiving = nthWeekday(year, 10, 4, 4); // 4th Thursday of November
  const blackFriday = addDays(thanksgiving, 1);
  const cyberMonday = addDays(thanksgiving, 4);
  const day = (m, d) => new Date(Date.UTC(year, m, d));
  const tech = /electronic|computer|laptop|tablet|camera|headphone|audio|tv|phone|gaming|smart home|wearable/i;
  const school = /office|computer|laptop|electronic|backpack|school|stationery/i;
  const outdoor = /home|kitchen|garden|patio|tools|outdoor|sports|furniture|appliance|mattress/i;

  return [
    { name: 'New Year clearance', start: day(0, 1), end: day(0, 10), depth: 0.07, relevance: () => 0.6 },
    { name: 'Presidents Day sales', start: day(1, 12), end: day(1, 18), depth: 0.06, relevance: (c) => (outdoor.test(c) ? 0.9 : 0.4) },
    { name: 'Memorial Day sales', start: day(4, 20), end: day(4, 28), depth: 0.07, relevance: (c) => (outdoor.test(c) ? 1 : 0.5) },
    { name: 'Prime Day', start: day(6, 8), end: day(6, 16), depth: 0.12, relevance: () => 1 },
    { name: 'Back-to-school sales', start: day(7, 1), end: day(7, 25), depth: 0.07, relevance: (c) => (school.test(c) ? 0.9 : 0.3) },
    { name: 'Labor Day sales', start: day(8, 1), end: day(8, 8), depth: 0.07, relevance: (c) => (outdoor.test(c) ? 1 : 0.5) },
    { name: 'Prime Big Deal Days', start: day(9, 6), end: day(9, 14), depth: 0.1, relevance: () => 0.9 },
    { name: 'Black Friday / Cyber Monday', start: addDays(blackFriday, -3), end: cyberMonday, depth: 0.15, relevance: (c) => (tech.test(c) ? 1 : 0.9) },
    { name: 'Post-Christmas clearance', start: day(11, 26), end: day(11, 31), depth: 0.08, relevance: () => 0.6 }
  ];
}

/** Late-year gift-buying demand pushes prices up between Cyber Monday and Christmas. */
function isHolidayDemandPeak(date) {
  const y = date.getUTCFullYear();
  const cyberMonday = addDays(nthWeekday(y, 10, 4, 4), 4);
  return date > cyberMonday && date < new Date(Date.UTC(y, 11, 21));
}

function nthWeekday(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month, 1 + offset + (n - 1) * 7));
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

/**
 * Find the most relevant sale event that is running or starts within 45 days.
 * @param {Date} now
 * @param {string} category
 */
export function findSeasonalEvent(now, category = '') {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let best = null;
  for (const year of [today.getUTCFullYear(), today.getUTCFullYear() + 1]) {
    for (const ev of seasonalEvents(year)) {
      const relevance = ev.relevance(category);
      const inProgress = today >= ev.start && today <= ev.end;
      const daysUntil = Math.round((ev.start - today) / 86400000);
      if (!inProgress && (daysUntil < 0 || daysUntil > 45)) continue;
      const proximity = inProgress ? 1 : clamp(1.15 - daysUntil / 45, 0.25, 1);
      const weight = ev.depth * relevance * proximity;
      if (!best || weight > best.weight) {
        best = { name: ev.name, depth: ev.depth, relevance, inProgress, daysUntil: Math.max(0, daysUntil), weight };
      }
    }
  }
  return best;
}

/**
 * Deterministic heuristic forecast ("Prediction Simulation Mode").
 *
 * Combines (1) mean reversion toward the typical price, (2) the seasonal sale
 * calendar, (3) category sale propensity and (4) small seeded noise so that the
 * same product gives the same answer within a week but products differ.
 *
 * @param {Object} input See {@link getPrediction}.
 * @returns {Prediction & {event?: string}}
 */
export function simulatePrediction({ asin = '', price, listPrice, category = '', title = '', volatility = 0.1, signals = {}, now = new Date() }) {
  const rand = mulberry32(hashString(`${asin}:${isoWeek(now)}`));
  const noise = (amp) => (rand() * 2 - 1) * amp;
  const haystack = `${category} ${signals.category || ''} ${title}`;

  // (1) Mean reversion: how far is today's price from what this item "normally" costs?
  const typical = signals.avgPrice || (signals.lowPrice && signals.highPrice ? (signals.lowPrice + signals.highPrice) / 2 : 0);
  // A list price below today's price says nothing about discounts (it is often scraped noise).
  const listRef = Math.max(listPrice || 0, signals.listPrice || 0);
  const listSignal = listRef > price ? listRef * 0.96 : 0; // list prices overstate what items actually sell for
  let reference = typical || listSignal;
  if (reference < price * 0.4 || reference > price * 2.5) reference = 0; // implausible -> ignore
  const gap = reference > 0 ? (price - reference) / reference : 0; // +ve = pricey today
  let drift = clamp(-gap * 0.55, -0.12, 0.1);
  const nearFloor = signals.lowPrice > 0 && price <= signals.lowPrice * 1.03;
  if (nearFloor) drift += 0.04;

  // (2) Seasonal sale calendar
  const event = findSeasonalEvent(now, haystack);
  let eventNote = '';
  if (event) {
    if (event.inProgress) {
      drift += event.depth * event.relevance * 0.35; // sale is live; prices tend to rebound afterwards
      eventNote = `${event.name} is live`;
    } else {
      drift -= event.depth * event.relevance * clamp(1.15 - event.daysUntil / 45, 0.25, 1);
      eventNote = `${event.name} in ~${event.daysUntil}d`;
    }
  } else if (isHolidayDemandPeak(now)) {
    drift += 0.03;
    eventNote = 'holiday demand peak';
  }

  drift = clamp(drift + noise(0.012), -0.15, 0.15);

  // (3) Discount probability
  const saleProneness = clamp(volatility * 1.6, 0.1, 0.5); // volatile categories get discounted more often
  let discountProbability = 0.18 + saleProneness * 0.6;
  if (event && !event.inProgress) discountProbability += event.depth * event.relevance * 2.2;
  if (event && event.inProgress) discountProbability -= 0.1;
  discountProbability += clamp(gap * 1.4, -0.15, 0.25);
  if (nearFloor) discountProbability -= 0.12;
  discountProbability = clamp(discountProbability + noise(0.04), 0.05, 0.95);

  // (4) Sentiment multiplier follows the drift direction.
  const sentimentMultiplier = clamp(1 + drift * 1.1 + noise(0.01), 0.85, 1.15);

  const parts = [];
  if (reference > 0 && Math.abs(gap) >= 0.03) {
    parts.push(`price is ${Math.abs(gap * 100).toFixed(0)}% ${gap > 0 ? 'above' : 'below'} its typical level`);
  }
  if (eventNote) parts.push(eventNote);
  if (nearFloor) parts.push('already near its recent low');

  return {
    sentimentMultiplier: round(sentimentMultiplier, 3),
    discountProbability: round(discountProbability, 3),
    priceDrift: round(drift, 4),
    isSimulated: true,
    source: 'heuristic',
    marketsStatus: 'offline',
    macro: null,
    rationale: parts.length ? `Heuristic model: ${parts.join('; ')}.` : 'Heuristic model: no strong seasonal or price-level signal.',
    event: event ? eventNote : undefined
  };
}

function round(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return `${d.getUTCFullYear()}-W${Math.ceil(((d - yearStart) / 86400000 + 1) / 7)}`;
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
