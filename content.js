/* Snaffle - content script. Runs in every frame. */
(() => {
  if (window.__snaffleLoaded) return;
  window.__snaffleLoaded = true;

  const DEFAULTS = {
    enabled: true,
    key: { enabled: true, code: 'KeyS', label: 'Alt + S', ctrl: false, alt: true, shift: false, meta: false },
    mouse: { enabled: true, button: 1, label: 'Alt + Middle click', ctrl: false, alt: true, shift: false, meta: false },
    captureKey: { enabled: true, code: 'KeyS', label: 'Alt + Shift + S', ctrl: false, alt: true, shift: true, meta: false },
    galleryKey: { enabled: true, code: 'KeyI', label: 'Alt + Shift + I', ctrl: false, alt: true, shift: true, meta: false },
    folder: 'Snaffle/{host}',
    template: '{name}.{ext}',
    captureFormat: 'png',
    captureQuality: 92,
    captureHideFixed: true,
    captureFullWidth: true,
    galleryMinSize: 80,
    upgrade: true,
    preferLink: true,
    streamAssembly: true,
    posterFallback: true,
    saveAs: false,
    toast: true,
    outline: false,
    contextMenu: true
  };

  let cfg = JSON.parse(JSON.stringify(DEFAULTS));

  const merge = (base, over) => {
    const out = Object.assign({}, base);
    for (const k of Object.keys(over || {})) {
      const v = over[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object') out[k] = merge(base[k], v);
      else if (v !== undefined) out[k] = v;
    }
    return out;
  };

  chrome.storage.sync.get('cfg', (s) => { if (s && s.cfg) cfg = merge(DEFAULTS, s.cfg); });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'sync' && ch.cfg) cfg = merge(DEFAULTS, ch.cfg.newValue || {});
  });

  /* ---------------------------------------------------------------- hover */

  let hoverTarget = null;
  let outlineQueued = false;
  const cursor = { x: 0, y: 0 };
  const capture = { capture: true, passive: true };

  // Only the target is kept. Resolving the ancestor chain is deferred to the
  // moment of a grab, so hovering costs nothing on a busy page.
  document.addEventListener('mousemove', (e) => {
    cursor.x = e.clientX; cursor.y = e.clientY;
    if (e.target !== hoverTarget) { hoverTarget = e.target; queueOutline(); }
  }, capture);

  document.addEventListener('mouseover', (e) => {
    hoverTarget = e.target;
    queueOutline();
  }, capture);

  function queueOutline() {
    if (!cfg.enabled || !cfg.outline || outlineQueued) return;
    outlineQueued = true;
    requestAnimationFrame(() => { outlineQueued = false; paintOutline(); });
  }

  // The same nodes composedPath() would give - a ShadowRoot has no parentNode,
  // so stepping to its host crosses the boundary.
  function ancestors(node) {
    const out = [];
    let n = node;
    while (n && out.length < 80) {
      if (n.nodeType === 1) out.push(n);
      n = n.parentNode || n.host || null;
    }
    return out;
  }

  function elementStack(start) {
    const els = [];
    const seen = new Set();
    const add = (n) => { if (n && n.nodeType === 1 && !seen.has(n)) { seen.add(n); els.push(n); } };
    for (const n of ancestors(start || hoverTarget)) add(n);
    // Overlay-covered media (X, Instagram, lightboxes) sits *under* the topmost element.
    try { for (const n of document.elementsFromPoint(cursor.x, cursor.y)) add(n); } catch (_) {}
    return els;
  }

  /* --------------------------------------------------------- url helpers */

  const MEDIA_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|ico|tiff?|svg|mp4|webm|mov|m4v|mkv|ogv|ogg|mp3|m4a|wav|flac)(?=$|[?#])/i;
  const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|ico|tiff?|svg)(?=$|[?#])/i;
  const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv|ogv)(?=$|[?#])/i;

  const abs = (u, el) => {
    if (!u) return '';
    u = String(u).trim();
    if (!u || u === 'about:blank' || u.startsWith('javascript:')) return '';
    if (/^(data|blob):/.test(u)) return u;
    try { return new URL(u, (el && el.baseURI) || document.baseURI).href; } catch (_) { return ''; }
  };

  function parseSrcset(input) {
    const out = [];
    let i = 0; const n = input.length;
    while (i < n) {
      while (i < n && /[\s,]/.test(input[i])) i++;
      if (i >= n) break;
      let start = i;
      while (i < n && !/\s/.test(input[i])) i++;
      let url = input.slice(start, i);
      let hadComma = false;
      while (url.endsWith(',')) { url = url.slice(0, -1); hadComma = true; }
      let desc = '';
      if (!hadComma) {
        while (i < n && /\s/.test(input[i])) i++;
        start = i;
        while (i < n && input[i] !== ',') i++;
        desc = input.slice(start, i).trim();
        if (input[i] === ',') i++;
      }
      if (url) out.push({ url, desc });
    }
    return out;
  }

  /* ------------------------------------------------- full-res "upgrades" */

  function upgrade(url) {
    if (!cfg.upgrade || !/^https?:/i.test(url)) return url;
    let u;
    try { u = new URL(url); } catch (_) { return url; }
    const host = u.hostname;

    // Image proxies that embed the original URL (Substack, weserv, Cloudinary fetch, wp.com ...)
    const embedded = /https?%3A%2F%2F[^\s"'&]+/i.exec(u.href);
    if (embedded) {
      try {
        const inner = decodeURIComponent(embedded[0]);
        if (/^https?:\/\/.+\..+/.test(inner)) return inner;
      } catch (_) {}
    }
    const proxied = u.searchParams.get('url') || u.searchParams.get('src') || u.searchParams.get('image');
    if (proxied && /^https?:\/\//i.test(proxied)) return proxied;

    // X / Twitter
    if (/(^|\.)twimg\.com$/.test(host)) {
      if (u.searchParams.has('name')) { u.searchParams.set('name', 'orig'); return u.href; }
      return u.href.replace(/:(thumb|small|medium|large)$/, ':orig');
    }
    // Reddit previews -> the original upload
    if (/(^|\.)redd\.it$/.test(host) && /^(preview|external-preview)\./.test(host)) {
      return 'https://i.redd.it' + u.pathname;
    }
    // Imgur thumbnail suffix (id + one size letter)
    if (/(^|\.)imgur\.com$/.test(host)) {
      const m = /^\/([A-Za-z0-9]{5,8})([bsmtlhg])(\.[a-z0-9]+)$/.exec(u.pathname);
      if (m && (m[1].length === 5 || m[1].length === 7)) return u.origin + '/' + m[1] + m[3];
    }
    // Wikimedia thumbnails
    if (/wikimedia\.org$|wikipedia\.org$/.test(host) && u.pathname.includes('/thumb/')) {
      const m = /^(.*)\/thumb(\/.+?\/.+?\/[^/]+)\/[^/]+$/.exec(u.pathname);
      if (m) return u.origin + m[1] + m[2];
    }
    // Squarespace ?format=750w
    const fmt = u.searchParams.get('format');
    if (fmt && /^\d+w$/.test(fmt)) { u.searchParams.set('format', 'original'); return u.href; }
    // Shopify-style _1024x1024 before the extension
    if (/cdn\.shopify\.com$/.test(host)) {
      u.pathname = u.pathname.replace(/_(\d+x\d*|\d*x\d+|small|medium|large|grande|compact)(?=\.[a-z0-9]+$)/i, '');
    }
    // Generic resize params - skipped on signed URLs, which break if touched.
    const signed = u.searchParams.has('Signature') || u.searchParams.has('X-Amz-Signature') ||
                   u.searchParams.has('sig') || /fbcdn\.net$|cdninstagram\.com$/.test(host);
    if (!signed) {
      for (const p of ['w', 'h', 'width', 'height', 'quality', 'q', 'resize', 'fit', 'crop', 'dpr', 'size', 'maxwidth', 'maxheight']) {
        u.searchParams.delete(p);
      }
    }
    return u.href;
  }

  /* ------------------------------------------------------ media resolver */

  function fromImg(img) {
    const cands = [];
    const nat = Math.max(img.naturalWidth || 0, img.width || 0, 1);
    const push = (u, score) => { const a = abs(u, img); if (a) cands.push({ u: a, score }); };
    const scoreOf = (desc) => {
      if (!desc) return nat;
      const w = /^([\d.]+)w$/.exec(desc); if (w) return parseFloat(w[1]);
      const x = /^([\d.]+)x$/.exec(desc); if (x) return nat * parseFloat(x[1]);
      return nat;
    };

    push(img.currentSrc, nat + 1);
    push(img.getAttribute('src'), nat);

    if (cfg.upgrade) {
      const sets = [];
      if (img.getAttribute('srcset')) sets.push(img.getAttribute('srcset'));
      const pic = img.closest && img.closest('picture');
      if (pic) pic.querySelectorAll('source[srcset]').forEach((s) => sets.push(s.getAttribute('srcset')));
      for (const s of sets) for (const c of parseSrcset(s)) push(c.url, scoreOf(c.desc));

      for (const attr of ['data-src', 'data-original', 'data-lazy-src', 'data-full-src', 'data-hi-res-src',
                          'data-zoom-image', 'data-large_image', 'data-image', 'data-actualsrc', 'data-echo']) {
        if (img.hasAttribute(attr)) push(img.getAttribute(attr), nat * 1.2);
      }
      const dss = img.getAttribute('data-srcset');
      if (dss) for (const c of parseSrcset(dss)) push(c.url, scoreOf(c.desc) * 1.1);
    }

    if (!cands.length) return null;
    cands.sort((a, b) => b.score - a.score);
    return { url: upgrade(cands[0].u), kind: 'image', el: img, alt: img.alt || '' };
  }

  function fromVideo(v) {
    let url = abs(v.currentSrc || v.getAttribute('src'), v);
    if (!url || url.startsWith('blob:')) {
      const s = v.querySelector('source[src]');
      const direct = s ? abs(s.getAttribute('src'), s) : '';
      if (direct && !direct.startsWith('blob:')) url = direct;
    }
    const poster = abs(v.poster, v);
    if (!url) return poster ? { url: poster, kind: 'image', el: v, posterOnly: true } : null;
    return { url: url.startsWith('blob:') ? url : upgrade(url), kind: 'video', el: v, poster };
  }

  function fromBackground(el) {
    let cs;
    try { cs = getComputedStyle(el); } catch (_) { return null; }
    const bi = cs && cs.backgroundImage;
    if (!bi || bi === 'none') return null;
    const m = /url\((['"]?)([^)]*?)\1\)/.exec(bi);
    if (!m || !m[2]) return null;
    const u = abs(m[2], el);
    if (!u) return null;
    return { url: upgrade(u), kind: 'image', el, background: true };
  }

  function fromCanvas(c) {
    try {
      const d = c.toDataURL('image/png');
      if (d && d.length > 32) return { url: d, kind: 'image', el: c, canvas: true };
    } catch (_) {
      return { error: 'That canvas holds cross-origin pixels and cannot be exported.' };
    }
    return null;
  }

  function fromSvg(svg) {
    try {
      const clone = svg.cloneNode(true);
      if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      const str = new XMLSerializer().serializeToString(clone);
      return { url: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(str), kind: 'image', el: svg, svg: true };
    } catch (_) { return null; }
  }

  function resolve(els) {
    let linkHref = '';
    let softError = null;

    for (const el of els) {
      const tag = (el.tagName || '').toLowerCase();

      if (!linkHref && tag === 'a') {
        const href = abs(el.getAttribute('href'), el);
        if (href && MEDIA_EXT.test(href)) linkHref = href;
      }

      let hit = null;
      if (tag === 'img') hit = fromImg(el);
      else if (tag === 'video') hit = fromVideo(el);
      else if (tag === 'audio') { const u = abs(el.currentSrc || el.getAttribute('src'), el); if (u) hit = { url: u, kind: 'audio', el }; }
      else if (tag === 'canvas') { const r = fromCanvas(el); if (r && r.error) softError = r.error; else hit = r; }
      else if (tag === 'svg') hit = fromSvg(el);
      else if (tag === 'image' && el.ownerSVGElement) {
        const u = abs(el.getAttribute('href') || el.getAttribute('xlink:href'), el);
        if (u) hit = { url: u, kind: 'image', el };
      }
      if (!hit) hit = fromBackground(el);

      if (hit && hit.url) {
        // A thumbnail wrapped in a link to the real file: take the file.
        if (cfg.preferLink && linkHref && linkHref !== hit.url) {
          if (hit.kind === 'image' && IMAGE_EXT.test(linkHref)) return Object.assign({}, hit, { url: upgrade(linkHref), viaLink: true });
          if (hit.kind === 'video' && VIDEO_EXT.test(linkHref)) return Object.assign({}, hit, { url: upgrade(linkHref), viaLink: true });
        }
        return hit;
      }
    }

    if (linkHref) return { url: upgrade(linkHref), kind: VIDEO_EXT.test(linkHref) ? 'video' : 'image', el: null, viaLink: true };
    if (softError) return { error: softError };
    return null;
  }

  /* --------------------------------------------------------- name tokens */

  const MIME_EXT = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav'
  };

  function tokensFor(hit) {
    let name = '', ext = '';
    const u = hit.url;
    if (/^data:/i.test(u)) {
      const m = /^data:([^;,]+)/i.exec(u);
      ext = (m && MIME_EXT[m[1].toLowerCase()]) || 'png';
      name = document.title || location.hostname || 'media';
    } else {
      try {
        const p = new URL(u, location.href);
        const seg = decodeURIComponent(p.pathname.split('/').filter(Boolean).pop() || '');
        const dot = seg.lastIndexOf('.');
        if (dot > 0) { name = seg.slice(0, dot); ext = seg.slice(dot + 1); }
        else {
          // Extension-less CDN key, e.g. pbs.twimg.com/media/<key>?format=png.
          // The type lives in the query, and the key is useless as a file name,
          // so prefer the enclosing post if there is one.
          name = seg;
          const f = (p.searchParams.get('format') || '').toLowerCase();
          if (/^[a-z0-9]{1,5}$/.test(f)) ext = f;
          const who = hit.el && statusInfo(hit.el);
          if (who) name = who.user + '-' + who.id;
        }
        if (!name) name = p.hostname;
      } catch (_) { name = 'media'; }
    }
    ext = (ext || '').split(/[?#]/)[0].toLowerCase();
    if (!/^[a-z0-9]{1,5}$/.test(ext)) ext = '';
    if (!ext) ext = hit.kind === 'video' ? 'mp4' : hit.kind === 'audio' ? 'mp3' : 'jpg';
    return {
      name, ext, kind: hit.kind,
      host: location.hostname.replace(/^www\./, ''),
      title: document.title || '',
      alt: hit.alt || ''
    };
  }

  /* -------------------------------------------------------------- overlay */

  let shadowHost = null, shadowRoot = null, outlineBox = null, toastBox = null, toastTimer = null;

  function ui() {
    if (shadowRoot && shadowHost && shadowHost.isConnected) return shadowRoot;
    shadowHost = document.createElement('div');
    shadowHost.id = '__snaffle_ui';
    shadowHost.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    shadowRoot = shadowHost.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      '.box{position:fixed;pointer-events:none;border:2px solid #3b82f6;border-radius:4px;' +
      'box-shadow:0 0 0 2px rgba(59,130,246,.25);transition:opacity .15s;opacity:0}' +
      '.box.on{opacity:1}' +
      '.box.hit{border-color:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.35)}' +
      '.toast{position:fixed;right:16px;bottom:16px;max-width:380px;padding:10px 14px;border-radius:10px;' +
      'font:500 13px/1.4 ui-sans-serif,system-ui,"Segoe UI",sans-serif;color:#fff;background:#111827;' +
      'box-shadow:0 8px 24px rgba(0,0,0,.35);opacity:0;transform:translateY(8px);transition:all .18s;' +
      'pointer-events:none;word-break:break-all}' +
      '.toast.on{opacity:1;transform:translateY(0)}' +
      '.toast.ok{background:#065f46}.toast.warn{background:#78350f}.toast.err{background:#7f1d1d}' +
      '</style><div class="box"></div><div class="toast"></div>';
    outlineBox = shadowRoot.querySelector('.box');
    toastBox = shadowRoot.querySelector('.toast');
    (document.body || document.documentElement).appendChild(shadowHost);
    return shadowRoot;
  }

  function boxFor(el) {
    if (!el || !el.getBoundingClientRect) return null;
    const r = el.getBoundingClientRect();
    return (r.width && r.height) ? r : null;
  }

  function paintOutline() {
    ui();
    const hit = resolve(elementStack(hoverTarget));
    const r = hit && !hit.error ? boxFor(hit.el) : null;
    if (!r) { outlineBox.classList.remove('on'); return; }
    outlineBox.classList.remove('hit');
    outlineBox.classList.add('on');
    Object.assign(outlineBox.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  }

  function flash(el) {
    const r = boxFor(el);
    if (!r) return;
    ui();
    Object.assign(outlineBox.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    outlineBox.classList.add('on', 'hit');
    setTimeout(() => {
      outlineBox.classList.remove('hit');
      if (!cfg.outline) outlineBox.classList.remove('on');
    }, 600);
  }

  function toast(msg, kind) {
    if (!cfg.toast) return;
    ui();
    toastBox.textContent = msg;
    toastBox.className = 'toast on ' + (kind || 'ok');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastBox.classList.remove('on'); }, kind === 'err' ? 4500 : 2200);
  }

  /* ------------------------------------------------------------ download */

  let busy = false;

  function ask(msg) {
    return new Promise((res) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          if (chrome.runtime.lastError) res({ ok: false, error: chrome.runtime.lastError.message });
          else res(r);
        });
      } catch (e) { res({ ok: false, error: String(e) }); }
    });
  }

  async function canFetch(url) {
    try { const r = await fetch(url); return r.ok || r.type === 'opaque'; } catch (_) { return false; }
  }

  function pageDownload(href, filename, revoke) {
    return new Promise((res) => {
      const a = document.createElement('a');
      a.href = href;
      a.download = String(filename || 'download').split('/').pop();
      a.style.display = 'none';
      (document.body || document.documentElement).appendChild(a);
      a.click();
      setTimeout(() => { a.remove(); if (revoke) URL.revokeObjectURL(href); res(); }, 1500);
    });
  }

  /* Fetch inside the page (correct Referer + cookies), then save via an anchor. */
  async function fallback(url, filename) {
    try {
      const r = await fetch(url, { credentials: 'include', referrer: location.href });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const blob = await r.blob();
      if (!blob.size) throw new Error('empty response');
      await pageDownload(URL.createObjectURL(blob), filename, true);
      toast('Saved ' + filename, 'ok');
      return true;
    } catch (_) {
      const res = await ask({ type: 'proxyGrab', url, filename });
      if (res && res.ok) { toast('Saved ' + res.filename, 'ok'); return true; }
      return false;
    }
  }

  /* ------------------------------------------------- streamed video (HLS) */

  const MAX_SEGMENTS = 1200;
  let cancelStream = false;

  function b64ToBuf(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  // video.twimg.com allows cross-origin reads, because the player itself needs
  // them. Where a CDN does not, the service worker fetches under host permission.
  async function fetchBuf(url, viaProxy) {
    if (!viaProxy) {
      try {
        const r = await fetch(url, { credentials: 'omit' });
        if (r.ok) return await r.arrayBuffer();
      } catch (_) {}
    }
    const res = await ask({ type: 'proxyFetch', url });
    if (res && res.ok) return b64ToBuf(res.b64);
    throw new Error('could not read ' + url.split('/').pop());
  }

  async function fetchText(url) {
    return new TextDecoder().decode(await fetchBuf(url));
  }

  function parseMaster(text, base) {
    const out = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!/^#EXT-X-STREAM-INF/i.test(lines[i])) continue;
      const bw = /BANDWIDTH=(\d+)/i.exec(lines[i]);
      const rs = /RESOLUTION=(\d+)x(\d+)/i.exec(lines[i]);
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || lines[j].trim().startsWith('#'))) j++;
      if (j >= lines.length) break;
      out.push({
        bandwidth: bw ? parseInt(bw[1], 10) : 0,
        width: rs ? parseInt(rs[1], 10) : 0,
        height: rs ? parseInt(rs[2], 10) : 0,
        url: new URL(lines[j].trim(), base).href
      });
    }
    return out;
  }

  function parseMedia(text, base) {
    const segs = [];
    let init = '';
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#')) {
        const m = /^#EXT-X-MAP:.*URI="([^"]+)"/i.exec(line);
        if (m) init = new URL(m[1], base).href;
        continue;
      }
      segs.push(new URL(line, base).href);
    }
    return { init, segs };
  }

  function playlistBlocker(text) {
    if (/#EXT-X-KEY:(?!.*METHOD=NONE)/i.test(text)) return 'This stream is encrypted (DRM) and cannot be saved.';
    if (/#EXT-X-BYTERANGE/i.test(text)) return 'This stream uses byte-range segments, which Snaffle cannot reassemble.';
    return '';
  }

  // Segments are folded into a Blob every CHUNK of them. Holding all of a long
  // video as ArrayBuffers would sit in the tab's heap; a Blob can be backed by
  // disk, so peak memory stays at roughly one chunk.
  async function assembleStream(urls, mime, onProgress) {
    const CHUNK = 24;
    const LANES = 6;
    let blob = new Blob([], { type: mime });
    let done = 0;
    let viaProxy = false;

    for (let start = 0; start < urls.length && !cancelStream; start += CHUNK) {
      const slice = urls.slice(start, start + CHUNK);
      const bufs = new Array(slice.length);
      let next = 0;

      const lane = async () => {
        for (;;) {
          const i = next++;
          if (i >= slice.length || cancelStream) return;
          let buf = null;
          for (let attempt = 0; attempt < 3 && !buf; attempt++) {
            try {
              buf = await fetchBuf(slice[i], viaProxy);
            } catch (e) {
              if (attempt === 0) viaProxy = true;        // page fetch blocked: use the worker
              else if (attempt === 2) { cancelStream = true; throw e; }
            }
          }
          bufs[i] = buf;
          onProgress(++done, urls.length);
        }
      };

      await Promise.all(Array.from({ length: Math.min(LANES, slice.length) }, lane));
      if (cancelStream) break;
      blob = new Blob([blob].concat(bufs), { type: mime });
    }
    return blob;
  }

  const X_MEDIA_ID = /\/(?:ext_tw_video|amplify_video|tweet_video)(?:_thumb)?\/(\d+)\//;

  function streamMediaId(v) {
    const m = X_MEDIA_ID.exec(v.poster || '');
    return m ? m[1] : '';
  }

  // Nearest enclosing post, for naming: user + status id.
  function statusInfo(el) {
    let node = el;
    for (let i = 0; i < 12 && node; i++, node = node.parentElement) {
      const a = node.querySelector && node.querySelector('a[href*="/status/"]');
      if (!a) continue;
      try {
        const m = /^\/([^/]+)\/status\/(\d+)/.exec(new URL(a.href).pathname);
        if (m) return { user: m[1], id: m[2] };
      } catch (_) {}
    }
    return null;
  }

  const hostToken = () => location.hostname.replace(/^www\./, '');

  // Returns true when the stream was handled (saved, refused, or cancelled),
  // false when no stream URL was ever seen for this video.
  async function grabStream(videoEl) {
    const mediaId = streamMediaId(videoEl);
    const found = await ask({ type: 'findStream', mediaId });
    if (!found || !found.url) return false;

    const who = statusInfo(videoEl);
    const stem = who ? who.user + '-' + who.id : (mediaId ? 'video-' + mediaId : 'video');

    // A progressive file was served after all: normal download path.
    if (/\.mp4(\?|$)/i.test(found.url)) {
      const tok = { name: stem, ext: 'mp4', kind: 'video', host: hostToken(), title: document.title || '', alt: '' };
      const res = await ask({ type: 'grab', url: found.url, tokens: tok, pageUrl: location.href });
      if (res && res.ok) { toast('Saved ' + res.filename, 'ok'); return true; }
      return await fallback(found.url, stem + '.mp4') || true;
    }

    cancelStream = false;
    toast('Reading stream playlist...', 'warn');

    let playlistUrl = found.url;
    let text = await fetchText(playlistUrl);
    let height = 0;
    let videoOnly = false;

    if (/#EXT-X-STREAM-INF/i.test(text)) {
      // A separate audio rendition means the variants carry video only, and
      // muxing them is beyond what a page can do. Say so rather than quietly
      // handing over a silent file.
      videoOnly = /#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*URI="/i.test(text);
      const variants = parseMaster(text, playlistUrl);
      if (!variants.length) { toast('Could not read the stream playlist.', 'err'); return true; }
      variants.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
      height = variants[0].height;
      playlistUrl = variants[0].url;
      text = await fetchText(playlistUrl);
    }

    const blocked = playlistBlocker(text);
    if (blocked) { toast(blocked, 'err'); return true; }

    const { init, segs } = parseMedia(text, playlistUrl);
    if (!segs.length) { toast('That stream playlist had no segments.', 'err'); return true; }
    if (segs.length > MAX_SEGMENTS) {
      toast('That stream is too long to reassemble (' + segs.length + ' segments).', 'err');
      return true;
    }
    // Fragmented MP4 carries its moov in the init segment. Without it the
    // concatenation is unplayable, so do not pretend otherwise.
    if (/\.m4s(\?|$)/i.test(segs[0]) && !init) {
      toast('This stream has no init segment, so its pieces cannot be joined into a playable file.', 'err');
      return true;
    }

    const onEsc = (e) => { if (e.key === 'Escape') cancelStream = true; };
    window.addEventListener('keydown', onEsc, true);

    try {
      const ts = /\.ts(\?|$)/i.test(segs[0]);
      const mime = ts ? 'video/mp2t' : 'video/mp4';
      const blob = await assembleStream(init ? [init].concat(segs) : segs, mime, (done, total) => {
        toast('Downloading video: ' + done + ' / ' + total + ' segments (Esc to cancel)', 'warn');
      });
      if (cancelStream) { toast('Cancelled.', 'warn'); return true; }

      const tok = {
        name: stem + (height ? '-' + height + 'p' : ''),
        ext: ts ? 'ts' : 'mp4',
        kind: 'video', host: hostToken(), title: document.title || '', alt: ''
      };
      const named = await ask({ type: 'buildName', tokens: tok });
      const filename = (named && named.filename) || tok.name + '.' + tok.ext;
      await pageDownload(URL.createObjectURL(blob), filename, true);
      toast('Saved ' + filename + ' (' + Math.max(1, Math.round(blob.size / 1048576)) + ' MB)' +
            (videoOnly ? ' - video only, this stream keeps audio in a separate track' : ''), 'ok');
      return true;
    } catch (e) {
      toast('Stream download failed: ' + ((e && e.message) || e), 'err');
      return true;
    } finally {
      cancelStream = false;
      window.removeEventListener('keydown', onEsc, true);
    }
  }

  // The guard is claimed before the first await, so a double tap cannot start
  // two assemblies of the same video.
  async function grab(startNode) {
    if (!cfg.enabled || busy) return;
    busy = true;
    try {
      await runGrab(startNode);
    } catch (e) {
      toast('Download failed: ' + ((e && e.message) || e), 'err');
    } finally {
      busy = false;
    }
  }

  async function runGrab(startNode) {
    let hit = resolve(elementStack(startNode));

    if (!hit) { toast('No image or video under the cursor', 'warn'); return; }
    if (hit.error) { toast(hit.error, 'err'); return; }

    // Streamed (MSE) video: its blob URL is not fetchable, so rebuild it from
    // the HLS playlist the player used. Poster frame is the last resort.
    if (hit.kind === 'video' && hit.url.startsWith('blob:') && !(await canFetch(hit.url))) {
      if (cfg.streamAssembly !== false && hit.el) {
        flash(hit.el);
        if (await grabStream(hit.el)) return;
      }
      if (cfg.posterFallback && hit.poster) {
        hit = { url: hit.poster, kind: 'image', el: hit.el, posterFallbackUsed: true };
      } else {
        toast('This video is streamed in segments and cannot be saved directly.', 'err');
        return;
      }
    }

    flash(hit.el);
    const tok = tokensFor(hit);
    const prefix = hit.posterFallbackUsed ? 'Streamed video - saved poster: ' : 'Saved ';

    if (/^(data|blob):/i.test(hit.url)) {
      const r = await ask({ type: 'buildName', tokens: tok });
      const name = (r && r.filename) || tok.name + '.' + tok.ext;
      await pageDownload(hit.url, name, false);
      toast(prefix + name, 'ok');
      return;
    }

    const res = await ask({ type: 'grab', url: hit.url, tokens: tok, pageUrl: location.href });
    if (res && res.ok) {
      toast(prefix + res.filename, 'ok');
    } else {
      toast('Retrying from the page...', 'warn');
      const name = (res && res.filename) || tok.name + '.' + tok.ext;
      if (!await fallback(hit.url, name)) {
        toast('Could not download: ' + ((res && res.error) || 'blocked by the site'), 'err');
      }
    }
  }

  /* ----------------------------------------------- shared with sibling files */

  // capture.js and gallery.js are separate content scripts in the same isolated
  // world. They attach themselves to this object and borrow the UI and the
  // download plumbing rather than duplicating it.
  const api = {
    get cfg() { return cfg; },
    ui, toast, flash, ask, pageDownload, fallback, fetchBuf,
    resolve, elementStack, ancestors, tokensFor, statusInfo, hostToken,
    fromImg, fromVideo, fromBackground,
    abs, upgrade, parseSrcset, grab,
    capture: null,   // set by capture.js
    gallery: null    // set by gallery.js
  };
  window.__SNAFFLE = api;

  /* ------------------------------------------------------------ triggers */

  const modsMatch = (t, e) => !!t.ctrl === e.ctrlKey && !!t.alt === e.altKey && !!t.shift === e.shiftKey && !!t.meta === e.metaKey;

  function isTyping(e) {
    const el = (e && e.target) || document.activeElement;
    if (!el || !el.tagName) return false;
    if (el.isContentEditable) return true;
    return /^(input|textarea|select)$/i.test(el.tagName);
  }

  const keyMatches = (k, e) => {
    if (!k || !k.enabled) return false;
    const hitKey = k.code ? e.code === k.code : (e.key || '').toLowerCase() === (k.key || '').toLowerCase();
    return hitKey && modsMatch(k, e);
  };

  // Each binding is checked against the same event, most specific first - a
  // three-modifier combo must win over a two-modifier one that shares its key.
  // Capture and the gallery live in the top frame. A key pressed inside an
  // iframe is relayed there rather than silently doing nothing.
  const KEY_ACTIONS = [
    ['captureKey', () => (api.capture ? api.capture() : ask({ type: 'relayTop', action: 'captureNow' }))],
    ['galleryKey', () => (api.gallery ? api.gallery() : ask({ type: 'relayTop', action: 'galleryNow' }))],
    ['key', () => grab()]
  ];

  window.addEventListener('keydown', (e) => {
    if (!cfg.enabled || e.repeat || isTyping(e)) return;
    for (const [name, run] of KEY_ACTIONS) {
      if (!keyMatches(cfg[name], e)) continue;
      e.preventDefault();
      e.stopPropagation();
      run();
      return;
    }
  }, true);

  let suppressUntil = 0;

  // Browser gestures on links - middle click opens a tab, Ctrl+Alt+click opens
  // Chrome's split view, Alt+click downloads - are default actions of the click
  // sequence. Cancelling only some of those events still lets the gesture fire,
  // so once our trigger matches we cancel the whole sequence.
  const SEQUENCE = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click',
                    'auxclick', 'contextmenu', 'dblclick', 'dragstart'];

  const triggerMatches = (e) =>
    cfg.enabled && cfg.mouse.enabled && !isTyping(e) &&
    e.button === cfg.mouse.button && modsMatch(cfg.mouse, e);

  const kill = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  };

  for (const type of SEQUENCE) {
    const opens = (type === 'pointerdown' || type === 'mousedown');
    window.addEventListener(type, (e) => {
      if (opens) {
        if (!triggerMatches(e)) return;
        kill(e);
        suppressUntil = Date.now() + 1200;
        // pointerdown lands first and only arms the suppression; mousedown grabs.
        if (type === 'mousedown') grab(e.target);
        return;
      }
      if (Date.now() < suppressUntil) kill(e);
    }, true);
  }

  /* --------------------------------------------------- messages from bg */

  chrome.runtime.onMessage.addListener((msg, _s, send) => {
    if (!msg) return false;
    if (msg.type === 'grabNow') { grab(); send({ ok: true }); }
    else if (msg.type === 'downloadFailed') { fallback(msg.url, msg.filename); send({ ok: true }); }
    else if (msg.type === 'toast') { toast(msg.text, msg.kind); send({ ok: true }); }
    else if (msg.type === 'captureNow') { if (api.capture) api.capture(); send({ ok: true }); }
    else if (msg.type === 'galleryNow') { if (api.gallery) api.gallery(); send({ ok: true }); }
    return false;
  });
})();
