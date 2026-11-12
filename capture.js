/* Snaffle - full-page screenshot. Scrolls the page, captures each screen
   through the service worker, and stitches the shots together. Loaded into a
   tab by the service worker when it is asked for. */
(() => {
  const api = window.__SNAFFLE;
  // Loaded into the tab each time it is asked for; only the first copy stays.
  if (!api || api.capture) return;

  // Only the top frame drives a capture; a shot is always of the whole tab.
  if (window.top !== window) return;

  const Pdf = SnafflePdf;

  // tabs.captureVisibleTab is quota-limited to a couple of calls per second.
  const SHOT_INTERVAL = 420;
  const SETTLE = 160;

  // One image is at most this tall, in device pixels. A canvas much larger
  // than this can take a gigabyte of memory or fail to be created at all, so a
  // taller page is saved as several images rather than one huge or shrunken one.
  const PART_PX = 16000;
  const MAX_WIDTH_PX = 16000;
  // ...and at most this many pixels in all (about 256 MB while it is being
  // drawn), so a page that is very wide as well as tall gets shorter pieces.
  const PART_AREA = 64 * 1000 * 1000;

  // A page that keeps growing as it is scrolled has to stop somewhere.
  const MAX_ROWS = 100;

  const CHUNK = 6 * 1024 * 1024;
  const TOAST = 'capture';
  const OWN_UI = ['__snaffle_ui', '__snaffle_gallery'];

  class Cancelled extends Error {}

  let job = null;   // the capture in progress: { cancelled }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Two animation frames, so a change has been painted. A hidden tab gets no
  // frames at all, so this never waits longer than a moment.
  const painted = () => Promise.race([
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    sleep(300)
  ]);

  function pageSize() {
    const de = document.documentElement;
    const b = document.body;
    const h = Math.max(de.scrollHeight, de.offsetHeight, de.clientHeight,
                       b ? b.scrollHeight : 0, b ? b.offsetHeight : 0);
    const w = Math.max(de.scrollWidth, de.offsetWidth, de.clientWidth,
                       b ? b.scrollWidth : 0, b ? b.offsetWidth : 0);
    return { w, h };
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('a captured screen could not be read'));
      img.src = dataUrl;
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('the image could not be encoded'))), type, quality);
    });
  }

  const cancelAction = [{ label: 'Cancel', send: { type: 'relayTop', action: 'captureCancel' }, close: false }];

  function progress(text, pct) {
    api.toast(text, 'busy', { id: TOAST, sticky: true, progress: pct, actions: cancelAction });
  }

  /* ---------------------------------------------------- taking one shot */

  // Images still loading where the page has just been scrolled to get a
  // moment to arrive, so lazy-loaded pictures are not captured as blanks.
  async function settle(first) {
    await painted();
    const vh = document.documentElement.clientHeight;
    const end = Date.now() + 1200;
    while (Date.now() < end) {
      let waiting = false;
      for (const img of document.images) {
        if (img.complete) continue;
        const r = img.getBoundingClientRect();
        if (r.bottom > 0 && r.top < vh && r.width > 0) { waiting = true; break; }
      }
      if (!waiting) break;
      await sleep(80);
    }
    await sleep(first ? SETTLE + 200 : SETTLE);
  }

  // The tab has to be the one in front, or the shot would be of whichever tab
  // is. If it is not, wait for the user to come back instead of guessing.
  async function waitForTab() {
    api.toast('Paused. Come back to this tab to finish the screenshot.', 'warn', { id: TOAST, sticky: true, actions: cancelAction });
    if (!job.pausedAt) job.pausedAt = Date.now();
    const end = job.pausedAt + 3 * 60 * 1000;
    for (;;) {
      if (job.cancelled) throw new Cancelled();
      if (Date.now() > end) throw new Error('the tab was left for too long');
      await sleep(400);
      if (document.visibilityState === 'visible') return;
    }
  }

  // `place` scrolls to where the shot belongs and waits for it to settle. It
  // is run again if the shot had to wait for the tab, since anything may have
  // moved in the meantime.
  async function shotAt(place) {
    for (;;) {
      if (job.cancelled) throw new Cancelled();
      await place();
      if (job.cancelled) throw new Cancelled();

      // Our own messages and panels must not be in the picture.
      const ours = OWN_UI.map((id) => document.getElementById(id)).filter(Boolean);
      const was = ours.map((el) => el.style.visibility);
      ours.forEach((el) => el.style.setProperty('visibility', 'hidden', 'important'));
      await painted();
      let res;
      try {
        res = await api.ask({ type: 'captureViewport' });
      } finally {
        ours.forEach((el, i) => { el.style.visibility = was[i]; });
      }

      if (res && res.ok) { job.pausedAt = 0; return loadImage(res.dataUrl); }
      if (res && res.inactive) { await waitForTab(); continue; }
      throw new Error((res && res.error) || 'the browser refused the capture');
    }
  }

  /* -------------------------------------------- fixed and sticky elements */

  // A fixed header would otherwise be repeated on every screen of the image,
  // and a fixed footer baked into the middle of it. Each fixed element is
  // classed by where it sits: things at the top are kept for the first screen
  // only, things at the bottom for the last screen only, and anything that
  // fills the height (a sidebar) is left alone. Hiding uses `visibility`, which
  // does not reflow the page. Sticky elements are put back in their place in
  // the flow, where they belong once.
  function makePins(enabled) {
    const fixed = new Map();    // el -> { vis, prio, anchor }
    const sticky = new Map();   // el -> { pos, prio }
    const viewH = () => document.documentElement.clientHeight;

    function consider(el) {
      if (!el || el.nodeType !== 1 || fixed.has(el) || sticky.has(el) || OWN_UI.includes(el.id)) return;
      let pos;
      try { pos = getComputedStyle(el).position; } catch (_) { return; }
      if (pos === 'sticky') {
        sticky.set(el, { pos: el.style.position, prio: el.style.getPropertyPriority('position') });
        el.style.setProperty('position', 'static', 'important');
      } else if (pos === 'fixed') {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const anchor = r.height >= viewH() * 0.6 ? 'full' : (r.top + r.height / 2 < viewH() / 2 ? 'top' : 'bottom');
        fixed.set(el, { vis: el.style.visibility, prio: el.style.getPropertyPriority('visibility'), anchor });
      }
    }

    return {
      // Once, before the first shot.
      scanAll() {
        if (!enabled) return;
        let n = 0;
        for (const el of document.querySelectorAll('*')) { if (++n > 6000) break; consider(el); }
      },
      // Before every shot: a header that only becomes fixed once the page has
      // been scrolled is not there to find at the start. Sampling what is
      // under a grid of points is far cheaper than walking the document again.
      scanView() {
        if (!enabled) return;
        const de = document.documentElement;
        const seen = new Set();
        for (let i = 0; i < 5; i++) {
          for (let j = 0; j < 5; j++) {
            const x = Math.min(de.clientWidth - 1, Math.round((de.clientWidth * (i + 0.5)) / 5));
            const y = j === 0 ? 4 : j === 4 ? de.clientHeight - 5 : Math.round((de.clientHeight * (j + 0.5)) / 5);
            let stack = [];
            try { stack = document.elementsFromPoint(x, y); } catch (_) {}
            for (const top of stack) {
              for (const el of api.ancestors(top)) {
                if (seen.has(el)) break;
                seen.add(el);
                consider(el);
              }
            }
          }
        }
      },
      apply(firstScreen, lastScreen) {
        for (const [el, f] of fixed) {
          const show = f.anchor === 'full' || (f.anchor === 'top' && firstScreen) || (f.anchor === 'bottom' && lastScreen);
          if (show) el.style.setProperty('visibility', f.vis, f.prio);
          else el.style.setProperty('visibility', 'hidden', 'important');
        }
      },
      restore() {
        for (const [el, f] of fixed) el.style.setProperty('visibility', f.vis, f.prio);
        for (const [el, s] of sticky) el.style.setProperty('position', s.pos, s.prio);
      }
    };
  }

  /* --------------------------------------------------------- the surface */

  // What the shots are drawn onto. It is a stack of canvases, each at most
  // PART_PX tall, addressed in page (CSS) pixels. A part is encoded and its
  // canvas released as soon as nothing more can be drawn on it, so memory in
  // use stays at a part or two however long the page is.
  function makeSurface(widthCss, scale, background, encode) {
    const widthPx = Math.max(1, Math.ceil(widthCss * scale));
    const partPx = Math.max(2000, Math.min(PART_PX, Math.floor(PART_AREA / widthPx)));
    const partCss = Math.max(1, Math.floor(partPx / scale));
    const parts = [];   // { canvas, ctx, blob, width, height }

    function make(heightPx) {
      const canvas = document.createElement('canvas');
      canvas.width = widthPx;
      canvas.height = Math.max(1, heightPx);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('the browser could not make an image this large');
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return { canvas, ctx, blob: null, width: 0, height: 0 };
    }

    function resize(p, heightPx) {
      const next = make(heightPx);
      next.ctx.drawImage(p.canvas, 0, 0);
      p.canvas.width = 0;
      p.canvas = next.canvas;
      p.ctx = next.ctx;
    }

    function part(k, needCss) {
      const needPx = Math.min(partPx, Math.ceil(needCss * scale));
      if (!parts[k]) parts[k] = make(needPx);
      else if (!parts[k].blob && parts[k].canvas.height < needPx) resize(parts[k], needPx);
      return parts[k];
    }

    async function seal(k, heightCss) {
      const p = parts[k];
      if (p.blob) return;
      const heightPx = Math.max(1, Math.min(partPx, Math.ceil(heightCss * scale)));
      if (p.canvas.height !== heightPx) resize(p, heightPx);
      p.width = p.canvas.width;
      p.height = p.canvas.height;
      p.blob = await encode(p.canvas);
      p.canvas.width = 0;       // hand the memory back now, not at garbage collection
      p.canvas = null;
      p.ctx = null;
    }

    return {
      scale,
      // Source rectangle in the shot's own pixels, destination in page pixels.
      draw(img, sx, sy, sw, sh, dx, dy, dw, dh) {
        const first = Math.floor(dy / partCss);
        const last = Math.floor((dy + dh - 0.001) / partCss);
        for (let k = first; k <= last; k++) {
          const top = k * partCss;
          const p = part(k, Math.min(partCss, dy + dh - top));
          if (p.blob) continue;
          // Floor the position and ceil the size: a one-pixel overlap between
          // screens is invisible, a one-pixel gap is a line across the image.
          p.ctx.drawImage(img, sx, sy, sw, sh,
            Math.floor(dx * scale), Math.floor((dy - top) * scale), Math.ceil(dw * scale), Math.ceil(dh * scale));
        }
      },
      // Everything above `cssY` is finished.
      async sealAbove(cssY) {
        const done = Math.floor(cssY / partCss);
        for (let k = 0; k < done; k++) if (parts[k] && !parts[k].blob) await seal(k, partCss);
      },
      async finish(totalCss) {
        const count = Math.max(1, Math.ceil(totalCss / partCss));
        for (let k = 0; k < count; k++) {
          if (!parts[k]) parts[k] = make(1);
          await seal(k, Math.min(partCss, totalCss - k * partCss));
        }
        return parts.slice(0, count).map((p) => ({ blob: p.blob, width: p.width, height: p.height }));
      },
      discard() {
        for (const p of parts) if (p && p.canvas) p.canvas.width = 0;
      }
    };
  }

  /* ---------------------------------------------- where the page scrolls */

  // Many web apps never scroll the page itself: the document is exactly one
  // screen tall and the content scrolls inside a box. Scrolling the window
  // then captures one screen and nothing more. Find that box.
  function innerScroller() {
    const de = document.documentElement;
    const vw = de.clientWidth, vh = de.clientHeight;

    // Does the window move at all? If it does, the page scrolls the ordinary
    // way. If it does not, whatever scrolls is a box inside it - which can be
    // the body itself, so only the root element is ruled out below.
    const y = window.scrollY;
    window.scrollTo(window.scrollX, y + 2);
    const moves = window.scrollY !== y || y > 0;
    window.scrollTo(window.scrollX, y);
    if (moves) return null;

    let best = null, bestArea = 0;
    for (const el of api.ancestors(document.elementFromPoint(vw / 2, vh / 2))) {
      if (el === de) continue;
      let overflow = '';
      try { overflow = getComputedStyle(el).overflowY; } catch (_) { continue; }
      if (!/auto|scroll|overlay/.test(overflow)) continue;
      if (el.scrollHeight - el.clientHeight < 40) continue;
      if (el.clientHeight < vh * 0.4 || el.clientWidth < vw * 0.4) continue;
      const area = el.clientWidth * el.clientHeight;
      if (area > bestArea) { best = el; bestArea = area; }
    }
    return best;
  }

  /* ------------------------------------------------------------ capturing */

  async function capturePage() {
    if (job) return;
    job = { cancelled: false };
    const cfg = api.cfg;
    const de = document.documentElement;
    const review = cfg.captureThen !== 'save';
    const format = (cfg.captureFormat || 'png').toLowerCase();
    const quality = Math.min(100, Math.max(10, cfg.captureQuality || 92)) / 100;

    const start = { x: window.scrollX, y: window.scrollY };
    const pins = makePins(!!cfg.captureHideFixed);
    let scroller = null, scrollerTop = 0;
    let surface = null;

    // Animations and transitions would be caught half way, and smooth
    // scrolling would leave every shot mid-glide.
    const calm = document.createElement('style');
    calm.textContent = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;' +
      'transition-duration:0s!important;transition-delay:0s!important;scroll-behavior:auto!important}';

    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      job.cancelled = true;
    };
    window.addEventListener('keydown', onKey, true);

    let tidy = false;
    const cleanUp = () => {
      if (tidy) return;
      tidy = true;
      window.removeEventListener('keydown', onKey, true);
      pins.restore();
      calm.remove();
      if (scroller) scroller.scrollTop = scrollerTop;
      window.scrollTo(start.x, start.y);
    };

    try {
      (document.head || de).appendChild(calm);
      progress('Capturing the page...', 0);
      pins.scanAll();

      scroller = innerScroller();
      if (scroller) scrollerTop = scroller.scrollTop;

      const vw = de.clientWidth, vh = de.clientHeight;
      if (!vw || !vh) throw new Error('the page has no visible area');

      // The shot is measured rather than assumed: its width over the window's
      // width is the real pixel ratio, whatever the browser reports.
      let ratio = 0;
      let scaledDown = false;
      const begin = (img, widthCss) => {
        if (surface) return;
        ratio = img.width / window.innerWidth;
        let scale = ratio;
        if (widthCss * scale > MAX_WIDTH_PX) { scale = MAX_WIDTH_PX / widthCss; scaledDown = true; }
        const bg = getComputedStyle(document.body || de).backgroundColor;
        const encode = (canvas) => (review || format === 'png'
          ? canvasToBlob(canvas, 'image/png')
          : canvasToBlob(canvas, 'image/jpeg', quality));
        surface = makeSurface(widthCss, scale, /rgba\(0, 0, 0, 0\)|transparent/.test(bg) ? '#ffffff' : bg, encode);
      };

      let totalH = 0;
      let truncated = false;
      let shots = 0;

      if (!scroller) {
        /* The ordinary case: the window scrolls. */
        const totalW = cfg.captureFullWidth ? Math.max(vw, pageSize().w) : vw;
        const xs = [];
        for (let x = 0; x < totalW; x += vw) xs.push(x);

        let y = 0, rows = 0, lastAt = -1;
        for (;;) {
          let at = 0;
          for (const x of xs) {
            const img = await shotAt(async () => {
              window.scrollTo(x, y);
              await settle(rows === 0);
              pins.scanView();
              pins.apply(window.scrollY <= 0, window.scrollY + vh >= pageSize().h - 1);
            });
            begin(img, totalW);
            // scrollTo clamps at the edges, so draw where the page really is.
            at = window.scrollY;
            surface.draw(img, 0, 0, vw * ratio, vh * ratio, window.scrollX, at, vw, vh);
            shots++;
            const screens = Math.max(shots, Math.ceil(pageSize().h / vh) * xs.length);
            progress('Capturing the page: screen ' + shots + ' of ' + screens, Math.round((shots / screens) * 100));
            await sleep(SHOT_INTERVAL);
          }
          rows++;
          totalH = at + vh;
          await surface.sealAbove(at - vh);
          if (totalH >= pageSize().h - 1) break;       // the bottom
          if (at <= lastAt) break;                     // it will not scroll any further
          if (rows >= MAX_ROWS) { truncated = true; break; }
          lastAt = at;
          y = totalH;
        }
      } else {
        /* The page scrolls inside a box. Capture the screen once, then scroll
           the box and add only its contents below, and finish with whatever
           sits under the box moved down to follow them. */
        const box = scroller.getBoundingClientRect();
        const left = box.left + scroller.clientLeft;
        const top = box.top + scroller.clientTop;
        const cw = scroller.clientWidth, ch = scroller.clientHeight;
        const boxBottom = top + ch;

        let pos = 0, rows = 0, reached = 0, lastAt = -1;
        let under = null;
        for (;;) {
          const img = await shotAt(async () => {
            scroller.scrollTop = pos;
            await settle(rows === 0);
          });
          begin(img, vw);
          const at = scroller.scrollTop;
          if (rows === 0) {
            surface.draw(img, 0, 0, vw * ratio, boxBottom * ratio, 0, 0, vw, boxBottom);
            if (vh - boxBottom >= 1) {
              under = document.createElement('canvas');
              under.width = Math.ceil(vw * ratio);
              under.height = Math.ceil((vh - boxBottom) * ratio);
              under.getContext('2d').drawImage(img, 0, boxBottom * ratio, vw * ratio, (vh - boxBottom) * ratio, 0, 0, under.width, under.height);
            }
          } else {
            surface.draw(img, left * ratio, top * ratio, cw * ratio, ch * ratio, left, top + at, cw, ch);
          }
          shots++;
          rows++;
          reached = at + ch;
          const screens = Math.max(shots, Math.ceil(scroller.scrollHeight / ch));
          progress('Capturing the page: screen ' + shots + ' of ' + screens, Math.round((shots / screens) * 100));
          await surface.sealAbove(top + at - ch);
          await sleep(SHOT_INTERVAL);
          if (reached >= scroller.scrollHeight - 1) break;
          if (at <= lastAt) break;
          if (rows >= MAX_ROWS) { truncated = true; break; }
          lastAt = at;
          pos = reached;
        }
        const extra = Math.max(0, reached - ch);
        if (under) surface.draw(under, 0, 0, under.width, under.height, 0, boxBottom + extra, vw, vh - boxBottom);
        totalH = vh + extra;
      }

      if (job.cancelled) throw new Cancelled();
      progress('Putting the screenshot together...', 100);
      const parts = await surface.finish(totalH);
      cleanUp();

      const notes =
        (parts.length > 1 ? ' The page was too large for one image, so it is in ' + parts.length + ' pieces.' : '') +
        (scaledDown ? ' It was scaled down to fit.' : '') +
        (truncated ? ' It stops after ' + MAX_ROWS + ' screens because the page kept growing.' : '');
      const info = {
        name: (document.title || location.hostname || 'page').slice(0, 80),
        host: api.hostToken(), title: document.title || '', notes
      };

      if (review && await handOver(parts, info)) {
        api.dismissToast(TOAST);
        return;
      }
      await saveParts(parts, info, review ? 'png' : format);
    } catch (e) {
      if (surface) surface.discard();
      cleanUp();
      if (e instanceof Cancelled) api.toast('Screenshot cancelled.', 'warn', { id: TOAST });
      else api.toast('The screenshot could not be taken: ' + ((e && e.message) || e), 'err', { id: TOAST });
    } finally {
      job = null;
    }
  }

  /* -------------------------------------------------------------- output */

  // Open the results page and pass it the images, so the user can look at the
  // screenshot before deciding whether and how to save it.
  async function handOver(parts, info) {
    const open = await api.ask({ type: 'openResult' });
    if (!open || !open.ok) return false;
    for (let i = 0; i < parts.length; i++) {
      const blob = parts[i].blob;
      for (let at = 0; at < blob.size; at += CHUNK) {
        const r = await api.ask({ type: 'resultPart', id: open.id, part: i, b64: await api.toBase64(blob.slice(at, at + CHUNK)) });
        if (!r || !r.ok) return false;
      }
    }
    const done = await api.ask({
      type: 'resultDone', id: open.id, info,
      parts: parts.map((p) => ({ width: p.width, height: p.height }))
    });
    return !!(done && done.ok);
  }

  // Save straight away, in the configured format.
  async function saveParts(parts, info, format) {
    const ext = format === 'pdf' ? 'pdf' : format === 'jpeg' ? 'jpg' : 'png';
    let files = parts.map((p) => p.blob);
    if (format === 'pdf') {
      const pages = [];
      for (const p of parts) pages.push({ jpeg: new Uint8Array(await p.blob.arrayBuffer()), width: p.width, height: p.height });
      files = [new Blob(Pdf.build(pages), { type: 'application/pdf' })];
    }

    let first = null;
    for (let i = 0; i < files.length; i++) {
      const tok = {
        name: info.name + (files.length > 1 ? ' (' + (i + 1) + ' of ' + files.length + ')' : ''),
        ext, kind: 'screenshot', host: info.host, title: info.title, alt: ''
      };
      const named = await api.ask({ type: 'buildName', tokens: tok });
      const saved = await api.saveBlob(files[i], (named && named.path) || tok.name + '.' + ext);
      if (saved.cancelled) { api.dismissToast(TOAST); return; }
      if (!first) first = saved;
    }

    const size = parts.length === 1 ? ' (' + parts[0].width + ' x ' + parts[0].height + ')' : '';
    const what = files.length > 1 ? 'Saved ' + files.length + ' images, starting with ' : 'Saved ';
    api.toast(what + api.savedText(first) + size + (info.notes ? '.' + info.notes : ''), info.notes ? 'warn' : 'ok',
      { id: TOAST, actions: api.showAction(first.id) });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'captureCancel' && job) job.cancelled = true;
    return false;
  });

  api.capture = capturePage;
})();
