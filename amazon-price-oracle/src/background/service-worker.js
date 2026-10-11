/**
 * PriceOracle service worker (Manifest V3, ES module).
 *
 * Responsibilities:
 *  - Message router for the content script, popup and options page.
 *  - All cross-origin traffic (context.dev, Gemini markets) so pages never hit CORS.
 *  - Orchestrates: context.dev signals -> volatility -> Gemini-markets/heuristic
 *    prediction -> 5-tier projection, and persists the last result for the popup.
 *  - Two analysis depths: full (product pages, spends context.dev credits) and
 *    light (search results: cached context.dev data only, no credits).
 *
 * The worker keeps no in-memory state that matters across restarts; everything
 * durable lives in chrome.storage.local.
 */
import { MSG, STORAGE_KEYS, DEFAULT_CONTEXT_DEV_KEY } from '../shared/constants.js';
import {
  clearContextCache,
  clearContextPause,
  countCachedProducts,
  fetchProductContext,
  getContextDevKey,
  testContextDevConnection
} from './context-dev.js';
import { getPrediction, testGeminiConnection } from './gemini-prediction.js';
import { addRecent } from './recent.js';
import { clearPriceHistory, countTrackedProducts, historySignals, recordPrice } from './price-history.js';
import { computeProjection, estimateVolatility } from './projection-engine.js';

/** In-flight analyses keyed by ASIN+price so concurrent renders share one request. */
const inflight = new Map();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  handleMessage(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  return true; // keep the channel open for the async response
});

chrome.runtime.onInstalled.addListener((details) => {
  // The optional Gemini API key was removed; delete any key saved by older versions.
  chrome.storage.local.remove('gemini_api_key');
  if (details.reason === 'update') {
    // Tabs opened before an update still run the previous (now orphaned) scripts.
    injectIntoOpenAmazonTabs();
    return;
  }
  if (details.reason !== 'install') return;
  chrome.storage.local.set({ [STORAGE_KEYS.ANALYSIS_COUNT]: 0 });
  chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome/welcome.html') });
  injectIntoOpenAmazonTabs();
});

/**
 * Chrome does not run content scripts in tabs that were already open when the
 * extension was installed. Inject them now so the widget works without a reload.
 */
async function injectIntoOpenAmazonTabs() {
  try {
    const manifest = chrome.runtime.getManifest();
    const files = manifest.content_scripts?.[0]?.js || [];
    const tabs = await chrome.tabs.query({ url: ['https://www.amazon.com/*', 'https://amazon.com/*'] });
    await Promise.allSettled(
      tabs.filter((t) => t.id !== undefined).map((t) => chrome.scripting.executeScript({ target: { tabId: t.id }, files }))
    );
  } catch (err) {
    console.warn('PriceOracle: could not inject into open tabs', err);
  }
}

/**
 * @param {{type: string, [k: string]: any}} message
 * @returns {Promise<any>}
 */
