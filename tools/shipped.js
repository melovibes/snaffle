/* The files that make up the extension as it is installed. One list, used by
   the browser tests (which load exactly these) and by the release zip (which
   contains exactly these), so the two cannot drift apart. */

const FILES = [
  'manifest.json',
  'shared.js', 'hls.js', 'pdf.js', 'background.js', 'content.js', 'capture.js', 'gallery.js',
  'offscreen.html', 'offscreen.js',
  'result.html', 'result.js', 'result.css',
  'options.html', 'options.js', 'options.css',
  'popup.html', 'popup.js', 'popup.css',
  'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png',
  'vendor/mediabunny.min.mjs', 'vendor/mediabunny.LICENSE.txt', 'vendor/README.md'
];

// Not loaded by Chrome, but they travel with any copy that is handed on.
const DOCS = ['LICENSE', 'README.md'];

module.exports = { FILES, DOCS };
