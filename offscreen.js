/* Snaffle - offscreen worker document.

   The service worker cannot hold a blob URL and cannot run for minutes, and a
   page's own script dies when its tab navigates. This document can do both, so
   it does three jobs for the service worker:

     - rebuild a streamed video into one MP4, including streams that keep audio
       in a separate track (via the bundled Mediabunny library);
     - fetch a file the browser's own downloader was refused;
     - receive bytes a page is holding (a canvas, a screenshot) in chunks.

   Each ends in a blob URL, which the service worker downloads into the user's
   folder and then asks this document to release. Nothing here ever hands bytes
   back to a page. */

import * as MB from './vendor/mediabunny.min.mjs';

const S = globalThis.SnaffleShared;
const H = globalThis.SnaffleHls;

const MAX_SEGMENTS = 1200;                 // fallback joiner only: about an hour
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024; // bytes a page may push for one file

const jobs = new Map();    // stream job id -> { tabId, cancel }
const blobs = new Set();   // blob URLs handed out and not yet released
const uploads = new Map(); // upload id -> { chunks, bytes, at }

const tell = (msg) => { try { chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError); } catch (_) {} };

function keep(blob) {
  const url = URL.createObjectURL(blob);
  blobs.add(url);
  return url;
}

/* ----------------------------------------------------------------- uploads */

function addPart(msg) {
  let u = uploads.get(msg.id);
  if (!u) { u = { chunks: [], bytes: 0, at: Date.now() }; uploads.set(msg.id, u); }
  const bin = atob(msg.b64 || '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  u.bytes += bytes.length;
  u.at = Date.now();
  if (u.bytes > MAX_UPLOAD) { uploads.delete(msg.id); return { ok: false, error: 'the file is too large' }; }
  u.chunks.push(bytes);
  return { ok: true };
}

function seal(msg) {
  const u = uploads.get(msg.id);
  uploads.delete(msg.id);
  if (!u || !u.bytes) return { ok: false, error: 'no bytes arrived' };
  const blob = new Blob(u.chunks, { type: msg.mime || 'application/octet-stream' });
  return { ok: true, url: keep(blob), size: blob.size };
}

// An upload whose page went away mid-way would otherwise sit here for good.
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [id, u] of uploads) if (u.at < cutoff) uploads.delete(id);
}, 60 * 1000);

/* ------------------------------------------------------------ plain fetch */

async function fetchFile(msg) {
  try {
    const r = await fetch(msg.url, { credentials: 'omit' });
    if (!r.ok) return { ok: false, error: r.status === 403 ? 'the site refused the download' : 'the site answered ' + r.status };
    const blob = await r.blob();
    if (!blob.size) return { ok: false, error: 'the site sent an empty file' };
    if (S.notMedia(blob.type)) return { ok: false, error: 'the site sent a web page instead of a file' };
    return { ok: true, url: keep(blob), size: blob.size, mime: blob.type };
  } catch (e) {
    return { ok: false, error: 'the site could not be reached' };
  }
}

/* --------------------------------------------------------- streamed video */

function fetcher(ctl) {
  return async (input, init) => {
    const o = Object.assign({}, init || {}, { credentials: 'omit' });
    o.signal = o.signal ? AbortSignal.any([o.signal, ctl.abort.signal]) : ctl.abort.signal;
    const r = await fetch(input, o);
    // Each media segment that arrives is a step of progress the user can see.
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (r.ok && /\.(m4s|ts|aac|mp4|m4v|m4a)(\?|$)/i.test(url) && ctl.onPiece) ctl.onPiece();
    return r;
  };
}

async function getText(url, ctl) {
  const r = await fetcher(ctl)(url);
  if (!r.ok) throw new Error(r.status === 403 ? 'the site refused the stream' : 'the stream answered ' + r.status);
  return r.text();
}

