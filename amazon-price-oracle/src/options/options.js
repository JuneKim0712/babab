/**
 * Options page: manage the context.dev and Gemini keys and test connectivity.
 */
import { DEFAULT_CONTEXT_DEV_KEY, MSG, STORAGE_KEYS } from '../shared/constants.js';

const $ = (id) => document.getElementById(id);
let bannerTimer = null;

function banner(text, kind) {
  const el = $('banner');
  el.textContent = text;
  el.className = `banner ${kind}`;
  el.hidden = false;
  clearTimeout(bannerTimer);
  if (kind === 'ok') bannerTimer = setTimeout(() => (el.hidden = true), 5000);
}

function updateGeminiState(hasKey) {
  $('gemini-state').textContent = hasKey
    ? 'Status: key saved (optional). Live Gemini market data is enabled either way.'
    : 'Status: no key — fine, Gemini market data is public and still used.';
}

async function load() {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.CONTEXT_KEY, STORAGE_KEYS.GEMINI_KEY]);
  $('context-key').value = (stored[STORAGE_KEYS.CONTEXT_KEY] || '').trim() || DEFAULT_CONTEXT_DEV_KEY;
  $('gemini-key').value = (stored[STORAGE_KEYS.GEMINI_KEY] || '').trim();
  updateGeminiState(Boolean($('gemini-key').value));
}

async function save(event) {
  event.preventDefault();
  const contextKey = $('context-key').value.trim();
  const geminiKey = $('gemini-key').value.trim();

  // The shipped default is the implicit fallback, so there is no need to persist it.
  if (!contextKey || contextKey === DEFAULT_CONTEXT_DEV_KEY) {
    await chrome.storage.local.remove(STORAGE_KEYS.CONTEXT_KEY);
    $('context-key').value = DEFAULT_CONTEXT_DEV_KEY;
  } else {
    await chrome.storage.local.set({ [STORAGE_KEYS.CONTEXT_KEY]: contextKey });
  }

  if (geminiKey) {
    await chrome.storage.local.set({ [STORAGE_KEYS.GEMINI_KEY]: geminiKey });
  } else {
    await chrome.storage.local.remove(STORAGE_KEYS.GEMINI_KEY);
  }
  await chrome.storage.local.remove(STORAGE_KEYS.MACRO_CACHE);

  updateGeminiState(Boolean(geminiKey));
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
      keys: { contextDev: $('context-key').value, gemini: $('gemini-key').value }
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
$('clear-gemini').addEventListener('click', () => {
  $('gemini-key').value = '';
  banner('Gemini key cleared in the form — click Save to apply.', 'info');
});
$('form').addEventListener('submit', (e) => save(e).catch((err) => banner(`Could not save: ${err.message}`, 'err')));
$('test').addEventListener('click', testConnection);

load();
