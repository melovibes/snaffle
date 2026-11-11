/* Snaffle offline checks.  Run: node test/snaffle.test.js
   Covers the pure logic that is easy to break and hard to notice in a browser:
   URL rewriting, srcset and HLS playlist parsing, file-name building, the PDF
   writer's byte offsets, and whether the UI scripts reach for element ids that
   actually exist in their HTML. */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let fails = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? 'PASS ' : 'FAIL ') + label +
    (ok ? '' : '\n   got:  ' + JSON.stringify(got) + '\n   want: ' + JSON.stringify(want)));
}

// Pull a function out of a content script without running its IIFE.
function lift(file, startMarker, endMarker, names, scope) {
  const src = read(file);
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  if (a < 0 || b < 0) throw new Error('marker missing in ' + file + ': ' + startMarker);
  const body = src.slice(a, b);
  const keys = Object.keys(scope || {});
  const fn = new Function(...keys, body + '\nreturn {' + names.join(',') + '};');
  return fn(...keys.map((k) => scope[k]));
}

/* ------------------------------------------------------------- url rewriting */

const { upgrade } = lift('content.js', 'function upgrade(url)',
  '/* ------------------------------------------------------ media resolver */',
  ['upgrade'], { cfg: { upgrade: true } });

eq('x/twitter name=orig',
  upgrade('https://pbs.twimg.com/media/ABC123?format=jpg&name=small'),
  'https://pbs.twimg.com/media/ABC123?format=jpg&name=orig');
eq('x/twitter :large suffix',
  upgrade('https://pbs.twimg.com/media/ABC123.jpg:large'),
  'https://pbs.twimg.com/media/ABC123.jpg:orig');
eq('reddit preview to i.redd.it',
  upgrade('https://preview.redd.it/abc123.jpg?width=640&crop=smart'),
  'https://i.redd.it/abc123.jpg');
eq('imgur thumbnail suffix',
  upgrade('https://i.imgur.com/aBcDeF1m.jpg'), 'https://i.imgur.com/aBcDeF1.jpg');
eq('imgur non-thumbnail untouched',
  upgrade('https://i.imgur.com/aBcDeF1.jpg'), 'https://i.imgur.com/aBcDeF1.jpg');
eq('wikimedia thumb path',
  upgrade('https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Cat.jpg/800px-Cat.jpg'),
  'https://upload.wikimedia.org/wikipedia/commons/a/ab/Cat.jpg');
eq('substack proxy unwrapped',
  upgrade('https://substackcdn.com/image/fetch/w_1456,c_limit/https%3A%2F%2Fbucket.s3.amazonaws.com%2Freal.png'),
  'https://bucket.s3.amazonaws.com/real.png');
eq('weserv url= proxy',
  upgrade('https://images.weserv.nl/?url=https://example.com/photo.jpg&w=300'),
  'https://example.com/photo.jpg');
eq('resize params stripped',
  upgrade('https://cdn.example.com/photo.jpg?width=400&height=300&quality=70&v=9'),
  'https://cdn.example.com/photo.jpg?v=9');
eq('signed url left alone',
  upgrade('https://cdn.example.com/photo.jpg?w=400&X-Amz-Signature=deadbeef'),
  'https://cdn.example.com/photo.jpg?w=400&X-Amz-Signature=deadbeef');
eq('instagram cdn left alone',
  upgrade('https://scontent.cdninstagram.com/v/t51.png?w=320&stp=dst-jpg'),
  'https://scontent.cdninstagram.com/v/t51.png?w=320&stp=dst-jpg');
eq('shopify size suffix',
  upgrade('https://cdn.shopify.com/s/files/1/0/shirt_1024x1024.jpg'),
  'https://cdn.shopify.com/s/files/1/0/shirt.jpg');
eq('squarespace format',
  upgrade('https://images.squarespace-cdn.com/content/abc/photo?format=750w'),
  'https://images.squarespace-cdn.com/content/abc/photo?format=original');
