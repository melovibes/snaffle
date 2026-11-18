/* Snaffle - content script. Runs in every frame. */
(() => {
  const S = SnaffleShared;

  // An update leaves the old copy of this script behind in every open tab, cut
  // off from the extension but still listening. The fresh copy that is injected
  // after an update retires it, so one key press is never handled twice. A copy
  // that is still working is left alone, which makes injecting this file again
  // into a tab that already has it harmless.
  const prior = window.__SNAFFLE;
  if (prior && prior.alive && prior.alive()) return;
  if (prior && prior.retire) prior.retire();

  let dead = false;
  const alive = () => { try { return !dead && !!chrome.runtime.id; } catch (_) { return false; } };

  let cfg = S.effective(null);
  chrome.storage.sync.get('cfg', (s) => { if (s && s.cfg) cfg = S.effective(s.cfg); });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'sync' && ch.cfg) cfg = S.effective(ch.cfg.newValue);
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

  // A page that rebuilds what is under a still pointer can produce a mouseout
  // with no related target, which reads as the pointer having left. :hover is
  // the browser's own answer to whether it is still over this document.
  const pointerHere = () => {
    if (pointerInside) return true;
    try { if (document.documentElement.matches(':hover')) pointerInside = true; } catch (_) {}
    return pointerInside;
  };

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
  // Smallest first: the smallest thing the pointer is inside is the most
  // specific. All of them are returned, because the smallest may turn out to
  // be an empty placeholder with something real behind it.
  function mediaAllAround(root, x, y) {
    const found = [];
    let list = [];
    try { list = root.querySelectorAll('img, video, canvas'); } catch (_) {}
    for (const el of list) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      found.push({ el, area: r.width * r.height });
    }
    return found.sort((a, b) => a.area - b.area).map((f) => f.el);
  }

  const mediaAround = (root, x, y) => mediaAllAround(root, x, y)[0] || null;

  // Does this video have anything in it yet? One that has not been started
  // is only a box; its cover picture is all there is to save.
  const hasMedia = (v) => v.readyState > 0 || !!v.srcObject || !!(v.currentSrc || v.getAttribute('src'));

  // A player's cover picture lies exactly over its video, and stays there
  // while the video plays underneath. Pointing at it is pointing at the video.
  function videoBehind(el, stack) {
    if (!el || !el.getBoundingClientRect) return null;
    const a = el.getBoundingClientRect();
    const candidates = stack.concat(mediaAllAround(document, cursor.x, cursor.y));
    for (const v of candidates) {
      if ((v.tagName || '') !== 'VIDEO' || v === el || !hasMedia(v)) continue;
      const b = v.getBoundingClientRect();
      const same = Math.abs(a.left - b.left) <= 4 && Math.abs(a.top - b.top) <= 4 &&
                   Math.abs(a.width - b.width) <= 8 && Math.abs(a.height - b.height) <= 8;
      if (same) return v;
    }
    return null;
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
    const push = (u, score, w) => { const a = abs(u, img); if (a) cands.push({ u: a, score, w: w || 0 }); };
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
      // A width descriptor says how wide that version really is.
      const widthOf = (desc) => { const m = /^([d.]+)w$/.exec(desc || ''); return m ? Math.round(parseFloat(m[1])) : 0; };
      for (const s of sets) for (const c of parseSrcset(s)) push(c.url, scoreOf(c.desc), widthOf(c.desc));

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
    return { url: up, alts: fallbacks([cands[0].u, current], up), kind: 'image', el: img, alt: img.alt || '', width: cands[0].w };
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
    if (!url) {
      // A player can feed a video without ever giving it an address. It is
      // still a video, and still what the user is pointing at.
      if (v.srcObject || v.readyState > 0) return { url: '', kind: 'video', el: v, poster, stream: true };
      return poster ? { url: poster, kind: 'image', el: v } : null;
    }
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
      for (const loose of mediaAllAround(document, cursor.x, cursor.y)) {
        hit = mediaFrom(loose);
        if (hit) break;
      }
    }
    if (hit && hit.kind === 'image' && !hit.make) {
      const v = videoBehind(hit.el, stack);
      const under = v && fromVideo(v);
      // The cover is kept as the poster, for when the video cannot be saved.
      if (under && under.kind === 'video') hit = Object.assign({}, under, { poster: under.poster || hit.url });
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

  function tokensFor(hit, url) {
    let name = '', ext = '';
    const u = url || hit.url;
    if (/^data:/i.test(u)) {
      const m = /^data:([^;,]+)/i.exec(u);
      ext = (m && S.MIME_EXT[m[1].toLowerCase()]) || 'png';
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
          // One of several pictures saved from the same post says which.
          if (who) name = who.user + '-' + who.id + (hit.part ? '-' + hit.part : '');
        }
        const ig = hit.el && instagramInfo(hit.el, hit.slide);
        if (ig) name = ig.name;
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

  let shadowHost = null, shadowRoot = null, outlineBox = null, toastList = null;

  const OVERLAY_CSS =
    ':host{all:initial}' +
    '.box{position:fixed;pointer-events:none;border:2px solid #3b82f6;border-radius:4px;' +
    'box-shadow:0 0 0 2px rgba(59,130,246,.25);transition:opacity .15s;opacity:0}' +
    '.box.on{opacity:1}' +
    '.box.hit{border-color:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.35)}' +
    // The list itself never takes clicks; only the toasts in it do.
    '.toasts{position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;align-items:flex-end;' +
    'gap:8px;pointer-events:none;max-width:min(420px,calc(100vw - 32px))}' +
    '.toast{pointer-events:auto;box-sizing:border-box;max-width:100%;display:grid;grid-template-columns:1fr auto;' +
    'gap:6px 10px;align-items:start;padding:10px 12px;border-radius:10px;color:#fff;background:#111827;' +
    'font:500 13px/1.4 ui-sans-serif,system-ui,"Segoe UI",sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.35);' +
    'opacity:0;transform:translateY(8px);transition:opacity .18s,transform .18s}' +
    '.toast.on{opacity:1;transform:none}' +
    '.toast.ok{background:#065f46}.toast.warn{background:#78350f}.toast.err{background:#7f1d1d}.toast.busy{background:#1e3a8a}' +
    '.msg{overflow-wrap:anywhere}' +
    '.x{all:unset;cursor:pointer;opacity:.7;font-size:16px;line-height:1;padding:1px 3px;border-radius:4px}' +
    '.x:hover,.x:focus-visible{opacity:1;background:rgba(255,255,255,.18)}' +
    '.acts{grid-column:1/-1;display:flex;gap:8px;flex-wrap:wrap}' +
    '.acts:empty,.bar[hidden]{display:none}' +
    '.acts button{all:unset;cursor:pointer;font-weight:650;padding:4px 10px;border-radius:6px;background:rgba(255,255,255,.16)}' +
    '.acts button:hover,.acts button:focus-visible{background:rgba(255,255,255,.3)}' +
    '.bar{grid-column:1/-1;height:4px;border-radius:2px;background:rgba(255,255,255,.25);overflow:hidden}' +
    '.bar i{display:block;height:100%;width:0;background:#fff;transition:width .25s}' +
    '@media (prefers-reduced-motion:reduce){.toast,.bar i,.box{transition:none}}';

  function ui() {
    if (shadowRoot && shadowHost && shadowHost.isConnected) return shadowRoot;
    shadowHost = document.createElement('div');
    shadowHost.id = '__snaffle_ui';
    shadowHost.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    shadowRoot = shadowHost.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = '<style>' + OVERLAY_CSS + '</style><div class="box"></div><div class="toasts"></div>';
    outlineBox = shadowRoot.querySelector('.box');
    toastList = shadowRoot.querySelector('.toasts');
    toasts.clear();
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

  /* --------------------------------------------------------------- toasts */

  // Several can be on screen at once: a video that is still downloading keeps
  // its own toast, with a progress bar and a Cancel button, while other grabs
  // report beside it. A toast with an `id` is updated in place.
  //
  //   opts.id        update the toast with this id instead of adding one
  //   opts.sticky    stay until replaced or dismissed (work in progress)
  //   opts.linger    the outcome of background work: stay up longer
  //   opts.progress  0-100, draws the bar
  //   opts.actions   [{ label, send }] - a button that sends `send` to the
  //                  service worker when pressed
  const toasts = new Map();   // id -> { el, timer, life }
  const MAX_TOASTS = 4;
  let toastSeq = 0;

  // From any frame; the top page is where toasts are drawn, so one inside a
  // small iframe is not clipped to it.
  function toast(msg, kind, opts) {
    if (window.top !== window) { ask({ type: 'relayTop', action: 'toast', text: msg, kind, opts }); return; }
    showToast(msg, kind, opts);
  }

  function dismissToast(id) {
    const t = toasts.get(id);
    if (!t) return;
    toasts.delete(id);
    clearTimeout(t.timer);
    t.el.classList.remove('on');
    setTimeout(() => t.el.remove(), 220);
  }

  // A message nobody was looking at has not been read. A toast's time only
  // runs while this page is the one in front: one that arrives while the
  // user is in another tab is still there, with its full time ahead of it,
  // when they come back.
  const inFront = () => document.visibilityState !== 'hidden';

  function armToast(id) {
    const t = toasts.get(id);
    if (!t) return;
    clearTimeout(t.timer);
    t.timer = 0;
    if (t.life && inFront()) t.timer = setTimeout(() => dismissToast(id), t.life);
  }

  document.addEventListener('visibilitychange', () => {
    if (dead) return;
    for (const id of Array.from(toasts.keys())) armToast(id);
  });

  // The outcome of a background job is said once. If this page is reloaded
  // or left while that message is still up, it is handed back to the
  // extension, which shows it on whatever the tab loads next. From here on
  // this page takes no more messages: it will not be here to show them.
  let leaving = false;
  window.addEventListener('pagehide', (e) => {
    if (dead || e.persisted || window.top !== window) return;
    leaving = true;
    const lost = Array.from(toasts.values()).map((t) => t.kept).filter(Boolean);
    if (lost.length) { try { chrome.runtime.sendMessage({ type: 'toastsLost', toasts: lost }, () => void chrome.runtime.lastError); } catch (_) {} }
  });
  window.addEventListener('pageshow', (e) => { if (e.persisted) leaving = false; });

  function showToast(msg, kind, opts) {
    const o = opts || {};
    kind = kind || 'ok';
    // The setting turns off confirmations. Problems and work in progress are
    // always shown: silence after a failed grab would look like success.
    if (!cfg.toast && kind === 'ok') {
      if (o.id) dismissToast(o.id);
      return;
    }
    ui();

    const id = o.id || 'toast-' + (++toastSeq);
    let t = toasts.get(id);
    if (!t || !t.el.isConnected) {
      // The page took the old one away. Its timer must go with it, or it would
      // later dismiss the message that replaces it.
      if (t) clearTimeout(t.timer);
      const el = document.createElement('div');
      el.innerHTML = '<span class="msg"></span><button class="x" aria-label="Dismiss">&times;</button>' +
                     '<div class="bar" hidden><i></i></div><div class="acts"></div>';
      t = { el, timer: 0, life: 0 };
      toasts.set(id, t);
      el.querySelector('.x').addEventListener('click', () => dismissToast(id));
      // Reading or reaching for a button should not race the timer.
      el.addEventListener('mouseenter', () => clearTimeout(t.timer));
      el.addEventListener('mouseleave', () => { if (t.life) t.timer = setTimeout(() => dismissToast(id), 1500); });
      toastList.appendChild(el);
      requestAnimationFrame(() => el.classList.add('on'));

      // Keep the stack short; work in progress is never the one dropped.
      const open = Array.from(toasts.entries());
      for (const [oldId, old] of open) {
        if (toasts.size <= MAX_TOASTS) break;
        if (oldId !== id && old.life) dismissToast(oldId);
      }
    }

    const el = t.el;
    el.className = 'toast ' + kind + (el.classList.contains('on') ? ' on' : '');
    el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    el.dataset.seq = String(++toastSeq);
    el.querySelector('.msg').textContent = msg;

    const bar = el.querySelector('.bar');
    bar.hidden = o.progress == null;
    if (o.progress != null) bar.firstChild.style.width = Math.max(0, Math.min(100, o.progress)) + '%';

    const acts = el.querySelector('.acts');
    acts.textContent = '';
    for (const a of o.actions || []) {
      const b = document.createElement('button');
      b.textContent = a.label;
      b.addEventListener('click', () => { ask(a.send); if (a.close !== false) dismissToast(id); });
      acts.appendChild(b);
    }

    t.life = o.sticky ? 0 : (kind === 'err' ? 8000 : (o.actions && o.actions.length ? 6000 : 3000));
    // The end of a job that ran in the background, which the user was
    // probably not watching: it stays long enough to be noticed.
    if (o.linger && t.life) t.life = Math.max(t.life, 15000);
    // Kept so it can be shown again if this page goes away under it.
    t.kept = o.linger && t.life ? { text: msg, kind, opts: { id: o.id, actions: o.actions || [] } } : null;
    armToast(id);
  }

  // "Show in folder" for a download Chrome knows by id.
  const showAction = (downloadId) => (downloadId != null
    ? [{ label: 'Show in folder', send: { type: 'showDownload', id: downloadId } }]
    : []);

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

  const toBase64 = (blob) => new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1] || '');
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });

  function dataUrlToBlob(dataUrl) {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return null;
    const head = dataUrl.slice(5, comma);
    const body = dataUrl.slice(comma + 1);
    const mime = head.split(';')[0] || 'application/octet-stream';
    try {
      if (/;base64/i.test(head)) {
        const bin = atob(body);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: mime });
      }
      return new Blob([decodeURIComponent(body)], { type: mime });
    } catch (_) {
      return null;
    }
  }

  // Messages carry text, so bytes travel as base64, a few megabytes at a time.
  const CHUNK = 6 * 1024 * 1024;

  // Save bytes that exist only in this page: a canvas, a screenshot, a file
  // the page fetched with its own cookies. They are passed in chunks to the
  // extension's worker page, which can hand them to the downloader with the
  // folder setting applied, at any size. An anchor click cannot carry a folder,
  // so it is kept only for when the extension cannot be reached, and the
  // caller is told when it was used.
  async function saveBlob(blob, path) {
    const open = await ask({ type: 'blobOpen' });
    if (open && open.ok) {
      const id = 'up-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      let sent = blob.size > 0;
      for (let at = 0; at < blob.size && sent; at += CHUNK) {
        const r = await ask({ type: 'blobPart', id, b64: await toBase64(blob.slice(at, at + CHUNK)) });
        sent = !!(r && r.ok);
      }
      if (sent) {
        const res = await ask({ type: 'blobSave', id, mime: blob.type, filename: path });
        if (res && res.ok) return { name: res.filename, filed: true, id: res.id };
        if (res && res.cancelled) return { name: '', cancelled: true };
      }
    }
    const name = String(path).split('/').pop();
    await pageDownload(URL.createObjectURL(blob), name, true);
    return { name, filed: false };
  }

  const savedText = (saved) => saved.name + (saved.filed ? '' : ' (in Downloads, outside your Snaffle folder)');

  // Say that a file was saved - unless the user cancelled the Save As dialog,
  // in which case there is nothing to say.
  function announce(prefix, saved, suffix, kind, toastId) {
    if (saved.cancelled) { if (toastId) dismissToast(toastId); return; }
    toast(prefix + savedText(saved) + (suffix || ''), kind || 'ok', { id: toastId, actions: showAction(saved.id) });
  }

  // The browser could not fetch it alone. The page can try with its own
  // cookies and Referer, and the extension's worker page after that.
  async function fallback(url, path) {
    let reason = '';
    try {
      const r = await fetch(url, { credentials: 'include', referrer: location.href });
      if (!r.ok) throw new Error('the site answered ' + r.status);
      const blob = await r.blob();
      if (!blob.size) throw new Error('the site sent an empty file');
      if (S.notMedia(blob.type)) throw new Error('the site sent a web page instead of a file');
      return { ok: true, saved: await saveBlob(blob, path) };
    } catch (e) {
      reason = (e && e.message) || String(e);
    }
    const res = await ask({ type: 'proxyGrab', url, filename: path });
    if (res && res.ok) return { ok: true, saved: { name: res.filename, filed: true, id: res.id } };
    if (res && res.cancelled) return { ok: true, saved: { name: '', cancelled: true } };
    // "Failed to fetch" is the browser's word for a cross-origin refusal; the
    // extension's own attempt says more about what the site actually did.
    return { ok: false, reason: (res && res.error) || reason };
  }

  /* ------------------------------------------------------ streamed video */

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

  // The same for Instagram, where a file's own name is a long number: the
  // account, the post's short code, and which picture of the post it is, so
  // that a saved file can be traced back to where it came from.
  const IG_POST = /^\/(?:([A-Za-z0-9._]+)\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/;
  const IG_NOT_A_USER = /^(p|reel|reels|tv|explore|accounts|direct|stories|about|legal|web|api)$/i;

  function instagramInfo(el, slide) {
    if (!/(^|\.)instagram\.com$/i.test(location.hostname)) return null;
    const read = (href) => {
      try {
        const m = IG_POST.exec(new URL(href, location.href).pathname);
        return m ? { user: m[1] && !IG_NOT_A_USER.test(m[1]) ? m[1] : '', id: m[2] } : null;
      } catch (_) { return null; }
    };

    // On a post's own page the address says which post it is. In a feed it
    // is the nearest enclosing post that links to itself.
    let post = read(location.href);
    let index = post ? new URL(location.href).searchParams.get('img_index') || '' : '';
    let scope = null;
    if (!post) {
      let node = el;
      for (let i = 0; i < 16 && node && !post; i++, node = node.parentElement) {
        if (!node.querySelectorAll) continue;
        for (const a of node.querySelectorAll('a[href]')) {
          post = read(a.getAttribute('href'));
          if (post) { scope = node; break; }
        }
      }
      index = '';
    }
    if (!post) return null;

    if (!post.user) {
      // The page's own canonical address often carries the account name.
      for (const sel of ['link[rel="canonical"]', 'meta[property="og:url"]']) {
        const tag = document.querySelector(sel);
        const other = tag && read(tag.getAttribute('href') || tag.getAttribute('content') || '');
        if (other && other.id === post.id && other.user) { post.user = other.user; break; }
      }
    }
    if (!post.user) {
      // Otherwise the first link to a profile in the post is its author.
      for (const a of (scope || document).querySelectorAll('a[href]')) {
        const m = /^\/([A-Za-z0-9._]+)\/?$/.exec(a.getAttribute('href') || '');
        if (m && !IG_NOT_A_USER.test(m[1])) { post.user = m[1]; break; }
      }
    }
    // Which slide of the post: as told by whoever is stepping through it,
    // else read off the post's own row of slides, else from the address.
    const car = !slide && el ? carouselOf(el) : null;
    const number = slide || (car ? car.indexOf(car.slide) + 1 : 0) || (/^\d+$/.test(index) ? Number(index) : 0);
    const name = [post.user, post.id, number ? String(number) : ''].filter(Boolean).join('-');
    return { user: post.user, id: post.id, index: number ? String(number) : '', name };
  }

  const hostToken = () => location.hostname.replace(/^www\./, '');

  // Stream jobs this tab has running. The service worker tells every frame
  // when one starts and ends, so Escape can cancel from wherever focus is.
  let streaming = 0;

  // A streamed video is rebuilt by the extension's worker page, not here: it
  // takes a while, it should not block other grabs, and it should survive this
  // page navigating away. Returns what became of it, or null when no stream
  // was ever seen for this video.
  //
  // `part` is set when this video is one item of a whole post being saved:
  // { batch, slide }. Then nothing is said here - the post keeps one running
  // message for all of it - and the outcome is handed back instead:
  // { ok, name, id } saved, { ok: false, error }, { cancelled } or { job }
  // for a download now running in the background.
  async function grabStream(videoEl, part, hit) {
    const say = part ? () => {} : toast;
    const mediaId = streamMediaId(videoEl);
    const who = statusInfo(videoEl);
    const ig = instagramInfo(videoEl, hit && hit.slide);
    const tokens = {
      name: ig ? ig.name : who ? who.user + '-' + who.id + (hit && hit.part ? '-' + hit.part : '') : (mediaId ? 'video-' + mediaId : 'video'),
      ext: 'mp4', kind: 'video', host: hostToken(), title: document.title || '', alt: ''
    };
    // The video's exact length and shape tell it from the others a page has
    // loaded: the slides either side of this one, the next posts in a feed.
    const duration = Number.isFinite(videoEl.duration) ? videoEl.duration : 0;
    const res = await ask({
      type: 'grabStream', mediaId, tokens, duration, width: videoEl.videoWidth || 0, height: videoEl.videoHeight || 0,
      pageUrl: location.href, batch: part ? part.batch : null
    });
    if (!res || !res.found) return null;

    // The page was given a whole file after all.
    if (res.direct) {
      if (res.cancelled) return { cancelled: true };
      if (res.ok) {
        say('Saved ' + res.filename + (res.guess || ''), res.guess ? 'warn' : 'ok', { actions: showAction(res.id) });
        return { ok: true, name: res.filename, id: res.id, note: res.guess || '' };
      }
      const fb = await fallback(res.url, res.filename || tokens.name + '.mp4');
      if (fb.ok) {
        if (!part) announce('Saved ', fb.saved, res.guess, res.guess ? 'warn' : 'ok');
        return fb.saved.cancelled ? { cancelled: true } : { ok: true, name: savedText(fb.saved), id: fb.saved.id, note: res.guess || '' };
      }
      const why = fb.reason || res.error || 'the site blocked it';
      say('Could not save this video: ' + why, 'err');
      return { ok: false, error: why };
    }

    if (!res.started) {
      const why = res.error || 'the download did not start';
      say('Could not save this video: ' + why, 'err');
      return { ok: false, error: why };
    }
    say('Reading the stream...', 'busy', {
      id: res.id, sticky: true, progress: 0,
      actions: [{ label: 'Cancel', send: { type: 'cancelStreams', id: res.id }, close: false }]
    });
    return { job: res.id };
  }

  window.addEventListener('keydown', (e) => {
    if (dead || e.key !== 'Escape') return;
    // A post being stepped through stops at the slide it is on.
    for (const b of batches.values()) if (b.sweeping) b.stop = true;
    if (streaming) ask({ type: 'cancelStreams' });
  }, true);

  // The guard is claimed before the first await, so a double tap cannot start
  // two assemblies of the same video.
  async function grab() {
    if (dead) return;
    if (!alive()) {
      // The extension was updated or removed and this copy was not replaced.
      dead = true;
      showToast('Snaffle was updated. Reload this page to use it here.', 'warn');
      return;
    }
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
    const hit = resolve(elementStack());
    if (!hit) { toast('No image or video under the cursor', 'warn'); return; }
    await saveHit(hit, null);
  }

  // Save one thing the resolver found. On its own (`part` null) it reports
  // with toasts as it goes. As one item of a whole post (`part` is
  // { batch, slide }) it says nothing and hands back what happened, in the
  // shapes grabStream() describes, for the post's own running message.
  async function saveHit(hit, part) {
    const say = part ? () => {} : toast;
    const done = (saved) => (saved.cancelled ? { cancelled: true } : { ok: true, name: savedText(saved), id: saved.id });

    // Canvas and SVG are only encoded now that a grab is really happening.
    if (hit.make) {
      const made = hit.make();
      if (made.error) { say(made.error, 'err'); return { ok: false, error: made.error }; }
      hit = Object.assign({}, hit, { url: made.url, make: null });
    }

    // Streamed (MSE) video: its blob URL is not fetchable, so rebuild it from
    // the HLS playlist the player used. Poster frame is the last resort.
    let coverOnly = false;
    if (hit.kind === 'video' && (hit.stream || (hit.url.startsWith('blob:') && !(await canFetch(hit.url))))) {
      if (cfg.streamAssembly !== false && hit.el) {
        if (!part) flash(hit.el);
        const taken = await grabStream(hit.el, part, hit);
        if (taken) return taken;
      }
      if (cfg.posterFallback && hit.poster) {
        hit = { url: hit.poster, kind: 'image', el: hit.el, posterFallbackUsed: true, slide: hit.slide, part: hit.part };
        coverOnly = true;
      } else {
        const why = 'This video is streamed in segments and cannot be saved directly.';
        say(why, 'err');
        return { ok: false, error: 'the video is streamed in pieces and none of them were seen loading' };
      }
    }

    if (!part) flash(hit.el);
    const prefix = hit.posterFallbackUsed ? 'Streamed video - saved poster: ' : 'Saved ';
    const note = coverOnly ? 'only the still picture of the video was saved' : '';

    // Bytes that exist only in this page: an encoded canvas, an inline SVG, an
    // image the page built in memory.
    if (/^(data|blob):/i.test(hit.url)) {
      const tok = tokensFor(hit);
      const named = await ask({ type: 'buildName', tokens: tok });
      const blob = /^data:/i.test(hit.url) ? dataUrlToBlob(hit.url) : await (await fetch(hit.url)).blob();
      if (!blob) { say('That image could not be read.', 'err'); return { ok: false, error: 'the image could not be read' }; }
      const saved = await saveBlob(blob, (named && named.path) || tok.name + '.' + tok.ext);
      if (!part) announce(prefix, saved);
      return Object.assign(done(saved), { note });
    }

    // Try the best address first, then each fallback, ending with the one the
    // page itself loaded. The service worker answers only once the server has,
    // so "Saved" means a real file of the right kind is arriving.
    const candidates = [hit.url].concat(hit.alts || []).map((u) => ({ url: u, tokens: tokensFor(hit, u) }));
    const tid = 'grab-' + Date.now();
    const slow = part ? 0 : setTimeout(() => toast('Saving...', 'busy', { id: tid, sticky: true }), 600);
    const res = await ask({ type: 'grab', candidates, pageUrl: location.href });
    clearTimeout(slow);
    if (res && res.ok) {
      say(prefix + res.filename, 'ok', { id: tid, actions: showAction(res.id) });
      return { ok: true, name: res.filename, id: res.id, note };
    }
    if (res && res.cancelled) { say('Cancelled.', 'warn', { id: tid }); return { cancelled: true }; }

    const last = candidates[candidates.length - 1];
    const fb = await fallback(last.url, (res && res.filename) || last.tokens.name + '.' + last.tokens.ext);
    if (fb.ok) {
      if (!part) announce(prefix, fb.saved, '', 'ok', tid);
      return Object.assign(done(fb.saved), { note });
    }
    const why = fb.reason || (res && res.error) || 'the site blocked it';
    say('Could not save this: ' + why, 'err', { id: tid });
    return { ok: false, error: why };
  }

  /* ---------------------------------------------------------- a whole post */

  // A post with several slides, built the way Instagram builds one: a row
  // whose items are each put in place by a sideways transform, of which only
  // the slide on show and its neighbours are in the page at any moment, a
  // frame that row slides through, and a button at each side to step along.
  // Nothing here goes by the site's class names or by the wording of its
  // buttons, both of which change; it goes by how the thing is laid out.
  const SLIDE_X = /translateX\(\s*(-?[\d.]+)px/;
  const slideX = (el) => {
    const m = SLIDE_X.exec((el.getAttribute && el.getAttribute('style')) || '');
    return m ? parseFloat(m[1]) : null;
  };

  function carouselOf(el) {
    let inside = el;
    for (const row of ancestors(el).slice(1)) {
      // `inside` is the child of `row` that the element sits in.
      const kids = row.children ? Array.from(row.children) : [];
      const placed = kids.filter((k) => slideX(k) != null);
      const slide = inside;
      inside = row;
      if (placed.length < 2 || !placed.includes(slide)) continue;
      const width = slide.getBoundingClientRect().width;
      if (width < 50) continue;

      // The frame is the nearest box around the row that is one slide wide
      // and has more than that to scroll through.
      let frame = null;
      for (let n = row.parentElement, up = 0; n && up < 4; n = n.parentElement, up++) {
        if (Math.abs(n.clientWidth - width) <= 2 && n.scrollWidth > n.clientWidth + 2) { frame = n; break; }
      }
      const car = {
        row, slide, width, frame: frame || row.parentElement || row,
        indexOf: (s) => Math.round((slideX(s) || 0) / width),
        // Slides in the page right now, by number from 0.
        at: (i) => Array.from(row.children).find((k) => slideX(k) != null && k.querySelector('img, video') && Math.round(slideX(k) / width) === i) || null,
        count() {
          if (frame) return Math.max(1, Math.round(frame.scrollWidth / width));
          // Failing that, the row ends in a marker one pixel wide, placed
          // where the last slide ends.
          const end = Array.from(row.children).filter((k) => slideX(k) != null && !k.querySelector('img, video')).pop();
          return end ? Math.max(1, Math.round((slideX(end) + 1) / width)) : 0;
        }
      };
      return car;
    }
    return null;
  }

  // The button that steps a row of slides on (dir 1) or back (dir -1): a
  // small control lying over the frame, half-way up, at that side of it.
  function stepButton(car, dir) {
    const box = car.frame.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    let root = car.frame;
    for (let up = 0; up < 6 && root.parentElement; up++) {
      root = root.parentElement;
      for (const b of root.querySelectorAll('button, [role="button"]')) {
        if (car.row.contains(b)) continue;
        const q = b.getBoundingClientRect();
        if (!q.width || !q.height || q.width > box.width / 3) continue;
        const cx = q.left + q.width / 2, cy = q.top + q.height / 2;
        if (cx <= box.left || cx >= box.right) continue;
        if (Math.abs(cy - (box.top + box.height / 2)) > box.height * 0.3) continue;
        const side = cx > box.left + box.width * 0.75 ? 1 : cx < box.left + box.width * 0.25 ? -1 : 0;
        if (side === dir) return b;
      }
    }
    return null;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (test, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (test()) return true; await sleep(100); }
    return test();
  };
  const biggest = (list) => Array.from(list).map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter((x) => x.r.width && x.r.height).sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height).map((x) => x.el)[0] || null;

  // What one slide holds: its video once the player has loaded it, with the
  // cover picture as the fallback, or else its picture.
  async function slideHit(li) {
    const v = li.querySelector('video');
    if (v) await until(() => v.readyState >= 1 || !v.isConnected, 6000);
    const img = biggest(li.querySelectorAll('img'));
    if (img) await until(() => img.complete, 3000);
    const cover = img ? fromImg(img) : null;
    if (v && hasMedia(v)) {
      const hit = fromVideo(v);
      if (hit && hit.kind === 'video') return Object.assign({}, hit, { poster: hit.poster || (cover && cover.url) || '' });
    }
    return cover;
  }

  // Posts being saved whole: id -> { total, at, items, jobs, sweeping, stop }.
  const batches = new Map();

  // One running message for the whole post, rewritten as things happen.
  function renderBatch(b) {
    const jobs = Array.from(b.jobs.values());
    const live = jobs.filter((j) => !j.done);
    const saved = b.items.filter((x) => x.ok).length + jobs.filter((j) => j.done && j.ok).length;
    const missed = b.items.filter((x) => !x.ok && !x.cancelled && !x.job)
      .concat(jobs.filter((j) => j.done && !j.ok && !j.cancelled));
    const asked = b.items.length;

    if (b.sweeping) {
      toast('Saving this post: ' + (b.total ? b.at + ' of ' + b.total : 'slide ' + b.at) + '... (Esc to stop)', 'busy',
        { id: b.id, sticky: true, progress: b.total ? Math.round(((b.at - 1) / b.total) * 100) : null });
      return;
    }
    if (live.length) {
      const stuck = live.find((j) => j.state === 'stalled');
      const pct = Math.round(live.reduce((n, j) => n + (j.pct || 0), 0) / live.length);
      const what = live.length === 1 ? '1 video' : live.length + ' videos';
      toast(stuck
        ? 'Saved ' + saved + ' of ' + asked + ' from this post. A video download stalled at ' + (stuck.pct || 0) + '%. ' +
          (stuck.attempt ? 'Trying again (' + stuck.attempt + ' of ' + stuck.of + ')...' : 'Waiting for the site...')
        : 'Saved ' + saved + ' of ' + asked + ' from this post. ' + what + ' still downloading: ' + pct + '%',
        stuck ? 'warn' : 'busy',
        { id: b.id, sticky: true, progress: pct, actions: [{ label: 'Cancel', send: { type: 'cancelStreams' }, close: false }] });
      return;
    }

    batches.delete(b.id);
    const names = b.items.filter((x) => x.ok && x.name).map((x) => x.name).concat(jobs.filter((j) => j.ok && j.name).map((j) => j.name));
    const folder = names.length && names[0].includes('/') ? names[0].slice(0, names[0].lastIndexOf('/')) : '';
    const lastId = b.items.concat(jobs).map((x) => x.id || x.downloadId).filter((x) => x != null).pop();
    const label = (x) => (b.total > 1 || asked > 1 ? 'item ' + x.n + ' (' : '(') + (x.error || 'not saved') + ')';
    const notes = b.items.concat(jobs).filter((x) => x.ok && x.note).map((x) => 'item ' + x.n + ': ' + String(x.note).replace(/^ - /, ''));
    const dropped = b.items.filter((x) => x.cancelled).length + jobs.filter((j) => j.cancelled).length;
    const stopped = (b.stop ? ' Stopped before the end.' : '') + (dropped ? ' ' + dropped + ' cancelled.' : '');
    if (!asked) {
      toast(b.stop ? 'Stopped before anything was saved.' : 'Nothing in this post could be saved.', b.stop ? 'warn' : 'err', { id: b.id, linger: true });
      return;
    }
    if (!missed.length && saved === asked) {
      toast('Saved all ' + saved + ' from this post' + (folder ? ' to ' + folder : '') + '.' + stopped + (notes.length ? ' Note - ' + notes.join('; ') : ''),
        notes.length || stopped ? 'warn' : 'ok', { id: b.id, linger: true, actions: showAction(lastId) });
      return;
    }
    toast('Saved ' + saved + ' of ' + asked + ' from this post' + (folder ? ' to ' + folder : '') + '.' + stopped +
      (missed.length ? ' Not saved: ' + missed.map(label).join(', ') + '.' : '') + (notes.length ? ' Note - ' + notes.join('; ') : ''),
      saved ? 'warn' : 'err', { id: b.id, linger: true, actions: showAction(lastId) });
  }

  // Save one item of a post and file what happened under the post.
  async function saveItem(b, hit, n, slide) {
    let out;
    try {
      out = hit ? await saveHit(hit, { batch: b.id, slide }) : { ok: false, error: 'nothing on this slide could be read' };
    } catch (e) {
      out = { ok: false, error: String((e && e.message) || e) };
    }
    out.n = n;
    b.items.push(out);
    if (out.job) {
      // A video now downloading in the background. News of it comes later.
      const j = b.jobs.get(out.job) || { pct: 0 };
      j.n = n;
      b.jobs.set(out.job, j);
    }
  }

  // Step through every slide of a carousel, saving each, and put the post
  // back on the slide it was showing.
  async function sweep(car, b) {
    const step = async (dir) => {
      const btn = stepButton(car, dir);
      if (!btn) return false;
      btn.click();
      await sleep(350);
      return true;
    };
    let start = 0;
    while (start < 40 && await step(-1)) start++;

    b.total = car.count();
    let pos = 0;
    for (; pos < 40; pos++) {
      if (b.stop || !car.row.isConnected) break;
      b.at = pos + 1;
      renderBatch(b);
      await until(() => !!car.at(pos), 3000);
      const li = car.at(pos);
      const hit = li ? await slideHit(li) : null;
      if (hit) hit.slide = pos + 1;
      await saveItem(b, hit, pos + 1, pos + 1);
      if (b.total && pos + 1 >= b.total) break;
      if (b.stop || !(await step(1))) break;
    }
    // Back to where the user was.
    for (let i = 0; i < 40 && pos > start; i++, pos--) if (!(await step(-1))) break;
    for (let i = 0; i < 40 && pos < start; i++, pos++) if (!(await step(1))) break;
  }

  // Without slides to step through, a post is whatever encloses the thing
  // under the pointer: every picture and video of any size inside it.
  function postItems(hit) {
    const POST = 'article, [role="article"]';
    const el = hit.el && hit.el.closest ? hit.el : null;
    const scope = el && (el.closest(POST) || el.closest('figure'));
    if (!scope) return [hit];
    const out = [], seen = new Set();
    const add = (h) => {
      const key = h && (h.url || h.el);
      if (!h || seen.has(key)) return;
      seen.add(key);
      out.push(h);
    };
    const videos = Array.from(scope.querySelectorAll('video'));
    for (const m of scope.querySelectorAll('img, video')) {
      if (out.length >= 40) break;
      // A post quoted inside this one is a post of its own.
      if (scope.matches(POST) && m.closest(POST) !== scope) continue;
      const r = m.getBoundingClientRect();
      if (r.width < 100 || r.height < 100) continue;
      // A cover picture lying over a video is that video, listed once.
      if (m.tagName === 'IMG' && videos.some((v) => {
        const q = v.getBoundingClientRect();
        return Math.abs(q.left - r.left) <= 4 && Math.abs(q.top - r.top) <= 4 && Math.abs(q.width - r.width) <= 8 && Math.abs(q.height - r.height) <= 8;
      })) continue;
      add(mediaFrom(m));
    }
    if (hit.el && !out.some((h) => h.el === hit.el)) add(hit);
    return out.length ? out : [hit];
  }

  async function runPost() {
    const hit = resolve(elementStack());
    if (!hit) { toast('No post under the cursor', 'warn'); return; }
    const b = { id: 'post-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), total: 0, at: 0, items: [], jobs: new Map(), sweeping: true, stop: false };
    batches.set(b.id, b);
    if (hit.el) flash(hit.el);
    try {
      const car = hit.el ? carouselOf(hit.el) : null;
      if (car && car.count() > 1) {
        await sweep(car, b);
      } else {
        const list = postItems(hit);
        if (list.length === 1) {
          // Nothing around it to make a post of: the one thing, saved and
          // reported the ordinary way.
          batches.delete(b.id);
          b.single = true;
          await saveHit(list[0], null);
          return;
        }
        b.total = list.length;
        for (let i = 0; i < list.length && !b.stop; i++) {
          b.at = i + 1;
          renderBatch(b);
          if (list.length > 1) list[i].part = i + 1;
          await saveItem(b, list[i], i + 1, 0);
        }
      }
    } finally {
      b.sweeping = false;
      if (!b.single) renderBatch(b);
    }
  }

  // News of a video belonging to a post this frame is saving.
  function batchNews(msg) {
    const b = batches.get(msg.batch);
    if (!b) return false;
    const j = b.jobs.get(msg.id) || { n: 0, pct: 0 };
    b.jobs.set(msg.id, j);
    if (msg.done) {
      Object.assign(j, { done: true, ok: !!msg.ok, cancelled: !!msg.cancelled, name: msg.filename || '', error: msg.error || '', note: msg.note || '', downloadId: msg.downloadId });
    } else {
      Object.assign(j, { pct: msg.pct || 0, state: msg.state || '', attempt: msg.attempt || 0, of: msg.of || 0 });
    }
    if (!b.sweeping) renderBatch(b);
    return true;
  }

  async function post() {
    if (dead) return;
    if (!alive()) {
      dead = true;
      showToast('Snaffle was updated. Reload this page to use it here.', 'warn');
      return;
    }
    if (!cfg.enabled || busy) return;
    busy = true;
    try {
      await runPost();
    } catch (e) {
      toast('Could not save this post: ' + ((e && e.message) || e), 'err');
    } finally {
      busy = false;
    }
  }

  /* ----------------------------------------------- shared with sibling files */

  // capture.js and gallery.js are separate content scripts in the same isolated
  // world. They attach themselves to this object and borrow the UI and the
  // download plumbing rather than duplicating it.
  const api = {
    get cfg() { return cfg; },
    alive,
    retire() { dead = true; if (shadowHost) shadowHost.remove(); },
    ui, toast, dismissToast, showAction, flash, ask, pageDownload, toBase64, saveBlob, savedText, announce, fallback,
    resolve, elementStack, ancestors, tokensFor, statusInfo, instagramInfo, hostToken,
    fromImg, fromVideo, fromBackground, linkFor, fallbacks,
    abs, upgrade, parseSrcset, grab, post, carouselOf, stepButton, postItems,
    capture: null,        // set by capture.js when it is loaded on demand
    gallery: null,        // set by gallery.js likewise, in the top frame
    galleryLoaded: false  // set by gallery.js in every frame it is loaded into
  };
  window.__SNAFFLE = api;

  /* ------------------------------------------------------------ triggers */

  const modsMatch = (t, e) => !!t.ctrl === e.ctrlKey && !!t.alt === e.altKey && !!t.shift === e.shiftKey && !!t.meta === e.metaKey;

  function isTyping(e) {
    // Inside a shadow root the event's target is the host; the first entry
    // of the composed path is the element actually being typed into.
    const el = (e && ((e.composedPath && e.composedPath()[0]) || e.target)) || document.activeElement;
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
    if (pointerHere() && !overFrame()) { grab(); return; }
    ask({ type: 'relayGrab' }).then((r) => {
      if (!r || !r.handled) toast('No image or video under the cursor', 'warn');
    });
  }

  // The same for saving the whole post the pointer is on.
  function keyPost() {
    if (pointerHere() && !overFrame()) { post(); return; }
    ask({ type: 'relayGrab', what: 'post' }).then((r) => {
      if (!r || !r.handled) toast('No post under the cursor', 'warn');
    });
  }

  // The screenshot and media-list code is not in the page until it is asked
  // for. The service worker loads it into the top frame and starts it, which
  // also covers a key pressed while focus is inside an iframe.
  function runFeature(name) {
    ask({ type: 'feature', name }).then((r) => { if (r && r.error) toast(r.error, 'err'); });
  }

  // Each binding is checked against the same event, most specific first - a
  // three-modifier combo must win over a two-modifier one that shares its key.
  const KEY_ACTIONS = [
    ['captureKey', () => runFeature('capture')],
    ['galleryKey', () => runFeature('gallery')],
    ['postKey', keyPost],
    ['key', keyGrab]
  ];

  window.addEventListener('keydown', (e) => {
    if (dead || !cfg.enabled || e.repeat || isTyping(e)) return;
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
      if (dead) return;
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
    if (!msg || dead) return false;
    if (msg.type === 'grabNow') {
      // Broadcast to every frame. Only the one the pointer is in answers, so
      // the sender can tell whether anybody took it.
      if (!pointerHere() || overFrame()) return false;
      if (msg.what === 'post') post(); else grab();
      send({ handled: true });
    } else if (msg.type === 'downloadFailed') {
      // A download that started and then died. Never leave "Saved" standing.
      fallback(msg.url, msg.filename).then((fb) => {
        if (fb.ok) announce('Saved ', fb.saved);
        else toast('Could not save ' + String(msg.filename).split('/').pop() + ': ' + (fb.reason || msg.error || 'the site blocked it'), 'err');
      });
      send({ ok: true });
    } else if (msg.type === 'batchNews') {
      // Only the frame that is saving that post answers, so the sender can
      // tell when nobody is and show the news the ordinary way.
      if (!batchNews(msg)) return false;
      send({ taken: true });
    } else if (msg.type === 'toast') {
      // No answer from a page on its way out, so the sender tries again.
      if (leaving) return false;
      if (window.top === window) showToast(msg.text, msg.kind, msg.opts);
      send({ ok: true });
    } else if (msg.type === 'streamStarted') { streaming++; send({ ok: true }); }
    else if (msg.type === 'streamEnded') { streaming = Math.max(0, streaming - 1); send({ ok: true }); }
    else if (msg.type === 'captureNow') { if (api.capture) api.capture(); send({ ok: true }); }
    else if (msg.type === 'galleryNow') { if (api.gallery) api.gallery(); send({ ok: true }); }
    return false;
  });
})();