// Read the playlists once, before any heavy work, to refuse what cannot be
// saved at all and to know what the fallback joiner would have to work with.
async function inspect(job, ctl) {
  let mediaUrl = job.url;
  let mediaText = await getText(job.url, ctl);
  let height = 0;
  let splitAudio = false;

  if (/#EXT-X-STREAM-INF/i.test(mediaText)) {
    splitAudio = H.hasSplitAudio(mediaText);
    const best = H.bestVariant(H.parseMaster(mediaText, job.url));
    if (!best) throw new Error('the stream playlist could not be read');
    height = best.height;
    mediaUrl = best.url;
    mediaText = await getText(mediaUrl, ctl);
  }

  const key = (/#EXT-X-KEY:[^\n]*METHOD=([A-Z0-9-]+)/i.exec(mediaText) || [])[1] || 'NONE';
  const { init, segs } = H.parseMedia(mediaText, mediaUrl);
  return {
    mediaUrl, height, splitAudio, init, segs,
    key: key.toUpperCase(),
    live: !/#EXT-X-ENDLIST/i.test(mediaText),
    byterange: /#EXT-X-BYTERANGE/i.test(mediaText)
  };
}

// The normal route: Mediabunny reads the stream and writes a real MP4. It
// merges a separate audio track, converts MPEG-TS, and produces a file with a
// proper index, which the joined-segments route cannot.
async function viaLibrary(job, ctl) {
  const input = new MB.Input({
    source: new MB.UrlSource(job.url, {
      fetchFn: fetcher(ctl),
      // The library's default is to retry for ever. Three tries, and none
      // at all once the job has been cancelled.
      getRetryDelay: (attempts) => (ctl.cancelled || attempts >= 3 ? null : 0.5 * (attempts + 1))
    }),
    formats: MB.HLS_FORMATS
  });
  ctl.input = input;
  try {
    const output = new MB.Output({
      format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new MB.BufferTarget()
    });
    const conv = await MB.Conversion.init({ input, output, tracks: 'primary' });
    if (!conv.isValid) throw new Error('the stream has no track that can be saved');
    ctl.conv = conv;

    const used = conv.utilizedTracks || [];
    const video = used.find((t) => t.type === 'video');
    if (!video) throw new Error('the stream has no video track that can be saved');
    const hadAudio = (await input.getAudioTracks()).length > 0;
    const sound = used.some((t) => t.type === 'audio');

    await conv.execute();
    if (ctl.cancelled) throw new Error('cancelled');

    const blob = new Blob([output.target.buffer], { type: 'video/mp4' });
    return {
      ok: true, url: keep(blob), size: blob.size, ext: 'mp4',
      height: await video.getDisplayHeight(),
      // Only worth mentioning when the stream had sound and the file does not.
      silent: hadAudio && !sound
    };
  } finally {
    try { if (input.dispose) input.dispose(); } catch (_) {}
  }
}

// The plain route: join the best rendition's segments end to end. Folded into
// a Blob every chunk so a long video is not held entirely as ArrayBuffers.
async function viaJoin(info, ctl) {
  const urls = info.init ? [info.init].concat(info.segs) : info.segs;
  const ts = /\.ts(\?|$)/i.test(info.segs[0]);
  const mime = ts ? 'video/mp2t' : 'video/mp4';
  const CHUNK = 24, LANES = 6;
  const get = fetcher(ctl);
  let blob = new Blob([], { type: mime });

  for (let start = 0; start < urls.length; start += CHUNK) {
    const slice = urls.slice(start, start + CHUNK);
    const bufs = new Array(slice.length);
    let next = 0;
    const lane = async () => {
      for (;;) {
        const i = next++;
        if (i >= slice.length) return;
        let buf = null, last = null;
        for (let attempt = 0; attempt < 3 && !buf; attempt++) {
          if (ctl.cancelled) throw new Error('cancelled');
          try {
            const r = await get(slice[i]);
            if (!r.ok) throw new Error('a piece of the stream answered ' + r.status);
            buf = await r.arrayBuffer();
          } catch (e) { last = e; }
        }
        if (!buf) { ctl.abort.abort(); throw last; }
        bufs[i] = buf;
      }
    };
    await Promise.all(Array.from({ length: Math.min(LANES, slice.length) }, lane));
    blob = new Blob([blob].concat(bufs), { type: mime });
  }
  return { ok: true, url: keep(blob), size: blob.size, ext: ts ? 'ts' : 'mp4', height: info.height, joined: true };
}

async function runStream(job) {
  const ctl = { cancelled: false, conv: null, input: null, abort: new AbortController(), onPiece: null };
  // Cancelling must end the job at once, whatever the library is in the
  // middle of, so the job races a promise that only cancel() settles.
  let stop;
  const stopped = new Promise((_, reject) => { stop = reject; });
  stopped.catch(() => {});
  jobs.set(job.id, {
    tabId: job.tabId,
    cancel() {
      ctl.cancelled = true;
      ctl.abort.abort();
      try { if (ctl.conv) ctl.conv.cancel().catch(() => {}); } catch (_) {}
      try { if (ctl.input && ctl.input.dispose) ctl.input.dispose(); } catch (_) {}
      stop(new Error('cancelled'));
    }
  });

  // Progress is throttled: a toast does not need sixty updates a second.
  let lastPct = -1, lastAt = 0;
  const report = (pct) => {
    const now = Date.now();
    if (pct === lastPct || now - lastAt < 300) return;
    lastPct = pct; lastAt = now;
    tell({ type: 'os:progress', id: job.id, tabId: job.tabId, pct });
  };

  const work = async () => {
    let result;
    const info = await inspect(job, ctl);
    if (info.live) throw new Error('This is a live stream, which has no end to save.');
    if (/SAMPLE-AES/.test(info.key)) throw new Error('This stream is encrypted (DRM) and cannot be saved.');

    // A split-audio stream has a second set of segments to fetch.
    const total = Math.max(1, info.segs.length * (info.splitAudio ? 2 : 1));
    let pieces = 0;
    ctl.onPiece = () => report(Math.min(99, Math.round((++pieces / total) * 100)));

    try {
      result = await viaLibrary(job, ctl);
    } catch (libErr) {
      if (ctl.cancelled) throw libErr;
      // Joining is only honest when the result would still be a whole,
      // playable file: no missing audio, nothing encrypted, an index to play by.
      const joinable = !info.splitAudio && info.key === 'NONE' && !info.byterange &&
        info.segs.length > 0 && info.segs.length <= MAX_SEGMENTS &&
        (info.init || /\.ts(\?|$)/i.test(info.segs[0]));
      if (!joinable) {
        if (info.key !== 'NONE') throw new Error('This stream is encrypted and cannot be saved.');
        const why = String((libErr && libErr.message) || libErr).replace(/\.$/, '');
        // Joining the video alone would hand over a silent file as if it were whole.
        throw new Error(info.splitAudio
          ? 'its separate audio track could not be merged (' + why + ')'
          : 'the stream could not be converted (' + why + ')');
      }
      pieces = 0;
      result = await viaJoin(info, ctl);
    }
    return result;
  };

  let result;
  try {
    result = await Promise.race([work(), stopped]);
  } catch (e) {
    result = ctl.cancelled
      ? { ok: false, cancelled: true }
      : { ok: false, error: String((e && e.message) || e) };
  }

  jobs.delete(job.id);
  tell(Object.assign({ type: 'os:done', id: job.id, tabId: job.tabId, meta: job.meta }, result));
}

/* --------------------------------------------------------------- messages */

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || !msg.type) return false;

  // The one thing a page may send here: bytes, to be held until the service
  // worker decides what to do with them.
  if (msg.type === 'blobPart') { respond(addPart(msg)); return false; }

  // Everything else comes from the service worker only.
  if (sender.tab) return false;

  switch (msg.type) {
    case 'os:stream':
      runStream(msg.job);
      respond({ ok: true });
      return false;
    case 'os:cancel':
      for (const j of jobs.values()) if (msg.tabId == null || j.tabId === msg.tabId) j.cancel();
      respond({ ok: true });
      return false;
    case 'os:seal':
      respond(seal(msg));
      return false;
    case 'os:fetch':
      fetchFile(msg).then(respond);
      return true;
    case 'os:revoke':
      URL.revokeObjectURL(msg.url);
      blobs.delete(msg.url);
      respond({ ok: true });
      return false;
    case 'os:busy':
      respond({ busy: jobs.size > 0 || blobs.size > 0 || uploads.size > 0 });
      return false;
  }
  return false;
});
