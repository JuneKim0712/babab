/**
 * Link to the PriceOracle website: Google sign-in (done by the website) and per-item price alerts.
 *
 * The extension never talks to Google. It opens the website's sign-in bridge in an auth window
 * (chrome.identity.launchWebAuthFlow); the website signs the user in with Google and redirects back
 * with its own bearer token. That token lives in chrome.storage.local and is only ever sent to the
 * configured website origin. See docs/WEBSITE_INTEGRATION.md.
 */
import { SITE_REQUEST_TIMEOUT_MS, STORAGE_KEYS } from '../shared/constants.js';
import {
  buildAlertBody,
  buildConnectUrl,
  isSessionValid,
  normalizeAlert,
  normalizeSiteUrl,
  parseAuthRedirect,
  validateTarget
} from './site-api.js';

const CORS_HINT = 'Could not reach the website. It must allow cross-origin requests (see docs/WEBSITE_INTEGRATION.md).';

class SignedOutError extends Error {
  constructor() {
    super('Your website sign-in expired. Sign in again.');
    this.code = 'signed_out';
  }
}

async function readConfig() {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.SITE_URL, STORAGE_KEYS.SITE_SESSION]);
  const session = stored[STORAGE_KEYS.SITE_SESSION];
  return { siteUrl: stored[STORAGE_KEYS.SITE_URL] || '', session: isSessionValid(session) ? session : null, hadSession: Boolean(session) };
}

async function clearSession() {
  await chrome.storage.local.remove(STORAGE_KEYS.SITE_SESSION);
}

/** The website rejected the token: drop it but remember that the user was signed in, so the UI can say "expired". */
async function expireSession() {
  const { session } = await chrome.storage.local.get(STORAGE_KEYS.SITE_SESSION).then((s) => ({ session: s[STORAGE_KEYS.SITE_SESSION] }));
  await chrome.storage.local.set({ [STORAGE_KEYS.SITE_SESSION]: { email: session?.email || '', expiresAt: 0 } });
}

/**
 * Authenticated request to the website. Rejects with SignedOutError on 401 (and forgets the token).
 * @returns {Promise<{status: number, body: any}>}
 */
async function siteFetch(path, { method = 'GET', body } = {}) {
  const { siteUrl, session } = await readConfig();
  if (!siteUrl || !session) throw new SignedOutError();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SITE_REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(new URL(path, siteUrl), {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${session.token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new Error(CORS_HINT);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401) {
    await expireSession();
    throw new SignedOutError();
  }
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    /* empty or non-JSON body */
  }
  if (!response.ok && response.status !== 404) {
    throw new Error(parsed?.error || `The website answered ${response.status}.`);
  }
  return { status: response.status, body: parsed };
}

/** Everything Settings and the popup need. */
export async function getSiteStatus({ withAlertCount = false } = {}) {
  const { siteUrl, session, hadSession } = await readConfig();
  const status = {
    siteUrl,
    connected: Boolean(siteUrl && session),
    expired: Boolean(siteUrl && hadSession && !session),
    email: session?.email || '',
    name: session?.name || '',
    activeAlerts: null
  };
  if (withAlertCount && status.connected) {
    try {
      const { body } = await siteFetch('/api/alerts');
      const list = Array.isArray(body?.alerts) ? body.alerts.map(normalizeAlert).filter(Boolean) : [];
      status.activeAlerts = list.filter((a) => a.enabled).length;
    } catch (err) {
      if (err.code === 'signed_out') {
        status.connected = false;
        status.expired = true;
        status.email = '';
      }
    }
  }
  return status;
}

/** Run the Google sign-in through the website and store the resulting session. */
export async function connectSite(address) {
  const siteUrl = normalizeSiteUrl(address);
  const redirectUri = chrome.identity.getRedirectURL('site');
  const state = crypto.randomUUID();
  const finalUrl = await chrome.identity.launchWebAuthFlow({
    url: buildConnectUrl(siteUrl, redirectUri, state),
    interactive: true
  });
  const session = parseAuthRedirect(finalUrl, state);
  await chrome.storage.local.set({ [STORAGE_KEYS.SITE_URL]: siteUrl, [STORAGE_KEYS.SITE_SESSION]: session });
  return getSiteStatus();
}

export async function disconnectSite() {
  try {
    await siteFetch('/api/session', { method: 'DELETE' });
  } catch {
    /* best effort: the local token is dropped regardless */
  }
  await clearSession();
  return getSiteStatus();
}

/**
 * What the product-page card shows for an item.
 * @returns {Promise<{state: 'not_configured'|'signed_out'|'ready'|'error', email?: string, alert?: object|null, error?: string}>}
 */
export async function getAlertState(asin) {
  const { siteUrl, session, hadSession } = await readConfig();
  if (!siteUrl) return { state: 'not_configured' };
  if (!session) return { state: 'signed_out', expired: hadSession };
  try {
    const { status, body } = await siteFetch(`/api/alerts/${encodeURIComponent(asin)}`);
    return { state: 'ready', email: session.email, alert: status === 404 ? null : normalizeAlert(body?.alert) };
  } catch (err) {
    if (err.code === 'signed_out') return { state: 'signed_out', expired: true };
    return { state: 'error', error: err.message };
  }
}

/**
 * Create, update, pause or resume the alert for one item (idempotent: one alert per user and ASIN).
 * `targetPrice` may be omitted when only toggling `enabled`.
 */
export async function setAlert({ asin, title, currentPrice, targetPrice, enabled, toggleOnly }) {
  const price = Number(currentPrice);
  if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error('Invalid ASIN');
  // Pausing or resuming keeps the saved target even if the price has since fallen below it.
  const target = validateTarget(targetPrice, toggleOnly ? 0 : price);
  const { body } = await siteFetch(`/api/alerts/${encodeURIComponent(asin)}`, {
    method: 'PUT',
    body: buildAlertBody({ asin, title, currentPrice: price, targetPrice: target, enabled })
  });
  const alert = normalizeAlert(body?.alert);
  if (!alert) throw new Error('The website did not return the saved alert.');
  return alert;
}

export async function removeAlert(asin) {
  await siteFetch(`/api/alerts/${encodeURIComponent(asin)}`, { method: 'DELETE' });
  return true;
}
