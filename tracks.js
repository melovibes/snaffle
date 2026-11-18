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
  // Tracks of one post share an asset id. The post is chosen by length first,
  // then by which was asked for most recently, and the result is marked as a
  // guess when more than one post was still in the running.
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
    pool.sort((a, b) => a.ts - b.ts);
    const g = pool[pool.length - 1];

    const best = (list) => list.slice().sort((a, b) => (a.bitrate - b.bitrate) || ((a.ts || 0) - (b.ts || 0))).pop() || null;
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
    return {
      video: video.url,
      audio: audio ? audio.url : '',
      guessed: pool.length > 1 || !typed,
      posts: pool.length,
      typed
    };
  }

  const api = { isTrack, whole, ranged, describe, pick, HOSTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
