/**
 * PriceOracle service worker (Manifest V3, ES module).
 *
 * Responsibilities:
 *  - Message router for the content script, popup and options page.
 *  - All cross-origin traffic (context.dev, Gemini) so pages never hit CORS.
 *  - Orchestrates: context.dev signals -> volatility -> Gemini/heuristic
 *    prediction -> 5-tier projection, and persists the last result for the popup.
 *
 * The worker keeps no in-memory state that matters across restarts; everything
 * durable lives in chrome.storage.local.
 */
import { MSG, STORAGE_KEYS, DEFAULT_CONTEXT_DEV_KEY } from '../shared/constants.js';
import {
  clearContextCache,
  countCachedProducts,
  fetchProductContext,
  getContextDevKey,
  testContextDevConnection
} from './context-dev.js';
import { getPrediction, testGeminiConnection } from './gemini-prediction.js';
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
  if (details.reason === 'install') {
    chrome.storage.local.set({ [STORAGE_KEYS.ANALYSIS_COUNT]: 0 });
  }
});

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
    case MSG.CLEAR_CACHE:
      await clearContextCache();
      await chrome.storage.local.remove(STORAGE_KEYS.PREDICTION_CACHE);
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
 */
async function analyzeProduct(page) {
  const asin = String(page?.asin || '').toUpperCase();
  const price = Number(page?.price);
  if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error('Invalid ASIN');
  if (!(price > 0)) throw new Error('Could not read a valid price');

  const key = `${asin}:${price}:${page.forceRefresh ? 'f' : ''}`;
  if (inflight.has(key)) return inflight.get(key);

  const job = runPipeline({ ...page, asin, price }).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function runPipeline(page) {
  const context = await fetchProductContext(page.asin, { forceRefresh: Boolean(page.forceRefresh) });
  const { signals } = context;

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
      hasContext: context.status !== 'error',
      signalCount,
      isSimulated: prediction.isSimulated
    }
  });

  const result = {
    asin: page.asin,
    title: page.title || '',
    projection,
    meta: {
      context: {
        status: context.status,
        fromCache: context.fromCache,
        fetchedAt: context.fetchedAt,
        signalCount,
        error: context.error
      },
      gemini: {
        keyStatus: prediction.keyStatus,
        isSimulated: prediction.isSimulated,
        source: prediction.source,
        rationale: prediction.rationale,
        sentimentMultiplier: prediction.sentimentMultiplier,
        discountProbability: prediction.discountProbability,
        error: prediction.error
      }
    }
  };

  await recordLastAnalysis(result);
  return result;
}

async function recordLastAnalysis(result) {
  const count = (await chrome.storage.local.get(STORAGE_KEYS.ANALYSIS_COUNT))[STORAGE_KEYS.ANALYSIS_COUNT] || 0;
  await chrome.storage.local.set({
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
      isSimulated: result.meta.gemini.isSimulated
    },
    [STORAGE_KEYS.ANALYSIS_COUNT]: count + 1
  });
}

/** Snapshot used by the popup. Never exposes the key values themselves. */
async function getStatus() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.GEMINI_KEY,
    STORAGE_KEYS.LAST_ANALYSIS,
    STORAGE_KEYS.ANALYSIS_COUNT
  ]);
  const contextKey = await getContextDevKey();
  return {
    geminiKeySet: Boolean((stored[STORAGE_KEYS.GEMINI_KEY] || '').trim()),
    contextKeySet: Boolean(contextKey.key),
    usingDefaultContextKey: contextKey.isDefault,
    cachedProducts: await countCachedProducts(),
    analysisCount: stored[STORAGE_KEYS.ANALYSIS_COUNT] || 0,
    lastAnalysis: stored[STORAGE_KEYS.LAST_ANALYSIS] || null
  };
}

/**
 * Validate API reachability. Uses keys from the options form when supplied
 * (so users can test before saving), otherwise the stored ones.
 * @param {{contextDev?: string, gemini?: string}} keys
 */
async function testConnections(keys) {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.GEMINI_KEY);
  const contextKey = (keys.contextDev || '').trim() || (await getContextDevKey()).key || DEFAULT_CONTEXT_DEV_KEY;
  const geminiKey = (keys.gemini || '').trim() || (stored[STORAGE_KEYS.GEMINI_KEY] || '').trim();

  const [contextDev, gemini] = await Promise.all([
    testContextDevConnection(contextKey),
    geminiKey
      ? testGeminiConnection(geminiKey)
      : Promise.resolve({ ok: false, skipped: true, message: 'No Gemini key set — running on heuristic model' })
  ]);
  return { contextDev, gemini };
}
