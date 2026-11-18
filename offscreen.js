/* Snaffle - offscreen worker document.

   The service worker cannot hold a blob URL and cannot run for minutes, and a
   page's own script dies when its tab navigates. This document can do both, so
   it does three jobs for the service worker:

     - rebuild a streamed video into one MP4, including streams that keep audio
       in a separate track, and sites that serve picture and sound as two
       separate files (via the bundled Mediabunny library);
     - fetch a file the browser's own downloader was refused;
     - receive bytes a page is holding (a canvas, a screenshot) in chunks.

   Each ends in a blob URL, which the service worker downloads into the user's
   folder and then asks this document to release. Nothing here ever hands bytes
   back to a page. */

import * as MB from './vendor/mediabunny.min.mjs';

const S = globalThis.SnaffleShared;
const H = globalThis.SnaffleHls;
const T = globalThis.SnaffleTracks;

const MAX_SEGMENTS = 1200;                 // fallback joiner only: about an hour
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024; // bytes a page may push for one file
const MAX_TRACK = 2 * 1024 * 1024 * 1024;  // one track of a video, fetched in ranges
const TRACK_STEP = 2 * 1024 * 1024;        // the size of each range
const HEAD_BYTES = 16 * 1024;              // enough of a track to read its index
const STALL_MS = 15000;                    // no bytes for this long is a stuck download
const MAX_TRIES = 5;                       // tries in a row, with nothing arriving, before giving up
const MAX_RUNNING = 2;                     // videos rebuilt at once; the rest wait their turn

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
  // What the bytes are, so the file is named for what it holds. The blob is
  // given that type as well, because Chrome makes a file's extension agree
  // with the type it arrives as.
  const real = S.sniffType(u.chunks[0]);
  const blob = new Blob(u.chunks, { type: real || msg.mime || 'application/octet-stream' });
  return { ok: true, url: keep(blob), size: blob.size, mime: msg.mime || '', real };
}

// An upload whose page went away mid-way would otherwise sit here for good.
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [id, u] of uploads) if (u.at < cutoff) uploads.delete(id);
}, 60 * 1000);

/* ------------------------------------------------------------ plain fetch */

async function fetchFile(msg) {
  try {
    const r = await fetch(msg.url, { credentials: msg.include ? 'include' : 'omit' });
    if (!r.ok) return { ok: false, error: r.status === 403 ? 'the site refused the download' : 'the site answered ' + r.status };
    const blob = await r.blob();
    if (!blob.size) return { ok: false, error: 'the site sent an empty file' };
    if (S.notMedia(blob.type)) return { ok: false, error: 'the site sent a web page instead of a file' };
    const real = S.sniffType(new Uint8Array(await blob.slice(0, 64).arrayBuffer()));
    const typed = real && real !== S.cleanMime(blob.type) ? new Blob([blob], { type: real }) : blob;
    return { ok: true, url: keep(typed), size: typed.size, mime: blob.type, real };
  } catch (e) {
    return { ok: false, error: 'the site could not be reached' };
  }
}

/* --------------------------------------------------------- streamed video */

