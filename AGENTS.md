# Agent / contributor quick rules

Read [README.md](README.md) first: purpose, architecture, file map, projection maths, API notes and the full best-practice list. The essentials:

- The extension lives in `amazon-price-oracle/`. `PriceOracle.zip` at the repo root is the shipped build.
- Content scripts (`src/content/*`) are classic scripts sharing `globalThis.PriceOracle`; background, popup, options and welcome code are ES modules.
- All external `fetch` calls go through `src/background/service-worker.js` and its clients. Never call APIs from pages.
- Price alerts are local (`price_alerts` in `chrome.storage.local`, see `docs/ALERTS_INTEGRATION.md`): no accounts, no servers. The only credit-spending background work is the capped hourly alert check (max 5 lookups per run, alerts not checked in 4 h).
- Search pages use `light` analyses: they must never spend context.dev credits (cache only). Only the explicit "Deep analysis" click may.
- Business logic stays pure (`projection-engine.js`, parsing, `computeMacroSignal`) and is unit tested.
- Every external dependency needs a fallback; the page must never break.
- Tests use mocks only. Do not call context.dev in tests (about 5 credits per scrape).
- Before committing: `cd amazon-price-oracle && npm run lint && npm test` (and `npm run e2e` for UI or pipeline changes). If shipped files changed, run `npm run pack` and commit `PriceOracle.zip` with them.
- Keep the worker/widget/popup/test result contract in sync (see README, "Storage, messages and settings").
- Releasing: bump `manifest.json` and `package.json` versions, rebuild the zip, commit, `git tag -a vX.Y.Z`, `git push origin main --tags`.
- Add a line to CHANGELOG.md for every revision (what improved, and that core behaviour is unchanged).
