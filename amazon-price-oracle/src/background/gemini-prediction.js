/**
 * Gemini prediction client with a graceful heuristic fallback.
 *
 * - Key present  -> asks Google's Gemini API (structured JSON output) for a
 *                   market sentiment multiplier (0.85-1.15), a discount
 *                   probability (0-1) and an optional expected price drift.
 * - Key missing  -> runs "Prediction Simulation Mode": a deterministic model
 *                   built from historical-volatility hints, price-vs-typical
 *                   mean reversion and the Amazon seasonal sale calendar.
 *                   Results are flagged `isSimulated: true`.
 *
 * The same simulation also covers any Gemini failure (bad key, quota,
 * network) so the widget never breaks; `keyStatus` tells the UI which case it is.
 */
import {
  GEMINI_GENERATE_URL,
  GEMINI_MODELS_URL,
  PREDICTION_CACHE_TTL_MS,
  CACHE_MAX_ENTRIES,
  STORAGE_KEYS
} from '../shared/constants.js';

const REQUEST_TIMEOUT_MS = 20000;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * @typedef {Object} Prediction
 * @property {number} sentimentMultiplier  0.85-1.15 (<1 = prices expected to fall).
 * @property {number} discountProbability  0-1 chance of a notable discount within 30 days.
 * @property {number} priceDrift           Additive fraction applied to the mid price (-0.15..0.15).
 * @property {boolean} isSimulated         True when produced by the heuristic model.
 * @property {'gemini'|'heuristic'} source
 * @property {'active'|'pending'|'error'} keyStatus  pending = no key saved.
 * @property {string} rationale            One-line explanation shown in tooltips.
 * @property {string} [error]              Why Gemini was bypassed (keyStatus 'error').
 * @property {boolean} [fromCache]
 */

/**
 * Get a prediction for a product, using Gemini when configured.
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
  const stored = await chrome.storage.local.get(STORAGE_KEYS.GEMINI_KEY);
  const apiKey = (stored[STORAGE_KEYS.GEMINI_KEY] || '').trim();

  if (!apiKey) {
    return { ...simulatePrediction(input), keyStatus: 'pending' };
  }

  const cacheKey = `${input.asin}:${Math.round(input.price)}`;
  const cached = await readPredictionCache(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  const baseline = simulatePrediction(input);
  try {
    const remote = await requestGeminiForecast(apiKey, input, baseline);
    const result = {
      sentimentMultiplier: remote.sentimentMultiplier,
      discountProbability: remote.discountProbability,
      priceDrift: remote.priceDrift ?? baseline.priceDrift,
      isSimulated: false,
      source: 'gemini',
      keyStatus: 'active',
      rationale: remote.rationale || 'Gemini market forecast'
    };
    await writePredictionCache(cacheKey, result);
    return result;
  } catch (err) {
    return {
      ...baseline,
      keyStatus: 'error',
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

// ---------------------------------------------------------------------------
// Gemini (live) mode
// ---------------------------------------------------------------------------

async function requestGeminiForecast(apiKey, input, baseline) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(GEMINI_GENERATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildPrompt(input, baseline) }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              sentimentMultiplier: { type: 'NUMBER' },
              discountProbability: { type: 'NUMBER' },
              priceDrift: { type: 'NUMBER' },
              rationale: { type: 'STRING' }
            },
            required: ['sentimentMultiplier', 'discountProbability']
          }
        }
      }),
      signal: controller.signal
    });

    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new Error(`Gemini rejected the API key (HTTP ${res.status})`);
    }
    if (res.status === 429) throw new Error('Gemini quota exceeded (HTTP 429)');
    if (!res.ok) throw new Error(`Gemini request failed (HTTP ${res.status})`);

    const body = await res.json();
    const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    return parseForecast(text);
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('Gemini request timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse and sanitise the model's JSON answer.
 * @param {string} text
 */