const stallError = () => Object.assign(new Error('the download stalled'), { stalled: true });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Every request a job makes goes through here. Besides carrying the job's
// cancel signal, each one is watched: a connection that stays open and sends
// nothing would otherwise hang the job for good, with a progress bar that
// never moves. When nothing has arrived for `ctl.stallMs` the request is
// dropped and fails with an error marked `stalled`, which the callers treat
// as a reason to ask again from where they had got to.
function fetcher(ctl) {
  return async (input, init) => {
    const own = new AbortController();
    const o = Object.assign({}, init || {}, { credentials: 'omit' });
    o.signal = AbortSignal.any([ctl.abort.signal, own.signal].concat(o.signal ? [o.signal] : []));
    const limit = ctl.stallMs || STALL_MS;
    let timer = 0, early = 0, stalled = false, quiet = false;
    // Two stages. After a third of the limit with nothing arriving the user
    // is told the download has gone quiet; at the limit it is dropped.
    const watch = () => {
      clearTimeout(timer); clearTimeout(early);
      early = setTimeout(() => { quiet = true; if (ctl.trouble) ctl.trouble(0); }, limit / 3);
      timer = setTimeout(() => { stalled = true; own.abort(); }, limit);
    };
    const rest = () => {
      clearTimeout(timer); clearTimeout(early);
      // Something arrived after all: the notice comes down again.
      if (quiet && !stalled) { quiet = false; if (ctl.clear) ctl.clear(); }
    };

    watch();
    let r;
    try {
      r = await fetch(input, o);
    } catch (e) {
      rest();
      throw stalled ? stallError() : e;
    }
    rest();
    // Each media segment that arrives is a step of progress the user can see.
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (r.ok && /\.(m4s|ts|aac|mp4|m4v|m4a)(\?|$)/i.test(url) && ctl.onPiece) ctl.onPiece();
    return r.body ? watched(r, { watch, rest, stalled: () => stalled, ctl }) : r;
  };
}

// The same response, with its body passed through a watcher. The clock only
// runs while a read is waiting on the network, so a reader that takes its
// time between reads is never mistaken for a stuck connection.
function watched(r, w) {
  let stream = null;
  const body = () => {
    if (stream) return stream;
    const reader = r.body.getReader();
    stream = new ReadableStream({
      async pull(c) {
        w.watch();
        try {
          const { done, value } = await reader.read();
          w.rest();
          if (done) { c.close(); return; }
          if (w.ctl.flowing) w.ctl.flowing();
          c.enqueue(value);
        } catch (e) {
          w.rest();
          c.error(w.stalled() ? stallError() : e);
        }
      },
      cancel(reason) {
        w.rest();
        return reader.cancel(reason).catch(() => {});
      }
    });
    return stream;
  };
  const read = (how) => () => new Response(body())[how]();
  return new Proxy(r, {
    get(target, key) {
      if (key === 'body') return body();
      if (key === 'arrayBuffer' || key === 'blob' || key === 'text' || key === 'json') return read(key);
      const v = Reflect.get(target, key, target);
      return typeof v === 'function' ? v.bind(target) : v;
    }
  });
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
      // The library's default is to retry for ever. A request that fails
      // outright gets three tries. One that stalled is asked for again from
      // where it stopped, up to MAX_TRIES times in a row with nothing
      // arriving in between, and the user is told while that goes on. None
      // of this happens once the job has been cancelled.
      getRetryDelay: (attempts, error) => {
        if (ctl.cancelled) return null;
        const stuck = !!(error && error.stalled);
        ctl.fails++;
        if (ctl.fails > MAX_TRIES || (!stuck && attempts >= 3)) return null;
        if (stuck) ctl.trouble(ctl.fails);
        return stuck ? 1 : 0.5 * (attempts + 1);
      }
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

    // The converter knows how much of the video's running time it has
    // written, which is a truer measure than a count of requests.
    conv.onProgress = (p) => { ctl.timed = true; ctl.report(Math.min(99, Math.round(p * 100))); };
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
            ctl.clear();
          } catch (e) {
            last = e;
            if (e && e.stalled && !ctl.cancelled) ctl.trouble(attempt + 1);
          }
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

/* ------------------------------------------- video in separate whole files */

