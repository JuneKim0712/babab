#!/usr/bin/env node
/**
 * Local test harness (development only; not part of the shipped extension).
 *
 * Serves, over HTTPS with a throw-away self-signed certificate:
 *   - https://www.amazon.com/dp/<ASIN>  -> test-page/amazon-product.html (mock product page)
 *   - https://www.amazon.com/s?k=...    -> test-page/amazon-search.html (mock search results)
 *   - POST /v1/web/scrape, GET /v1/org/logs -> mock context.dev (host api.context.dev)
 *   - GET  /v1/prediction-markets/*     -> mock Gemini prediction markets (host api.gemini.com)
 *   - GET  /__control?marketsDown=1|0   -> make the mock Gemini markets fail (tests the offline fallback)
 *   - accounts.google.com, identitytoolkit.googleapis.com, securetoken.googleapis.com -> mock Google OAuth + Firebase Auth
 *   - xylm-306e6.web.app/api/*          -> mock PriceOracle website API (create-alert, my-alerts; docs/ALERTS_INTEGRATION.md)
 *   - GET  /__stats                     -> request counters (used by tests/e2e.mjs)
 *
 * Launch Chrome so those hostnames resolve here:
 *   google-chrome \
 *     --host-resolver-rules="MAP www.amazon.com 127.0.0.1:$PORT, MAP api.context.dev 127.0.0.1:$PORT, MAP api.gemini.com 127.0.0.1:$PORT" \
 *     --ignore-certificate-errors --load-extension=/path/to/amazon-price-oracle \
 *     https://www.amazon.com/dp/B0CX23V258
 */
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 44391);
const DEFAULT_KEY = 'ctxt_secret_7390b0f7f788470c85aa687254599803';

export const stats = { extract: 0, extractAuthOk: 0, markets: 0, categories: 0, lastGeminiKeyHeader: null, marketsDown: false, lastExtractBody: null, contextStatus: 0,
  site: {
    alerts: {}, nextId: 1, creates: 0, updates: 0, deletes: 0, lists: 0,
    lastCreate: null, lastUpdate: null, lastDelete: null, lastAuthorization: null, lastAuthParams: null,
    signIns: 0, refreshes: 0, lastRedirectUri: null,
    validTokens: new Set(), tokenCounter: 0, tokenTtl: 3600,
    refuseLogin: false, idpFail: false, refreshRevoked: false, create422: false, createDelayMs: 0
  } };


function ensureCert() {
  const dir = path.join(os.tmpdir(), 'price-oracle-demo-cert');
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=price-oracle-demo',
      '-keyout', key, '-out', cert
    ], { stdio: 'ignore' });
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
};

const readBody = (req) => new Promise((resolve) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => resolve(data));
});

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const fakeJwt = (claims) => `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(claims)}.sig`;
const SITE_EMAIL = 'june@example.com';
const GOOGLE_CLIENT = '754413445676-dsqaqjdq1r5mpla7or2mlgjkg4cnf97m.apps.googleusercontent.com';
// Like the real site: JSON, and no CORS headers at all (the extension must call it from its service worker).
const siteJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

function issueToken() {
  const token = `fbid_${++stats.site.tokenCounter}`;
  stats.site.validTokens.add(token);
  return token;
}

