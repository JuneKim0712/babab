import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

await import('../src/content/amazon-parser.js');
const { Parser } = globalThis.PriceOracle;

const pages = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-page');
const load = (file, url) => {
  const dom = new JSDOM(fs.readFileSync(path.join(pages, file), 'utf8'), { url });
  return { doc: dom.window.document, loc: dom.window.location };
};
const fragment = (html, url = 'https://www.amazon.com/s?k=x') => {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url });
  return { doc: dom.window.document, loc: dom.window.location };
};

test('parsePrice handles currency formats, ranges and junk', () => {
  assert.equal(Parser.parsePrice('$1,299.00'), 1299);
  assert.equal(Parser.parsePrice('US$ 24.99'), 24.99);
  assert.equal(Parser.parsePrice('$10.00 - $20.00'), 10);
  assert.equal(Parser.parsePrice('\u00a0$7.50'), 7.5);
  assert.equal(Parser.parsePrice('$0.00'), null);
  assert.equal(Parser.parsePrice('See options'), null);
  assert.equal(Parser.parsePrice(''), null);
  assert.equal(Parser.parsePrice(null), null);
});

test('isSearchPage only matches the search results path', () => {
  const is = (p) => Parser.isSearchPage({ pathname: p });
  assert.equal(is('/s'), true);
  assert.equal(is('/s/'), true);
  assert.equal(is('/s/ref=nb_sb_noss'), true);
  assert.equal(is('/dp/B09B8V1LZ3'), false);
  assert.equal(is('/shop/x'), false);
  assert.equal(is('/gp/cart/view.html'), false);
});

test('product page: ASIN, price, list price, category and title are read', () => {
  const { doc, loc } = load('amazon-product.html', 'https://www.amazon.com/dp/B0CX23V258');
  const product = Parser.parseProduct(doc, loc);
  assert.equal(product.asin, 'B0CX23V258');
  assert.equal(product.price, 174.99);
  assert.equal(product.listPrice, 219);
  assert.match(product.category, /Electronics > Headphones/);
  assert.ok(product.title.length > 5);
  assert.equal(Parser.getAsin(doc, loc), 'B0CX23V258');
});

test('product page without a price yields null instead of a bogus card', () => {
  const { doc, loc } = fragment('<input id="ASIN" value="B0CX23V258"><span id="productTitle">Thing</span>', 'https://www.amazon.com/dp/B0CX23V258');
  assert.equal(Parser.parseProduct(doc, loc), null);
});

test('list price at or below the current price is ignored', () => {
  const { doc, loc } = fragment(
    `<input id="ASIN" value="B0CX23V258">
     <div id="corePriceDisplay_desktop_feature_div">
       <span class="priceToPay"><span class="a-offscreen">$50.00</span></span>
       <span class="basisPrice"><span class="a-offscreen">$40.00</span></span>
     </div>`,
    'https://www.amazon.com/dp/B0CX23V258'
  );
  assert.equal(Parser.parseProduct(doc, loc).listPrice, null);
});

test('search page: cards with a price are parsed, others are skipped', () => {
  const { doc, loc } = load('amazon-search.html', 'https://www.amazon.com/s?k=echo+dot&i=amazon-devices');
  const cards = Parser.getSearchCards(doc);
  assert.equal(cards.length, 4);
  const parsed = cards.map((c) => Parser.parseSearchCard(c));
  assert.deepEqual(parsed.map((p) => p && p.asin), ['B0SEARCH01', 'B0SEARCH02', null, 'B0SEARCH04']);
  assert.equal(parsed[0].price, 49.99);
  assert.equal(parsed[0].listPrice, 69.99);
  assert.equal(parsed[0].rating, 4.7);
  assert.equal(parsed[0].title, 'Echo Dot (5th Gen) smart speaker with Alexa');
  assert.equal(parsed[1].listPrice, null);
  assert.equal(parsed[3].price, 59.99); // whole/fraction spans only, trailing decimal point
  assert.equal(Parser.getSearchCategory(doc, loc), 'amazon devices');
});

test('search card: ASIN must be well formed and price must be positive', () => {
  const { doc } = fragment(`
    <div data-component-type="s-search-result" data-asin=""><span class="a-price"><span class="a-offscreen">$5.00</span></span></div>
    <div data-component-type="s-search-result" data-asin="SHORT"><span class="a-price"><span class="a-offscreen">$5.00</span></span></div>
    <div data-component-type="s-search-result" data-asin="b0abc12345"><span class="a-price"><span class="a-offscreen">$0.00</span></span></div>
    <div data-component-type="s-search-result" data-asin="b0abc12346"><span class="a-price"><span class="a-offscreen">$5.00</span></span></div>`);
  const out = Parser.getSearchCards(doc).map((c) => Parser.parseSearchCard(c));
  assert.deepEqual(out.map((p) => p && p.asin), [null, null, null, 'B0ABC12346']);
});

