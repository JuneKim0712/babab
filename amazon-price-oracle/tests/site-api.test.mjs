import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAlertBody,
  buildConnectUrl,
  isSessionValid,
  normalizeAlert,
  normalizeSiteUrl,
  parseAuthRedirect,
  validateTarget
} from '../src/background/site-api.js';

test('normalizeSiteUrl returns an https origin and tolerates paths and a missing scheme', () => {
  assert.equal(normalizeSiteUrl('baba.example.com'), 'https://baba.example.com');
  assert.equal(normalizeSiteUrl(' https://baba.example.com/some/page?x=1 '), 'https://baba.example.com');
  assert.equal(normalizeSiteUrl('https://baba.example.com:8443/'), 'https://baba.example.com:8443');
});

test('normalizeSiteUrl only allows plain http for localhost', () => {
  assert.equal(normalizeSiteUrl('localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizeSiteUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.throws(() => normalizeSiteUrl('http://baba.example.com'), /https/);
  assert.throws(() => normalizeSiteUrl('ftp://baba.example.com'), /https/);
});

test('normalizeSiteUrl rejects empty and nonsense input', () => {
  assert.throws(() => normalizeSiteUrl(''), /Enter your website/);
  assert.throws(() => normalizeSiteUrl('   '), /Enter your website/);
  assert.throws(() => normalizeSiteUrl('not a url'), /website address/);
  assert.throws(() => normalizeSiteUrl('intranet'), /website address/);
});

test('buildConnectUrl carries the redirect, state and client', () => {
  const url = new URL(buildConnectUrl('https://baba.example.com', 'https://abc.chromiumapp.org/site', 'st8'));
  assert.equal(url.origin + url.pathname, 'https://baba.example.com/extension/connect');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://abc.chromiumapp.org/site');
  assert.equal(url.searchParams.get('state'), 'st8');
  assert.equal(url.searchParams.get('client'), 'priceoracle-extension');
});

test('parseAuthRedirect reads the session from the fragment', () => {
  const now = 1_000_000;
  const s = parseAuthRedirect('https://abc.chromiumapp.org/site#access_token=tok&expires_in=3600&email=a%40b.co&name=Ann&state=xyz', 'xyz', now);
  assert.deepEqual(s, { token: 'tok', email: 'a@b.co', name: 'Ann', expiresAt: now + 3_600_000 });
});

test('parseAuthRedirect falls back to the query string and a 24h default lifetime', () => {
  const now = 5;
  const s = parseAuthRedirect('https://abc.chromiumapp.org/site?access_token=t&state=s', 's', now);
  assert.equal(s.token, 't');
  assert.equal(s.expiresAt, now + 24 * 60 * 60 * 1000);
});

test('parseAuthRedirect refuses a wrong state, an error, a cancel and a missing token', () => {
  assert.throws(() => parseAuthRedirect('https://a.chromiumapp.org/site#access_token=t&state=other', 'mine'), /did not match/);
  assert.throws(() => parseAuthRedirect('https://a.chromiumapp.org/site#state=mine', 'mine'), /access token/);
  assert.throws(() => parseAuthRedirect('https://a.chromiumapp.org/site#error=access_denied&state=mine', 'mine'), /refused sign-in: access_denied/);
  assert.throws(() => parseAuthRedirect(undefined, 'mine'), /cancelled/);
});

test('isSessionValid needs a token that has not expired', () => {
  assert.equal(isSessionValid({ token: 't', expiresAt: 100 }, 99), true);
  assert.equal(isSessionValid({ token: 't', expiresAt: 100 }, 100), false);
  assert.equal(isSessionValid({ expiresAt: 0 }, 1), false);
  assert.equal(isSessionValid(null), false);
});

test('validateTarget accepts money-ish input, rounds to cents and insists on a price below today', () => {
  assert.equal(validateTarget('149.999', 200), 150);
  assert.equal(validateTarget('$1,049.5', 2000), 1049.5);
  assert.equal(validateTarget(99, 100), 99);
  assert.throws(() => validateTarget('100', 100), /below the current price/);
  assert.throws(() => validateTarget('150', 100), /below the current price/);
  for (const bad of ['', 'abc', '0', '-5', '0.001', null, undefined, NaN]) assert.throws(() => validateTarget(bad, 100), /above \$0/, String(bad));
  assert.equal(validateTarget('150', 0), 150); // toggling skips the current-price comparison
});

test('buildAlertBody matches the documented wire format', () => {
  assert.deepEqual(buildAlertBody({ asin: 'B0CX23V258', title: 'T', currentPrice: 174.99, targetPrice: 150, enabled: true }), {
    asin: 'B0CX23V258',
    title: 'T',
    url: 'https://www.amazon.com/dp/B0CX23V258',
    currency: 'USD',
    targetPrice: 150,
    currentPrice: 174.99,
    enabled: true,
    source: 'extension'
  });
  assert.equal(buildAlertBody({ asin: 'B0CX23V258', title: 'x'.repeat(999), currentPrice: 1, targetPrice: 0.5, enabled: false }).title.length, 300);
});

test('normalizeAlert is defensive about what the website returns', () => {
  assert.deepEqual(normalizeAlert({ id: 'a1', asin: 'b0cx23v258', targetPrice: '150', enabled: false, title: 'T', triggeredAt: '2026-01-02T03:04:05Z' }), {
    id: 'a1', asin: 'B0CX23V258', targetPrice: 150, enabled: false, title: 'T', triggeredAt: Date.parse('2026-01-02T03:04:05Z')
  });
  assert.equal(normalizeAlert({ asin: 'B0CX23V258', targetPrice: 150 }).enabled, true);
  assert.equal(normalizeAlert({ asin: 'B0CX23V258', targetPrice: 150 }).triggeredAt, null);
  for (const bad of [null, undefined, 'x', {}, { targetPrice: 0 }, { targetPrice: 'abc' }]) assert.equal(normalizeAlert(bad), null);
});
