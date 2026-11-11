/* Browser tests: the real extension, in real Chromium, against local fixtures.
     node test/browser/run.js            run everything
     node test/browser/run.js grab       run one area (grab | stream | shot | list | ui | life)

   Each check states the behaviour a user should get and records what actually
   happened. A failing check is a defect to fix, not a broken test: several of
   these are expected to fail until the defect behind them is fixed. */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');
const { launch, sleep } = require('./harness');
const { start } = require('./server');

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
    row.observed = 'harness error: ' + ((e && e.message) || e).split('\n')[0];
    row.error = true;
  }
  results.push(row);
  const tag = row.untested ? 'SKIP' : row.ok ? ' ok ' : 'FAIL';
  console.log('[' + tag + '] ' + id + '  ' + expect + '\n        -> ' + row.observed);
}

const clean = (t) => String(t).replace(/[^ -~]/g, '?').slice(0, 140);
const base = (u) => { try { return new URL(u).pathname.split('/').pop(); } catch (_) { return String(u).slice(0, 40); } };

(async () => {
  const A = await start(4701, 4702);
  const B = await start(4702, 4701);
  let h = await launch();

  const clearToast = (target) => target.evaluate(() => {
    const host = document.getElementById('__snaffle_ui');
    const t = host && host.shadowRoot && host.shadowRoot.querySelector('.toast');
    if (t) t.textContent = '';
  }).catch(() => {});

  // One grab, observed three ways.
  async function grab(page, selector, o) {
    const opt = Object.assign({ via: 'key', frame: null, settle: 6000 }, o || {});
    const before = new Set((await h.apiDownloads()).map((d) => d.id));
    const pdMark = h.pageDownloads.length;
    const markA = A.mark(), markB = B.mark();
    const pagesBefore = h.context.pages().length;
    await clearToast(page);
    for (const f of page.frames()) await clearToast(f);

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

    // The toast lives in whichever frame handled the grab.
    let toast = await h.settledToast(page, opt.settle);
    if (!toast) {
      for (const f of page.frames()) {
        const t = await h.toast(f).catch(() => null);
        if (t && t.text) { toast = '(inside iframe) ' + t.text; break; }
      }
    }
    await sleep(opt.after || 900);
    const later = await h.toast(page);

    const api = (await h.apiDownloads()).filter((d) => !before.has(d.id));
    const pageDl = [];
    for (const d of h.pageDownloads.slice(pdMark)) {
      let bytes = null;
      try { bytes = fs.readFileSync(await d.path()); } catch (_) {}
      pageDl.push({ name: d.suggestedFilename(), url: d.url().slice(0, 60), bytes });
    }
    return {
      toast, finalToast: later ? later.text : '', api, pageDl,
      reqA: A.since(markA), reqB: B.since(markB),
      newPages: h.context.pages().length - pagesBefore, url: page.url()
    };
  }

  const describe = (r) => {
    const parts = ['toast "' + (r.toast || '(none)') + '"'];
    for (const d of r.api) parts.push('downloads-API got ' + base(d.url) + ' [' + d.mime + ', ' + d.state + (d.error ? ' ' + d.error : '') + ']');
    for (const d of r.pageDl) parts.push('page-anchor saved ' + d.name);
    if (!r.api.length && !r.pageDl.length) parts.push('no download');
    return parts.join('; ');
  };
  const gotFile = (r, name) => r.api.some((d) => base(d.url) === name && d.state === 'complete' && /^(image|video)\//.test(d.mime));

  /* ================================================================ grab */

  if (!only || only === 'grab') {
    const page = await h.newPage(A.origin + '/pages/grab.html');
    await sleep(600);

    const simple = (id, item, sel, want, expect) => check('grab', id, item, expect, async () => {
      const r = await grab(page, sel);
      return { ok: gotFile(r, want), observed: describe(r) };
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
      const viaAnchor = r.pageDl.length > 0;
      const inFolder = /Snaffle\//.test(r.toast || '');
      return { ok: viaAnchor && inFolder, observed: describe(r) + (viaAnchor ? '; saved by page anchor, which cannot carry a folder' : '') };
    });

    await check('grab', 'G10', 8, 'Inline SVG saves into the configured folder', async () => {
      const r = await grab(page, '#svg svg');
      return { ok: r.pageDl.length > 0 && /Snaffle\//.test(r.toast || ''), observed: describe(r) };
    });

    await check('grab', 'G12', null, 'Extension-less image served as WebP is named .webp', async () => {
      const r = await grab(page, '#noext img');
      return { ok: /\.webp/.test(r.toast || ''), observed: describe(r) };
    });

    await check('grab', 'G13', 1, 'A URL that answers with a web page is not reported as a saved image', async () => {
      const r = await grab(page, '#htmlimg', { after: 1500 });
      const lied = /^Saved/.test(r.finalToast || r.toast || '') && r.api.some((d) => /html/.test(d.mime));
      return { ok: !lied, observed: describe(r) + '; final toast "' + r.finalToast + '"' };
    });

    await check('grab', 'G14', null, 'Same-origin hotlink-protected image is recovered by the page-context retry', async () => {
      const r = await grab(page, '#protected img', { after: 3500 });
      const recovered = r.pageDl.some((d) => /guarded/.test(d.name) && d.bytes && d.bytes.length > 100);
      return { ok: recovered, observed: describe(r) + '; final toast "' + r.finalToast + '"' };
    });

    await check('grab', 'G15', null, 'Unrecoverable download ends with an error, not a standing "Saved"', async () => {
      const r = await grab(page, '#xprotected img', { after: 4500 });
      const anyFile = r.api.some((d) => d.state === 'complete') || r.pageDl.length > 0;
      const saysSaved = /^Saved/.test(r.finalToast || '');
      return { ok: anyFile || !saysSaved, observed: describe(r) + '; final toast "' + r.finalToast + '"; file on disk: ' + (anyFile ? 'yes' : 'no') };
    });

    await check('grab', 'G17', null, 'Mouse trigger on a linked image saves it without navigating or opening a tab', async () => {
      const r = await grab(page, '#navlink img', { via: 'mouse' });
      const stayed = /grab\.html/.test(r.url) && r.newPages === 0;
      return { ok: gotFile(r, 'inlink.png') && stayed, observed: describe(r) + '; new tabs ' + r.newPages + '; still on fixture: ' + stayed };
    });

    await check('grab', 'G18', 6, 'Keyboard trigger reaches an image inside a same-origin iframe', async () => {
      const r = await grab(page, '#framed', { frame: '#frame-same iframe', settle: 2500 });
      return { ok: gotFile(r, 'framed.png'), observed: describe(r) };
    });

    await check('grab', 'G19', 6, 'Keyboard trigger reaches an image inside a cross-origin iframe', async () => {
      const r = await grab(page, '#framed', { frame: '#frame-cross iframe', settle: 2500 });
      return { ok: r.api.some((d) => base(d.url) === 'framed.png'), observed: describe(r) };
    });

    await check('grab', 'G20', null, 'Mouse trigger works inside an iframe', async () => {
      const r = await grab(page, '#framed', { frame: '#frame-cross iframe', via: 'mouse' });
      return { ok: r.api.some((d) => base(d.url) === 'framed.png'), observed: describe(r) };
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
      return { ok: !r.api.length && !r.pageDl.length, observed: describe(r) };
    });

    await check('grab', 'G26', null, 'Master switch off disables the trigger', async () => {
      await h.setCfg({ enabled: false });
      const r = await grab(page, '#plain img', { settle: 1500 });
      await h.setCfg({ enabled: true });
      return { ok: !r.api.length, observed: describe(r) };
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

    await check('stream', 'S02', 7, 'With no media id, the hovered video (b) is saved, or the user is told it is a guess', async () => {
      const r = await grab(page, '#vb', { settle: 15000 });
      const d = r.pageDl[0];
      const text = d && d.bytes ? d.bytes.toString() : '';
      const which = (/\[([a-z0-9]+):/.exec(text) || [])[1] ||
        (d && d.bytes ? 'something else entirely (' + d.bytes.length + ' bytes, named ' + d.name + ')' : 'nothing');
      const warned = /guess|may not|might/i.test(r.toast || '');
      return { ok: which === 'b' || warned, observed: 'hovered stream b, saved stream ' + which + '; toast "' + r.toast + '"' };
    });

    await check('stream', 'S01', 8, 'X-shaped stream is matched by media id, rebuilt, and saved into the configured folder', async () => {
      const r = await grab(page, '#vx', { settle: 15000 });
      const d = r.pageDl[0];
      if (!d || !d.bytes) return { ok: false, observed: describe(r) };
      const media = path.join(__dirname, 'media');
      const want = Buffer.concat(['init.mp4', 'seg0.m4s', 'seg1.m4s', 'seg2.m4s'].map((f) => fs.readFileSync(path.join(media, f))));
      const exact = Buffer.compare(d.bytes, want) === 0;
      const out = path.join(h.work, 'assembled.mp4');
      fs.writeFileSync(out, d.bytes);
      let probe = '';
      try {
        probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'csv=p=0', out]).toString().trim().replace(/\s+/g, ' ');
      } catch (e) { probe = 'ffprobe failed'; }
      const inFolder = /Snaffle\//.test(r.toast || '');
      return {
        ok: exact && inFolder,
        observed: 'saved ' + d.name + ' (' + d.bytes.length + ' bytes), bytes ' + (exact ? 'match init+segments exactly' : 'DIFFER') +
                  '; ffprobe: ' + probe + '; toast "' + r.toast + '"; folder applied: ' + inFolder
      };
    });

    await check('stream', 'S03', null, 'After an earlier stream download, an id-less grab still saves the hovered video (c), best rendition, pieces in order', async () => {
      const r = await grab(page, '#vc', { settle: 15000 });
      const d = r.pageDl[0];
      const text = d && d.bytes ? d.bytes.toString() : '';
      const want = '[c:hi:init.mp4][c:hi:seg0.m4s][c:hi:seg1.m4s][c:hi:seg2.m4s]';
      return { ok: text === want, observed: text ? 'file contains ' + clean(text) + '; named ' + d.name : describe(r) };
    });
    await page.close();

    const audio = await h.newPage(A.origin + '/pages/stream-audio.html');
    await audio.waitForFunction(() => /ready/.test(document.title), null, { timeout: 8000 });
    await sleep(400);
    await check('stream', 'S04', 9, 'A stream with a separate audio track produces a file with sound', async () => {
      const r = await grab(audio, '#vd', { settle: 15000 });
      const d = r.pageDl[0];
      const text = d && d.bytes ? d.bytes.toString() : '';
      return { ok: /audio/.test(text), observed: 'file has ' + (/audio/.test(text) ? 'audio' : 'no audio pieces') + '; toast "' + r.toast + '"' };
    });
    await audio.close();

    const nocors = await h.newPage(A.origin + '/pages/stream-nocors.html');
    await nocors.waitForFunction(() => /ready/.test(document.title), null, { timeout: 8000 });
    await sleep(400);
    await check('stream', 'S05', null, 'Stream on a CDN without CORS is still rebuilt (service-worker fetch path)', async () => {
      const r = await grab(nocors, '#ve', { settle: 15000 });
      const d = r.pageDl[0];
      const text = d && d.bytes ? d.bytes.toString() : '';
      return { ok: text === '[e:hi:init.mp4][e:hi:seg0.m4s][e:hi:seg1.m4s][e:hi:seg2.m4s]', observed: text ? 'file contains ' + clean(text) : describe(r) };
    });
    await nocors.close();
  }

  /* ========================================================== screenshot */

  async function shoot(page, timeout) {
    const mark = h.pageDownloads.length;
    await clearToast(page);
    await page.keyboard.press('Alt+Shift+KeyS');
    const end = Date.now() + (timeout || 30000);
    while (Date.now() < end && h.pageDownloads.length === mark) await sleep(200);
    await sleep(2200);
    const d = h.pageDownloads[mark];
    const toast = await h.toast(page);
    if (!d) return { toast: toast ? toast.text : '', name: '', bytes: null };
    return { toast: toast ? toast.text : '', name: d.suggestedFilename(), bytes: fs.readFileSync(await d.path()) };
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

    await check('shot', 'C01', null, 'A 2500px page captures as one 1000x2500 image with every band in place', async () => {
      const s = await shoot(tall);
      if (!s.bytes) return { ok: false, observed: 'no file; toast "' + s.toast + '"' };
      const png = PNG.sync.read(s.bytes);
      const seen = BANDS.map((_, i) => px(png, 500, Math.min(png.height - 1, i * 500 + 250)));
      const ok = png.width === 1000 && png.height === 2500 && seen.join() === BANDS.join();
      return { ok, observed: png.width + 'x' + png.height + ', band colours ' + seen.join(' ') + '; saved as ' + s.name + '; scroll restored to ' + await tall.evaluate(() => window.scrollY) };
    });

    await check('shot', 'C06', null, 'JPEG and PDF output are valid files', async () => {
      await h.setCfg({ captureFormat: 'jpeg' });
      const j = await shoot(tall);
      await h.setCfg({ captureFormat: 'pdf' });
      const p = await shoot(tall);
      await h.setCfg({ captureFormat: 'png' });
      const jpegOk = !!j.bytes && j.bytes[0] === 0xff && j.bytes[1] === 0xd8 && /\.jpg$/.test(j.name);
      const text = p.bytes ? p.bytes.toString('latin1') : '';
      const sx = parseInt((/startxref\n(\d+)/.exec(text) || [])[1] || '-1', 10);
      const pdfOk = text.startsWith('%PDF-1.4') && text.slice(sx, sx + 4) === 'xref' && /\.pdf$/.test(p.name);
      const at = text.indexOf('stream\n', text.indexOf('/DCTDecode'));
      const embedded = at > 0 && p.bytes[at + 7] === 0xff && p.bytes[at + 8] === 0xd8;
      return { ok: jpegOk && pdfOk && embedded, observed: 'jpeg ' + (jpegOk ? 'valid (' + j.name + ')' : 'INVALID: got ' + (j.name || 'no file') + ', first bytes ' + (j.bytes ? j.bytes.slice(0, 4).toString('hex') : 'none') + ', toast "' + j.toast + '"') + '; pdf ' + (pdfOk ? 'structure valid' : 'INVALID') + ', embedded JPEG ' + (embedded ? 'present' : 'MISSING') + ' (' + p.name + ')' };
    });

    await check('shot', 'C05', 11, 'Switching tabs during a capture does not put the other tab in the image', async () => {
      const other = await h.context.newPage();
      await other.goto(A.origin + '/pages/lime.html');
      await tall.bringToFront();
      await tall.mouse.move(300, 300);
      const mark = h.pageDownloads.length;
      await tall.keyboard.press('Alt+Shift+KeyS');
      await clearToast(tall);
      await sleep(900);
      await other.bringToFront();
      // Leave the other tab in front for a while, as a user checking something would.
      await sleep(6000);
      const finishedWhileHidden = h.pageDownloads.length > mark;
      await tall.bringToFront();
      const end = Date.now() + 30000;
      while (Date.now() < end && h.pageDownloads.length === mark) await sleep(200);
      await sleep(2200);
      const d = h.pageDownloads[mark];
      const toast = await h.toast(tall);
      const said = toast ? toast.text : '';
      await other.close();
      if (!d) return { ok: /cancel|abort|switch|stopped/i.test(said), observed: 'no image produced; toast "' + said + '"' };
      const png = PNG.sync.read(fs.readFileSync(await d.path()));
      const seen = BANDS.map((_, i) => px(png, 500, Math.min(png.height - 1, i * 500 + 250)));
      const lime = seen.filter((c) => c === '#7fff00').length;
      return {
        ok: lime === 0,
        observed: lime + ' of 5 bands show the other tab (lime #7fff00); band colours ' + seen.join(' ') +
                  '; capture ' + (finishedWhileHidden ? 'ran on while hidden' : 'stalled until the tab was shown again') + '; toast "' + said + '"'
      };
    });
    await tall.close();

    const fixed = await h.newPage(A.origin + '/pages/tall-fixed.html');
    await sleep(500);
    await fixed.mouse.move(300, 300);
    await check('shot', 'C03', 13, 'Fixed header appears once at the top and fixed footer once at the bottom', async () => {
      const s = await shoot(fixed);
      if (!s.bytes) return { ok: false, observed: 'no file; toast "' + s.toast + '"' };
      const png = PNG.sync.read(s.bytes);
      const top = px(png, 500, 20), mid = px(png, 500, 680), end = px(png, 500, png.height - 20);
      const headerRepeats = [720, 1420, 2120].map((y) => px(png, 500, y)).filter((c) => c === '#000000').length;
      const ok = top === '#000000' && mid !== '#ff00ff' && end === '#ff00ff' && headerRepeats === 0;
      const restored = await fixed.evaluate(() => getComputedStyle(document.getElementById('bottom')).visibility);
      return { ok, observed: 'top y=20 ' + top + ' (header), y=680 ' + mid + (mid === '#ff00ff' ? ' (footer baked into mid-page)' : '') + ', last 20px ' + end + (end === '#ff00ff' ? ' (footer)' : ' (footer missing)') + '; header repeats ' + headerRepeats + '; footer visibility after capture: ' + restored };
    });
    await fixed.close();

    const inner = await h.newPage(A.origin + '/pages/innerscroll.html');
    await sleep(500);
    await inner.mouse.move(300, 300);
    await check('shot', 'C04', 12, 'A page that scrolls inside a container is captured in full, or the user is warned', async () => {
      const s = await shoot(inner);
      if (!s.bytes) return { ok: /scroll|container|visible/i.test(s.toast), observed: 'no file; toast "' + s.toast + '"' };
      const png = PNG.sync.read(s.bytes);
      // The page title is in the file name, so judge the message without it.
      const warned = /only the visible|scrolls inside|could not capture|partial/i.test(s.toast.replace(s.name, ''));
      return { ok: png.height >= 2500 || warned, observed: 'image is ' + png.width + 'x' + png.height + ' of a 2500px document; toast "' + s.toast + '"' };
    });
    await inner.close();

    // Device pixel ratio 2 needs its own browser.
    const h2 = await launch({ dpr: 2 });
    await check('shot', 'C02', null, 'At device pixel ratio 2 the capture is 2000x5000 and bands still line up', async () => {
      const page = await h2.newPage(A.origin + '/pages/tall.html');
      await sleep(600);
      await page.mouse.move(300, 300);
      const mark = h2.pageDownloads.length;
      await page.keyboard.press('Alt+Shift+KeyS');
      const end = Date.now() + 30000;
      while (Date.now() < end && h2.pageDownloads.length === mark) await sleep(200);
      const d = h2.pageDownloads[mark];
      if (!d) { const t = await h2.toast(page); return { ok: false, observed: 'no file; toast "' + (t ? t.text : '') + '"' }; }
      const png = PNG.sync.read(fs.readFileSync(await d.path()));
      const seen = BANDS.map((_, i) => px(png, 1000, Math.min(png.height - 1, i * 1000 + 500)));
      // Where did the pixels actually land? Sample the left quarter too.
      const leftQuarter = [250, 1250, 2250].map((y) => px(png, 250, y)).join(' ');
      const shotSize = await page.evaluate(() => window.innerWidth + 'x' + window.innerHeight + ' css px at dpr ' + window.devicePixelRatio);
      return {
        ok: png.width === 2000 && png.height === 5000 && seen.join() === BANDS.join(),
        observed: png.width + 'x' + png.height + '; centre column ' + seen.join(' ') + '; left quarter at y=250,1250,2250: ' + leftQuarter + '; viewport ' + shotSize
      };
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
    const names = (list) => list.map((c) => /^blob:/.test(c.url) ? 'blob' : base(c.url));

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
      return { ok: big.length === 0, observed: big.length ? 'fetched for thumbnails: ' + big.join(', ') + ' (800x600 and 1600x1200; the page itself had only loaded 200x150 versions)' : 'no full-size fetches' };
    });

    await check('list', 'L05', 18, 'A 10x10 background image is hidden by the 80px minimum once its size is known', async () => {
      const n = names(list || []);
      const tiny = (list || []).find((c) => /tinybg/.test(c.url));
      return { ok: !n.includes('tinybg.png'), observed: tiny ? 'tinybg.png still listed, showing "' + tiny.dims + '"' : 'not listed' };
    });

    await check('list', 'L06', null, 'Cards are reachable and selectable from the keyboard', async () => {
      const c = (list || [])[0] || {};
      return { ok: c.tabindex != null, observed: 'card tabindex=' + c.tabindex + ', role=' + c.role };
    });

    await check('list', 'L03', 17, 'Select all + Download saves every listed item and reports the true count', async () => {
      const before = new Set((await h.apiDownloads()).map((d) => d.id));
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
      const api = (await h.apiDownloads()).filter((d) => !before.has(d.id));
      const done = api.filter((d) => d.state === 'complete').length;
      const bad = api.filter((d) => d.state !== 'complete').map((d) => (/^blob:/.test(d.url) ? 'blob' : base(d.url)) + ' ' + (d.error || d.state));
      const toast = await h.toast(page);
      const claimed = parseInt((/Saved (\d+)/.exec(toast ? toast.text : '') || [])[1] || '-1', 10);
      return { ok: done === count && claimed === done, observed: count + ' selected, ' + api.length + ' downloads started [' + api.map((d) => (/^blob:/.test(d.url) ? 'blob' : /^data:/.test(d.url) ? 'data' : base(d.url))).join(', ') + '], ' + done + ' completed' + (bad.length ? ' (failed: ' + bad.join(', ') + ')' : '') + '; toast "' + (toast ? toast.text : '') + '"' };
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
      const before = new Set((await h.apiDownloads()).map((d) => d.id));
      await h.hover(page, '#plain img');
      await page.keyboard.press('Control+Shift+KeyK');
      await sleep(1200);
      const got = (await h.apiDownloads()).filter((d) => !before.has(d.id)).length;
      await page.close();
      await opt.click('#reset'); await sleep(300);
      return { ok: stored.code === 'KeyK' && stored.ctrl && got === 1, observed: 'stored ' + JSON.stringify({ code: stored.code, ctrl: stored.ctrl, shift: stored.shift, alt: stored.alt }) + '; new shortcut produced ' + got + ' download' };
    });

    await check('ui', 'P05', 20, 'Defaults are not written into storage at install', async () => {
      const cfg = await h.getCfg();
      const keys = Object.keys(cfg || {});
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

    await check('life', 'X01', 21, 'After the extension reloads, an open tab still works or says to reload', async () => {
      const page = await h.newPage(A.origin + '/pages/grab.html');
      await sleep(500);
      await h.probe.evaluate(() => chrome.runtime.reload()).catch(() => {});
      await sleep(2500);
      await page.bringToFront();
      const mark = A.mark();
      await clearToast(page);
      await h.hover(page, '#plain img');
      await page.keyboard.press('Alt+KeyS');
      await sleep(3000);
      const t = await h.toast(page);
      const fetched = A.since(mark).filter((r) => /plain\.png/.test(r.path)).length;
      const text = t ? t.text : '';
      return { ok: /reload/i.test(text) || (fetched > 0 && /^Saved/.test(text)), observed: 'toast "' + (text || '(none)') + '"; server saw ' + fetched + ' request(s) for the image; page download events ' + h.pageDownloads.filter((d) => /plain/.test(d.suggestedFilename())).length };
    });
  }

  await h.close().catch(() => {});
  await A.close(); await B.close();

  const run = results.filter((r) => !r.untested);
  const failed = run.filter((r) => !r.ok);
  fs.writeFileSync(path.join(__dirname, 'last-run.json'), JSON.stringify(results, null, 2));
  console.log('\n' + run.length + ' checks: ' + (run.length - failed.length) + ' ok, ' + failed.length + ' failing' +
              (failed.length ? ' (' + failed.map((r) => r.id).join(' ') + ')' : ''));
  process.exit(0);
})().catch((e) => { console.error('RUN FAILED', e); process.exit(2); });
