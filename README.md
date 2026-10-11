# PriceOracle — Amazon Buy Timing & Price Projection (Chrome extension)

PriceOracle is a Manifest V3 Chrome extension that injects a **Buy Timing & 30-day Price Projection** card under the price on Amazon product pages (`amazon.com`) and a compact verdict chip on every result of Amazon search pages (`amazon.com/s?k=...`). It answers one question: *should I buy this now, or wait?*

```
⚡ PRICE TIMING ORACLE                         [● context.dev: Connected]
RECOMMENDATION   [ WAIT — Expected to drop 8.4% (~$14.70) in 30 days ]  (82% confidence)
30-DAY PROJECTED PRICE TIERS
 $129.00    $145.00    $162.50    $189.00    $219.00
 LOWEST      LOW        MID        HIGH      HIGHEST
 ──●────────────●─────────▲───────────────────        [Current: $174.99]
📊 30-Day Delta: ▼ -8.4% (-$14.70 expected)
🔑 Gemini Status: Gemini Markets: Live — Fed hike odds 19%, cut odds 3% · recession odds 4%
```

**Just want to use it?** Follow the step-by-step [User guide](docs/USER_GUIDE.md) (install, reading the card, settings, update, uninstall, troubleshooting).

- [Install](#install-30-seconds)
- [Purpose and scope](#purpose-and-scope)
- [Architecture](#architecture)
- [File-by-file reference](#file-by-file-reference)
- [How the projection works](#how-the-projection-works)
- [External APIs](#external-apis)
- [Storage, messages and settings](#storage-messages-and-settings)
- [Development workflow](#development-workflow)
- [Testing](#testing)
- [Best practices and pitfalls](#best-practices-and-pitfalls)
- [Releasing and tags](#releasing-and-tags)
- [Decisions and deviations from the original brief](#decisions-and-deviations-from-the-original-brief)
- [Security and privacy](#security-and-privacy)
- [Known limitations and roadmap](#known-limitations-and-roadmap)
- [Troubleshooting](#troubleshooting)

---

## Install (30 seconds)

No build step, no keys, no setup.

1. **Download the zip** of the latest tagged release:
   - Latest: <https://github.com/JuneKim0712/babab/releases/latest/download/PriceOracle.zip>
   - Or a specific tag straight from the repo: `https://github.com/JuneKim0712/babab/raw/<tag>/PriceOracle.zip` (for example `v1.0.0`).
   - Unzip it anywhere. You should get a folder containing `manifest.json`, `icons/` and `src/`.
2. Open `chrome://extensions`, switch on **Developer mode** (top right), click **Load unpacked** and select the unzipped folder.
3. A welcome tab opens. Click **Try it on a sample product**, or open any Amazon product page. The card appears under the price. Amazon tabs that were already open work immediately, with no reload.

Optional: pin the icon (puzzle piece, then the pin) for quick stats.

Notes:
- Chrome can show a "disable developer mode extensions" prompt on restart. Choose to keep the extension. Loading unpacked is the only no-store install path.
- To **update**, replace the folder contents with the newer zip and click the reload icon on the extension's card in `chrome://extensions`.
- To install from a clone instead of the zip, load the `amazon-price-oracle/` folder (the one containing `manifest.json`).

---

## Purpose and scope

**Goal:** give a shopper a fast, honest, in-page signal on timing, on product pages (full card) and search results (compact chip, expandable): WAIT (price expected to fall at least 4% in 30 days), BUY NOW (expected to rise at least 4%), or FAIR PRICE (stable), plus a five-tier distribution of plausible 30-day prices and a pin showing where today's price sits.

**What it is:** a client-side extension. All logic runs in the browser; the only network calls are from the background service worker to context.dev and Gemini.

**Optional price alerts:** the user can set, pause, re-arm or remove a price alert for the current item from the card. Alerts are stored locally (`chrome.storage.local`), are checked whenever the extension sees the price (product pages, search results) and by an hourly background check, and fire a desktop notification plus a toolbar badge. An email address saved in Settings is listed with the alerts and used by the notification's "Email me this" button (a `mailto:`; the extension sends no email). The same alerts are added to <https://xylm-306e6.web.app/alerts/> next to the site's own. No sign-in. See `docs/ALERTS_INTEGRATION.md`.

**What it is not:**
- Not a price-history tracker. Amazon pages expose no price history, so the projection comes from a model (see below), not from past prices.
- Not a product-level forecaster backed by trained ML. Product-level numbers come from a deterministic heuristic model; Gemini prediction markets add *macro* odds (Fed, recession) that nudge it.
- Not affiliated with Amazon, context.dev or Gemini.

Design goals, in priority order:
1. **Never break the page or crash.** Every external dependency has a fallback.
2. **Zero setup.** Works immediately after load. API keys are optional/overridable.
3. **Isolated UI.** Shadow DOM so Amazon's CSS cannot affect the widget and the widget cannot affect Amazon.
4. **Cheap to run.** Aggressive caching so API credits are preserved.
5. **Testable.** Business logic is pure functions with unit tests; the whole extension has an end-to-end test against mocks.

---

## Architecture

```
 Amazon product page                        Chrome extension
┌──────────────────────┐   sendMessage   ┌─────────────────────────────────────────────┐
│ content scripts      │ ──────────────▶ │ service worker (ES module)                   │
│  amazon-parser.js    │                 │   service-worker.js   router + orchestration │
│  widget-template.js  │ ◀────────────── │   context-dev.js ───────▶ api.context.dev    │
│  content.js          │  {ok, data}     │   gemini-prediction.js ─▶ api.gemini.com     │
│  (Shadow DOM widget) │                 │   projection-engine.js (pure math)           │
└──────────────────────┘                 │   chrome.storage.local (keys + caches)       │
                                         └─────────────────────────────────────────────┘
 popup (stats, key modal)  ── messages / storage ──▶ same worker
 options (keys, Test Connection) ──────────────────▶ same worker
 welcome (post-install tab)
```

Request flow for one product page (search pages are described after it):
1. `content.js` parses the page (`PriceOracle.Parser.parseProduct`): ASIN, price, list price, category, title.
2. It sends `PO_ANALYZE_PRODUCT` to the service worker and paints a loading skeleton.
3. The worker (`runPipeline` in `service-worker.js`):
   1. `fetchProductContext` (context.dev, cached 24 h per ASIN) returns pricing *signals*.
   2. `estimateVolatility` derives a 30-day volatility fraction.
   3. `getPrediction` runs the heuristic model, then blends in Gemini macro odds (cached 3 h). On failure it returns the heuristic result flagged `isSimulated: true`.
   4. `computeProjection` produces tiers, delta, recommendation and confidence.
   5. The result is stored as `last_analysis` for the popup and returned to the page.
4. `content.js` renders the card into the Shadow DOM. A `MutationObserver` re-runs the flow when the ASIN or price changes (colour/size variant) without a page reload.

Request flow for a search-results page (`search-results.js`):
1. `PriceOracle.Parser.getSearchCards` finds `div[data-component-type="s-search-result"][data-asin]`; `parseSearchCard` reads ASIN, price, list price, title and rating from each card. Cards without a price ("See options") get no chip. The category comes from the department dropdown, else the `i=` URL parameter, else the sub-nav.
2. A Shadow DOM chip host (`[data-price-oracle-chip]`) is inserted after the card's price row. Cards are analysed lazily as they near the viewport (`IntersectionObserver`), at most 4 at a time.
3. Each card sends `PO_ANALYZE_PRODUCT` with `light: true`. Light mode **never calls context.dev** (it only reuses the 24 h cache, status `skipped` otherwise), so a page of 60 results costs zero credits. The Gemini macro lookup is shared across all cards (in-flight de-duplication plus the 3 h cache). Light results are not written to `last_analysis`.
4. Clicking a chip expands the five tiers. For a quick estimate the panel offers **Deep analysis**, which re-sends the request with `light: false` (one context.dev scrape for that product).
5. A debounced `MutationObserver` on the results grid adds chips to lazily loaded cards and re-renders a card when its price changes.

Key properties:
- **Content scripts are classic scripts**, not modules (Chrome does not allow ES modules in `content_scripts`). They share state through `globalThis.PriceOracle`. Order in `manifest.json` matters: messaging, parser, template, search-results, content (`tests/package.test.mjs` enforces it). The second entry (the PriceOracle website) loads `messaging.js` then `site-alerts.js`.
- **The service worker is an ES module** (`"type": "module"`) so background files `import` each other and `src/shared/constants.js`.
- **No CORS issues:** pages never call external APIs; only the worker does, using `host_permissions`.
- **No inline scripts** anywhere (MV3 CSP). Popup, options and welcome load `type="module"` files.

---

## File-by-file reference

```
.
├── README.md                     This file (single source of truth for collaborators)
├── AGENTS.md                     Short rules for AI/code agents; points here
├── docs/ALERTS_INTEGRATION.md    How local price alerts work: storage, price sources, notifications, the website alerts page, limits
├── docs/DESIGN.md                Design system: palette, components, sources
├── docs/USER_GUIDE.md            End-user guide for installing and using the extension (+ docs/images)
├── PriceOracle.zip               Ready-to-install build of the extension (regenerate with npm run pack)
├── .github/workflows/            CI (unit tests) and tag-triggered release (attaches PriceOracle.zip)
└── amazon-price-oracle/          The extension (this folder is what "Load unpacked" loads)
    ├── manifest.json
    ├── package.json              Dev scripts only; the extension has no runtime dependencies
    ├── icons/                    icon16/48/128.png (generated by scripts/generate-icons.js)
    ├── scripts/
    ├── src/
    ├── test-page/
    └── tests/
```

### Extension runtime (`amazon-price-oracle/`)

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest. Permissions: `storage`, `scripting`, `alarms` (hourly alert check), `notifications` (alerts). Host permissions: `api.context.dev`, `api.gemini.com`, `www.amazon.com`, `amazon.com`. Declares the service worker (module), the five Amazon content scripts (in order), a second content script entry for `https://xylm-306e6.web.app/*` (`messaging.js`, `site-alerts.js`), popup, options page (`open_in_tab`), icons. **`version` here is the release version.** |
| `src/shared/tokens.css` | Design tokens (the "Ledger" palette) for popup, options and welcome; mirrored in `TOKENS` inside `widget-template.js`. See `docs/DESIGN.md`. |
| `src/shared/constants.js` | Single source of truth for endpoints, the default context.dev key, storage keys, cache TTLs and message type names. Imported by the worker, popup and options. Content scripts cannot import it, so `content.js` mirrors the one message name it needs. |
| `src/background/service-worker.js` | Message router (`PO_ANALYZE_PRODUCT`, `PO_GET_STATUS`, `PO_TEST_CONNECTION`, `PO_OPEN_OPTIONS`, `PO_CLEAR_CACHE`), the analysis pipeline, in-flight request de-duplication, `last_analysis` bookkeeping, and the `onInstalled` handler (opens the welcome tab and injects content scripts into already-open Amazon tabs). Always replies `{ok, data}` or `{ok:false, error}`. |
| `src/background/context-dev.js` | context.dev client. Calls `POST /v1/web/scrape` with `formats {json, markdown}` and a pricing JSON schema. `unwrapScrapeResponse` flattens the API's `{requested, success, data}` wrappers; `extractSignals` + `signalsFromMarkdown` turn the output into normalised signals (list price, current price, low/avg/high, discount %, rating, reviews, bought-past-month, category, availability). 24 h cache per ASIN (15 min negative cache for errors). `testContextDevConnection` uses a free endpoint. |
| `src/background/gemini-prediction.js` | Two parts. (1) **Gemini prediction markets** client: fetches Economics events, `contractProbability`, `computeMacroSignal` (Fed hike/cut odds + recession odds to a sentiment multiplier and discount boost), `blendMacro`, 3 h cache with stale fallback. (2) **Heuristic model** `simulatePrediction`: deterministic, seeded by ASIN and ISO week; mean reversion vs typical/list price, seasonal sale calendar (`findSeasonalEvent`), category sale proneness. Always available as the fallback. |
| `src/background/alerts.js` | Local price alerts (needs `chrome.*`): serialized storage in `price_alerts`, `createAlert` / `updateAlert` / `removeAlert`, `noticePrice` (called with every price seen on product pages and search results), notifications (with "Open on Amazon" and "Email me this" buttons), toolbar badge, the hourly background check (alarm `po-alert-check`, alerts not checked in 4 h, max 5 per run, one context.dev credit each, switchable), and the alert email. |
| `src/content/site-alerts.js` | Runs only on `xylm-306e6.web.app`. On the `/alerts` route adds a "Set in your PriceOracle extension" section under the site's own list (Pause/Resume/Re-arm, Edit, Delete) without touching the page's React data; watches SPA route changes. |
| `src/background/alerts-api.js` | Pure alert helpers: `normalizeAlert`, `sanitizeAlerts`, `upsertAlert`, `patchAlert`, `observePrice` (fires once at target), `dueForCheck`, `sortAlerts`, `summarizeAlerts`, `badgeFor`, `notificationText`, `isEmail`, `mailtoUrl`, `validateTarget`. |
| `src/background/recent.js` | Pure `addRecent` for the popup's recent list. |
| `src/background/price-history.js` | Local observation log. Pure helpers (`addObservation`, `summarize`, `historySignals`) plus chained storage writes (`recordPrice`). `historySignals` returns low/high/avg only after 3+ points over 2+ days; the worker merges them *under* context.dev signals. |
| `src/background/projection-engine.js` | Pure functions, no `chrome.*`. `estimateVolatility`, `computeProjection`, `buildRecommendation`, `computeConfidence`, `formatUsd`. Contains the spec formulas (see below). |
| `src/content/amazon-parser.js` | `PriceOracle.Parser`: ASIN (`#ASIN`, URL regex fallback), price (multiple selector fallbacks, `.a-offscreen` and whole/fraction), list price, category (breadcrumb, dropdown, nav), title, rating; `parseProduct()` returns null on non-product pages or when no price is present. Search helpers: `isSearchPage`, `getSearchCategory`, `getSearchCards`, `parseSearchCard`. |
| `src/content/widget-template.js` | `PriceOracle.Widget.render(state)`: returns the Shadow DOM HTML plus the isolated CSS for loading / error / ready states, the pill badges, the five-tier range bar and pin (`pinPosition` interpolates between tiers). `renderChip(state)` renders the compact search-result chip and its expandable panel. Re-asserts inheritable CSS properties on the card because the host element lives in Amazon's DOM. |
| `src/content/content.js` | Entry point. Finds the anchor (after `#corePriceDisplay_desktop_feature_div`, else top of `#buybox`, else other price containers), creates one Shadow DOM host (`#price-oracle-host`), sends analysis requests, ignores stale responses (request sequence counter), observes the product container with a debounced `MutationObserver`, re-attaches the host if Amazon re-renders the DOM. |
| `src/content/messaging.js` | `PriceOracle.send(message)`: `chrome.runtime.sendMessage` with one retry when the worker was asleep and a 90 s timeout. `PriceOracle.settings.get/watch` read the options switches and report changes live. Both content scripts use them. |
| `src/content/search-results.js` | Search-page entry point (runs only on `/s` URLs): chip placement, lazy analysis queue (concurrency 4), chip click handling (expand, retry, deep analysis), observers for lazily loaded cards. |
| `src/popup/popup.html/.css/.js` | Toolbar popup: last analysed product, counters, connection status badges, the local price alert list (Re-arm, status badge), clear-cache button. |
| `src/options/options.html/.css/.js` | Settings page: "Where PriceOracle appears" switches (saved immediately), context.dev key (pre-filled with the default; saving the default removes the stored override), **Test Connection** (tests unsaved form values via the worker), status banner, price alert email (validated on Save), background-check switch, "Send a test notification". |
| `src/welcome/welcome.html/.css` | Post-install tab: no setup needed, link to a sample product, pin tip. |

### Tooling and tests (`amazon-price-oracle/`)

| File | Role |
| --- | --- |
| `package.json` | Scripts: `lint` (ESLint), `test` (unit), `e2e`, `pack`, `icons`, `demo`. Dev dependencies: `puppeteer-core` (e2e), `jsdom` (parser tests) and `eslint` (lint). |
| `scripts/pack.mjs` | Builds `../PriceOracle.zip` (manifest, icons, src only) with a dependency-free, deterministic zip writer. |
| `scripts/generate-icons.js` | Generates the PNG icons with a zero-dependency rasteriser. |
| `tests/properties.test.mjs` | Seeded property tests: tier ordering, spec formulas, thresholds, confidence and heuristic bounds. |
| `tests/recent.test.mjs` | Unit tests for the recent list. |
| `tests/history.test.mjs` | Unit tests for the local price history. |
| `tests/parser.test.mjs` | DOM tests (jsdom) for `amazon-parser.js` using the mock pages as fixtures. |
| `tests/widget.test.mjs` | Pure rendering tests for `widget-template.js`: escaping, tiers, chip states. |
| `tests/alerts-api.test.mjs` | Unit tests for the alert helpers (storage cleanup, firing rules, re-arm, due checks, sorting, badge, email, mailto, notification text). |
| `tests/design.test.mjs` | Design guards: token sync, WCAG AA contrast, no emoji/gradients/soft shadows/indigo. |
| `tests/package.test.mjs` | Guard tests: version sync, manifest file references, content-script order (both entries) and classic-script rule, no inline scripts, committed zip is current. |
| `tests/engine.test.mjs` | Unit tests (Node `node:test`): projection formulas, tier ordering, thresholds, signal extraction, scrape-response unwrapping, macro signal, heuristic determinism and bounds, seasonal calendar. |
| `tests/e2e.mjs` | End-to-end test in a real Chrome: loads the unpacked extension, drives a mock Amazon page with mock context.dev and mock Gemini. Run against the shipped zip with `EXT_DIR`. |
| `test-page/amazon-product.html` | Mock Amazon product page with hostile CSS (proves Shadow DOM isolation) and variant buttons (proves re-render). |
| `test-page/amazon-search.html` | Mock search-results page (cards with and without prices, hostile CSS, a button that lazily appends a card). |
| `test-page/serve.mjs` | HTTPS mock server for `www.amazon.com`, `api.context.dev`, `api.gemini.com` (self-signed cert); also usable standalone via `npm run demo`. |

---

## How the projection works

All maths lives in `src/background/projection-engine.js`. Inputs: `currentPrice` (P), `volatility` (v, fraction, clamped 0.04–0.35), `discountProbability` (dp, 0–1), `sentimentMultiplier` (s, 0.85–1.15), optional `priceDrift` (d, default 0).

```
projectedMid      = P * (1 + (s - 1) * v * (1 - dp) + d)
deltaPercentMonth = (projectedMid - P) / P * 100

Lowest  (P5)  = P * (1 - 2.2 * v)        Low  (P25) = P * (1 - 1.1 * v)
Mid     (P50) = projectedMid
High    (P75) = P * (1 + 1.0 * v)        Highest (P95) = P * (1 + 2.1 * v)

deltaPercentMonth <= -4.0  ->  WAIT        >= +4.0  ->  BUY NOW        otherwise  ->  FAIR PRICE
```

- **Why `priceDrift` exists:** with `s` limited to 0.85–1.15 the base term moves the mid price only by ~1–3%, so the ±4% thresholds would never trigger. `priceDrift` carries mean reversion and seasonal effects. At `d = 0` the output is exactly the formula from the original brief.
- **Tier ordering guard:** a strong drift can push the mid outside the volatility band; neighbouring tiers are widened (`low <= 0.98*mid`, `high >= 1.02*mid`, and the outer tiers likewise) so the five prices always ascend.
- **Volatility** (`estimateVolatility`): category base (books ~0.06 up to fashion ~0.16), blended with the observed high-low range when context.dev returns one, plus a bump when a list-price gap exists, small adjustments for very cheap / very expensive items.
- **Heuristic model** (`simulatePrediction`): reference price = typical price from context.dev, else 96% of the list price when it exceeds the price; implausible references (outside 0.4x–2.5x of price) are ignored. `gap = (price - reference) / reference`; `drift = clamp(-0.55*gap)`, adjusted by the seasonal calendar (a sale starting soon pulls the price down; a live sale implies a rebound), near-floor price, and small seeded noise (stable within an ISO week). Discount probability rises with category sale proneness, upcoming events and price above reference.
- **Gemini macro blend** (`computeMacroSignal`, `blendMacro`):
  ```
  inflationPressure = P(hike) - P(cut)
  sentiment         = 1 + 0.10 * inflationPressure - 0.50 * P(recession)      (clamped 0.85-1.15)
  discountBoost     = 0.40 * P(recession) + 0.10 * max(0, -inflationPressure) (clamped 0-0.2)
  ```
  The product sentiment is multiplied by the macro sentiment; the boost is added to the discount probability; the drift moves by `(macroSentiment - 1) * 0.5`.
- **Confidence** (`computeConfidence`): base 46, +12 with context data, +3 per signal (max 12), +1.6 per percentage point of expected move (max 16), +5 when live Gemini odds are present. Capped at 82% for heuristic-only and 88% with Gemini. It is a data-quality indicator, not a statistical confidence interval.
- **`isSimulated`** means "no live Gemini market data was available" (heuristic-only). It does not mean the product forecast is ML-backed.

---

## External APIs

### context.dev (page intelligence)
- Endpoint: `POST https://api.context.dev/v1/web/scrape`, header `Authorization: Bearer <key>`.
- Body: `{ url: "https://www.amazon.com/dp/<ASIN>", formats: {json: true, markdown: true}, jsonParams: {schema, instructions}, maxAgeMs: 86400000 }`.
- Response: each output is wrapped as `{requested, success, data, error_code?, message?}`; `unwrapScrapeResponse` flattens it and throws only if no requested output succeeded.
- Cost: about 5 credits per json+markdown scrape. Hence the 24 h per-ASIN cache. A failed lookup is cached 15 minutes.
- `GET /v1/org/logs?limit=1` is a credit-free authenticated call used by **Test Connection** (also returns `credits_remaining`).
- The brief specified `POST /v1/extract`, which returns `ENDPOINT_NOT_FOUND`. See [Decisions](#decisions-and-deviations-from-the-original-brief).
- Amazon pages rarely expose price history, so low/avg/high are usually null. The heuristic model and the confidence score account for missing signals. Some ASINs 404 or are unavailable; the widget then falls back to page data only.
- Docs and OpenAPI: <https://docs.context.dev> and <https://www.context.dev/openapi.json>.

### Gemini prediction markets (macro odds)
- Docs: <https://developer.gemini.com/prediction-markets-spec/markets>.
- Endpoint used: `GET https://api.gemini.com/v1/prediction-markets/events?status=active&category=Economics&limit=50`. Also `GET .../categories` for Test Connection.
- **Public, no key required.** There is no Gemini key anywhere in the extension. `onInstalled` deletes a `gemini_api_key` left behind by v1.0.x.
- Contract prices are strings in `[0,1]` and are probabilities. `contractProbability` uses the bid/ask midpoint, else the last trade, else null (illiquid contracts often have no quotes).
- Events used: the next `FED<yymmdd>` market (labels like "Hike 25bps", "Cut 25bps", "Fed maintains rate") and the `RECESSION*` market ("Yes").
- There are no Amazon or product markets. Other categories (Commodities, Politics, Sports, Crypto) are unused.

---

## Storage, messages and settings

`chrome.storage.local` keys (see `STORAGE_KEYS` in `constants.js`):

| Key | Content |
| --- | --- |
| `context_dev_api_key` | User override of the context.dev key. Absent means "use the shipped default". |
| `context_cache` | `{ [ASIN]: { fetchedAt, signals, error? } }`, 24 h TTL, max 200 entries. |
| `gemini_macro_backoff` | `{until, reason}`: set for 5 minutes after a failed Gemini markets request so later analyses fall back instantly. Cleared by a successful fetch, Save, Clear cache or Test Connection. |
| `gemini_macro_cache` | Last macro signal, 3 h TTL, reused up to 24 h if Gemini is unreachable (`stale: true`). |
| `price_alerts` | Local price alerts: array, newest first, one per ASIN, max 200: `{id, asin, title, targetPrice, status: active\|paused\|triggered, priceAtCreation, lastPrice, lastCheckedAt, createdAt, triggeredAt, triggeredPrice}`. |
| `alert_email` | Address typed in Settings (optional). Listed with the alerts and used for the "Email me this" `mailto:`. |
| `alert_background_checks` | `false` when the hourly background check is switched off (default on). |
| `show_product_card`, `show_search_chips` | Options switches. Absent means on; `false` turns that surface off. Content scripts watch `chrome.storage.onChanged` and add or remove the UI live. |
| `context_pause` | `{until, reason}`: circuit breaker set after a 401/402/403/429 from context.dev; no calls until `until` (30 min) or until settings are saved / Test Connection succeeds. |
| `price_history` | `{ [ASIN]: [[timestamp, price], ...] }`: prices this browser has seen (max 40 points per ASIN, 300 ASINs, 120 days). Written by `price-history.js`. |
| `last_analysis`, `recent_analyses`, `analysis_count` | Popup display data (`recent_analyses` holds the last 5 products, see `recent.js`). |

Messages (content/popup/options to worker), names in `MSG`:
`PO_ANALYZE_PRODUCT`, `PO_GET_STATUS`, `PO_TEST_CONNECTION`, `PO_OPEN_OPTIONS`, `PO_CLEAR_CACHE`, `PO_CLEAR_HISTORY`, and for price alerts `PO_ALERT_STATE`, `PO_ALERT_CREATE`, `PO_ALERT_UPDATE`, `PO_ALERT_REMOVE`, `PO_ALERT_LIST`, `PO_ALERT_TEST_NOTIFICATION`. Every response is `{ok:true,data}` or `{ok:false,error}`.

Request payload extras: `forceRefresh` (product page retry) and `light` (search results, no context.dev calls). Result contract returned by `PO_ANALYZE_PRODUCT`: `{ asin, title, light, projection: {currentPrice, volatility, projectedMid, deltaPercentMonth, deltaAmount, tiers:{lowest,low,mid,high,highest}, recommendation:{action,label,message}, confidence}, meta: {history:{count,low,high,avg,spanDays}|null, context:{status,fromCache,fetchedAt,signalCount,error}, gemini:{status,isSimulated,source,rationale,summary,stale,sentimentMultiplier,discountProbability,error}} }`. The widget, popup and tests all depend on this shape; change it in one commit across all of them.

Settings UX: the default context.dev key is pre-filled in Options; saving it unchanged deletes the override. Saving settings clears the macro cache.

---

## Development workflow

Requirements: Node 20+ (tested on 22), Chrome. No install is needed to run unit tests; `npm install` is only needed for e2e.

```bash
cd amazon-price-oracle
npm test                 # unit tests, ~1 s
npm install              # once, for e2e (puppeteer-core)
npx @puppeteer/browsers install chrome@stable   # one-off: Chrome for Testing (branded Chrome 137+ ignores --load-extension)
CHROME_PATH=/path/to/chrome npm run e2e         # full extension test against mocks, ~5 s; screenshots in tests/screenshots/
npm run pack             # rebuild ../PriceOracle.zip
```

Day-to-day loop:
1. Edit code under `src/`.
2. In `chrome://extensions` click the reload icon on the extension, then reload the Amazon tab. (Service worker edits need the extension reload; content script edits also need the tab reload.)
3. Debug: service worker console via the extension card's "service worker" link; page console for content scripts; popup via right-click, Inspect.
4. Run `npm test` and `npm run e2e` before committing.
5. If you changed anything under `amazon-price-oracle/` that ships, run `npm run pack` and commit the updated `PriceOracle.zip` with the change.

Run the mock harness by hand: `npm run demo`, then launch Chrome with the host-resolver flags documented at the top of `test-page/serve.mjs`.

---

## Testing

- **Unit** (`tests/engine.test.mjs`): everything that is pure. Add a test for any new formula, parser rule or fallback. Use fixtures shaped like the real API responses (see `ECONOMICS` in the test file for the Gemini shape; the scrape wrapper shape is in `unwrapScrapeResponse` tests).
- **E2E** (`tests/e2e.mjs`): injects the widget, checks placement and Shadow DOM isolation against hostile CSS, verifies the exact context.dev request (Bearer key, URL, formats, schema), caches, variant re-render without reload, options flows, Gemini live and offline fallback, welcome tab, popup modal. It maps `www.amazon.com`, `api.context.dev` and `api.gemini.com` to the local mock via `--host-resolver-rules`, so it needs no network and no credits.
- **Shipped-artifact check:** `unzip PriceOracle.zip -d /tmp/x && EXT_DIR=/tmp/x npm run e2e`.
- **Live check** (manual, costs credits): load the extension and open `https://www.amazon.com/dp/B09B8V1LZ3`.
- The e2e test found real bugs before (a stale storage-key reference); keep it green and extend it with each feature.

---

## Best practices and pitfalls

For humans and AI agents collaborating on this repo:

1. **Keep logic pure and tested.** Put maths and parsing in functions that take plain data, with no `chrome.*` or `fetch`. Only `service-worker.js`, the API clients and UI files touch the platform.
2. **All network calls go through the service worker.** Never `fetch` external APIs from a content script, popup or options page (CORS, and keys would leak into page context).
3. **Never break the page.** Wrap external calls, return a typed fallback, and surface state to the UI (`context.status`, `gemini.status`). A missing price or API outage must produce a clear state, not an exception.
4. **Content scripts are classic scripts.** No `import`/`export`. Use the `PriceOracle` namespace and keep the manifest order. Wrap in an IIFE, guard against double injection (`__priceOracleLoaded`).
5. **Do not read or mutate Amazon's DOM beyond what is needed.** Amazon's markup changes often: add selector *fallbacks* rather than replacing selectors; avoid generic selectors such as `.a-price .a-offscreen` on the whole page (they match carousel prices).
6. **Shadow DOM hygiene.** All widget CSS lives in `widget-template.js`. Outer `!important` rules can still reach the *host* element and inherit inward, so inheritable properties are re-asserted on `.po-card`. Escape every dynamic string with `escapeHtml` before putting it in `innerHTML`.
7. **Avoid mutation loops.** The widget lives in a shadow root (not observed). Re-analysis is gated by an `asin|price` signature and a debounce. Keep it that way if you change rendering.
8. **Protect API credits.** context.dev is about 5 credits per scrape; keep the 24 h per-ASIN cache and negative caching. Test Connection must use the credit-free endpoint. Tests use mocks, never the real API.
9. **No inline scripts or `eval`** (MV3 CSP). New UI pages use `<script type="module" src>`.
10. **Single source of truth for constants** in `src/shared/constants.js`. If you add a message type used by `content.js`, mirror it there by hand and note it.
11. **Change the result contract atomically** (worker, widget, popup, tests, this README).
12. **Keep the zip in sync.** Any shipped-file change means `npm run pack` and committing `PriceOracle.zip` in the same commit, or users will install stale code.
13. **No secrets in the repo beyond the shipped default context.dev key.** Never commit real user keys. Do not log keys.
14. **Formatting and style:** modern JS (ES2020+), small documented functions, JSDoc for exported functions and data shapes, comments only for non-obvious intent. Use `const`, strict equality, and early returns.
15. **Commit hygiene:** one logical change per commit, imperative message ("Add...", "Fix..."), tests with the change. `node_modules/` and `tests/screenshots/` are git-ignored.
16. **E2E gotchas:** background tabs do not paint, so `waitForFunction` (rAF polling) stalls in hidden tabs; call `bringToFront()` or close tabs that steal focus (the welcome tab does). Use Chrome for Testing, not branded Chrome 137+.
17. **Branches and PRs:** branch from `main` (`feature/<topic>`), keep PRs small, include test output and a screenshot for UI changes.

---

## Releasing and tags

Version lives in `amazon-price-oracle/manifest.json` (`version`) and `amazon-price-oracle/package.json`. Use semantic versioning: `MAJOR.MINOR.PATCH`.

```bash
# 1. bump version in manifest.json and package.json
# 2. verify
cd amazon-price-oracle && npm test && npm run pack && cd ..
# 3. commit (include the rebuilt PriceOracle.zip)
git add -A && git commit -m "Release vX.Y.Z"
# 4. tag and push
git tag -a vX.Y.Z -m "PriceOracle vX.Y.Z"
git push origin main --tags
```

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which runs the unit tests, builds the zip and publishes a GitHub Release with `PriceOracle.zip` attached. That makes <https://github.com/JuneKim0712/babab/releases/latest/download/PriceOracle.zip> always point at the newest release. Even without the workflow, every tag serves the committed zip at `https://github.com/JuneKim0712/babab/raw/<tag>/PriceOracle.zip`.

Current release: `v1.0.0`.

---

## Decisions and deviations from the original brief

| Topic | Brief | What was built, and why |
| --- | --- | --- |
| context.dev endpoint | `POST /v1/extract`, `formats: ["json","markdown"]` | That path returns `ENDPOINT_NOT_FOUND`. Uses `POST /v1/web/scrape` with `formats: {json, markdown}` and a pricing `jsonParams.schema`, same Bearer auth. |
| Gemini | "gemini.com / Prediction" with an API key and a simulated fallback | Uses the Gemini prediction-markets API. Its market data is public, so no key is needed and it is live out of the box (v1.1 removed the optional key field entirely). The heuristic model remains the fallback and still runs when the API is unreachable. |
| Projection formula | `projectedMid = P*(1+(s-1)*v*(1-dp))` | Adds an optional additive `priceDrift` (default 0 reproduces the formula) because the base term cannot reach the +/-4% thresholds. |
| Confidence | "82%" in the mock | Derived heuristically (see above), capped at 82% heuristic-only, 88% with Gemini. |
| Example ASIN | `B0CX23V258` | Returns HTTP 404 from Amazon today. `B09B8V1LZ3` works and is used in docs/samples. |
| Install | Load unpacked | Same, plus a welcome tab, injection into already-open tabs and a ready zip/release. |
| Extra files | not in the file tree | `src/shared/constants.js`, `src/welcome/*`, tests, mock harness, scripts, zip. |

---

## Security and privacy

- The default context.dev key is shipped in `src/shared/constants.js` as requested, so anyone with the extension can read it. For public distribution replace it, or have users set their own in Options, or rotate it.
- User-entered keys live only in `chrome.storage.local` and are only sent to their own API from the service worker. Keys are never logged.
- Data sent out: the ASIN/product URL to context.dev; nothing user-identifying to Gemini (it is a GET for public market data). No analytics, no telemetry.
- Price alerts (optional): stored only in this browser (`chrome.storage.local`). Nothing about an alert is sent anywhere. The background check makes the same context.dev lookups as the card (product ID only). The email in Settings stays local and is used only to fill a `mailto:` the user opens. The website content script runs only on `xylm-306e6.web.app`, renders with `textContent` and talks only to the extension.
- Permissions are minimal: `storage`, `scripting` (to inject into already-open Amazon tabs on install), `alarms` and `notifications` (price alerts), and hosts for Amazon, context.dev and Gemini. The PriceOracle site is matched by a content script only (no host permission, no network access to it). There is no `identity` permission.
- Shadow DOM and `escapeHtml` prevent page CSS leakage and HTML injection from product titles or API strings.

---

## Known limitations and roadmap

- Amazon US only (`amazon.com`); prices are formatted as USD.
- No external price history. The extension builds a local one from prices it has seen (see `price-history.js`), which only helps for products you have visited before. Idea: integrate a real price-history source.
- The product forecast is a heuristic model. Ideas: calibrate coefficients against collected history; add more Gemini markets (commodities, sector indices) as category-specific signals.
- Search chips need a visible price on the card; cards that only say "See options" get none. Search chips use cached context.dev data only (no credits) until the user asks for a deep analysis.
- Selectors target the desktop product page and the standard search grid; mobile layout and some Amazon A/B variants may not match. Add fallbacks in `amazon-parser.js`.
- Variant changes are detected through the DOM mutation of the price and `#ASIN`; exotic flows (quick view modals) are not handled.
- No Chrome Web Store listing yet (would need packaging, a privacy policy and key handling for the default key).
- Possible UX: price alerts, options for threshold percentage, localisation, dark mode.

---

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| No widget | Not a product page (no `/dp/<ASIN>` and no `#ASIN`), no price on the page (unavailable item), or extension not reloaded after an edit. Reload the extension and the tab. Check the page console for errors. |
| Widget says "Couldn't build a projection" | The worker returned an error (see text). Click Retry. Check the service worker console. |
| `context.dev: Offline` chip | context.dev returned an error (bad key, quota, ASIN 404, network). The card still renders using page data. Use Options, Test Connection. |
| `Gemini Markets: Offline` | `api.gemini.com` unreachable; the heuristic model is used. Cached macro odds up to 24 h old are used first. |
| Stale numbers after changing keys | Saving keys clears the macro cache; context.dev data is cached 24 h per ASIN. Popup, Clear cache. |
| Extension disappears after restart | Chrome's developer-mode extension prompt; choose to keep it. |
| e2e: `Target closed` / waits time out | A hidden tab is stalling rAF polling, or branded Chrome is being used. Use Chrome for Testing and `bringToFront()`. |
| e2e: no service worker target | Branded Chrome 137+ ignores `--load-extension`. Set `CHROME_PATH` to Chrome for Testing. |

---

## License

MIT, see [LICENSE](LICENSE).
