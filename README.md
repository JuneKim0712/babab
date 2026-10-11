# PriceOracle

A Chrome extension that adds a **Buy Timing & 30-day Price Projection** card under the price on Amazon product pages: WAIT, BUY NOW or FAIR PRICE, with five projected price tiers.

## Install (about 30 seconds, no keys or setup)

1. **Download** [`PriceOracle.zip`](PriceOracle.zip) and unzip it anywhere.
2. In Chrome go to `chrome://extensions`, switch on **Developer mode** (top right), click **Load unpacked** and pick the unzipped folder (the one that contains `manifest.json`).
3. A welcome tab opens. Click **Try it on a sample product**, or open any Amazon product page. The card appears under the price. Amazon tabs that were already open work immediately, no reload needed.

That's it: the context.dev key is built in and Gemini prediction-market data is public, so nothing needs configuring. Optional: pin the icon (puzzle piece in the toolbar, then the pin) for quick stats.

Keeping it installed: Chrome may show a "disable developer mode extensions" prompt on restart. Choose to keep the extension. To update, replace the folder's contents with a newer zip and click the reload icon on the extension's card.

Using a cloned repo instead of the zip? Load the `amazon-price-oracle/` folder.

## More

Everything else (how it works, projection maths, settings, tests, deviations from the original brief) is in [`amazon-price-oracle/README.md`](amazon-price-oracle/README.md).

After changing extension code, rebuild the zip with `cd amazon-price-oracle && npm run pack`.
