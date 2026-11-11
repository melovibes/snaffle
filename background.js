/* Snaffle - service worker: filename building, downloads, context menu. */

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

const MAX_PROXY_BYTES = 60 * 1024 * 1024;

function merge(base, over) {
  const out = Object.assign({}, base);
  for (const k of Object.keys(over || {})) {
    const v = over[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object') out[k] = merge(base[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

async function getCfg() {
  const s = await chrome.storage.sync.get('cfg');
  return merge(DEFAULTS, s.cfg || {});
}

/* ------------------------------------------------------------- filenames */

const pad = (n) => String(n).padStart(2, '0');

function sanitizeSegment(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 100);
}

function applyTemplate(tpl, tok, index) {
  const d = new Date();
  const map = {
    name: tok.name, ext: tok.ext, host: tok.host, title: tok.title, alt: tok.alt, kind: tok.kind,
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
    datetime: `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
    ts: String(Date.now()),
    index: String(index).padStart(4, '0')
  };
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (k in map ? (map[k] == null ? '' : map[k]) : m));
}

async function nextIndex() {
  const s = await chrome.storage.local.get('counter');
  const n = (s.counter || 0) + 1;
  await chrome.storage.local.set({ counter: n });
  return n;
}

async function buildFilename(rawTok, cfg, index) {
  const c = cfg || await getCfg();
  const idx = index || await nextIndex();
  // An empty {name} would collapse the template to a bare extension.
  const tok = Object.assign({}, rawTok);
  if (!tok.name) tok.name = tok.host || 'media';

  let name = applyTemplate(c.template || '{name}.{ext}', tok, idx);
  name = name.split('/').map(sanitizeSegment).filter(Boolean).join('/');
  if (!name) name = `${tok.host || 'media'}-${idx}.${tok.ext}`;
  if (!/\.[a-z0-9]{1,5}$/i.test(name)) name += '.' + tok.ext;

  const folder = applyTemplate(c.folder || '', tok, idx)
    .split('/').map(sanitizeSegment).filter(Boolean).join('/');

  return folder ? folder + '/' + name : name;
}

/* ------------------------------------------------------------- downloads */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pending = new Map(); // downloadId -> { tabId, frameId, url, filename }

function startDownload(opts) {
  return new Promise((resolve) => {
    chrome.downloads.download(opts, (id) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve({ ok: true, id });
    });
  });
}

const findDownload = (id) => new Promise((res) => chrome.downloads.search({ id }, (items) => res(items && items[0])));

// Take a rejected download back out of the browser: stop it, delete whatever
// reached the disk, and drop it from the downloads list.
async function discard(id) {
  const quiet = (fn) => new Promise((res) => {
    try { fn(() => { void chrome.runtime.lastError; res(); }); } catch (_) { res(); }
  });
  await quiet((cb) => chrome.downloads.cancel(id, cb));
  await quiet((cb) => chrome.downloads.removeFile(id, cb));
  await quiet((cb) => chrome.downloads.erase({ id }, cb));
}

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/x-icon': 'ico',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/ogg': 'ogg'
};
const cleanMime = (m) => String(m || '').toLowerCase().split(';')[0].trim();

// Text is never the picture or video someone pointed at. SVG is the one image
// type that calls itself XML.
function notMedia(mime) {
  const m = cleanMime(mime);
  if (!m || /svg/.test(m)) return false;
  return /^text\/|html|json|xml|javascript/.test(m);
}

const WHY = {
  SERVER_FORBIDDEN: 'the site refused the download',
  SERVER_UNAUTHORIZED: 'the site wants a sign-in',
  SERVER_BAD_CONTENT: 'the file is not there (404)',
  SERVER_FAILED: 'the site had an error',
  NETWORK_FAILED: 'the connection failed',
  NETWORK_TIMEOUT: 'the connection timed out',
  FILE_ACCESS_DENIED: 'the folder could not be written to',
  FILE_NAME_TOO_LONG: 'the file name is too long'
};

// The name a download was asked for, keyed by address, so the file can be
// renamed once the server has said what it really is.
const wanted = new Map();

// The extension a file should carry, given what the server says it is. A .jpg
// address that serves WebP is common, and the file should say what it holds.
function nameForMime(filename, mime) {
  const real = MIME_EXT[cleanMime(mime)];
  if (!real) return filename;
  const had = (/\.([a-z0-9]{1,5})$/i.exec(filename) || [])[1] || '';
  const same = had.toLowerCase() === real || (/^jpe?g$/i.test(had) && real === 'jpg');
  if (same) return filename;
  return had ? filename.slice(0, -had.length) + real : filename + '.' + real;
}

// Runs for every download in the browser once its headers are in. Ours are
// the only ones touched; anything else is left to Chrome and other extensions.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const w = item.byExtensionId === chrome.runtime.id ? wanted.get(item.url) : null;
  if (!w) return;
  w.finalName = nameForMime(w.filename, item.mime);
  suggest({ filename: w.finalName, conflictAction: 'uniquify' });
});

// Wait until a download has shown what it is. Resolves as soon as the outcome
// is certain: failed, the wrong kind of content, finished, or bytes of the
// right kind arriving.
async function verdict(id, waitForDialog) {
  const deadline = Date.now() + (waitForDialog ? 120000 : 20000);
  while (Date.now() < deadline) {
    const item = await findDownload(id);
    if (!item) return { ok: false, error: 'the download disappeared' };
    if (item.state === 'interrupted') {
      if (item.error === 'USER_CANCELED') return { ok: false, cancelled: true, error: 'cancelled' };
      return { ok: false, error: WHY[item.error] || String(item.error || 'the download was interrupted').toLowerCase() };
    }
    if (item.mime && notMedia(item.mime)) {
      return { ok: false, error: 'the site sent a web page instead of a file' };
    }
    if (item.state === 'complete') return { ok: true, mime: item.mime };
    if (item.bytesReceived > 0 && item.mime) return { ok: true, running: true, mime: item.mime };
    await sleep(120);
  }
  return { ok: true, running: true };
}

async function tryDownload(url, filename, cfg, sender) {
  wanted.set(url, { filename });
  try {
    const res = await startDownload({ url, filename, conflictAction: 'uniquify', saveAs: !!cfg.saveAs });
    if (!res.ok) return { ok: false, error: res.error, filename };
    const v = await verdict(res.id, !!cfg.saveAs);
    const finalName = (wanted.get(url) || {}).finalName || filename;
    if (!v.ok) {
      if (!v.cancelled) await discard(res.id);
      return { ok: false, error: v.error, cancelled: !!v.cancelled, filename: finalName };
    }
    // Still arriving: keep watching, so a late failure is reported too.
    if (v.running) {
      pending.set(res.id, { tabId: sender.tab ? sender.tab.id : null, frameId: sender.frameId, url, filename: finalName });
    }
    return { ok: true, id: res.id, filename: finalName };
  } finally {
    wanted.delete(url);
  }
}

// A download that passed its first check can still die part-way. Tell the tab,
// which retries with the page's own credentials and reports the real outcome.
chrome.downloads.onChanged.addListener((delta) => {
  const info = pending.get(delta.id);
  if (!info || !delta.state) return;
  if (delta.state.current === 'complete') { pending.delete(delta.id); return; }
  if (delta.state.current !== 'interrupted') return;
  pending.delete(delta.id);
  const err = (delta.error && delta.error.current) || '';
  if (err === 'USER_CANCELED' || info.tabId == null) return;
  const msg = { type: 'downloadFailed', url: info.url, filename: info.filename, error: WHY[err] || '' };
  const done = () => void chrome.runtime.lastError;
  if (info.frameId != null) chrome.tabs.sendMessage(info.tabId, msg, { frameId: info.frameId }, done);
  else chrome.tabs.sendMessage(info.tabId, msg, done);
});

// Candidates arrive best first, ending with the address the page itself
// loaded. The first one that turns out to be a real file wins.
async function handleGrab(msg, sender) {
  const cfg = await getCfg();
  const candidates = msg.candidates || [{ url: msg.url, tokens: msg.tokens }];
  const idx = await nextIndex();
  let last = { ok: false, error: 'there was nothing to download' };
  for (const c of candidates) {
    const filename = await buildFilename(c.tokens, cfg, idx);
    last = await tryDownload(c.url, filename, cfg, sender);
    if (last.ok || last.cancelled) return last;
  }
  return last;
}

// Bytes a page handed over as a data URL: an encoded canvas, an inline SVG, a
// file the page fetched itself. Saved here so the folder setting applies.
async function saveData(msg) {
  const cfg = await getCfg();
  const filename = msg.filename
    ? String(msg.filename).split('/').map(sanitizeSegment).filter(Boolean).join('/')
    : await buildFilename(msg.tokens, cfg);
  const res = await startDownload({ url: msg.dataUrl, filename, conflictAction: 'uniquify', saveAs: !!cfg.saveAs });
  if (!res.ok) return { ok: false, error: res.error };
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const item = await findDownload(res.id);
    if (!item || item.state === 'interrupted') return { ok: false, error: 'the browser would not save it' };
    if (item.state === 'complete') return { ok: true, filename };
    await sleep(100);
  }
  return { ok: true, filename };
}

/* Last resort: fetch from the worker (no CORS limits) and save as a data URL. */
function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

async function handleProxyGrab(msg) {
  try {
    const r = await fetch(msg.url, { credentials: 'omit' });
    if (!r.ok) return { ok: false, error: r.status === 403 ? 'the site refused the download' : 'the site answered ' + r.status };
    const buf = await r.arrayBuffer();
    if (!buf.byteLength) return { ok: false, error: 'the site sent an empty file' };
    if (buf.byteLength > MAX_PROXY_BYTES) return { ok: false, error: 'the file is too large for the fallback path' };
    const type = r.headers.get('content-type') || 'application/octet-stream';
    if (notMedia(type)) return { ok: false, error: 'the site sent a web page instead of a file' };
    const dataUrl = `data:${type.split(';')[0]};base64,` + toBase64(buf);
    const filename = String(msg.filename || 'download').split('/').map(sanitizeSegment).filter(Boolean).join('/');
    const res = await startDownload({ url: dataUrl, filename, conflictAction: 'uniquify' });
    return res.ok ? { ok: true, filename } : { ok: false, error: res.error };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ----------------------------------------------- streamed video (sniffer) */

// MSE video has no file URL - the playlist the player fetched is the only
// handle on it, so record those per tab. storage.session survives the service
// worker going idle, which it will long before the user hits the trigger.
const STREAMS_KEY = 'streams';
const MAX_STREAMS = 120;
let streams = null;

const X_MEDIA_ID = /\/(?:ext_tw_video|amplify_video|tweet_video)(?:_thumb)?\/(\d+)\//;

async function loadStreams() {
  if (!streams) {
    const s = await chrome.storage.session.get(STREAMS_KEY);
    streams = s[STREAMS_KEY] || { list: [] };
  }
  return streams;
}

const STREAM_TTL = 2 * 60 * 60 * 1000;

async function recordStream(d) {
  const s = await loadStreams();
  const cutoff = Date.now() - STREAM_TTL;
  // No reason to keep a record of what was watched hours ago.
  s.list = s.list.filter((e) => e.url !== d.url && e.ts > cutoff);
  s.list.push({
    url: d.url,
    id: (X_MEDIA_ID.exec(d.url) || [])[1] || '',
    tabId: d.tabId,
    playlist: /\.m3u8(\?|$)/i.test(d.url),
    ts: Date.now()
  });
  if (s.list.length > MAX_STREAMS) s.list = s.list.slice(-MAX_STREAMS);
  await chrome.storage.session.set({ [STREAMS_KEY]: s });
}

// Playlists the extension is about to fetch for itself, so the sniffer does
// not record them as if the page had asked for another video.
const ownFetches = new Map(); // url -> expiry

function isOwnFetch(url) {
  const until = ownFetches.get(url);
  if (!until) return false;
  if (until < Date.now()) { ownFetches.delete(url); return false; }
  return true;
}

chrome.webRequest.onBeforeRequest.addListener((d) => {
  // Playlists and whole files only - never the thousands of segment requests.
  if (!/\.(m3u8|mp4)(\?|$)/i.test(d.url)) return;
  // Requests with no tab are the service worker's own; announced ones are ours too.
  if (d.tabId < 0 || isOwnFetch(d.url)) return;
  recordStream(d).catch(() => {});
}, { urls: ['*://*/*.m3u8*', '*://video.twimg.com/*'] });

// A player asks for a master playlist and then its variants, so several
// recorded playlists can be one video. Two belong together when one sits in
// the other's directory tree. Each group is represented by its shallowest
// playlist, which is the master.
function streamGroups(entries) {
  const dir = (u) => { try { const p = new URL(u); return p.origin + p.pathname.replace(/[^/]*$/, ''); } catch (_) { return u; } };
  const groups = [];
  for (const e of entries) {
    const d = dir(e.url);
    const g = groups.find((x) => d.startsWith(x.dir) || x.dir.startsWith(d));
    if (!g) { groups.push({ dir: d, url: e.url, ts: e.ts }); continue; }
    if (d.length < g.dir.length) { g.dir = d; g.url = e.url; }
    g.ts = Math.max(g.ts, e.ts);
  }
  return groups.sort((x, y) => x.ts - y.ts);
}

async function findStream(msg, sender) {
  const s = await loadStreams();
  const tabId = sender.tab ? sender.tab.id : -1;
  const inTab = s.list.filter((e) => e.tabId === tabId);

  // X repeats the same media id in the poster and in the video URL, so this is
  // an exact match even with a dozen videos in one timeline.
  if (msg.mediaId) {
    const hits = (inTab.length ? inTab : s.list).filter((e) => e.id === msg.mediaId);
    const best = hits.find((e) => e.playlist) || hits[hits.length - 1];
    return best ? { url: best.url } : { url: '' };
  }
  // No id to match on: the most recent stream this tab asked for. With more
  // than one stream on the page that is a guess, and the caller says so.
  const groups = streamGroups(inTab.filter((e) => e.playlist));
  const recent = groups[groups.length - 1];
  return recent ? { url: recent.url, guessed: true, streams: groups.length } : { url: '' };
}

async function proxyFetch(msg) {
  try {
    const r = await fetch(msg.url, { credentials: 'omit' });
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
    return { ok: true, b64: toBase64(await r.arrayBuffer()), type: r.headers.get('content-type') || '' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ------------------------------------------------- screenshots and bulk ops */

// captureVisibleTab is quota-limited to a couple of calls per second, and the
// quota error is retryable - a stitched capture of a long page will hit it.
async function captureViewport(sender) {
  if (!sender.tab) return { ok: false, error: 'no tab' };
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
      if (dataUrl) return { ok: true, dataUrl };
    } catch (e) {
      const m = String((e && e.message) || e);
      if (!/exceed|quota|rate/i.test(m) || attempt === 4) return { ok: false, error: m };
      await sleep(600);
    }
  }
  return { ok: false, error: 'capture did not return an image' };
}

async function setBadge(text, tabId) {
  try {
    await chrome.action.setBadgeText({ text: String(text || ''), tabId });
    if (text) await chrome.action.setBadgeBackgroundColor({ color: '#2563eb', tabId });
  } catch (_) {}
}

// Media lives in every frame, but tabs.sendMessage only hands back one reply.
// Each frame pushes its own list instead, and we gather them for a moment.
const mediaBuckets = new Map();

async function collectMedia(sender) {
  if (!sender.tab) return { ok: false, items: [] };
  const token = Date.now() + ':' + sender.tab.id;
  mediaBuckets.set(token, []);
  try {
    chrome.tabs.sendMessage(sender.tab.id, { type: 'collectMediaFrame', token },
      () => void chrome.runtime.lastError);
    await sleep(700);
    const seen = new Set();
    const items = [];
    for (const it of mediaBuckets.get(token) || []) {
      if (!it || !it.url || seen.has(it.url)) continue;
      seen.add(it.url);
      items.push(it);
    }
    return { ok: true, items };
  } finally {
    mediaBuckets.delete(token);
  }
}

async function bulkGrab(msg, sender) {
  const cfg = await getCfg();
  let saved = 0, failed = 0;
  for (const item of msg.items || []) {
    const filename = await buildFilename(item.tokens, cfg);
    const res = await startDownload({ url: item.url, filename, conflictAction: 'uniquify', saveAs: false });
    if (res.ok) {
      saved++;
      pending.set(res.id, {
        tabId: sender.tab ? sender.tab.id : null,
        frameId: 0, url: item.url, filename
      });
    } else {
      failed++;
    }
    await sleep(120);               // keep the downloads panel from choking
  }
  return { ok: true, saved, failed };
}

/* -------------------------------------------------------------- messages */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  if (msg.type === 'grab') { handleGrab(msg, sender).then(sendResponse); return true; }
  if (msg.type === 'proxyGrab') { handleProxyGrab(msg).then(sendResponse); return true; }
  if (msg.type === 'findStream') { findStream(msg, sender).then(sendResponse); return true; }
  if (msg.type === 'saveData') { saveData(msg).then(sendResponse); return true; }
  if (msg.type === 'ownFetch') {
    for (const u of msg.urls || []) ownFetches.set(u, Date.now() + 30000);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'relayGrab') {
    // Every frame hears this; only the one the pointer is in answers.
    if (!sender.tab) { sendResponse({ handled: false }); return false; }
    chrome.tabs.sendMessage(sender.tab.id, { type: 'grabNow' }, (r) => {
      void chrome.runtime.lastError;
      sendResponse({ handled: !!(r && r.handled) });
    });
    return true;
  }
  if (msg.type === 'proxyFetch') { proxyFetch(msg).then(sendResponse); return true; }
  if (msg.type === 'captureViewport') { captureViewport(sender).then(sendResponse); return true; }
  if (msg.type === 'collectMedia') { collectMedia(sender).then(sendResponse); return true; }
  if (msg.type === 'bulkGrab') { bulkGrab(msg, sender).then(sendResponse); return true; }
  if (msg.type === 'mediaFound') {
    const bucket = mediaBuckets.get(msg.token);
    if (bucket) bucket.push.apply(bucket, msg.items || []);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'badge') {
    setBadge(msg.text, sender.tab ? sender.tab.id : undefined);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'relayTop') {
    if (sender.tab) {
      chrome.tabs.sendMessage(sender.tab.id, { type: msg.action, text: msg.text, kind: msg.kind }, { frameId: 0 },
        () => void chrome.runtime.lastError);
    }
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'buildName') {
    buildFilename(msg.tokens).then((f) => sendResponse({ ok: true, filename: f.split('/').pop(), path: f }));
    return true;
  }
  if (msg.type === 'getCfg') { getCfg().then((c) => sendResponse(c)); return true; }
  return false;
});

/* ---------------------------------------------------------- context menu */

async function buildMenus() {
  await chrome.contextMenus.removeAll();
  const cfg = await getCfg();
  if (!cfg.contextMenu) return;
  chrome.contextMenus.create({
    id: 'snaffle-save',
    title: 'Save with Snaffle',
    contexts: ['image', 'video', 'audio']
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'snaffle-save') return;
  const url = info.srcUrl;
  if (!url) return;

  let name = 'media', ext = '';
  try {
    const p = new URL(url);
    const seg = decodeURIComponent(p.pathname.split('/').filter(Boolean).pop() || '');
    const dot = seg.lastIndexOf('.');
    if (dot > 0) { name = seg.slice(0, dot); ext = seg.slice(dot + 1); } else if (seg) { name = seg; }
  } catch (_) {}
  ext = ext.split(/[?#]/)[0].toLowerCase();
  if (!/^[a-z0-9]{1,5}$/.test(ext)) ext = info.mediaType === 'video' ? 'mp4' : 'jpg';

  let host = '';
  try { host = new URL(info.pageUrl || (tab && tab.url) || url).hostname.replace(/^www\./, ''); } catch (_) {}

  const res = await handleGrab({
    url,
    tokens: { name, ext, host, title: (tab && tab.title) || '', alt: '', kind: info.mediaType || 'image' }
  }, { tab, frameId: info.frameId });

  if (tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, {
      type: 'toast',
      text: res.ok ? 'Saved ' + res.filename : 'Could not download: ' + res.error,
      kind: res.ok ? 'ok' : 'err'
    }, () => void chrome.runtime.lastError);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const s = await chrome.storage.sync.get('cfg');
  if (!s.cfg) await chrome.storage.sync.set({ cfg: DEFAULTS });
  buildMenus();
});

chrome.runtime.onStartup.addListener(buildMenus);

chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'sync' && ch.cfg) buildMenus();
});
