/**
 * Options page: manage the context.dev key and test connectivity.
 */
import { DEFAULT_CONTEXT_DEV_KEY, MSG, STORAGE_KEYS } from '../shared/constants.js';

const $ = (id) => document.getElementById(id);
/** Checkbox id -> storage key. Absent in storage means on. */
const SWITCHES = {
  'show-product-card': STORAGE_KEYS.SHOW_PRODUCT_CARD,
  'show-search-chips': STORAGE_KEYS.SHOW_SEARCH_CHIPS
};
let bannerTimer = null;

function banner(text, kind) {
  const el = $('banner');
  el.textContent = text;
  el.className = `banner ${kind}`;
  el.hidden = false;
  clearTimeout(bannerTimer);
  if (kind === 'ok') bannerTimer = setTimeout(() => (el.hidden = true), 5000);
}

async function load() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.CONTEXT_KEY);
  $('context-key').value = (stored[STORAGE_KEYS.CONTEXT_KEY] || '').trim() || DEFAULT_CONTEXT_DEV_KEY;
  const shown = await chrome.storage.local.get(Object.keys(SWITCHES).map((id) => SWITCHES[id]));
  for (const [id, key] of Object.entries(SWITCHES)) $(id).checked = shown[key] !== false;
}

async function save(event) {
  event.preventDefault();
  const contextKey = $('context-key').value.trim();

  // The shipped default is the implicit fallback, so there is no need to persist it.
  if (!contextKey || contextKey === DEFAULT_CONTEXT_DEV_KEY) {
    await chrome.storage.local.remove(STORAGE_KEYS.CONTEXT_KEY);
    $('context-key').value = DEFAULT_CONTEXT_DEV_KEY;
  } else {
    await chrome.storage.local.set({ [STORAGE_KEYS.CONTEXT_KEY]: contextKey });
  }

  await chrome.storage.local.remove([STORAGE_KEYS.MACRO_CACHE, STORAGE_KEYS.CONTEXT_PAUSE]);

  banner('Settings saved.', 'ok');
}

function showResult(prefix, result) {
  const dot = $(`dot-${prefix}`);
  dot.className = `dot ${result.skipped ? 'skip' : result.ok ? 'ok' : 'err'}`;
  $(`res-${prefix}`).textContent = result.message;
}

async function testConnection() {
  const button = $('test');
  button.disabled = true;
  button.textContent = 'Testing…';
  banner('Testing API reachability…', 'info');
  try {
    const response = await chrome.runtime.sendMessage({
      type: MSG.TEST_CONNECTION,
      keys: { contextDev: $('context-key').value }
    });
    if (!response?.ok) throw new Error(response?.error || 'Service worker unavailable');
    const { contextDev, gemini } = response.data;
    $('results').hidden = false;
    showResult('context', contextDev);
    showResult('gemini', gemini);
    const allOk = contextDev.ok && (gemini.ok || gemini.skipped);
    banner(allOk ? 'Connection test passed.' : 'Connection test found a problem — see details below.', allOk ? 'ok' : 'err');
  } catch (err) {
    banner(`Connection test failed: ${err.message}`, 'err');
  } finally {
    button.disabled = false;
    button.textContent = 'Test Connection';
  }
}

document.querySelectorAll('[data-toggle]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = $(btn.dataset.toggle);
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    btn.textContent = reveal ? 'Hide' : 'Show';
  });
});
$('reset-context').addEventListener('click', () => {
  $('context-key').value = DEFAULT_CONTEXT_DEV_KEY;
});
$('form').addEventListener('submit', (e) => save(e).catch((err) => banner(`Could not save: ${err.message}`, 'err')));
$('test').addEventListener('click', testConnection);
for (const [id, type, done] of [
  ['clear-history', MSG.CLEAR_HISTORY, 'Price history cleared.'],
  ['clear-cache', MSG.CLEAR_CACHE, 'context.dev cache cleared.']
]) {
  $(id).addEventListener('click', async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type });
      if (!response?.ok) throw new Error(response?.error || 'Service worker unavailable');
      banner(done, 'ok');
    } catch (err) {
      banner(`Could not clear: ${err.message}`, 'err');
    }
  });
}
for (const [id, key] of Object.entries(SWITCHES)) {
  $(id).addEventListener('change', async (e) => {
    await chrome.storage.local.set({ [key]: e.target.checked });
    banner(e.target.checked ? 'Turned on.' : 'Turned off.', 'ok');
  });
}

load();
