/**
 * Messaging helper shared by the content scripts.
 *
 * Exposes `globalThis.PriceOracle.send(message)`, which resolves with the
 * service worker's `data` or rejects with an Error. Compared to a bare
 * chrome.runtime.sendMessage it:
 *  - retries once when the worker was asleep or restarting
 *    ("Receiving end does not exist"),
 *  - gives up after TIMEOUT_MS instead of leaving a card on "Analyzing…" forever,
 *  - never retries "Extension context invalidated" (the extension was reloaded;
 *    callers treat that as "stay silent").
 */
(function (root) {
  'use strict';

  const PO = (root.PriceOracle = root.PriceOracle || {});
  const TIMEOUT_MS = 90000; // a cold context.dev scrape can take a while
  const RETRY_DELAY_MS = 400;

  function once(message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('PriceOracle timed out waiting for the background service')), TIMEOUT_MS);
      const done = (fn, value) => {
        clearTimeout(timer);
        fn(value);
      };
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const err = chrome.runtime.lastError;
          if (err) return done(reject, new Error(err.message));
          if (!response) return done(reject, new Error('No response from the PriceOracle service worker'));
          if (!response.ok) return done(reject, new Error(response.error || 'Unknown error'));
          done(resolve, response.data);
        });
      } catch (err) {
        done(reject, err);
      }
    });
  }

  const isTransient = (err) => /receiving end does not exist|message port closed|no response from/i.test(String(err && err.message));

  async function send(message, retries = 1) {
    try {
      return await once(message);
    } catch (err) {
      if (retries > 0 && isTransient(err)) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        return send(message, retries - 1);
      }
      throw err;
    }
  }

  PO.send = send;
})(globalThis);
