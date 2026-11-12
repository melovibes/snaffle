/* Snaffle offline checks.  Run: node test/snaffle.test.js
   Covers the pure logic that is easy to break and hard to notice in a browser:
   URL rewriting, srcset and HLS playlist parsing, file-name building, the PDF
   writer's byte offsets, and whether the UI scripts reach for element ids that
   actually exist in their HTML. */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const S = require('../shared.js');
const H = require('../hls.js');
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

const { parseMaster, parseMedia, playlistBlocker, bestVariant, hasSplitAudio } = H;

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
eq('tallest variant wins', bestVariant(variants).url,
  'https://video.twimg.com/ext_tw_video/1234567890/pu/pl/720x1280/high.m3u8');
eq('variant height recorded', bestVariant(variants).height, 1280);
eq('a muxed master has no split audio', hasSplitAudio(master), false);
eq('a separate audio rendition is recognised',
  hasSplitAudio('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"\nv.m3u8'), true);
eq('an audio rendition muxed into the video (no URI) is not split audio',
  hasSplitAudio('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"\nv.m3u8'), false);
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

const nameHelpers = S;

eq('spaces and dashes kept', nameHelpers.sanitizeSegment('my photo-01.jpg'), 'my photo-01.jpg');
eq('illegal characters replaced', nameHelpers.sanitizeSegment('a/b:c*d?e"f<g>h|i'), 'a_b_c_d_e_f_g_h_i');
eq('trailing dot trimmed', nameHelpers.sanitizeSegment('  name.  '), 'name');
eq('template filled',
  nameHelpers.applyTemplate('{host}-{name}.{ext}', { host: 'example.com', name: 'pic', ext: 'jpg' }, 1),
  'example.com-pic.jpg');
eq('unknown token kept verbatim',
  nameHelpers.applyTemplate('{name}-{bogus}.{ext}', { name: 'pic', ext: 'jpg' }, 1), 'pic-{bogus}.jpg');
eq('index zero padded', nameHelpers.applyTemplate('{index}', {}, 42), '0042');

/* ----------------------------------------------------------------- config */

eq('nothing stored means the defaults', S.effective(undefined).folder, 'Snaffle/{host}');
eq('unchanged settings store nothing but the version', S.toStore(S.effective(null)), { v: S.CFG_VERSION });
eq('only the changed setting is stored',
  S.toStore(Object.assign(S.effective(null), { saveAs: true })), { v: S.CFG_VERSION, saveAs: true });

// What version 1.0 wrote at install: every default, including ones since changed.
const frozen = {
  enabled: true,
  key: { enabled: true, code: 'KeyD', label: 'Alt + D', ctrl: false, alt: true, shift: false, meta: false },
  mouse: { enabled: true, button: 1, label: 'Alt + Middle click', ctrl: false, alt: true, shift: false, meta: false },
  folder: 'HoverGrab/{host}', template: '{name}.{ext}', upgrade: true, toast: true
};
eq('an install-time copy of old defaults is not treated as a choice', S.toStore(frozen), { v: S.CFG_VERSION });
eq('so the old default folder gives way to the new one', S.effective(frozen).folder, 'Snaffle/{host}');
eq('and the old default shortcut gives way to the new one', S.keyLabel(S.effective(frozen).key), 'Alt + S');
eq('a real choice inside an old config survives',
  S.toStore(Object.assign({}, frozen, { folder: 'Pictures/{date}', key: Object.assign({}, frozen.key, { code: 'KeyG' }) })),
  { v: S.CFG_VERSION, key: { enabled: true, code: 'KeyG', ctrl: false, alt: true, shift: false, meta: false }, folder: 'Pictures/{date}' });
eq('a partly-set binding is completed from the defaults', S.effective({ mouse: { button: 2 } }).mouse,
  { enabled: true, button: 2, ctrl: false, alt: true, shift: false, meta: false });
eq('unknown keys are dropped', S.toStore({ nonsense: 1 }), { v: S.CFG_VERSION });
eq('labels', [S.keyLabel(S.DEFAULTS.captureKey), S.mouseLabel(S.DEFAULTS.mouse), S.keyLabel(S.DEFAULTS.key, true)],
  ['Alt + Shift + S', 'Alt + Middle click', 'Option + S']);
eq('path building', S.buildPath({ name: 'pic', ext: 'jpg', host: 'example.com' }, { folder: 'Snaffle/{host}', template: '{name}.{ext}' }, 7),
  'Snaffle/example.com/pic.jpg');
