/* Launches Chromium with the extension loaded and gives tests three ways to
   see what really happened: the toast the user would read, the download items
   Chrome recorded, and the requests the fixture server received. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const { FILES: SHIPPED } = require('../../tools/shipped');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Only the files that ship are copied, so a test run also proves the extension
// does not depend on anything outside that list.
function stageExtension(dir) {
  for (const f of SHIPPED) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  }
}

async function launch(opts) {
  const o = Object.assign({ width: 1000, height: 700, dpr: 1 }, opts || {});
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'snaffle-test-'));
  const extDir = path.join(work, 'ext');
  const profile = path.join(work, 'profile');
  const dlDir = path.join(work, 'downloads');
  fs.mkdirSync(dlDir, { recursive: true });
  stageExtension(extDir);

  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: o.width, height: o.height },
    deviceScaleFactor: o.dpr,
    acceptDownloads: true,
    downloadsPath: dlDir,
    // Chromium's own screen recording of every page, for the demo.
    recordVideo: o.video ? { dir: o.video, size: { width: o.width, height: o.height } } : undefined,
    args: ['--disable-extensions-except=' + extDir, '--load-extension=' + extDir]
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;

  // An extension page stays open as a probe: it can call chrome.* APIs
  // however often the service worker is recycled underneath us.
  const probe = await context.newPage();
  await probe.goto('chrome-extension://' + extId + '/options.html');
  await probe.waitForLoadState('domcontentloaded');

  // Page-initiated downloads (anchor clicks) surface here.
  const pageDownloads = [];
  context.on('page', (p) => p.on('download', (d) => pageDownloads.push(d)));

  const h = {
    context, extId, probe, work, dlDir, pageDownloads,

    async newPage(url) {
      const page = await context.newPage();
      page.on('download', (d) => { if (!pageDownloads.includes(d)) pageDownloads.push(d); });
      const consoleErrors = [];
      page.on('pageerror', (e) => consoleErrors.push(String(e)));
      page.consoleErrors = consoleErrors;
      if (url) await page.goto(url, { waitUntil: 'load' });
      await page.bringToFront();
      return page;
    },

    async setCfg(patch) {
      // Written the way the options page writes it: only what differs from
      // the defaults, and nothing at all when nothing does. Setting a value
      // back to its default must leave storage as a fresh install has it.
      await probe.evaluate(async (p) => {
        const s = await chrome.storage.sync.get('cfg');
        const next = SnaffleShared.toStore(Object.assign(SnaffleShared.effective(s.cfg), p));
        if (Object.keys(next).length <= 1) await chrome.storage.sync.remove('cfg');
        else await chrome.storage.sync.set({ cfg: next });
      }, patch);
      await sleep(150);
    },

    async getCfg() {
      return probe.evaluate(async () => (await chrome.storage.sync.get('cfg')).cfg);
    },

    // Chrome's own record of downloads the extension started.
    async apiDownloads() {
      return probe.evaluate(() => new Promise((res) => chrome.downloads.search({}, (items) => res(items.map((i) => ({
        id: i.id, url: i.url, finalUrl: i.finalUrl, filename: i.filename, mime: i.mime,
        state: i.state, error: i.error || '', bytes: i.bytesReceived, referrer: i.referrer || ''
      }))))));
    },

    async toast(page) {
      return page.evaluate(() => {
        const host = document.getElementById('__snaffle_ui');
        if (!host || !host.shadowRoot) return null;
        // Several toasts can be up; the one most recently written to is the news.
        const all = Array.from(host.shadowRoot.querySelectorAll('.toast'));
        if (!all.length) return null;
        const t = all.sort((x, y) => Number(y.dataset.seq) - Number(x.dataset.seq))[0];
        const bar = t.querySelector('.bar');
        return {
          text: t.querySelector('.msg').textContent, cls: t.className, count: all.length,
          actions: Array.from(t.querySelectorAll('.acts button')).map((b) => b.textContent),
          progress: bar && !bar.hidden ? bar.firstChild.style.width : null,
          all: all.map((x) => x.querySelector('.msg').textContent)
        };
      });
    },

    // Wait until the toast stops changing, i.e. the grab reached a verdict.
    async settledToast(page, timeout) {
      const end = Date.now() + (timeout || 6000);
      let last = null, stableSince = 0;
      while (Date.now() < end) {
        const t = await h.toast(page);
        const text = t ? t.text : '';
        if (text && text === last) {
          if (!/^(Saving|Retrying|Reading|Downloading|Scanning)/.test(text) && Date.now() - stableSince > 700) return text;
        } else { last = text; stableSince = Date.now(); }
        await sleep(100);
      }
      return last || '';
    },

    async hover(page, selector, frame) {
      const target = frame ? frame.locator(selector) : page.locator(selector);
      const box = await target.boundingBox();
      if (!box) throw new Error('no box for ' + selector);
      // Two moves so the page sees real mousemove/mouseover, as a hand would give it.
      await page.mouse.move(box.x + box.width / 2 - 8, box.y + box.height / 2 - 8);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await sleep(60);
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    },

    async close() {
      await context.close();
      try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
    }
  };
  return h;
}

module.exports = { launch, sleep, ROOT };
