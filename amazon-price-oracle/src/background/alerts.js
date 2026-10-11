/**
 * Local price alerts: storage, notifications and background checks. The pure logic lives in alerts-api.js.
 *
 * Where a price comes from:
 *  - the product page and search results the user browses (analyzeProduct calls `noticePrice`), and
 *  - a background check every hour for alerts not checked in the last 4 hours (one context.dev lookup each,
 *    at most 5 per run), unless the user turned that off in Settings.
 * When a price is at or below the target the alert fires once: desktop notification, toolbar badge and a
 * "Target reached" state on the product card, popup and website alerts page. Re-arm it to be told again.
 */
import { ALERT_CHECK_BATCH, ALERT_RECHECK_MS, STORAGE_KEYS } from '../shared/constants.js';
import {
  dueForCheck,
  findAlert,
  isEmail,
  mailtoUrl,
  notificationText,
  observePrice,
  patchAlert,
  removeAlertFrom,
  sanitizeAlerts,
  sortAlerts,
  summarizeAlerts,
  badgeFor,
  upsertAlert
} from './alerts-api.js';
import { fetchProductContext } from './context-dev.js';

const NOTIFICATION_PREFIX = 'po-alert-';

/** Read-modify-write on one storage key must not interleave, or two tabs could overwrite each other. */
let queue = Promise.resolve();
const serialized = (work) => {
  const run = queue.then(work, work);
  queue = run.catch(() => {});
  return run;
};

async function readList() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.PRICE_ALERTS);
  return sanitizeAlerts(stored[STORAGE_KEYS.PRICE_ALERTS]);
}

const writeList = (list) => chrome.storage.local.set({ [STORAGE_KEYS.PRICE_ALERTS]: list });

export async function getEmail() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.ALERT_EMAIL);
  const email = String(stored[STORAGE_KEYS.ALERT_EMAIL] || '').trim();
  return isEmail(email) ? email : '';
}

/** Everything the popup, the website page and the search chips need, fired alerts first. */
export async function getAlertsOverview() {
  return { alerts: sortAlerts(await readList()), email: await getEmail() };
}

/** What the product-page card shows for one item. */
export async function getAlertState(asin) {
  return { alert: findAlert(await readList(), asin), email: await getEmail() };
}

export function createAlert({ asin, title, currentPrice, targetPrice }) {
  return serialized(async () => {
    const { list, alert } = upsertAlert(await readList(), { asin, title, currentPrice, targetPrice });
    await writeList(list);
    return alert;
  });
}

export function updateAlert({ alertId, ...changes }) {
  return serialized(async () => {
    const { list, alert } = patchAlert(await readList(), alertId, changes);
    await writeList(list);
    return alert;
  });
}

export function removeAlert({ alertId }) {
  return serialized(async () => {
    await writeList(removeAlertFrom(await readList(), alertId));
    return true;
  });
}

/** Record a price the extension saw; fires the alert (notification) when it reached the target. */
export function noticePrice(asin, price) {
  return serialized(async () => {
    const { list, fired, changed } = observePrice(await readList(), asin, price);
    if (!changed) return null;
    await writeList(list);
    if (fired) await notify(fired);
    return fired;
  });
}

/** Settings "Send a test notification": proves that Chrome and the operating system will show alerts. */
export async function sendTestNotification() {
  const id = `${NOTIFICATION_PREFIX}TEST`;
  await chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: 'PriceOracle test',
    message: 'Price alerts will look like this. Click to dismiss.',
    priority: 1
  });
  return true;
}

async function notify(alert) {
  const { title, message } = notificationText(alert);
  const email = await getEmail();
  const buttons = [{ title: 'Open on Amazon' }];
  if (email) buttons.push({ title: 'Email me this' });
  try {
    await chrome.notifications.create(`${NOTIFICATION_PREFIX}${alert.asin}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message,
      priority: 2,
      requireInteraction: true,
      buttons
    });
  } catch (err) {
    console.warn('PriceOracle: could not show the notification', err);
  }
}

/** Notification click: open the product; button 1 opens a ready-made email to the address in Settings. */
export async function handleNotificationClick(notificationId, buttonIndex) {
  if (!notificationId.startsWith(NOTIFICATION_PREFIX)) return;
  const asin = notificationId.slice(NOTIFICATION_PREFIX.length);
  if (asin === 'TEST') return chrome.notifications.clear(notificationId);
  const alert = findAlert(await readList(), asin);
  const email = await getEmail();
  const url = buttonIndex === 1 && email && alert ? mailtoUrl(email, alert) : `https://www.amazon.com/dp/${encodeURIComponent(asin)}`;
  await chrome.tabs.create({ url });
  chrome.notifications.clear(notificationId);
}

/** Hourly alarm: look up the alerts that are due and fire any that reached their target. */
export async function runBackgroundCheck() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.ALERT_BACKGROUND);
  if (stored[STORAGE_KEYS.ALERT_BACKGROUND] === false) return { checked: 0 };
  const due = dueForCheck(await readList(), Date.now(), ALERT_RECHECK_MS, ALERT_CHECK_BATCH);
  let checked = 0;
  for (const alert of due) {
    const context = await fetchProductContext(alert.asin, { forceRefresh: true });
    const price = context.signals?.currentPrice;
    if (context.status === 'connected' && price > 0) {
      await noticePrice(alert.asin, price);
      checked++;
    } else if (/paused|key|quota|credit/i.test(context.error || '')) {
      break; // the whole service is unavailable; do not hammer it for each alert
    }
  }
  return { checked };
}

/** Toolbar badge: the number of alerts that reached their target. */
export async function syncAlertBadge() {
  const { text, title } = badgeFor(summarizeAlerts(await readList()));
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: '#B12704' });
  await chrome.action.setBadgeTextColor?.({ color: '#FFFFFF' });
  await chrome.action.setTitle({ title });
}
