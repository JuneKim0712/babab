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
 *   - https://baba.test/*               -> mock PriceOracle website: /extension/connect sign-in bridge + /api/alerts (docs/WEBSITE_INTEGRATION.md)
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
  site: { alerts: {}, lastPut: null, puts: 0, deletes: 0, connects: 0, lastRedirectUri: null, tokenValid: true, refuseLogin: false, corsBroken: false } };
const SITE_TOKEN = 'po_site_token_123';

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

const SITE_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type'
};
const siteJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...(stats.site.corsBroken ? {} : SITE_HEADERS) });
  res.end(JSON.stringify(body));
};

/** Mock PriceOracle website. This is the executable form of docs/WEBSITE_INTEGRATION.md. */
async function handleSite(req, res, url) {
  const site = stats.site;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, stats.site.corsBroken ? {} : SITE_HEADERS);
    return res.end();
  }

  if (url.pathname === '/extension/connect') {
    site.connects++;
    const redirect = url.searchParams.get('redirect_uri') || '';
    site.lastRedirectUri = redirect;
    const state = url.searchParams.get('state') || '';
    let target;
    try {
      target = new URL(redirect);
    } catch {
      res.writeHead(400);
      return res.end('bad redirect_uri');
    }
    if (!target.hostname.endsWith('.chromiumapp.org')) {
      res.writeHead(400);
      return res.end('redirect_uri must be https://<extension-id>.chromiumapp.org/...');
    }
    const fragment = site.refuseLogin
      ? new URLSearchParams({ error: 'access_denied', state })
      : new URLSearchParams({ access_token: SITE_TOKEN, token_type: 'Bearer', expires_in: '3600', email: 'june@example.com', name: 'June', state });
    res.writeHead(302, { Location: `${redirect}#${fragment}` });
    return res.end();
  }

  if (url.pathname.startsWith('/api/')) {
    if (!site.tokenValid || req.headers.authorization !== `Bearer ${SITE_TOKEN}`) return siteJson(res, 401, { error: 'unauthorized' });
    if (url.pathname === '/api/session' && req.method === 'DELETE') return siteJson(res, 200, { ok: true });
    if (url.pathname === '/api/alerts' && req.method === 'GET') return siteJson(res, 200, { alerts: Object.values(site.alerts) });
    const m = url.pathname.match(/^\/api\/alerts\/([A-Z0-9]{10})$/);
    if (m) {
      const asin = m[1];
      if (req.method === 'GET') return site.alerts[asin] ? siteJson(res, 200, { alert: site.alerts[asin] }) : siteJson(res, 404, { error: 'not found' });
      if (req.method === 'PUT') {
        const body = JSON.parse((await readBody(req)) || '{}');
        site.lastPut = body;
        site.puts++;
        const prev = site.alerts[asin];
        site.alerts[asin] = {
          id: prev?.id || `alr_${asin}`, asin, title: body.title, targetPrice: body.targetPrice, enabled: body.enabled,
          createdAt: prev?.createdAt || new Date().toISOString(), triggeredAt: null
        };
        return siteJson(res, prev ? 200 : 201, { alert: site.alerts[asin] });
      }
      if (req.method === 'DELETE') {
        site.deletes++;
        delete site.alerts[asin];
        return siteJson(res, 200, { ok: true });
      }
    }
  }
  return siteJson(res, 404, { error: 'not found' });
}

export function createServer() {
  return https.createServer(ensureCert(), async (req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    const url = new URL(req.url, 'https://localhost');

    if (url.pathname === '/__stats') return json(res, 200, stats);

    if (host === 'baba.test') return handleSite(req, res, url);

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
      for (const k of ['tokenValid', 'refuseLogin', 'corsBroken']) if (url.searchParams.has(k)) stats.site[k] = url.searchParams.get(k) === '1';
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