export function parseForecast(text) {
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Gemini returned no JSON');
  let raw;
  try {
    raw = JSON.parse(match[0]);
  } catch {
    throw new Error('Gemini returned malformed JSON');
  }
  const sentiment = Number(raw.sentimentMultiplier);
  const probability = Number(raw.discountProbability);
  if (!Number.isFinite(sentiment) || !Number.isFinite(probability)) {
    throw new Error('Gemini response missing required fields');
  }
  const drift = Number(raw.priceDrift);
  return {
    sentimentMultiplier: clamp(sentiment, 0.85, 1.15),
    // Tolerate answers given as percentages (e.g. 35 instead of 0.35).
    discountProbability: clamp(probability > 1 ? probability / 100 : probability, 0, 1),
    priceDrift: Number.isFinite(drift) ? clamp(drift, -0.15, 0.15) : undefined,
    rationale: typeof raw.rationale === 'string' ? raw.rationale.slice(0, 240) : ''
  };
}

function buildPrompt(input, baseline) {
  const { signals = {} } = input;
  const facts = {
    title: input.title || undefined,
    category: input.category || signals.category || undefined,
    currentPriceUsd: input.price,
    listPriceUsd: input.listPrice || signals.listPrice,
    typicalPriceUsd: signals.avgPrice,
    lowPriceUsd: signals.lowPrice,
    highPriceUsd: signals.highPrice,
    rating: signals.rating,
    reviewCount: signals.reviewCount,
    boughtPastMonth: signals.boughtPastMonth,
    estimatedMonthlyVolatility: input.volatility,
    todayIso: (input.now || new Date()).toISOString().slice(0, 10),
    upcomingSeasonalEvent: baseline.event || undefined
  };
  return [
    'You are a retail price-forecasting model for Amazon.com products.',
    'Given the facts below, forecast the next 30 days and answer ONLY with JSON:',
    '- sentimentMultiplier: number 0.85-1.15 (below 1 = price expected to fall, above 1 = expected to rise).',
    '- discountProbability: number 0-1, chance of a notable discount in the next 30 days.',
    '- priceDrift: number -0.15..0.15, expected fractional change of the fair price over 30 days (e.g. -0.06 = 6% drop).',
    '- rationale: one short sentence.',
    `Facts: ${JSON.stringify(facts)}`
  ].join('\n');
}

/**
 * Validate a Gemini key without spending generation quota.
 * @param {string} apiKey
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function testGeminiConnection(apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${GEMINI_MODELS_URL}?pageSize=1`, {
      headers: { 'x-goog-api-key': apiKey },
      signal: controller.signal
    });
    if (res.ok) return { ok: true, message: 'Connected — API key accepted' };
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return { ok: false, message: `API key rejected (HTTP ${res.status})` };
    }
    return { ok: false, message: `Unexpected response (HTTP ${res.status})` };
  } catch (err) {
    return { ok: false, message: err && err.name === 'AbortError' ? 'Request timed out' : 'Network error — endpoint unreachable' };
  } finally {
    clearTimeout(timer);
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
    keyStatus: 'pending',
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

// ---------------------------------------------------------------------------
// Prediction cache
// ---------------------------------------------------------------------------

async function readPredictionCache(key) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.PREDICTION_CACHE);
  const entry = (data[STORAGE_KEYS.PREDICTION_CACHE] || {})[key];
  return entry && Date.now() - entry.at < PREDICTION_CACHE_TTL_MS ? entry.value : null;
}

async function writePredictionCache(key, value) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.PREDICTION_CACHE);
  let cache = data[STORAGE_KEYS.PREDICTION_CACHE] || {};
  cache[key] = { at: Date.now(), value };
  const entries = Object.entries(cache);
  if (entries.length > CACHE_MAX_ENTRIES) {
    entries.sort((a, b) => b[1].at - a[1].at);
    cache = Object.fromEntries(entries.slice(0, CACHE_MAX_ENTRIES));
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.PREDICTION_CACHE]: cache });
}
