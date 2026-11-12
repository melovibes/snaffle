/* Snaffle - service worker. Decides what gets downloaded and where, and
   coordinates the pieces that do the work: the downloads API, the offscreen
   document (large files and streamed video), and the content scripts. */

importScripts('shared.js');
const S = SnaffleShared;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getCfg() {
  const s = await chrome.storage.sync.get('cfg');
  return S.effective(s.cfg);
}

async function nextIndex() {
  const s = await chrome.storage.local.get('counter');
  const n = (s.counter || 0) + 1;
  await chrome.storage.local.set({ counter: n });
  return n;
}

async function buildFilename(tok, cfg, index) {
  return S.buildPath(tok, cfg || await getCfg(), index || await nextIndex());
}

function toastTab(tabId, text, kind, opts) {
  if (tabId == null || tabId < 0) return;
  chrome.tabs.sendMessage(tabId, { type: 'toast', text, kind, opts }, { frameId: 0 }, () => void chrome.runtime.lastError);
}

// The button a toast carries once its file is on disk.
const showAction = (id) => (id != null ? [{ label: 'Show in folder', send: { type: 'showDownload', id } }] : []);

/* ------------------------------------------------------------- downloads */

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

// Runs for every download in the browser once its headers are in. Ours are
// the only ones touched; anything else is left to Chrome and other extensions.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const w = item.byExtensionId === chrome.runtime.id ? wanted.get(item.url) : null;
  if (!w) return;
  w.finalName = S.nameForMime(w.filename, item.mime);
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
    if (item.mime && S.notMedia(item.mime)) return { ok: false, error: 'the site sent a web page instead of a file' };
    if (item.state === 'complete') return { ok: true };
    if (item.bytesReceived > 0 && item.mime) return { ok: true, running: true };
    await sleep(120);
  }
  return { ok: true, running: true };
}

// Downloads that passed their first check but are still arriving. Kept in
// session storage because the service worker can be stopped before they end.
async function remember(id, info) {
  const s = await chrome.storage.session.get('pending');
  const all = s.pending || {};
  all[id] = info;
  await chrome.storage.session.set({ pending: all });
}

async function recall(id) {
  const s = await chrome.storage.session.get('pending');
  const all = s.pending || {};
  const info = all[id];
  if (info) { delete all[id]; await chrome.storage.session.set({ pending: all }); }
  return info || null;
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
      await remember(res.id, { tabId: sender.tab ? sender.tab.id : null, frameId: sender.frameId, url, filename: finalName });
    }
    return { ok: true, id: res.id, filename: finalName };
  } finally {
    wanted.delete(url);
  }
}

// A download that passed its first check can still die part-way. Tell the tab,
// which retries with the page's own credentials and reports the real outcome.
chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state || delta.state.current === 'in_progress') return;
  const info = await recall(delta.id);
  if (!info || delta.state.current !== 'interrupted') return;
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

/* ---------------------------------------------------- offscreen document */

// One hidden extension page does the work a service worker cannot: it can
// hold a blob URL, and it stays alive for a download that takes minutes.
let opening = null;

async function ensureOffscreen() {
  const url = chrome.runtime.getURL('offscreen.html');
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (existing.length) return;
  if (!opening) {
    opening = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Assemble streamed video and hold large files as blobs so they can be saved into the chosen folder.'
    }).finally(() => { opening = null; });
  }
  await opening;
}

async function toOffscreen(msg) {
  await ensureOffscreen();
  return new Promise((res) => {
    chrome.runtime.sendMessage(msg, (r) => {
      if (chrome.runtime.lastError) res({ ok: false, error: 'the worker page did not answer' });
      else res(r);
    });
  });
}

// Close the worker page once it holds nothing, so it does not sit in memory.
async function closeOffscreenIfIdle() {
  try {
    const url = chrome.runtime.getURL('offscreen.html');
    const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
    if (!existing.length) return;
    const state = await new Promise((res) => chrome.runtime.sendMessage({ type: 'os:busy' }, (r) => { void chrome.runtime.lastError; res(r); }));
    if (state && !state.busy) await chrome.offscreen.closeDocument();
  } catch (_) {}
}

