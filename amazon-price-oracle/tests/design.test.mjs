import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const SURFACES = [
  'src/popup/popup.css', 'src/options/options.css', 'src/welcome/welcome.css',
  'src/popup/popup.html', 'src/options/options.html', 'src/welcome/welcome.html',
  'src/content/widget-template.js'
];

function tokensFrom(css) {
  return Object.fromEntries([...css.matchAll(/(--po-[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('extension pages and the content-script widget share one token set', () => {
  const css = tokensFrom(read('src/shared/tokens.css'));
  const sandbox = { globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read('src/content/widget-template.js'), sandbox);
  const inlined = tokensFrom(sandbox.PriceOracle.Widget.TOKENS);
  for (const [name, value] of Object.entries(inlined)) {
    assert.equal(css[name], value, `${name} differs between tokens.css and the widget TOKENS`);
  }
});

test('every text/background pairing meets WCAG AA (4.5:1)', () => {
  const t = tokensFrom(read('src/shared/tokens.css'));
  const pairs = [
    ['--po-ink', '--po-paper'], ['--po-ink', '--po-wash'], ['--po-graphite', '--po-paper'], ['--po-graphite', '--po-wash'],
    ['--po-teal', '--po-paper'], ['--po-teal', '--po-teal-tint'], ['--po-teal-deep', '--po-teal-tint'],
    ['--po-wait', '--po-wait-tint'], ['--po-buy', '--po-buy-tint'], ['--po-fair', '--po-fair-tint'],
    ['--po-caution', '--po-caution-tint'], ['--po-paper', '--po-teal'], ['--po-paper', '--po-teal-deep']
  ];
  for (const [fg, bg] of pairs) {
    assert.ok(contrast(t[fg], t[bg]) >= 4.5, `${fg} on ${bg} is ${contrast(t[fg], t[bg]).toFixed(2)}:1`);
  }
});

test('UI surfaces use no emoji, gradients, glows or the old indigo palette', () => {
  for (const f of SURFACES) {
    const src = read(f);
    assert.doesNotMatch(src, /\p{Extended_Pictographic}/u, `${f} contains emoji`);
    assert.doesNotMatch(src, /gradient\(/, `${f} uses a gradient`);
    assert.doesNotMatch(src, /#(4338ca|4f46e5|6366f1|7c3aed|eef2ff)/i, `${f} still uses indigo`);
    assert.doesNotMatch(src, /box-shadow:[^;]*rgba/, `${f} uses a soft shadow`);
  }
});

test('extension pages load the shared tokens', () => {
  for (const f of ['src/popup/popup.html', 'src/options/options.html', 'src/welcome/welcome.html']) {
    assert.match(read(f), /\.\.\/shared\/tokens\.css/, `${f} must link tokens.css`);
  }
});