// One track, complete. The address without its byte range usually answers
// with the whole file. If that is refused, it is asked for the way the
// player asks: a range at a time, in order, until the file runs out.
//
// Either way a download that stalls or is cut off is not started again: the
// bytes that arrived are kept and the rest is asked for from where it
// stopped. `t` is the track's running account, { got, total, least }: bytes
// in hand, the size the server gave, and the least the file's own index says
// it holds. The file is only handed back when it is all there.
async function fetchTrack(url, ctl, t, onBytes) {
  const get = fetcher(ctl);
  const parts = [];
  const add = (chunk) => { parts.push(chunk); t.got += chunk.byteLength; onBytes(); };
  const enough = () => t.got >= Math.max(t.total, t.least);
  let fails = 0;

  try {
    const r = await get(url);
    if (r.status === 200 && r.body) {
      t.total = Number(r.headers.get('content-length')) || 0;
      onBytes();
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        add(value);
      }
      if (t.got && enough()) return new Blob(parts, { type: 'video/mp4' });
    }
  } catch (e) {
    if (ctl.cancelled) throw e;
    // Stalled or cut off part-way. Carry on below from the last byte.
    fails = 1;
    ctl.trouble(fails);
  }

  let refused = 0;
  for (;;) {
    if (ctl.cancelled) throw new Error('cancelled');
    if (t.got >= MAX_TRACK) throw new Error('the video is too large to save');
    if (t.total && t.got >= t.total && enough()) break;

    let p = null, buf = null;
    try {
      const last = (t.total ? Math.min(t.total, t.got + TRACK_STEP) : t.got + TRACK_STEP) - 1;
      p = await get(T.ranged(url, t.got, last));
      if (p.ok) buf = await p.arrayBuffer();
    } catch (e) {
      if (ctl.cancelled) throw e;
      p = null;
    }
    if (buf && buf.byteLength) {
      // A server may send less than it was asked for. The next range starts
      // where this one really ended.
      add(buf);
      if (fails) { fails = 0; ctl.clear(); }
      continue;
    }

    // Nothing came. An empty answer, or a refusal once some of the file is
    // in hand, is how a server says the file is over - which is only
    // believed when as much has arrived as the file is known to hold.
    const no = !!p && !p.ok && p.status < 500 && p.status !== 408 && p.status !== 429;
    if (no && !t.got) throw new Error(p.status === 403 ? 'the site refused the video' : 'the video answered ' + p.status);
    const over = !!p && (p.ok || no);
    if (over && enough()) break;
    if (no) refused = p.status;

    if (++fails > MAX_TRIES) {
      throw new Error(refused
        ? 'the site stopped sending the video part-way (it answered ' + refused + '; its address may have expired)'
        : 'the download stalled and ' + MAX_TRIES + ' more tries did not get it moving');
    }
    ctl.trouble(fails);
    await pause(Math.min(8000, 500 * Math.pow(2, fails - 1)));
  }
  if (!t.got) throw new Error('the site sent an empty video');
  return new Blob(parts, { type: 'video/mp4' });
}

// The start of a track, read for what it says of itself (see tracks.js).
async function readHead(url, ctl) {
  try {
    const r = await fetcher(ctl)(T.ranged(url, 0, HEAD_BYTES - 1));
    if (!r.ok) return null;
    return T.head(new Uint8Array(await r.arrayBuffer()));
  } catch (e) {
    if (ctl.cancelled) throw e;
    return null;
  }
}