/** Mock Google OAuth + Firebase Auth. Executable form of the sign-in part of docs/ALERTS_INTEGRATION.md. */
async function handleGoogle(host, req, res, url) {
  const site = stats.site;
  if (host === 'accounts.google.com' && url.pathname === '/o/oauth2/v2/auth') {
    const q = url.searchParams;
    site.lastAuthParams = Object.fromEntries(q);
    const redirect = q.get('redirect_uri') || '';
    let target;
    try {
      target = new URL(redirect);
    } catch {
      res.writeHead(400);
      return res.end('bad redirect_uri');
    }
    if (!target.hostname.endsWith('.chromiumapp.org') || q.get('client_id') !== GOOGLE_CLIENT || q.get('response_type') !== 'id_token' || !q.get('nonce')) {
      res.writeHead(400);
      return res.end('redirect_uri_mismatch / invalid_request');
    }
    site.signIns++;
    site.lastRedirectUri = redirect;
    const fragment = site.refuseLogin
      ? new URLSearchParams({ error: 'access_denied', state: q.get('state') })
      : new URLSearchParams({
          id_token: fakeJwt({ iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT, sub: 'g-1', email: SITE_EMAIL, name: 'June', nonce: q.get('nonce') }),
          state: q.get('state')
        });
    res.writeHead(302, { Location: `${redirect}#${fragment}` });
    return res.end();
  }
  if (host === 'identitytoolkit.googleapis.com' && url.pathname === '/v1/accounts:signInWithIdp') {
    const body = JSON.parse((await readBody(req)) || '{}');
    if (site.idpFail || !/id_token=/.test(body.postBody || '') || !/providerId=google\.com/.test(body.postBody || '')) {
      return siteJson(res, 400, { error: { code: 400, message: 'INVALID_IDP_RESPONSE : Unable to parse Google id_token' } });
    }
    return siteJson(res, 200, {
      idToken: issueToken(), refreshToken: 'rt_1', expiresIn: String(site.tokenTtl), email: SITE_EMAIL, displayName: 'June', localId: 'uid_june'
    });
  }
  if (host === 'securetoken.googleapis.com' && url.pathname === '/v1/token') {
    const form = new URLSearchParams(await readBody(req));
    site.refreshes++;
    if (site.refreshRevoked || form.get('grant_type') !== 'refresh_token' || form.get('refresh_token') !== 'rt_1') {
      return siteJson(res, 400, { error: { code: 400, message: 'INVALID_REFRESH_TOKEN', status: 'INVALID_ARGUMENT' } });
    }
    return siteJson(res, 200, { id_token: issueToken(), refresh_token: 'rt_1', expires_in: String(site.tokenTtl), user_id: 'uid_june' });
  }
  return siteJson(res, 404, { error: 'not found' });
}

const publicAlert = (a) => {
  const copy = { ...a };
  for (const hidden of ['email', 'userId', 'lastNotifiedAt']) delete copy[hidden];
  return copy;
};

/** Mock of the PriceOracle website API. Executable form of the alert part of docs/ALERTS_INTEGRATION.md. */
async function handleSite(req, res, url) {
  const site = stats.site;
  if (!url.pathname.startsWith('/api/')) return siteJson(res, 404, { error: 'not found' });
  const authorization = req.headers.authorization || '';
  site.lastAuthorization = authorization;
  const authed = authorization.startsWith('Bearer ') && site.validTokens.has(authorization.slice(7));

  if (url.pathname === '/api/create-alert') {
    if (req.method !== 'POST') return siteJson(res, 405, { error: 'Method not allowed' });
    const body = JSON.parse((await readBody(req)) || '{}');
    site.lastCreate = body;
    site.creates++;
    if (!body.email || !body.targetValue) return siteJson(res, 400, { error: 'email and targetValue are required' });
    if (site.createDelayMs) await new Promise((r) => setTimeout(r, site.createDelayMs));
    if (site.create422) return siteJson(res, 422, { error: 'Could not read a live price for this product. Nothing was saved.' });
    const asin = (String(body.targetValue).match(/\/dp\/([A-Z0-9]{10})/) || [])[1] || String(body.targetValue);
    const id = `al_${site.nextId++}`;
    site.alerts[id] = {
      id, email: String(body.email).toLowerCase(), userId: authed ? 'uid_june' : null, targetType: 'asin', targetValue: asin, retailer: 'amazon',
      productTitle: 'Sonic Aura Wireless Noise Cancelling Over-Ear Headphones', currentPriceAtCreation: 174.99,
      targetPrice: body.targetPrice ?? null, minDiscountPercent: null, triggerOnPredictedDrop: false,
      initialProjection: { projectedMid: 190.66, deltaPercentMonth: 9, recommendation: 'BUY_NOW' }, status: 'active', createdAt: new Date().toISOString()
    };
    return siteJson(res, 200, { success: true, alertId: id, alert: site.alerts[id], notice: '' });
  }

  if (url.pathname === '/api/my-alerts') {
    if (!authed) return siteJson(res, 401, { error: 'Sign in required' });
    if (req.method === 'GET') {
      site.lists++;
      const alerts = Object.values(site.alerts).filter((a) => a.userId === 'uid_june').reverse().map(publicAlert);
      return siteJson(res, 200, { success: true, alerts });
    }
    if (req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const alert = site.alerts[body.alertId];
      if (body.action === 'update') {
        site.lastUpdate = body;
        site.updates++;
        if (!alert || alert.userId !== 'uid_june') return siteJson(res, 404, { error: 'Alert not found' });
        if ('targetPrice' in body) alert.targetPrice = body.targetPrice;
        if ('status' in body) {
          if (body.status !== 'active' && body.status !== 'paused') return siteJson(res, 400, { error: 'Invalid status' });
          alert.status = body.status;
        }
        return siteJson(res, 200, { success: true });
      }
      if (body.action === 'delete') {
        site.lastDelete = body;
        site.deletes++;
        if (!alert || alert.userId !== 'uid_june') return siteJson(res, 404, { error: 'Alert not found' });
        delete site.alerts[body.alertId];
        return siteJson(res, 200, { success: true });
      }
      return siteJson(res, 400, { error: 'Unknown action' });
    }
  }
  return siteJson(res, 404, { error: 'not found' });
}

