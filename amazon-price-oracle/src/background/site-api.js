/**
 * Pure helpers for the website integration (no chrome.* and no fetch, so they are unit-tested).
 * The wire format is specified in docs/WEBSITE_INTEGRATION.md.
 */
import { SITE_CONNECT_PATH } from '../shared/constants.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Normalise the website address typed in Settings to an origin.
 * https is required, except for localhost during development.
 * @param {string} input
 * @returns {string} e.g. "https://baba.example.com"
 */
export function normalizeSiteUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('Enter your website address first.');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `${LOCAL_HOSTS.has(raw.split(/[/:]/)[0]) ? 'http' : 'https'}://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error('That does not look like a website address.');
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('The website address must start with https://');
  }
  if (!url.hostname.includes('.') && !local) throw new Error('That does not look like a website address.');
  return url.origin;
}

/**
 * URL of the website's sign-in bridge. The website signs the user in with Google, then redirects to
 * `redirectUri` with the session in the URL fragment.
 */
export function buildConnectUrl(siteUrl, redirectUri, state) {
  const url = new URL(SITE_CONNECT_PATH, siteUrl);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('client', 'priceoracle-extension');
  return url.toString();
}

/**
 * Read the session the website handed back. Accepts the fragment (preferred) or the query string.
 * @param {string} redirectUrl The final URL Chrome intercepted.
 * @param {string} expectedState The random value sent in buildConnectUrl.
 * @param {number} [now]
 * @returns {{token: string, email: string, name: string, expiresAt: number}}
 */
export function parseAuthRedirect(redirectUrl, expectedState, now = Date.now()) {
  if (!redirectUrl) throw new Error('Sign-in was cancelled.');
  const url = new URL(redirectUrl);
  const params = new URLSearchParams(url.hash.replace(/^#/, ''));
  for (const [k, v] of url.searchParams) if (!params.has(k)) params.set(k, v);

  if (params.get('error')) throw new Error(`The website refused sign-in: ${params.get('error_description') || params.get('error')}`);
  if (params.get('state') !== expectedState) throw new Error('Sign-in response did not match this request. Try again.');
  const token = params.get('access_token');
  if (!token) throw new Error('The website did not return an access token.');

  const expiresIn = Number(params.get('expires_in'));
  const ttlMs = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 24 * 60 * 60 * 1000;
  return { token, email: params.get('email') || '', name: params.get('name') || '', expiresAt: now + ttlMs };
}

/** @param {{expiresAt?: number}|null|undefined} session */
export const isSessionValid = (session, now = Date.now()) => Boolean(session?.token) && (session.expiresAt || 0) > now;

/**
 * Validate a target typed on the product page.
 * @returns {number} price rounded to cents
 */
export function validateTarget(value, currentPrice) {
  const n = Number(String(value ?? '').replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n <= 0) throw new Error('Enter a target price above $0.');
  const cents = Math.round(n * 100) / 100;
  if (cents < 0.01) throw new Error('Enter a target price above $0.');
  if (currentPrice > 0 && cents >= currentPrice) throw new Error('Pick a target below the current price.');
  return cents;
}

/** Body of `PUT /api/alerts/:asin`. */
export function buildAlertBody({ asin, title, currentPrice, targetPrice, enabled }) {
  return {
    asin,
    title: String(title || '').slice(0, 300),
    url: `https://www.amazon.com/dp/${asin}`,
    currency: 'USD',
    targetPrice,
    currentPrice,
    enabled: enabled !== false,
    source: 'extension'
  };
}

/**
 * Defensive read of an alert returned by the website.
 * @returns {{id: string, asin: string, targetPrice: number, enabled: boolean, title: string, triggeredAt: number|null}|null}
 */
export function normalizeAlert(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const targetPrice = Number(raw.targetPrice);
  if (!Number.isFinite(targetPrice) || targetPrice <= 0) return null;
  const triggered = raw.triggeredAt ? Date.parse(raw.triggeredAt) || Number(raw.triggeredAt) : 0;
  return {
    id: String(raw.id ?? raw.asin ?? ''),
    asin: String(raw.asin || '').toUpperCase(),
    targetPrice,
    enabled: raw.enabled !== false,
    title: String(raw.title || ''),
    triggeredAt: Number.isFinite(triggered) && triggered > 0 ? triggered : null
  };
}