// Download a blob the worker page is holding, then let it go.
async function saveBlobUrl(url, filename, cfg) {
  try {
    const res = await startDownload({ url, filename, conflictAction: 'uniquify', saveAs: !!cfg.saveAs });
    if (!res.ok) return { ok: false, error: res.error };
    const deadline = Date.now() + (cfg.saveAs ? 10 * 60000 : 5 * 60000);
    while (Date.now() < deadline) {
      const item = await findDownload(res.id);
      if (!item) return { ok: false, error: 'the download disappeared' };
      if (item.state === 'interrupted') {
        return { ok: false, cancelled: item.error === 'USER_CANCELED', error: WHY[item.error] || 'the browser would not save it' };
      }
      if (item.state === 'complete') return { ok: true, filename, id: res.id };
      await sleep(100);
    }
    return { ok: false, error: 'saving took too long' };
  } finally {
    await toOffscreen({ type: 'os:revoke', url });
    closeOffscreenIfIdle();
  }
}

// Bytes a page pushed to the worker page in chunks: a canvas, a screenshot, a
// file the page fetched with its own credentials.
async function blobSave(msg) {
  const cfg = await getCfg();
  const filename = msg.filename
    ? String(msg.filename).split('/').map(S.sanitizeSegment).filter(Boolean).join('/')
    : await buildFilename(msg.tokens, cfg);
  const sealed = await toOffscreen({ type: 'os:seal', id: msg.id, mime: msg.mime });
  if (!sealed || !sealed.ok) return { ok: false, error: (sealed && sealed.error) || 'the file could not be assembled' };
  return saveBlobUrl(sealed.url, filename, cfg);
}

