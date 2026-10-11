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

/**
 * Gemini prediction markets (gemini.com). The market-data endpoints are public
 * and need no API key.
 * Docs: https://developer.gemini.com/prediction-markets-spec/markets
 */
export const GEMINI_MARKETS_BASE = 'https://api.gemini.com/v1/prediction-markets';

/** chrome.storage.local keys. */
export const STORAGE_KEYS = Object.freeze({
  CONTEXT_KEY: 'context_dev_api_key',
  CONTEXT_CACHE: 'context_cache',
  MACRO_CACHE: 'gemini_macro_cache',
  SHOW_PRODUCT_CARD: 'show_product_card',
  SHOW_SEARCH_CHIPS: 'show_search_chips',
  LAST_ANALYSIS: 'last_analysis',
  ANALYSIS_COUNT: 'analysis_count'
});

/** context.dev responses are cached per ASIN for 24 hours to preserve credits. */
export const CONTEXT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Failed lookups are remembered briefly so a flaky API is not hammered. */
export const CONTEXT_ERROR_TTL_MS = 15 * 60 * 1000;
/** Macro odds from Gemini markets move slowly; refresh at most every 3 hours. */
export const MACRO_CACHE_TTL_MS = 3 * 60 * 60 * 1000;
/** If Gemini markets is unreachable, reuse a cached reading up to this old. */
export const MACRO_STALE_MAX_MS = 24 * 60 * 60 * 1000;
/** Max ASIN entries kept in the context cache. */
export const CACHE_MAX_ENTRIES = 200;

/** Message types exchanged between content script / popup / options and the service worker. */
export const MSG = Object.freeze({
  ANALYZE_PRODUCT: 'PO_ANALYZE_PRODUCT',
  GET_STATUS: 'PO_GET_STATUS',
  TEST_CONNECTION: 'PO_TEST_CONNECTION',
  OPEN_OPTIONS: 'PO_OPEN_OPTIONS',
  CLEAR_CACHE: 'PO_CLEAR_CACHE'
});
