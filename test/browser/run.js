/* Browser tests: the real extension, in real Chromium, against local fixtures.
     node test/browser/run.js            run everything
     node test/browser/run.js grab       run one area (grab | stream | shot | list | ui | life)

   Each check states the behaviour a user should get and records what actually
   happened. A failing check is a defect in the extension, not a broken test.
   Exit code is 0 only when nothing unexpected failed: checks listed in
   KNOWN_FAILING are defects that are understood and scheduled, and they are
   reported without failing the run. A check on that list that starts passing
   is reported too, so the list cannot go stale. */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');
const { launch, sleep } = require('./harness');
const { start } = require('./server');

// Defect id -> the phase that fixes it. See docs/phase0-findings.md.
const KNOWN_FAILING = {
  S04: 'phase 2: no muxer, so split-audio streams save without sound',
  C02: 'phase 4: capture trusts devicePixelRatio instead of measuring the shot',
  C03: 'phase 4: fixed elements are hidden before the first shot',
  C04: 'phase 4: inner scrolling containers are not detected',
  C05: 'phase 4: no check that the tab is still in front',
  L02: 'phase 4: thumbnails load the full-size originals',
  L05: 'phase 4: size filter is not re-applied when dimensions arrive',
  L06: 'phase 3: media list has no keyboard access',
  P02: 'phase 3: recorded shortcut is not saved until Save is pressed',
  P05: 'phase 2: defaults are written to storage at install',
  X02: 'phase 2: service worker fetches any URL it is asked for'
};

const only = process.argv[2] || '';
const results = [];

async function check(area, id, item, expect, fn) {
  if (only && only !== area) return;
  const row = { area, id, item, expect, ok: false, observed: '' };
  try {
    const r = await fn();
    row.ok = !!r.ok;
    row.observed = r.observed;
    if (r.untested) row.untested = true;
  } catch (e) {
    row.observed = 'harness error: ' + String((e && e.message) || e).split('\n')[0];
    row.error = true;
  }
  results.push(row);
  const known = !row.ok && !row.untested && KNOWN_FAILING[id];
  const tag = row.untested ? 'SKIP' : row.ok ? ' ok ' : known ? 'KNWN' : 'FAIL';
  console.log('[' + tag + '] ' + id + '  ' + expect + '\n        -> ' + row.observed);
}

const clean = (t) => String(t).replace(/[^ -~]/g, '?').slice(0, 140);
const base = (u) => {
  if (/^data:/i.test(u)) return 'data:' + (/^data:([^;,]+)/i.exec(u) || [])[1];
  if (/^blob:/i.test(u)) return 'blob';
  try { return new URL(u).pathname.split('/').pop(); } catch (_) { return String(u).slice(0, 40); }
};

