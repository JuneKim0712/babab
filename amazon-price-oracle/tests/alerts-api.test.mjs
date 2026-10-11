import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCreateBody,
  buildDeleteBody,
  buildGoogleAuthUrl,
  buildUpdateBody,
  canRefresh,
  decodeJwtPayload,
  findAlertForAsin,
  firebaseErrorMessage,
  isTokenFresh,
  normalizeAlert,
  parseGoogleRedirect,
  refreshSession,
  sessionFromSignIn,
  validateTarget
} from '../src/background/alerts-api.js';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims) => `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`;
const CLIENT = 'client.apps.googleusercontent.com';
const redirect = (idToken, state = 'st', extra = '') => `https://abc.chromiumapp.org/#id_token=${idToken}&state=${state}${extra}`;

test('decodeJwtPayload reads unicode claims and rejects garbage', () => {
  assert.equal(decodeJwtPayload(jwt({ name: 'Zoë 김' })).name, 'Zoë 김');
  assert.throws(() => decodeJwtPayload('nope'), /malformed/);
  assert.throws(() => decodeJwtPayload('a.!!!.c'), /malformed/);
});

test('buildGoogleAuthUrl asks for an ID token with scopes, state, nonce and the account chooser', () => {
  const url = new URL(buildGoogleAuthUrl({ clientId: CLIENT, redirectUri: 'https://abc.chromiumapp.org/', state: 's', nonce: 'n', loginHint: 'a@b.co' }));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const p = Object.fromEntries(url.searchParams);
  assert.deepEqual(p, {
    client_id: CLIENT, response_type: 'id_token', redirect_uri: 'https://abc.chromiumapp.org/', scope: 'openid email profile',
    state: 's', nonce: 'n', prompt: 'select_account', login_hint: 'a@b.co'
  });
  assert.equal(new URL(buildGoogleAuthUrl({ clientId: CLIENT, redirectUri: 'https://x/', state: 's', nonce: 'n' })).searchParams.has('login_hint'), false);
});

test('parseGoogleRedirect returns the token only when state, nonce and audience match', () => {
  const ok = jwt({ nonce: 'n', aud: CLIENT, email: 'a@b.co' });
  assert.equal(parseGoogleRedirect(redirect(ok), { state: 'st', nonce: 'n', clientId: CLIENT }), ok);
  assert.throws(() => parseGoogleRedirect(redirect(ok, 'other'), { state: 'st', nonce: 'n', clientId: CLIENT }), /did not match/);
  assert.throws(() => parseGoogleRedirect(redirect(jwt({ nonce: 'x', aud: CLIENT })), { state: 'st', nonce: 'n', clientId: CLIENT }), /did not match/);
  assert.throws(() => parseGoogleRedirect(redirect(jwt({ nonce: 'n', aud: 'else' })), { state: 'st', nonce: 'n', clientId: CLIENT }), /different app/);
  assert.throws(() => parseGoogleRedirect('https://abc.chromiumapp.org/#state=st', { state: 'st', nonce: 'n', clientId: CLIENT }), /ID token/);
  assert.throws(() => parseGoogleRedirect('https://abc.chromiumapp.org/#error=access_denied&state=st', { state: 'st', nonce: 'n' }), /refused sign-in: access_denied/);
  assert.throws(() => parseGoogleRedirect(undefined, { state: 'st', nonce: 'n' }), /cancelled/);
});

test('firebaseErrorMessage keeps the error code only', () => {
  assert.equal(firebaseErrorMessage({ error: { message: 'INVALID_IDP_RESPONSE : Unable to parse Google id_token' } }, 'x'), 'INVALID_IDP_RESPONSE');
  assert.equal(firebaseErrorMessage({ error: { message: 'INVALID_REFRESH_TOKEN' } }, 'x'), 'INVALID_REFRESH_TOKEN');
  assert.equal(firebaseErrorMessage(null, 'HTTP 500'), 'HTTP 500');
});

test('sessionFromSignIn maps the Identity Toolkit response and falls back to token claims', () => {
  const now = 1000;
  assert.deepEqual(
    sessionFromSignIn({ idToken: 'T', refreshToken: 'R', expiresIn: '3600', email: 'A@B.co', displayName: 'Ann', localId: 'u1' }, now),
    { idToken: 'T', refreshToken: 'R', expiresAt: now + 3_600_000, email: 'a@b.co', name: 'Ann', uid: 'u1' }
  );
  const s = sessionFromSignIn({ idToken: jwt({ email: 'c@d.co', name: 'Cy', user_id: 'u2' }), refreshToken: 'R' }, now);
  assert.equal(s.email, 'c@d.co');
  assert.equal(s.uid, 'u2');
  assert.equal(s.expiresAt, now + 3_600_000);
  assert.throws(() => sessionFromSignIn({ idToken: 'T' }), /did not return a session/);
});

