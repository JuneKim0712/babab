/**
 * Recently analysed products shown in the popup. Pure, so it is unit tested
 * (the service worker itself cannot be imported outside Chrome).
 */
export const RECENT_MAX = 5;

/**
 * Newest first, one row per ASIN, at most RECENT_MAX rows.
 * @param {Array<{asin: string}>} list
 * @param {{asin: string}} entry
 */
export function addRecent(list, entry) {
  return [entry, ...list.filter((e) => e.asin !== entry.asin)].slice(0, RECENT_MAX);
}
