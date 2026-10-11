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
🔑 Gemini Status: Gemini Markets: Live — Fed hike odds 16%, cut odds 2% · recession odds 4%
```

## Install (Load unpacked)

Fastest path, from the repo root: download `PriceOracle.zip`, unzip it, then in `chrome://extensions` enable **Developer mode**, click **Load unpacked** and pick the unzipped folder. A welcome tab opens, and any Amazon tabs already open start working immediately (no reload). Full steps are in the [root README](../README.md).

From a clone, pick this folder (`amazon-price-oracle/`, the one containing `manifest.json`). No build step and no runtime dependencies. Rebuild the zip with `npm run pack`.

Then open any Amazon product page, e.g. `https://www.amazon.com/dp/B09B8V1LZ3`. The widget renders beneath the price; picking a different colour/size re-renders it in place.

### Gemini prediction markets (no key needed)

The Gemini layer uses the [Gemini prediction markets API](https://developer.gemini.com/prediction-markets-spec/markets) (`GET https://api.gemini.com/v1/prediction-markets/events?status=active&category=Economics`). Those market-data endpoints are public, so it is live out of the box. PriceOracle reads the next **Fed decision** market (probability of a hike vs. a cut) and the **recession** market, and turns them into a sentiment multiplier (0.85–1.15) and a discount-probability boost that are blended into the per-product heuristic model:

```
inflationPressure = P(hike) - P(cut)
sentiment         = 1 + 0.10 * inflationPressure - 0.50 * P(recession)
discountBoost     = 0.40 * P(recession) + 0.10 * max(0, -inflationPressure)
```

Contract prices are probabilities; a contract's probability is its bid/ask midpoint, else the last trade. Results are cached for 3 hours. If Gemini markets can't be reached the card says so and falls back to the heuristic model alone (**Prediction Simulation Mode**), so nothing breaks. These markets are macro-level (there are no Amazon or product markets), so they nudge the forecast rather than replace the product model.

An API key is **optional**: if you paste one in Options or the popup modal, it is stored in `chrome.storage.local` and sent as `X-GEMINI-APIKEY`. The public endpoints ignore it today.

## How it works

| File | Role |
| --- | --- |
| `src/background/service-worker.js` | Message router, orchestration, all cross-origin `fetch` (no CORS issues), last-result storage for the popup |
| `src/background/context-dev.js` | context.dev client, signal extraction, 24-hour per-ASIN cache in `chrome.storage.local` |
| `src/background/gemini-prediction.js` | Gemini prediction-markets client (Fed/recession odds), heuristic model and fallback |
| `src/background/projection-engine.js` | Volatility estimate, 5 quantile tiers, 30-day % change, recommendation, confidence |
| `src/content/amazon-parser.js` | ASIN / price / list price / category parsing with multiple selector fallbacks |
| `src/content/widget-template.js` | Shadow DOM markup and isolated CSS |
| `src/content/content.js` | Injection after `#corePriceDisplay_desktop_feature_div` (or top of `#buybox`), `MutationObserver` for variant changes |
| `src/popup/*` | Quick stats, status, optional Gemini key modal |
| `src/options/*` | Settings: context.dev key (pre-filled), optional Gemini key, Test Connection |
| `src/welcome/*` | Welcome tab shown after install |
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

`priceDrift` is an addition to the brief's formula (default `0`, which gives exactly the specified formula). With the sentiment multiplier bounded to 0.85–1.15 the base term can only move the mid price by roughly 1–3%, so the ±4% WAIT / BUY NOW thresholds could never trigger. `priceDrift` carries mean reversion toward the typical price and seasonal sale effects (from the heuristic model, nudged by the Gemini market odds). If a strong drift pushes the mid outside the volatility band, the neighbouring tiers are widened so the five prices always read in ascending order.

## Deviations from the brief

- **context.dev endpoint.** `POST https://api.context.dev/v1/extract` returns `ENDPOINT_NOT_FOUND`. The client uses the documented `POST https://api.context.dev/v1/web/scrape` with `formats: { json: true, markdown: true }` and a pricing JSON schema, with the same Bearer authentication. One json+markdown scrape costs about 5 credits, which is why results are cached for 24 hours per ASIN. **Test Connection** uses the credit-free `GET /v1/org/logs?limit=1`.
- **Gemini.** Implemented against the Gemini prediction-markets API. Its market-data endpoints are public, so the key from the brief is optional and Gemini data works with no setup. The extension never crashes without it, and it falls back to the heuristic model if the API is unreachable.
- **Price history.** Amazon pages do not expose price history, so context.dev usually returns list price, rating, review count, sales volume and category rather than a 30/90-day low. The heuristic model and confidence score handle missing signals.
- The `B0CX23V258` example ASIN in the brief currently returns HTTP 404 from Amazon. `B09B8V1LZ3` is a live product that works.

## Security note

The default context.dev key ships inside the extension source, as requested, so anyone who has the extension can read it. Replace it with your own in Options, or rotate the key before distributing. The optional Gemini key is only ever stored in `chrome.storage.local` and sent to api.gemini.com from the service worker.

## Testing

```bash
npm test                 # unit tests (projection engine, signal parsing, heuristic model), plain Node
npm install              # once, for the e2e test (puppeteer-core)
npm run e2e              # loads the extension in Chrome for Testing against a mock Amazon page + mock APIs
```

The e2e test needs a Chrome that honours `--load-extension` (branded Google Chrome 137+ does not). Get one with `npx @puppeteer/browsers install chrome@stable` and point `CHROME_PATH` at it. It verifies injection, Shadow DOM isolation from hostile page CSS, the context.dev request, the 24-hour cache, variant re-rendering, the welcome tab, options (pre-filled key, Test Connection, saving), Gemini markets live and offline fallback, and the popup modal. Screenshots go to `tests/screenshots/`.

`npm run demo` starts the same mock server on its own; the Chrome flags that map `amazon.com` to it are in the header of `test-page/serve.mjs`.

Run the same e2e checks against the shipped zip by unzipping it and setting `EXT_DIR`. Regenerate the icons with `npm run icons` and the zip with `npm run pack`.
