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
  C05: 'phase 4: no check that the tab is still in front'
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
    if (host && host.shadowRoot) host.shadowRoot.querySelectorAll('.toast').forEach((t) => t.remove());
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

    await check('grab', 'G30', null, 'Typing in a text box inside a shadow root also counts as typing', async () => {
      const r = await grab(page, '#plain img', {
        settle: 1500,
        beforeTrigger: async () => { await page.evaluate(() => document.getElementById('shadowfield').shadowRoot.querySelector('input').focus()); }
      });
      await page.evaluate(() => document.getElementById('shadowfield').shadowRoot.querySelector('input').blur());
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

    await check('grab', 'G28', null, 'A saved file is confirmed with a button to show it in its folder', async () => {
      const r = await grab(page, '#plain img', { after: 200 });
      const t = await h.toast(page);
      // The toast must take clicks; the area around it must not.
      const hits = await page.evaluate(() => {
        const root = document.getElementById('__snaffle_ui').shadowRoot;
        return { toast: getComputedStyle(root.querySelector('.toast')).pointerEvents, list: getComputedStyle(root.querySelector('.toasts')).pointerEvents };
      });
      const pressed = await page.evaluate(() => {
        const b = document.getElementById('__snaffle_ui').shadowRoot.querySelector('.acts button');
        if (b) b.click();
        return !!b;
      });
      await sleep(400);
      const gone = !(await h.toast(page));
      const ok = /^Saved/.test(r.toast) && !!t && t.actions.join() === 'Show in folder' && hits.toast === 'auto' && hits.list === 'none' && pressed && gone;
      return { ok, observed: 'toast "' + r.toast + '" with buttons [' + (t ? t.actions.join(', ') : '') + ']; clickable: toast ' + hits.toast + ', surrounding area ' + hits.list + '; pressing the button dismissed it: ' + gone };
    });

    await check('grab', 'G29', null, 'With confirmations turned off, a saved file is silent but a failure is still shown', async () => {
      await h.setCfg({ toast: false });
      const good = await grab(page, '#plain img', { settle: 1800 });
      const bad = await grab(page, '#xprotected img', { after: 2500 });
      await h.setCfg({ toast: true });
      const ok = gotFile(good, 'plain.png') && !good.toast && /Could not save/.test(bad.toast || bad.finalToast);
      return { ok, observed: 'saved image: file arrived, toast "' + (good.toast || '(none)') + '"; failed image: toast "' + (bad.toast || bad.finalToast) + '"' };
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
      const said = await h.settledToast(slow, 5000);
      await sleep(2500);
      const files = (await h.apiDownloads()).filter((d) => !marks.ids.has(d.id)).length;
      return { ok: files === 0 && /Cancelled/.test(said), observed: 'toast "' + said + '"; downloads ' + files };
    });

    await check('stream', 'S15', null, 'A running download shows a progress bar and a Cancel button that stops it', async () => {
      const marks = await mark(h);
      await clearToast(slow);
      await h.hover(slow, '#v');
      await slow.keyboard.press('Alt+KeyS');
      await sleep(1500);
      const during = await h.toast(slow);
      // Press the toast's own button, the way a user would.
      const pressed = await slow.evaluate(() => {
        const root = document.getElementById('__snaffle_ui').shadowRoot;
        const b = Array.from(root.querySelectorAll('.acts button')).find((x) => x.textContent === 'Cancel');
        if (b) b.click();
        return !!b;
      });
      const said = await h.settledToast(slow, 5000);
      await sleep(2500);
      const files = (await h.apiDownloads()).filter((d) => !marks.ids.has(d.id)).length;
      const ok = pressed && during && during.progress != null && /busy/.test(during.cls) && /Cancelled/.test(said) && files === 0;
      return { ok, observed: 'while running: "' + (during ? during.text : '') + '", bar at ' + (during ? during.progress : 'none') + ', buttons [' + (during ? during.actions.join(', ') : '') + ']; after Cancel: "' + said + '"; downloads ' + files };
    });

    await check('stream', 'S16', null, 'An image saved during a video download gets its own toast beside the progress one', async () => {
      await clearToast(slow);
      await h.hover(slow, '#v');
      await slow.keyboard.press('Alt+KeyS');
      await sleep(900);
      await h.hover(slow, '#pic');
      await slow.keyboard.press('Alt+KeyS');
      await sleep(1200);
      const t = await h.toast(slow);
      const all = t ? t.all : [];
      await slow.keyboard.press('Escape');
      await h.settledToast(slow, 5000);
      const both = all.some((x) => /^(Reading|Downloading)/.test(x)) && all.some((x) => /^Saved .*beside\.png/.test(x));
      return { ok: both && all.length === 2, observed: all.length + ' toasts on screen: ' + JSON.stringify(all) };
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

    // The cards a user can see, and where keyboard focus is.
    const panel = () => page.evaluate(() => {
      const host = document.getElementById('__snaffle_gallery');
      if (!host || !host.shadowRoot) return null;
      const r = host.shadowRoot;
      const active = r.activeElement;
      return {
        cards: Array.from(r.querySelectorAll('.card')).filter((c) => !c.hidden).map((c) => ({
          url: c.dataset.url, dims: (c.querySelector('.dims') || {}).textContent || '',
          selected: c.getAttribute('aria-selected') === 'true', tabindex: c.getAttribute('tabindex'),
          role: c.getAttribute('role'), state: c.classList.contains('done') ? 'done' : c.classList.contains('failed') ? 'failed' : ''
        })),
        focus: active ? (active.classList.contains('card') ? 'card:' + active.dataset.url.split('/').pop() : active.tagName.toLowerCase() + (active.dataset.act ? ':' + active.dataset.act : '')) : 'none',
        status: r.querySelector('footer').textContent,
        button: r.querySelector('[data-act="dl"]').textContent,
        dialog: r.querySelector('.wrap').getAttribute('role') + '/' + r.querySelector('.wrap').getAttribute('aria-modal'),
        shade: !!r.querySelector('.shade')
      };
    });
    const names = (cards) => cards.map((c) => base(c.url));

    const markA = A.mark();
    await page.keyboard.press('Alt+Shift+KeyI');
    await sleep(2500);
    const first = await panel();

    await check('list', 'L01', null, 'The panel opens as a dialog and lists the page images, including one inside a cross-origin iframe', async () => {
      if (!first) return { ok: false, observed: 'panel did not open; toast "' + ((await h.toast(page)) || {}).text + '"' };
      const n = names(first.cards);
      const ok = ['one.png', 'two-large.png', 'three-full.png', 'bigbg.png', 'framed.png'].every((f) => n.includes(f)) &&
                 first.dialog === 'dialog/true' && first.shade;
      return { ok, observed: first.cards.length + ' items: ' + n.join(', ') + '; ' + first.dialog + ', page dimmed: ' + first.shade };
    });

    await check('list', 'L04', null, 'A thumbnail that links to its full file is listed once, as the full file', async () => {
      const n = names(first ? first.cards : []);
      return { ok: n.includes('three-full.png') && !n.includes('three-thumb.png'), observed: 'three-full.png ' + (n.includes('three-full.png') ? 'listed' : 'missing') + ', three-thumb.png ' + (n.includes('three-thumb.png') ? 'also listed' : 'not listed separately') };
    });

    await check('list', 'L02', 16, 'Opening the panel does not fetch full-size originals just to draw thumbnails', async () => {
      const big = A.since(markA).map((r) => r.path.split('/').pop()).filter((f) => /two-large|three-full/.test(f));
      return { ok: big.length === 0, observed: big.length ? 'fetched for thumbnails: ' + big.join(', ') : 'no full-size fetches; previews reuse what the page had loaded' };
    });

    await check('list', 'L05', 18, 'A 10x10 background image is hidden by the 80px minimum once its size is known', async () => {
      const tiny = (first ? first.cards : []).find((c) => /tinybg/.test(c.url));
      return { ok: !tiny, observed: tiny ? 'tinybg.png still showing, "' + tiny.dims + '"' : 'not showing' };
    });

    await check('list', 'L06', null, 'Cards can be reached, moved between and selected from the keyboard', async () => {
      const start = first ? first.focus : 'none';
      await page.keyboard.press('ArrowRight');
      const moved = (await panel()).focus;
      await page.keyboard.press('Space');
      const after = await panel();
      const picked = after.cards.filter((c) => c.selected).map((c) => base(c.url));
      await page.keyboard.press('Space');
      const cleared = (await panel()).cards.filter((c) => c.selected).length;
      const ok = /^card:/.test(start) && /^card:/.test(moved) && moved !== start && picked.length === 1 && 'card:' + picked[0] === moved && cleared === 0;
      return { ok, observed: 'focus opens on ' + start + '; Right arrow moves to ' + moved + '; Space selects [' + picked.join(', ') + ']; Space again leaves ' + cleared + ' selected' };
    });

    await check('list', 'L08', null, 'Tab stays inside the dialog', async () => {
      const seen = [];
      for (let i = 0; i < 14; i++) { await page.keyboard.press('Tab'); seen.push((await panel()).focus); }
      const outside = await page.evaluate(() => document.activeElement && document.activeElement.id !== '__snaffle_gallery' && document.activeElement !== document.body ? document.activeElement.tagName : '');
      const stops = Array.from(new Set(seen));
      return { ok: !seen.includes('none') && !outside && stops.length >= 5 && seen.filter((x) => x === stops[0]).length >= 2, observed: stops.length + ' stops, cycling: ' + stops.join(' > ') + (outside ? '; ESCAPED to ' + outside : '') };
    });

    await check('list', 'L09', null, 'Shift-click selects the range between two cards', async () => {
      const boxes = await page.evaluate(() => {
        const r = document.getElementById('__snaffle_gallery').shadowRoot;
        return Array.from(r.querySelectorAll('.card')).filter((c) => !c.hidden).map((c) => { const b = c.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
      });
      await page.mouse.click(boxes[0].x, boxes[0].y);
      await page.keyboard.down('Shift');
      await page.mouse.click(boxes[3].x, boxes[3].y);
      await page.keyboard.up('Shift');
      const p = await panel();
      const n = p.cards.filter((c) => c.selected).length;
      await page.evaluate(() => document.getElementById('__snaffle_gallery').shadowRoot.querySelector('[data-act="none"]').click());
      return { ok: n === 4 && /Download 4/.test(p.button), observed: n + ' selected after clicking card 1 then shift-clicking card 4; button reads "' + p.button + '"' };
    });

    await check('list', 'L10', null, 'Typing in the filter keeps the same cards rather than rebuilding them', async () => {
      await page.evaluate(() => { window.__firstCard = document.getElementById('__snaffle_gallery').shadowRoot.querySelector('.card'); });
      await page.evaluate(() => {
        const input = document.getElementById('__snaffle_gallery').shadowRoot.querySelector('input[type=search]');
        input.value = 'bigbg'; input.dispatchEvent(new Event('input'));
      });
      const narrowed = (await panel()).cards.length;
      const same = await page.evaluate(() => {
        const r = document.getElementById('__snaffle_gallery').shadowRoot;
        const input = r.querySelector('input[type=search]');
        input.value = ''; input.dispatchEvent(new Event('input'));
        return r.querySelector('.card') === window.__firstCard;
      });
      const back = (await panel()).cards.length;
      return { ok: narrowed === 1 && same && back === first.cards.length, observed: 'filter "bigbg" shows ' + narrowed + ' card; cleared shows ' + back + '; first card is the same element: ' + same };
    });

    await check('list', 'L03', 17, 'Select all + Download saves every selected item, reports the true count, and stays open', async () => {
      const marks = await mark(h);
      const count = await page.evaluate(() => {
        const r = document.getElementById('__snaffle_gallery').shadowRoot;
        r.querySelector('[data-act="all"]').click();
        const n = r.querySelectorAll('.card[aria-selected="true"]').length;
        r.querySelector('[data-act="dl"]').click();
        return n;
      });
      const end = Date.now() + 30000;
      let p = await panel();
      while (Date.now() < end && p && !/^Saved \d+ file/.test(p.status)) { await sleep(300); p = await panel(); }
      const api = (await h.apiDownloads()).filter((d) => !marks.ids.has(d.id));
      const done = api.filter((d) => d.state === 'complete').length;
      const claimed = parseInt((/Saved (\d+)/.exec(p ? p.status : '') || [])[1] || '-1', 10);
      const marked = p ? p.cards.filter((c) => c.state === 'done').length : 0;
      return { ok: !!p && done === count && claimed === count && marked === count, observed: count + ' selected, ' + done + ' completed [' + api.filter((d) => d.state === 'complete').map((d) => base(d.url)).join(', ') + ']; panel says "' + (p ? p.status : 'closed') + '"; ' + marked + ' cards marked saved' };
    });

    await check('list', 'L07', null, 'Escape closes the panel and gives focus back to the page', async () => {
      await page.keyboard.press('Escape');
      await sleep(300);
      const gone = await page.evaluate(() => !document.getElementById('__snaffle_gallery'));
      return { ok: gone, observed: gone ? 'closed' : 'still open' };
    });
    await page.close();

    // A page where one of the listed files cannot be fetched at all.
    const bad = await h.newPage(A.origin + '/pages/grab.html');
    await sleep(700);
    await bad.mouse.move(900, 600);
    await check('list', 'L11', null, 'A file that cannot be saved is named, counted, and left selected', async () => {
      await bad.keyboard.press('Alt+Shift+KeyI');
      await sleep(2500);
      const picked = await bad.evaluate(() => {
        const r = document.getElementById('__snaffle_gallery').shadowRoot;
        const want = Array.from(r.querySelectorAll('.card')).filter((c) => /plain\.png|far\.png/.test(c.dataset.url));
        want.forEach((c) => c.click());
        r.querySelector('[data-act="dl"]').click();
        return want.length;
      });
      const read = () => bad.evaluate(() => {
        const host = document.getElementById('__snaffle_gallery');
        if (!host) return null;
        const r = host.shadowRoot;
        return { status: r.querySelector('footer').textContent, warn: r.querySelector('footer').className, selected: Array.from(r.querySelectorAll('.card[aria-selected="true"]')).map((c) => c.dataset.url.split('/').pop()) };
      });
      const end = Date.now() + 30000;
      let p = await read();
      while (Date.now() < end && p && !/^Saved \d+ file/.test(p.status)) { await sleep(300); p = await read(); }
      const ok = picked === 2 && !!p && /^Saved 1 file\. Could not save 1: far/.test(p.status) && p.selected.join() === 'far.png' && p.warn === 'warn';
      return { ok, observed: 'picked ' + picked + '; panel says "' + (p ? p.status : 'closed') + '"; still selected: [' + (p ? p.selected.join(', ') : '') + ']' };
    });
    await bad.close();
  }

  /* ================================================================== ui */

  if (!only || only === 'ui') {
    const opt = await h.context.newPage();
    const errors = [];
    opt.on('pageerror', (e) => errors.push(String(e)));
    opt.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await opt.goto('chrome-extension://' + h.extId + '/options.html');
    await sleep(500);

    const text = (id) => opt.evaluate((x) => document.getElementById(x).textContent, id);
    const hint = (id) => opt.evaluate((x) => { const e = document.getElementById(x); return { text: e.textContent, cls: e.className }; }, id);
    const stored = async () => (await h.getCfg()) || {};
    const record = async (id, combo) => { await opt.click('#' + id); await opt.keyboard.press(combo); await sleep(250); };
    const reset = async () => { await opt.click('#reset'); await opt.click('#reset'); await sleep(300); };

    await check('ui', 'P05', 20, 'Defaults are not written into storage at install', async () => {
      const keys = Object.keys(await stored());
      return { ok: keys.length === 0, observed: 'storage holds ' + keys.length + ' keys right after install' + (keys.length ? ' (' + keys.slice(0, 5).join(', ') + ')' : '') };
    });

    await check('ui', 'P01', null, 'Options page loads cleanly with every control populated', async () => {
      const v = await opt.evaluate(() => ({
        key: document.getElementById('keyRec').textContent, mouse: document.getElementById('mouseRec').textContent,
        cap: document.getElementById('captureRec').textContent, gal: document.getElementById('galleryRec').textContent,
        folder: document.getElementById('folder').value, fmt: document.getElementById('captureFormat').value,
        preview: document.getElementById('preview').textContent, status: document.getElementById('status').textContent,
        saveButton: !!document.getElementById('save')
      }));
      return { ok: !errors.length && v.key === 'Alt + S' && v.preview === 'Downloads/Snaffle/example.com/sunset-over-the-bay.jpg' && !v.saveButton, observed: JSON.stringify(v) + (errors.length ? '; errors: ' + errors.join(' | ') : '; no console errors') };
    });

    await check('ui', 'P02', null, 'A recorded shortcut is saved the moment it is recorded', async () => {
      await record('keyRec', 'Control+Shift+KeyK');
      const shown = await text('keyRec');
      const key = (await stored()).key || {};
      const status = await text('status');
      await opt.reload(); await sleep(400);
      const afterReload = await text('keyRec');
      return { ok: key.code === 'KeyK' && key.ctrl === true && afterReload === 'Ctrl + Shift + K', observed: 'box shows "' + shown + '", storage has ' + (key.code || 'nothing') + ', status "' + status + '"; after reload the box reads "' + afterReload + '"' };
    });

    await check('ui', 'P03', null, 'An open page honours the new shortcut straight away', async () => {
      const page = await h.newPage(A.origin + '/pages/grab.html');
      await sleep(400);
      const marks = await mark(h);
      await h.hover(page, '#plain img');
      await page.keyboard.press('Control+Shift+KeyK');
      await sleep(1500);
      const got = (await h.apiDownloads()).filter((d) => !marks.ids.has(d.id)).length;
      await page.keyboard.press('Alt+KeyS');
      await sleep(1000);
      const old = (await h.apiDownloads()).filter((d) => !marks.ids.has(d.id)).length - got;
      await page.close();
      return { ok: got === 1 && old === 0, observed: 'new shortcut made ' + got + ' download; the old one made ' + old };
    });

    await check('ui', 'P06', 20, 'Only what was changed is stored, and Reset needs a second press', async () => {
      const saved = Object.keys(await stored()).sort().join(',');
      await opt.click('#reset');
      await sleep(200);
      const armed = await text('reset');
      const stillThere = Object.keys(await stored()).length;
      await opt.click('#reset');
      await sleep(300);
      const after = await h.getCfg();
      const label = await text('keyRec');
      return { ok: saved === 'key,v' && /again/i.test(armed) && stillThere > 0 && after === undefined && label === 'Alt + S', observed: 'storage held [' + saved + ']; first press says "' + armed + '" and keeps it; second press leaves ' + (after === undefined ? 'nothing stored' : JSON.stringify(after)) + ', box back to "' + label + '"' };
    });

    await check('ui', 'P07', null, 'The quality box is only shown when the format has a quality', async () => {
      const png = await opt.evaluate(() => document.getElementById('qualityRow').hidden);
      await opt.selectOption('#captureFormat', 'jpeg');
      await sleep(250);
      const jpeg = await opt.evaluate(() => document.getElementById('qualityRow').hidden);
      const fmt = (await stored()).captureFormat;
      await reset();
      return { ok: png === true && jpeg === false && fmt === 'jpeg', observed: 'hidden for PNG: ' + png + '; hidden for JPEG: ' + jpeg + '; stored format: ' + fmt };
    });

    await check('ui', 'P08', null, 'Shortcuts Chrome uses, keeps, or that clash are flagged as they are recorded', async () => {
      await record('keyRec', 'Alt+KeyD');
      const uses = await hint('keyHint');
      await record('keyRec', 'Control+KeyT');
      const keeps = await hint('keyHint');
      await record('keyRec', 'Alt+Shift+KeyS');   // the screenshot trigger's default
      const clash = await hint('keyHint');
      await record('keyRec', 'Alt+KeyG');
      const fine = await hint('keyHint');
      await reset();
      const ok = /address bar/.test(uses.text) && /warn/.test(uses.cls) && /never passes it/.test(keeps.text) && /bad/.test(keeps.cls) &&
                 /Another trigger/.test(clash.text) && /bad/.test(clash.cls) && fine.text === '';
      return { ok, observed: 'Alt+D: "' + uses.text + '" | Ctrl+T: "' + keeps.text + '" | same as screenshot: "' + clash.text + '" | Alt+G: "' + fine.text + '"' };
    });

    await check('ui', 'P09', null, 'The mouse recorder can be cancelled with Escape, and records a click with modifiers', async () => {
      await opt.click('#mouseRec');
      const armed = await text('mouseRec');
      await opt.keyboard.press('Escape');
      await sleep(150);
      const cancelled = await text('mouseRec');
      const untouched = (await stored()).mouse === undefined;

      await opt.click('#mouseRec');
      const box = await opt.locator('#mouseRec').boundingBox();
      await opt.keyboard.down('Shift');
      await opt.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
      await opt.keyboard.up('Shift');
      await sleep(300);
      const recorded = await text('mouseRec');
      const m = (await stored()).mouse || {};
      const rearmed = await opt.evaluate(() => document.getElementById('mouseRec').classList.contains('listening'));
      await reset();
      return { ok: /Click here/.test(armed) && cancelled === 'Alt + Middle click' && untouched && recorded === 'Shift + Right click' && m.button === 2 && m.shift === true && !rearmed, observed: 'armed: "' + armed + '"; after Escape: "' + cancelled + '" (nothing stored: ' + untouched + '); after Shift+right click: "' + recorded + '", stored button ' + m.button + '; left listening: ' + rearmed };
    });

    await check('ui', 'P10', null, 'Typing a folder updates the preview at once and saves after a pause', async () => {
      await opt.fill('#folder', 'Pictures/{host}');
      const preview = await text('preview');
      const early = (await stored()).folder;
      await sleep(700);
      const late = (await stored()).folder;
      const status = await text('status');
      await reset();
      return { ok: preview === 'Downloads/Pictures/example.com/sunset-over-the-bay.jpg' && late === 'Pictures/{host}' && status === 'All changes saved', observed: 'preview "' + preview + '"; stored straight away: ' + (early || 'not yet') + '; after a pause: ' + late + '; status "' + status + '"' };
    });
    await opt.close();

    await check('ui', 'P04', null, 'Popup loads cleanly, names its triggers, and lists what was saved', async () => {
      const pop = await h.context.newPage();
      const errs = [];
      pop.on('pageerror', (e) => errs.push(String(e)));
      await pop.goto('chrome-extension://' + h.extId + '/popup.html');
      await sleep(700);
      const v = await pop.evaluate(() => ({
        key: document.getElementById('keyLabel').textContent, mouse: document.getElementById('mouseLabel').textContent,
        cap: document.getElementById('captureLabel').textContent, gal: document.getElementById('galleryLabel').textContent,
        dest: document.getElementById('dest').textContent,
        recent: document.querySelectorAll('#recent .file').length
      }));
      await pop.close();
      const ok = !errs.length && v.key === 'Alt + S' && v.mouse === 'Alt + Middle click' && v.cap === 'Alt + Shift + S' && v.dest === 'Downloads/Snaffle/{host}' && v.recent >= 1;
      return { ok, observed: JSON.stringify(v) + (errs.length ? '; errors ' + errs.join('|') : '; no errors') };
    });

    await check('ui', 'P12', null, 'The popup\'s button opens the media list in the tab it was opened over', async () => {
      const page = await h.newPage(A.origin + '/pages/gallery.html');
      await page.waitForFunction(() => /ready/.test(document.title), null, { timeout: 8000 });
      const tabId = await h.probe.evaluate(async () => {
        const t = (await chrome.tabs.query({})).find((x) => /gallery\.html/.test(x.url || ''));
        return t ? t.id : null;
      });
      const pop = await h.context.newPage();
      await pop.goto('chrome-extension://' + h.extId + '/popup.html?tab=' + tabId);
      await sleep(800);
      const before = await pop.evaluate(() => ({ note: document.getElementById('note').hidden, disabled: document.getElementById('gallery').disabled }));
      await pop.click('#gallery');
      await sleep(2200);
      const open = await page.evaluate(() => !!document.getElementById('__snaffle_gallery'));
      await pop.close(); await page.close();
      return { ok: before.note && !before.disabled && open, observed: 'no warning shown: ' + before.note + '; button enabled: ' + !before.disabled + '; list opened in the page: ' + open };
    });

    // Opened as a tab, the popup's "current page" is an extension page: one
    // of the places Snaffle cannot run.
    await check('ui', 'P11', null, 'On a page it cannot work on, the popup says so and disables its page actions', async () => {
      const pop = await h.context.newPage();
      await pop.goto('chrome-extension://' + h.extId + '/popup.html');
      await sleep(900);
      const v = await pop.evaluate(() => ({
        note: document.getElementById('note').hidden ? '' : document.getElementById('note').textContent,
        capture: document.getElementById('capture').disabled, gallery: document.getElementById('gallery').disabled
      }));
      await pop.close();
      return { ok: /cannot run on this page/i.test(v.note) && v.capture && v.gallery, observed: 'note "' + v.note + '"; buttons disabled: ' + v.capture + ', ' + v.gallery };
    });
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