// Last resort for a file the browser's downloader and the page were both
// refused: fetch it from the worker page, which sends no page cookies, and
// save it. The bytes go to disk only; nothing is returned to the page.
async function proxyGrab(msg) {
  if (!/^https?:\/\//i.test(msg.url || '')) return { ok: false, error: 'not a web address' };
  const cfg = await getCfg();
  const got = await toOffscreen({ type: 'os:fetch', url: msg.url });
  if (!got || !got.ok) { closeOffscreenIfIdle(); return { ok: false, error: (got && got.error) || 'the site could not be reached' }; }
  const asked = String(msg.filename || 'download').split('/').map(S.sanitizeSegment).filter(Boolean).join('/');
  return saveBlobUrl(got.url, S.nameForMime(asked, got.mime), cfg);
}

/* ----------------------------------------------- streamed video (sniffer) */

// MSE video has no file URL - the playlist the player fetched is the only
// handle on it, so record those per tab. storage.session survives the service
// worker going idle, which it will long before the user hits the trigger.
const STREAMS_KEY = 'streams';
const MAX_STREAMS = 120;
const STREAM_TTL = 2 * 60 * 60 * 1000;
let streams = null;

const X_MEDIA_ID = /\/(?:ext_tw_video|amplify_video|tweet_video)(?:_thumb)?\/(\d+)\//;

async function loadStreams() {
  if (!streams) {
    const s = await chrome.storage.session.get(STREAMS_KEY);
    streams = s[STREAMS_KEY] || { list: [] };
  }
  return streams;
}

async function recordStream(d) {
  const s = await loadStreams();
  const cutoff = Date.now() - STREAM_TTL;
  // No reason to keep a record of what was watched hours ago.
  s.list = s.list.filter((e) => e.url !== d.url && e.ts > cutoff);
  s.list.push({
    url: d.url,
    id: (X_MEDIA_ID.exec(d.url) || [])[1] || '',
    tabId: d.tabId,
    playlist: /\.m3u8$/i.test(new URL(d.url).pathname),
    ts: Date.now()
  });
  if (s.list.length > MAX_STREAMS) s.list = s.list.slice(-MAX_STREAMS);
  await chrome.storage.session.set({ [STREAMS_KEY]: s });
}

chrome.webRequest.onBeforeRequest.addListener((d) => {
  // Playlists and whole files only - never the thousands of segment requests.
  // Judged on the path: a page address that merely mentions a playlist in its
  // query string is not one, and neither is a navigation.
  if (d.type === 'main_frame' || d.type === 'sub_frame') return;
  let file = '';
  try { file = new URL(d.url).pathname; } catch (_) { return; }
  if (!/\.(m3u8|mp4)$/i.test(file)) return;
  // A request with no tab is the extension's own, from the worker page while
  // it rebuilds a stream. Only what pages ask for is evidence of a video.
  if (d.tabId < 0) return;
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

async function findStream(mediaId, tabId) {
  const s = await loadStreams();
  const inTab = s.list.filter((e) => e.tabId === tabId);

  // X repeats the same media id in the poster and in the video URL, so this is
  // an exact match even with a dozen videos in one timeline.
  if (mediaId) {
    const hits = (inTab.length ? inTab : s.list).filter((e) => e.id === mediaId);
    const group = streamGroups(hits.filter((e) => e.playlist)).pop();
    const best = group || hits[hits.length - 1];
    return best ? { url: best.url } : { url: '' };
  }
  // No id to match on: the most recent stream this tab asked for. With more
  // than one stream on the page that is a guess, and the user is told so.
  const groups = streamGroups(inTab.filter((e) => e.playlist));
  const recent = groups[groups.length - 1];
  return recent ? { url: recent.url, guessed: true, streams: groups.length } : { url: '' };
}

/* ------------------------------------------------- streamed video (jobs) */

// Some CDNs only serve video to requests that carry the page's address. The
// worker page cannot set a Referer itself, so a session rule adds it to the
// extension's own requests to that site for the length of the job.
async function setReferer(playlistUrl, pageUrl) {
  try {
    const host = new URL(playlistUrl).hostname;
    const site = /^[\d.]+$/.test(host) || !host.includes('.') ? host : host.split('.').slice(-2).join('.');
    const id = 1 + (Date.now() % 1000000000);
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [{
        id, priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'set', value: new URL(pageUrl).href }] },
        condition: { requestDomains: [site], initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest', 'media', 'other'] }
      }]
    });
    return id;
  } catch (_) {
    return 0;
  }
}

const clearReferer = (id) => {
  if (id) chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
};

async function grabStream(msg, sender) {
  if (!sender.tab) return { found: false };
  const tabId = sender.tab.id;
  const found = await findStream(msg.mediaId || '', tabId);
  if (!found.url) return { found: false };

  const guess = found.guessed && found.streams > 1
    ? ' - best guess: this page loaded ' + found.streams + ' streams and none could be matched to this video'
    : '';

  // A whole file was served after all: the ordinary download path.
  if (/\.mp4(\?|$)/i.test(found.url)) {
    const tokens = Object.assign({}, msg.tokens, { ext: 'mp4' });
    const res = await handleGrab({ candidates: [{ url: found.url, tokens }] }, sender);
    return Object.assign({ found: true, direct: true, url: found.url, guess }, res);
  }

  const id = 'job-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const ruleId = await setReferer(found.url, msg.pageUrl || sender.tab.url || found.url);
  // Everything needed to finish the job travels with it, because this service
  // worker may have been stopped and restarted by the time it is done.
  const job = { id, url: found.url, tabId, meta: { tokens: msg.tokens, guess, ruleId } };
  const ack = await toOffscreen({ type: 'os:stream', job });
  if (!ack || !ack.ok) { clearReferer(ruleId); return { found: true, started: false, error: 'the worker page did not start' }; }
  // Every frame, so Escape cancels from wherever keyboard focus happens to be.
  chrome.tabs.sendMessage(tabId, { type: 'streamStarted' }, () => void chrome.runtime.lastError);
  return { found: true, started: true, id };
}

