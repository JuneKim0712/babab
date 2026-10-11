# Changelog

Each revision improves reliability, UX, tests or docs. The core function is unchanged throughout:
the 5-tier 30-day projection (formulas in the README), the WAIT / BUY NOW / FAIR PRICE thresholds
(-4% / +4%), the Shadow DOM card on product pages, the context.dev + Gemini markets inputs, and the
heuristic fallback.

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