// Picture from one file and sound from another, written as one MP4. The
// packets are copied as they are, so nothing is re-encoded and nothing is
// lost. Which file holds which is read from the files, not assumed.
async function mergeTracks(files, ctl, onStep) {
  const inputs = files.map((b) => new MB.Input({ source: new MB.BlobSource(b), formats: MB.ALL_FORMATS }));
  try {
    let vTrack = null, aTrack = null;
    for (const input of inputs) {
      if (!vTrack) vTrack = await input.getPrimaryVideoTrack();
    }
    for (const input of inputs) {
      if (!aTrack) aTrack = await input.getPrimaryAudioTrack();
    }
    if (!vTrack) throw new Error('none of the files holds a picture');

    const output = new MB.Output({
      format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new MB.BufferTarget()
    });
    const lanes = [];
    const vSource = new MB.EncodedVideoPacketSource(vTrack.codec);
    output.addVideoTrack(vSource);
    lanes.push({ sink: new MB.EncodedPacketSink(vTrack), source: vSource, config: await vTrack.getDecoderConfig(), first: true });
    if (aTrack) {
      const aSource = new MB.EncodedAudioPacketSource(aTrack.codec);
      output.addAudioTrack(aSource);
      lanes.push({ sink: new MB.EncodedPacketSink(aTrack), source: aSource, config: await aTrack.getDecoderConfig(), first: true });
    }

    await output.start();
    const length = (await vTrack.computeDuration()) || 0;
    for (const l of lanes) l.packet = await l.sink.getFirstPacket();
    // Always feed whichever track is furthest behind, so picture and sound
    // stay side by side in the file.
    for (let n = 0; ; n++) {
      const live = lanes.filter((l) => l.packet);
      if (!live.length) break;
      if (ctl.cancelled) throw new Error('cancelled');
      const l = live.reduce((a, b) => (a.packet.timestamp <= b.packet.timestamp ? a : b));
      await l.source.add(l.packet, l.first ? { decoderConfig: l.config } : undefined);
      l.first = false;
      if (length && n % 50 === 0) onStep(Math.min(1, l.packet.timestamp / length));
      l.packet = await l.sink.getNextPacket(l.packet);
    }
    await output.finalize();
    return { buffer: output.target.buffer, height: await vTrack.getDisplayHeight(), sound: !!aTrack };
  } finally {
    for (const input of inputs) { try { if (input.dispose) input.dispose(); } catch (_) {} }
  }
}

async function tracksWork(job, ctl, report) {
  // A page that has loaded several videos (the slides either side of the one
  // on show are loaded ahead) leaves several candidates. The start of each
  // is read, and the one that runs exactly as long as the video being
  // pointed at is the one.
  const choices = job.choices && job.choices.length ? job.choices : [{ video: job.video, audio: job.audio, typed: true }];
  const heads = await Promise.all(choices.map((c) => readHead(c.video, ctl)));
  if (ctl.cancelled) throw new Error('cancelled');
  const want = job.want || {};
  const found = T.match(heads, want);
  const chosen = choices[found.index];
  const head = heads[found.index];

  // Whether the user should be told the choice was not certain, and why.
  let guess = '', tied = 0;
  if (!chosen.typed) guess = 'untyped';
  else if (choices.length > 1 && !found.exact) { guess = found.matched ? 'tied' : 'unmatched'; tied = found.tied; }
  else if (choices.length === 1 && head && head.duration > 0 && want.duration > 0 && Math.abs(head.duration - want.duration) > 1) guess = 'length';

  const urls = [chosen.video].concat(chosen.audio ? [chosen.audio] : []);
  const tracks = urls.map((u, i) => ({ got: 0, total: 0, least: i === 0 && head ? head.size : 0 }));
  // Fetching is nine tenths of the bar; the merge is quick.
  const onBytes = () => {
    let got = 0, total = 0;
    for (const t of tracks) {
      const size = Math.max(t.total, t.least);
      if (!size) return;                 // one size still unknown: no honest figure yet
      got += Math.min(t.got, size);
      total += size;
    }
    report(Math.min(90, Math.round((got / total) * 90)));
  };
  const files = await Promise.all(urls.map((u, i) => fetchTrack(u, ctl, tracks[i], onBytes)));
  if (ctl.cancelled) throw new Error('cancelled');
  report(90);

  const extra = { guess, tied, posts: choices.length };
  try {
    const made = await mergeTracks(files, ctl, (p) => report(90 + Math.round(p * 9)));
    const blob = new Blob([made.buffer], { type: 'video/mp4' });
    return Object.assign({ ok: true, url: keep(blob), size: blob.size, ext: 'mp4', height: made.height, silent: urls.length > 1 && !made.sound }, extra);
  } catch (e) {
    if (ctl.cancelled) throw e;
    // The files could not be read as video here. The picture file plays on
    // its own, so it is saved as it came rather than nothing at all, and the
    // user is told the sound is missing.
    return Object.assign({ ok: true, url: keep(files[0]), size: files[0].size, ext: 'mp4', height: 0, silent: urls.length > 1 }, extra);
  }
}

/* ------------------------------------------------------------- the job */

