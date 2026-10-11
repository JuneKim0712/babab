/**
 * context.dev API client.
 *
 * Calls `POST https://api.context.dev/v1/web/scrape` (the live equivalent of the
 * `/v1/extract` endpoint in the original brief, which does not exist) for an
 * Amazon product URL, requesting the `json` and `markdown` outputs, and distils
 * the response into a flat set of pricing "signals" the projection engine can
 * use. Results are cached for 24 hours in chrome.storage.local, indexed by ASIN,
 * to preserve API credits (a json+markdown scrape costs about 5 credits).
 *
 * Amazon pages rarely expose price history, so any signal may be missing;
 * parsing is deliberately defensive: it reads the schema-shaped JSON output and
 * falls back to regexes over the markdown.
 */
import {
  CACHE_MAX_ENTRIES,
  CONTEXT_CACHE_TTL_MS,
  CONTEXT_DEV_AUTH_CHECK_URL,
  CONTEXT_DEV_ENDPOINT,
  CONTEXT_ERROR_TTL_MS,
  DEFAULT_CONTEXT_DEV_KEY,
  STORAGE_KEYS
} from '../shared/constants.js';

const REQUEST_TIMEOUT_MS = 60000;

/** JSON Schema describing the pricing facts we want context.dev to extract. */
const PRICING_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    category: { type: 'string', description: 'Department breadcrumb, e.g. "Electronics > Headphones".' },
    currentPrice: { type: ['number', 'null'], description: 'Current buy-box price in USD as a plain number.' },
    listPrice: { type: ['number', 'null'], description: 'Strike-through, list or typical price in USD.' },
    lowestPrice: { type: ['number', 'null'], description: 'Lowest recent price in USD if the page shows one (e.g. 30-day low).' },
    averagePrice: { type: ['number', 'null'], description: 'Average or typical price in USD if the page shows one.' },
    highestPrice: { type: ['number', 'null'], description: 'Highest recent price in USD if the page shows one.' },
    discountPercent: { type: ['number', 'null'], description: 'Advertised discount percentage.' },
    rating: { type: ['number', 'null'] },
    reviewCount: { type: ['integer', 'null'] },
    boughtPastMonth: { type: ['integer', 'null'], description: 'Units bought in the past month, e.g. 10000 for "10K+ bought".' },
    availability: { type: ['string', 'null'] }
  },
  additionalProperties: false
};
const PRICING_INSTRUCTIONS = 'Extract pricing signals for the product. Use null for anything not shown on the page; never guess.';

/**
 * Resolve the context.dev key: user-saved value first, shipped default otherwise.
 * @returns {Promise<{key: string, isDefault: boolean}>}
 */
export async function getContextDevKey() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.CONTEXT_KEY);
  const custom = (stored[STORAGE_KEYS.CONTEXT_KEY] || '').trim();
  return custom
    ? { key: custom, isDefault: custom === DEFAULT_CONTEXT_DEV_KEY }
    : { key: DEFAULT_CONTEXT_DEV_KEY, isDefault: true };
}

/**
 * Fetch (or load from cache) context signals for an ASIN.
 *
 * @param {string} asin
 * @param {{forceRefresh?: boolean}} [options]
 * @returns {Promise<ContextResult>}
 *
 * @typedef {Object} ContextResult
 * @property {'connected'|'cached'|'error'} status
 * @property {boolean} fromCache
 * @property {number|null} fetchedAt
 * @property {ContextSignals} signals   Empty object when unavailable.
 * @property {string} [error]
 *
 * @typedef {Object} ContextSignals
 * @property {number} [listPrice]      Strike-through / typical list price.
 * @property {number} [currentPrice]
 * @property {number} [avgPrice]       Average or "typical" price.
 * @property {number} [lowPrice]       Lowest observed price (e.g. 30/90 day low).
 * @property {number} [highPrice]      Highest observed price.
 * @property {number} [discountPct]    Advertised discount percent.
 * @property {number} [rating]
 * @property {number} [reviewCount]
 * @property {number} [boughtPastMonth]
 * @property {string} [category]
 * @property {string} [availability]
 */
