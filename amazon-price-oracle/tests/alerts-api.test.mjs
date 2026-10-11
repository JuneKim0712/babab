import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ALERTS,
  badgeFor,
  dueForCheck,
  findAlert,
  isEmail,
  mailtoUrl,
  normalizeAlert,
  notificationText,
  observePrice,
  patchAlert,
  removeAlertFrom,
  sanitizeAlerts,
  sortAlerts,
  summarizeAlerts,
  upsertAlert,
  validateTarget
} from '../src/background/alerts-api.js';

const NOW = 1_700_000_000_000;
const make = (asin, extra = {}) => ({ asin, title: `Item ${asin}`, targetPrice: 50, status: 'active', createdAt: NOW, ...extra });

test('validateTarget accepts money formats and rounds to cents', () => {
  assert.equal(validateTarget('$49.999', 60), 50);
  assert.equal(validateTarget(' 1,049.5 ', 2000), 1049.5);
  assert.equal(validateTarget(12, 0), 12);
});

test('validateTarget rejects empty, zero, negative, junk and targets at or above the price', () => {
  for (const bad of ['', '0', '-3', 'abc', null, undefined, '0.001']) assert.throws(() => validateTarget(bad, 60), /above \$0/);
  assert.throws(() => validateTarget('60', 60), /below the current price/);
  assert.throws(() => validateTarget('61', 60), /below the current price/);
});

test('normalizeAlert fills defaults and rejects unusable records', () => {
  const alert = normalizeAlert({ asin: 'b0abc12345', targetPrice: '19.989', title: 'T' });
  assert.equal(alert.asin, 'B0ABC12345');
  assert.equal(alert.id, 'po-B0ABC12345');
  assert.equal(alert.targetPrice, 19.99);
  assert.equal(alert.status, 'active');
  assert.equal(alert.lastPrice, null);
  for (const bad of [null, 'x', {}, { asin: 'short', targetPrice: 5 }, { asin: 'B0ABC12345' }, { asin: 'B0ABC12345', targetPrice: 0 }]) {
    assert.equal(normalizeAlert(bad), null);
  }
  assert.equal(normalizeAlert({ asin: 'B0ABC12345', targetPrice: 5, status: 'bogus' }).status, 'active');
  assert.equal(normalizeAlert({ asin: 'B0ABC12345', targetPrice: 5, title: 'x'.repeat(500) }).title.length, 200);
});

test('sanitizeAlerts drops junk, keeps one alert per product and sorts newest first', () => {
  const list = sanitizeAlerts([make('B000000001', { createdAt: 1 }), null, make('B000000002', { createdAt: 9 }), make('B000000001', { targetPrice: 99 }), 'x']);
  assert.deepEqual(list.map((a) => a.asin), ['B000000002', 'B000000001']);
  assert.equal(list[1].targetPrice, 50, 'the first record for a product wins');
  assert.deepEqual(sanitizeAlerts(undefined), []);
});

test('upsertAlert creates, then re-aims the same alert instead of duplicating it', () => {
  const first = upsertAlert([], { asin: 'b0abc12345', title: 'Echo Dot', targetPrice: '40', currentPrice: 55 }, NOW);
  assert.equal(first.list.length, 1);
  assert.equal(first.alert.priceAtCreation, 55);
  assert.equal(first.alert.lastPrice, 55);
  assert.equal(first.alert.createdAt, NOW);

  const second = upsertAlert(first.list, { asin: 'B0ABC12345', targetPrice: '35', currentPrice: 54 }, NOW + 5);
  assert.equal(second.list.length, 1);
  assert.equal(second.alert.targetPrice, 35);
  assert.equal(second.alert.priceAtCreation, 55, 'the original price is kept');
  assert.equal(second.alert.title, 'Echo Dot');
  assert.equal(second.alert.createdAt, NOW);
});

test('upsertAlert re-arms a fired alert and validates input', () => {
  const fired = [make('B0ABC12345', { status: 'triggered', triggeredAt: NOW, triggeredPrice: 45 })];
  const { alert } = upsertAlert(fired, { asin: 'B0ABC12345', targetPrice: 40, currentPrice: 60 });
  assert.equal(alert.status, 'active');
  assert.equal(alert.triggeredAt, null);
  assert.throws(() => upsertAlert([], { asin: 'B0ABC12345', targetPrice: 70, currentPrice: 60 }), /below the current price/);
  assert.throws(() => upsertAlert([], { asin: 'nope', targetPrice: 5, currentPrice: 60 }), /Invalid ASIN/);
});