test('refreshSession swaps tokens, keeps identity, and tolerates a missing refresh token', () => {
  const session = { idToken: 'old', refreshToken: 'R', expiresAt: 1, email: 'a@b.co', name: 'A', uid: 'u' };
  assert.deepEqual(refreshSession(session, { id_token: 'new', refresh_token: 'R2', expires_in: '1800' }, 10), {
    ...session, idToken: 'new', refreshToken: 'R2', expiresAt: 10 + 1_800_000
  });
  assert.equal(refreshSession(session, { id_token: 'new' }, 0).refreshToken, 'R');
  assert.throws(() => refreshSession(session, {}), /refreshed token/);
});

test('isTokenFresh refreshes ahead of expiry; canRefresh needs a refresh token', () => {
  const s = { idToken: 'T', expiresAt: 10_000 };
  assert.equal(isTokenFresh(s, 2_000, 7_999), true);
  assert.equal(isTokenFresh(s, 2_000, 8_000), false);
  assert.equal(isTokenFresh({ expiresAt: 10_000 }, 0, 1), false);
  assert.equal(canRefresh({ refreshToken: 'R' }), true);
  assert.equal(canRefresh({ email: 'a', expired: true }), false);
});

test('validateTarget accepts money-ish input, rounds to cents and insists on a price below today', () => {
  assert.equal(validateTarget('149.999', 200), 150);
  assert.equal(validateTarget('$1,049.5', 2000), 1049.5);
  assert.equal(validateTarget(99, 100), 99);
  assert.throws(() => validateTarget('100', 100), /below the current price/);
  assert.throws(() => validateTarget('150', 100), /below the current price/);
  for (const bad of ['', 'abc', '0', '-5', '0.001', null, undefined, NaN]) assert.throws(() => validateTarget(bad, 100), /above \$0/, String(bad));
  assert.equal(validateTarget('150', 0), 150);
});

test('request bodies match docs/ALERTS_INTEGRATION.md', () => {
  assert.deepEqual(buildCreateBody({ email: 'a@b.co', asin: 'B0CX23V258', targetPrice: 150 }), {
    email: 'a@b.co', targetType: 'asin', targetValue: 'https://www.amazon.com/dp/B0CX23V258', targetPrice: 150
  });
  assert.deepEqual(buildUpdateBody({ alertId: 'x', targetPrice: 99.5 }), { action: 'update', alertId: 'x', targetPrice: 99.5 });
  assert.deepEqual(buildUpdateBody({ alertId: 'x', status: 'paused' }), { action: 'update', alertId: 'x', status: 'paused' });
  assert.deepEqual(buildUpdateBody({ alertId: 'x', status: 'active', targetPrice: 5 }), { action: 'update', alertId: 'x', targetPrice: 5, status: 'active' });
  assert.throws(() => buildUpdateBody({ alertId: 'x', status: 'triggered' }), /active.*paused/);
  assert.deepEqual(buildDeleteBody('x'), { action: 'delete', alertId: 'x' });
});

test('normalizeAlert reads the website document and is defensive', () => {
  const raw = { id: 'a1', targetType: 'asin', targetValue: 'b0cx23v258', retailer: 'amazon', productTitle: 'T', currentPriceAtCreation: 174.99, targetPrice: '150', status: 'triggered' };
  assert.deepEqual(normalizeAlert(raw), {
    id: 'a1', asin: 'B0CX23V258', targetType: 'asin', retailer: 'amazon', targetPrice: 150, status: 'triggered', title: 'T', priceAtCreation: 174.99
  });
  const bare = normalizeAlert({ alertId: 'a2', targetType: 'asin', targetValue: 'B0CX23V258', targetPrice: null });
  assert.equal(bare.id, 'a2');
  assert.equal(bare.targetPrice, null);
  assert.equal(bare.status, 'active');
  assert.equal(bare.retailer, 'amazon'); // old documents have no retailer: Amazon
  assert.equal(normalizeAlert({ id: 'x', targetValue: 'B0CX23V258', status: 'weird' }).status, 'active');
  for (const bad of [null, undefined, 'x', {}, { id: 'x' }, { targetValue: 'B0CX23V258' }]) assert.equal(normalizeAlert(bad), null);
});

test('findAlertForAsin picks the newest Amazon product alert and ignores Best Buy and category alerts', () => {
  const list = [
    { id: 'bb', targetType: 'sku', retailer: 'bestbuy', targetValue: 'B0CX23V258', status: 'active' },
    { id: 'cat', targetType: 'category', retailer: null, targetValue: 'B0CX23V258', status: 'active' },
    { id: 'new', targetType: 'asin', retailer: 'amazon', targetValue: 'B0CX23V258', status: 'paused' },
    { id: 'old', targetType: 'asin', targetValue: 'B0CX23V258', status: 'active' },
    { id: 'other', targetType: 'asin', retailer: 'amazon', targetValue: 'B0OTHER000', status: 'active' }
  ];
  assert.equal(findAlertForAsin(list, 'b0cx23v258').id, 'new');
  assert.equal(findAlertForAsin(list, 'B0NOPE0000'), null);
  assert.equal(findAlertForAsin(undefined, 'B0CX23V258'), null);
});
