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
  MACRO_BACKOFF: 'gemini_macro_backoff',
  SHOW_PRODUCT_CARD: 'show_product_card',
  SHOW_SEARCH_CHIPS: 'show_search_chips',
  PRICE_HISTORY: 'price_history',
  CONTEXT_PAUSE: 'context_pause',
  LAST_ANALYSIS: 'last_analysis',
  RECENT_ANALYSES: 'recent_analyses',
  ANALYSIS_COUNT: 'analysis_count',
  PRICE_ALERTS: 'price_alerts',
  ALERT_EMAIL: 'alert_email',
  ALERT_BACKGROUND: 'alert_background_checks'
});

/** context.dev responses are cached per ASIN for 24 hours to preserve credits. */
export const CONTEXT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Failed lookups are remembered briefly so a flaky API is not hammered. */
export const CONTEXT_ERROR_TTL_MS = 15 * 60 * 1000;
/** After a key or quota failure, context.dev is not called again for this long. */
export const CONTEXT_PAUSE_MS = 30 * 60 * 1000;
/** Macro odds from Gemini markets move slowly; refresh at most every 3 hours. */
export const MACRO_CACHE_TTL_MS = 3 * 60 * 60 * 1000;
/** After a failed Gemini markets request, do not try again for this long (falls back instantly). */
export const MACRO_BACKOFF_MS = 5 * 60 * 1000;
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
  CLEAR_CACHE: 'PO_CLEAR_CACHE',
  CLEAR_HISTORY: 'PO_CLEAR_HISTORY',
  ALERT_STATE: 'PO_ALERT_STATE',
  ALERT_CREATE: 'PO_ALERT_CREATE',
  ALERT_UPDATE: 'PO_ALERT_UPDATE',
  ALERT_REMOVE: 'PO_ALERT_REMOVE',
  ALERT_LIST: 'PO_ALERT_LIST',
  ALERT_TEST_NOTIFICATION: 'PO_ALERT_TEST_NOTIFICATION'
});

/**
 * Price alerts are stored on this device (chrome.storage.local, key PRICE_ALERTS). There is no account, no
 * sign-in and no server. The extension alerts the user itself (notification, toolbar badge, product card), and
 * a content script shows the same alerts on the PriceOracle website's alerts page. See docs/ALERTS_INTEGRATION.md.
 */
export const SITE_ALERTS_URL = 'https://xylm-306e6.web.app/alerts/';

/** Background price checks run on this alarm. */
export const ALERT_CHECK_ALARM = 'po-alert-check';
export const ALERT_CHECK_MINUTES = 60;
/** An alert is not re-checked in the background more often than this (each check is one context.dev credit). */
export const ALERT_RECHECK_MS = 4 * 60 * 60 * 1000;
/** At most this many alerts are checked per alarm, so a long list cannot drain credits at once. */
export const ALERT_CHECK_BATCH = 5;
