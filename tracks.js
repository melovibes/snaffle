/* Snaffle - video that is served as separate whole files, one per track,
   which the player fetches a byte range at a time. Instagram (and the rest of
   Meta's CDN) works this way: a post is one video-only MP4 per quality and one
   audio-only MP4, all fragments of the same "asset".

   Nothing here touches the network or the browser. The service worker uses it
   to recognise and choose tracks, the worker page to ask for them, and the
   tests to check both. */
var SnaffleTracks = (typeof SnaffleTracks !== 'undefined' && SnaffleTracks) || (function () {
  const HOSTS = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;
  const RANGE = /([?&])(?:bytestart|byteend)=\d+(?=&|$)/g;

  // Is this request one piece of a video track?
  function isTrack(url) {
    try {
      const u = new URL(url);
      return HOSTS.test(u.hostname) && /\.mp4$/i.test(u.pathname) && /[?&]bytestart=\d+/.test(u.search);
    } catch (_) {
      return false;
    }
  }

  // The address of the whole track: the same text with the byte range taken
  // out. Everything else in it is signed, so it is edited as text and never
  // parsed and rebuilt - one re-encoded character and the server answers 403.
  function whole(url) {
    return String(url)
      .replace(RANGE, (m, lead) => (lead === '?' ? '?' : ''))
      .replace('?&', '?')
      .replace(/\?$/, '');
  }

  // The address of one range of it, asked for the way the player asks.
  function ranged(url, start, end) {
    const w = whole(url);
    return w + (w.includes('?') ? '&' : '?') + 'bytestart=' + start + '&byteend=' + end;
  }

  // What a track's address says about it. `efg` is base64 JSON: which asset
  // the track belongs to, its bitrate and length, and a tag that names audio.
  function describe(url) {
    const u = new URL(url);
    let efg = {};
    try {
      const raw = (u.searchParams.get('efg') || '').replace(/-/g, '+').replace(/_/g, '/');
      const parsed = JSON.parse(atob(raw));
      if (parsed && typeof parsed === 'object') efg = parsed;
    } catch (_) {}
    const tag = String(efg.vencode_tag || '');
    return {
      key: u.origin + u.pathname,           // the same track, whichever range
      url: whole(url),
      asset: String(efg.xpv_asset_id || efg.video_id || ''),
      known: !!tag,                         // did the address say what it is
      audio: /audio/i.test(tag),
      bitrate: Number(efg.bitrate) || 0,
      duration: Number(efg.duration_s) || 0
    };
  }

  // Out of every track a tab has asked for, the ones to save for the video
  // the user is pointing at. `want.duration` is that video's length in
  // seconds, when the page knows it.
  //
  // Tracks of one post share an asset id. Posts of the wrong length are set
  // aside, the rest are listed most recent first in `choices`, and the result
  // is marked as a guess when more than one post was still in the running.
  // The address only gives the length in whole seconds; match() below settles
  // it from the files.
  function pick(entries, want) {
    const groups = new Map();
    for (const e of entries || []) {
      let g = groups.get(e.asset);
      if (!g) { g = { asset: e.asset, tracks: [], ts: 0, duration: 0 }; groups.set(e.asset, g); }
      g.tracks.push(e);
      g.ts = Math.max(g.ts, e.ts || 0);
      g.duration = Math.max(g.duration, e.duration || 0);
    }
    // A post that has only been asked for sound is not one the user can see.
    let pool = Array.from(groups.values()).filter((g) => g.tracks.some((t) => !t.audio));
    if (!pool.length) return null;

    const seconds = Number(want && want.duration) || 0;
    if (seconds > 0) {
      // The address rounds the length to whole seconds.
      const near = pool.filter((g) => g.duration > 0 && Math.abs(g.duration - seconds) <= 1.5);
      if (near.length) pool = near;
    }
    // Most recent first. Every post still in the running is handed over, so
    // the worker page can settle it by reading the files themselves.
    pool.sort((a, b) => b.ts - a.ts);

    const best = (list) => list.slice().sort((a, b) => (a.bitrate - b.bitrate) || ((a.ts || 0) - (b.ts || 0))).pop() || null;
    const choices = pool.slice(0, MAX_CHOICES).map((g) => {
      const typed = g.tracks.every((t) => t.known);
      let video, audio;
      if (typed) {
        video = best(g.tracks.filter((t) => !t.audio));
        audio = best(g.tracks.filter((t) => t.audio));
      } else {
        // Nothing says which is which. Hand over the two most recent tracks
        // and let the worker page tell picture from sound by reading them.
        const recent = g.tracks.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
        video = recent.pop() || null;
        audio = recent.pop() || null;
      }
      return { video: video.url, audio: audio ? audio.url : '', typed };
    });
    const first = choices[0];
    return {
      video: first.video,
      audio: first.audio,
      guessed: pool.length > 1 || !first.typed,
      posts: pool.length,
      typed: first.typed,
      choices
    };
  }

  const MAX_CHOICES = 8;

  /* ------------------------------------------------ what a file says of itself */

  // The first few thousand bytes of a track hold its index: how long it runs,
  // to a fraction of a frame, how large its picture is, and how many bytes
  // the whole file has. A page says a video's length just as exactly, which
  // makes the length a fingerprint: of several videos a page has loaded, the
  // one whose file runs exactly as long as the video being pointed at is it.
  //
  // `bytes` is a Uint8Array of the start of the file. Returns null when it
  // is not a file of this kind.
  function head(bytes) {
    if (!bytes || bytes.length < 16) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const end = dv.byteLength;
    const name = (p) => String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));
    const u64 = (p) => dv.getUint32(p) * 4294967296 + dv.getUint32(p + 4);
    const out = { duration: 0, width: 0, height: 0, audio: false, size: 0 };
    let scale = 0, length = 0, fragments = 0, sawMovie = false;

    const walk = (from, to) => {
      let p = from;
      while (p + 8 <= to) {
        let size = dv.getUint32(p);
        const type = name(p + 4);
        let body = p + 8;
        if (size === 1) { if (p + 16 > to) return; size = u64(p + 8); body = p + 16; }
        if (size < 8) return;
        const stop = Math.min(p + size, end);
        const has = (n) => body + n <= stop;
        if (type === 'moov') sawMovie = true;
        if (type === 'moov' || type === 'trak' || type === 'mdia' || type === 'mvex') {
          walk(body, stop);
        } else if (type === 'mvhd' && has(32)) {
          const v1 = dv.getUint8(body) === 1;
          scale = dv.getUint32(body + (v1 ? 20 : 12));
          length = v1 ? u64(body + 24) : dv.getUint32(body + 16);
        } else if (type === 'mehd' && has(12)) {
          fragments = dv.getUint8(body) === 1 ? u64(body + 4) : dv.getUint32(body + 4);
        } else if (type === 'hdlr' && has(12)) {
          const kind = name(body + 8);
          if (kind === 'soun' && !out.width) out.audio = true;
          if (kind === 'vide') out.audio = false;
        } else if (type === 'tkhd' && has(dv.getUint8(body) === 1 ? 96 : 84)) {
          const at = body + (dv.getUint8(body) === 1 ? 88 : 76);
          const w = dv.getUint32(at) / 65536, h = dv.getUint32(at + 4) / 65536;
          if (w && h) { out.width = Math.round(w); out.height = Math.round(h); out.audio = false; }
        } else if (type === 'sidx' && has(24)) {
          const v1 = dv.getUint8(body) === 1;
          const ticks = dv.getUint32(body + 8);
          let q = body + 12 + (v1 ? 16 : 8);
          const first = v1 ? u64(body + 20) : dv.getUint32(body + 16);
          const count = dv.getUint16(q + 2);
          q += 4;
          // Only a list that arrived whole can be added up.
          if (ticks && q + count * 12 <= end) {
            let bytesIn = 0, time = 0;
            for (let i = 0; i < count; i++, q += 12) {
              bytesIn += dv.getUint32(q) & 0x7fffffff;
              time += dv.getUint32(q + 4);
            }
            out.duration = time / ticks;
            // Where the index ends, plus everything it points at. A file may
            // carry a little more after that, so this is the least it holds.
            out.size = p + size + first + bytesIn;
          }
        }
        p += size;
      }
    };
    walk(0, end);
    if (!sawMovie) return null;
    if (!out.duration && scale) out.duration = (fragments || length) / scale;
    return out;
  }

  // Which of several candidate files is the video being pointed at.
  // `heads` is what head() said of each, in order of preference (null where
  // nothing could be read). `want` is what the page says of its video:
  // { duration, width, height }. `exact` is false when the files could not
  // settle it, and the first candidate still standing is offered as a guess;
  // `matched` says whether any file ran the right length at all.
  function match(heads, want) {
    const list = (heads || []).map((h, index) => ({ h, index }));
    if (!list.length) return { index: -1, exact: false, tied: 0, matched: false };
    const seconds = Number(want && want.duration) || 0;
    if (!(seconds > 0)) return { index: 0, exact: list.length === 1, tied: list.length, matched: false };

    // The page takes its figure from the same index, so a match is close to
    // exact. A quarter of a second allows for sound that runs a shade longer
    // than the picture.
    let near = list.filter((c) => c.h && c.h.duration > 0 && Math.abs(c.h.duration - seconds) <= 0.25);
    if (!near.length) return { index: 0, exact: false, tied: list.length, matched: false };
    if (near.length > 1) {
      const least = Math.min.apply(null, near.map((c) => Math.abs(c.h.duration - seconds)));
      const closest = near.filter((c) => Math.abs(c.h.duration - seconds) - least < 0.002);
      if (closest.length) near = closest;
    }
    if (near.length > 1 && want.width > 0 && want.height > 0) {
      // Two clips cut to the same length can still differ in shape. The page
      // may be playing a smaller version, so it is the proportions that count.
      const shape = want.width / want.height;
      const same = near.filter((c) => c.h.width && c.h.height && Math.abs(c.h.width / c.h.height - shape) / shape < 0.02);
      if (same.length) near = same;
    }
    return { index: near[0].index, exact: near.length === 1, tied: near.length, matched: true };
  }

  const api = { isTrack, whole, ranged, describe, pick, head, match, HOSTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