test('upsertAlert refuses to grow past the cap but still edits an existing alert', () => {
  const full = Array.from({ length: MAX_ALERTS }, (_, i) => make(`B${String(i).padStart(9, '0')}`, { createdAt: i + 1 }));
  assert.throws(() => upsertAlert(full, { asin: 'ZZZZZZZZZZ', targetPrice: 5, currentPrice: 60 }), /up to 200/);
  const { list } = upsertAlert(full, { asin: full[3].asin, targetPrice: 5, currentPrice: 60 });
  assert.equal(list.length, MAX_ALERTS);
});

test('patchAlert pauses, re-arms and re-targets', () => {
  const list = sanitizeAlerts([make('B0ABC12345', { status: 'triggered', triggeredAt: NOW, triggeredPrice: 44 })]);
  const id = list[0].id;
  const rearmed = patchAlert(list, id, { status: 'active' });
  assert.equal(rearmed.alert.status, 'active');
  assert.equal(rearmed.alert.triggeredPrice, null);

  const paused = patchAlert(rearmed.list, id, { status: 'paused' });
  assert.equal(paused.alert.status, 'paused');

  const retargeted = patchAlert(list, id, { targetPrice: '30', toggleOnly: true });
  assert.equal(retargeted.alert.targetPrice, 30);
  assert.equal(retargeted.alert.status, 'active', 'a new target re-arms a fired alert');

  assert.throws(() => patchAlert(list, id, { targetPrice: '90', currentPrice: 60 }), /below the current price/);
  assert.throws(() => patchAlert(list, id, { status: 'triggered' }), /status must be/);
  assert.throws(() => patchAlert(list, 'po-GONE', { status: 'active' }), /no longer exists/);
});

test('removeAlertFrom removes only that alert', () => {
  const list = sanitizeAlerts([make('B000000001'), make('B000000002')]);
  assert.deepEqual(removeAlertFrom(list, 'po-B000000001').map((a) => a.asin), ['B000000002']);
  assert.equal(removeAlertFrom(list, 'po-nothing').length, 2);
});

test('observePrice fires once when the price reaches the target', () => {
  const list = sanitizeAlerts([make('B0ABC12345', { targetPrice: 50 })]);

  const above = observePrice(list, 'B0ABC12345', 52, NOW);
  assert.equal(above.fired, null);
  assert.equal(above.list[0].lastPrice, 52);
  assert.equal(above.list[0].lastCheckedAt, NOW);
  assert.equal(above.list[0].status, 'active');

  const hit = observePrice(above.list, 'b0abc12345', 49.5, NOW + 1);
  assert.equal(hit.fired.asin, 'B0ABC12345');
  assert.equal(hit.list[0].status, 'triggered');
  assert.equal(hit.list[0].triggeredPrice, 49.5);

  const again = observePrice(hit.list, 'B0ABC12345', 40, NOW + 2);
  assert.equal(again.fired, null, 'it does not fire twice');
  assert.equal(again.list[0].triggeredPrice, 49.5);
  assert.equal(again.list[0].lastPrice, 40);
});

test('observePrice fires on a price exactly equal to the target and ignores paused alerts and bad prices', () => {
  const list = sanitizeAlerts([make('B0ABC12345', { targetPrice: 50 }), make('B0ABC12346', { targetPrice: 50, status: 'paused' })]);
  assert.ok(observePrice(list, 'B0ABC12345', 50).fired);
  assert.equal(observePrice(list, 'B0ABC12346', 10).fired, null);
  assert.equal(observePrice(list, 'B0ABC12346', 10).list.find((a) => a.asin === 'B0ABC12346').status, 'paused');
  for (const bad of [0, -1, NaN, null, undefined, 'abc']) {
    const result = observePrice(list, 'B0ABC12345', bad);
    assert.equal(result.changed, false);
    assert.equal(result.list, list);
  }
  assert.equal(observePrice(list, 'B0UNKNOWN0', 5).changed, false);
});

