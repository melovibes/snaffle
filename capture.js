/* Snaffle - full-page screenshot. Scrolls the page, captures each viewport
   through the service worker, and stitches the shots onto one canvas. */
(() => {
  const api = window.__SNAFFLE;
  if (!api) return;

  // Only the top frame drives a capture; captureVisibleTab shoots the whole tab.
  if (window.top !== window) return;

  // Chrome will not create a canvas larger than this. A tall page is scaled
  // down to fit rather than failing outright.
  const MAX_SIDE = 32000;
  const MAX_AREA = 240e6;

  // tabs.captureVisibleTab is quota-limited to a couple of calls per second.
  const SHOT_INTERVAL = 420;
  const SETTLE = 160;

  let running = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  function pageSize() {
    const de = document.documentElement;
    const b = document.body;
    const h = Math.max(de.scrollHeight, de.offsetHeight, de.clientHeight,
                       b ? b.scrollHeight : 0, b ? b.offsetHeight : 0);
    const w = Math.max(de.scrollWidth, de.offsetWidth, de.clientWidth,
                       b ? b.scrollWidth : 0, b ? b.offsetWidth : 0);
    return { w, h };
  }

  // Fixed elements would reappear in every shot; sticky ones would slide down
  // the page. Hiding fixed is free (no reflow); sticky is pinned back into its
  // flow position so it does not leave a gap where its box belongs.
  function neutralizeOverlays() {
    const touched = [];
    let scanned = 0;
    for (const el of document.querySelectorAll('*')) {
      if (++scanned > 6000) break;
      let pos;
      try { pos = getComputedStyle(el).position; } catch (_) { continue; }
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      if (el.id === '__snaffle_ui') continue;
      touched.push([el, el.style.visibility, el.style.position]);
      if (pos === 'fixed') el.style.setProperty('visibility', 'hidden', 'important');
      else el.style.setProperty('position', 'static', 'important');
    }
    return () => {
      for (const [el, vis, position] of touched) {
        el.style.visibility = vis;
        el.style.position = position;
      }
    };
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('could not decode a captured frame'));
      img.src = dataUrl;
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode the image'))), type, quality);
    });
  }

  async function capturePage() {
    if (running) return;
    const cfg = api.cfg;
    running = true;

    const de = document.documentElement;
    const body = document.body;
    const host = document.getElementById('__snaffle_ui');

    const prev = {
      x: window.scrollX,
      y: window.scrollY,
      behavior: de.style.scrollBehavior,
      htmlOverflow: de.style.overflow,
      bodyOverflow: body ? body.style.overflow : ''
    };
    let restoreOverlays = () => {};

    try {
      // Smooth scrolling makes every shot land mid-animation.
      de.style.setProperty('scroll-behavior', 'auto', 'important');
      if (host) host.style.display = 'none';

      const vw = de.clientWidth;
      const vh = de.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      const { w: fullW, h: fullH } = pageSize();
      const totalW = cfg.captureFullWidth ? fullW : vw;

      if (!vw || !vh) throw new Error('the page has no measurable viewport');

      const scale = Math.min(dpr, MAX_SIDE / totalW, MAX_SIDE / fullH,
                             Math.sqrt(MAX_AREA / (totalW * fullH)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(totalW * scale));
      canvas.height = Math.max(1, Math.round(fullH * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('could not get a 2D context');

      const xs = [];
      for (let x = 0; x < totalW; x += vw) xs.push(x);
      const ys = [];
      for (let y = 0; y < fullH; y += vh) ys.push(y);
      const total = xs.length * ys.length;

      let shot = 0;
      let first = true;

      for (const y of ys) {
        for (const x of xs) {
          window.scrollTo(x, y);
          await nextFrame();
          // Lazy images load on scroll; give them a beat before shooting.
          await sleep(first ? SETTLE + 200 : SETTLE);

          if (first) {
            // The first shot keeps the real header; later ones must not repeat it.
            if (cfg.captureHideFixed) restoreOverlays = neutralizeOverlays();
            first = false;
          }

          const res = await api.ask({ type: 'captureViewport' });
          if (!res || !res.ok) throw new Error(res && res.error ? res.error : 'capture was refused');

          const img = await loadImage(res.dataUrl);
          // scrollTo clamps at the bottom, so draw where the page actually is.
          const atX = window.scrollX;
          const atY = window.scrollY;
          ctx.drawImage(
            img, 0, 0, img.width, img.height,
            Math.round(atX * scale), Math.round(atY * scale),
            Math.round((img.width / dpr) * scale), Math.round((img.height / dpr) * scale)
          );

          shot++;
          api.ask({ type: 'badge', text: shot + '/' + total });
          if (shot < total) await sleep(SHOT_INTERVAL);
        }
      }

      api.ask({ type: 'badge', text: '' });

      const fmt = (cfg.captureFormat || 'png').toLowerCase();
      const quality = Math.min(100, Math.max(10, cfg.captureQuality || 92)) / 100;
      const stem = (document.title || location.hostname || 'page').slice(0, 80);
      const tok = {
        name: stem,
        ext: fmt === 'pdf' ? 'pdf' : (fmt === 'jpeg' ? 'jpg' : 'png'),
        kind: 'screenshot',
        host: api.hostToken(),
        title: document.title || '',
        alt: ''
      };

      let blob;
      if (fmt === 'pdf') {
        const jpeg = await canvasToBlob(canvas, 'image/jpeg', quality);
        blob = await pdfFromJpeg(new Uint8Array(await jpeg.arrayBuffer()), canvas.width, canvas.height);
      } else if (fmt === 'jpeg') {
        blob = await canvasToBlob(canvas, 'image/jpeg', quality);
      } else {
        blob = await canvasToBlob(canvas, 'image/png');
      }

      const named = await api.ask({ type: 'buildName', tokens: tok });
      const path = (named && named.path) || tok.name + '.' + tok.ext;

      // Restore the view before the download bar shifts things around.
      restoreOverlays();
      restoreOverlays = () => {};
      window.scrollTo(prev.x, prev.y);
      if (host) host.style.display = '';

      const saved = await api.saveBlob(blob, path);
      const scaled = scale < dpr ? ', scaled to fit the canvas limit' : '';
      api.toast('Saved ' + api.savedText(saved) + ' (' + canvas.width + ' x ' + canvas.height + scaled + ')', 'ok');
    } catch (e) {
      api.ask({ type: 'badge', text: '' });
      if (host) host.style.display = '';
      api.toast('Full-page capture failed: ' + ((e && e.message) || e), 'err');
    } finally {
      restoreOverlays();
      de.style.scrollBehavior = prev.behavior;
      de.style.overflow = prev.htmlOverflow;
      if (body) body.style.overflow = prev.bodyOverflow;
      window.scrollTo(prev.x, prev.y);
      if (host) host.style.display = '';
      running = false;
    }
  }

  /* ------------------------------------------------------------------ PDF */

  // One page, one DCTDecode image. Byte offsets in the xref table have to be
  // exact, so the file is assembled from byte chunks with a running offset.
  async function pdfFromJpeg(jpeg, pxW, pxH) {
    const enc = new TextEncoder();
    const MAX_PT = 14400;                   // the largest page side a PDF may use
    let ptW = 612;                          // letter width
    let ptH = (pxH / pxW) * ptW;
    if (ptH > MAX_PT) { ptH = MAX_PT; ptW = (pxW / pxH) * ptH; }
    const w = ptW.toFixed(2);
    const h = ptH.toFixed(2);

    const content = enc.encode('q ' + w + ' 0 0 ' + h + ' 0 0 cm /Im0 Do Q\n');

    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + w + ' ' + h + ']' +
        ' /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>',
      { dict: '<< /Type /XObject /Subtype /Image /Width ' + pxW + ' /Height ' + pxH +
              ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpeg.length + ' >>',
        stream: jpeg },
      { dict: '<< /Length ' + content.length + ' >>', stream: content }
    ];

    const chunks = [];
    let offset = 0;
    const push = (bytes) => { chunks.push(bytes); offset += bytes.length; };
    const pushText = (s) => push(enc.encode(s));

    pushText('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

    const offsets = [];
    objects.forEach((obj, i) => {
      offsets.push(offset);
      const n = i + 1;
      if (typeof obj === 'string') {
        pushText(n + ' 0 obj\n' + obj + '\nendobj\n');
      } else {
        pushText(n + ' 0 obj\n' + obj.dict + '\nstream\n');
        push(obj.stream);
        pushText('\nendstream\nendobj\n');
      }
    });

    const xref = offset;
    let table = 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
    for (const off of offsets) table += String(off).padStart(10, '0') + ' 00000 n \n';
    table += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
    pushText(table);

    return new Blob(chunks, { type: 'application/pdf' });
  }

  api.capture = capturePage;
})();