async function finishStream(msg) {
  const meta = msg.meta || {};
  const tabId = msg.tabId;
  clearReferer(meta.ruleId);
  const ended = () => {
    if (tabId != null) chrome.tabs.sendMessage(tabId, { type: 'streamEnded' }, () => void chrome.runtime.lastError);
    closeOffscreenIfIdle();
  };

  // Each verdict replaces the job's own progress toast.
  const at = { id: msg.id };
  if (msg.cancelled) { toastTab(tabId, 'Cancelled.', 'warn', at); ended(); return; }
  if (!msg.ok) {
    const why = String(msg.error || 'the stream could not be read');
    toastTab(tabId, /^[A-Z]/.test(why) ? why : 'Could not save this video: ' + why, 'err', at);
    ended();
    return;
  }

  const cfg = await getCfg();
  const tok = Object.assign({}, meta.tokens, {
    name: ((meta.tokens && meta.tokens.name) || 'video') + (msg.height ? '-' + msg.height + 'p' : ''),
    ext: msg.ext || 'mp4'
  });
  const filename = await buildFilename(tok, cfg);
  const res = await saveBlobUrl(msg.url, filename, cfg);
  if (!res.ok) {
    if (res.cancelled) toastTab(tabId, 'Cancelled.', 'warn', at);
    else toastTab(tabId, 'Could not save this video: ' + res.error, 'err', at);
    ended();
    return;
  }

  const notes =
    (msg.silent ? ' - no sound: the audio track could not be included' : '') +
    (msg.joined ? ' - saved as joined segments, so some players may show the wrong length' : '') +
    (meta.guess || '');
  toastTab(tabId, 'Saved ' + filename + ' (' + S.sizeText(msg.size) + ')' + notes, notes ? 'warn' : 'ok',
    { id: msg.id, actions: showAction(res.id) });
  ended();
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
    chrome.tabs.sendMessage(sender.tab.id, { type: 'collectMediaFrame', token }, () => void chrome.runtime.lastError);
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

/* ----------------------------------------------------- injecting scripts */

const CORE = ['shared.js', 'content.js'];

// Put the content script into a tab that does not have a working one: a tab
// opened before the extension was installed, or one left with a dead copy by
// an update. A tab that already has a live copy ignores this.
async function injectCore(tabId) {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: CORE });
}

async function injectEverywhere() {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.id == null || t.discarded) continue;
    injectCore(t.id).catch(() => {});   // chrome:// pages and the like refuse
  }
}

// The screenshot and media-list code is only loaded into a tab when asked
// for, rather than into every frame of every page.
async function runFeature(name, tabId) {
  if (name !== 'capture' && name !== 'gallery') return { ok: false, error: 'unknown feature' };
  if (tabId == null) return { ok: false, error: 'no tab' };
  try {
    await injectCore(tabId);
    await chrome.scripting.executeScript({
      target: name === 'gallery' ? { tabId, allFrames: true } : { tabId, frameIds: [0] },
      files: [name + '.js']
    });
  } catch (_) {
    return { ok: false, error: 'Snaffle cannot run on this page.' };
  }
  await new Promise((res) => chrome.tabs.sendMessage(tabId, { type: name + 'Now' }, { frameId: 0 }, () => { void chrome.runtime.lastError; res(); }));
  return { ok: true };
}

/* -------------------------------------------------------------- messages */

const fromWorkerPage = (sender) => !sender.tab && sender.id === chrome.runtime.id;