eq('data url passthrough', upgrade('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');

// Rewrites that used to turn an image into something else.
eq('tracking parameter with an encoded page url is not unwrapped',
  upgrade('https://cdn.example.com/a.png?ref=https%3A%2F%2Fexample.com%2Farticle.html'),
  'https://cdn.example.com/a.png?ref=https%3A%2F%2Fexample.com%2Farticle.html');
eq('url= parameter pointing at a page is not followed',
  upgrade('https://cdn.example.com/a.png?url=https://example.com/landing'),
  'https://cdn.example.com/a.png?url=https://example.com/landing');
eq('reddit external-preview is left alone (signed, no i.redd.it copy)',
  upgrade('https://external-preview.redd.it/abc.jpg?width=640&s=sig'),
  'https://external-preview.redd.it/abc.jpg?width=640&s=sig');

/* ------------------------------------------------------------------ srcset */

const { parseSrcset } = lift('content.js', 'function parseSrcset(input)',
  '/* ------------------------------------------------- full-res "upgrades" */',
  ['parseSrcset']);

const set1 = parseSrcset('small.jpg 320w, medium.jpg 640w, large.jpg 1280w');
eq('srcset count', set1.length, 3);
eq('srcset widest url', set1[2].url, 'large.jpg');
eq('srcset widest descriptor', set1[2].desc, '1280w');
const set2 = parseSrcset('a.jpg, b.jpg 2x');
eq('srcset bare comma', [set2.length, set2[0].url, set2[1].desc], [2, 'a.jpg', '2x']);
const set3 = parseSrcset('https://x.com/i.jpg?a=1,b=2 1000w');
eq('srcset comma inside query', [set3.length, set3[0].url], [1, 'https://x.com/i.jpg?a=1,b=2']);

/* -------------------------------------------------------------- hls playlists */

const { parseMaster, parseMedia, playlistBlocker } = lift('content.js',
  'function parseMaster(text, base)', 'async function assembleStream(',
  ['parseMaster', 'parseMedia', 'playlistBlocker']);

const MASTER_URL = 'https://video.twimg.com/ext_tw_video/1234567890/pu/pl/aBcDeF.m3u8';
const master = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=288000,RESOLUTION=320x568',
  '/ext_tw_video/1234567890/pu/pl/320x568/low.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2176000,RESOLUTION=720x1280',
  '/ext_tw_video/1234567890/pu/pl/720x1280/high.m3u8'
].join('\n');
const variants = parseMaster(master, MASTER_URL);
eq('master variant count', variants.length, 2);
variants.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
eq('tallest variant wins', variants[0].url,
  'https://video.twimg.com/ext_tw_video/1234567890/pu/pl/720x1280/high.m3u8');
eq('variant height recorded', variants[0].height, 1280);
eq('comment between tag and uri',
  parseMaster('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=9\n# note\nv/360.m3u8',
    'https://cdn.example.com/a/master.m3u8')[0].url,
  'https://cdn.example.com/a/v/360.m3u8');

const MEDIA_URL = 'https://video.twimg.com/ext_tw_video/1/pu/pl/720x1280/high.m3u8';
const fmp4 = ['#EXTM3U', '#EXT-X-VERSION:7',
  '#EXT-X-MAP:URI="/ext_tw_video/1/pu/vid/init.mp4"',
  '#EXTINF:3.000,', '/ext_tw_video/1/pu/vid/seg1.m4s',
  '#EXTINF:3.000,', '/ext_tw_video/1/pu/vid/seg2.m4s', '#EXT-X-ENDLIST'].join('\n');
const parsed = parseMedia(fmp4, MEDIA_URL);
eq('init segment resolved', parsed.init, 'https://video.twimg.com/ext_tw_video/1/pu/vid/init.mp4');
eq('segment count', parsed.segs.length, 2);
eq('segment resolved', parsed.segs[1], 'https://video.twimg.com/ext_tw_video/1/pu/vid/seg2.m4s');

const ts = parseMedia('#EXTM3U\n#EXTINF:10.0,\nseg0.ts\n#EXTINF:10.0,\nseg1.ts\n#EXT-X-ENDLIST',
  'https://cdn.example.com/v/720/index.m3u8');
eq('ts playlist has no init', ts.init, '');
eq('ts relative segment resolved', ts.segs[0], 'https://cdn.example.com/v/720/seg0.ts');

eq('clean playlist allowed', playlistBlocker(fmp4), '');
eq('aes key refused',
  playlistBlocker('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k.bin"\nseg0.ts').length > 0, true);
eq('method none allowed', playlistBlocker('#EXTM3U\n#EXT-X-KEY:METHOD=NONE\nseg0.ts'), '');
eq('byterange refused',
  playlistBlocker('#EXTM3U\n#EXT-X-BYTERANGE:75232@0\nseg0.ts').length > 0, true);

