/* Fixture server for the browser tests. Two instances run on different ports so
   pages can embed genuinely cross-origin content. Every request is logged, so a
   test can ask "which URL did the extension actually fetch?" instead of
   trusting what the UI claims. */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const FIXTURES = path.join(__dirname, 'fixtures');
const MEDIA = path.join(__dirname, 'media');

const pngCache = new Map();
function solidPng(w, h, hex) {
  const key = w + 'x' + h + '/' + hex;
  if (pngCache.has(key)) return pngCache.get(key);
  const png = new PNG({ width: w, height: h });
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  for (let i = 0; i < w * h; i++) {
    png.data[i * 4] = r; png.data[i * 4 + 1] = g; png.data[i * 4 + 2] = b; png.data[i * 4 + 3] = 255;
  }
  const buf = PNG.sync.write(png);
  pngCache.set(key, buf);
  return buf;
}

// A small generated landscape, for the demo page: a sky, a sun and two lines
// of hills. Drawn in proportions, so the same number gives the same picture
// at any size - a thumbnail and its full-size original really do match.
const SCENES = [
  ['2b1b4a', 'ff8a5c', 'ffe29a', '5a2d5e', '2a1533'],
  ['7ec8e3', 'fdf6e3', 'ffffff', '5fa777', '2f6b4f'],
  ['0f2042', '4a6fa5', 'f4f1de', '22335a', '0b1630'],
  ['f6c177', 'fbe3b5', 'fff4d6', 'c97b4a', '8a4b2a'],
  ['b8e0d2', 'eaf4f4', 'fefae0', '6a994e', '386641'],
  ['48cae4', 'caf0f8', 'ffffff', '0077b6', '023e8a'],
  ['10002b', '5a189a', 'e0aaff', '3c096c', '1a0033'],
  ['ffb4a2', 'ffe5d9', 'ffffff', 'b5838d', '6d6875'],
  ['90e0ef', 'f1faee', 'fff3b0', 'e09f3e', '9e2a2b']
];
const rgb = (hex) => [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (n) => Math.max(0, Math.min(1, n));

function scenePng(w, h, n) {
  const key = 'art' + w + 'x' + h + '/' + n;
  if (pngCache.has(key)) return pngCache.get(key);
  const [top, low, sun, far, near] = SCENES[n % SCENES.length].map(rgb);
  const png = new PNG({ width: w, height: h });
  const sunX = 0.2 + ((n * 37) % 60) / 100, sunY = 0.26 + ((n * 13) % 20) / 100, sunR = 0.085;
  const aspect = w / h;
  for (let y = 0; y < h; y++) {
    const v = y / h;
    for (let x = 0; x < w; x++) {
      const u = x / w;
      let c = mix(top, low, Math.pow(v, 1.15));
      const d = Math.hypot((u - sunX) * aspect, v - sunY);
      c = mix(c, sun, 0.35 * clamp01(1 - d / (sunR * 3.2)));          // glow
      c = mix(c, sun, clamp01((sunR - d) * h + 0.5));                  // disc
      const farY = 0.62 + 0.06 * Math.sin(u * 8.2 + n) + 0.025 * Math.sin(u * 19.5 + n * 2);
      c = mix(c, mix(far, near, clamp01((v - farY) * 1.2)), clamp01((v - farY) * h + 0.5));
      const nearY = 0.79 + 0.07 * Math.sin(u * 5.7 + n * 1.7) + 0.02 * Math.sin(u * 27 + n);
      c = mix(c, near, clamp01((v - nearY) * h + 0.5));
      const i = (y * w + x) * 4;
      png.data[i] = c[0]; png.data[i + 1] = c[1]; png.data[i + 2] = c[2]; png.data[i + 3] = 255;
    }
  }
  const buf = PNG.sync.write(png);
  pngCache.set(key, buf);
  return buf;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.mp4': 'video/mp4', '.m4s': 'video/iso.segment',
  '.m3u8': 'application/vnd.apple.mpegurl'
};

// Fake HLS streams: the bytes say which stream and rendition they came from,
// so an assembled file can be checked for exactly the right pieces in order.
function fakeHls(vid, file) {
  if (file === 'master.m3u8') {
    return [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180',
      'lo.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
      'hi.m3u8'
    ].join('\n');
  }
  if (file === 'master-audio.m3u8') {
    return [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",URI="audio.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="aud"',
      'hi.m3u8'
    ].join('\n');
  }
  const m = /^(hi|lo|audio)\.m3u8$/.exec(file);
  if (m) {
    return [
      '#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2',
      '#EXT-X-MAP:URI="' + m[1] + '-init.mp4"',
      '#EXTINF:2.0,', m[1] + '-seg0.m4s',
      '#EXTINF:2.0,', m[1] + '-seg1.m4s',
      '#EXTINF:2.0,', m[1] + '-seg2.m4s',
      '#EXT-X-ENDLIST'
    ].join('\n');
  }
  const s = /^(hi|lo|audio)-(init\.mp4|seg\d\.m4s)$/.exec(file);
  if (s) return Buffer.from('[' + vid + ':' + s[1] + ':' + s[2] + ']');
  return null;
}

function start(port, peerPort) {
  const log = [];
  let slowMs = 0;   // per-segment delay for /real and /guarded, set by a test

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1:' + port);
    const p = url.pathname;
    log.push({ path: p, search: url.search, referer: req.headers.referer || '', t: Date.now() });

    const send = (status, type, body, extra) => {
      res.writeHead(status, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store' }, extra || {}));
      res.end(body);
    };
    const CORS = { 'Access-Control-Allow-Origin': '*' };

    let m;

    // /img/<w>x<h>/<hex>/<name>.png - a solid PNG whose size identifies it.
    if ((m = /^\/img\/(\d+)x(\d+)\/([0-9a-f]{6})\/[^/]+\.png$/i.exec(p))) {
      return send(200, 'image/png', solidPng(+m[1], +m[2], m[3]));
    }
    // /art/<w>x<h>/<n>/<name>.png - a generated landscape, for the demo page.
    if ((m = /^\/art\/(\d+)x(\d+)\/(\d+)\/[^/]+\.png$/i.exec(p))) {
      if (+m[1] > 2400 || +m[2] > 2400) return send(400, 'text/plain', 'too large');
      return send(200, 'image/png', scenePng(+m[1], +m[2], +m[3]));
    }
    // /noext/<w>x<h>/<hex> - same, but no extension and a caller-chosen type.
    if ((m = /^\/noext\/(\d+)x(\d+)\/([0-9a-f]{6})$/i.exec(p))) {
      return send(200, url.searchParams.get('ct') || 'image/png', solidPng(+m[1], +m[2], m[3]));
    }
    // An "image" URL that answers 200 with a web page, like a hotlink landing page.
    if (/^\/htmlimg\//.test(p)) {
      return send(200, 'text/html; charset=utf-8', '<html><body>This is not an image.</body></html>');
    }
    // Hotlink protection: only served when a Referer is present.
    if ((m = /^\/protected\/[^/]+\.png$/.exec(p))) {
      if (!req.headers.referer) return send(403, 'text/plain', 'hotlinking refused');
      return send(200, 'image/png', solidPng(300, 200, '884400'), url.searchParams.has('cors') ? CORS : {});
    }
    if (p === '/article.html') {
      return send(200, 'text/html; charset=utf-8', '<html><body><h1>An article, not an image</h1></body></html>');
    }

    // Fake streams, with and without CORS.
    if ((m = /^\/(hls|hlsnocors)\/([a-z0-9]+)\/(.+)$/.exec(p))) {
      const body = fakeHls(m[2], m[3]);
      if (body == null) return send(404, 'text/plain', 'no such piece');
      const type = /\.m3u8$/.test(m[3]) ? TYPES['.m3u8'] : 'video/mp4';
      return send(200, type, body, m[1] === 'hls' ? CORS : {});
    }

    // Real ffmpeg-made streams: /real/<set>/<file>. `guarded` serves the same
    // files behind a Referer check, the way hotlink-protected CDNs serve video.
    // ?slow=N delays each segment by N ms, to keep a download running.
    if ((m = /^\/(real|guarded)\/([a-z]+)\/([^/]+)$/.exec(p))) {
      if (m[1] === 'guarded' && !/^http:\/\/127\.0\.0\.1:\d+\//.test(req.headers.referer || '')) {
        return send(403, 'text/plain', 'referer required', CORS);
      }
      const file = path.join(MEDIA, m[2], m[3]);
      if (!fs.existsSync(file)) return send(404, 'text/plain', 'missing', CORS);
      const ext = path.extname(file);
      const type = TYPES[ext] || (ext === '.ts' ? 'video/mp2t' : 'application/octet-stream');
      const slow = /\.(m4s|ts)$/.test(file) ? slowMs : 0;
      return setTimeout(() => send(200, type, fs.readFileSync(file), CORS), slow);
    }
    if ((m = /^\/vendor\/([^/]+)$/.exec(p))) {
      const file = path.join(__dirname, '..', '..', 'vendor', m[1]);
      if (fs.existsSync(file)) return send(200, 'text/javascript', fs.readFileSync(file), CORS);
    }

    // A real fMP4 HLS stream under X-shaped paths, so the media id in the
    // poster and in the playlist URL line up the way they do on X.
    if ((m = /^\/ext_tw_video\/(\d+)\/pu\/pl\/(.+)$/.exec(p))) {
      if (m[2] === 'master.m3u8') {
        return send(200, TYPES['.m3u8'],
          '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=320x240\nmedia.m3u8\n', CORS);
      }
      const file = path.join(MEDIA, path.basename(m[2]));
      if (fs.existsSync(file)) {
        return send(200, TYPES[path.extname(file)] || 'application/octet-stream', fs.readFileSync(file), CORS);
      }
      return send(404, 'text/plain', 'missing');
    }
    if ((m = /^\/ext_tw_video_thumb\/(\d+)\/pu\/img\/[^/]+\.png$/.exec(p))) {
      return send(200, 'image/png', solidPng(320, 240, '334455'));
    }
    if ((m = /^\/media\/([^/]+)$/.exec(p))) {
      const file = path.join(MEDIA, m[1]);
      if (fs.existsSync(file)) return send(200, TYPES[path.extname(file)] || 'application/octet-stream', fs.readFileSync(file));
    }

    // Static fixture pages. {{A}} and {{B}} become the two origins.
    if ((m = /^\/pages\/([a-z0-9-]+\.html)$/.exec(p))) {
      const file = path.join(FIXTURES, m[1]);
      if (fs.existsSync(file)) {
        const html = fs.readFileSync(file, 'utf8')
          .replace(/\{\{A\}\}/g, 'http://127.0.0.1:' + port)
          .replace(/\{\{B\}\}/g, 'http://127.0.0.1:' + peerPort)
          .replace(/\{\{A_ENC\}\}/g, encodeURIComponent('http://127.0.0.1:' + port));
        return send(200, TYPES['.html'], html);
      }
    }
    if (p === '/favicon.ico') return send(204, 'image/x-icon', '');

    send(404, 'text/plain', 'not found: ' + p);
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({
      port,
      origin: 'http://127.0.0.1:' + port,
      log,
      mark: () => log.length,
      slow: (ms) => { slowMs = ms; },
      since: (mark) => log.slice(mark),
      close: () => new Promise((r) => server.close(r))
    }));
  });
}

module.exports = { start, solidPng };