test('search card: strike-through price only counts when it is above the price', () => {
  const { doc } = fragment(`
    <div data-component-type="s-search-result" data-asin="B0ABC12345">
      <span class="a-price"><span class="a-offscreen">$30.00</span></span>
      <span class="a-price a-text-price"><span class="a-offscreen">$20.00</span></span>
    </div>`);
  assert.equal(Parser.parseSearchCard(Parser.getSearchCards(doc)[0]).listPrice, null);
});

test('search category: dropdown beats URL parameter beats sub-nav', () => {
  const url = 'https://www.amazon.com/s?k=a&i=garden';
  let { doc, loc } = fragment('<select id="searchDropdownBox"><option>All Departments</option><option selected>Toys &amp; Games</option></select>', url);
  assert.equal(Parser.getSearchCategory(doc, loc), 'Toys & Games');
  ({ doc, loc } = fragment('<select id="searchDropdownBox"><option selected>All Departments</option></select>', url));
  assert.equal(Parser.getSearchCategory(doc, loc), 'garden');
  ({ doc, loc } = fragment('<div id="nav-subnav" data-category="books"></div>', 'https://www.amazon.com/s?k=a&i=aps'));
  assert.equal(Parser.getSearchCategory(doc, loc), 'books');
  ({ doc, loc } = fragment('', 'https://www.amazon.com/s?k=a'));
  assert.equal(Parser.getSearchCategory(doc, loc), '');
});

test('search card: heading aria-label is used when the heading has no text', () => {
  const { doc } = fragment(`
    <div data-component-type="s-search-result" data-asin="B0ABC12345">
      <h2 aria-label="Echo Dot (5th Gen) smart speaker"><a href="#"><span></span></a></h2>
      <span class="a-price"><span class="a-offscreen">$49.99</span></span>
    </div>`);
  assert.equal(Parser.parseSearchCard(Parser.getSearchCards(doc)[0]).title, 'Echo Dot (5th Gen) smart speaker');
});

test('search card: rating falls back to an aria-label', () => {
  const { doc } = fragment(`
    <div data-component-type="s-search-result" data-asin="B0ABC12345">
      <span aria-label="4.3 out of 5 stars"></span>
      <span class="a-price"><span class="a-offscreen">$9.99</span></span>
    </div>`);
  assert.equal(Parser.parseSearchCard(Parser.getSearchCards(doc)[0]).rating, 4.3);
});

test('search card: a secondary "options from" price is never the main price', () => {
  const { doc } = fragment(`
    <div data-component-type="s-search-result" data-asin="B0ABC12345">
      <div data-cy="secondary-offer-recipe"><span class="a-price"><span class="a-offscreen">$5.00</span></span></div>
    </div>
    <div data-component-type="s-search-result" data-asin="B0ABC12346">
      <div data-cy="secondary-offer-recipe"><span class="a-price"><span class="a-offscreen">$5.00</span></span></div>
      <div data-cy="price-recipe"><span class="a-price"><span class="a-offscreen">$25.00</span></span></div>
    </div>`);
  const [only, both] = Parser.getSearchCards(doc);
  assert.equal(Parser.parseSearchCard(only), null);
  assert.equal(Parser.parseSearchCard(both).price, 25);
  assert.equal(Parser.getSearchPriceBox(both).closest('[data-cy]').getAttribute('data-cy'), 'price-recipe');
});

test('product page: newer price containers are recognised', () => {
  for (const html of [
    '<div id="apex_offerDisplay_desktop"><span class="a-price"><span class="a-offscreen">$42.00</span></span></div>',
    '<div id="tp_price_block_total_price_ww"><span class="a-offscreen">$42.00</span></div>',
    '<div class="reinventPricePriceToPayMargin"><span class="a-offscreen">$42.00</span></div>'
  ]) {
    const { doc, loc } = fragment(`<input id="ASIN" value="B0CX23V258">${html}`, 'https://www.amazon.com/dp/B0CX23V258');
    assert.equal(Parser.parseProduct(doc, loc)?.price, 42, html);
  }
});