export async function fetchProductContext(asin, { forceRefresh = false } = {}) {
  const cache = await readCache();
  const entry = cache[asin];

  if (!forceRefresh && entry) {
    const age = Date.now() - entry.fetchedAt;
    if (!entry.error && age < CONTEXT_CACHE_TTL_MS) {
      return { status: 'cached', fromCache: true, fetchedAt: entry.fetchedAt, signals: entry.signals };
    }
    if (entry.error && age < CONTEXT_ERROR_TTL_MS) {
      return { status: 'error', fromCache: true, fetchedAt: entry.fetchedAt, signals: {}, error: entry.error };
    }
  }

  try {
    const { key } = await getContextDevKey();
    const payload = await requestExtract(`https://www.amazon.com/dp/${asin}`, key);
    const signals = extractSignals(payload);
    const fetchedAt = Date.now();
    cache[asin] = { fetchedAt, signals };
    await writeCache(cache);
    return { status: 'connected', fromCache: false, fetchedAt, signals };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const fetchedAt = Date.now();
    // Keep a stale-but-valid cache entry rather than overwriting it with an error.
    if (entry && !entry.error) {
      return { status: 'cached', fromCache: true, fetchedAt: entry.fetchedAt, signals: entry.signals, error: message };
    }
    cache[asin] = { fetchedAt, signals: {}, error: message };
    await writeCache(cache);
    return { status: 'error', fromCache: false, fetchedAt, signals: {}, error: message };
  }
}

/**
 * POST to the extract endpoint.
 * @param {string} url Page to extract.
 * @param {string} apiKey Bearer token.
 * @returns {Promise<any>} Parsed response body.
 */
