# Changelog

Each revision improves reliability, UX, tests or docs. The core function is unchanged throughout:
the 5-tier 30-day projection (formulas in the README), the WAIT / BUY NOW / FAIR PRICE thresholds
(-4% / +4%), the Shadow DOM card on product pages, the context.dev + Gemini markets inputs, and the
heuristic fallback.

## 1.8.1 - context.dev no longer says "Offline" for half an hour after one rate limit

The shipped context.dev key is shared with the PriceOracle website, and its log showed about one in five
requests answered with HTTP 429 in bursts. 1.8.0 treated any 429 like a spent quota and paused context.dev for
30 minutes, so the chip read "Offline" long after the key was fine again. Now a 429 is retried once after 2.5 s;
if it persists the pause is 45 s to 5 min (the server's `Retry-After`, clamped). A 402 or a rejected key (401/403)
still pauses for 30 minutes and Test Connection still clears it. The projection, thresholds and inputs are unchanged.

## 1.8.0 - Local price alerts, notifications and the website alerts page (no sign-in)

Replaces the Firebase/Google sign-in alerts of 1.7.0. Note that the 1.7.0 sign-in was never exercised live
(it needed a Google redirect URI that was never registered), so nothing a user relied on is lost. The
projection, thresholds, inputs and fallbacks are unchanged. Details in
[docs/ALERTS_INTEGRATION.md](docs/ALERTS_INTEGRATION.md).

- Alerts are saved in this browser (`chrome.storage.local` key `price_alerts`, one per product). No account,
  no Firebase, no Google, no network for alerts.
- Settings: **email address** (validated, saved with Save), **Check prices in the background** switch, and
  **Send a test notification**. The email is listed with the alerts and used by the notification's
  **Email me this** button (a `mailto:`; the extension sends no email).
- When a price reaches the target the extension alerts the user: desktop notification (Open on Amazon, Email me
  this), toolbar badge with the number of alerts waiting, "Target reached" on the card, popup and website page.
  Fires once; **Re-arm** or a new target re-arms it.
- Prices are seen on product pages, in search results (no extra requests) and by an hourly background check of
  alerts not checked in 4 hours (max 5 per run, one context.dev credit each, switchable).
- Website: on <https://xylm-306e6.web.app/alerts/> a content script adds a "Set in your PriceOracle extension"
  section under the site's own list (Pause/Resume/Re-arm, Edit, Delete). It never touches the site's React
  state or `localStorage`, follows the single-page app's route changes, and the site's demo alerts are
  unaffected.
- Popup lists the local alerts with a status badge and Re-arm; search chips show a bell for items with an alert.
- Removed the `identity` permission, the Google and Firebase host permissions and the site host permission, the
  added `alarms` and `notifications` (the manifest `key` is kept). Deleted `account.js`, `alerts-client.js`
  and the `account_session` / `account_marker` storage (not read any more).
- Tests: alert helpers rewritten (unit), card and package guards updated, e2e covers set / fire / re-arm,
  notifications, popup list, search bell, Settings and the website page against a mock page using the site's
  stylesheet. 102 unit tests pass; e2e passes in real Chrome. The live site was checked against that mock, not
  an authenticated session.

## 1.7.0 - Price alerts through the PriceOracle website API (Google + Firebase)

Replaces the 1.6.0 draft, which targeted a hypothetical website API, with the real one documented for
project `xylm-306e6`. The projection, thresholds, inputs and fallbacks are unchanged. Details and the one
setup step (a Google redirect URI) are in [docs/ALERTS_INTEGRATION.md](docs/ALERTS_INTEGRATION.md).

- Sign in with Google from the card or Settings: Google OAuth (`chrome.identity`), exchanged for a Firebase ID
  token over the Identity Toolkit REST API. No Firebase SDK, no remote code. Tokens refresh automatically.
- Product card **Price alert** section: set a target (emailed to your Google address), update it, **Turn off**
  / **Turn on**, **Re-arm** after it fired, or **Remove**. Shows "Alert sent" for triggered alerts and the price
  at the time the alert was set, as recorded by the server.
- Alerts are created only on an explicit click, with a pending state for the slow first lookup (timeout 75 s),
  never twice for the same item (an existing alert is updated instead), and server errors such as a 422 are
  shown verbatim.
- All traffic goes through the service worker (the site sends no CORS headers); no Firestore access.
- Extension id is now fixed by a `key` in the manifest so a single Google redirect URI can be registered.
- Popup: "Price alerts" row with the account and active alert count (Amazon product alerts only).
- 401 handling: refresh once and retry; a revoked refresh token shows "Your sign-in expired".
- New host permissions: the site, `identitytoolkit.googleapis.com`, `securetoken.googleapis.com`.
- Removed the website-address field and `site_*` storage from 1.6.0 (cleaned up on update).
- New mock of Google OAuth, Firebase Auth and the site API in `test-page/serve.mjs`; 21 e2e steps and new unit
  tests (token handling, request bodies, alert matching, card states).

## 1.5.0 - "Ledger" visual redesign

Design only. The projection maths, thresholds, inputs and fallbacks are unchanged. Full palette and
rationale: [docs/DESIGN.md](docs/DESIGN.md).

- New palette and system built on Amazon's own colours plus GOV.UK, Carbon and Stripe-style restraint:
  one teal accent, flat 1px-ruled surfaces, no gradients, glows, shadows or emoji.
- Product card: quiet header with a chart mark, left-accent recommendation banner with a trend icon,
  five tiers with plain names, a flat range bar showing the likely band, and a key/value footer.
- Search chip: rectangular tag with an icon, same banner colours as the card.
- Popup, settings and welcome page rebuilt on shared tokens (`src/shared/tokens.css`); the lightning bolt
  emoji and indigo gradients are gone.
- New flat teal toolbar icon (axes and price line), generated by `scripts/generate-icons.js`.
- Status colours are never the only signal: every state also has an icon or text label; every text
  pairing meets WCAG AA.
- `tests/design.test.mjs` guards token sync between the extension pages and the widget, AA contrast,
  and the absence of emoji, gradients, soft shadows and the old indigo.
- New docs/DESIGN.md; refreshed screenshots.

## 1.4.4 - Property-based tests for the engine

- `tests/properties.test.mjs`: about 25,000 seeded pseudo-random cases (deterministic, reproducible) check the
  invariants the UI depends on: the five tiers always ascend and stay finite and positive (prices from one
  cent to a million dollars, wild volatility, drift and sentiment inputs); zero-drift output equals the spec
  formulas to the cent; the recommendation follows the -4% / +4% thresholds exactly (including the boundary
  values); confidence is an integer within 40-82 (heuristic) or 40-88 (live markets); volatility stays within
  4-35%; the heuristic model is bounded, deterministic and gives a sane projection for any product and date;
  the seasonal calendar behaves for every day of the year.
- Mutation check: removing the tier-ordering guard makes these tests fail, so they do guard the behaviour.
- No production code changed; no bugs were found.

## 1.4.3 - Linting

- ESLint (flat config, `npm run lint`) with separate rules for service-worker/page modules, classic content
  scripts and Node tooling. Unused variables and undefined names now fail CI.
- Fixed the two findings it reported (unused catch bindings in `messaging.js`).
- CI installs dependencies with `npm ci` and lints before running the unit tests.

## 1.4.2 - Fast fallback when Gemini markets is down

- After a failed Gemini markets request, the extension waits 5 minutes before trying again. During that time
  cards fall back to the heuristic model (or a stale reading up to 24 h old) immediately, instead of each
  analysis waiting out a 15 s timeout. The first successful request, Save in Settings, Clear cache, or
  Test Connection ends the backoff early.
- 3 new unit tests (fail fast, stale reading used, backoff ends and clears).

## 1.4.1 - Parser fallbacks for newer Amazon markup

- Product page: recognises the newer price containers (`#apex_offerDisplay_desktop`,
  `#tp_price_block_total_price_ww`, `.reinventPricePriceToPayMargin`), and the card can anchor to
  `#apex_offerDisplay_desktop` when the classic price block is missing.
- Search cards: title falls back to the heading's `aria-label` (empty-text headings), rating falls back to an
  `aria-label` ("4.3 out of 5 stars"), and "options from $X" secondary offers are never mistaken for the
  product's price. Chip placement and parsing share one price-box helper (`getSearchPriceBox`).
- Fixture-based tests for each variant (4 new, 57 unit tests in total).

## 1.4.0 - Recently analysed products

- The popup lists the last products you looked at (below the most recent one): title, verdict pill and price,
  each linking back to the product. Full analyses only: product pages and "Deep analysis" on a search chip (quick chip estimates do not fill the list).
- Rows are built with `textContent` and `encodeURIComponent`, so titles and ASINs can never inject markup.
- New pure module `recent.js` with unit tests (ordering, one row per ASIN, cap of 5), plus an end-to-end check.

## 1.3.2 - Circuit breaker for context.dev

- A rejected key (401/403) or exhausted quota (402/429) now pauses context.dev calls for 30 minutes for
  *all* products, instead of failing and retrying once per product. Cards keep working from page data and
  cached results; the chip tooltip explains "paused until HH:MM".
- The outage is not stored as a per-product error, so nothing stays stuck after the problem is fixed.
- Saving settings or a successful **Test Connection** resumes calls immediately.
- Unit tests (pause, no per-product error, stale cache served while paused, expiry) and an end-to-end test
  with a forced 401 (second product never reaches the API; Test Connection restores service).

## 1.3.1 - Performance and accessibility

- Price history no longer rewrites its storage blob when a product is revisited with an unchanged price. A
  search page of 60 cards used to trigger 60 full writes; now only genuinely new observations write.
- The product card is a labelled `region` and exposes `aria-busy` while loading, so screen readers announce
  it and its state.
- New tests for both.

## 1.3.0 - Local price history

- PriceOracle now remembers the prices it has seen per product (product pages and search cards) in
  `chrome.storage.local`: one point per price change or per 6 hours, 40 points per product, 300 products,
  120 days. Nothing leaves the browser.
- Once a product has at least 3 observations over at least 2 days, the observed low / high / average fill the
  low / high / average signals that context.dev rarely provides (context.dev data always wins). The projection
  maths is untouched; it simply receives better inputs.
- The card shows "Your price history: Seen 4 times over 10 days · low $X · high $Y" (also in the expanded chip)
  once a product has been seen twice.
- Popup shows a "Tracked prices" counter; Settings has a "Local data" panel with **Clear price history** and
  **Clear context.dev cache**.
- 7 new unit tests (dedupe, caps, expiry, thresholds, concurrent writes, eviction) and an end-to-end check.

## 1.2.1 - Parser hardening and CI

- `parseProduct(doc, loc)` now accepts the location, like `getAsin` already did, so the product parser no
  longer depends on the live `window.location` (found while writing the new tests).
- New DOM-based parser tests (jsdom, reusing the mock pages as fixtures): price formats and ranges,
  search-page detection, product and search-card parsing, malformed or zero-price cards, strike-through price
  rules, and category precedence (dropdown, URL parameter, sub-nav).
- New widget tests: pin position is monotonic and clamped, five tiers render, every dynamic string is
  HTML-escaped (card and chip), all context chip states, chip states, and when "Deep analysis" is offered.
- CI now also runs the browser end-to-end suite, once from source and once against the committed
  `PriceOracle.zip`. 39 unit tests in total.

## 1.2.0 - Controls and accessibility

- Options page has two switches, **Product pages** and **Search results**. They save immediately and apply live
  on open Amazon tabs (content scripts watch `chrome.storage.onChanged`); a switch that is off also stays off on
  newly opened pages and costs nothing (no observers, no requests).
- Search chips are keyboard accessible: Enter or Space expands, Escape collapses, and focus returns to the chip
  after each re-render. The expanded panel is a labelled region for screen readers.
- The context.dev chip tooltip shows how old the data is ("fetched 3 h ago").
- E2E now also covers the switches (live off and on, persistence across new pages) and keyboard use. 24 unit
  tests and 21 end-to-end checks.

## 1.1.1 - Reliability

- Fixed a lost-update race in the context.dev cache: analyses finishing at the same time (search pages)
  could overwrite each other's cached entries. Writes are now serialised and re-read the cache first.
- New shared `messaging.js` for the content scripts: one retry when the service worker was asleep, a 90 s
  timeout so a card never sits on "Analyzing…" forever, and no duplicated messaging code.
- Tabs that were open during an extension update now get the new content scripts injected (previously only
  on first install).
- Release workflow can be started by hand (`workflow_dispatch`, input: existing tag), fixing releases that
  did not trigger when a branch and tag were pushed together.
- New guard tests: manifest and `package.json` versions match, every manifest file exists, content script
  order, content scripts are not ES modules, no inline scripts in extension pages, and the committed
  `PriceOracle.zip` is not stale. Plus a regression test for the cache race. 24 unit tests in total.

## 1.1.0 - Search results and no Gemini key

- Chips on Amazon search results (light analysis that spends no context.dev credits, optional "Deep
  analysis" per product, lazy loading of cards, shared Gemini lookup).
- Removed the Gemini API key field everywhere; Gemini prediction-market data is public.
- Docs, screenshots and tests updated.

## 1.0.x - Initial release

- Product-page card, popup, options page with Test Connection, context.dev integration with 24 h cache,
  Gemini prediction-markets layer with heuristic fallback, one-click zip install and welcome page.
