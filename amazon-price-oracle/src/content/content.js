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
  if (!PO || !PO.Parser || !PO.Widget || !PO.send || !PO.settings) return;
  if (root.__priceOracleLoaded) return;
  root.__priceOracleLoaded = true;

  /** Mirrors MSG in src/shared/constants.js (content scripts cannot import modules). */
  const MSG = {
    ANALYZE_PRODUCT: 'PO_ANALYZE_PRODUCT',
    OPEN_OPTIONS: 'PO_OPEN_OPTIONS',
    ALERT_STATE: 'PO_ALERT_STATE',
    ALERT_SET: 'PO_ALERT_SET',
    ALERT_REMOVE: 'PO_ALERT_REMOVE'
  };
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
  let cardState = { status: 'loading' };
  let alertView = null;
  let enabled = false;

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

    const fallback = document.querySelector('#corePrice_feature_div, #apex_desktop, #apex_offerDisplay_desktop, #price_feature_div');
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
      shadow.addEventListener('keydown', onShadowKey);
      shadow.addEventListener('keyup', onShadowKey);
      shadow.addEventListener('keypress', onShadowKey);
    }

    const alreadyPlaced =
      host.isConnected &&
      (anchor.where === 'afterend' ? anchor.el.nextElementSibling === host : anchor.el.firstElementChild === host);
    if (!alreadyPlaced) anchor.el.insertAdjacentElement(anchor.where, host);
    host.style.display = '';
    return true;
  }

  function paint(state) {
    cardState = state;
    if (!ensureHost()) return;
    shadow.innerHTML = PO.Widget.render(state.status === 'ready' ? { ...state, alert: alertView } : state);
  }

  function onShadowClick(event) {
    const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!target) return;
    const action = target.getAttribute('data-action');
    if (action === 'retry' && lastParsed) analyze(lastParsed, true);
    else if (action === 'alert-connect') sendMessage({ type: MSG.OPEN_OPTIONS }).catch(() => {});
    else if (action === 'alert-retry') loadAlert();
    else if (action === 'alert-save') saveAlert(false);
    else if (action === 'alert-toggle') saveAlert(true);
    else if (action === 'alert-remove') removeAlert();
  }

  /** Keep typing in the target field from triggering Amazon's keyboard shortcuts; Enter saves. */
  function onShadowKey(event) {
    if (!(event.target instanceof Element) || !event.target.matches('[data-field="alert-target"]')) return;
    event.stopPropagation();
    if (event.type === 'keydown' && event.key === 'Enter') saveAlert(false);
  }

  // -------------------------------------------------------------------------
  // Price alerts (stored on the PriceOracle website; the worker does the talking)
  // -------------------------------------------------------------------------

  const readTarget = () => shadow?.querySelector('[data-field="alert-target"]')?.value ?? '';
  const isSignedOutError = (err) => /sign-in expired/i.test(String(err && err.message));

  function setAlertView(patch) {
    alertView = { ...alertView, ...patch };
    if (cardState.status === 'ready') paint(cardState);
  }

  async function loadAlert() {
    if (!lastParsed || cardState.status !== 'ready') return;
    const { asin } = lastParsed;
    const seq = requestSeq;
    const suggested = PO.Widget.suggestTarget(cardState.data.projection.currentPrice, cardState.data.projection.tiers.low);
    alertView = { phase: 'loading', suggested };
    paint(cardState);
    try {
      const res = await sendMessage({ type: MSG.ALERT_STATE, asin });
      if (seq !== requestSeq) return;
      alertView =
        res.state === 'ready'
          ? { phase: 'ready', alert: res.alert, email: res.email, suggested }
          : { phase: res.state, error: res.error, expired: res.expired, suggested };
    } catch (err) {
      if (seq !== requestSeq || /context invalidated/i.test(String(err && err.message))) return;
      alertView = { phase: 'error', error: err && err.message, suggested };
    }
    paint(cardState);
  }

  async function saveAlert(toggle) {
    if (!lastParsed || alertView?.phase !== 'ready' || alertView.busy) return;
    const existing = alertView.alert;
    const typed = readTarget();
    setAlertView({ busy: true, error: '', draft: typed });
    const seq = requestSeq;
    try {
      const alert = await sendMessage({
        type: MSG.ALERT_SET,
        payload: {
          asin: lastParsed.asin,
          title: lastParsed.title,
          currentPrice: lastParsed.price,
          targetPrice: toggle ? existing.targetPrice : typed,
          enabled: toggle ? !existing.enabled : existing ? existing.enabled : true,
          toggleOnly: Boolean(toggle)
        }
      });
      if (seq !== requestSeq) return;
      setAlertView({ busy: false, alert, draft: undefined });
    } catch (err) {
      if (seq !== requestSeq) return;
      if (isSignedOutError(err)) return loadAlert();
      setAlertView({ busy: false, error: err && err.message });
    }
  }

  async function removeAlert() {
    if (!lastParsed || alertView?.phase !== 'ready' || alertView.busy) return;
    setAlertView({ busy: true, error: '' });
    const seq = requestSeq;
    try {
      await sendMessage({ type: MSG.ALERT_REMOVE, asin: lastParsed.asin });
      if (seq !== requestSeq) return;
      setAlertView({ busy: false, alert: null, draft: undefined });
    } catch (err) {
      if (seq !== requestSeq) return;
      if (isSignedOutError(err)) return loadAlert();
      setAlertView({ busy: false, error: err && err.message });
    }
  }

  /** Signing in (or out) from Settings in another tab updates open product pages. */
  function watchSiteSession() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && ('site_session' in changes || 'site_url' in changes) && enabled) loadAlert();
      });
    } catch {
      /* extension was reloaded; nothing to watch */
    }
  }

  // -------------------------------------------------------------------------
  // Analysis
  // -------------------------------------------------------------------------

  const sendMessage = (message) => PO.send(message);

  async function analyze(product, forceRefresh = false) {
    const seq = ++requestSeq;
    lastParsed = product;
    alertView = null;
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
      loadAlert();
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
      if (!enabled) return;
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

  function enable() {
    if (enabled) return;
    enabled = true;
    attachObserver();
    refresh();
  }

  /** Remove the card and stop watching the page (the "show card" switch was turned off). */
  function disable() {
    enabled = false;
    clearTimeout(debounceTimer);
    if (observer) observer.disconnect();
    observer = null;
    observedNode = null;
    requestSeq++; // drop any response still in flight
    signature = '';
    if (host) host.remove();
  }

  async function init() {
    if (!isProductPage()) return;
    window.addEventListener('popstate', scheduleRefresh);
    window.addEventListener('pageshow', scheduleRefresh);
    watchSiteSession();
    PO.settings.watch('productCard', (on) => (on ? enable() : disable()));
    if (await PO.settings.get('productCard')) enable();
  }

  init();
})(globalThis);