async function requestExtract(url, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(CONTEXT_DEV_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        url,
        formats: { json: true, markdown: true },
        jsonParams: { schema: PRICING_SCHEMA, instructions: PRICING_INSTRUCTIONS },
        maxAgeMs: CONTEXT_CACHE_TTL_MS
      }),
      signal: controller.signal
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`context.dev rejected the API key (HTTP ${res.status})`);
    }
    if (res.status === 402 || res.status === 429) {
      throw new Error(`context.dev quota or rate limit reached (HTTP ${res.status})`);
    }
    if (!res.ok) {
      throw new Error(`context.dev request failed (HTTP ${res.status})`);
    }
    return unwrapScrapeResponse(await res.json());
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('context.dev request timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The scrape API wraps each output as `{requested, success, data, error_code?, message?}`.
 * Flatten it to `{json, markdown}` and fail only when no requested output succeeded.
 * Plain `{json, markdown}` payloads pass through unchanged.
 * @param {any} body
 * @returns {{json: any, markdown: string}}
 */
export function unwrapScrapeResponse(body) {
  const out = (key) => {
    const part = body?.[key];
    if (part && typeof part === 'object' && 'success' in part) return part.success ? part.data : null;
    return part ?? null;
  };
  const json = out('json');
  const markdown = out('markdown');
  if (json == null && markdown == null) {
    const failed = ['json', 'markdown'].map((k) => body?.[k]).find((p) => p && p.success === false);
    const detail = failed ? `${failed.message || failed.error_code || 'extraction failed'}` : 'empty response';
    throw new Error(`context.dev could not read the product page (${detail})`);
  }
  return { json, markdown: typeof markdown === 'string' ? markdown : '' };
}

/**
 * Reachability/auth check used by "Test Connection". Uses a credit-free
 * authenticated endpoint, so testing never spends scrape credits.
 * @param {string} apiKey
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function testContextDevConnection(apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(CONTEXT_DEV_AUTH_CHECK_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: `API key rejected (HTTP ${res.status})` };
    }
    if (!res.ok) return { ok: false, message: `Unexpected response (HTTP ${res.status})` };
    const remaining = (await res.json().catch(() => null))?.key_metadata?.credits_remaining;
    return {
      ok: true,
      message: Number.isFinite(remaining)
        ? `Connected — API key accepted (${remaining.toLocaleString('en-US')} credits remaining)`
        : 'Connected — API key accepted'
    };
  } catch (err) {
    return { ok: false, message: err && err.name === 'AbortError' ? 'Request timed out' : 'Network error — endpoint unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Signal extraction
// ---------------------------------------------------------------------------

/** Key-name patterns searched (case-insensitive) in the structured JSON. */
const JSON_KEY_PATTERNS = {
  listPrice: /^(list[_\s-]?price|original[_\s-]?price|was[_\s-]?price|msrp|regular[_\s-]?price|strike[_\s-]?price|typical[_\s-]?price)$/i,
  currentPrice: /^(price|current[_\s-]?price|sale[_\s-]?price|deal[_\s-]?price|buy[_\s-]?box[_\s-]?price)$/i,
  avgPrice: /^(avg|average|mean|median|typical)[_\s-]?(price)?$/i,
  lowPrice: /^((lowest|low|min|minimum)[_\s-]?(price)?(_?(30|60|90)d(ay)?s?)?|price[_\s-]?low|all[_\s-]?time[_\s-]?low)$/i,
  highPrice: /^((highest|high|max|maximum)[_\s-]?(price)?|price[_\s-]?high)$/i,
  discountPct: /^(discount|discount[_\s-]?(percent|percentage|pct)|savings[_\s-]?(percent|percentage|pct))$/i,
  rating: /^(rating|average[_\s-]?rating|stars|review[_\s-]?score)$/i,
  reviewCount: /^(review[_\s-]?count|reviews|num[_\s-]?reviews|ratings[_\s-]?count|total[_\s-]?reviews|rating[_\s-]?count)$/i,
  boughtPastMonth: /^(bought[_\s-]?past[_\s-]?month|units[_\s-]?sold[_\s-]?month)$/i,
  category: /^(category|product[_\s-]?category|breadcrumb|department)$/i,
  availability: /^(availability|stock|stock[_\s-]?status)$/i
};

/**
 * Turn a raw extract response into normalised pricing signals.
 * @param {any} payload
 * @returns {ContextSignals}
 */
export function extractSignals(payload) {
  const signals = {};
  const root = payload && typeof payload === 'object' ? payload : {};
  const jsonPart = root.json ?? root.data?.json ?? root.data ?? root.result ?? root;
  const markdown = pickString(root.markdown ?? root.data?.markdown ?? root.result?.markdown);

  // 1) Structured JSON
  walk(jsonPart, (key, value) => {
    for (const [field, pattern] of Object.entries(JSON_KEY_PATTERNS)) {
      if (signals[field] !== undefined || !pattern.test(key)) continue;
      const parsed = toFieldValue(field, value);
      if (parsed !== undefined) signals[field] = parsed;
    }
  });

  // 2) Markdown fallbacks
  if (markdown) mergeMissing(signals, signalsFromMarkdown(markdown));

  // 3) Sanity-check relationships
  for (const field of ['listPrice', 'currentPrice', 'avgPrice', 'lowPrice', 'highPrice']) {
    if (!(signals[field] > 0)) delete signals[field];
  }
  if (signals.listPrice && signals.currentPrice && signals.listPrice < signals.currentPrice) {
    delete signals.listPrice; // a "list price" under the current price is not a strike-through
  }
  if (signals.lowPrice && signals.highPrice && signals.lowPrice > signals.highPrice) {
    [signals.lowPrice, signals.highPrice] = [signals.highPrice, signals.lowPrice];
  }
  if (signals.rating && (signals.rating < 0 || signals.rating > 5)) delete signals.rating;
  if (signals.discountPct !== undefined && (signals.discountPct < 0 || signals.discountPct > 95)) {
    delete signals.discountPct;
  }
  return signals;
}

/**
 * Pull pricing hints out of free-form markdown.
 * @param {string} md
 * @returns {ContextSignals}
 */
export function signalsFromMarkdown(md) {
  const out = {};
  const money = '\\$\\s?([\\d,]+(?:\\.\\d{1,2})?)';
  const grab = (re) => {
    const m = md.match(re);
    return m ? parseMoney(m[1]) : undefined;
  };

  out.listPrice = grab(new RegExp(`(?:list|typical|was|original|regular)\\s*price[^$\\n]{0,24}${money}`, 'i'));
  out.lowPrice = grab(new RegExp(`(?:lowest|low)\\s*price[^$\\n]{0,48}${money}`, 'i'));
  out.avgPrice = grab(new RegExp(`(?:average|avg)\\s*price[^$\\n]{0,32}${money}`, 'i'));
  out.highPrice = grab(new RegExp(`(?:highest|high)\\s*price[^$\\n]{0,48}${money}`, 'i'));
  out.currentPrice = grab(new RegExp(`(?:^|\\n)\\s*(?:price|deal of the day|with \\d+ percent savings)[^$\\d\\n]{0,24}${money}`, 'i'));

  const off = md.match(/(\d{1,2})\s?%\s*(?:off|savings)/i) || md.match(/(?:^|\s)-(\d{1,2})\s?%/);
  if (off) out.discountPct = Number(off[1]);

  const rating = md.match(/(\d(?:\.\d)?)\s*out of 5/i);
  if (rating) out.rating = Number(rating[1]);

  const reviews = md.match(/([\d,]+)\s+(?:global\s+)?ratings?/i);
  if (reviews) out.reviewCount = parseInt(reviews[1].replace(/,/g, ''), 10);

  const bought = md.match(/([\d,.]+)\s*([kK])?\+?\s+bought in past month/i);
  if (bought) {
    const base = parseFloat(bought[1].replace(/,/g, ''));
    out.boughtPastMonth = Math.round(bought[2] ? base * 1000 : base);
  }

  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** Depth-first walk over objects/arrays calling `visit(key, value)` for each property. */
function walk(node, visit, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return;
  if (Array.isArray(node)) {
    for (const item of node.slice(0, 50)) walk(item, visit, depth + 1);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    visit(key, value);
    if (value && typeof value === 'object') walk(value, visit, depth + 1);
  }
}

function toFieldValue(field, value) {
  switch (field) {
    case 'category':
    case 'availability': {
      if (Array.isArray(value)) value = value.filter((v) => typeof v === 'string').join(' > ');
      return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : undefined;
    }
    case 'boughtPastMonth':
    case 'reviewCount': {
      const n = typeof value === 'number' ? value : parseInt(String(value).replace(/[^\d]/g, ''), 10);
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    }
    case 'rating':
    case 'discountPct': {
      const n = typeof value === 'number' ? value : parseFloat(String(value).replace(/[^\d.]/g, ''));
      return Number.isFinite(n) ? n : undefined;
    }
    default: {
      // Price-like fields; allow {amount, currency} objects.
      if (value && typeof value === 'object' && 'amount' in value) value = value.amount;
      const n = typeof value === 'number' ? value : parseMoney(value);
      return Number.isFinite(n) ? n : undefined;
    }
  }
}

/** Parse "$1,299.00" / "1299" into a number, or undefined. */
function parseMoney(raw) {
  if (typeof raw === 'number') return raw;
  if (typeof raw !== 'string') return undefined;
  const m = raw.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : undefined;
}

function pickString(v) {
  return typeof v === 'string' ? v : '';
}

function mergeMissing(target, source) {
  for (const [k, v] of Object.entries(source)) {
    if (target[k] === undefined && v !== undefined) target[k] = v;
  }
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

async function readCache() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.CONTEXT_CACHE);
  return data[STORAGE_KEYS.CONTEXT_CACHE] || {};
}

async function writeCache(cache) {
  const entries = Object.entries(cache);
  if (entries.length > CACHE_MAX_ENTRIES) {
    entries.sort((a, b) => b[1].fetchedAt - a[1].fetchedAt);
    cache = Object.fromEntries(entries.slice(0, CACHE_MAX_ENTRIES));
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.CONTEXT_CACHE]: cache });
}

/** Number of ASINs with a valid (non-error) cache entry. */
export async function countCachedProducts() {
  const cache = await readCache();
  return Object.values(cache).filter((e) => !e.error && Date.now() - e.fetchedAt < CONTEXT_CACHE_TTL_MS).length;
}

/** Remove every cached context.dev response. */
export async function clearContextCache() {
  await chrome.storage.local.remove(STORAGE_KEYS.CONTEXT_CACHE);
}
