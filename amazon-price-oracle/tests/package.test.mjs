import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('manifest and package.json versions match', () => {
  assert.equal(manifest.version, pkg.version);
});

test('every file the manifest references exists', () => {
  const refs = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_ui.page,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap((c) => c.js)
  ];
  for (const ref of refs) assert.ok(fs.existsSync(path.join(root, ref)), `missing ${ref}`);
});

test('content scripts load in dependency order', () => {
  const js = manifest.content_scripts[0].js.map((f) => path.basename(f, '.js'));
  const index = Object.fromEntries(js.map((n, i) => [n, i]));
  assert.ok(index.messaging < index['search-results'] && index.messaging < index.content);
  assert.ok(index['amazon-parser'] < index['widget-template']);
  assert.ok(index['widget-template'] < index['search-results'] && index['widget-template'] < index.content);
});

test('content scripts are classic scripts (no import/export)', () => {
  for (const f of manifest.content_scripts[0].js) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.doesNotMatch(src, /^\s*(import|export)\s/m, `${f} must not be an ES module`);
  }
});

test('no extension page uses inline scripts (MV3 CSP)', () => {
  for (const page of [manifest.action.default_popup, manifest.options_ui.page, 'src/welcome/welcome.html']) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    for (const tag of html.match(/<script\b[^>]*>/g) || []) assert.match(tag, /\bsrc=/, `inline script in ${page}`);
  }
});

test('committed PriceOracle.zip is up to date with the sources', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'po-zip-')), 'PriceOracle.zip');
  execFileSync(process.execPath, [path.join(root, 'scripts', 'pack.mjs'), out], { stdio: 'ignore' });
  const committed = fs.readFileSync(path.join(root, '..', 'PriceOracle.zip'));
  assert.ok(committed.equals(fs.readFileSync(out)), 'PriceOracle.zip is stale: run `npm run pack` and commit it');
});

test('message names mirrored in content.js exist in shared constants', async () => {
  const { MSG } = await import('../src/shared/constants.js');
  const src = fs.readFileSync(path.join(root, 'src/content/content.js'), 'utf8');
  const block = src.match(/const MSG = \{([\s\S]*?)\};/)[1];
  const pairs = [...block.matchAll(/(\w+):\s*'([A-Z_]+)'/g)];
  assert.ok(pairs.length >= 5);
  for (const [, key, value] of pairs) assert.equal(MSG[key], value, `MSG.${key} differs from constants.js`);
});

test('the extension asks only for the permissions it needs', () => {
  assert.deepEqual([...manifest.permissions].sort(), ['identity', 'scripting', 'storage']);
  assert.ok(!manifest.host_permissions.some((h) => h === '<all_urls>' || h === 'https://*/*'), 'no broad host permissions');
  assert.ok(manifest.host_permissions.includes('https://xylm-306e6.web.app/*'), 'the alerts API needs host permission (it sends no CORS headers)');
});

test('manifest key pins the extension id used for the Google redirect URI', async () => {
  const crypto = await import('node:crypto');
  const hex = crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
  const id = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
  assert.equal(id, 'gnckobeflimeehgaaliiibfliebjapbe');
});