/* ----------------------------------------------------------- file names */

const nameHelpers = lift('background.js', 'function sanitizeSegment(s)',
  'async function nextIndex()', ['sanitizeSegment', 'applyTemplate'],
  { pad: (n) => String(n).padStart(2, '0') });

eq('spaces and dashes kept', nameHelpers.sanitizeSegment('my photo-01.jpg'), 'my photo-01.jpg');
eq('illegal characters replaced', nameHelpers.sanitizeSegment('a/b:c*d?e"f<g>h|i'), 'a_b_c_d_e_f_g_h_i');
eq('trailing dot trimmed', nameHelpers.sanitizeSegment('  name.  '), 'name');
eq('template filled',
  nameHelpers.applyTemplate('{host}-{name}.{ext}', { host: 'example.com', name: 'pic', ext: 'jpg' }, 1),
  'example.com-pic.jpg');
eq('unknown token kept verbatim',
  nameHelpers.applyTemplate('{name}-{bogus}.{ext}', { name: 'pic', ext: 'jpg' }, 1), 'pic-{bogus}.jpg');
eq('index zero padded', nameHelpers.applyTemplate('{index}', {}, 42), '0042');

/* ------------------------------------------------- download verdict helpers */

const dl = lift('background.js', 'const MIME_EXT = {', '// Runs for every download in the browser',
  ['nameForMime', 'notMedia']);

eq('extension-less name takes the served type', dl.nameForMime('Snaffle/x/808080.jpg', 'image/webp'), 'Snaffle/x/808080.webp');
eq('jpg address serving webp is renamed', dl.nameForMime('photo.jpg', 'image/webp; charset=binary'), 'photo.webp');
eq('jpeg and jpg are the same type', dl.nameForMime('photo.jpeg', 'image/jpeg'), 'photo.jpeg');
eq('matching type is untouched', dl.nameForMime('a/b/clip.mp4', 'video/mp4'), 'a/b/clip.mp4');
eq('unknown type is untouched', dl.nameForMime('file.bin', 'application/octet-stream'), 'file.bin');
eq('name with no extension gains one', dl.nameForMime('folder/key', 'image/png'), 'folder/key.png');

eq('html is not media', dl.notMedia('text/html; charset=utf-8'), true);
eq('json is not media', dl.notMedia('application/json'), true);
eq('svg is media despite being xml', dl.notMedia('image/svg+xml'), false);
eq('octet-stream is given the benefit of the doubt', dl.notMedia('application/octet-stream'), false);
eq('missing type is given the benefit of the doubt', dl.notMedia(''), false);

const { streamGroups } = lift('background.js', 'function streamGroups(entries)', 'async function findStream(',
  ['streamGroups']);

// One video is a master playlist plus the variants the player then asks for.
const oneVideo = streamGroups([
  { url: 'https://v.example.com/ext_tw_video/9/pu/pl/master.m3u8', ts: 1 },
  { url: 'https://v.example.com/ext_tw_video/9/pu/pl/avc1/720x1280/v.m3u8', ts: 2 },
  { url: 'https://v.example.com/ext_tw_video/9/pu/pl/mp4a/128000/a.m3u8', ts: 3 }
]);
eq('master and its variants count as one stream', oneVideo.length, 1);
eq('the group is represented by its master', oneVideo[0].url, 'https://v.example.com/ext_tw_video/9/pu/pl/master.m3u8');
const twoVideos = streamGroups([
  { url: 'https://v.example.com/hls/b/master.m3u8', ts: 5 },
  { url: 'https://v.example.com/hls/c/master.m3u8', ts: 2 },
  { url: 'https://v.example.com/hls/c/hi.m3u8', ts: 3 }
]);
eq('separate directories are separate streams', twoVideos.length, 2);
eq('groups are ordered by most recent activity', twoVideos[twoVideos.length - 1].url, 'https://v.example.com/hls/b/master.m3u8');

/* ------------------------------------------------------------------- PDF */

const { pdfFromJpeg } = lift('capture.js', 'async function pdfFromJpeg(jpeg, pxW, pxH)',
  '  api.capture = capturePage;', ['pdfFromJpeg']);

