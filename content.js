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

  let hoverTarget = null;      // innermost element under the pointer in this frame
  let lastEventTarget = null;
  let pointerInside = false;   // is the pointer over this frame's document at all
  let outlineQueued = false;
  const cursor = { x: 0, y: 0 };
  const capture = { capture: true, passive: true };

  // Events from inside a shadow root arrive retargeted to the host. The first
  // entry of the composed path is the element the pointer is really on.
  const deepTarget = (e) => (e.composedPath && e.composedPath()[0]) || e.target;

  document.addEventListener('mousemove', (e) => {
    cursor.x = e.clientX; cursor.y = e.clientY;
    pointerInside = true;
    if (e.target !== lastEventTarget) { lastEventTarget = e.target; hoverTarget = deepTarget(e); queueOutline(); }
  }, capture);

  document.addEventListener('mouseover', (e) => {
    pointerInside = true;
    lastEventTarget = e.target;
    hoverTarget = deepTarget(e);
    queueOutline();
  }, capture);

  // No related target means the pointer left this document altogether - into
  // the parent page, or out of the window. Entering a child iframe does not
  // count: the iframe element itself is the related target.
  document.addEventListener('mouseout', (e) => {
    if (!e.relatedTarget) pointerInside = false;
  }, capture);

  // The pointer is over an embedded frame, whose contents this frame cannot see.
  const overFrame = () => !!hoverTarget && /^(IFRAME|FRAME)$/.test(hoverTarget.tagName || '');

  function queueOutline() {
    if (!cfg.enabled || !cfg.outline || outlineQueued) return;
    outlineQueued = true;
    requestAnimationFrame(() => { outlineQueued = false; paintOutline(); });
  }

  // Content scripts may look inside closed shadow roots as well as open ones.
  function shadowOf(el) {
    try {
      if (chrome.dom && chrome.dom.openOrClosedShadowRoot) return chrome.dom.openOrClosedShadowRoot(el);
    } catch (_) {}
    return el.shadowRoot || null;
  }

  // Composed ancestors: a ShadowRoot has no parentNode, so stepping to its
  // host crosses the boundary.
  function ancestors(node) {
    const out = [];
    let n = node;
    while (n && out.length < 80) {
      if (n.nodeType === 1) out.push(n);
      n = n.parentNode || n.host || null;
    }
    return out;
  }

  // Everything painted under the pointer, topmost first, shadow roots opened.
  // Paint order is the order that matches what the user is looking at: an
  // image under a transparent overlay comes before the card behind them both.
  function stackAt(x, y) {
    const out = [];
    const seen = new Set();
    const visit = (root, depth) => {
      let els = [];
      try { els = root.elementsFromPoint(x, y); } catch (_) {}
      for (const el of els) {
        // A shadow root's answer includes the outer page; keep only its own.
        if (seen.has(el) || el.getRootNode() !== root) continue;
        const inner = depth < 6 ? shadowOf(el) : null;
        if (inner) visit(inner, depth + 1);     // its contents paint in its place
        seen.add(el);
        out.push(el);
      }
    };
    visit(document, 0);
    return out;
  }

  // Media the pointer is geometrically over, even if it cannot be hit-tested:
  // sites put pointer-events:none on images to defeat "save image as".
  function mediaAround(root, x, y) {
    let best = null, bestArea = Infinity;
    let list = [];
    try { list = root.querySelectorAll('img, video, canvas'); } catch (_) {}
    for (const el of list) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const area = r.width * r.height;
      if (area < bestArea) { best = el; bestArea = area; }
    }
    return best;
  }

  function elementStack() {
    return stackAt(cursor.x, cursor.y);
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

    // Image proxies that embed the original URL (Substack, weserv, Cloudinary
    // fetch, wp.com ...). Only unwrap when the embedded URL is itself a media
    // file: tracking and referrer parameters carry encoded page URLs too, and
    // following one of those downloads a web page.
    const mediaUrl = (s) => {
      try { return /\.(jpe?g|png|gif|webp|avif|bmp|svg|mp4|webm|mov)$/i.test(new URL(s).pathname); }
      catch (_) { return false; }
    };
    const embedded = /https?%3A%2F%2F[^\s"'&]+/i.exec(u.href);
    if (embedded) {
      try {
        const inner = decodeURIComponent(embedded[0]);
        if (mediaUrl(inner)) return inner;
      } catch (_) {}
    }
    const proxied = u.searchParams.get('url') || u.searchParams.get('src') || u.searchParams.get('image');
    if (proxied && /^https?:\/\//i.test(proxied) && mediaUrl(proxied)) return proxied;

    // X / Twitter
    if (/(^|\.)twimg\.com$/.test(host)) {
      if (u.searchParams.has('name')) { u.searchParams.set('name', 'orig'); return u.href; }
      return u.href.replace(/:(thumb|small|medium|large)$/, ':orig');
    }
    // Reddit's own previews -> the original upload. external-preview images
    // are other sites' pictures behind a signed URL; they have no i.redd.it copy.
    if (host === 'preview.redd.it') {
      return 'https://i.redd.it' + u.pathname;
    }
    if (host === 'external-preview.redd.it') return url;
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
    let changed = false;
    if (/cdn\.shopify\.com$/.test(host)) {
      const bare = u.pathname.replace(/_(\d+x\d*|\d*x\d+|small|medium|large|grande|compact)(?=\.[a-z0-9]+$)/i, '');
      if (bare !== u.pathname) { u.pathname = bare; changed = true; }
    }
    // Generic resize params - skipped on signed URLs, which break if touched.
    const signed = u.searchParams.has('Signature') || u.searchParams.has('X-Amz-Signature') ||
                   u.searchParams.has('sig') || u.searchParams.has('s') ||
                   /fbcdn\.net$|cdninstagram\.com$/.test(host);
    if (!signed) {
      for (const p of ['w', 'h', 'width', 'height', 'quality', 'q', 'resize', 'fit', 'crop', 'dpr', 'size', 'maxwidth', 'maxheight']) {
        if (u.searchParams.has(p)) { u.searchParams.delete(p); changed = true; }
      }
    }
    // Re-serialising re-encodes the query, so an address nothing was removed
    // from is handed back exactly as it came.
    return changed ? u.href : url;
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

    const current = abs(img.currentSrc || img.getAttribute('src'), img);
    push(img.currentSrc, nat + 1);
    push(img.getAttribute('src'), nat);

    if (cfg.upgrade) {
      const sets = [];
      if (img.getAttribute('srcset')) sets.push(img.getAttribute('srcset'));
      const pic = img.closest && img.closest('picture');
      if (pic) pic.querySelectorAll('source[srcset]').forEach((s) => sets.push(s.getAttribute('srcset')));
      for (const s of sets) for (const c of parseSrcset(s)) push(c.url, scoreOf(c.desc));

      // Lazy-load attributes hold all sorts of things - ids, JSON, flags. Only
      // take one that reads as an address: absolute, or ending in an image type.
      const plausible = (v) => /^(https?:)?\/\//i.test(v) || IMAGE_EXT.test(v);
      for (const attr of ['data-src', 'data-original', 'data-lazy-src', 'data-full-src', 'data-hi-res-src',
                          'data-zoom-image', 'data-large_image', 'data-image', 'data-actualsrc', 'data-echo']) {
        const v = (img.getAttribute(attr) || '').trim();
        if (v && plausible(v)) push(v, nat * 1.2);
      }
      const dss = img.getAttribute('data-srcset');
      if (dss) for (const c of parseSrcset(dss)) push(c.url, scoreOf(c.desc) * 1.1);
    }

    if (!cands.length) return null;
    cands.sort((a, b) => b.score - a.score);
    const up = upgrade(cands[0].u);
    return { url: up, alts: fallbacks([cands[0].u, current], up), kind: 'image', el: img, alt: img.alt || '' };
  }

  // Every rewrite is a guess about a server we do not control, so each hit
  // carries the addresses to fall back to, ending with what the page itself loaded.
  function fallbacks(list, chosen) {
    return list.filter((u, i) => u && u !== chosen && /^https?:/i.test(u) && list.indexOf(u) === i);
  }

  function fromVideo(v) {
    let url = abs(v.currentSrc || v.getAttribute('src'), v);
    if (!url || url.startsWith('blob:')) {
      const s = v.querySelector('source[src]');
      const direct = s ? abs(s.getAttribute('src'), s) : '';
      if (direct && !direct.startsWith('blob:')) url = direct;
    }
    const poster = abs(v.poster, v);
    if (!url) return poster ? { url: poster, kind: 'image', el: v } : null;
    if (url.startsWith('blob:')) return { url, kind: 'video', el: v, poster };
    const up = upgrade(url);
    return { url: up, alts: fallbacks([url], up), kind: 'video', el: v, poster };
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
    const up = upgrade(u);
    return { url: up, alts: fallbacks([u], up), kind: 'image', el };
  }

  // Encoding a canvas or serialising an SVG is expensive, so a hit on one only
  // promises to do it. The work happens when a grab actually goes ahead, not
  // every time the outline wants to know what is under the pointer.
  function encodeCanvas(c) {
    try {
      const d = c.toDataURL('image/png');
      if (d && d.length > 32) return { url: d };
    } catch (_) {
      return { error: 'That canvas holds cross-origin pixels and cannot be exported.' };
    }
    return { error: 'That canvas is empty.' };
  }

  function encodeSvg(svg) {
    try {
      const clone = svg.cloneNode(true);
      if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      const str = new XMLSerializer().serializeToString(clone);
      return { url: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(str) };
    } catch (_) {
      return { error: 'That SVG could not be serialised.' };
    }
  }

  function mediaFrom(el) {
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'img') return fromImg(el);
    if (tag === 'video') return fromVideo(el);
    if (tag === 'audio') {
      const u = abs(el.currentSrc || el.getAttribute('src'), el);
      return u ? { url: u, kind: 'audio', el } : null;
    }
    if (tag === 'canvas') return { url: '', kind: 'image', el, make: () => encodeCanvas(el) };
    if (tag === 'svg') return { url: '', kind: 'image', el, make: () => encodeSvg(el) };
    if (tag === 'image' && el.ownerSVGElement) {
      const u = abs(el.getAttribute('href') || el.getAttribute('xlink:href'), el);
      return u ? { url: u, kind: 'image', el } : null;
    }
    return null;
  }

  // The nearest enclosing link that points straight at a media file.
  function linkFor(el) {
    for (const n of ancestors(el)) {
      if ((n.tagName || '').toLowerCase() !== 'a') continue;
      const href = abs(n.getAttribute('href'), n);
      if (href && MEDIA_EXT.test(href)) return href;
    }
    return '';
  }

  // `stack` is what is painted under the pointer, topmost first. The first
  // element that is media, or has a background image, is what the user sees.
  function resolve(stack) {
    let hit = null;

    for (const el of stack) {
      hit = mediaFrom(el);
      if (hit) break;
      const bg = fromBackground(el);
      if (bg) {
        // Media inside this element paints over its background, even if
        // pointer-events:none kept that media out of the hit-test stack.
        const inner = mediaAround(el, cursor.x, cursor.y);
        hit = (inner && mediaFrom(inner)) || bg;
        break;
      }
    }
    if (!hit) {
      const loose = mediaAround(document, cursor.x, cursor.y);
      if (loose) hit = mediaFrom(loose);
    }

    // A thumbnail wrapped in a link to the real file: take the file, and keep
    // the thumbnail as the fallback.
    const link = cfg.preferLink ? (linkFor(hit && hit.el) || linkFor(stack[0])) : '';
    if (hit) {
      const fits = link && link !== hit.url &&
        ((hit.kind === 'image' && IMAGE_EXT.test(link)) || (hit.kind === 'video' && VIDEO_EXT.test(link)));
      if (!fits) return hit;
      const up = upgrade(link);
      return Object.assign({}, hit, {
        url: up, make: null, viaLink: true,
        alts: fallbacks([link, hit.url].concat(hit.alts || []), up)
      });
    }
    if (link) {
      const up = upgrade(link);
      return { url: up, alts: fallbacks([link], up), kind: VIDEO_EXT.test(link) ? 'video' : 'image', el: stack[0] || null, viaLink: true };
    }
    return null;
  }

  /* --------------------------------------------------------- name tokens */

  const MIME_EXT = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav'
  };

  function tokensFor(hit, url) {
    let name = '', ext = '';
    const u = url || hit.url;
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
    // Nothing in the address says what this is. The service worker corrects
    // the guess once the server has answered with a real content type.
    const extGuessed = !ext;
    if (!ext) ext = hit.kind === 'video' ? 'mp4' : hit.kind === 'audio' ? 'mp3' : 'jpg';
    return {
      name, ext, extGuessed, kind: hit.kind,
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
    const hit = pointerInside ? resolve(elementStack()) : null;
    const r = hit ? boxFor(hit.el) : null;
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
    if (window.top !== window) { ask({ type: 'relayTop', action: 'toast', text: msg, kind }); return; }
    showToast(msg, kind);
  }

  function showToast(msg, kind) {
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

  // Text is never the picture or video someone pointed at. SVG is the one
  // image type that calls itself XML.
  const notMedia = (type) => !/svg/i.test(type || '') && /^text\/|html|json|xml|javascript/i.test(type || '');

  const sizeText = (bytes) => (bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB');

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

  function blobToDataUrl(blob) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  // Above this a file is too big to hand to the service worker in one message.
  const MAX_INLINE = 24 * 1024 * 1024;

  // Save bytes that exist only in this page. Passing them to the service worker
  // lets the download honour the folder setting. An anchor click cannot carry a
  // folder, so it is the last resort, and the caller is told when it was used.
  async function saveBlob(blob, path) {
    if (blob.size <= MAX_INLINE) {
      const res = await ask({ type: 'saveData', dataUrl: await blobToDataUrl(blob), filename: path });
      if (res && res.ok) return { name: res.filename, filed: true };
    }
    const name = String(path).split('/').pop();
    await pageDownload(URL.createObjectURL(blob), name, true);
    return { name, filed: false };
  }

  const savedText = (saved) => saved.name + (saved.filed ? '' : ' (in Downloads, outside your Snaffle folder)');

  // The browser could not fetch it alone. The page can try with its own
  // cookies and Referer, and the service worker after that.
  async function fallback(url, path) {
    let reason = '';
    try {
      const r = await fetch(url, { credentials: 'include', referrer: location.href });
      if (!r.ok) throw new Error('the site answered ' + r.status);
      const blob = await r.blob();
      if (!blob.size) throw new Error('the site sent an empty file');
      if (notMedia(blob.type)) throw new Error('the site sent a web page instead of a file');
      return { ok: true, saved: await saveBlob(blob, path) };
    } catch (e) {
      reason = (e && e.message) || String(e);
    }
    const res = await ask({ type: 'proxyGrab', url, filename: path });
    if (res && res.ok) return { ok: true, saved: { name: res.filename, filed: true } };
    // "Failed to fetch" is the browser's word for a cross-origin refusal; the
    // service worker's answer says more about what the site actually did.
    return { ok: false, reason: (res && res.error && !/Failed to fetch/i.test(res.error) ? res.error : '') || reason };
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

  // The sniffer records every playlist requested from this tab, and cannot
  // tell the page's requests from ours. Announce ours first so they are not
  // recorded as if the page had asked for another video.
  async function fetchText(url) {
    await ask({ type: 'ownFetch', urls: [url] });
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

    // Several streams on the page and nothing tying one of them to this video:
    // the most recent is only a guess, and the user has to be told so.
    const guess = found.guessed && found.streams > 1
      ? ' - best guess: this page loaded ' + found.streams + ' streams and none could be matched to this video'
      : '';

    const who = statusInfo(videoEl);
    const stem = who ? who.user + '-' + who.id : (mediaId ? 'video-' + mediaId : 'video');

    // A progressive file was served after all: normal download path.
    if (/\.mp4(\?|$)/i.test(found.url)) {
      const tok = { name: stem, ext: 'mp4', kind: 'video', host: hostToken(), title: document.title || '', alt: '' };
      const res = await ask({ type: 'grab', candidates: [{ url: found.url, tokens: tok }], pageUrl: location.href });
      if (res && res.ok) { toast('Saved ' + res.filename + guess, guess ? 'warn' : 'ok'); return true; }
      const fb = await fallback(found.url, (res && res.filename) || stem + '.mp4');
      if (fb.ok) toast('Saved ' + savedText(fb.saved) + guess, guess ? 'warn' : 'ok');
      else toast('Could not save this video: ' + (fb.reason || (res && res.error) || 'the site blocked it'), 'err');
      return true;
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
      const saved = await saveBlob(blob, (named && named.path) || tok.name + '.' + tok.ext);
      toast('Saved ' + savedText(saved) + ' (' + sizeText(blob.size) + ')' +
            (videoOnly ? ' - video only, this stream keeps audio in a separate track' : '') + guess,
            guess ? 'warn' : 'ok');
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
  async function grab() {
    if (!cfg.enabled || busy) return;
    busy = true;
    try {
      await runGrab();
    } catch (e) {
      toast('Could not save this: ' + ((e && e.message) || e), 'err');
    } finally {
      busy = false;
    }
  }

  async function runGrab() {
    let hit = resolve(elementStack());
    if (!hit) { toast('No image or video under the cursor', 'warn'); return; }

    // Canvas and SVG are only encoded now that a grab is really happening.
    if (hit.make) {
      const made = hit.make();
      if (made.error) { toast(made.error, 'err'); return; }
      hit = Object.assign({}, hit, { url: made.url, make: null });
    }

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
    const prefix = hit.posterFallbackUsed ? 'Streamed video - saved poster: ' : 'Saved ';

    // Bytes that exist only in this page: an encoded canvas, an inline SVG, an
    // image the page built in memory.
    if (/^(data|blob):/i.test(hit.url)) {
      const tok = tokensFor(hit);
      const named = await ask({ type: 'buildName', tokens: tok });
      const path = (named && named.path) || tok.name + '.' + tok.ext;
      let saved = null;
      if (/^data:/i.test(hit.url)) {
        const res = await ask({ type: 'saveData', dataUrl: hit.url, filename: path });
        if (res && res.ok) saved = { name: res.filename, filed: true };
      } else {
        saved = await saveBlob(await (await fetch(hit.url)).blob(), path);
      }
      if (!saved) {
        const name = path.split('/').pop();
        await pageDownload(hit.url, name, false);
        saved = { name, filed: false };
      }
      toast(prefix + savedText(saved), 'ok');
      return;
    }

    // Try the best address first, then each fallback, ending with the one the
    // page itself loaded. The service worker answers only once the server has,
    // so "Saved" means a real file of the right kind is arriving.
    const candidates = [hit.url].concat(hit.alts || []).map((u) => ({ url: u, tokens: tokensFor(hit, u) }));
    const slow = setTimeout(() => toast('Saving...', 'warn'), 600);
    const res = await ask({ type: 'grab', candidates, pageUrl: location.href });
    clearTimeout(slow);
    if (res && res.ok) { toast(prefix + res.filename, 'ok'); return; }

    const last = candidates[candidates.length - 1];
    const fb = await fallback(last.url, (res && res.filename) || last.tokens.name + '.' + last.tokens.ext);
    if (fb.ok) toast(prefix + savedText(fb.saved), 'ok');
    else toast('Could not save this: ' + (fb.reason || (res && res.error) || 'the site blocked it'), 'err');
  }

  /* ----------------------------------------------- shared with sibling files */

  // capture.js and gallery.js are separate content scripts in the same isolated
  // world. They attach themselves to this object and borrow the UI and the
  // download plumbing rather than duplicating it.
  const api = {
    get cfg() { return cfg; },
    ui, toast, flash, ask, pageDownload, saveBlob, savedText, fallback, fetchBuf,
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

  // A key press lands in whichever frame has keyboard focus, which need not be
  // the frame the pointer is in. If the pointer is not here, hand the grab to
  // the frame that has it rather than acting on a stale position.
  function keyGrab() {
    if (pointerInside && !overFrame()) { grab(); return; }
    ask({ type: 'relayGrab' }).then((r) => {
      if (!r || !r.handled) toast('No image or video under the cursor', 'warn');
    });
  }

  // Each binding is checked against the same event, most specific first - a
  // three-modifier combo must win over a two-modifier one that shares its key.
  // Capture and the gallery live in the top frame. A key pressed inside an
  // iframe is relayed there rather than silently doing nothing.
  const KEY_ACTIONS = [
    ['captureKey', () => (api.capture ? api.capture() : ask({ type: 'relayTop', action: 'captureNow' }))],
    ['galleryKey', () => (api.gallery ? api.gallery() : ask({ type: 'relayTop', action: 'galleryNow' }))],
    ['key', keyGrab]
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
  // sequence, so once our trigger matches the rest of the sequence is cancelled.
  //
  // pointerdown is the exception, and must NOT be cancelled: doing so makes the
  // browser drop the mousedown and mouseup that follow, and mousedown is where
  // the grab happens. It is only hidden from the page.
  const SEQUENCE = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click',
                    'auxclick', 'contextmenu', 'dblclick', 'dragstart'];

  const triggerMatches = (e) =>
    cfg.enabled && cfg.mouse.enabled && !isTyping(e) &&
    e.button === cfg.mouse.button && modsMatch(cfg.mouse, e);

  const hide = (e) => {
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  };
  const kill = (e) => { e.preventDefault(); hide(e); };

  for (const type of SEQUENCE) {
    window.addEventListener(type, (e) => {
      if (type === 'pointerdown') {
        if (!triggerMatches(e)) return;
        hide(e);
        suppressUntil = Date.now() + 1200;
        return;
      }
      if (type === 'mousedown') {
        if (!triggerMatches(e)) return;
        kill(e);
        suppressUntil = Date.now() + 1200;
        // The click itself says where the pointer is; no hover is needed first.
        cursor.x = e.clientX; cursor.y = e.clientY;
        pointerInside = true;
        hoverTarget = deepTarget(e);
        grab();
        return;
      }
      if (Date.now() < suppressUntil) kill(e);
    }, true);
  }

  /* --------------------------------------------------- messages from bg */

  chrome.runtime.onMessage.addListener((msg, _s, send) => {
    if (!msg) return false;
    if (msg.type === 'grabNow') {
      // Broadcast to every frame. Only the one the pointer is in answers, so
      // the sender can tell whether anybody took it.
      if (!pointerInside || overFrame()) return false;
      grab();
      send({ handled: true });
    } else if (msg.type === 'downloadFailed') {
      // A download that started and then died. Never leave "Saved" standing.
      fallback(msg.url, msg.filename).then((fb) => {
        if (fb.ok) toast('Saved ' + savedText(fb.saved), 'ok');
        else toast('Could not save ' + String(msg.filename).split('/').pop() + ': ' + (fb.reason || msg.error || 'the site blocked it'), 'err');
      });
      send({ ok: true });
    } else if (msg.type === 'toast') {
      if (window.top === window) showToast(msg.text, msg.kind);
      send({ ok: true });
    } else if (msg.type === 'captureNow') { if (api.capture) api.capture(); send({ ok: true }); }
    else if (msg.type === 'galleryNow') { if (api.gallery) api.gallery(); send({ ok: true }); }
    return false;
  });
})();
