/* Builds dist/snaffle-<version>.zip from what is committed: the files that
   ship, the licence and the README, and nothing else.

     node tools/make-zip.js            build it
     node tools/make-zip.js --check    build it, then unzip it, load it into
                                       Chromium and make sure it starts

   It is built with `git archive`, so it holds exactly what the commit holds.
   Uncommitted changes are not included, and the script says so. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { FILES, DOCS } = require('./shipped');

const ROOT = path.join(__dirname, '..');
const git = (args) => execFileSync('git', args, { cwd: ROOT }).toString().trim();

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;
const name = 'snaffle-' + version;
const out = path.join(ROOT, 'dist', name + '.zip');

const paths = FILES.concat(DOCS);
const missing = paths.filter((p) => !fs.existsSync(path.join(ROOT, p)));
if (missing.length) { console.error('missing files: ' + missing.join(', ')); process.exit(1); }

const dirty = git(['status', '--porcelain', '--'].concat(paths));
if (dirty) console.warn('note: uncommitted changes are NOT in the zip:\n' + dirty);

fs.mkdirSync(path.dirname(out), { recursive: true });
git(['archive', '--format=zip', '--prefix=' + name + '/', '-o', out, 'HEAD', '--'].concat(paths));
console.log('wrote ' + path.relative(ROOT, out) + ' (' + Math.round(fs.statSync(out).size / 1024) + ' KB, ' + paths.length + ' files) from ' + git(['rev-parse', '--short', 'HEAD']));

if (!process.argv.includes('--check')) process.exit(0);

/* ---- check: does the thing people will download actually load? ---- */

(async () => {
  const { chromium } = require('playwright');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'snaffle-zip-'));
  try {
    if (process.platform === 'win32') {
      execFileSync('powershell', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath "' + out + '" -DestinationPath "' + work + '"']);
    } else {
      execFileSync('unzip', ['-q', out, '-d', work]);
    }
    const ext = path.join(work, name);
    const unpacked = fs.readdirSync(ext);

    const context = await chromium.launchPersistentContext(path.join(work, 'profile'), {
      channel: 'chromium', headless: true,
      args: ['--disable-extensions-except=' + ext, '--load-extension=' + ext]
    });
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const id = new URL(sw.url()).host;

    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto('chrome-extension://' + id + '/options.html');
    await page.waitForTimeout(500);
    const seen = await page.evaluate(() => ({
      version: chrome.runtime.getManifest().version,
      key: document.getElementById('keyRec').textContent,
      shared: typeof SnaffleShared
    }));
    // The worker page is where the bundled library is loaded; open it directly
    // to prove the module and its import resolve from inside the zip.
    const worker = await context.newPage();
    const workerErrors = [];
    worker.on('pageerror', (e) => workerErrors.push(String(e)));
    await worker.goto('chrome-extension://' + id + '/offscreen.html');
    await worker.waitForTimeout(800);
    await context.close();

    const ok = seen.version === version && seen.key === 'Alt + S' && seen.shared === 'object' && !errors.length && !workerErrors.length;
    console.log('unzipped ' + unpacked.length + ' entries; service worker started; options page reports v' + seen.version +
                ', trigger "' + seen.key + '"; worker page errors: ' + (workerErrors.length ? workerErrors.join(' | ') : 'none') +
                (errors.length ? '; options errors: ' + errors.join(' | ') : ''));
    console.log(ok ? 'zip check passed' : 'ZIP CHECK FAILED');
    process.exitCode = ok ? 0 : 1;
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
  }
})().catch((e) => { console.error('ZIP CHECK FAILED', e); process.exit(1); });
