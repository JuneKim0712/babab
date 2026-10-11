/**
 * Calls to the website's alert API (https://xylm-306e6.web.app), always from the service worker:
 * the endpoints send no CORS headers, so a content script's fetch would be blocked.
 * Alerts are never written to Firestore directly; the server attaches the live price, title and forecast.
 */
import { API_BASE, API_TIMEOUT_MS, CREATE_ALERT_TIMEOUT_MS } from '../shared/constants.js';
import { SignedOutError, getIdToken, invalidateSession } from './account.js';
import {
  buildCreateBody,
  buildDeleteBody,
  buildUpdateBody,
  findAlertForAsin,
  normalizeAlert,
  validateTarget
} from './alerts-api.js';

/**
 * Authenticated JSON request. On a 401 the ID token is refreshed once and the request retried.
 * @returns {Promise<{status: number, body: any}>}
 */
async function api(path, { method = 'GET', body, timeoutMs = API_TIMEOUT_MS } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { idToken } = await getIdToken({ force: attempt > 0 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${idToken}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (err) {
      throw new Error(err?.name === 'AbortError' ? 'The alerts service took too long to answer. Try again.' : 'Could not reach the alerts service.');
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 && attempt === 0) continue;
    if (response.status === 401) {
      await invalidateSession();
      throw new SignedOutError();
    }

    const contentType = response.headers.get('content-type') || '';
    const parsed = contentType.includes('json') ? await response.json().catch(() => null) : null;
    if (!contentType.includes('json') && response.status !== 204) {
      throw new Error(`The alerts service answered with a web page (HTTP ${response.status}), not data.`);
    }
    return { status: response.status, body: parsed };
  }
  throw new SignedOutError();
}

function failure(res, fallback) {
  const message = typeof res.body?.error === 'string' ? res.body.error : res.body?.error?.message;
  return new Error(message || `${fallback} (HTTP ${res.status}).`);
}

async function listAlerts() {
  const res = await api('/api/my-alerts');
  if (res.status !== 200 || !res.body?.success) throw failure(res, 'Could not load your alerts');
  return Array.isArray(res.body.alerts) ? res.body.alerts : [];
}

/** Number of active alerts and the account email, for Settings and the popup. */
export async function countActiveAlerts() {
  const list = await listAlerts();
  return list.map(normalizeAlert).filter((a) => a && a.status === 'active' && a.retailer !== 'bestbuy').length;
}

/**
 * What the product-page card shows for an item.
 * @returns {Promise<{state: 'signed_out'|'ready'|'error', email?: string, alert?: object|null, expired?: boolean, error?: string}>}
 */
export async function getAlertState(asin) {
  try {
    const { email } = await getIdToken();
    return { state: 'ready', email, alert: findAlertForAsin(await listAlerts(), asin) };
  } catch (err) {
    if (err.code === 'signed_out') return { state: 'signed_out', expired: /expired/i.test(err.message) };
    return { state: 'error', error: err.message };
  }
}

/**
 * Create the alert for an item. Only call this from an explicit click: every new product lookup costs the
 * website scraping credits, and the first one can take up to ~47 s.
 */
export async function createAlert({ asin, currentPrice, targetPrice }) {
  if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error('Invalid ASIN');
  const target = validateTarget(targetPrice, Number(currentPrice));
  const { email } = await getIdToken();

  // Never create a duplicate (each one is a paid lookup): reuse an alert that already exists.
  const existing = findAlertForAsin(await listAlerts(), asin);
  if (existing) {
    await updateAlert({ alertId: existing.id, targetPrice: target, status: 'active' });
    return (await getAlertState(asin)).alert;
  }

  const res = await api('/api/create-alert', { method: 'POST', body: buildCreateBody({ email, asin, targetPrice: target }), timeoutMs: CREATE_ALERT_TIMEOUT_MS });
  if (res.status !== 200 || !res.body?.success) throw failure(res, 'The alert was not saved');
  const alert = normalizeAlert({ ...res.body.alert, id: res.body.alertId });
  if (!alert) throw new Error('The alerts service did not return the saved alert.');
  return alert;
}

/** Change the target and/or pause or re-arm an alert, then return the alert as the server now has it. */
export async function updateAlert({ asin, alertId, targetPrice, status, currentPrice, toggleOnly }) {
  const target = targetPrice === undefined ? undefined : validateTarget(targetPrice, toggleOnly ? 0 : Number(currentPrice));
  const res = await api('/api/my-alerts', { method: 'POST', body: buildUpdateBody({ alertId, targetPrice: target, status }) });
  if (res.status === 404) throw new Error('That alert no longer exists. Reload the page to see your current alerts.');
  if (res.status !== 200 || res.body?.success === false) throw failure(res, 'The alert was not updated');
  return asin ? findAlertForAsin(await listAlerts(), asin) : null;
}

export async function removeAlert({ alertId }) {
  const res = await api('/api/my-alerts', { method: 'POST', body: buildDeleteBody(alertId) });
  if (res.status === 404) return true; // already gone
  if (res.status !== 200 || res.body?.success === false) throw failure(res, 'The alert was not deleted');
  return true;
}