// One of the extension's own pages (the popup, the options page), as opposed
// to a content script speaking from inside a web page.
const fromOwnPage = (sender) => sender.id === chrome.runtime.id &&
  String(sender.url || '').startsWith(chrome.runtime.getURL(''));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  // The popup names the tab it wants acted on. A content script cannot: it
  // only ever speaks for the tab it is in.
  const tabId = fromOwnPage(sender) && msg.tabId != null ? msg.tabId : (sender.tab ? sender.tab.id : null);

  switch (msg.type) {
    case 'grab': handleGrab(msg, sender).then(sendResponse); return true;
    case 'grabStream': grabStream(msg, sender).then(sendResponse); return true;
    case 'blobOpen': ensureOffscreen().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false })); return true;
    case 'blobSave': blobSave(msg).then(sendResponse); return true;
    case 'proxyGrab': proxyGrab(msg).then(sendResponse); return true;
    case 'captureViewport': captureViewport(sender).then(sendResponse); return true;
    case 'collectMedia': collectMedia(sender).then(sendResponse); return true;
    case 'feature': runFeature(msg.name, tabId).then(sendResponse); return true;
    case 'canRun':
      // Asked by the popup: is this a page Snaffle can work on? Finding out
      // also loads it into a tab that was open before it was installed.
      if (tabId == null) { sendResponse({ ok: false }); return false; }
      injectCore(tabId).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
      return true;
    case 'buildName':
      buildFilename(msg.tokens).then((f) => sendResponse({ ok: true, filename: f.split('/').pop(), path: f }));
      return true;

    case 'cancelStreams':
      // One job when its toast's Cancel is pressed; all of the tab's on Escape.
      if (sender.tab) toOffscreen({ type: 'os:cancel', tabId: sender.tab.id, id: msg.id || null });
      sendResponse({ ok: true });
      return false;

    case 'showDownload':
      try { chrome.downloads.show(msg.id); } catch (_) {}
      sendResponse({ ok: true });
      return false;

    case 'mediaFound': {
      const bucket = mediaBuckets.get(msg.token);
      if (bucket) bucket.push.apply(bucket, msg.items || []);
      sendResponse({ ok: true });
      return false;
    }
    case 'badge':
      setBadge(msg.text, sender.tab ? sender.tab.id : undefined);
      sendResponse({ ok: true });
      return false;

    case 'relayTop':
      if (sender.tab) {
        chrome.tabs.sendMessage(sender.tab.id, { type: msg.action, text: msg.text, kind: msg.kind, opts: msg.opts }, { frameId: 0 },
          () => void chrome.runtime.lastError);
      }
      sendResponse({ ok: true });
      return false;

    case 'relayGrab':
      // Every frame hears this; only the one the pointer is in answers.
      if (!sender.tab) { sendResponse({ handled: false }); return false; }
      chrome.tabs.sendMessage(sender.tab.id, { type: 'grabNow' }, (r) => {
        void chrome.runtime.lastError;
        sendResponse({ handled: !!(r && r.handled) });
      });
      return true;

    // From the worker page. A tab cannot forge these: its messages carry a tab.
    case 'os:progress':
      if (fromWorkerPage(sender)) {
        toastTab(msg.tabId, 'Downloading video: ' + msg.pct + '%', 'busy', {
          id: msg.id, sticky: true, progress: msg.pct,
          actions: [{ label: 'Cancel', send: { type: 'cancelStreams', id: msg.id }, close: false }]
        });
      }
      return false;
    case 'os:done':
      if (fromWorkerPage(sender)) finishStream(msg);
      return false;
  }
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

  if (tab && tab.id != null && !res.cancelled) {
    toastTab(tab.id, res.ok ? 'Saved ' + res.filename : 'Could not save this: ' + res.error, res.ok ? 'ok' : 'err',
      { actions: res.ok ? showAction(res.id) : [] });
  }
});

/* -------------------------------------------------------------- lifecycle */

chrome.runtime.onInstalled.addListener(async () => {
  // Early versions wrote every default into storage. Keep only what the user
  // actually changed, so defaults can move on without them.
  const s = await chrome.storage.sync.get('cfg');
  if (s.cfg && s.cfg.v !== S.CFG_VERSION) await chrome.storage.sync.set({ cfg: S.toStore(s.cfg) });
  buildMenus();
  // Tabs that were already open have no content script, or a dead one.
  injectEverywhere();
});

chrome.runtime.onStartup.addListener(buildMenus);

chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'sync' && ch.cfg) buildMenus();
});
