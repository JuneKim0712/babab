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

async function refresh() {
  try {
    const status = await request({ type: MSG.GET_STATUS });
    $('stat-count').textContent = status.analysisCount;
    $('stat-cache').textContent = status.cachedProducts;
    setBadge($('ctx-status'), status.contextKeySet, status.usingDefaultContextKey ? 'Default key active' : 'Custom key active');
    const gem = status.lastAnalysis?.geminiStatus;
    setBadge($('gem-status'), gem !== 'offline', gem === 'live' ? 'Live' : gem === 'offline' ? 'Offline' : 'Ready');
    $('gem-hint').textContent =
      gem === 'offline'
        ? 'Gemini markets was unreachable on the last check: using the heuristic model only.'
        : 'Live Fed and recession odds from Gemini prediction markets feed every projection. No key required.';
    renderLast(status.lastAnalysis);
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
