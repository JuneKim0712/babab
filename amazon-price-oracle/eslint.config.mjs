import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'tests/screenshots/**'] },
  js.configs.recommended,
  {
    // Service worker, popup, options, welcome: ES modules in an extension context.
    files: ['src/background/**/*.js', 'src/shared/**/*.js', 'src/popup/**/*.js', 'src/options/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser, ...globals.serviceworker, chrome: 'readonly' } },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }] }
  },
  {
    // Content scripts are classic scripts sharing globalThis.PriceOracle.
    files: ['src/content/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, chrome: 'readonly' } },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }] }
  },
  {
    files: ['tests/**/*.mjs', 'scripts/**/*.{js,mjs}', 'test-page/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: { sourceType: 'module', globals: { ...globals.node, ...globals.browser, chrome: 'readonly' } },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }] }
  }
];
