/**
 * Popup: quick stats, connection status and cache controls.
 */
import { MSG } from '../shared/constants.js';

const $ = (id) => document.getElementById(id);
const usd = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

/** Send a message to the service worker and unwrap `{ok, data}`. */
async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'Service worker unavailable');
  return response.data;
}

function setBadge(el, ok, text) {
  el.textContent = text;
  el.className = `badge ${ok ? 'ok' : 'pending'}`;
}

function timeAgo(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/** Rows link to the product; text is set with textContent so titles can never inject markup. */
function renderRecent(list) {
  $('recent-card').hidden = !list || list.length < 2; // the last product is already shown above
  const ul = $('recent-list');
  ul.replaceChildren();
  for (const item of (list || []).slice(1)) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `https://www.amazon.com/dp/${encodeURIComponent(item.asin)}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    const title = document.createElement('span');
    title.className = 'recent-title';
    title.textContent = item.title || `ASIN ${item.asin}`;
    const pill = document.createElement('span');
    pill.className = `pill small ${item.action}`;
    pill.textContent = item.label;
    const price = document.createElement('span');
    price.className = 'muted';
    price.textContent = usd(item.currentPrice);
    a.append(title, pill, price);
    li.append(a);
    ul.append(li);
  }
}

function renderLast(last) {
  $('last-empty').hidden = Boolean(last);
  $('last-body').hidden = !last;
  if (!last) return;

  $('last-product').textContent = last.title || `ASIN ${last.asin}`;
  const pill = $('last-pill');
  pill.textContent = last.label;
  pill.className = `pill ${last.action}`;
  $('last-confidence').textContent = `${last.confidence}% confidence${last.isSimulated ? ' · heuristic' : ''}`;
  $('last-current').textContent = usd(last.currentPrice);
  $('last-mid').textContent = usd(last.projectedMid);

  const sign = last.deltaPercentMonth > 0 ? '+' : '';
  const amount = `${last.deltaAmount > 0 ? '+' : last.deltaAmount < 0 ? '-' : ''}${usd(Math.abs(last.deltaAmount))}`;
  $('last-delta').textContent = `${sign}${last.deltaPercentMonth.toFixed(1)}% (${amount})`;
  $('last-when').textContent = `Analyzed ${timeAgo(last.at)}`;
}

const ALERT_PILL = { active: ['ALERT_ON', 'Alert on'], paused: ['ALERT_PAUSED', 'Paused'], triggered: ['ALERT_SENT', 'Target reached'] };
const MAX_ALERTS_SHOWN = 6;

/** Titles come from Amazon pages, so everything is set with textContent. */
function renderAlerts(overview) {
  const alerts = overview?.alerts || [];
  $('alerts-card').hidden = alerts.length === 0;
  const ul = $('alerts-list');
  ul.replaceChildren();
  for (const alert of alerts.slice(0, MAX_ALERTS_SHOWN)) {
    const li = document.createElement('li');
    const link = document.createElement('a');
    link.href = `https://www.amazon.com/dp/${encodeURIComponent(alert.asin)}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = alert.title || `ASIN ${alert.asin}`;

    const meta = document.createElement('div');
    meta.className = 'alert-meta';
    const [cls, label] = ALERT_PILL[alert.status];
    const pill = document.createElement('span');
    pill.className = `pill small ${cls}`;
    pill.textContent = label;
    const goal = document.createElement('span');
    goal.textContent = alert.status === 'triggered' ? `hit ${usd(alert.triggeredPrice || alert.targetPrice)}, target ${usd(alert.targetPrice)}` : `at or below ${usd(alert.targetPrice)}`;
    meta.append(pill, goal);

    if (alert.status === 'triggered') {
      const rearm = document.createElement('button');
      rearm.type = 'button';
      rearm.className = 'btn small';
      rearm.textContent = 'Re-arm';
      rearm.addEventListener('click', async () => {
        rearm.disabled = true;
        try {
          await request({ type: MSG.ALERT_UPDATE, payload: { alertId: alert.id, status: 'active' } });
        } catch (err) {
          goal.textContent = err.message;
        }
        await refresh();
      });
      meta.append(rearm);
    }
    li.append(link, meta);
    ul.append(li);
  }
  const extra = alerts.length - MAX_ALERTS_SHOWN;
  $('alerts-more').hidden = extra <= 0;
  $('alerts-more').textContent = extra > 0 ? `and ${extra} more on the alerts page` : '';
}

function renderAlertsStatus(overview) {
  const alerts = overview?.alerts || [];
  const active = alerts.filter((a) => a.status === 'active').length;
  const reached = alerts.filter((a) => a.status === 'triggered').length;
  setBadge($('alerts-status'), true, reached ? `${reached} reached` : active ? `${active} watching` : 'None yet');
  $('alerts-hint').textContent = alerts.length
    ? 'Alerts are stored in this browser. Chrome notifies you when one reaches its target.'
    : 'Open a product page and use "Set alert" in the PriceOracle card. Alerts are stored in this browser.';
}

async function refresh() {
  try {
    const status = await request({ type: MSG.GET_STATUS });
    $('stat-count').textContent = status.analysisCount;
    $('stat-cache').textContent = status.cachedProducts;
    $('stat-tracked').textContent = status.trackedProducts;
    setBadge($('ctx-status'), status.contextKeySet, status.usingDefaultContextKey ? 'Default key active' : 'Custom key active');
    const gem = status.lastAnalysis?.geminiStatus;
    setBadge($('gem-status'), gem !== 'offline', gem === 'live' ? 'Live' : gem === 'offline' ? 'Offline' : 'Ready');
    $('gem-hint').textContent =
      gem === 'offline'
        ? 'Gemini markets was unreachable on the last check: using the heuristic model only.'
        : 'Live Fed and recession odds from Gemini prediction markets feed every projection. No key required.';
    renderLast(status.lastAnalysis);
    const overview = await request({ type: MSG.ALERT_LIST });
    renderAlertsStatus(overview);
    renderAlerts(overview);
    renderRecent(status.recent);
  } catch (err) {
    $('gem-hint').textContent = `Could not load status: ${err.message}`;
  }
}

$('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('clear-cache').addEventListener('click', async () => {
  await request({ type: MSG.CLEAR_CACHE });
  await refresh();
});

refresh();