async function handleMessage(message) {
  switch (message.type) {
    case MSG.ANALYZE_PRODUCT:
      return analyzeProduct(message.payload);
    case MSG.GET_STATUS:
      return getStatus();
    case MSG.TEST_CONNECTION:
      return testConnections(message.keys || {});
    case MSG.OPEN_OPTIONS:
      await chrome.runtime.openOptionsPage();
      return true;
    case MSG.CLEAR_HISTORY:
      await clearPriceHistory();
      return true;
    case MSG.CLEAR_CACHE:
      await clearContextCache();
      await chrome.storage.local.remove([STORAGE_KEYS.MACRO_CACHE, STORAGE_KEYS.MACRO_BACKOFF]);
      return true;
    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}

/**
 * Run the full analysis pipeline for one product.
 *
 * @param {Object} page Data scraped by the content script.
 * @param {string} page.asin
 * @param {number} page.price
 * @param {number} [page.listPrice]
 * @param {string} [page.title]
 * @param {string} [page.category]
 * @param {boolean} [page.forceRefresh]
 * @param {boolean} [page.light]  Search-result mode: use cached context.dev data only (no credits).
 */
async function analyzeProduct(page) {
  const asin = String(page?.asin || '').toUpperCase();
  const price = Number(page?.price);
  if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error('Invalid ASIN');
  if (!(price > 0)) throw new Error('Could not read a valid price');

  const key = `${asin}:${price}:${page.forceRefresh ? 'f' : ''}${page.light ? 'l' : ''}`;
  if (inflight.has(key)) return inflight.get(key);

  const job = runPipeline({ ...page, asin, price }).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function runPipeline(page) {
  const light = Boolean(page.light);
  const context = await fetchProductContext(page.asin, {
    forceRefresh: !light && Boolean(page.forceRefresh),
    cacheOnly: light
  });
  // Prices this browser has seen before. context.dev data wins; history only fills gaps.
  const history = await recordPrice(page.asin, page.price).catch(() => null);
  const signals = { ...historySignals(history), ...context.signals };

  const volatility = estimateVolatility({
    category: page.category,
    title: page.title,
    price: page.price,
    listPrice: page.listPrice,
    signals
  });

  const prediction = await getPrediction({
    asin: page.asin,
    price: page.price,
    listPrice: page.listPrice,
    title: page.title,
    category: page.category,
    volatility,
    signals
  });

  const signalCount = Object.keys(signals).length;
  const projection = computeProjection({
    currentPrice: page.price,
    volatility,
    discountProbability: prediction.discountProbability,
    sentimentMultiplier: prediction.sentimentMultiplier,
    priceDrift: prediction.priceDrift,
    quality: {
      hasContext: context.status === 'connected' || context.status === 'cached',
      signalCount,
      isSimulated: prediction.isSimulated
    }
  });

  const result = {
    asin: page.asin,
    title: page.title || '',
    light,
    projection,
    meta: {
      history: history && history.count >= 2 ? history : null,
      context: {
        status: context.status,
        fromCache: context.fromCache,
        fetchedAt: context.fetchedAt,
        signalCount,
        error: context.error
      },
      gemini: {
        status: prediction.marketsStatus,
        isSimulated: prediction.isSimulated,
        source: prediction.source,
        rationale: prediction.rationale,
        summary: prediction.macro?.summary || '',
        stale: Boolean(prediction.macro?.stale),
        sentimentMultiplier: prediction.sentimentMultiplier,
        discountProbability: prediction.discountProbability,
        error: prediction.error
      }
    }
  };

  if (!light) await recordLastAnalysis(result);
  return result;
}

async function recordLastAnalysis(result) {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.ANALYSIS_COUNT, STORAGE_KEYS.RECENT_ANALYSES]);
  const count = stored[STORAGE_KEYS.ANALYSIS_COUNT] || 0;
  const entry = {
    at: Date.now(),
    asin: result.asin,
    title: result.title,
    currentPrice: result.projection.currentPrice,
    deltaPercentMonth: result.projection.deltaPercentMonth,
    action: result.projection.recommendation.action,
    label: result.projection.recommendation.label
  };
  await chrome.storage.local.set({
    [STORAGE_KEYS.RECENT_ANALYSES]: addRecent(stored[STORAGE_KEYS.RECENT_ANALYSES] || [], entry),
    [STORAGE_KEYS.LAST_ANALYSIS]: {
      at: Date.now(),
      asin: result.asin,
      title: result.title,
      currentPrice: result.projection.currentPrice,
      projectedMid: result.projection.projectedMid,
      deltaPercentMonth: result.projection.deltaPercentMonth,
      deltaAmount: result.projection.deltaAmount,
      action: result.projection.recommendation.action,
      label: result.projection.recommendation.label,
      confidence: result.projection.confidence,
      isSimulated: result.meta.gemini.isSimulated,
      geminiStatus: result.meta.gemini.status
    },
    [STORAGE_KEYS.ANALYSIS_COUNT]: count + 1
  });
}

/** Snapshot used by the popup. Never exposes the key value itself. */
async function getStatus() {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.LAST_ANALYSIS, STORAGE_KEYS.ANALYSIS_COUNT, STORAGE_KEYS.RECENT_ANALYSES]);
  const contextKey = await getContextDevKey();
  return {
    contextKeySet: Boolean(contextKey.key),
    usingDefaultContextKey: contextKey.isDefault,
    cachedProducts: await countCachedProducts(),
    trackedProducts: await countTrackedProducts(),
    analysisCount: stored[STORAGE_KEYS.ANALYSIS_COUNT] || 0,
    lastAnalysis: stored[STORAGE_KEYS.LAST_ANALYSIS] || null,
    recent: stored[STORAGE_KEYS.RECENT_ANALYSES] || []
  };
}

/**
 * Validate API reachability. Uses the key from the options form when supplied
 * (so users can test before saving), otherwise the stored one.
 * @param {{contextDev?: string}} keys
 */
async function testConnections(keys) {
  const contextKey = (keys.contextDev || '').trim() || (await getContextDevKey()).key || DEFAULT_CONTEXT_DEV_KEY;
  const [contextDev, gemini] = await Promise.all([testContextDevConnection(contextKey), testGeminiConnection()]);
  if (contextDev.ok) await clearContextPause();
  return { contextDev, gemini };
}
