import test from 'node:test';
import assert from 'node:assert/strict';
import { RECENT_MAX, addRecent } from '../src/background/recent.js';

test('newest first, one row per ASIN', () => {
  let list = [];
  for (const asin of ['A', 'B', 'C']) list = addRecent(list, { asin, price: 1 });
  assert.deepEqual(list.map((e) => e.asin), ['C', 'B', 'A']);
  list = addRecent(list, { asin: 'A', price: 2 });
  assert.deepEqual(list.map((e) => e.asin), ['A', 'C', 'B']);
  assert.equal(list[0].price, 2);
});

test('list is capped', () => {
  let list = [];
  for (let i = 0; i < RECENT_MAX + 4; i++) list = addRecent(list, { asin: `X${i}` });
  assert.equal(list.length, RECENT_MAX);
  assert.equal(list[0].asin, `X${RECENT_MAX + 3}`);
});
