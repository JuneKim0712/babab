#!/usr/bin/env node
/**
 * Local test harness (development only; not part of the shipped extension).
 *
 * Serves, over HTTPS with a throw-away self-signed certificate:
 *   - https://www.amazon.com/dp/<ASIN>  -> test-page/amazon-product.html (mock product page)
 *   - POST /v1/web/scrape, GET /v1/org/logs -> mock context.dev (host api.context.dev)
 *   - GET  /v1beta/models               -> mock Gemini key check (host generativelanguage.googleapis.com)
 *   - POST /v1beta/models/*             -> mock Gemini forecast
 *   - GET  /__stats                     -> request counters (used by tests/e2e.mjs)
 *
 * Launch Chrome so those hostnames resolve here:
 *   google-chrome \
 *     --host-resolver-rules="MAP www.amazon.com 127.0.0.1:$PORT, MAP api.context.dev 127.0.0.1:$PORT, MAP generativelanguage.googleapis.com 127.0.0.1:$PORT" \
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

export const stats = { extract: 0, extractAuthOk: 0, gemini: 0, geminiKeyCheck: 0, lastExtractBody: null };

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

export function createServer() {
  return https.createServer(ensureCert(), async (req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    const url = new URL(req.url, 'https://localhost');

    if (url.pathname === '/__stats') return json(res, 200, stats);

    if (host === 'api.context.dev' && url.pathname === '/v1/org/logs') {
      if (req.headers.authorization !== `Bearer ${process.env.EXPECTED_CONTEXT_KEY || DEFAULT_KEY}`) return json(res, 401, { error_code: 'NOT_FOUND' });
      return json(res, 200, { data: [], key_metadata: { credits_consumed: 0, credits_remaining: 989 } });
    }

    if (host === 'api.context.dev' && url.pathname === '/v1/web/scrape') {
      stats.extract++;
      const body = JSON.parse((await readBody(req)) || '{}');
      stats.lastExtractBody = body;
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

    if (host === 'generativelanguage.googleapis.com') {
      if (!req.headers['x-goog-api-key'] || req.headers['x-goog-api-key'] === 'bad-key') return json(res, 403, { error: 'bad key' });
      if (req.method === 'GET') {
        stats.geminiKeyCheck++;
        return json(res, 200, { models: [] });
      }
      stats.gemini++;
      await readBody(req);
      return json(res, 200, {
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          sentimentMultiplier: 0.88, discountProbability: 0.45, priceDrift: -0.09, rationale: 'Mock Gemini: sale season approaching.'
        }) }] } }]
      });
    }

    if (/^\/(dp|gp\/product)\//.test(url.pathname)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(here, 'amazon-product.html')));
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
