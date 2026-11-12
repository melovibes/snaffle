/* Snaffle - page media list. Lists every image and video on the page (across
   frames), filters them, and bulk-downloads the selection. Loaded into a tab
   by the service worker when it is asked for. */
(() => {
  const api = window.__SNAFFLE;
  // Loaded into the tab each time it is asked for; only the first copy stays.
  if (!api || api.galleryLoaded) return;
  api.galleryLoaded = true;

  const IMAGE_FILE = /\.(jpe?g|png|gif|webp|avif|bmp|svg)(?=$|[?#])/i;
  const VIDEO_FILE = /\.(mp4|webm|mov|m4v)(?=$|[?#])/i;
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

  // Each item names the best address to save (`url`), the addresses to fall
  // back to, and `thumb`: something the page has ALREADY loaded that can stand
  // in as a preview. The list must not fetch every original just to draw itself.
  function collectFrame() {
    const sizes = resourceSizes();
    const seen = new Set();
    const items = [];
    const add = (it) => {
      if (!it.url || seen.has(it.url)) return;
      if (/^data:/i.test(it.url) && it.url.length > 1e6) return;   // skip giant inline blobs
      seen.add(it.url);
      it.bytes = sizes.get(it.url) || 0;
      items.push(it);
    };

    for (const img of document.images) {
      const hit = api.fromImg(img);
      if (!hit) continue;
      const shown = api.abs(img.currentSrc || img.getAttribute('src'), img);
      let url = hit.url;
      let alts = hit.alts || [];

      // A thumbnail linking to the full file is one item: the full file, with
      // the thumbnail as its preview and its fallback.
      const link = api.cfg.preferLink ? api.linkFor(img) : '';
      if (link && IMAGE_FILE.test(link)) {
        const up = api.upgrade(link);
        alts = api.fallbacks([link, url].concat(alts), up);
        url = up;
      }

      // What is known about the size of the version that would be saved.
      let w = 0, h = 0, approx = false;
      if (url === shown) { w = img.naturalWidth; h = img.naturalHeight; }
      else if (url === hit.url && hit.width && img.naturalWidth) {
        w = hit.width;
        h = Math.round(hit.width * img.naturalHeight / img.naturalWidth);
        approx = true;
      }
      add({ url, alts, thumb: shown, kind: 'image', w, h, approx, shownW: img.naturalWidth, shownH: img.naturalHeight, alt: img.alt || '' });
    }

    for (const v of document.querySelectorAll('video')) {
      const poster = v.poster ? api.abs(v.poster, v) : '';
      const hit = api.fromVideo(v);
      if (hit && hit.kind === 'video' && !/^blob:/i.test(hit.url)) {
        add({ url: hit.url, alts: hit.alts || [], thumb: poster, kind: 'video', w: v.videoWidth || 0, h: v.videoHeight || 0, alt: '' });
      }
      if (poster) add({ url: poster, alts: [], thumb: poster, kind: 'image', w: 0, h: 0, alt: '' });
    }

    let scanned = 0;
    for (const el of document.querySelectorAll('*')) {
      if (++scanned > BG_SCAN_LIMIT) break;
      const hit = api.fromBackground(el);
      if (!hit) continue;
      // The address the page loaded is the last fallback, or the hit itself.
      const loaded = (hit.alts && hit.alts[hit.alts.length - 1]) || hit.url;
      add({ url: hit.url, alts: hit.alts || [], thumb: loaded, sameAsThumb: loaded === hit.url, kind: 'image', w: 0, h: 0, alt: '' });
    }

    for (const a of document.querySelectorAll('a[href]')) {
      const href = api.abs(a.getAttribute('href'), a);
      if (!href || !(IMAGE_FILE.test(href) || VIDEO_FILE.test(href))) continue;
      const up = api.upgrade(href);
      const inner = a.querySelector('img');
      add({
        url: up, alts: api.fallbacks([href], up),
        thumb: inner ? api.abs(inner.currentSrc || inner.getAttribute('src'), inner) : '',
        kind: VIDEO_FILE.test(href) ? 'video' : 'image',
        w: 0, h: 0, shownW: inner ? inner.naturalWidth : 0, shownH: inner ? inner.naturalHeight : 0, alt: ''
      });
    }

    return items;
  }

  chrome.runtime.onMessage.addListener((msg, _s, send) => {
    if (!msg || msg.type !== 'collectMediaFrame' || !api.alive()) return false;
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
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .shade { position: fixed; inset: 0; z-index: 2147483645; background: rgba(0,0,0,.55); }
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
    .count { color: #a3acb9; }
    .spacer { flex: 1; }
    input[type=search], input[type=number] {
      background: #0f1115; color: #e5e7eb; border: 1px solid #2a2f3a;
      border-radius: 7px; padding: 6px 9px; font: inherit;
    }
    input[type=search] { width: 190px; }
    input[type=number] { width: 68px; }
    label.min { color: #a3acb9; display: flex; align-items: center; gap: 6px; }
    .chips { display: flex; gap: 5px; flex-wrap: wrap; }
    button { font: inherit; cursor: pointer; }
    .chip {
      border: 1px solid #2a2f3a; background: #0f1115; color: #a3acb9;
      border-radius: 999px; padding: 4px 10px;
    }
    .chip[aria-pressed="true"] { background: #1d4ed8; border-color: #1d4ed8; color: #fff; }
    .btn {
      border: 1px solid #2a2f3a; background: #0f1115; color: #e5e7eb;
      border-radius: 7px; padding: 6px 11px;
    }
    .btn:hover:not(:disabled) { border-color: #60a5fa; }
    .btn.primary { background: #2563eb; border-color: #2563eb; color: #fff; font-weight: 600; }
    .btn:disabled { opacity: .45; cursor: default; }
    .btn.close { font-size: 17px; line-height: 1; padding: 4px 9px; }
    input:focus-visible, button:focus-visible, .card:focus-visible {
      outline: 2px solid #60a5fa; outline-offset: 2px;
    }
    .grid {
      flex: 1; overflow: auto; padding: 14px;
      display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px;
      align-content: start;
    }
    .card {
      border: 1px solid #2a2f3a; border-radius: 10px; overflow: hidden;
      background: #171a21; cursor: pointer; position: relative; user-select: none;
    }
    .card[aria-selected="true"] { border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,.35); }
    .thumb {
      height: 110px; display: flex; align-items: center; justify-content: center;
      color: #a3acb9; font-weight: 650; text-transform: uppercase; letter-spacing: .06em;
      background: repeating-conic-gradient(#1b1f27 0% 25%, #141821 0% 50%) 50% / 16px 16px;
    }
    .thumb img { max-width: 100%; max-height: 110px; display: block; }
    .meta { padding: 7px 9px; font-size: 11px; color: #a3acb9; }
    .meta b { display: block; color: #e5e7eb; font-weight: 600; font-size: 11px;
              white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tick {
      position: absolute; top: 7px; left: 7px; width: 18px; height: 18px;
      border-radius: 5px; border: 1px solid #6b7280; background: rgba(15,17,21,.8);
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
    .card.done .badge.state { background: #065f46; }
    .card.failed .badge.state { background: #7f1d1d; }
    .empty { padding: 40px; text-align: center; color: #a3acb9; grid-column: 1 / -1; }
    footer {
      padding: 9px 14px; border-top: 1px solid #2a2f3a; background: #171a21;
      color: #a3acb9; min-height: 38px; overflow-wrap: anywhere;
    }
    footer.warn { color: #fbbf24; }
  `;

  let host = null;
  let root = null;
  let all = [];
  let selected = new Set();      // item urls
  let typeFilter = new Set();
  let opening = false;
  let saving = false;
  let stopSaving = false;
  let anchor = -1;               // last card acted on, for shift-click ranges
  let returnFocus = null;

  const q = (sel) => root.querySelector(sel);

  const tokensOf = (it) => api.tokensFor({ url: it.url, kind: it.kind, alt: it.alt, el: null }, it.url);
  const nameOf = (it) => {
    if (/^(data|blob):/i.test(it.url)) return it.kind + ' held in the page';
    const t = tokensOf(it);
    return t.name + (t.extGuessed ? '' : '.' + t.ext);
  };
  const extOf = (it) => (/^blob:/i.test(it.url) ? 'other' : tokensOf(it).ext);

  function dimsText(it) {
    if (it.w && it.h) return (it.approx ? 'about ' : '') + it.w + ' x ' + it.h;
    if (it.shownW && it.shownH) return 'larger version of a ' + it.shownW + ' x ' + it.shownH + ' preview';
    return 'size not known yet';
  }

  /* ---- building: every card is made once, then only shown or hidden ---- */

  function makeCard(it, index) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.url = it.url;
    card.dataset.index = String(index);
    card.setAttribute('role', 'option');
    card.setAttribute('aria-selected', 'false');
    card.tabIndex = -1;
    card.title = it.url.slice(0, 300);

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (it.thumb) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = '';
      img.src = it.thumb;
      // When the preview IS the file, decoding it tells us the real size, and
      // the size filter can then be applied to it.
      img.addEventListener('load', () => {
        if (!it.w && (it.thumb === it.url || it.sameAsThumb)) {
          it.w = img.naturalWidth; it.h = img.naturalHeight;
          card.querySelector('.dims').textContent = dimsText(it);
          card.setAttribute('aria-label', labelOf(it));
          queueFilter();
        }
      });
      img.addEventListener('error', () => { thumb.textContent = it.ext || it.kind; });
      thumb.appendChild(img);
    } else {
      thumb.textContent = it.ext || it.kind;
    }

    const tick = document.createElement('div');
    tick.className = 'tick';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const nameEl = document.createElement('b');
    nameEl.textContent = nameOf(it).slice(0, 60);
    const dims = document.createElement('span');
    dims.className = 'dims';
    dims.textContent = dimsText(it);
    meta.appendChild(nameEl);
    meta.appendChild(dims);
    if (it.bytes) meta.appendChild(document.createTextNode(' - ' + SnaffleShared.sizeText(it.bytes)));

    if (it.kind === 'video') {
      const badge = document.createElement('div');
      badge.className = 'badge';
      badge.textContent = 'video';
      card.appendChild(badge);
    }

    card.appendChild(thumb);
    card.appendChild(tick);
    card.appendChild(meta);
    card.setAttribute('aria-label', labelOf(it));
    it.card = card;
    return card;
  }

  const labelOf = (it) => nameOf(it) + ', ' + it.kind + ', ' + dimsText(it);

  function build() {
    returnFocus = document.activeElement;
    host = document.createElement('div');
    host.id = '__snaffle_gallery';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<style>' + CSS + '</style>' +
      '<div class="shade"></div>' +
      '<div class="wrap" role="dialog" aria-modal="true" aria-label="Images and video on this page">' +
        '<header>' +
          '<h2>Page media</h2><span class="count" role="status"></span>' +
          '<input type="search" placeholder="filter by address" aria-label="Filter by address">' +
          '<label class="min">at least <input type="number" min="0" step="10" aria-label="Minimum size in pixels"> px</label>' +
          '<div class="chips" role="group" aria-label="File types"></div>' +
          '<span class="spacer"></span>' +
          '<button class="btn" data-act="all">Select all shown</button>' +
          '<button class="btn" data-act="none">Clear</button>' +
          '<button class="btn primary" data-act="dl">Download</button>' +
          '<button class="btn close" data-act="close" aria-label="Close">&times;</button>' +
        '</header>' +
        '<div class="grid" role="listbox" aria-multiselectable="true" aria-label="Media found"></div>' +
        '<footer role="status" aria-live="polite"></footer>' +
      '</div>';
    document.documentElement.appendChild(host);

    q('input[type=number]').value = api.cfg.galleryMinSize || 0;
    q('input[type=search]').addEventListener('input', applyFilter);
    q('input[type=number]').addEventListener('input', applyFilter);
    q('.shade').addEventListener('click', close);

    const types = Array.from(new Set(all.map((i) => i.ext).filter(Boolean))).sort();
    const chips = q('.chips');
    for (const t of types) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.dataset.type = t;
      b.setAttribute('aria-pressed', 'false');
      b.textContent = t;
      chips.appendChild(b);
    }

    q('header').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (chip) {
        const t = chip.dataset.type;
        if (typeFilter.has(t)) typeFilter.delete(t); else typeFilter.add(t);
        chip.setAttribute('aria-pressed', typeFilter.has(t) ? 'true' : 'false');
        applyFilter();
        return;
      }
      const btn = e.target.closest('button');
      const act = btn && btn.dataset.act;
      if (act === 'close') close();
      else if (act === 'all') { for (const it of shown()) select(it, true); paint(); }
      else if (act === 'none') { for (const it of all) select(it, false); paint(); }
      else if (act === 'dl') { if (saving) stopSaving = true; else download(); }
    });

    const grid = q('.grid');
    all.forEach((it, i) => grid.appendChild(makeCard(it, i)));
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.hidden = true;
    grid.appendChild(empty);

    grid.addEventListener('click', (e) => {
      const card = e.target.closest('.card');
      if (!card || saving) return;
      const i = Number(card.dataset.index);
      // Shift-click extends from the last card touched, over what is showing.
      if (e.shiftKey && anchor >= 0 && anchor !== i) {
        const [lo, hi] = anchor < i ? [anchor, i] : [i, anchor];
        for (let k = lo; k <= hi; k++) if (!all[k].card.hidden) select(all[k], true);
      } else {
        select(all[i], !selected.has(all[i].url));
      }
      anchor = i;
      focusCard(card);
      paint();
    });

    window.addEventListener('keydown', onKey, true);
  }

  /* ---- selection, filtering, status ---- */

  function select(it, on) {
    if (on) selected.add(it.url); else selected.delete(it.url);
    it.card.setAttribute('aria-selected', on ? 'true' : 'false');
  }

  const shown = () => all.filter((it) => !it.card.hidden);

  function matches(it) {
    const text = q('input[type=search]').value.trim().toLowerCase();
    const min = parseInt(q('input[type=number]').value, 10) || 0;
    if (text && it.url.toLowerCase().indexOf(text) < 0) return false;
    if (typeFilter.size && !typeFilter.has(it.ext)) return false;
    // Judge by the best size known for the file. Nothing known is not the same
    // as tiny, so an unmeasured item stays.
    const w = it.w || it.shownW || 0, h = it.h || it.shownH || 0;
    if (min && w && h && w < min && h < min) return false;
    return true;
  }

  let filterQueued = false;
  function queueFilter() {
    if (filterQueued) return;
    filterQueued = true;
    requestAnimationFrame(() => { filterQueued = false; if (root) applyFilter(); });
  }

  function applyFilter() {
    let visible = 0;
    for (const it of all) {
      const on = matches(it);
      it.card.hidden = !on;
      if (on) visible++;
      // What cannot be seen cannot stay selected: "Download 12" must mean the
      // twelve on screen.
      else if (selected.has(it.url)) select(it, false);
    }
    const empty = q('.empty');
    empty.hidden = visible > 0;
    empty.textContent = all.length ? 'Nothing matches those filters.' : 'No images or video found on this page.';
    // Keep exactly one card in the tab order.
    const current = root.activeElement && root.activeElement.classList.contains('card') && !root.activeElement.hidden
      ? root.activeElement : null;
    const home = current || (shown()[0] || {}).card;
    for (const it of all) it.card.tabIndex = it.card === home ? 0 : -1;
    paint();
  }

  function paint() {
    const visible = shown().length;
    q('.count').textContent = all.length + ' found' + (visible !== all.length ? ', ' + visible + ' shown' : '');
    const dl = q('[data-act="dl"]');
    if (!saving) {
      dl.textContent = selected.size ? 'Download ' + selected.size : 'Download';
      dl.disabled = selected.size === 0;
      const bytes = all.filter((it) => selected.has(it.url)).reduce((n, it) => n + (it.bytes || 0), 0);
      setStatus(selected.size
        ? selected.size + ' selected' + (bytes ? ', at least ' + SnaffleShared.sizeText(bytes) : '')
        : 'Click or press Space to select. Shift-click selects a range. Arrow keys move.');
    }
  }

  function setStatus(text, warn) {
    const f = q('footer');
    f.textContent = text;
    f.className = warn ? 'warn' : '';
  }

  /* ---- keyboard ---- */

  function focusCard(card) {
    for (const it of all) it.card.tabIndex = it.card === card ? 0 : -1;
    card.focus();
    card.scrollIntoView({ block: 'nearest' });
  }

  // Arrow keys move through the cards as they are laid out on screen.
  function gridKey(e, card) {
    const cards = shown().map((it) => it.card);
    const i = cards.indexOf(card);
    let to = null;

    if (e.key === ' ' || e.key === 'Enter') {
      if (!saving) { const it = all[Number(card.dataset.index)]; select(it, !selected.has(it.url)); anchor = Number(card.dataset.index); paint(); }
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      if (!saving) { for (const it of shown()) select(it, true); paint(); }
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowRight') to = cards[i + 1];
    else if (e.key === 'ArrowLeft') to = cards[i - 1];
    else if (e.key === 'Home') to = cards[0];
    else if (e.key === 'End') to = cards[cards.length - 1];
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // The nearest card in the next row that sits in the same column.
      const r = card.getBoundingClientRect();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      let best = null, bestGap = Infinity;
      for (const c of cards) {
        const cr = c.getBoundingClientRect();
        const gap = (cr.top - r.top) * dir;
        if (gap <= 1 || Math.abs(cr.left - r.left) > 4) continue;
        if (gap < bestGap) { best = c; bestGap = gap; }
      }
      to = best;
    } else return;

    e.preventDefault();
    if (to) focusCard(to);
  }

  const tabStops = () => Array.from(root.querySelectorAll('input, button, .card[tabindex="0"]'))
    .filter((el) => !el.disabled && !el.hidden && el.offsetParent !== null);

  // Every key the dialog cares about is handled here, at the window, before
  // the page sees it. Escape closes from wherever focus is. While focus is in
  // the dialog, Tab stays inside it and the page's own shortcuts do not fire
  // behind it.
  function onKey(e) {
    if (!root) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    const active = root.activeElement;
    if (!active) {
      // Focus slipped out to the page (a click on empty space). Tab brings it back.
      if (e.key === 'Tab') { const s = tabStops(); if (s.length) { e.preventDefault(); e.stopPropagation(); s[0].focus(); } }
      return;
    }
    e.stopPropagation();
    if (e.key === 'Tab') {
      const stops = tabStops();
      if (!stops.length) return;
      const at = stops.indexOf(active);
      const next = e.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : (at === stops.length - 1 ? 0 : at + 1);
      e.preventDefault();
      stops[next].focus();
      return;
    }
    if (active.classList.contains('card')) gridKey(e, active);
  }

  function close() {
    window.removeEventListener('keydown', onKey, true);
    stopSaving = true;
    if (host) host.remove();
    host = null; root = null; all = []; selected = new Set(); typeFilter = new Set(); anchor = -1; saving = false;
    try { if (returnFocus && returnFocus.focus) returnFocus.focus(); } catch (_) {}
    returnFocus = null;
  }

  /* ---- downloading ---- */

  // One file at a time, so the count on screen is true and each failure can
  // be named. Each goes through the same path as a single grab: best address
  // first, fallbacks after, and "saved" only when a real file is arriving.
  async function download() {
    const picks = all.filter((it) => selected.has(it.url));
    if (!picks.length) return;
    saving = true;
    stopSaving = false;
    const dl = q('[data-act="dl"]');
    dl.textContent = 'Stop';
    for (const b of root.querySelectorAll('[data-act="all"], [data-act="none"]')) b.disabled = true;

    let ok = 0;
    const failed = [];
    for (let i = 0; i < picks.length; i++) {
      if (stopSaving || !root) break;
      const it = picks[i];
      setStatus('Saving ' + (i + 1) + ' of ' + picks.length + ': ' + nameOf(it));

      const urls = [it.url].concat(it.alts || []);
      const candidates = urls.map((u) => ({ url: u, tokens: api.tokensFor({ url: u, kind: it.kind, alt: it.alt, el: null }, u) }));
      const res = await api.ask({ type: 'grab', candidates, pageUrl: location.href });
      let good = !!(res && res.ok);
      let why = (res && res.error) || 'the site blocked it';
      if (!good && res && res.cancelled) { stopSaving = true; break; }
      if (!good && !/^(data|blob):/i.test(it.url)) {
        // The browser was refused; the page may not be.
        const last = candidates[candidates.length - 1];
        const fb = await api.fallback(last.url, (res && res.filename) || last.tokens.name + '.' + last.tokens.ext);
        good = fb.ok && !(fb.saved && fb.saved.cancelled);
        if (!fb.ok) why = fb.reason || why;
      }
      if (!root) break;

      const mark = document.createElement('div');
      mark.className = 'badge state';
      mark.style.top = it.kind === 'video' ? '30px' : '7px';
      if (good) {
        ok++;
        select(it, false);
        it.card.classList.add('done');
        mark.textContent = 'saved';
      } else {
        failed.push(nameOf(it) + ' (' + why + ')');
        it.card.classList.add('failed');
        mark.textContent = 'failed';
      }
      const old = it.card.querySelector('.badge.state');
      if (old) old.remove();
      it.card.appendChild(mark);
    }

    saving = false;
    if (!root) return;
    for (const b of root.querySelectorAll('[data-act="all"], [data-act="none"]')) b.disabled = false;
    const stopped = stopSaving && ok + failed.length < picks.length;
    paint();

    const summary = 'Saved ' + ok + ' file' + (ok === 1 ? '' : 's') +
      (failed.length ? '. Could not save ' + failed.length + ': ' + failed.join('; ') : '') +
      (stopped ? '. Stopped before the rest.' : '');
    setStatus(summary + (failed.length ? ' They are still selected.' : ''), failed.length > 0);
    api.toast('Saved ' + ok + ' file' + (ok === 1 ? '' : 's') + (failed.length ? ', ' + failed.length + ' failed' : ''),
              failed.length ? 'warn' : 'ok');
  }

  async function openGallery() {
    if (host) { close(); return; }        // the trigger toggles the panel
    if (opening) return;
    opening = true;
    const tid = 'gallery-scan';
    api.toast('Looking for images and video...', 'busy', { id: tid, sticky: true });
    try {
      const res = await api.ask({ type: 'collectMedia' });
      const items = (res && res.items) || [];
      all = items.map((it) => { const o = Object.assign({}, it); o.ext = extOf(o); return o; });
      // Biggest first - that is almost always what you came for.
      const area = (it) => (it.w || it.shownW || 0) * (it.h || it.shownH || 0);
      all.sort((a, b) => area(b) - area(a) || (b.bytes - a.bytes));
      api.dismissToast(tid);
      build();
      applyFilter();
      const first = (shown()[0] || {}).card;
      if (first) focusCard(first); else q('[data-act="close"]').focus();
    } catch (e) {
      api.toast('Could not look through this page: ' + ((e && e.message) || e), 'err', { id: tid });
    } finally {
      opening = false;
    }
  }

  api.gallery = openGallery;
})();