eq('an empty name falls back to the host', S.buildPath({ name: '', ext: 'png', host: 'example.com' }, { folder: '', template: '{name}.{ext}' }, 7),
  'example.com.png');

/* --------------------------------------------------- shortcut warnings */

const bind = (code, mods) => Object.assign({ code, ctrl: false, alt: false, shift: false, meta: false }, mods || {});
const click = (button, mods) => Object.assign({ button, ctrl: false, alt: false, shift: false, meta: false }, mods || {});

eq('the default shortcuts raise no warning',
  ['key', 'captureKey', 'galleryKey'].map((k) => S.keyWarning(S.DEFAULTS[k]).text).concat(S.mouseWarning(S.DEFAULTS.mouse).text), ['', '', '', '']);
eq('alt+d is flagged as the address bar, but allowed',
  [/address bar/.test(S.keyWarning(bind('KeyD', { alt: true })).text), S.keyWarning(bind('KeyD', { alt: true })).blocked], [true, false]);
eq('ctrl+t is flagged as something Chrome never passes on',
  [/never passes it/.test(S.keyWarning(bind('KeyT', { ctrl: true })).text), S.keyWarning(bind('KeyT', { ctrl: true })).blocked], [true, true]);
eq('a bare letter is flagged', /single keys/.test(S.keyWarning(bind('KeyS')).text), true);
eq('a bare function key is not', S.keyWarning(bind('F8')).text, '');
eq('plain left click is refused', S.mouseWarning(click(0)).blocked, true);
eq('ctrl+alt+left click is flagged as split view', /split view/.test(S.mouseWarning(click(0, { ctrl: true, alt: true })).text), true);
eq('plain right click is flagged as replacing the menu', /right-click menu/.test(S.mouseWarning(click(2)).text), true);
eq('back button is flagged as unreliable', /may not work/.test(S.mouseWarning(click(3, { alt: true })).text), true);
eq('shift+middle click is fine', S.mouseWarning(click(1, { shift: true })).text, '');

/* ------------------------------------------------- download verdict helpers */

const dl = S;

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
  const flags = /const FLAGS = \[([\s\S]*?)\];/.exec(read('options.js'))[1]
    .match(/'([^']+)'/g).map((x) => x.replace(/'/g, ''));
  eq('every options flag has a default', flags.filter((k) => !(k in S.DEFAULTS)), []);

  // The three key bindings must not ship colliding defaults.
  const sigs = ['key', 'captureKey', 'galleryKey'].map((k) => {
    const b = S.DEFAULTS[k];
    return [b.code, b.ctrl, b.alt, b.shift, b.meta].join('|');
  });
  eq('default key bindings are distinct', new Set(sigs).size, sigs.length);

  // Only the core is in every frame of every page. The screenshot and media
  // list code is loaded into a tab when asked for.
  const manifest = JSON.parse(read('manifest.json'));
  eq('always-on content scripts are the shared module and the core, in that order',
    manifest.content_scripts[0].js, ['shared.js', 'content.js']);

  // Every file the extension loads at run time must exist.
  const wantedFiles = ['shared.js', 'hls.js', 'offscreen.html', 'offscreen.js', 'capture.js', 'gallery.js',
    'vendor/mediabunny.min.mjs', 'vendor/mediabunny.LICENSE.txt', manifest.background.service_worker, manifest.options_page];
  eq('every file loaded at run time is present', wantedFiles.filter((x) => !fs.existsSync(path.join(ROOT, x))), []);
  eq('the worker page loads its scripts in dependency order',
    [...read('offscreen.html').matchAll(/src="([^"]+)"/g)].map((m) => m[1]), ['shared.js', 'hls.js', 'offscreen.js']);
  for (const html of ['options.html', 'popup.html']) {
    eq(html + ' loads the shared module before its own script',
      [...read(html).matchAll(/<script src="([^"]+)"/g)].map((m) => m[1])[0], 'shared.js');
  }
  eq('permissions cover what the service worker calls',
    ['scripting', 'offscreen', 'declarativeNetRequestWithHostAccess', 'downloads', 'webRequest', 'storage', 'contextMenus']
      .filter((p) => !manifest.permissions.includes(p)), []);
  eq('manifest description fits the store limit', manifest.description.length <= 132, true);
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
