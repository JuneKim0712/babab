/**
 * Shared constants for every extension context that supports ES modules
 * (service worker, popup, options page). Content scripts are classic scripts
 * and never import this file.
 */

/** Default context.dev secret key shipped with the extension (user-overridable). */
export const DEFAULT_CONTEXT_DEV_KEY = 'ctxt_secret_7390b0f7f788470c85aa687254599803';

/**
 * context.dev scrape endpoint. The `/v1/extract` path from the original brief
 * returns ENDPOINT_NOT_FOUND; `/v1/web/scrape` is the documented equivalent that
 * returns `json` and `markdown` outputs for a URL.
 */
export const CONTEXT_DEV_ENDPOINT = 'https://api.context.dev/v1/web/scrape';
/** Free, authenticated endpoint used by "Test Connection" (consumes no credits). */
export const CONTEXT_DEV_AUTH_CHECK_URL = 'https://api.context.dev/v1/org/logs?limit=1';

/** Google Gemini (Generative Language) API used for the structured forecast. */
export const GEMINI_MODEL = 'gemini-2.0-flash';
export const GEMINI_GENERATE_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
export const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/** chrome.storage.local keys. */
export const STORAGE_KEYS = Object.freeze({
  GEMINI_KEY: 'gemini_api_key',
  CONTEXT_KEY: 'context_dev_api_key',
  CONTEXT_CACHE: 'context_cache',
  PREDICTION_CACHE: 'prediction_cache',
  LAST_ANALYSIS: 'last_analysis',
  ANALYSIS_COUNT: 'analysis_count'
});

/** context.dev responses are cached per ASIN for 24 hours to preserve credits. */
export const CONTEXT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Failed lookups are remembered briefly so a flaky API is not hammered. */
export const CONTEXT_ERROR_TTL_MS = 15 * 60 * 1000;
/** Gemini forecasts are cached for 6 hours per ASIN + price. */
export const PREDICTION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** Max ASIN entries kept in each cache. */
export const CACHE_MAX_ENTRIES = 200;

/** Message types exchanged between content script / popup / options and the service worker. */
export const MSG = Object.freeze({
  ANALYZE_PRODUCT: 'PO_ANALYZE_PRODUCT',
  GET_STATUS: 'PO_GET_STATUS',
  TEST_CONNECTION: 'PO_TEST_CONNECTION',
  OPEN_OPTIONS: 'PO_OPEN_OPTIONS',
  CLEAR_CACHE: 'PO_CLEAR_CACHE'
});
