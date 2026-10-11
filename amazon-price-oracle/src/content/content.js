/**
 * Content script entry point.
 *
 * - Parses the product page (ASIN + price) via PriceOracle.Parser.
 * - Asks the service worker for a projection (no cross-origin fetches here).
 * - Injects the widget inside a Shadow DOM host directly after the price block
 *   (or at the top of the buy box), so Amazon's CSS cannot leak in or out.
 * - Watches the product container with a MutationObserver and re-renders when a
 *   different colour/size variant changes the ASIN or price.
 */
(function (root) {
  'use strict';

  const PO = root.PriceOracle;
  if (!PO || !PO.Parser || !PO.Widget) return;
  if (root.__priceOracleLoaded) return;
  root.__priceOracleLoaded = true;

  /** Mirrors MSG in src/shared/constants.js (content scripts cannot import modules). */
  const MSG = { ANALYZE_PRODUCT: 'PO_ANALYZE_PRODUCT' };
  const HOST_ID = 'price-oracle-host';
  const DEBOUNCE_MS = 350;
  const CONTAINER_SELECTORS = ['#ppd', '#dp-container', '#centerCol', '#dp', '#a-page'];

  let host = null;
  let shadow = null;
  let signature = '';
  let requestSeq = 0;
  let observer = null;
  let observedNode = null;
  let debounceTimer = null;
  let lastParsed = null;

  function isProductPage() {
    return /\/(?:dp|gp\/product)\//i.test(location.pathname) || Boolean(document.querySelector('#ASIN'));
  }

  // -------------------------------------------------------------------------
  // Injection
  // -------------------------------------------------------------------------

  /** Find where the widget should live. Returns null if the page isn't ready. */
  function findAnchor() {
    const priceBlock = document.querySelector('#corePriceDisplay_desktop_feature_div');
    if (priceBlock) return { el: priceBlock, where: 'afterend' };

    const buybox = document.querySelector('#rightCol #buybox') || document.querySelector('#buybox');
    if (buybox) return { el: buybox, where: 'afterbegin' };

    const fallback = document.querySelector('#corePrice_feature_div, #apex_desktop, #price_feature_div');
    return fallback ? { el: fallback, where: 'afterend' } : null;
  }

  /** Create the shadow host if needed and make sure it is attached next to the price. */
  function ensureHost() {
    const anchor = findAnchor();
    if (!anchor) return false;

    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
      shadow = host.attachShadow({ mode: 'open' });
      shadow.addEventListener('click', onShadowClick);
    }

    const alreadyPlaced =
      host.isConnected &&
      (anchor.where === 'afterend' ? anchor.el.nextElementSibling === host : anchor.el.firstElementChild === host);
    if (!alreadyPlaced) anchor.el.insertAdjacentElement(anchor.where, host);
    host.style.display = '';
    return true;
  }

  function paint(state) {
    if (!ensureHost()) return;
    shadow.innerHTML = PO.Widget.render(state);
  }

  function onShadowClick(event) {
    const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!target) return;
    const action = target.getAttribute('data-action');
    if (action === 'retry' && lastParsed) {
      analyze(lastParsed, true);
    }
  }

  // -------------------------------------------------------------------------
  // Analysis
  // -------------------------------------------------------------------------

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const err = chrome.runtime.lastError;
          if (err) return reject(new Error(err.message));
          if (!response) return reject(new Error('No response from the PriceOracle service worker'));
          if (!response.ok) return reject(new Error(response.error || 'Unknown error'));
          resolve(response.data);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  async function analyze(product, forceRefresh = false) {
    const seq = ++requestSeq;
    lastParsed = product;
    paint({ status: 'loading' });
    try {
      const data = await sendMessage({
        type: MSG.ANALYZE_PRODUCT,
        payload: {
          asin: product.asin,
          price: product.price,
          listPrice: product.listPrice,
          title: product.title,
          category: product.category,
          forceRefresh
        }
      });
      if (seq !== requestSeq) return; // a newer variant was selected meanwhile
      paint({ status: 'ready', data });
    } catch (err) {
      if (seq !== requestSeq) return;
      if (/context invalidated/i.test(String(err && err.message))) return; // extension was reloaded
      paint({ status: 'error', error: err && err.message });
    }
  }

  /** Re-read the page; re-analyse only if the ASIN or price changed. */
  function refresh() {
    const product = PO.Parser.parseProduct(document);
    if (!product) {
      if (host) host.style.display = 'none';
      return;
    }
    const nextSignature = `${product.asin}|${product.price}`;
    const healthy = host && host.isConnected && host.style.display !== 'none';
    if (nextSignature === signature && healthy) return;

    if (nextSignature === signature && host && ensureHost()) return; // only re-attach (Amazon re-rendered the DOM)
    signature = nextSignature;
    analyze(product);
  }

  // -------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------

  function scheduleRefresh() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      attachObserver();
      refresh();
    }, DEBOUNCE_MS);
  }

  function findContainer() {
    for (const selector of CONTAINER_SELECTORS) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  /** Observe the main product container; fall back to <body> until it exists. */
  function attachObserver() {
    const target = findContainer() || document.body;
    if (target === observedNode && observer) return;
    if (observer) observer.disconnect();
    observedNode = target;
    observer = new MutationObserver((mutations) => {
      const relevant = mutations.some((m) => !(host && m.target instanceof Node && host.contains(m.target)));
      if (relevant) scheduleRefresh();
    });
    observer.observe(target, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['value'] });
  }

  function init() {
    if (!isProductPage()) return;
    attachObserver();
    refresh();
    window.addEventListener('popstate', scheduleRefresh);
    window.addEventListener('pageshow', scheduleRefresh);
  }

  init();
})(globalThis);
