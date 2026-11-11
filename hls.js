/* Snaffle - minimal HLS playlist reading, for the fallback joiner.

   The normal route for a streamed video is the bundled Mediabunny library,
   which reads the playlist itself and writes a proper MP4. This file backs the
   plain route used when that fails: take the best rendition's segments and
   join them end to end. It only needs to find those segments and to recognise
   the streams that joining cannot handle. */
var SnaffleHls = (typeof SnaffleHls !== 'undefined' && SnaffleHls) || (function () {

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

  // Highest resolution first, bandwidth as the tie-break.
  function bestVariant(variants) {
    return variants.slice().sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth))[0] || null;
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

  // Audio kept in its own rendition: joining the video segments alone would
  // give a silent file.
  const hasSplitAudio = (masterText) => /#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*URI="/i.test(masterText);

  // Why a media playlist cannot simply be joined, or '' if it can.
  function playlistBlocker(text) {
    if (/#EXT-X-KEY:(?!.*METHOD=NONE)/i.test(text)) return 'This stream is encrypted (DRM) and cannot be saved.';
    if (/#EXT-X-BYTERANGE/i.test(text)) return 'This stream uses byte-range segments, which cannot be joined.';
    return '';
  }

  return { parseMaster, bestVariant, parseMedia, hasSplitAudio, playlistBlocker };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SnaffleHls;
