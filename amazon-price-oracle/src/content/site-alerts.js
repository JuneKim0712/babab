/**
 * Content script for the PriceOracle website (https://xylm-306e6.web.app).
 *
 * On /alerts it adds the price alerts set in this extension to the page, in a section right under the alerts
 * the site already lists. The site is a client-rendered Next.js app that keeps its own list in React state, so
 * nothing is written into its data: this script renders extra cards in the page and talks to the extension's
 * service worker for pause / re-arm / change target / delete. The page's own alerts are never touched.
 *
 * Cards reuse the Tailwind classes the alerts page already ships (the page's stylesheet is purged, so only
 * classes seen in the page's own markup are used) and every string is set with textContent.
 * The site is a single-page app: navigating to /alerts does not reload the page, so the route is watched.
 */
(function (root) {
  'use strict';

  const PO = root.PriceOracle;
  if (!PO || !PO.send) return;
  if (root.__priceOracleSiteLoaded) return;
  root.__priceOracleSiteLoaded = true;

  const MSG = { ALERT_LIST: 'PO_ALERT_LIST', ALERT_UPDATE: 'PO_ALERT_UPDATE', ALERT_REMOVE: 'PO_ALERT_REMOVE' };
  const SECTION_ID = 'price-oracle-extension-alerts';
  /** React hydrates the page after load; adding nodes earlier would make it discard them. */
  const SETTLE_MS = 900;

  const BTN = 'px-3 py-1.5 rounded-xl text-xs font-bold transition border border-slate-200 text-slate-600 hover:bg-slate-50';
  const BTN_ON = 'px-3 py-1.5 rounded-xl text-xs font-bold transition border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100';
  const BTN_DANGER = 'px-3 py-1.5 rounded-xl text-xs font-bold transition border border-slate-200 text-slate-400 hover:text-rose-600 hover:border-rose-200 hover:bg-rose-50';
  const BADGE = 'text-[10px] font-bold px-2 py-0.5 rounded-full uppercase border ';

  let alerts = [];
  let email = '';
  let editingId = null;
  let draft = '';
  let errorText = '';
  let errorAsin = '';
  let settled = false;
  let timer = null;

  const usd = (n) => `$${Number(n).toFixed(2)}`;
  const isAlertsRoute = () => /^\/alerts\/?$/.test(location.pathname);

  function h(tag, className, text, attrs) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined && text !== null) el.textContent = text;
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    return el;
  }

  function ago(ts) {
    const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
  }

  async function act(type, payload) {
    errorText = '';
    try {
      await PO.send({ type, payload });
    } catch (err) {
      errorText = err && err.message ? err.message : 'Something went wrong.';
    }
    await load();
  }

  function card(alert) {
    const wrap = h('div', 'bg-white rounded-2xl border border-slate-200 p-5 shadow-sm hover:shadow-md transition flex flex-col md:flex-row md:items-center justify-between gap-4', null, {
      'data-po-alert': alert.asin
    });
    const info = h('div', 'flex-1');

    const tags = h('div', 'flex items-center space-x-2 mb-2');
    tags.append(h('span', 'text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 uppercase', `asin: ${alert.asin}`));
    const reached = alert.status === 'triggered';
    const on = alert.status === 'active';
    tags.append(
      h('span', `${BADGE}${on || reached ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-500 border-slate-200'}`, reached ? 'target reached' : alert.status, {
        'data-po-status': alert.status
      })
    );
    tags.append(h('span', `${BADGE}bg-teal-50 text-teal-700 border-teal-200`, 'Set in extension'));
    info.append(tags);

    if (editingId === alert.id) {
      const row = h('div', 'flex flex-col sm:flex-row gap-2 my-2');
      const input = h('input', 'px-3 py-1.5 border border-slate-300 rounded-xl text-sm font-semibold w-32', null, {
        type: 'number',
        step: '0.01',
        min: '0.01',
        placeholder: 'Target $',
        'aria-label': 'Target price in US dollars',
        'data-po-field': 'target'
      });
      input.value = draft;
      input.addEventListener('input', () => (draft = input.value));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') save(alert);
        if (e.key === 'Escape') cancelEdit();
      });
      const saveBtn = h('button', 'px-3 py-1.5 bg-emerald-600 text-white rounded-xl font-bold text-xs', 'Save', { type: 'button', 'data-po-action': 'save' });
      saveBtn.addEventListener('click', () => save(alert));
      const cancel = h('button', BTN, 'Cancel', { type: 'button' });
      cancel.addEventListener('click', cancelEdit);
      row.append(input, saveBtn, cancel);
      info.append(row);
    } else {
      const link = h('a', 'font-extrabold text-base text-slate-900', alert.title || `Amazon item ${alert.asin}`, {
        href: `https://www.amazon.com/dp/${encodeURIComponent(alert.asin)}`,
        target: '_blank',
        rel: 'noreferrer'
      });
      link.style.display = 'block';
      const heading = h('h3');
      heading.append(link);
      info.append(heading);

      const meta = h('div', 'mt-1 flex flex-wrap items-center gap-4 text-xs text-slate-500 font-medium');
      const stat = (label, value, strong) => {
        const span = h('span', null, `${label}: `);
        span.append(h('strong', strong, value));
        return span;
      };
      if (alert.priceAtCreation) meta.append(stat('Initial', usd(alert.priceAtCreation)));
      meta.append(stat('Target', usd(alert.targetPrice), 'text-emerald-700 font-bold'));
      if (reached) meta.append(stat('Reached at', usd(alert.triggeredPrice || alert.targetPrice)));
      else if (alert.lastPrice) meta.append(stat('Last seen', `${usd(alert.lastPrice)}${alert.lastCheckedAt ? ` (${ago(alert.lastCheckedAt)})` : ''}`));
      meta.append(stat('Notify', email ? `Chrome and ${email}` : 'Chrome notification'));
      info.append(meta);
    }
    if (errorText && (editingId === alert.id || alert.asin === errorAsin)) {
      const err = h('p', 'text-xs font-bold', errorText, { role: 'alert' });
      err.style.color = '#b12704';
      info.append(err);
    }

    const actions = h('div', 'flex items-center space-x-2 shrink-0 pt-3 md:pt-0 border-t md:border-t-0 border-slate-100');
    const toggle = h('button', on ? BTN : BTN_ON, on ? 'Pause' : reached ? 'Re-arm' : 'Resume', { type: 'button', 'data-po-action': 'toggle' });
    toggle.addEventListener('click', () => {
      errorAsin = alert.asin;
      act(MSG.ALERT_UPDATE, { alertId: alert.id, status: on ? 'paused' : 'active' });
    });
    const edit = h('button', BTN, 'Edit', { type: 'button', 'data-po-action': 'edit', title: 'Edit threshold' });
    edit.addEventListener('click', () => {
      editingId = alert.id;
      draft = String(alert.targetPrice);
      errorText = '';
      render();
      document.querySelector(`#${SECTION_ID} [data-po-field="target"]`)?.focus();
    });
    const del = h('button', BTN_DANGER, 'Delete', { type: 'button', 'data-po-action': 'delete', title: 'Delete alert' });
    del.addEventListener('click', () => {
      errorAsin = alert.asin;
      act(MSG.ALERT_REMOVE, { alertId: alert.id });
    });
    actions.append(toggle, edit, del);

    wrap.append(info, actions);
    return wrap;
  }

  function cancelEdit() {
    editingId = null;
    errorText = '';
    render();
  }

  async function save(alert) {
    errorAsin = alert.asin;
    errorText = '';
    try {
      await PO.send({ type: MSG.ALERT_UPDATE, payload: { alertId: alert.id, targetPrice: draft, toggleOnly: true } });
      editingId = null;
    } catch (err) {
      errorText = err && err.message ? err.message : 'Could not save.';
    }
    await load();
  }

  function section() {
    const el = h('section', 'mt-8', null, { id: SECTION_ID, 'aria-label': 'Alerts set in the PriceOracle extension' });
    const head = h('div', 'flex items-center space-x-2 text-emerald-600 font-bold text-xs uppercase tracking-wider mb-3');
    head.append(h('span', null, `Set in your PriceOracle extension (${alerts.length})`));
    const grid = h('div', 'grid grid-cols-1 gap-4');
    for (const alert of alerts) grid.append(card(alert));
    el.append(head, grid);
    return el;
  }

  /** (Re)build the section. Keeps a half-typed target when a refresh arrives mid-edit. */
  function render() {
    const existing = document.getElementById(SECTION_ID);
    if (!isAlertsRoute() || !settled || !alerts.length) {
      existing?.remove();
      return;
    }
    const main = document.querySelector('main');
    if (!main || main.children.length < 2) return;
    const hadFocus = Boolean(editingId && existing?.contains(document.activeElement));
    const next = section();
    if (existing) existing.replaceWith(next);
    else main.append(next);
    if (hadFocus) next.querySelector('[data-po-field="target"]')?.focus();
  }

  async function load() {
    try {
      const overview = await PO.send({ type: MSG.ALERT_LIST });
      alerts = overview.alerts;
      email = overview.email || '';
    } catch (err) {
      if (/context invalidated/i.test(String(err && err.message))) return;
      alerts = [];
    }
    if (editingId && !alerts.some((a) => a.id === editingId)) editingId = null;
    render();
  }

  /** The page can re-render and drop the section, or move between routes without a reload. */
  function watch() {
    const check = () => {
      timer = null;
      const existing = document.getElementById(SECTION_ID);
      if (!isAlertsRoute()) return existing?.remove();
      const main = document.querySelector('main');
      if (alerts.length && settled && main && (!existing || existing.parentElement !== main)) render();
      else if (existing && main && main.lastElementChild !== existing && !editingId) main.append(existing);
      return undefined;
    };
    new MutationObserver(() => {
      if (!timer) timer = setTimeout(check, 150);
    }).observe(document.body, { childList: true, subtree: true });
  }

  function start() {
    watch();
    load();
    setTimeout(() => {
      settled = true;
      render();
    }, document.readyState === 'complete' ? SETTLE_MS : SETTLE_MS * 2);
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && ('price_alerts' in changes || 'alert_email' in changes)) load();
      });
    } catch {
      /* extension was reloaded; nothing to watch */
    }
  }

  start();
})(globalThis);
