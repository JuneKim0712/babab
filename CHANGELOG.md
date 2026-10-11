# Changelog

Each revision improves reliability, UX, tests or docs. The core function is unchanged throughout:
the 5-tier 30-day projection (formulas in the README), the WAIT / BUY NOW / FAIR PRICE thresholds
(-4% / +4%), the Shadow DOM card on product pages, the context.dev + Gemini markets inputs, and the
heuristic fallback.

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
