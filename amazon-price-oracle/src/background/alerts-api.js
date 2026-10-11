/**
 * Pure helpers for the local price alerts (no chrome.* and no fetch, so they are unit-tested).
 *
 * An alert is a plain object, one per product (ASIN), stored in chrome.storage.local:
 *   { id, asin, title, targetPrice, status: 'active'|'paused'|'triggered', priceAtCreation, lastPrice,
 *     lastCheckedAt, createdAt, triggeredAt, triggeredPrice }
 * Every function returns new objects; callers persist the result.
 */

export const MAX_ALERTS = 200;
const MAX_TITLE = 200;

export const alertId = (asin) => `po-${String(asin).toUpperCase()}`;

const money = (v) => {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) || n <= 0 ? null : Math.round(n * 100) / 100;
};
const time = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

/**
 * Defensive read of one stored alert.
 * @returns {object|null} null when it is not usable
 */
export function normalizeAlert(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const asin = String(raw.asin || '').toUpperCase();
  const targetPrice = money(raw.targetPrice);
  if (!/^[A-Z0-9]{10}$/.test(asin) || !targetPrice) return null;
  return {
    id: alertId(asin),
    asin,
    title: String(raw.title || '').slice(0, MAX_TITLE),
    targetPrice,
    status: raw.status === 'paused' || raw.status === 'triggered' ? raw.status : 'active',
    priceAtCreation: money(raw.priceAtCreation),
    lastPrice: money(raw.lastPrice),
    lastCheckedAt: time(raw.lastCheckedAt),
    createdAt: time(raw.createdAt) || Date.now(),
    triggeredAt: time(raw.triggeredAt),
    triggeredPrice: money(raw.triggeredPrice)
  };
}

/** Clean the stored list: drop junk, one alert per product (the first wins), newest first, capped. */
export function sanitizeAlerts(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const alert = normalizeAlert(raw);
    if (!alert || seen.has(alert.id)) continue;
    seen.add(alert.id);
    out.push(alert);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_ALERTS);
}

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

export const findAlert = (list, asin) => list.find((a) => a.asin === String(asin).toUpperCase()) || null;

/**
 * Create the alert for a product, or re-aim the one that exists (one alert per product).
 * @returns {{list: object[], alert: object}}
 */
export function upsertAlert(list, { asin, title, targetPrice, currentPrice }, now = Date.now()) {
  const target = validateTarget(targetPrice, Number(currentPrice));
  const key = String(asin).toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(key)) throw new Error('Invalid ASIN');
  const existing = findAlert(list, key);
  const alert = normalizeAlert({
    ...existing,
    asin: key,
    title: title || existing?.title || '',
    targetPrice: target,
    status: 'active',
    priceAtCreation: existing?.priceAtCreation ?? money(currentPrice),
    lastPrice: money(currentPrice) ?? existing?.lastPrice,
    lastCheckedAt: money(currentPrice) ? now : existing?.lastCheckedAt,
    createdAt: existing?.createdAt ?? now,
    triggeredAt: null,
    triggeredPrice: null
  });
  const rest = list.filter((a) => a.id !== alert.id);
  if (!existing && rest.length >= MAX_ALERTS) throw new Error(`You can keep up to ${MAX_ALERTS} price alerts. Remove one first.`);
  return { list: sanitizeAlerts([alert, ...rest]), alert };
}

/**
 * Change an alert's target, title and/or status. A new target re-arms a fired alert.
 * @returns {{list: object[], alert: object}}
 */
export function patchAlert(list, id, { targetPrice, status, title, currentPrice, toggleOnly }) {
  const existing = list.find((a) => a.id === id);
  if (!existing) throw new Error('That alert no longer exists.');
  if (status !== undefined && status !== 'active' && status !== 'paused') throw new Error('status must be "active" or "paused"');
  const next = { ...existing };
  if (targetPrice !== undefined) {
    next.targetPrice = validateTarget(targetPrice, toggleOnly ? 0 : Number(currentPrice));
    next.status = 'active';
  }
  if (status !== undefined) next.status = status;
  if (title) next.title = title;
  if (next.status !== 'triggered') {
    next.triggeredAt = null;
    next.triggeredPrice = null;
  }
  const alert = normalizeAlert(next);
  return { list: list.map((a) => (a.id === id ? alert : a)), alert };
}

export const removeAlertFrom = (list, id) => list.filter((a) => a.id !== id);

/**
 * Record a price the extension saw for a product and fire the alert if it reached the target.
 * @returns {{list: object[], fired: object|null, changed: boolean}}
 */
export function observePrice(list, asin, price, now = Date.now()) {
  const p = money(price);
  const key = String(asin).toUpperCase();
  const existing = findAlert(list, key);
  if (!existing || !p) return { list, fired: null, changed: false };
  const next = { ...existing, lastPrice: p, lastCheckedAt: now };
  let fired = null;
  if (existing.status === 'active' && p <= existing.targetPrice) {
    next.status = 'triggered';
    next.triggeredAt = now;
    next.triggeredPrice = p;
    fired = next;
  }
  return { list: list.map((a) => (a.id === existing.id ? next : a)), fired, changed: true };
}

/** Active alerts that have not been checked for `recheckMs`, least recently checked first. */
export function dueForCheck(list, now, recheckMs, limit) {
  return list
    .filter((a) => a.status === 'active' && now - (a.lastCheckedAt || 0) >= recheckMs)
    .sort((a, b) => (a.lastCheckedAt || 0) - (b.lastCheckedAt || 0))
    .slice(0, limit);
}

/** Fired alerts first, then active, then paused; stable within a group (the stored list is newest first). */
export function sortAlerts(alerts) {
  const rank = { triggered: 0, active: 1, paused: 2 };
  return alerts.map((a, i) => [a, i]).sort((x, y) => rank[x[0].status] - rank[y[0].status] || x[1] - y[1]).map(([a]) => a);
}

export function summarizeAlerts(alerts) {
  const summary = { total: alerts.length, active: 0, paused: 0, triggered: 0 };
  for (const a of alerts) summary[a.status]++;
  return summary;
}

/** Toolbar badge: the number of alerts that reached their target and are waiting for the user. */
export function badgeFor(summary) {
  const n = summary.triggered;
  if (!n) {
    const quiet = summary.active ? `PriceOracle: watching ${summary.active} price alert${summary.active === 1 ? '' : 's'}` : 'PriceOracle';
    return { text: '', title: quiet };
  }
  return { text: n > 99 ? '99+' : String(n), title: `PriceOracle: ${n} price alert${n === 1 ? '' : 's'} reached your target` };
}

const usd = (n) => `$${Number(n).toFixed(2)}`;

/** Text of the desktop notification for a fired alert. */
export function notificationText(alert) {
  const name = alert.title || `Amazon item ${alert.asin}`;
  return {
    title: 'Price target reached',
    message: `${name.length > 90 ? `${name.slice(0, 89)}…` : name} is ${usd(alert.triggeredPrice ?? alert.lastPrice)}, at or below your ${usd(alert.targetPrice)} target.`
  };
}

export const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || '').trim());

/** A mailto: link that lets the user send themselves the deal with one click (the extension never sends mail). */
export function mailtoUrl(email, alert) {
  const { message } = notificationText(alert);
  const body = `${message}\n\nhttps://www.amazon.com/dp/${alert.asin}`;
  return `mailto:${String(email).trim()}?subject=${encodeURIComponent('PriceOracle: price target reached')}&body=${encodeURIComponent(body)}`;
}
