# PriceOracle — Amazon Buy Timing & Price Projection

A Manifest V3 Chrome extension that adds a **Price Timing Oracle** card directly under the price on Amazon product pages (`amazon.com`). It tells you whether to **WAIT**, **BUY NOW**, or that the price is **FAIR**, and shows five projected 30-day price tiers with a pin for today's price.

```
⚡ PRICE TIMING ORACLE                  [● context.dev: Connected]
RECOMMENDATION   [ WAIT — Expected to drop 8.4% (~$14.70) in 30 days ]  (82% confidence)
30-DAY PROJECTED PRICE TIERS
 $129.00   $145.00   $162.50   $189.00   $219.00
 LOWEST     LOW       MID       HIGH      HIGHEST
 ─────●────────────●────────▲──────────────────      [Current: $174.99]
📊 30-Day Delta: ▼ -8.4% (-$14.70 expected)
🔑 Gemini Status: Gemini Key: Pending (Running on heuristic model - click to configure)
```

## Install (Load unpacked)

1. Open `chrome://extensions/` and enable **Developer mode**.
2. Click **Load unpacked** and select this folder (`amazon-price-oracle/`, the one containing `manifest.json`).
3. Open any Amazon product page, e.g. `https://www.amazon.com/dp/B09B8V1LZ3`. The widget renders beneath the price.
4. Pick a different colour/size on the page: the widget re-renders in place, no reload needed.

No build step and no runtime dependencies.

### Adding the Gemini key (optional)

Right-click the extension icon → **Options** (or click the widget's Gemini badge, or use the popup's **Add Gemini key** modal) and paste your key. It is saved in `chrome.storage.local`. Use **Test Connection** to validate it before saving.

Until a key is saved the extension runs in **Prediction Simulation Mode**: a deterministic model built from category volatility, price vs. typical/list price, and the Amazon sale calendar (Prime Day, Back-to-School, Black Friday/Cyber Monday, …). Nothing breaks; results are just flagged as heuristic. A Gemini failure (bad key, quota, offline) falls back to the same model.

## How it works

| File | Role |
| --- | --- |
| `src/background/service-worker.js` | Message router, orchestration, all cross-origin `fetch` (no CORS issues), last-result storage for the popup |
| `src/background/context-dev.js` | context.dev client, signal extraction, 24-hour per-ASIN cache in `chrome.storage.local` |
| `src/background/gemini-prediction.js` | Gemini client (structured JSON), key check, heuristic simulation fallback |
| `src/background/projection-engine.js` | Volatility estimate, 5 quantile tiers, 30-day % change, recommendation, confidence |
| `src/content/amazon-parser.js` | ASIN / price / list price / category parsing with multiple selector fallbacks |
| `src/content/widget-template.js` | Shadow DOM markup and isolated CSS |
| `src/content/content.js` | Injection after `#corePriceDisplay_desktop_feature_div` (or top of `#buybox`), `MutationObserver` for variant changes |
| `src/popup/*` | Quick stats, key status, Gemini key modal |
| `src/options/*` | Settings: context.dev key (pre-filled), Gemini key, Test Connection |
| `src/shared/constants.js` | Endpoints, storage keys, message types |

### Projection maths

```
projectedMid      = P * (1 + (sentiment - 1) * volatility * (1 - discountProbability) + priceDrift)
deltaPercentMonth = (projectedMid - P) / P * 100

Lowest  (P5)  = P * (1 - 2.2 * volatility)      Low  (P25) = P * (1 - 1.1 * volatility)
Mid     (P50) = projectedMid
High    (P75) = P * (1 + 1.0 * volatility)      Highest (P95) = P * (1 + 2.1 * volatility)

deltaPercentMonth <= -4%  ->  WAIT        >= +4%  ->  BUY NOW        otherwise  ->  FAIR PRICE
```

`priceDrift` is an addition to the brief's formula (default `0`, which gives exactly the specified formula). With the sentiment multiplier bounded to 0.85–1.15 the base term can only move the mid price by roughly 1–3%, so the ±4% WAIT / BUY NOW thresholds could never trigger. `priceDrift` carries mean reversion toward the typical price and seasonal sale effects (from the heuristic model, or from Gemini when a key is set). If a strong drift pushes the mid outside the volatility band, the neighbouring tiers are widened so the five prices always read in ascending order.

## Deviations from the brief

- **context.dev endpoint.** `POST https://api.context.dev/v1/extract` returns `ENDPOINT_NOT_FOUND`. The client uses the documented `POST https://api.context.dev/v1/web/scrape` with `formats: { json: true, markdown: true }` and a pricing JSON schema, with the same Bearer authentication. One json+markdown scrape costs about 5 credits, which is why results are cached for 24 hours per ASIN. **Test Connection** uses the credit-free `GET /v1/org/logs?limit=1`.
- **Gemini.** "Gemini" is implemented with Google's Gemini API (`generativelanguage.googleapis.com`, model `gemini-2.0-flash`, structured JSON output, key sent in the `x-goog-api-key` header). The gemini.com exchange's prediction-market API needs a key and secret pair and has no price-forecast endpoint.
- **Price history.** Amazon pages do not expose price history, so context.dev usually returns list price, rating, review count, sales volume and category rather than a 30/90-day low. The heuristic model and confidence score handle missing signals.
- The `B0CX23V258` example ASIN in the brief currently returns HTTP 404 from Amazon. `B09B8V1LZ3` is a live product that works.

## Security note

The default context.dev key ships inside the extension source, as requested, so anyone who has the extension can read it. Replace it with your own in Options, or rotate the key before distributing. The Gemini key is only ever stored in `chrome.storage.local` and sent to Google from the service worker.

## Testing

```bash
npm test                 # unit tests (projection engine, signal parsing, heuristic model), plain Node
npm install              # once, for the e2e test (puppeteer-core)
npm run e2e              # loads the extension in Chrome for Testing against a mock Amazon page + mock APIs
```

The e2e test needs a Chrome that honours `--load-extension` (branded Google Chrome 137+ does not). Get one with `npx @puppeteer/browsers install chrome@stable` and point `CHROME_PATH` at it. It verifies injection, Shadow DOM isolation from hostile page CSS, the context.dev request, the 24-hour cache, variant re-rendering, options (pre-filled key, Test Connection, saving), the Gemini pending/active/error states and the popup modal. Screenshots go to `tests/screenshots/`.

`npm run demo` starts the same mock server on its own; the Chrome flags that map `amazon.com` to it are in the header of `test-page/serve.mjs`.

Regenerate the icons with `npm run icons`.