(async () => {
  // Not a real JPEG - the writer only embeds the bytes, it does not parse them.
  const jpeg = new Uint8Array(512).fill(0x5a);
  const blob = await pdfFromJpeg(jpeg, 1200, 9000);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const text = Buffer.from(bytes).toString('latin1');

  eq('pdf header', text.slice(0, 8), '%PDF-1.4');
  eq('pdf trailer present', /startxref\n(\d+)\n%%EOF\n$/.test(text), true);

  const startxref = parseInt(/startxref\n(\d+)\n%%EOF/.exec(text)[1], 10);
  eq('startxref points at the xref table', text.slice(startxref, startxref + 4), 'xref');

  // Every offset in the table must land exactly on its object header.
  const table = text.slice(startxref);
  const entries = table.match(/^(\d{10}) 00000 n $/gm) || [];
  eq('xref lists five objects', entries.length, 5);
  let offsetsOk = true;
  entries.forEach((line, i) => {
    const off = parseInt(line.slice(0, 10), 10);
    if (!text.startsWith(String(i + 1) + ' 0 obj', off)) offsetsOk = false;
  });
  eq('every xref offset lands on its object', offsetsOk, true);

  eq('image stream length declared correctly',
    parseInt(/\/Filter \/DCTDecode \/Length (\d+)/.exec(text)[1], 10), jpeg.length);
  eq('jpeg bytes embedded', text.indexOf('ZZZZZZZZ') > 0, true);

  // A 1200x9000 capture is taller than the 14400pt page limit allows at 612pt
  // wide, so the page must be clamped and the width scaled to match.
  const box = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(text);
  const ptW = parseFloat(box[1]);
  const ptH = parseFloat(box[2]);
  eq('page height within the pdf limit', ptH <= 14400, true);
  eq('page keeps the image aspect ratio', Math.abs((ptW / ptH) - (1200 / 9000)) < 0.01, true);

  /* -------------------------------------------------- html / script wiring */

  // A typo in an id throws on page load and the whole options page dies, so
  // check that every id these scripts reach for is actually in the markup.
  for (const [js, html] of [['options.js', 'options.html'], ['popup.js', 'popup.html']]) {
    const ids = new Set();
    for (const m of read(html).matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);
    const wanted = new Set();
    for (const m of read(js).matchAll(/\$\('([^']+)'\)/g)) wanted.add(m[1]);
    const missing = [...wanted].filter((id) => !ids.has(id));
    eq(js + ' references only ids present in ' + html, missing, []);
  }

  // Every id the options page collects must exist as a default, or Save writes
  // a key nothing reads.
  const optionsSrc = read('options.js');
  const flags = /const FLAGS = \[([\s\S]*?)\];/.exec(optionsSrc)[1]
    .match(/'([^']+)'/g).map((s) => s.replace(/'/g, ''));
  const defaults = /const DEFAULTS = \{([\s\S]*?)\n\};/.exec(optionsSrc)[1];
  const missingDefaults = flags.filter((f) => !new RegExp('\\b' + f + ':').test(defaults));
  eq('every options flag has a default', missingDefaults, []);

  // The three key bindings must not ship colliding defaults.
  const sigs = ['key', 'captureKey', 'galleryKey'].map((f) => {
    const line = new RegExp('\\b' + f + ': \\{([^}]*)\\}').exec(defaults)[1];
    return ['code', 'ctrl', 'alt', 'shift', 'meta']
      .map((k) => (new RegExp(k + ": '?([^,'}]+)'?").exec(line) || [])[1]).join('|');
  });
  eq('default key bindings are distinct', new Set(sigs).size, sigs.length);

  // Content scripts load in manifest order and the later two need the shared
  // object the first one publishes.
  const manifest = JSON.parse(read('manifest.json'));
  eq('content scripts load core first',
    manifest.content_scripts[0].js, ['content.js', 'capture.js', 'gallery.js']);
  const api = /const api = \{([\s\S]*?)\n  \};/.exec(read('content.js'))[1];
  const used = new Set();
  for (const f of ['capture.js', 'gallery.js']) {
    for (const m of read(f).matchAll(/\bapi\.([A-Za-z_$][\w$]*)/g)) used.add(m[1]);
  }
  const notExported = [...used].filter((n) => !new RegExp('\\b' + n + '\\b').test(api));
  eq('capture.js and gallery.js only use exported helpers', notExported, []);

  console.log(fails ? '\n' + fails + ' FAILURE(S)' : '\nAll ' + 'checks passed.');
  process.exit(fails ? 1 : 0);
})();