test('dueForCheck picks stale active alerts, least recently checked first, up to the limit', () => {
  const HOUR = 3600_000;
  const list = sanitizeAlerts([
    make('B000000001', { lastCheckedAt: NOW - 5 * HOUR }),
    make('B000000002', { lastCheckedAt: NOW - 1 * HOUR }),
    make('B000000003', { lastCheckedAt: null }),
    make('B000000004', { lastCheckedAt: NOW - 9 * HOUR }),
    make('B000000005', { lastCheckedAt: NOW - 9 * HOUR, status: 'paused' }),
    make('B000000006', { lastCheckedAt: NOW - 9 * HOUR, status: 'triggered' })
  ]);
  assert.deepEqual(dueForCheck(list, NOW, 4 * HOUR, 5).map((a) => a.asin), ['B000000003', 'B000000004', 'B000000001']);
  assert.deepEqual(dueForCheck(list, NOW, 4 * HOUR, 2).map((a) => a.asin), ['B000000003', 'B000000004']);
});

test('findAlert is case-insensitive', () => {
  const list = sanitizeAlerts([make('B0ABC12345')]);
  assert.equal(findAlert(list, 'b0abc12345').asin, 'B0ABC12345');
  assert.equal(findAlert(list, 'B000000000'), null);
});

test('sortAlerts puts fired alerts first and is stable; summarizeAlerts counts', () => {
  const list = sanitizeAlerts([
    make('B000000001', { createdAt: 4, status: 'paused' }),
    make('B000000002', { createdAt: 3 }),
    make('B000000003', { createdAt: 2, status: 'triggered' }),
    make('B000000004', { createdAt: 1 })
  ]);
  assert.deepEqual(sortAlerts(list).map((a) => a.asin), ['B000000003', 'B000000002', 'B000000004', 'B000000001']);
  assert.deepEqual(summarizeAlerts(list), { total: 4, active: 2, paused: 1, triggered: 1 });
});

test('badgeFor counts alerts that reached their target', () => {
  assert.deepEqual(badgeFor({ total: 0, active: 0, paused: 0, triggered: 0 }), { text: '', title: 'PriceOracle' });
  assert.match(badgeFor({ total: 2, active: 2, paused: 0, triggered: 0 }).title, /watching 2 price alerts/);
  assert.match(badgeFor({ total: 1, active: 1, paused: 0, triggered: 0 }).title, /watching 1 price alert$/);
  assert.equal(badgeFor({ total: 3, active: 1, paused: 0, triggered: 2 }).text, '2');
  assert.equal(badgeFor({ total: 150, active: 0, paused: 0, triggered: 150 }).text, '99+');
});

test('notificationText names the item, the price and the target', () => {
  const alert = normalizeAlert({ asin: 'B0ABC12345', title: 'Echo Dot', targetPrice: 40, status: 'triggered', triggeredPrice: 38.5 });
  const { title, message } = notificationText(alert);
  assert.equal(title, 'Price target reached');
  assert.equal(message, 'Echo Dot is $38.50, at or below your $40.00 target.');
  assert.match(notificationText({ ...alert, title: '' }).message, /^Amazon item B0ABC12345 is/);
  assert.ok(notificationText({ ...alert, title: 'x'.repeat(300) }).message.length < 160);
});

test('isEmail and mailtoUrl', () => {
  assert.ok(isEmail('me@example.com'));
  assert.ok(isEmail(' me+deals@mail.example.co '));
  for (const bad of ['', 'me', 'me@', '@example.com', 'a b@example.com', 'me@example', null]) assert.equal(isEmail(bad), false);

  const alert = normalizeAlert({ asin: 'B0ABC12345', title: 'Echo & Dot', targetPrice: 40, status: 'triggered', triggeredPrice: 38 });
  const url = mailtoUrl('me@example.com', alert);
  assert.ok(url.startsWith('mailto:me@example.com?subject='));
  const body = new URLSearchParams(url.split('?')[1]).get('body');
  assert.match(body, /Echo & Dot is \$38\.00/);
  assert.match(body, /https:\/\/www\.amazon\.com\/dp\/B0ABC12345/);
});