export function createServer() {
  return https.createServer(ensureCert(), async (req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    const url = new URL(req.url, 'https://localhost');

    if (url.pathname === '/__stats') return json(res, 200, stats);

    if (host === 'xylm-306e6.web.app') return handleSite(req, res, url);
    if (['accounts.google.com', 'identitytoolkit.googleapis.com', 'securetoken.googleapis.com'].includes(host)) return handleGoogle(host, req, res, url);

    if (host === 'api.context.dev' && url.pathname === '/v1/org/logs') {
      if (req.headers.authorization !== `Bearer ${process.env.EXPECTED_CONTEXT_KEY || DEFAULT_KEY}`) return json(res, 401, { error_code: 'NOT_FOUND' });
      return json(res, 200, { data: [], key_metadata: { credits_consumed: 0, credits_remaining: 989 } });
    }

    if (host === 'api.context.dev' && url.pathname === '/v1/web/scrape') {
      stats.extract++;
      const body = JSON.parse((await readBody(req)) || '{}');
      stats.lastExtractBody = body;
      if (stats.contextStatus) return json(res, stats.contextStatus, { error: 'forced failure' });
      const authOk = req.headers.authorization === `Bearer ${process.env.EXPECTED_CONTEXT_KEY || DEFAULT_KEY}`;
      if (authOk) stats.extractAuthOk++;
      else return json(res, 401, { error: 'invalid key' });
      return json(res, 200, {
        url: body.url,
        json: {
          requested: true,
          success: true,
          data: { title: 'Sonic Aura Headphones', category: 'Electronics > Headphones', currentPrice: 174.99, listPrice: 219, lowestPrice: 139, averagePrice: 189, rating: 4.4, reviewCount: 8412, boughtPastMonth: 3000 }
        },
        markdown: { requested: true, success: true, data: '# Sonic Aura Headphones\n4.4 out of 5 stars\n' },
        key_metadata: { credits_consumed: 5, credits_remaining: 994 }
      });
    }

    if (url.pathname === '/__control') {
      if (url.searchParams.has('marketsDown')) stats.marketsDown = url.searchParams.get('marketsDown') === '1';
      return json(res, 200, stats);
    }

    if (host === 'api.gemini.com' && url.pathname.startsWith('/v1/prediction-markets/')) {
      stats.lastGeminiKeyHeader = req.headers['x-gemini-apikey'] || null;
      if (stats.marketsDown) return json(res, 503, { reason: 'unavailable' });
      if (url.pathname.endsWith('/categories')) {
        stats.categories++;
        return json(res, 200, { categories: ['Sports', 'Crypto', 'Economics'] });
      }
      stats.markets++;
      const c = (label, bestBid, bestAsk, lastTradePrice) => ({ label, prices: { bestBid, bestAsk, lastTradePrice } });
      return json(res, 200, {
        data: [
          { ticker: 'FED261030', title: 'Fed decision in October?', expiryDate: '2099-10-30T04:00:00.000Z',
            contracts: [c('Fed maintains rate', '0.82', '0.86', '0.86'), c('Hike 25bps', '0.14', '0.17', '0.14'), c('Cut >25bps', '0.01', '0.02', '0.01')] },
          { ticker: 'RECESSION26', title: 'Recession this year?', expiryDate: '2099-02-01T00:00:00.000Z', contracts: [c('Yes', '0.03', '0.04', '0.05')] }
        ],
        pagination: { limit: 50, offset: 0, total: 2 }
      });
    }

    if (/^\/(dp|gp\/product)\//.test(url.pathname)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(here, 'amazon-product.html')));
    }
    if (url.pathname === '/s') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(here, 'amazon-search.html')));
    }
    res.writeHead(404);
    res.end('not found');
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, '127.0.0.1', () => {
    console.log(`PriceOracle demo harness listening on https://127.0.0.1:${PORT}`);
    console.log('See the header of test-page/serve.mjs for the Chrome flags that map amazon.com here.');
  });
}