async function hlsWork(job, ctl, report) {
  let result;
  const info = await inspect(job, ctl);
  if (info.live) throw new Error('This is a live stream, which has no end to save.');
  if (/SAMPLE-AES/.test(info.key)) throw new Error('This stream is encrypted (DRM) and cannot be saved.');

  // Until the converter starts reporting, progress is segments fetched out
  // of segments expected. A split-audio stream has a second set of them, and
  // each rendition has an init piece.
  const perTrack = info.segs.length + (info.init ? 1 : 0);
  const total = Math.max(1, perTrack * (info.splitAudio ? 2 : 1));
  let pieces = 0;
  ctl.onPiece = () => { if (!ctl.timed) report(Math.min(95, Math.round((++pieces / total) * 100))); };
  // Bytes arriving again is the end of any stall.
  ctl.flowing = () => { ctl.fails = 0; ctl.clear(); };

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
    ctl.timed = false;
    result = await viaJoin(info, ctl);
  }
  return result;
}

// Only so many videos are rebuilt at once. Each is held in memory while it
// is put together, and a whole post saved in one go can ask for a dozen.
let running = 0;
const waiting = [];
const takeTurn = () => {
  if (running < MAX_RUNNING) { running++; return { now: true, ready: Promise.resolve() }; }
  return { now: false, ready: new Promise((res) => waiting.push(res)) };
};
const giveTurn = () => {
  const next = waiting.shift();
  if (next) next(); else running--;
};

async function runStream(job) {
  const ctl = {
    cancelled: false, conv: null, input: null, abort: new AbortController(), onPiece: null, timed: false, report: null,
    stallMs: Math.max(1, Number(job.stallSeconds) || STALL_MS / 1000) * 1000,
    fails: 0, flowing: null, trouble: null, clear: null
  };
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

  const batch = (job.meta && job.meta.batch) || null;
  // Nothing more is said about a job once its outcome has been decided.
  let over = false;
  const news = (extra) => { if (!over) tell(Object.assign({ type: 'os:progress', id: job.id, tabId: job.tabId, batch }, extra)); };

  // Progress is throttled: a toast does not need sixty updates a second.
  let lastPct = -1, lastAt = 0, stuck = false;
  const report = (pct) => {
    const now = Date.now();
    if (stuck || pct === lastPct || now - lastAt < 300) return;
    lastPct = pct; lastAt = now;
    news({ pct });
  };
  // A stall is said out loud, with the try it is on, and unsaid as soon as
  // bytes arrive again.
  ctl.trouble = (attempt) => {
    stuck = true;
    news({ pct: Math.max(0, lastPct), state: 'stalled', attempt, of: MAX_TRIES });
  };
  ctl.clear = () => {
    if (!stuck) return;
    stuck = false;
    news({ pct: Math.max(0, lastPct) });
  };

  ctl.report = report;

  const work = () => (job.kind === 'tracks' ? tracksWork(job, ctl, report) : hlsWork(job, ctl, report));

  // Wait for a free place. A job cancelled while it waits still gets its
  // turn in the end, and hands it straight on.
  let held = false;
  const place = takeTurn();
  const turn = place.ready.then(() => { held = true; if (over) giveTurn(); });
  if (!place.now) news({ pct: 0, state: 'queued' });

  let result;
  try {
    await Promise.race([turn, stopped]);
    result = await Promise.race([work(), stopped]);
  } catch (e) {
    result = ctl.cancelled
      ? { ok: false, cancelled: true }
      : { ok: false, error: String((e && e.message) || e) };
  }
  over = true;
  if (held) giveTurn();
  // One track failing ends the job; whatever else was still being fetched
  // for it is dropped rather than left to run on.
  if (!ctl.cancelled) { ctl.cancelled = true; ctl.abort.abort(); result.cancelled = false; }

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
      for (const [id, j] of jobs) {
        if (msg.id ? id === msg.id : (msg.tabId == null || j.tabId === msg.tabId)) j.cancel();
      }
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
