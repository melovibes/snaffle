/* Lint rules for Snaffle. The extension has no build step, so this is the
   only thing that reads every file before Chrome does. The rules are the
   ones that find real mistakes: names that do not exist, values that are
   never used, and comparisons that cannot be what was meant. */

const js = require('@eslint/js');
const globals = require('globals');

const rules = {
  ...js.configs.recommended.rules,
  'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none' }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }],
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-implicit-globals': 'off',
  'no-shadow': ['error', { builtinGlobals: false, hoist: 'never' }],
  'no-use-before-define': ['error', { functions: false, classes: true, variables: false }],
  'no-throw-literal': 'error',
  'no-self-compare': 'error',
  'no-unreachable-loop': 'error',
  'no-constant-binary-expression': 'error',
  'require-atomic-updates': 'off'
};

/* What each file can see besides the browser. */
const shared = { SnaffleShared: 'readonly' };

module.exports = [
  { ignores: ['node_modules/', 'vendor/', 'dist/', 'docs/'] },

  // Pages and scripts that run in a page or an extension page.
  {
    files: ['content.js', 'capture.js', 'gallery.js', 'options.js', 'popup.js', 'result.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser, chrome: 'readonly', ...shared, SnafflePdf: 'readonly' }
    },
    rules
  },

  // The service worker.
  {
    files: ['background.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.serviceworker, chrome: 'readonly', ...shared }
    },
    rules
  },

  // The worker page is a module: it imports the vendored library.
  {
    files: ['offscreen.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, chrome: 'readonly', ...shared, SnaffleHls: 'readonly' }
    },
    rules
  },

  // Files loaded both by the browser and by the tests.
  {
    files: ['shared.js', 'hls.js', 'pdf.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.node, self: 'readonly' }
    },
    // These open with `var X = existing X || (...)`, so that being loaded into
    // a page a second time keeps the first copy. That needs var.
    rules: { ...rules, 'no-var': 'off', 'no-use-before-define': 'off' }
  },

  // Node: tests and tools. Test files also hold functions that are handed
  // to the browser to run, so browser names are known there too.
  {
    files: ['test/**/*.js', 'tools/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser, chrome: 'readonly', ...shared, SnaffleHls: 'readonly', SnafflePdf: 'readonly' }
    },
    rules
  }
];
