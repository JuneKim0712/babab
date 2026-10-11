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
  ACCOUNT_SESSION: 'account_session',
  ACCOUNT_MARKER: 'account_marker'
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
  ACCOUNT_STATUS: 'PO_ACCOUNT_STATUS',
  ACCOUNT_SIGN_IN: 'PO_ACCOUNT_SIGN_IN',
  ACCOUNT_SIGN_OUT: 'PO_ACCOUNT_SIGN_OUT',
  ALERT_STATE: 'PO_ALERT_STATE',
  ALERT_CREATE: 'PO_ALERT_CREATE',
  ALERT_UPDATE: 'PO_ALERT_UPDATE',
  ALERT_REMOVE: 'PO_ALERT_REMOVE'
});

/**
 * PriceOracle alerts live on the website's Firebase project (xylm-306e6). The extension signs in with
 * Google, exchanges the Google ID token for a Firebase ID token (Identity Toolkit REST, no SDK), and calls
 * the site's HTTP API from the service worker. Never write to Firestore directly. See
 * docs/ALERTS_INTEGRATION.md.
 */
export const API_BASE = 'https://xylm-306e6.web.app';
/** Firebase web API key (public by design; served at /__/firebase/init.json on the hosting site). */
export const FIREBASE_API_KEY = 'AIzaSyDj97uXv2ETmA-FvwGRV0-_Tn686d2E6L8';
/** The Google OAuth web client Firebase Auth created for the project (found via accounts:createAuthUri). */
export const GOOGLE_OAUTH_CLIENT_ID = '754413445676-dsqaqjdq1r5mpla7or2mlgjkg4cnf97m.apps.googleusercontent.com';
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const IDENTITY_TOOLKIT_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp';
export const SECURE_TOKEN_URL = 'https://securetoken.googleapis.com/v1/token';
/** Normal alert API calls. */
export const API_TIMEOUT_MS = 20000;
/** The first lookup of a product can take 13-47 s on the server; allow well over a minute. */
export const CREATE_ALERT_TIMEOUT_MS = 75000;
/** Refresh the Firebase ID token this long before it expires. */
export const TOKEN_REFRESH_MARGIN_MS = 2 * 60 * 1000;
