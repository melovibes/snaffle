/* Snaffle - page media gallery. Lists every image and video on the page
   (across frames), filters them, and bulk-downloads the selection. */
(() => {
  const api = window.__SNAFFLE;
  // Loaded into the tab each time it is asked for; only the first copy stays.
  if (!api || api.galleryLoaded) return;
  api.galleryLoaded = true;

  const MEDIA_HREF = /\.(jpe?g|png|gif|webp|avif|bmp|svg|mp4|webm|mov|m4v)(?=$|[?#])/i;
  const BG_SCAN_LIMIT = 4000;

  /* ------------------------------------------------- per-frame collection */

  // Cross-origin responses without Timing-Allow-Origin report 0 here, so a
  // size is shown only when the browser actually tells us one.
  function resourceSizes() {
    const sizes = new Map();
    try {
      for (const e of performance.getEntriesByType('resource')) {
        const n = e.encodedBodySize || e.transferSize || 0;
        if (n) sizes.set(e.name, n);
      }
    } catch (_) {}
    return sizes;
  }

  function collectFrame() {
    const sizes = resourceSizes();
    const seen = new Set();
    const items = [];

    const add = (hit, el) => {
      if (!hit || !hit.url) return;
      const u = hit.url;
      if (seen.has(u)) return;
      if (/^data:/i.test(u) && u.length > 1e6) return;   // skip giant inline blobs
      seen.add(u);
      items.push({
        url: u,
        kind: hit.kind || 'image',
        w: (el && el.naturalWidth) || 0,
        h: (el && el.naturalHeight) || 0,
        bytes: sizes.get(u) || 0,
        alt: (el && el.alt) || ''
      });
    };

    for (const img of document.images) add(api.fromImg(img), img);

    for (const v of document.querySelectorAll('video')) {
      const hit = api.fromVideo(v);
      if (hit && hit.url && !/^blob:/i.test(hit.url)) add(hit, null);
      if (v.poster) add({ url: api.abs(v.poster, v), kind: 'image' }, null);
    }

    let scanned = 0;
    for (const el of document.querySelectorAll('*')) {
      if (++scanned > BG_SCAN_LIMIT) break;
      add(api.fromBackground(el), null);
    }

    for (const a of document.querySelectorAll('a[href]')) {
      const href = api.abs(a.getAttribute('href'), a);
      if (href && MEDIA_HREF.test(href)) {
        add({ url: api.upgrade(href), kind: /\.(mp4|webm|mov|m4v)(?=$|[?#])/i.test(href) ? 'video' : 'image' }, null);
      }
    }

    return items;
  }

  chrome.runtime.onMessage.addListener((msg, _s, send) => {
    if (!msg || msg.type !== 'collectMediaFrame') return false;
    let items = [];
    try { items = collectFrame(); } catch (_) {}
    chrome.runtime.sendMessage({ type: 'mediaFound', token: msg.token, items }, () => void chrome.runtime.lastError);
    send({ ok: true });
    return false;
  });

  // Everything below renders the panel, which belongs to the top frame only.
  if (window.top !== window) return;

  /* ------------------------------------------------------------ panel UI */

  const CSS = `
    :host { all: initial; }
    .wrap {
      position: fixed; inset: 24px; z-index: 2147483646;
      display: flex; flex-direction: column;
      background: #0f1115; color: #e5e7eb;
      border: 1px solid #2a2f3a; border-radius: 14px;
      box-shadow: 0 24px 64px rgba(0,0,0,.55);
      font: 13px/1.45 ui-sans-serif, system-ui, "Segoe UI", sans-serif;
      overflow: hidden;
    }
    header {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      padding: 12px 14px; border-bottom: 1px solid #2a2f3a; background: #171a21;
    }
    h2 { margin: 0; font-size: 14px; font-weight: 650; }
    .count { color: #9ca3af; }
    .spacer { flex: 1; }
    input[type=search], input[type=number] {
      background: #0f1115; color: #e5e7eb; border: 1px solid #2a2f3a;
      border-radius: 7px; padding: 6px 9px; font: inherit;
    }
    input[type=search] { width: 190px; }
    input[type=number] { width: 68px; }
    label.min { color: #9ca3af; display: flex; align-items: center; gap: 6px; }
    .chips { display: flex; gap: 5px; }
    .chip {
      border: 1px solid #2a2f3a; background: #0f1115; color: #9ca3af;
      border-radius: 999px; padding: 4px 10px; cursor: pointer; font: inherit;
    }
    .chip[aria-pressed="true"] { background: #1d4ed8; border-color: #1d4ed8; color: #fff; }
    button {
      border: 1px solid #2a2f3a; background: #0f1115; color: #e5e7eb;
      border-radius: 7px; padding: 6px 11px; cursor: pointer; font: inherit;
    }
    button:hover { border-color: #3b82f6; }
    button.primary { background: #2563eb; border-color: #2563eb; color: #fff; font-weight: 600; }
    button.primary[disabled] { opacity: .45; cursor: default; border-color: #2a2f3a; background: #1f2430; }
    button.close { font-size: 17px; line-height: 1; padding: 4px 9px; }
    .grid {
      flex: 1; overflow: auto; padding: 14px;
      display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px;
      align-content: start;
    }
    .card {
      border: 1px solid #2a2f3a; border-radius: 10px; overflow: hidden;
      background: #171a21; cursor: pointer; position: relative;
    }
    .card[aria-selected="true"] { border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,.35); }
    .thumb {
      height: 110px; display: flex; align-items: center; justify-content: center;
      background: repeating-conic-gradient(#1b1f27 0% 25%, #141821 0% 50%) 50% / 16px 16px;
    }
    .thumb img, .thumb video { max-width: 100%; max-height: 110px; display: block; }
    .meta { padding: 7px 9px; font-size: 11px; color: #9ca3af; }
    .meta b { display: block; color: #e5e7eb; font-weight: 600; font-size: 11px;
              white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tick {
      position: absolute; top: 7px; left: 7px; width: 18px; height: 18px;
      border-radius: 5px; border: 1px solid #4b5563; background: rgba(15,17,21,.8);
    }
    .card[aria-selected="true"] .tick { background: #2563eb; border-color: #2563eb; }
    .card[aria-selected="true"] .tick::after {
      content: ""; position: absolute; left: 5px; top: 2px; width: 5px; height: 10px;
      border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg);
    }
    .badge {
      position: absolute; top: 7px; right: 7px; padding: 1px 6px; border-radius: 999px;
      background: rgba(15,17,21,.85); font-size: 10px; color: #e5e7eb;
    }
    .empty { padding: 40px; text-align: center; color: #9ca3af; grid-column: 1 / -1; }
  `;

  let host = null;
  let root = null;
  let all = [];
  let selected = new Set();
  let typeFilter = new Set();
  let opening = false;

  const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');

  function extOf(url) {
    const m = /\.([a-z0-9]{1,5})(?=$|[?#])/i.exec(url);
    if (m) return m[1].toLowerCase();
    const f = /[?&]format=([a-z0-9]{1,5})/i.exec(url);
    if (f) return f[1].toLowerCase();
    if (/^data:image\/([a-z0-9+]+)/i.test(url)) return RegExp.$1.replace('+xml', '').toLowerCase();
    return '';
  }

  // File-name stem from the URL, falling back to the enclosing post or the host
  // when the path is an opaque CDN key.
  function stemOf(url) {
    if (/^data:/i.test(url)) return api.hostToken();
    let seg = '';
    try {
      seg = decodeURIComponent(new URL(url, location.href).pathname.split('/').filter(Boolean).pop() || '');
    } catch (_) {}
    const dot = seg.lastIndexOf('.');
    const stem = dot > 0 ? seg.slice(0, dot) : seg;
    return stem || api.hostToken();
  }

  function build() {
    host = document.createElement('div');
    host.id = '__snaffle_gallery';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<style>' + CSS + '</style>' +
      '<div class="wrap">' +
        '<header>' +
          '<h2>Page media</h2><span class="count"></span>' +
          '<input type="search" placeholder="filter by URL">' +
          '<label class="min">min <input type="number" min="0" step="10"> px</label>' +
          '<div class="chips"></div>' +
          '<span class="spacer"></span>' +
          '<button data-act="all">Select all</button>' +
          '<button data-act="none">Clear</button>' +
          '<button data-act="dl" class="primary">Download</button>' +
          '<button data-act="close" class="close" title="Close (Esc)">&times;</button>' +
        '</header>' +
        '<div class="grid"></div>' +
      '</div>';
    document.documentElement.appendChild(host);

    root.querySelector('input[type=number]').value = api.cfg.galleryMinSize || 0;
    root.querySelector('input[type=search]').addEventListener('input', render);
    root.querySelector('input[type=number]').addEventListener('input', render);

    root.querySelector('header').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (chip) {
        const t = chip.dataset.type;
        if (typeFilter.has(t)) typeFilter.delete(t); else typeFilter.add(t);
        render();
        return;
      }
      const act = e.target.closest('button') && e.target.closest('button').dataset.act;
      if (act === 'close') close();
      else if (act === 'all') { for (const it of visible()) selected.add(it.url); render(); }
      else if (act === 'none') { selected.clear(); render(); }
      else if (act === 'dl') download();
    });

    root.querySelector('.grid').addEventListener('click', (e) => {
      const card = e.target.closest('.card');
      if (!card) return;
      const url = card.dataset.url;
      if (selected.has(url)) selected.delete(url); else selected.add(url);
      card.setAttribute('aria-selected', selected.has(url) ? 'true' : 'false');
      paintHeader();
    });

    window.addEventListener('keydown', onEsc, true);
  }

  function onEsc(e) {
    if (e.key === 'Escape' && host) { e.preventDefault(); e.stopPropagation(); close(); }
  }

  function close() {
    window.removeEventListener('keydown', onEsc, true);
    if (host) host.remove();
    host = null; root = null; all = []; selected.clear(); typeFilter.clear();
  }

  function visible() {
    const q = root.querySelector('input[type=search]').value.trim().toLowerCase();
    const min = parseInt(root.querySelector('input[type=number]').value, 10) || 0;
    return all.filter((it) => {
      if (q && it.url.toLowerCase().indexOf(q) < 0) return false;
      if (typeFilter.size && !typeFilter.has(it.ext)) return false;
      // Unmeasured items (background images, bare links) are never filtered out
      // by size, since 0 means "not known yet" rather than "tiny".
      if (min && it.w && it.h && (it.w < min && it.h < min)) return false;
      return true;
    });
  }

  function paintHeader() {
    const shown = visible().length;
    root.querySelector('.count').textContent =
      all.length + ' found' + (shown !== all.length ? ', ' + shown + ' shown' : '');
    const dl = root.querySelector('[data-act="dl"]');
    dl.textContent = selected.size ? 'Download ' + selected.size : 'Download';
    dl.disabled = selected.size === 0;
  }

  function render() {
    const chips = root.querySelector('.chips');
    const types = Array.from(new Set(all.map((i) => i.ext).filter(Boolean))).sort();
    chips.innerHTML = types.map((t) =>
      '<button class="chip" data-type="' + t + '" aria-pressed="' +
      (typeFilter.has(t) ? 'true' : 'false') + '">' + t + '</button>').join('');

    const grid = root.querySelector('.grid');
    const list = visible();
    grid.textContent = '';

    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = all.length ? 'Nothing matches those filters.' : 'No images or video found on this page.';
      grid.appendChild(empty);
      paintHeader();
      return;
    }

    for (const it of list) {
      const card = document.createElement('div');
      card.className = 'card';
      card.dataset.url = it.url;
      card.setAttribute('aria-selected', selected.has(it.url) ? 'true' : 'false');
      card.title = it.url;

      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = it.url;
      // Dimensions are unknown for background images and bare links until the
      // thumbnail decodes; fill them in then so the size filter can use them.
      img.addEventListener('load', () => {
        if (!it.w) {
          it.w = img.naturalWidth; it.h = img.naturalHeight;
          const b = card.querySelector('.dims');
          if (b) b.textContent = it.w + ' x ' + it.h;
        }
      });
      img.addEventListener('error', () => { thumb.textContent = it.kind === 'video' ? 'video' : 'no preview'; });
      thumb.appendChild(img);

      const tick = document.createElement('div');
      tick.className = 'tick';

      const meta = document.createElement('div');
      meta.className = 'meta';
      const nameEl = document.createElement('b');
      nameEl.textContent = (it.url.split('/').pop() || it.url).split('?')[0].slice(0, 40) || it.ext;
      const dims = document.createElement('span');
      dims.className = 'dims';
      dims.textContent = it.w ? it.w + ' x ' + it.h : 'size unknown';
      meta.appendChild(nameEl);
      meta.appendChild(dims);
      if (it.bytes) meta.appendChild(document.createTextNode(' - ' + kb(it.bytes)));

      if (it.kind === 'video') {
        const badge = document.createElement('div');
        badge.className = 'badge';
        badge.textContent = 'video';
        card.appendChild(badge);
      }

      card.appendChild(thumb);
      card.appendChild(tick);
      card.appendChild(meta);
      grid.appendChild(card);
    }
    paintHeader();
  }

  async function download() {
    const picks = all.filter((it) => selected.has(it.url));
    if (!picks.length) return;
    const dl = root.querySelector('[data-act="dl"]');
    dl.disabled = true;
    dl.textContent = 'Saving...';

    const res = await api.ask({
      type: 'bulkGrab',
      pageUrl: location.href,
      items: picks.map((it) => ({
        url: it.url,
        tokens: {
          name: stemOf(it.url),
          ext: it.ext || (it.kind === 'video' ? 'mp4' : 'jpg'),
          kind: it.kind, host: api.hostToken(), title: document.title || '', alt: it.alt || ''
        }
      }))
    });

    const ok = (res && res.saved) || 0;
    const failed = (res && res.failed) || 0;
    api.toast('Saved ' + ok + ' file' + (ok === 1 ? '' : 's') +
              (failed ? ', ' + failed + ' failed' : ''), failed ? 'warn' : 'ok');
    close();
  }

  async function openGallery() {
    if (host) { close(); return; }        // the trigger toggles the panel
    if (opening) return;
    opening = true;
    api.toast('Scanning the page for media...', 'warn');
    try {
      const res = await api.ask({ type: 'collectMedia' });
      const items = (res && res.items) || [];
      all = items.map((it) => Object.assign({}, it, { ext: extOf(it.url) }));
      // Biggest first - that is almost always what you came for.
      all.sort((a, b) => (b.w * b.h) - (a.w * a.h) || (b.bytes - a.bytes));
      build();
      render();
    } catch (e) {
      api.toast('Could not scan the page: ' + ((e && e.message) || e), 'err');
    } finally {
      opening = false;
    }
  }

  api.gallery = openGallery;
})();
