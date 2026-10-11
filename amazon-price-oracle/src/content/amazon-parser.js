/**
 * Amazon product page and search-results parser.
 *
 * Classic content script (not a module). Exposes `globalThis.PriceOracle.Parser`.
 * Every extractor tries several selectors because Amazon A/B-tests its markup.
 */
(function (root) {
  'use strict';

  const PO = (root.PriceOracle = root.PriceOracle || {});

  const PRICE_SELECTORS = [
    '#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen',
    '#corePriceDisplay_desktop_feature_div .a-price:not(.a-text-price) .a-offscreen',
    '#corePrice_feature_div .a-price:not(.a-text-price) .a-offscreen',
    '#corePrice_desktop .a-price:not(.a-text-price) .a-offscreen',
    '#priceblock_ourprice',
    '#priceblock_dealprice',
    '#priceblock_saleprice',
    '#apex_desktop .a-price:not(.a-text-price) .a-offscreen',
    '#buybox .a-price:not(.a-text-price) .a-offscreen',
    '#price_inside_buybox',
    '#newBuyBoxPrice'
  ];

  const LIST_PRICE_SELECTORS = [
    '#corePriceDisplay_desktop_feature_div .basisPrice .a-offscreen',
    '#corePriceDisplay_desktop_feature_div .a-price.a-text-price .a-offscreen',
    '#corePrice_feature_div .a-price.a-text-price .a-offscreen',
    '#priceblock_listprice',
    '#listPrice',
    '.priceBlockStrikePriceString'
  ];

  /**
   * Extract the ASIN of the product currently displayed (variant-aware).
   * @param {Document} [doc]
   * @param {Location} [loc]
   * @returns {string|null}
   */
  function getAsin(doc = document, loc = location) {
    const fromInput = doc.querySelector('#ASIN')?.value;
    if (isAsin(fromInput)) return fromInput.toUpperCase();

    const fromPath = loc.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1];
    if (isAsin(fromPath)) return fromPath.toUpperCase();

    const fromAttr = doc.querySelector('[data-asin]:not([data-asin=""])')?.getAttribute('data-asin');
    if (isAsin(fromAttr) && /\/(?:dp|gp\/product)\//i.test(loc.pathname)) return fromAttr.toUpperCase();
    return null;
  }

  function isAsin(value) {
    return typeof value === 'string' && /^[A-Z0-9]{10}$/i.test(value);
  }

  /**
   * Convert text such as "$1,299.00", "US$ 24.99" or "$10.00 - $20.00" to a float.
   * Ranges resolve to their first (lowest) value.
   * @param {string|null|undefined} text
   * @returns {number|null}
   */
  function parsePrice(text) {
    if (!text) return null;
    const match = String(text).replace(/\u00a0/g, ' ').match(/\d[\d,]*(?:\.\d+)?|\.\d+/);
    if (!match) return null;
    const value = parseFloat(match[0].replace(/,/g, ''));
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  /** Price from the whole/fraction spans when `.a-offscreen` is absent. */
  function priceFromParts(container) {
    const whole = container.querySelector('.a-price-whole')?.textContent;
    if (!whole) return null;
    const fraction = container.querySelector('.a-price-fraction')?.textContent || '00';
    return parsePrice(`${whole.replace(/[^\d,]/g, '')}.${fraction.replace(/\D/g, '')}`);
  }

  /** Current price of the displayed offer, or null. */
  function getPrice(doc = document) {
    for (const selector of PRICE_SELECTORS) {
      const el = doc.querySelector(selector);
      if (!el) continue;
      const value = parsePrice(el.textContent) ?? parsePrice(el.getAttribute('aria-label'));
      if (value) return value;
    }
    const priceBox = doc.querySelector('#corePriceDisplay_desktop_feature_div .a-price, #corePrice_feature_div .a-price');
    return priceBox ? priceFromParts(priceBox) : null;
  }

  /** Strike-through / list price, or null. */
  function getListPrice(doc = document) {
    for (const selector of LIST_PRICE_SELECTORS) {
      const el = doc.querySelector(selector);
      const value = el && parsePrice(el.textContent);
      if (value) return value;
    }
    return null;
  }

  /** Category text from the breadcrumb, falling back to the search dropdown / nav. */
  function getCategory(doc = document) {
    const crumbs = [...doc.querySelectorAll('#wayfinding-breadcrumbs_feature_div li a, #wayfinding-breadcrumbs_container a')]
      .map((a) => a.textContent.trim())
      .filter(Boolean);
    if (crumbs.length) return crumbs.join(' > ');

    const dropdown = doc.querySelector('#searchDropdownBox');
    const selected = dropdown?.options?.[dropdown.selectedIndex]?.textContent?.trim();
    if (selected && !/^all departments$/i.test(selected)) return selected;

    const subnav = doc.querySelector('#nav-subnav')?.getAttribute('data-category');
    if (subnav) return subnav;

    const bylineCategory = doc.querySelector('#showing-breadcrumbs_div')?.textContent?.trim();
    return bylineCategory || '';
  }

  function getTitle(doc = document) {
    return (doc.querySelector('#productTitle')?.textContent || doc.title || '').trim().slice(0, 300);
  }

  function getRating(doc = document) {
    const text = doc.querySelector('#acrPopover')?.getAttribute('title') || doc.querySelector('#averageCustomerReviews .a-icon-alt')?.textContent;
    const match = text && text.match(/(\d(?:\.\d)?)\s*out of/i);
    return match ? parseFloat(match[1]) : null;
  }

  /**
   * Gather everything the service worker needs.
   * @param {Document} [doc]
   * @returns {{asin: string, price: number, listPrice: number|null, title: string, category: string, rating: number|null, url: string}|null}
   *          null when this is not a product page or no price is available yet.
   */
  function parseProduct(doc = document) {
    const asin = getAsin(doc);
    const price = getPrice(doc);
    if (!asin || !price) return null;
    const listPrice = getListPrice(doc);
    return {
      asin,
      price,
      listPrice: listPrice && listPrice > price ? listPrice : null,
      title: getTitle(doc),
      category: getCategory(doc),
      rating: getRating(doc),
      url: `https://www.amazon.com/dp/${asin}`
    };
  }

  // -------------------------------------------------------------------------
  // Search results
  // -------------------------------------------------------------------------

  const SEARCH_CARD_SELECTOR = 'div[data-component-type="s-search-result"][data-asin]';
  const SEARCH_PRICE_SELECTORS = [
    '.a-price:not(.a-text-price) .a-offscreen',
    '[data-cy="price-recipe"] .a-price:not(.a-text-price) .a-offscreen'
  ];

  /** Whether the URL is an Amazon search-results page (`/s?k=...`). */
  function isSearchPage(loc = location) {
    return /^\/s\/?$/.test(loc.pathname) || /^\/s\/ref=/.test(loc.pathname);
  }

  /**
   * Category of a search page: the department dropdown, else the `i` URL
   * parameter (for example "amazon-devices" becomes "amazon devices"), else the sub-nav.
   */
  function getSearchCategory(doc = document, loc = location) {
    const dropdown = doc.querySelector('#searchDropdownBox');
    const selected = dropdown?.options?.[dropdown.selectedIndex]?.textContent?.trim();
    if (selected && !/^all departments$/i.test(selected)) return selected;

    const fromParam = new URLSearchParams(loc.search).get('i');
    if (fromParam && fromParam !== 'aps') return fromParam.replace(/[-_,]+/g, ' ').trim();

    return doc.querySelector('#nav-subnav')?.getAttribute('data-category') || '';
  }

  /**
   * Read one search result card.
   * @param {Element} card
   * @returns {{asin: string, price: number, listPrice: number|null, title: string, rating: number|null}|null}
   *          null when the card has no ASIN or no visible price (for example "See options").
   */
  function parseSearchCard(card) {
    const asin = card.getAttribute('data-asin');
    if (!isAsin(asin)) return null;

    let price = null;
    for (const selector of SEARCH_PRICE_SELECTORS) {
      const el = card.querySelector(selector);
      price = el && parsePrice(el.textContent);
      if (price) break;
    }
    if (!price) {
      const box = card.querySelector('.a-price:not(.a-text-price)');
      price = box ? priceFromParts(box) : null;
    }
    if (!price) return null;

    const listText = card.querySelector('.a-price.a-text-price .a-offscreen')?.textContent;
    const listPrice = parsePrice(listText);
    const rating = parsePrice(card.querySelector('.a-icon-alt')?.textContent?.match(/(\d(?:\.\d)?)\s*out of/i)?.[1]);
    const title = (card.querySelector('h2')?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 300);

    return {
      asin: asin.toUpperCase(),
      price,
      listPrice: listPrice && listPrice > price ? listPrice : null,
      title,
      rating
    };
  }

  /** Every result card currently in the page. */
  function getSearchCards(doc = document) {
    return [...doc.querySelectorAll(SEARCH_CARD_SELECTOR)];
  }

  PO.Parser = {
    getAsin, getPrice, getListPrice, getCategory, getTitle, getRating, parsePrice, parseProduct,
    isSearchPage, getSearchCategory, parseSearchCard, getSearchCards, SEARCH_CARD_SELECTOR
  };
})(globalThis);
