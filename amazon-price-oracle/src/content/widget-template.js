/**
 * Widget markup and isolated CSS.
 *
 * Classic content script. Exposes `globalThis.PriceOracle.Widget` with:
 *   - TOKENS / STYLES / CHIP_STYLES: CSS strings injected inside the shadow root (Amazon CSS cannot leak in)
 *   - render(state): HTML string for the full product-page card
 *   - renderChip(state): HTML string for the compact search-result chip
 *
 * state = { status: 'loading' }
 *       | { status: 'error', error: string }
 *       | { status: 'ready', data: AnalysisResult }   (see service-worker.js)
 *
 * Chip state adds `expanded` and `deepLoading` booleans.
 *
 * Interactive elements carry `data-action` attributes ("retry", "toggle", "deep");
 * content.js / search-results.js wire a single delegated click listener each.
 *
 * Design: the "Ledger" palette, documented in docs/DESIGN.md. TOKENS below must stay
 * identical to src/shared/tokens.css (tests/design.test.mjs enforces it).
 */
(function (root) {
  'use strict';

  const PO = (root.PriceOracle = root.PriceOracle || {});

  /** Design tokens. Content scripts cannot import CSS files, so they are inlined here. */
  const TOKENS = `
    :host {
      --po-ink: #0f1111;
      --po-graphite: #565959;
      --po-rule: #d5d9d9;
      --po-rule-strong: #8d9696;
      --po-paper: #ffffff;
      --po-wash: #f7f8f8;
      --po-teal: #007185;
      --po-teal-deep: #00596a;
      --po-teal-tint: #e6f2f4;
      --po-teal-range: #b9d8de;
      --po-wait: #b12704;
      --po-wait-tint: #fcf1ee;
      --po-buy: #05705a;
      --po-buy-tint: #ebf6f2;
      --po-fair: #3d4242;
      --po-fair-tint: #eff1f1;
      --po-caution: #7a4400;
      --po-caution-tint: #fff4df;
      --po-font: "Amazon Ember", Arial, "Helvetica Neue", sans-serif;
    }`;

  const STYLES = `
    ${TOKENS}
    :host { all: initial; display: block; }
    *, *::before, *::after { box-sizing: border-box; }
    .po-wrap { container-type: inline-size; margin: 12px 0; }
    .po-card {
      font-family: var(--po-font);
      font-size: 14px; line-height: 1.4; color: var(--po-ink);
      /* The host element lives in Amazon's DOM, so re-assert every inheritable property. */
      font-style: normal; font-weight: 400; letter-spacing: normal; word-spacing: normal;
      text-transform: none; text-align: left; text-shadow: none; white-space: normal; direction: ltr;
      background: var(--po-paper); border: 1px solid var(--po-rule); border-radius: 8px; overflow: hidden;
    }
    .po-section { padding: 12px 16px; border-top: 1px solid var(--po-rule); }
    .po-section:first-child { border-top: 0; }
    .po-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; background: var(--po-wash); padding-block: 10px; }
    .po-title { font-weight: 700; font-size: 14px; display: flex; align-items: center; gap: 8px; color: var(--po-ink); }
    .po-mark { width: 18px; height: 18px; color: var(--po-teal); flex: none; }
    .po-icon { width: 16px; height: 16px; flex: none; }

    .po-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; padding: 2px 8px;
      border-radius: 4px; background: var(--po-teal-tint); color: var(--po-teal-deep); white-space: nowrap; }
    .po-chip .po-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--po-teal); }
    .po-chip.warn { background: var(--po-caution-tint); color: var(--po-caution); }
    .po-chip.warn .po-dot { background: var(--po-caution); }

    .po-label { font-size: 13px; font-weight: 700; color: var(--po-ink); margin-bottom: 8px; }
    .po-reco { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; }
    .po-pill { display: flex; align-items: center; gap: 10px; flex: 1 1 auto; min-width: 0; padding: 10px 12px;
      border-radius: 4px; border-left: 4px solid currentColor; font-size: 14px; }
    .po-pill .po-icon { width: 18px; height: 18px; }
    .po-pill .po-pill-label { font-weight: 700; letter-spacing: 0.02em; }
    .po-pill .po-pill-sep { opacity: 0.55; margin: 0 6px; }
    .po-pill .po-pill-msg { font-weight: 400; color: var(--po-ink); }
    .po-pill.WAIT { background: var(--po-wait-tint); color: var(--po-wait); }
    .po-pill.BUY_NOW { background: var(--po-buy-tint); color: var(--po-buy); }
    .po-pill.FAIR_PRICE { background: var(--po-fair-tint); color: var(--po-fair); }
    .po-confidence { font-size: 12px; color: var(--po-graphite); }

    .po-tier-grid { display: grid; grid-template-columns: repeat(5, 1fr); text-align: center; margin-bottom: 4px; }
    .po-tier-price { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .po-tier-name { font-size: 11px; font-weight: 600; letter-spacing: 0.04em; color: var(--po-graphite); margin-top: 1px; }
    .po-tier.mid .po-tier-price, .po-tier.mid .po-tier-name { color: var(--po-teal-deep); }
    .po-bar { position: relative; height: 52px; margin-top: 4px; }
    .po-track { position: absolute; left: 3%; right: 3%; top: 14px; height: 6px; border-radius: 3px; background: var(--po-rule); }
    .po-range { position: absolute; left: 30%; right: 30%; top: 14px; height: 6px; background: var(--po-teal-range); }
    .po-tick { position: absolute; top: 11px; width: 1px; height: 12px; background: var(--po-rule-strong); }
    .po-tick.mid { background: var(--po-teal); width: 2px; margin-left: -1px; top: 9px; height: 16px; }
    .po-pin { position: absolute; top: 5px; width: 4px; height: 24px; margin-left: -2px; border-radius: 2px;
      background: var(--po-ink); box-shadow: 0 0 0 2px var(--po-paper); }
    .po-pin-label { position: absolute; top: 32px; transform: translateX(-50%); white-space: nowrap; font-size: 12px;
      font-weight: 700; color: var(--po-ink); background: var(--po-paper); border: 1px solid var(--po-rule-strong); padding: 0 8px; border-radius: 4px; }
    .po-pin-label.edge-left { transform: translateX(-12%); }
    .po-pin-label.edge-right { transform: translateX(-88%); }

    .po-foot { display: grid; gap: 6px; background: var(--po-wash); }
    .po-row { display: grid; grid-template-columns: 108px 1fr; gap: 8px; align-items: baseline; font-size: 13px; }
    .po-key { color: var(--po-graphite); }
    .po-val { min-width: 0; }
    .po-delta.down { color: var(--po-wait); font-weight: 700; }
    .po-delta.up { color: var(--po-buy); font-weight: 700; }
    .po-delta.flat { color: var(--po-fair); font-weight: 700; }
    .po-status { font-weight: 600; }
    .po-status.ok { color: var(--po-buy); }
    .po-status.err { color: var(--po-caution); }
    .po-note { font-size: 12px; color: var(--po-graphite); }
    .po-btn { font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; border-radius: 4px; padding: 4px 12px;
      border: 1px solid var(--po-rule-strong); background: var(--po-paper); color: var(--po-ink); }
    .po-btn:hover { background: var(--po-wash); }
    .po-btn:focus-visible { outline: 2px solid var(--po-teal); outline-offset: 2px; }

    .po-skel { border-radius: 4px; background: var(--po-fair-tint); animation: po-pulse 1.4s ease-in-out infinite; }
    @keyframes po-pulse { 50% { opacity: 0.5; } }
    .po-error { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; background: var(--po-caution-tint); color: var(--po-caution); }
    @media (prefers-reduced-motion: reduce) { .po-skel { animation: none; } }
    @container (max-width: 380px) {
      .po-tier-price { font-size: 12px; }
      .po-tier-name { font-size: 10px; letter-spacing: 0.02em; }
      .po-row { grid-template-columns: 1fr; gap: 0; }
      .po-pill { flex-wrap: wrap; }
    }
  `;

  const ICONS = {
    mark: '<svg class="po-mark" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 3v12h13"/><path d="M5.5 11l3-3.5 2.5 2L15 4.5"/></svg>',
    WAIT: '<svg class="po-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5l4 4 2.5-2.5 4.5 4.5"/><path d="M13.5 6.5v4h-4"/></svg>',
    BUY_NOW: '<svg class="po-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 11.5l4-4 2.5 2.5 4.5-4.5"/><path d="M13.5 9.5v-4h-4"/></svg>',
    FAIR_PRICE: '<svg class="po-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3 6h10M3 10h10"/></svg>'
  };
  const iconFor = (action) => ICONS[action] || ICONS.FAIR_PRICE;

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
        <div class="po-title">${ICONS.mark}Price Timing Oracle</div>
        ${chipHtml}
      </div>`;
  }

  /** "3 h ago" style age for tooltips. */
  function ago(ts) {
    if (!ts) return '';
    const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
  }

  function renderContextChip(context) {
    if (!context) return '';
    if (context.status === 'error') {
      return `<span class="po-chip warn" title="${escapeHtml(context.error || 'context.dev unavailable')}"><i class="po-dot"></i>context.dev: Offline — using page data</span>`;
    }
    if (context.status === 'skipped') {
      return '<span class="po-chip warn" title="Quick estimate from page data"><i class="po-dot"></i>context.dev: Not used (quick estimate)</span>';
    }
    const suffix = context.fromCache ? ' (cached)' : '';
    const fetched = context.fetchedAt ? `, fetched ${ago(context.fetchedAt)}` : '';
    return `<span class="po-chip" title="${context.signalCount} pricing signals${fetched}"><i class="po-dot"></i>context.dev: Connected${suffix}</span>`;
  }

  function renderGeminiStatus(gemini) {
    if (gemini.status === 'live') {
      const detail = gemini.summary ? ` — ${escapeHtml(gemini.summary)}` : '';
      const stale = gemini.stale ? ' (cached)' : '';
      return `<span class="po-status ok" title="${escapeHtml(gemini.rationale)}">Gemini Markets: Live${stale}${detail}</span>`;
    }
    return `<span class="po-status err" title="${escapeHtml(gemini.error || '')}">Gemini Markets: Offline — running on heuristic model</span>`;
  }

  /** One-line summary of prices this browser has seen for the product (null until seen twice). */
  function historyText(history) {
    if (!history) return '';
    const span = history.spanDays >= 1 ? ` over ${Math.round(history.spanDays)} day${Math.round(history.spanDays) === 1 ? '' : 's'}` : '';
    return `Seen ${history.count} times${span} · low ${usd(history.low)} · high ${usd(history.high)}`;
  }

  function renderHistoryRow(history) {
    const text = historyText(history);
    return text ? `<div class="po-row"><span class="po-key">Your price history</span><span class="po-val">${escapeHtml(text)}</span></div>` : '';
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
            ${iconFor(recommendation.action)}
            <span><span class="po-pill-label">${escapeHtml(recommendation.label)}</span><span class="po-pill-sep">—</span><span class="po-pill-msg">${escapeHtml(recommendation.message)}</span></span>
          </div>
          <span class="po-confidence">(${confidence}% confidence)</span>
        </div>
      </div>
      <div class="po-section">
        <div class="po-label">30-day projected price tiers</div>
        <div class="po-tier-grid">${tierCells}</div>
        <div class="po-bar" role="img" aria-label="Current price ${usd(currentPrice)} relative to the projected price tiers">
          <div class="po-track"></div>
          <div class="po-range"></div>
          ${ticks}
          <span class="po-pin" style="left:${pin.toFixed(1)}%"></span>
          <span class="po-pin-label${edgeClass}" style="left:${pin.toFixed(1)}%">Current: ${usd(currentPrice)}</span>
        </div>
      </div>
      <div class="po-section po-foot">
        <div class="po-row"><span class="po-key">30-day delta</span><span class="po-val"><span class="po-delta ${dir}">${arrow} ${pct} (${expected})</span></span></div>
        <div class="po-row"><span class="po-key">Gemini status</span><span class="po-val">${renderGeminiStatus(meta.gemini)}</span></div>
        ${renderHistoryRow(meta.history)}
        <div class="po-note" title="${escapeHtml(meta.gemini.rationale)}">${escapeHtml(meta.gemini.rationale || '')}</div>
      </div>`;
  }

  function renderLoading() {
    return `
      ${renderHeader('<span class="po-chip warn"><i class="po-dot"></i>Analyzing…</span>')}
      <div class="po-section" aria-busy="true">
        <div class="po-skel" style="height:40px;margin-bottom:12px"></div>
        <div class="po-skel" style="height:44px;margin-bottom:10px"></div>
        <div class="po-skel" style="height:14px;width:55%"></div>
      </div>`;
  }

  function renderError(error) {
    return `
      ${renderHeader('<span class="po-chip warn"><i class="po-dot"></i>Unavailable</span>')}
      <div class="po-section po-error">
        <span>Couldn't build a projection: ${escapeHtml(error || 'unknown error')}</span>
        <button class="po-btn" type="button" data-action="retry">Retry</button>
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
    return `<style>${STYLES}</style><div class="po-wrap"><div class="po-card" role="region" aria-label="PriceOracle buy timing and 30-day price projection" aria-busy="${state.status === 'loading'}">${renderCard(state)}</div></div>`;
  }

  // -------------------------------------------------------------------------
  // Search-result chip
  // -------------------------------------------------------------------------

  const CHIP_STYLES = `
    ${TOKENS}
    :host { all: initial; display: block; }
    *, *::before, *::after { box-sizing: border-box; }
    .pc-wrap { container-type: inline-size; margin: 6px 0 4px; max-width: 100%;
      font-family: var(--po-font); font-size: 13px; line-height: 1.35;
      font-style: normal; font-weight: 400; letter-spacing: normal; text-transform: none; text-align: left; color: var(--po-ink); direction: ltr; }
    .pc-chip { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 4px 6px; max-width: 100%; font: inherit; font-size: 12px; cursor: pointer;
      padding: 3px 8px; border-radius: 4px; border: 1px solid currentColor; text-align: left; }
    .pc-chip:hover { filter: brightness(0.96); }
    .pc-chip:focus-visible, .pc-btn:focus-visible { outline: 2px solid var(--po-teal); outline-offset: 2px; }
    .pc-chip.WAIT { background: var(--po-wait-tint); color: var(--po-wait); }
    .pc-chip.BUY_NOW { background: var(--po-buy-tint); color: var(--po-buy); }
    .pc-chip.FAIR_PRICE { background: var(--po-fair-tint); color: var(--po-fair); }
    .pc-chip.pending, .pc-chip.error { background: var(--po-wash); color: var(--po-graphite); border-color: var(--po-rule); cursor: default; }
    .pc-chip.error { cursor: pointer; }
    .pc-icon { width: 14px; height: 14px; flex: none; }
    .pc-label { font-weight: 700; letter-spacing: 0.02em; }
    .pc-delta { font-weight: 600; font-variant-numeric: tabular-nums; }
    .pc-caret { font-size: 9px; opacity: 0.75; }
    .pc-panel { margin-top: 6px; padding: 10px 12px; border: 1px solid var(--po-rule); border-radius: 8px; background: var(--po-paper); display: grid; gap: 6px; }
    .pc-msg { font-weight: 700; }
    .pc-tiers { display: grid; grid-template-columns: repeat(5, 1fr); text-align: center; gap: 2px; }
    .pc-tier-price { font-weight: 700; font-size: 12px; font-variant-numeric: tabular-nums; }
    .pc-tier.mid .pc-tier-price, .pc-tier.mid .pc-tier-name { color: var(--po-teal-deep); }
    .pc-tier-name { font-size: 10px; font-weight: 600; letter-spacing: 0.04em; color: var(--po-graphite); }
    .pc-note { font-size: 12px; color: var(--po-graphite); }
    .pc-btn { font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; justify-self: start; border-radius: 4px; padding: 3px 10px;
      border: 1px solid var(--po-rule-strong); background: var(--po-paper); color: var(--po-ink); }
    .pc-btn:hover { background: var(--po-wash); }
    .pc-btn[disabled] { opacity: 0.6; cursor: progress; }
    .pc-skel { display: inline-block; width: 90px; height: 10px; border-radius: 4px; background: var(--po-rule); animation: pc-pulse 1.4s ease-in-out infinite; }
    @keyframes pc-pulse { 50% { opacity: 0.5; } }
    @media (prefers-reduced-motion: reduce) { .pc-skel { animation: none; } }
    @container (max-width: 230px) {
      .pc-tier-price { font-size: 10px; }
      .pc-tier-name { display: none; }
    }
  `;

  function renderChipPanel(data, state) {
    const { projection, meta } = data;
    const { tiers, recommendation, confidence, deltaPercentMonth, deltaAmount } = projection;
    const cells = TIER_ORDER.map(
      ([key, label]) => `
        <div class="pc-tier ${key === 'mid' ? 'mid' : ''}">
          <div class="pc-tier-price">${usd(tiers[key])}</div>
          <div class="pc-tier-name">${label}</div>
        </div>`
    ).join('');

    const sign = deltaAmount > 0 ? '+' : deltaAmount < 0 ? '-' : '';
    const pct = `${deltaPercentMonth > 0 ? '+' : ''}${deltaPercentMonth.toFixed(1)}%`;
    const gemini =
      meta.gemini.status === 'live'
        ? `Gemini Markets: Live${meta.gemini.summary ? ` — ${escapeHtml(meta.gemini.summary)}` : ''}`
        : 'Gemini Markets: Offline — heuristic model';
    const quick = data.light && meta.context.status === 'skipped';
    const deep = quick
      ? `<button class="pc-btn" type="button" data-action="deep" ${state.deepLoading ? 'disabled' : ''}>${
          state.deepLoading ? 'Analyzing…' : 'Deep analysis (uses context.dev)'
        }</button>`
      : '';

    return `
      <div class="pc-panel" role="region" aria-label="PriceOracle 30-day price outlook">
        <div class="pc-msg">${escapeHtml(recommendation.message)} <span class="pc-note">(${confidence}% confidence)</span></div>
        <div class="pc-tiers" aria-label="30-day projected price tiers">${cells}</div>
        <div class="pc-note">30-day: ${pct} (${sign}${usd(Math.abs(deltaAmount))}) · ${gemini}</div>
        ${meta.history ? `<div class="pc-note">${escapeHtml(historyText(meta.history))}</div>` : ''}
        ${quick ? '<div class="pc-note">Quick estimate from the price on this card. Open the product page or run a deep analysis for page-level signals.</div>' : ''}
        ${deep}
      </div>`;
  }

  /** Small icon for the chip (same glyphs as the card, sized down by CSS). */
  const chipIcon = (action) => iconFor(action).replace('class="po-icon"', 'class="pc-icon"');

  /**
   * Compact chip for one search result.
   * @param {{status: string, data?: any, error?: string, expanded?: boolean, deepLoading?: boolean}} state
   * @returns {string} Full shadow-root markup including styles.
   */
  function renderChip(state) {
    let chip;
    let panel = '';
    if (state.status === 'ready') {
      const { projection } = state.data;
      const { recommendation, deltaPercentMonth } = projection;
      const pct = `${deltaPercentMonth > 0 ? '+' : ''}${deltaPercentMonth.toFixed(1)}%`;
      chip = `<button class="pc-chip ${escapeHtml(recommendation.action)}" type="button" data-action="toggle" aria-expanded="${Boolean(state.expanded)}"
        title="PriceOracle 30-day outlook. Click for details.">
        ${chipIcon(recommendation.action)}<span class="pc-label">${escapeHtml(recommendation.label)}</span>
        <span class="pc-delta">${pct} / 30d</span><span class="pc-caret" aria-hidden="true">${state.expanded ? '▲' : '▼'}</span></button>`;
      if (state.expanded) panel = renderChipPanel(state.data, state);
    } else if (state.status === 'error') {
      chip = `<button class="pc-chip error" type="button" data-action="retry" title="${escapeHtml(state.error || 'Unavailable')}">PriceOracle unavailable — retry</button>`;
    } else {
      chip = `<span class="pc-chip pending" role="status"><span class="pc-skel"></span></span>`;
    }
    return `<style>${CHIP_STYLES}</style><div class="pc-wrap">${chip}${panel}</div>`;
  }

  PO.Widget = { TOKENS, STYLES, CHIP_STYLES, render, renderChip, pinPosition };
})(globalThis);
