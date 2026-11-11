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
  C02: 'phase 4: capture trusts devicePixelRatio instead of measuring the shot',
  C03: 'phase 4: fixed elements are hidden before the first shot',
  C04: 'phase 4: inner scrolling containers are not detected',
  C05: 'phase 4: no check that the tab is still in front',
  L02: 'phase 4: thumbnails load the full-size originals',
  L05: 'phase 4: size filter is not re-applied when dimensions arrive',
  L06: 'phase 3: media list has no keyboard access',
  P02: 'phase 3: recorded shortcut is not saved until Save is pressed'
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
    const piecesOf = (r) => (r.bytes ? r.bytes.toString() : '');
    const streamOf = (r) => (/^\[([a-z0-9]+):/.exec(piecesOf(r)) || [])[1] || (r.bytes ? 'something else (' + r.bytes.length + ' bytes)' : 'nothing');

    // What ffprobe makes of a saved file: tracks, frame counts, size, length.
    const probe = (bytes) => {
      const out = path.join(h.work, 'probe-' + Date.now() + '.bin');
      fs.writeFileSync(out, bytes);
      try {
        const raw = execFileSync('ffprobe', ['-v', 'error', '-show_entries',
          'format=duration,format_name:stream=codec_type,width,height,nb_frames', '-of', 'json', out]).toString();
        const j = JSON.parse(raw);
        const v = (j.streams || []).find((s) => s.codec_type === 'video');
        const a = (j.streams || []).find((s) => s.codec_type === 'audio');
        return {
          video: !!v, audio: !!a, height: v ? v.height : 0, frames: v ? parseInt(v.nb_frames || '0', 10) : 0,
          seconds: parseFloat((j.format || {}).duration || '0'), mp4: /mp4/.test((j.format || {}).format_name || ''),
          text: (v ? 'video ' + v.width + 'x' + v.height + ' ' + v.nb_frames + ' frames' : 'no video') + ', ' +
                (a ? 'audio' : 'NO AUDIO') + ', ' + parseFloat((j.format || {}).duration || '0').toFixed(2) + 's'
        };
      } catch (e) { return { video: false, audio: false, text: 'ffprobe could not read it' }; }
    };
    const whole = (p) => p.video && p.audio && p.mp4 && p.frames === 150 && Math.abs(p.seconds - 6) < 0.3;

    const openStream = async (src) => {
      const page = await h.newPage(A.origin + '/pages/one-stream.html?src=' + encodeURIComponent(src));
      await page.waitForFunction(() => /ready/.test(document.title), null, { timeout: 8000 });
      await sleep(500);
      return page;
    };

    const page = await h.newPage(A.origin + '/pages/stream.html');
    await page.waitForFunction(() => /ready/.test(document.title), null, { timeout: 8000 });
    await sleep(500);

    // Runs first, on a fresh page: the only playlists recorded are the page's own.
    await check('stream', 'S02', 7, 'With no media id and several streams on the page, the user is told the result is a guess', async () => {
      const r = await grab(page, '#vb', { settle: 20000 });
      const warned = /best guess/i.test(r.toast || '');
      return { ok: streamOf(r) === 'b' || warned, observed: 'hovered stream b, saved stream ' + streamOf(r) + '; toast "' + r.toast + '"' };
    });

    await check('stream', 'S01', null, 'X-shaped stream is matched by media id and rebuilt into a whole MP4, in the folder', async () => {
      const r = await grab(page, '#vx', { settle: 20000 });
      if (!r.bytes) return { ok: false, observed: describe(r) };
      const p = probe(r.bytes);
      const named = /^Saved Snaffle\/127\.0\.0\.1\/video-111-240p\.mp4 \(/.test(r.toast || '');
      const size = (/\(([\d.]+ [KM]B)\)/.exec(r.toast || '') || [])[1] || '';
      const truthful = size === Math.max(1, Math.round(r.bytes.length / 1024)) + ' KB';
      return { ok: whole(p) && named && truthful && !r.anchors.length, observed: p.text + '; ' + r.bytes.length + ' bytes; toast "' + r.toast + '"' };
    });

    // The extension has now fetched playlists of its own. They must not be
    // mistaken for the page's: c is still the last stream the page asked for.
    // These streams are not real video, so this also exercises the plain
    // joiner that takes over when the library cannot read a stream.
    await check('stream', 'S03', null, 'After earlier stream downloads, an id-less grab still follows the page; unreadable streams fall back to joining', async () => {
      const r = await grab(page, '#vc', { settle: 20000 });
      const want = '[c:hi:init.mp4][c:hi:seg0.m4s][c:hi:seg1.m4s][c:hi:seg2.m4s]';
      return { ok: piecesOf(r) === want && /joined segments/.test(r.toast || ''), observed: r.bytes ? 'file contains ' + clean(piecesOf(r)) + '; toast "' + r.toast + '"' : describe(r) };
    });
    await page.close();

    const split = await openStream(A.origin + '/real/split/master.m3u8');
    await check('stream', 'S04', 9, 'A stream that keeps audio in a separate track is saved as one file with sound', async () => {
      const r = await grab(split, '#v', { settle: 20000 });
      if (!r.bytes) return { ok: false, observed: describe(r) };
      const p = probe(r.bytes);
      return { ok: whole(p), observed: p.text + '; toast "' + r.toast + '"' };
    });

    await check('stream', 'S07', null, 'A page with a single stream is not called a guess', async () => {
      const r = await grab(split, '#v', { settle: 20000 });
      return { ok: !/guess/i.test(r.toast || '') && /^Saved/.test(r.toast || ''), observed: 'toast "' + r.toast + '"' };
    });
    await split.close();

    const multi = await openStream(A.origin + '/real/multi/master.m3u8');
    await check('stream', 'S09', null, 'The higher of two renditions is the one saved', async () => {
      const r = await grab(multi, '#v', { settle: 20000 });
      if (!r.bytes) return { ok: false, observed: describe(r) };
      const p = probe(r.bytes);
      return { ok: whole(p) && p.height === 240 && /-240p\.mp4/.test(r.toast || ''), observed: p.text + '; toast "' + r.toast + '"' };
    });
    await multi.close();

    const tsPage = await openStream(A.origin + '/real/ts/media.m3u8');
    await check('stream', 'S10', null, 'An MPEG-TS stream is saved as an MP4, not a .ts file', async () => {
      const r = await grab(tsPage, '#v', { settle: 20000 });
      if (!r.bytes) return { ok: false, observed: describe(r) };
      const p = probe(r.bytes);
      return { ok: whole(p) && /\.mp4 \(/.test(r.toast || ''), observed: p.text + '; toast "' + r.toast + '"' };
    });
    await tsPage.close();

    const guarded = await openStream(A.origin + '/guarded/multi/master.m3u8');
    await check('stream', 'S11', null, 'A stream that is only served with the page as Referer is still saved', async () => {
      const markA = A.mark();
      const r = await grab(guarded, '#v', { settle: 20000 });
      const refs = A.since(markA).filter((q) => /^\/guarded\//.test(q.path) && /one-stream\.html/.test(q.referer)).length;
      if (!r.bytes) return { ok: false, observed: describe(r) + '; guarded requests carrying the page as Referer: ' + refs };
      const p = probe(r.bytes);
      return { ok: whole(p), observed: p.text + '; ' + refs + ' requests carried the page as Referer; toast "' + r.toast + '"' };
    });
    await guarded.close();

    const fake = await h.newPage(A.origin + '/pages/stream-audio.html');
    await fake.waitForFunction(() => /ready/.test(document.title), null, { timeout: 8000 });
    await sleep(400);
    await check('stream', 'S08', null, 'When split audio cannot be merged, nothing is saved rather than a silent file', async () => {
      const r = await grab(fake, '#vd', { settle: 20000 });
      const none = !r.api.some((d) => d.state === 'complete');
      return { ok: none && /Could not save this video/.test(r.toast || ''), observed: describe(r) };
    });
    await fake.close();

    const nocors = await h.newPage(A.origin + '/pages/stream-nocors.html');
    await nocors.waitForFunction(() => /ready/.test(document.title), null, { timeout: 8000 });
    await sleep(400);
    await check('stream', 'S05', null, 'Stream on a CDN that refuses cross-origin reads is still rebuilt', async () => {
      const r = await grab(nocors, '#ve', { settle: 20000 });
      return { ok: piecesOf(r) === '[e:hi:init.mp4][e:hi:seg0.m4s][e:hi:seg1.m4s][e:hi:seg2.m4s]', observed: r.bytes ? 'file contains ' + clean(piecesOf(r)) : describe(r) };
    });
    await nocors.close();

    // A stream slowed down at the server, so there is time to do other things.
    A.slow(900);
    const slow = await openStream(A.origin + '/real/multi/master.m3u8');

    await check('stream', 'S12', 10, 'While a video is downloading, another image can be saved, and the video still finishes', async () => {
      const marks = await mark(h);
      await h.hover(slow, '#v');
      await slow.keyboard.press('Alt+KeyS');
      await sleep(700);
      await h.hover(slow, '#pic');
      await slow.keyboard.press('Alt+KeyS');
      await sleep(1500);
      const early = (await h.apiDownloads()).filter((d) => !marks.ids.has(d.id) && d.state === 'complete').map((d) => base(d.url));
      const end = Date.now() + 40000;
      let all = [];
      while (Date.now() < end) {
        all = (await h.apiDownloads()).filter((d) => !marks.ids.has(d.id) && d.state === 'complete');
        if (all.some((d) => /^blob:/.test(d.url))) break;
        await sleep(300);
      }
      const video = all.find((d) => /^blob:/.test(d.url));
      const p = video ? probe(fs.readFileSync(video.filename)) : { text: 'video never arrived' };
      const imageFirst = early.includes('beside.png') && !early.includes('blob');
      return { ok: imageFirst && !!video && whole(p), observed: 'finished within 1.5s of the second grab: [' + early.join(', ') + ']; later the video: ' + p.text };
    });

    await check('stream', 'S13', null, 'Escape cancels a video download and nothing is saved', async () => {
      const marks = await mark(h);
      await clearToast(slow);
      await h.hover(slow, '#v');
      await slow.keyboard.press('Alt+KeyS');
      await sleep(1200);
      await slow.keyboard.press('Escape');
      await sleep(4000);
      const t = await h.toast(slow);
      const files = (await h.apiDownloads()).filter((d) => !marks.ids.has(d.id)).length;
      return { ok: files === 0 && /Cancelled/.test(t ? t.text : ''), observed: 'toast "' + (t ? t.text : '') + '"; downloads ' + files };
    });

    await check('stream', 'S14', 10, 'A video download carries on after its tab navigates away', async () => {
      const marks = await mark(h);
      await h.hover(slow, '#v');
      await slow.keyboard.press('Alt+KeyS');
      await sleep(900);
      await slow.goto(A.origin + '/article.html');
      const end = Date.now() + 40000;
      let video = null;
      while (Date.now() < end && !video) {
        video = (await h.apiDownloads()).find((d) => !marks.ids.has(d.id) && d.state === 'complete' && /^blob:/.test(d.url));
        await sleep(300);
      }
      const p = video ? probe(fs.readFileSync(video.filename)) : { text: 'video never arrived' };
      return { ok: !!video && whole(p), observed: p.text };
    });
    A.slow(0);
    await slow.close();
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
      const stored = ((await h.getCfg()) || {}).key || { code: '(nothing stored)' };
      const marker = await opt.evaluate(() => /unsaved|not saved/i.test(document.body.innerText));
      const persisted = stored.code === 'KeyK';
      await opt.reload(); await sleep(400);
      const afterReload = await opt.evaluate(() => document.getElementById('keyRec').textContent);
      return { ok: persisted || marker, observed: 'box shows "' + shown + '", storage has ' + stored.code + ', no unsaved marker; after reload the box reads "' + afterReload + '"' };
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
      return { ok: keys.length === 0, observed: 'storage holds ' + keys.length + ' keys right after install' + (keys.length ? ' (' + keys.slice(0, 5).join(', ') + ')' : '') };
    });

    await check('ui', 'P06', 20, 'Saving stores only what was changed, and an old full config is slimmed to the same', async () => {
      await opt.click('#keyRec');
      await opt.keyboard.press('Control+Shift+KeyK');
      await opt.click('#save');
      await sleep(300);
      const saved = Object.keys((await h.getCfg()) || {}).sort().join(',');
      await opt.click('#reset'); await sleep(300);
      const afterReset = await h.getCfg();
      return { ok: saved === 'key,v' && afterReset === undefined, observed: 'after changing one shortcut storage holds [' + saved + ']; after Reset it holds ' + (afterReset === undefined ? 'nothing' : JSON.stringify(afterReset)) };
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
    await check('life', 'X02', 19, 'No message hands fetched bytes back to the caller', async () => {
      const r = await h.probe.evaluate((u) => new Promise((res) => chrome.runtime.sendMessage({ type: 'proxyFetch', url: u }, (x) => { void chrome.runtime.lastError; res(x && x.b64 ? atob(x.b64).slice(0, 60) : 'refused'); })), A.origin + '/article.html');
      const g = await h.probe.evaluate((u) => new Promise((res) => chrome.runtime.sendMessage({ type: 'proxyGrab', url: u, filename: 'x.html' }, (x) => { void chrome.runtime.lastError; res(JSON.stringify(x)); })), A.origin + '/article.html');
      return { ok: r === 'refused' && !/b64|html>/.test(g), observed: 'read-back request: ' + r + '; download-only request for a web page answered ' + g };
    });

    await check('life', 'F01', null, 'The popup route loads a feature into a tab that asks for it', async () => {
      const page = await h.newPage(A.origin + '/pages/gallery.html');
      await page.waitForFunction(() => /ready/.test(document.title), null, { timeout: 8000 });
      const res = await h.probe.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => /gallery\.html/.test(t.url || ''));
        if (!tab) return { ok: false, error: 'tab not found' };
        return new Promise((r) => chrome.runtime.sendMessage({ type: 'feature', name: 'gallery', tabId: tab.id }, r));
      });
      await sleep(2000);
      const open = await page.evaluate(() => !!document.getElementById('__snaffle_gallery'));
      await page.close();
      return { ok: !!(res && res.ok) && open, observed: 'answer ' + JSON.stringify(res) + '; panel open: ' + open };
    });

    await check('life', 'F02', null, 'On a page extensions cannot touch, the popup route says so', async () => {
      const page = await h.context.newPage();
      await page.goto('chrome://version/').catch(() => {});
      const res = await h.probe.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => !t.url);
        if (!tab) return { ok: false, error: 'no restricted tab found' };
        return new Promise((r) => chrome.runtime.sendMessage({ type: 'feature', name: 'capture', tabId: tab.id }, r));
      });
      await page.close();
      return { ok: !!res && res.ok === false && /cannot run on this page/i.test(res.error || ''), observed: 'answer ' + JSON.stringify(res) };
    });

    await check('life', 'X03', 21, 'Loading the content script into a tab that already has it does not double the grab', async () => {
      const page = await h.newPage(A.origin + '/pages/grab.html');
      await sleep(500);
      // What the extension does to every open tab when it is installed or updated.
      const injected = await h.probe.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => /grab\.html/.test(t.url || ''));
        const r = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['shared.js', 'content.js'] });
        return r.length;
      });
      const r = await grab(page, '#plain img');
      const requests = r.reqA.filter((q) => /plain\.png/.test(q.path)).length;
      await page.close();
      return { ok: requests === 1 && r.api.length === 1, observed: 're-injected into ' + injected + ' frames; one key press made ' + requests + ' request(s) and ' + r.api.length + ' download(s)' };
    });

    // Reloading an unpacked extension under automation removes it for good, so
    // the fresh copy that a real update injects cannot be observed here. What
    // can be: the copy left behind recognises it has been cut off and says so.
    await check('life', 'X01', 21, 'A tab whose extension has gone says to reload, rather than half-working', async () => {
      const page = await h.newPage(A.origin + '/pages/grab.html');
      await sleep(500);
      await h.probe.evaluate(() => chrome.runtime.reload()).catch(() => {});
      await sleep(2500);
      await page.bringToFront();
      const markA = A.mark();
      await clearToast(page);
      await h.hover(page, '#plain img');
      await page.keyboard.press('Alt+KeyS');
      await sleep(2000);
      const t = await h.toast(page);
      const fetched = A.since(markA).filter((q) => /plain\.png/.test(q.path)).length;
      const text = t ? t.text : '';
      return { ok: /Reload this page/.test(text) && fetched === 0, observed: 'toast "' + (text || '(none)') + '"; requests for the image: ' + fetched };
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
