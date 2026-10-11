/**
 * Search-results content script.
 *
 * On amazon.com/s?... pages, adds a compact PriceOracle chip under the price of
 * every result card: a verdict (WAIT / BUY NOW / FAIR PRICE) and the 30-day
 * change. Clicking the chip expands the five projected price tiers.
 *
 * Search analyses are "light": the service worker never spends context.dev
 * credits for them, it only reuses cached data. The expanded panel offers an
 * explicit "Deep analysis" button that runs the full pipeline for one product.
 *
 * - Cards are analysed lazily as they approach the viewport (IntersectionObserver),
 *   at most MAX_CONCURRENT at a time.
 * - Each chip lives in its own Shadow DOM host so Amazon's CSS cannot leak in or out.
 * - A debounced MutationObserver picks up lazily loaded cards and re-renders cards
 *   whose price changed.
 */
(function (root) {
  'use strict';

  const PO = root.PriceOracle;
  if (!PO || !PO.Parser || !PO.Widget || !PO.send || !PO.settings) return;
  if (!PO.Parser.isSearchPage(location)) return;
  if (root.__priceOracleSearchLoaded) return;
  root.__priceOracleSearchLoaded = true;

  /** Mirrors MSG in src/shared/constants.js (content scripts cannot import modules). */
  const MSG = { ANALYZE_PRODUCT: 'PO_ANALYZE_PRODUCT', ALERT_LIST: 'PO_ALERT_LIST' };
  const HOST_ATTR = 'data-price-oracle-chip';
  const MAX_CONCURRENT = 4;
  const DEBOUNCE_MS = 300;
  const VIEWPORT_MARGIN = '400px 0px';

  /** @type {WeakMap<Element, CardState>} */
  let cards = new WeakMap();
  const queue = [];
  let active = 0;
  let debounceTimer = null;
  let intersection = null;
  let mutationObserver = null;
  let observedRoot = null;
  let enabled = false;
  /** The user's local price alerts by ASIN; shown as a bell on the chips. */
  let alertsByAsin = new Map();

  /**
   * @typedef {Object} CardState
   * @property {HTMLElement} host
   * @property {ShadowRoot} shadow
   * @property {string} signature   asin|price|category the current result belongs to
   * @property {Object} product
   * @property {{status: string, data?: any, error?: string, expanded?: boolean, deepLoading?: boolean}} view
   * @property {number} seq         guards against out-of-order responses
   * @property {boolean} queued
   * @property {boolean} [analysed]  analysis was requested (set when the card first nears the viewport)
   */

  const sendMessage = (message) => PO.send(message);

  // -------------------------------------------------------------------------
  // Placement and rendering
  // -------------------------------------------------------------------------

  /** Element the chip goes after: the price row of the card. */
  function findAnchor(card) {
    const price = PO.Parser.getSearchPriceBox(card);
    if (!price) return null;
    return price.closest('[data-cy="price-recipe"]') || price.closest('.a-row') || price.parentElement;
  }

  function paint(state) {
    state.shadow.innerHTML = PO.Widget.renderChip({ ...state.view, alert: alertsByAsin.get(state.product.asin) });
  }

  function place(card, state) {
    const anchor = findAnchor(card);
    if (!anchor) return false;
    if (state.host.previousElementSibling !== anchor || !state.host.isConnected) {
      anchor.insertAdjacentElement('afterend', state.host);
    }
    return true;
  }

  function createState(card, product, signature) {
    const host = document.createElement('div');
    host.setAttribute(HOST_ATTR, '');
    const shadow = host.attachShadow({ mode: 'open' });
    /** @type {CardState} */
    const state = { host, shadow, signature, product, view: { status: 'loading' }, seq: 0, queued: false };
    shadow.addEventListener('click', (event) => onClick(card, state, event));
    shadow.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.view.expanded) {
        state.view = { ...state.view, expanded: false };
        paint(state);
        shadow.querySelector('.pc-chip')?.focus();
      }
    });
    cards.set(card, state);
    return state;
  }

  // -------------------------------------------------------------------------
  // Analysis
  // -------------------------------------------------------------------------

  function payload(state, extra) {
    const { product } = state;
    return {
      asin: product.asin,
      price: product.price,
      listPrice: product.listPrice,
      title: product.title,
      category: product.category,
      ...extra
    };
  }

  async function runAnalysis(state, { deep }) {
    const seq = ++state.seq;
    if (deep) {
      state.view = { ...state.view, deepLoading: true };
    } else {
      state.view = { status: 'loading' };
    }
    paint(state);
    try {
      const data = await sendMessage({ type: MSG.ANALYZE_PRODUCT, payload: payload(state, { light: !deep }) });
      if (seq !== state.seq) return;
      state.view = { status: 'ready', data, expanded: Boolean(state.view.expanded) || deep };
    } catch (err) {
      if (seq !== state.seq) return;
      if (/context invalidated/i.test(String(err && err.message))) return;
      state.view = deep && state.view.data
        ? { ...state.view, deepLoading: false }
        : { status: 'error', error: err && err.message };
    }
    paint(state);
  }

  function pump() {
    while (active < MAX_CONCURRENT && queue.length) {
      const state = queue.shift();
      state.queued = false;
      active++;
      runAnalysis(state, { deep: false }).finally(() => {
        active--;
        pump();
      });
    }
  }

  function enqueue(state) {
    if (state.queued) return;
    state.queued = true;
    queue.push(state);
    pump();
  }

  /** Re-rendering replaces the button, so hand keyboard focus back to the new one. */
  function focusChip(state) {
    state.shadow.querySelector('.pc-chip')?.focus({ preventScroll: true });
  }

  function onClick(card, state, event) {
    const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    const action = target.getAttribute('data-action');
    if (action === 'toggle' && state.view.status === 'ready') {
      state.view = { ...state.view, expanded: !state.view.expanded };
      paint(state);
      focusChip(state);
    } else if (action === 'retry') {
      enqueue(state);
    } else if (action === 'deep' && !state.view.deepLoading) {
      runAnalysis(state, { deep: true });
    }
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /** One request per page, refreshed when alerts change. Silent on failure: the chips just have no bell. */
  async function loadAlerts() {
    try {
      const overview = await sendMessage({ type: MSG.ALERT_LIST });
      alertsByAsin = new Map(overview.alerts.map((a) => [a.asin, a]));
    } catch {
      return;
    }
    if (!enabled) return;
    for (const card of PO.Parser.getSearchCards(document)) {
      const state = cards.get(card);
      if (state) paint(state);
    }
  }

  function watchAlerts() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && 'price_alerts' in changes && enabled) loadAlerts();
      });
    } catch {
      /* extension was reloaded; nothing to watch */
    }
  }

  function ensureIntersection() {
    if (intersection || typeof IntersectionObserver === 'undefined') return;
    intersection = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          intersection.unobserve(entry.target);
          const state = cards.get(entry.target);
          if (state && state.view.status === 'loading' && !state.analysed) {
            state.analysed = true;
            enqueue(state);
          }
        }
      },
      { rootMargin: VIEWPORT_MARGIN }
    );
  }

  /** Make sure every card with a price has a chip, and re-analyse cards whose price changed. */
  function scan() {
    const category = PO.Parser.getSearchCategory(document, location);
    for (const card of PO.Parser.getSearchCards(document)) {
      const product = PO.Parser.parseSearchCard(card);
      const existing = cards.get(card);

      if (!product) {
        if (existing) existing.host.remove();
        continue;
      }
      product.category = category;
      const signature = `${product.asin}|${product.price}|${category}`;

      if (existing && existing.signature === signature) {
        place(card, existing); // re-attach if Amazon re-rendered the card
        continue;
      }

      if (existing) existing.host.remove();
      const state = createState(card, product, signature);
      if (!place(card, state)) continue;
      paint(state);
      if (intersection) {
        intersection.observe(card);
      } else {
        state.analysed = true;
        enqueue(state);
      }
    }
  }

  function scheduleScan() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (!enabled) return;
      attachObserver();
      scan();
    }, DEBOUNCE_MS);
  }

  function findResultsRoot() {
    return document.querySelector('.s-main-slot') || document.querySelector('#search') || document.body;
  }

  function isOurs(node) {
    return node instanceof Element && node.hasAttribute(HOST_ATTR);
  }

  /** Observe the results grid; Amazon swaps it out when filters or pages change. */
  function attachObserver() {
    const target = findResultsRoot();
    if (target === observedRoot && mutationObserver) return;
    if (mutationObserver) mutationObserver.disconnect();
    observedRoot = target;
    mutationObserver = new MutationObserver((mutations) => {
      const relevant = mutations.some((m) => {
        if (isOurs(m.target)) return false;
        const touched = [...m.addedNodes, ...m.removedNodes];
        return !(touched.length > 0 && touched.every(isOurs));
      });
      if (relevant) scheduleScan();
    });
    mutationObserver.observe(target, { childList: true, subtree: true });
  }

  function enable() {
    if (enabled) return;
    enabled = true;
    ensureIntersection();
    attachObserver();
    scan();
    loadAlerts();
  }

  /** Remove every chip and stop watching the page (the "show chips" switch was turned off). */
  function disable() {
    enabled = false;
    clearTimeout(debounceTimer);
    if (mutationObserver) mutationObserver.disconnect();
    mutationObserver = null;
    observedRoot = null;
    if (intersection) intersection.disconnect();
    intersection = null;
    queue.length = 0;
    cards = new WeakMap(); // pending responses then paint into detached hosts
    document.querySelectorAll(`[${HOST_ATTR}]`).forEach((el) => el.remove());
  }

  async function init() {
    window.addEventListener('popstate', scheduleScan);
    window.addEventListener('pageshow', scheduleScan);
    watchAlerts();
    PO.settings.watch('searchChips', (on) => (on ? enable() : disable()));
    if (await PO.settings.get('searchChips')) enable();
  }

  init();
})(globalThis);