(async () => {
  const A = await start(4701, 4702);
  const B = await start(4702, 4701);
  const h = await launch();

  const clearToast = (target) => target.evaluate(() => {
    const host = document.getElementById('__snaffle_ui');
    const t = host && host.shadowRoot && host.shadowRoot.querySelector('.toast');
    if (t) t.textContent = '';
  }).catch(() => {});

  // What a run of the extension left behind, observed three ways.
  async function outcome(hh, page, marks, wait) {
    await sleep(wait || 900);
    const later = await hh.toast(page);
    const api = (await hh.apiDownloads()).filter((d) => !marks.ids.has(d.id));
    const anchors = hh.pageDownloads.slice(marks.pd).map((d) => d.suggestedFilename());
    // Chrome records every download, however it was started; the newest
    // finished one holds the bytes that reached the disk.
    const done = api.filter((d) => d.state === 'complete');
    let bytes = null;
    if (done.length) { try { bytes = fs.readFileSync(done[done.length - 1].filename); } catch (_) {} }
    return { finalToast: later ? later.text : '', api, anchors, bytes };
  }
  const mark = async (hh) => ({ ids: new Set((await hh.apiDownloads()).map((d) => d.id)), pd: hh.pageDownloads.length });

  async function grab(page, selector, o) {
    const opt = Object.assign({ via: 'key', frame: null, settle: 6000 }, o || {});
    const marks = await mark(h);
    const markA = A.mark();
    const pagesBefore = h.context.pages().length;
    await clearToast(page);

    const target = opt.frame ? page.frameLocator(opt.frame).locator(selector) : page.locator(selector);
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x - 8, y - 8);
    await page.mouse.move(x, y);
    await sleep(80);
    if (opt.beforeTrigger) await opt.beforeTrigger();

    if (opt.via === 'key') {
      await page.keyboard.press('Alt+KeyS');
    } else {
      await page.keyboard.down('Alt');
      await page.mouse.click(x, y, { button: 'middle' });
      await page.keyboard.up('Alt');
    }

    const toast = await h.settledToast(page, opt.settle);
    const out = await outcome(h, page, marks, opt.after);
    return Object.assign(out, {
      toast, reqA: A.since(markA),
      newPages: h.context.pages().length - pagesBefore, url: page.url()
    });
  }

  const describe = (r) => {
    const parts = ['toast "' + (r.toast || '(none)') + '"'];
    for (const d of r.api) parts.push('browser fetched ' + base(d.url) + ' [' + (d.mime || 'no type') + ', ' + d.state + (d.error ? ' ' + d.error : '') + ']');
    if (r.anchors.length) parts.push('saved by page anchor, outside the folder: ' + r.anchors.join(', '));
    if (!r.api.length) parts.push('no download');
    return parts.join('; ');
  };
  const gotFile = (r, name) => r.api.some((d) => base(d.url) === name && d.state === 'complete' && /^(image|video)\//.test(d.mime));
  const filed = (r) => /^Saved Snaffle\/127\.0\.0\.1\//.test(r.toast || '') && r.anchors.length === 0;

  /* ================================================================ grab */

  if (!only || only === 'grab') {
    const page = await h.newPage(A.origin + '/pages/grab.html');
    await sleep(600);

    const simple = (id, item, sel, want, expect) => check('grab', id, item, expect, async () => {
      const r = await grab(page, sel);
      return { ok: gotFile(r, want) && filed(r), observed: describe(r) };
    });

    await simple('G01', null, '#plain img', 'plain.png', 'Plain image saves, into the configured folder');
    await simple('G02', null, '#srcset img', 'large.png', 'Largest srcset candidate is chosen over the displayed one');
    await simple('G03', null, '#overlay', 'covered.png', 'Image under a transparent overlay is found');
    await simple('G04', 5, '#overlay-bg', 'cousin.png', 'Image under an overlay wins over a background texture on a container');
    await simple('G05', null, '#linked img', 'full.png', 'Thumbnail linking to the full file saves the full file');
    await simple('G06', 1, '#unwrap img', 'tracked.png', 'A tracking parameter containing an encoded URL does not hijack the download');
    await simple('G07', 3, '#dataattr img', 'real.png', 'A data- attribute holding an id is not mistaken for a better source');
    await simple('G08', null, '#bg', 'backdrop.png', 'CSS background image saves');
    await simple('G11', null, '#video video', 'tiny.mp4', 'Video with a direct file URL saves');
    await simple('G16', null, '#shadow', 'shadowed.png', 'Image inside a shadow root is found');

    await check('grab', 'G09', 8, 'Canvas grab saves a PNG into the configured folder', async () => {
      const r = await grab(page, '#canvas canvas');
      const png = !!r.bytes && r.bytes.slice(1, 4).toString() === 'PNG';
      return { ok: png && filed(r), observed: describe(r) + '; file is ' + (png ? 'a PNG of ' + r.bytes.length + ' bytes' : 'not a PNG') };
    });

    await check('grab', 'G10', 8, 'Inline SVG saves into the configured folder', async () => {
      const r = await grab(page, '#svg svg');
      const svg = !!r.bytes && /<svg/.test(r.bytes.toString());
      return { ok: svg && filed(r), observed: describe(r) + '; file is ' + (svg ? 'SVG markup' : 'not SVG') };
    });

    // Chrome skips an extension's filename hook when downloads are driven
    // through the automation protocol, so the rename cannot be observed here.
    // nameForMime is unit-tested instead, and this stays on the manual list.
    await check('grab', 'G12', null, 'Extension-less image served as WebP is named .webp', async () => ({
      untested: true, ok: false,
      observed: 'not observable under automation (filename hook is bypassed); covered by a unit test, needs a manual check'
    }));

    await check('grab', 'G13', 1, 'A URL that answers with a web page is not reported as a saved image', async () => {
      const r = await grab(page, '#htmlimg', { after: 1500 });
      const lied = /^Saved/.test(r.finalToast || r.toast || '');
      const left = r.api.filter((d) => d.state === 'complete').length;
      return { ok: !lied && left === 0, observed: describe(r) + '; files left behind: ' + left };
    });

    await check('grab', 'G14', null, 'Same-origin hotlink-protected image is recovered and still lands in the folder', async () => {
      const r = await grab(page, '#protected img', { after: 2500 });
      const png = !!r.bytes && r.bytes.slice(1, 4).toString() === 'PNG';
      return { ok: png && filed(r), observed: describe(r) + '; recovered file is ' + (png ? 'a PNG' : 'missing') };
    });

    await check('grab', 'G15', null, 'Unrecoverable download ends with an error, not a standing "Saved"', async () => {
      const r = await grab(page, '#xprotected img', { after: 3000 });
      const anyFile = r.api.some((d) => d.state === 'complete');
      const saysSaved = /^Saved/.test(r.finalToast || '');
      return { ok: !anyFile && !saysSaved && /Could not save/.test(r.finalToast), observed: describe(r) + '; final toast "' + r.finalToast + '"' };
    });

    await check('grab', 'G17', null, 'Mouse trigger on a linked image saves it without navigating or opening a tab', async () => {
      const r = await grab(page, '#navlink img', { via: 'mouse' });
      const stayed = /grab\.html/.test(r.url) && r.newPages === 0;
      return { ok: gotFile(r, 'inlink.png') && stayed, observed: describe(r) + '; new tabs ' + r.newPages + '; still on fixture: ' + stayed };
    });

    await check('grab', 'G18', 6, 'Keyboard trigger reaches an image inside a same-origin iframe', async () => {
      const r = await grab(page, '#framed', { frame: '#frame-same iframe' });
      return { ok: gotFile(r, 'framed.png'), observed: describe(r) };
    });

    await check('grab', 'G19', 6, 'Keyboard trigger reaches an image inside a cross-origin iframe, and the toast shows in the top page', async () => {
      const r = await grab(page, '#framed', { frame: '#frame-cross iframe' });
      return { ok: gotFile(r, 'framed.png') && /^Saved/.test(r.toast || ''), observed: describe(r) };
    });

    await check('grab', 'G20', null, 'Mouse trigger works inside an iframe', async () => {
      const r = await grab(page, '#framed', { frame: '#frame-cross iframe', via: 'mouse' });
      return { ok: gotFile(r, 'framed.png'), observed: describe(r) };
    });

    await check('grab', 'G21', null, 'Empty area reports that nothing is there', async () => {
      const r = await grab(page, '#empty', { settle: 2500 });
      return { ok: /No image or video/.test(r.toast || '') && !r.api.length, observed: describe(r) };
    });

    await check('grab', 'G22', null, 'Trigger is ignored while typing in a field', async () => {
      const r = await grab(page, '#plain img', {
        settle: 1500,
        beforeTrigger: async () => { await page.evaluate(() => document.getElementById('field').focus()); }
      });
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      return { ok: !r.api.length, observed: describe(r) };
    });

    await check('grab', 'G26', null, 'Master switch off disables the trigger', async () => {
      await h.setCfg({ enabled: false });
      const r = await grab(page, '#plain img', { settle: 1500 });
      await h.setCfg({ enabled: true });
      return { ok: !r.api.length, observed: describe(r) };
    });

    await check('grab', 'G27', null, 'With the pointer outside the page, the key says nothing is there rather than saving a stale target', async () => {
      await h.hover(page, '#plain img');
      // Leave the document the way a pointer leaves a window.
      await page.evaluate(() => document.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null })));
      const marks = await mark(h);
      await clearToast(page);
      await page.keyboard.press('Alt+KeyS');
      const toast = await h.settledToast(page, 2500);
      const out = await outcome(h, page, marks, 600);
      return { ok: !out.api.length && /No image or video/.test(toast), observed: 'toast "' + toast + '"; downloads ' + out.api.length };
    });

    const scroll = await h.newPage(A.origin + '/pages/scroll.html');
    await sleep(400);
    await check('grab', 'G23', 4, 'After wheel-scrolling without moving the mouse, the image now under the pointer is saved', async () => {
      const r = await grab(scroll, '#first', {
        beforeTrigger: async () => { await scroll.mouse.wheel(0, 300); await sleep(700); }
      });
      const under = await scroll.evaluate(() => { const e = document.elementFromPoint(110, 85); return e && e.id; });
      return { ok: gotFile(r, under + '.png'), observed: describe(r) + '; element under pointer was #' + under };
    });
    await scroll.close();
    await page.close();
  }

  /* ============================================================== stream */

  if (!only || only === 'stream') {
    const page = await h.newPage(A.origin + '/pages/stream.html');
    await page.waitForFunction(() => /ready/.test(document.title), null, { timeout: 8000 });
    await sleep(500);
    const piecesOf = (r) => (r.bytes ? r.bytes.toString() : '');
    const streamOf = (r) => (/^\[([a-z0-9]+):/.exec(piecesOf(r)) || [])[1] || (r.bytes ? 'something else (' + r.bytes.length + ' bytes)' : 'nothing');

    // Runs first, on a fresh page: the only playlists recorded are the page's own.
    await check('stream', 'S02', 7, 'With no media id and several streams on the page, the user is told the result is a guess', async () => {
      const r = await grab(page, '#vb', { settle: 15000 });
      const warned = /best guess/i.test(r.toast || '');
      return { ok: streamOf(r) === 'b' || warned, observed: 'hovered stream b, saved stream ' + streamOf(r) + '; toast "' + r.toast + '"' };
    });

    await check('stream', 'S01', null, 'X-shaped stream is matched by media id and rebuilt into a playable file', async () => {
      const r = await grab(page, '#vx', { settle: 15000 });
      if (!r.bytes) return { ok: false, observed: describe(r) };
      const media = path.join(__dirname, 'media');
      const want = Buffer.concat(['init.mp4', 'seg0.m4s', 'seg1.m4s', 'seg2.m4s'].map((f) => fs.readFileSync(path.join(media, f))));
      const exact = Buffer.compare(r.bytes, want) === 0;
      const out = path.join(h.work, 'assembled.mp4');
      fs.writeFileSync(out, r.bytes);
      let probe = '';
      try {
        probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'csv=p=0', out]).toString().trim().replace(/\s+/g, ' ');
      } catch (e) { probe = 'ffprobe failed'; }
      const sound = /video/.test(probe) && /audio/.test(probe) && /6\.\d/.test(probe);
      return { ok: exact && sound, observed: r.bytes.length + ' bytes, ' + (exact ? 'identical to init+segments' : 'DIFFERENT from init+segments') + '; ffprobe: ' + probe + '; toast "' + r.toast + '"' };
    });

    await check('stream', 'S06', 8, 'A rebuilt video lands in the configured folder, with a truthful size', async () => {
      const r = await grab(page, '#vx', { settle: 15000 });
      const size = (/\(([\d.]+ [KM]B)\)/.exec(r.toast || '') || [])[1] || '';
      return { ok: filed(r) && size === '101 KB', observed: 'toast "' + r.toast + '"' + (r.anchors.length ? '; saved by page anchor' : '') };
    });

    // The extension has now fetched playlists of its own. They must not be
    // mistaken for the page's: c is still the last stream the page asked for.
    await check('stream', 'S03', null, 'After earlier stream downloads, an id-less grab still follows the page, best rendition, pieces in order', async () => {
      const r = await grab(page, '#vc', { settle: 15000 });
      const want = '[c:hi:init.mp4][c:hi:seg0.m4s][c:hi:seg1.m4s][c:hi:seg2.m4s]';
      return { ok: piecesOf(r) === want, observed: r.bytes ? 'file contains ' + clean(piecesOf(r)) + '; toast "' + r.toast + '"' : describe(r) };
    });
    await page.close();

    const audio = await h.newPage(A.origin + '/pages/stream-audio.html');
    await audio.waitForFunction(() => /ready/.test(document.title), null, { timeout: 8000 });
    await sleep(400);
    await check('stream', 'S04', 9, 'A stream with a separate audio track produces a file with sound', async () => {
      const r = await grab(audio, '#vd', { settle: 15000 });
      const has = /audio/.test(piecesOf(r));
      return { ok: has, observed: 'file has ' + (has ? 'audio' : 'no audio pieces') + '; toast "' + r.toast + '"' };
    });

    await check('stream', 'S07', null, 'A page with a single stream is not called a guess', async () => {
      const r = await grab(audio, '#vd', { settle: 15000 });
      return { ok: !/guess/i.test(r.toast || '') && /^Saved/.test(r.toast || ''), observed: 'toast "' + r.toast + '"' };
    });
    await audio.close();

    const nocors = await h.newPage(A.origin + '/pages/stream-nocors.html');
    await nocors.waitForFunction(() => /ready/.test(document.title), null, { timeout: 8000 });
    await sleep(400);
    await check('stream', 'S05', null, 'Stream on a CDN without CORS is still rebuilt (service-worker fetch path)', async () => {
      const r = await grab(nocors, '#ve', { settle: 15000 });
      return { ok: piecesOf(r) === '[e:hi:init.mp4][e:hi:seg0.m4s][e:hi:seg1.m4s][e:hi:seg2.m4s]', observed: r.bytes ? 'file contains ' + clean(piecesOf(r)) : describe(r) };
    });
    await nocors.close();
  }

  /* ========================================================== screenshot */

  // Start a capture and wait for the file it produces.
  async function shoot(hh, page, o) {
    const opt = Object.assign({ timeout: 30000 }, o || {});
    const marks = await mark(hh);
    await clearToast(page);
    await page.keyboard.press('Alt+Shift+KeyS');
    if (opt.during) await opt.during();
    const end = Date.now() + opt.timeout;
    let api = [];
    while (Date.now() < end) {
      api = (await hh.apiDownloads()).filter((d) => !marks.ids.has(d.id) && d.state === 'complete');
      if (api.length) break;
      const t = await hh.toast(page);
      if (t && /failed|cancel/i.test(t.text)) break;
      await sleep(250);
    }
    const out = await outcome(hh, page, marks, 700);
    const name = (/^Saved (.+?) \(/.exec(out.finalToast) || [])[1] || '';
    return { toast: out.finalToast, name, bytes: out.bytes, anchors: out.anchors };
  }
  const px = (png, x, y) => {
    const i = (y * png.width + x) * 4;
    return '#' + [png.data[i], png.data[i + 1], png.data[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
  };
  const BANDS = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff'];

  if (!only || only === 'shot') {
    const tall = await h.newPage(A.origin + '/pages/tall.html');
    await sleep(500);
    await tall.mouse.move(300, 300);

    await check('shot', 'C01', null, 'A 2500px page captures as one 1000x2500 image, every band in place, into the folder', async () => {
      const s = await shoot(h, tall);
      if (!s.bytes) return { ok: false, observed: 'no file; toast "' + s.toast + '"' };
      const png = PNG.sync.read(s.bytes);
      const seen = BANDS.map((_, i) => px(png, 500, Math.min(png.height - 1, i * 500 + 250)));
      const inFolder = /^Snaffle\/127\.0\.0\.1\//.test(s.name) && !s.anchors.length;
      const ok = png.width === 1000 && png.height === 2500 && seen.join() === BANDS.join() && inFolder;
      return { ok, observed: png.width + 'x' + png.height + ', band colours ' + seen.join(' ') + '; saved as ' + s.name + '; scroll restored to ' + await tall.evaluate(() => window.scrollY) };
    });

    await check('shot', 'C06', null, 'JPEG and PDF output are valid files', async () => {
      await h.setCfg({ captureFormat: 'jpeg' });
      const j = await shoot(h, tall);
      await h.setCfg({ captureFormat: 'pdf' });
      const p = await shoot(h, tall);
      await h.setCfg({ captureFormat: 'png' });
      const jpegOk = !!j.bytes && j.bytes[0] === 0xff && j.bytes[1] === 0xd8 && /\.jpg$/.test(j.name);
      const text = p.bytes ? p.bytes.toString('latin1') : '';
      const sx = parseInt((/startxref\n(\d+)/.exec(text) || [])[1] || '-1', 10);
      const pdfOk = text.startsWith('%PDF-1.4') && text.slice(sx, sx + 4) === 'xref' && /\.pdf$/.test(p.name);
      const at = text.indexOf('stream\n', text.indexOf('/DCTDecode'));
      const embedded = at > 0 && p.bytes[at + 7] === 0xff && p.bytes[at + 8] === 0xd8;
      return { ok: jpegOk && pdfOk && embedded, observed: 'jpeg ' + (jpegOk ? 'valid (' + j.name + ')' : 'INVALID: got "' + j.name + '", toast "' + j.toast + '"') + '; pdf ' + (pdfOk ? 'structure valid' : 'INVALID') + ', embedded JPEG ' + (embedded ? 'present' : 'MISSING') + ' (' + p.name + ')' };
    });

    await check('shot', 'C05', 11, 'Switching tabs during a capture does not put the other tab in the image', async () => {
      const other = await h.context.newPage();
      await other.goto(A.origin + '/pages/lime.html');
      await tall.bringToFront();
      await tall.mouse.move(300, 300);
      // Leave the other tab in front for a while, as a user checking something would.
      const s = await shoot(h, tall, {
        during: async () => { await sleep(900); await other.bringToFront(); await sleep(6000); await tall.bringToFront(); }
      });
      await other.close();
      if (!s.bytes) return { ok: /cancel|abort|switch|stopped/i.test(s.toast), observed: 'no image produced; toast "' + s.toast + '"' };
      const png = PNG.sync.read(s.bytes);
      const seen = BANDS.map((_, i) => px(png, 500, Math.min(png.height - 1, i * 500 + 250)));
      const lime = seen.filter((c) => c === '#7fff00').length;
      return { ok: lime === 0, observed: lime + ' of 5 bands show the other tab (lime #7fff00); band colours ' + seen.join(' ') + '; toast "' + s.toast + '"' };
    });
    await tall.close();

    const fixed = await h.newPage(A.origin + '/pages/tall-fixed.html');
    await sleep(500);
    await fixed.mouse.move(300, 300);
    await check('shot', 'C03', 13, 'Fixed header appears once at the top and fixed footer once at the bottom', async () => {
      const s = await shoot(h, fixed);
      if (!s.bytes) return { ok: false, observed: 'no file; toast "' + s.toast + '"' };
      const png = PNG.sync.read(s.bytes);
      const top = px(png, 500, 20), mid = px(png, 500, 680), end = px(png, 500, png.height - 20);
      const headerRepeats = [720, 1420, 2120].map((y) => px(png, 500, y)).filter((c) => c === '#000000').length;
      const ok = top === '#000000' && mid !== '#ff00ff' && end === '#ff00ff' && headerRepeats === 0;
      const restored = await fixed.evaluate(() => getComputedStyle(document.getElementById('bottom')).visibility);
      return { ok, observed: 'y=20 is ' + top + (top === '#000000' ? ' (header)' : ' (header missing)') + ', y=680 is ' + mid + (mid === '#ff00ff' ? ' (footer baked into mid-page)' : '') + ', last 20px ' + end + (end === '#ff00ff' ? ' (footer)' : ' (footer missing)') + '; header repeats ' + headerRepeats + '; footer after capture: ' + restored };
    });
    await fixed.close();

    const inner = await h.newPage(A.origin + '/pages/innerscroll.html');
    await sleep(500);
    await inner.mouse.move(300, 300);
    await check('shot', 'C04', 12, 'A page that scrolls inside a container is captured in full, or the user is warned', async () => {
      const s = await shoot(h, inner);
      if (!s.bytes) return { ok: /scrolls inside|could not capture/i.test(s.toast), observed: 'no file; toast "' + s.toast + '"' };
      const png = PNG.sync.read(s.bytes);
      // The page title is in the file name, so judge the message without it.
      const warned = /only the visible|scrolls inside|could not capture|partial/i.test(s.toast.replace(s.name, ''));
      return { ok: png.height >= 2500 || warned, observed: 'image is ' + png.width + 'x' + png.height + ' of a 2500px document; toast "' + s.toast + '"' };
    });
    await inner.close();

    // Device pixel ratio 2 needs its own browser.
    const h2 = await launch({ dpr: 2 });
    await check('shot', 'C02', null, 'At device pixel ratio 2 the image is filled edge to edge', async () => {
      const page = await h2.newPage(A.origin + '/pages/tall.html');
      await sleep(600);
      await page.mouse.move(300, 300);
      const s = await shoot(h2, page);
      if (!s.bytes) return { ok: false, observed: 'no file; toast "' + s.toast + '"' };
      const png = PNG.sync.read(s.bytes);
      // Sample the centre of every band, wherever the image put it.
      const seen = BANDS.map((_, i) => px(png, Math.floor(png.width / 2), Math.floor((i + 0.5) * png.height / 5)));
      const filled = seen.join() === BANDS.join();
      return { ok: filled, observed: png.width + 'x' + png.height + '; band centres ' + seen.join(' ') + (filled ? '' : ' (#000000 is empty canvas)') };
    });
    await h2.close();
  }

  /* ========================================================== media list */

  if (!only || only === 'list') {
    const page = await h.newPage(A.origin + '/pages/gallery.html');
    await page.waitForFunction(() => /ready/.test(document.title), null, { timeout: 8000 });
    await sleep(900);
    await page.mouse.move(600, 500);

    const cards = () => page.evaluate(() => {
      const host = document.getElementById('__snaffle_gallery');
      if (!host || !host.shadowRoot) return null;
      return Array.from(host.shadowRoot.querySelectorAll('.card')).map((c) => ({
        url: c.dataset.url, dims: (c.querySelector('.dims') || {}).textContent || '',
        selected: c.getAttribute('aria-selected'), tabindex: c.getAttribute('tabindex'), role: c.getAttribute('role')
      }));
    });
    const names = (list) => list.map((c) => base(c.url));

    const markA = A.mark();
    await page.keyboard.press('Alt+Shift+KeyI');
    await sleep(2500);
    const list = await cards();

    await check('list', 'L01', null, 'The panel opens and lists the page images, including one inside a cross-origin iframe', async () => {
      if (!list) return { ok: false, observed: 'panel did not open; toast "' + ((await h.toast(page)) || {}).text + '"' };
      const n = names(list);
      const ok = ['one.png', 'two-large.png', 'three-full.png', 'bigbg.png', 'framed.png'].every((f) => n.includes(f));
      return { ok, observed: list.length + ' items: ' + n.join(', ') };
    });

    await check('list', 'L02', 16, 'Opening the panel does not fetch full-size originals just to draw thumbnails', async () => {
      const big = A.since(markA).map((r) => r.path.split('/').pop()).filter((f) => /two-large|three-full/.test(f));
      return { ok: big.length === 0, observed: big.length ? 'fetched for thumbnails: ' + big.join(', ') + ' (the page itself had only loaded 200x150 versions)' : 'no full-size fetches' };
    });

    await check('list', 'L05', 18, 'A 10x10 background image is hidden by the 80px minimum once its size is known', async () => {
      const tiny = (list || []).find((c) => /tinybg/.test(c.url));
      return { ok: !tiny, observed: tiny ? 'tinybg.png still listed, showing "' + tiny.dims + '"' : 'not listed' };
    });

    await check('list', 'L06', null, 'Cards are reachable and selectable from the keyboard', async () => {
      const c = (list || [])[0] || {};
      return { ok: c.tabindex != null, observed: 'card tabindex=' + c.tabindex + ', role=' + c.role };
    });

    await check('list', 'L03', 17, 'Select all + Download saves every selected item and reports the true count', async () => {
      const marks = await mark(h);
      // Count what Select all really selected, not how many cards are drawn:
      // a stale card can be on screen without being selectable (see L05).
      const count = await page.evaluate(() => {
        const r = document.getElementById('__snaffle_gallery').shadowRoot;
        r.querySelector('[data-act="all"]').click();
        const n = r.querySelectorAll('.card[aria-selected="true"]').length;
        r.querySelector('[data-act="dl"]').click();
        return n;
      });
      await sleep(4500);
      const api = (await h.apiDownloads()).filter((d) => !marks.ids.has(d.id));
      const done = api.filter((d) => d.state === 'complete').length;
      const toast = await h.toast(page);
      const claimed = parseInt((/Saved (\d+)/.exec(toast ? toast.text : '') || [])[1] || '-1', 10);
      return { ok: done === count && claimed === done, observed: count + ' selected, ' + api.length + ' started [' + api.map((d) => base(d.url)).join(', ') + '], ' + done + ' completed; toast "' + (toast ? toast.text : '') + '"' };
    });
    await page.close();
  }

  /* ================================================================== ui */

  if (!only || only === 'ui') {
    const opt = await h.context.newPage();
    const errors = [];
    opt.on('pageerror', (e) => errors.push(String(e)));
    opt.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await opt.goto('chrome-extension://' + h.extId + '/options.html');
    await sleep(500);

    await check('ui', 'P01', null, 'Options page loads cleanly with every control populated', async () => {
      const v = await opt.evaluate(() => ({
        key: document.getElementById('keyRec').textContent, mouse: document.getElementById('mouseRec').textContent,
        cap: document.getElementById('captureRec').textContent, gal: document.getElementById('galleryRec').textContent,
        folder: document.getElementById('folder').value, fmt: document.getElementById('captureFormat').value,
        preview: document.getElementById('preview').textContent
      }));
      return { ok: !errors.length && v.key === 'Alt + S' && !!v.preview.trim(), observed: JSON.stringify(v) + (errors.length ? '; errors: ' + errors.join(' | ') : '; no console errors') };
    });

    await check('ui', 'P02', null, 'A recorded shortcut is either saved or clearly marked as unsaved', async () => {
      await opt.click('#keyRec');
      await opt.keyboard.press('Control+Shift+KeyK');
      await sleep(200);
      const shown = await opt.evaluate(() => document.getElementById('keyRec').textContent);
      const stored = (await h.getCfg()).key;
      const marker = await opt.evaluate(() => /unsaved|not saved/i.test(document.body.innerText));
      const persisted = stored.code === 'KeyK';
      await opt.reload(); await sleep(400);
      const afterReload = await opt.evaluate(() => document.getElementById('keyRec').textContent);
      return { ok: persisted || marker, observed: 'box shows "' + shown + '", storage still has ' + stored.code + ', no unsaved marker; after reload the box reads "' + afterReload + '"' };
    });

    await check('ui', 'P03', null, 'Save persists a recorded shortcut and the page honours it', async () => {
      await opt.click('#keyRec');
      await opt.keyboard.press('Control+Shift+KeyK');
      await opt.click('#save');
      await sleep(300);
      const stored = (await h.getCfg()).key;
      const page = await h.newPage(A.origin + '/pages/grab.html');
      await sleep(400);
      const marks = await mark(h);
      await h.hover(page, '#plain img');
      await page.keyboard.press('Control+Shift+KeyK');
      await sleep(1500);
      const got = (await h.apiDownloads()).filter((d) => !marks.ids.has(d.id)).length;
      await page.close();
      await opt.click('#reset'); await sleep(300);
      return { ok: stored.code === 'KeyK' && stored.ctrl && got === 1, observed: 'stored ' + JSON.stringify({ code: stored.code, ctrl: stored.ctrl, shift: stored.shift, alt: stored.alt }) + '; new shortcut produced ' + got + ' download' };
    });

    await check('ui', 'P05', 20, 'Defaults are not written into storage at install', async () => {
      const keys = Object.keys((await h.getCfg()) || {});
      return { ok: keys.length === 0, observed: 'storage holds ' + keys.length + ' keys right after install (' + keys.slice(0, 5).join(', ') + ', ...)' };
    });

    await check('ui', 'P04', null, 'Popup loads cleanly', async () => {
      const pop = await h.context.newPage();
      const errs = [];
      pop.on('pageerror', (e) => errs.push(String(e)));
      await pop.goto('chrome-extension://' + h.extId + '/popup.html');
      await sleep(400);
      const v = await pop.evaluate(() => ({ key: document.getElementById('keyLabel').textContent, cap: document.getElementById('captureLabel').textContent, dest: document.getElementById('dest').textContent }));
      await pop.close();
      return { ok: !errs.length && v.key === 'Alt + S', observed: JSON.stringify(v) + (errs.length ? '; errors ' + errs.join('|') : '; no errors') };
    });
    await opt.close();
  }

  /* ============================================================ lifecycle */

  if (!only || only === 'life') {
    await check('life', 'X02', 19, 'The service worker refuses to fetch arbitrary URLs on request', async () => {
      const r = await h.probe.evaluate((u) => new Promise((res) => chrome.runtime.sendMessage({ type: 'proxyFetch', url: u }, (x) => res(x && x.ok ? atob(x.b64).slice(0, 60) : 'refused'))), A.origin + '/article.html');
      return { ok: r === 'refused', observed: 'asked for a loopback page, got back: ' + r };
    });

    // Last, because it restarts the extension and takes the probe page with it.
    await check('life', 'X01', 21, 'After the extension reloads, an open tab still saves the image or says to reload', async () => {
      const page = await h.newPage(A.origin + '/pages/grab.html');
      await sleep(500);
      await h.probe.evaluate(() => chrome.runtime.reload()).catch(() => {});
      await sleep(2500);
      await page.bringToFront();
      const markA = A.mark();
      await clearToast(page);
      await h.hover(page, '#plain img');
      await page.keyboard.press('Alt+KeyS');
      await sleep(3000);
      const t = await h.toast(page);
      const fetched = A.since(markA).filter((r) => /plain\.png/.test(r.path)).length;
      const text = t ? t.text : '';
      return { ok: /reload/i.test(text) || (fetched > 0 && /^Saved/.test(text)), observed: 'toast "' + (text || '(none)') + '"; server saw ' + fetched + ' request(s) for the image' };
    });
  }

  await h.close().catch(() => {});
  await A.close(); await B.close();

  const run = results.filter((r) => !r.untested);
  const failed = run.filter((r) => !r.ok);
  const unexpected = failed.filter((r) => !KNOWN_FAILING[r.id]);
  const fixedNow = run.filter((r) => r.ok && KNOWN_FAILING[r.id]);
  fs.writeFileSync(path.join(__dirname, 'last-run.json'), JSON.stringify(results, null, 2));

  console.log('\n' + run.length + ' checks: ' + (run.length - failed.length) + ' ok, ' +
              (failed.length - unexpected.length) + ' known defects, ' + unexpected.length + ' unexpected failures' +
              (results.length - run.length ? ', ' + (results.length - run.length) + ' not observable here' : ''));
  if (unexpected.length) console.log('UNEXPECTED: ' + unexpected.map((r) => r.id).join(' '));
  if (fixedNow.length) console.log('Now passing, remove from KNOWN_FAILING: ' + fixedNow.map((r) => r.id).join(' '));
  process.exit(unexpected.length || fixedNow.length ? 1 : 0);
})().catch((e) => { console.error('RUN FAILED', e); process.exit(2); });
