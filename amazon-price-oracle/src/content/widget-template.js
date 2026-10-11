/**
 * Widget markup and isolated CSS.
 *
 * Classic content script. Exposes `globalThis.PriceOracle.Widget` with:
 *   - STYLES: CSS string injected inside the shadow root (Amazon CSS cannot leak in)
 *   - render(state): HTML string for the card
 *
 * state = { status: 'loading' }
 *       | { status: 'error', error: string }
 *       | { status: 'ready', data: AnalysisResult }   (see service-worker.js)
 *
 * Interactive elements carry `data-action` attributes ("retry");
 * content.js wires a single delegated click listener.
 */
(function (root) {
  'use strict';

  const PO = (root.PriceOracle = root.PriceOracle || {});

  const STYLES = `
    :host { all: initial; display: block; }
    *, *::before, *::after { box-sizing: border-box; }
    .po-wrap { container-type: inline-size; margin: 12px 0; }
    .po-card {
      font-family: "Amazon Ember", -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
      font-size: 13px; line-height: 1.4; color: #0f172a;
      /* The host element lives in Amazon's DOM, so re-assert every inheritable property. */
      font-style: normal; font-weight: 400; letter-spacing: normal; word-spacing: normal;
      text-transform: none; text-align: left; text-shadow: none; white-space: normal; direction: ltr;
      background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06), 0 4px 14px rgba(15, 23, 42, 0.05);
      overflow: hidden;
    }
    .po-section { padding: 12px 16px; border-top: 1px solid #eef2f7; }
    .po-section:first-child { border-top: 0; }
    .po-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;
      background: linear-gradient(180deg, #f8fafc, #f1f5f9); }
    .po-title { font-weight: 800; letter-spacing: 0.08em; font-size: 12px; color: #0f172a; display: flex; align-items: center; gap: 6px; }
    .po-bolt { font-size: 14px; }
    .po-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; padding: 3px 9px;
      border-radius: 999px; background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; white-space: nowrap; }
    .po-chip .po-dot { width: 7px; height: 7px; border-radius: 50%; background: #10b981; }
    .po-chip.warn { background: #fffbeb; color: #b45309; border-color: #fde68a; }
    .po-chip.warn .po-dot { background: #f59e0b; }

    .po-label { font-size: 10.5px; font-weight: 700; letter-spacing: 0.1em; color: #64748b; text-transform: uppercase; margin-bottom: 8px; }
    .po-reco { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; }
    .po-pill { display: inline-flex; align-items: center; gap: 8px; font-weight: 700; font-size: 14px; padding: 8px 14px;
      border-radius: 10px; border: 1px solid transparent; }
    .po-pill .po-pill-label { font-weight: 800; letter-spacing: 0.04em; }
    .po-pill .po-pill-sep { opacity: 0.5; }
    .po-pill .po-pill-msg { font-weight: 600; }
    .po-pill.WAIT { background: #FEF2F2; color: #DC2626; border-color: #fca5a5; }
    .po-pill.BUY_NOW { background: #ECFDF5; color: #059669; border-color: #a7f3d0; }
    .po-pill.FAIR_PRICE { background: #F1F5F9; color: #334155; border-color: #cbd5e1; }
    .po-confidence { font-size: 12px; color: #64748b; font-weight: 600; }

    .po-tier-grid { display: grid; grid-template-columns: repeat(5, 1fr); text-align: center; margin-bottom: 6px; }
    .po-tier-price { font-size: 13px; font-weight: 800; font-variant-numeric: tabular-nums; color: #0f172a; }
    .po-tier-name { font-size: 9.5px; font-weight: 700; letter-spacing: 0.08em; color: #64748b; margin-top: 1px; }
    .po-tier.mid .po-tier-price { color: #4338ca; }
    .po-tier.mid .po-tier-name { color: #4338ca; }
    .po-bar { position: relative; height: 46px; margin-top: 2px; }
    .po-track { position: absolute; left: 3%; right: 3%; top: 10px; height: 8px; border-radius: 999px;
      background: linear-gradient(90deg, #6ee7b7 0%, #d5dde8 50%, #fca5a5 100%); }
    .po-tick { position: absolute; top: 5px; width: 2px; height: 18px; margin-left: -1px; border-radius: 2px; background: #94a3b8; }
    .po-tick.mid { background: #4338ca; width: 3px; margin-left: -1.5px; top: 3px; height: 22px; }
    .po-pin { position: absolute; top: 4px; width: 20px; height: 20px; margin-left: -10px; border-radius: 50%;
      background: #0f172a; border: 3px solid #ffffff; box-shadow: 0 0 0 2px #0f172a, 0 2px 6px rgba(15,23,42,.35); }
    .po-pin-label { position: absolute; top: 28px; transform: translateX(-50%); white-space: nowrap; font-size: 11.5px;
      font-weight: 700; color: #0f172a; background: #f1f5f9; border: 1px solid #e2e8f0; padding: 1px 8px; border-radius: 6px; }
    .po-pin-label.edge-left { transform: translateX(-12%); }
    .po-pin-label.edge-right { transform: translateX(-88%); }

    .po-foot { display: grid; gap: 6px; background: #fafbfc; }
    .po-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; }
    .po-row strong { font-weight: 700; }
    .po-delta.down { color: #dc2626; font-weight: 700; }
    .po-delta.up { color: #059669; font-weight: 700; }
    .po-delta.flat { color: #334155; font-weight: 700; }
    .po-note { font-size: 11px; color: #64748b; }
    .po-btn { font: inherit; font-size: 11.5px; font-weight: 600; cursor: pointer; border-radius: 999px; padding: 3px 10px;
      border: 1px solid #c7d2fe; background: #eef2ff; color: #4338ca; text-align: left; }
    button.po-btn:hover { background: #e0e7ff; }
    .po-btn:focus-visible { outline: 2px solid #6366f1; outline-offset: 2px; }
    span.po-btn { cursor: default; }
    .po-btn.ok { background: #ecfdf5; border-color: #a7f3d0; color: #047857; }
    .po-btn.err { background: #fffbeb; border-color: #fde68a; color: #b45309; }

    .po-skel { border-radius: 8px; background: linear-gradient(90deg, #eef2f7 25%, #f8fafc 50%, #eef2f7 75%);
      background-size: 200% 100%; animation: po-shimmer 1.2s linear infinite; }
    @keyframes po-shimmer { to { background-position: -200% 0; } }
    .po-error { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; color: #7f1d1d; }
    @media (prefers-reduced-motion: reduce) { .po-skel { animation: none; } }
    @container (max-width: 380px) {
      .po-tier-price { font-size: 11px; }
      .po-tier-name { font-size: 8.5px; letter-spacing: 0.04em; }
      .po-pill { font-size: 13px; padding: 7px 10px; }
    }
  `;

  const TIER_ORDER = [
    ['lowest', 'LOWEST'],
    ['low', 'LOW'],
    ['mid', 'MID'],
    ['high', 'HIGH'],
    ['highest', 'HIGHEST']
  ];
  /** Horizontal centre (%) of each of the five tier columns. */
  const TICK_POSITIONS = [10, 30, 50, 70, 90];

  const escapeHtml = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const usd = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

  /**
   * Position (%) of the current price along the five ticks. Interpolates
   * piecewise between neighbouring tiers; extrapolates (clamped) outside them.
   * @param {number} price
   * @param {number[]} tierValues ascending
   */
  function pinPosition(price, tierValues) {
    const first = tierValues[0];
    const last = tierValues[tierValues.length - 1];
    if (price <= first) {
      const span = tierValues[1] - first || 1;
      return Math.max(3, TICK_POSITIONS[0] - ((first - price) / span) * 20);
    }
    if (price >= last) {
      const span = last - tierValues[tierValues.length - 2] || 1;
      return Math.min(97, TICK_POSITIONS[4] + ((price - last) / span) * 20);
    }
    for (let i = 0; i < tierValues.length - 1; i++) {
      const a = tierValues[i];
      const b = tierValues[i + 1];
      if (price >= a && price <= b) {
        const t = b === a ? 0 : (price - a) / (b - a);
        return TICK_POSITIONS[i] + t * (TICK_POSITIONS[i + 1] - TICK_POSITIONS[i]);
      }
    }
    return 50;
  }

  function renderHeader(chipHtml) {
    return `
      <div class="po-section po-head">
        <div class="po-title"><span class="po-bolt" aria-hidden="true">⚡</span> PRICE TIMING ORACLE</div>
        ${chipHtml}
      </div>`;
  }

  function renderContextChip(context) {
    if (!context) return '';
    if (context.status === 'error') {
      return `<span class="po-chip warn" title="${escapeHtml(context.error || 'context.dev unavailable')}"><i class="po-dot"></i>context.dev: Offline — using page data</span>`;
    }
    const suffix = context.fromCache ? ' (cached)' : '';
    return `<span class="po-chip" title="${context.signalCount} pricing signals"><i class="po-dot"></i>context.dev: Connected${suffix}</span>`;
  }

  function renderGeminiStatus(gemini) {
    if (gemini.status === 'live') {
      const detail = gemini.summary ? ` — ${escapeHtml(gemini.summary)}` : '';
      const stale = gemini.stale ? ' (cached)' : '';
      return `<span class="po-btn ok" title="${escapeHtml(gemini.rationale)}">Gemini Markets: Live${stale}${detail}</span>`;
    }
    return `<span class="po-btn err" title="${escapeHtml(gemini.error || '')}">Gemini Markets: Offline — running on heuristic model</span>`;
  }

  function renderReady({ projection, meta }) {
    const { tiers, recommendation, deltaPercentMonth, deltaAmount, currentPrice, confidence } = projection;
    const values = TIER_ORDER.map(([key]) => tiers[key]);
    const pin = pinPosition(currentPrice, values);
    const edgeClass = pin < 16 ? ' edge-left' : pin > 84 ? ' edge-right' : '';

    const tierCells = TIER_ORDER.map(
      ([key, label]) => `
        <div class="po-tier ${key === 'mid' ? 'mid' : ''}">
          <div class="po-tier-price">${usd(tiers[key])}</div>
          <div class="po-tier-name">${label}</div>
        </div>`
    ).join('');

    const ticks = TICK_POSITIONS.map((p, i) => `<span class="po-tick ${i === 2 ? 'mid' : ''}" style="left:${p}%"></span>`).join('');

    const dir = deltaPercentMonth <= -0.05 ? 'down' : deltaPercentMonth >= 0.05 ? 'up' : 'flat';
    const arrow = dir === 'down' ? '▼' : dir === 'up' ? '▲' : '▬';
    const sign = deltaAmount > 0 ? '+' : deltaAmount < 0 ? '-' : '';
    const pct = `${deltaPercentMonth > 0 ? '+' : ''}${deltaPercentMonth.toFixed(1)}%`;
    const expected = dir === 'flat' ? 'no meaningful change expected' : `${sign}${usd(Math.abs(deltaAmount))} expected`;

    return `
      ${renderHeader(renderContextChip(meta.context))}
      <div class="po-section">
        <div class="po-label">Recommendation</div>
        <div class="po-reco">
          <div class="po-pill ${escapeHtml(recommendation.action)}" role="status">
            <span class="po-pill-label">${escapeHtml(recommendation.label)}</span>
            <span class="po-pill-sep">—</span>
            <span class="po-pill-msg">${escapeHtml(recommendation.message)}</span>
          </div>
          <span class="po-confidence">(${confidence}% confidence)</span>
        </div>
      </div>
      <div class="po-section">
        <div class="po-label">30-day projected price tiers</div>
        <div class="po-tier-grid">${tierCells}</div>
        <div class="po-bar" role="img" aria-label="Current price ${usd(currentPrice)} relative to the projected price tiers">
          <div class="po-track"></div>
          ${ticks}
          <span class="po-pin" style="left:${pin.toFixed(1)}%"></span>
          <span class="po-pin-label${edgeClass}" style="left:${pin.toFixed(1)}%">Current: ${usd(currentPrice)}</span>
        </div>
      </div>
      <div class="po-section po-foot">
        <div class="po-row">📊 <strong>30-Day Delta:</strong> <span class="po-delta ${dir}">${arrow} ${pct} (${expected})</span></div>
        <div class="po-row">🔑 <strong>Gemini Status:</strong> ${renderGeminiStatus(meta.gemini)}</div>
        <div class="po-note" title="${escapeHtml(meta.gemini.rationale)}">${escapeHtml(meta.gemini.rationale || '')}</div>
      </div>`;
  }

  function renderLoading() {
    return `
      ${renderHeader('<span class="po-chip warn"><i class="po-dot"></i>Analyzing…</span>')}
      <div class="po-section" aria-busy="true">
        <div class="po-skel" style="height:38px;width:70%;margin-bottom:12px"></div>
        <div class="po-skel" style="height:44px;margin-bottom:10px"></div>
        <div class="po-skel" style="height:14px;width:55%"></div>
      </div>`;
  }

  function renderError(error) {
    return `
      ${renderHeader('<span class="po-chip warn"><i class="po-dot"></i>Unavailable</span>')}
      <div class="po-section po-error">
        <span>Couldn't build a projection: ${escapeHtml(error || 'unknown error')}</span>
        <button class="po-btn err" type="button" data-action="retry">Retry</button>
      </div>`;
  }

  /**
   * @param {{status: string, data?: any, error?: string}} state
   * @returns {string} Card HTML (no <style>).
   */
  function renderCard(state) {
    switch (state.status) {
      case 'ready':
        return renderReady(state.data);
      case 'error':
        return renderError(state.error);
      default:
        return renderLoading();
    }
  }

  /** Full shadow-root markup including styles. */
  function render(state) {
    return `<style>${STYLES}</style><div class="po-wrap"><div class="po-card">${renderCard(state)}</div></div>`;
  }

  PO.Widget = { STYLES, render, pinPosition };
})(globalThis);
