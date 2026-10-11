/**
 * Pure helpers for Google sign-in, Firebase tokens and the website's alert API
 * (no chrome.* and no fetch, so they are unit-tested). Wire format: docs/ALERTS_INTEGRATION.md.
 */
import { GOOGLE_AUTH_URL } from '../shared/constants.js';

const b64urlToString = (value) => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

/** Read the claims of a JWT without verifying it (Firebase verifies the signature server-side). */
export function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Google returned a malformed ID token.');
  try {
    return JSON.parse(b64urlToString(parts[1]));
  } catch {
    throw new Error('Google returned a malformed ID token.');
  }
}

/** URL of Google's consent screen for an ID token (OpenID Connect implicit flow). */
export function buildGoogleAuthUrl({ clientId, redirectUri, state, nonce, loginHint }) {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'id_token');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('prompt', 'select_account');
  if (loginHint) url.searchParams.set('login_hint', loginHint);
  return url.toString();
}

/**
 * Pull the Google ID token out of the redirect and check that it answers *our* request.
 * @returns {string} the Google ID token
 */
export function parseGoogleRedirect(redirectUrl, { state, nonce, clientId }) {
  if (!redirectUrl) throw new Error('Sign-in was cancelled.');
  const url = new URL(redirectUrl);
  const params = new URLSearchParams(url.hash.replace(/^#/, ''));
  for (const [k, v] of url.searchParams) if (!params.has(k)) params.set(k, v);

  if (params.get('error')) throw new Error(`Google refused sign-in: ${params.get('error_description') || params.get('error')}`);
  if (params.get('state') !== state) throw new Error('Sign-in response did not match this request. Try again.');
  const idToken = params.get('id_token');
  if (!idToken) throw new Error('Google did not return an ID token.');

  const claims = decodeJwtPayload(idToken);
  if (claims.nonce !== nonce) throw new Error('Sign-in response did not match this request. Try again.');
  if (clientId && claims.aud !== clientId) throw new Error('Google returned a token for a different app.');
  return idToken;
}

/** Message from an Identity Toolkit / Secure Token error body, e.g. "INVALID_IDP_RESPONSE". */
export function firebaseErrorMessage(body, fallback) {
  const raw = body?.error?.message;
  return typeof raw === 'string' && raw ? raw.split(' : ')[0] : fallback;
}

/**
 * Session from `accounts:signInWithIdp`.
 * @returns {{idToken: string, refreshToken: string, expiresAt: number, email: string, name: string, uid: string}}
 */
export function sessionFromSignIn(body, now = Date.now()) {
  if (!body?.idToken || !body?.refreshToken) throw new Error('Firebase did not return a session.');
  const claims = decodeJwtPayloadSafe(body.idToken);
  return {
    idToken: body.idToken,
    refreshToken: body.refreshToken,
    expiresAt: now + (Number(body.expiresIn) > 0 ? Number(body.expiresIn) : 3600) * 1000,
    email: String(body.email || claims.email || '').toLowerCase(),
    name: String(body.displayName || claims.name || ''),
    uid: String(body.localId || claims.user_id || claims.sub || '')
  };
}

/** Session update from the Secure Token refresh response (snake_case fields). */
export function refreshSession(session, body, now = Date.now()) {
  if (!body?.id_token) throw new Error('Firebase did not return a refreshed token.');
  return {
    ...session,
    idToken: body.id_token,
    refreshToken: body.refresh_token || session.refreshToken,
    expiresAt: now + (Number(body.expires_in) > 0 ? Number(body.expires_in) : 3600) * 1000
  };
}

function decodeJwtPayloadSafe(token) {
  try {
    return decodeJwtPayload(token);
  } catch {
    return {};
  }
}

/** True while the ID token can still be used without refreshing. */
export const isTokenFresh = (session, margin, now = Date.now()) => Boolean(session?.idToken) && session.expiresAt - margin > now;

/** A session that still holds a refresh token can be renewed. */
export const canRefresh = (session) => Boolean(session?.refreshToken);

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

/** Body of `POST /api/create-alert`. The server resolves title, live price and forecast itself. */
export function buildCreateBody({ email, asin, targetPrice }) {
  return {
    email,
    targetType: 'asin',
    targetValue: `https://www.amazon.com/dp/${asin}`,
    targetPrice
  };
}

/** Body of `POST /api/my-alerts` for an update. Only the fields that are present are sent. */
export function buildUpdateBody({ alertId, targetPrice, status }) {
  const body = { action: 'update', alertId };
  if (targetPrice !== undefined) body.targetPrice = targetPrice;
  if (status !== undefined) {
    if (status !== 'active' && status !== 'paused') throw new Error('status must be "active" or "paused"');
    body.status = status;
  }
  return body;
}

export const buildDeleteBody = (alertId) => ({ action: 'delete', alertId });

/**
 * Defensive read of an alert document from the website.
 * @returns {{id: string, asin: string, targetPrice: number|null, status: 'active'|'paused'|'triggered', title: string, priceAtCreation: number|null, retailer: string}|null}
 */
export function normalizeAlert(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? raw.alertId ?? '');
  const asin = String(raw.targetValue || '').toUpperCase();
  if (!id || !asin) return null;
  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) || Number(v) <= 0 ? null : Number(v));
  return {
    id,
    asin,
    targetType: String(raw.targetType || ''),
    retailer: String(raw.retailer || 'amazon'),
    targetPrice: num(raw.targetPrice),
    status: raw.status === 'paused' || raw.status === 'triggered' ? raw.status : 'active',
    title: String(raw.productTitle || ''),
    priceAtCreation: num(raw.currentPriceAtCreation)
  };
}

/** The newest alert for an Amazon product (the list is newest first). */
export function findAlertForAsin(list, asin) {
  const wanted = String(asin).toUpperCase();
  for (const raw of Array.isArray(list) ? list : []) {
    const alert = normalizeAlert(raw);
    if (alert && alert.targetType === 'asin' && alert.retailer !== 'bestbuy' && alert.asin === wanted) return alert;
  }
  return null;
}
