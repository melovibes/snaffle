/* File-name checks, with Chromium downloading the way it does for a user.

     npm run test:native     (needs ffprobe on the PATH, like the browser checks)

   The main browser checks drive the extension through Playwright, which takes
   over downloads: files are saved under ids, and Chrome's file-naming hook is
   skipped. So those checks can prove what was fetched and what the message
   said, but not what the file on disk is called or which folder it is in.

   Here the same Chromium is started by hand and driven over the DevTools
   protocol with nothing touching downloads, into a throwaway profile whose
   download folder is a temporary directory. What lands in that directory is
   what a user would find in Downloads. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { start, throwawayCert } = require('./server');
const { FILES: SHIPPED } = require('../../tools/shipped');

const ROOT = path.join(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const only = process.argv[2] || '';

/* ------------------------------------------------- a small protocol client */

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let next = 0;
    const waiting = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id == null || !waiting.has(msg.id)) return;
      const w = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error.message)); else w.resolve(msg.result);
    });
    ws.addEventListener('error', () => reject(new Error('could not reach the browser')));
    ws.addEventListener('open', () => resolve({
      send(method, params, sessionId) {
        const id = ++next;
        return new Promise((res, rej) => {
          waiting.set(id, { resolve: res, reject: rej });
          ws.send(JSON.stringify(Object.assign({ id, method, params: params || {} }, sessionId ? { sessionId } : {})));
        });
      },
      close() { try { ws.close(); } catch (_) {} }
    }));
  });
}

async function launch(dlDir) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'snaffle-native-'));
  const extDir = path.join(work, 'ext');
  const profile = path.join(work, 'profile');
  for (const f of SHIPPED) {
    fs.mkdirSync(path.dirname(path.join(extDir, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(extDir, f));
  }
  // Downloads go to our own folder, never the real one, and never ask.
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({
    download: { default_directory: dlDir, prompt_for_download: false, directory_upgrade: true },
    safebrowsing: { enabled: false },
    profile: { default_content_setting_values: { automatic_downloads: 1 } }
  }));

  const child = spawn(chromium.executablePath(), [
    '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--window-size=1000,700',
    '--disable-extensions-except=' + extDir, '--load-extension=' + extDir,
    '--host-resolver-rules=MAP www.instagram.com 127.0.0.1, MAP *.cdninstagram.com 127.0.0.1',
    '--ignore-certificate-errors',
    // Without a display server and as root on a build machine, Chromium needs both.
    ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    'about:blank'
  ], { stdio: 'ignore' });

  // Chromium writes the port it chose into the profile once it is listening.
  const portFile = path.join(profile, 'DevToolsActivePort');
  let lines = null;
  for (let i = 0; i < 150 && !lines; i++) {
    await sleep(100);
    try { const t = fs.readFileSync(portFile, 'utf8').trim().split('\n'); if (t.length >= 2) lines = t; } catch (_) {}
  }
  if (!lines) { child.kill(); throw new Error('Chromium did not start'); }
  const cdp = await connect('ws://127.0.0.1:' + lines[0].trim() + lines[1].trim());

  const b = {
    cdp, work,
    async targets() { return (await cdp.send('Target.getTargets')).targetInfos; },
    async attach(targetId) {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      const page = {
        targetId, sessionId,
        send: (method, params) => cdp.send(method, params, sessionId),
        async eval(expression) {
          const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
          if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
          return r.result.value;
        },
        async until(expression, ms) {
          const end = Date.now() + (ms || 15000);
          while (Date.now() < end) {
            try { if (await page.eval(expression)) return true; } catch (_) {}
            await sleep(150);
          }
          throw new Error('timed out waiting for: ' + expression);
        },
        async hover(selector) {
          const box = await page.eval('(() => { const e = document.querySelector(' + JSON.stringify(selector) + '); e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()');
          await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x - 8, y: box.y - 8 });
          await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
          await sleep(120);
          await page.clear();
        },
        // modifiers: 1 Alt, 8 Shift
        async press(code, key, vk, modifiers) {
          const ev = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
          await page.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, ev));
          await page.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, ev));
        },
        // Take down the messages already showing, so the next one read is new.
        clear: () => page.eval('(() => { const h = document.getElementById("__snaffle_ui"); if (h && h.shadowRoot) h.shadowRoot.querySelectorAll(".toast").forEach((t) => t.remove()); })()'),
        toast: () => page.eval('(() => { const h = document.getElementById("__snaffle_ui"); if (!h || !h.shadowRoot) return ""; const all = Array.from(h.shadowRoot.querySelectorAll(".toast")); if (!all.length) return ""; return all.sort((x, y) => Number(y.dataset.seq) - Number(x.dataset.seq))[0].querySelector(".msg").textContent; })()'),
        close: () => cdp.send('Target.closeTarget', { targetId })
      };
      await page.send('Page.enable');
      await page.send('Runtime.enable');
      return page;
    },
    async open(url) {
      // Opened blank and then sent to the address, which is how a tab reaches
      // one of the extension's own pages; asking for it directly is refused.
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const page = await b.attach(targetId);
      await page.send('Page.navigate', { url });
      await page.until('location.href !== "about:blank" && document.readyState === "complete"');
      await page.send('Page.bringToFront');
      return page;
    },
    async close() {
      try { await cdp.send('Browser.close'); } catch (_) {}
      cdp.close();
      await sleep(500);
      try { child.kill(); } catch (_) {}
      for (let i = 0; i < 10; i++) {
        try { fs.rmSync(work, { recursive: true, force: true }); break; } catch (_) { await sleep(300); }
      }
    }
  };

  // Chromium has service workers of its own. Ours is the one whose manifest
  // says so, and its address gives the extension its id.
  let id = '';
  for (let i = 0; i < 100 && !id; i++) {
    for (const t of (await b.targets()).filter((x) => x.type === 'service_worker' && /^chrome-extension:/.test(x.url))) {
      try {
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
        const r = await cdp.send('Runtime.evaluate', { expression: 'chrome.runtime.getManifest().name', returnByValue: true }, sessionId);
        await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
        if (r.result && r.result.value === 'Snaffle') { id = new URL(t.url).host; break; }
      } catch (_) {}
    }
    if (!id) await sleep(100);
  }
  if (!id) { await b.close(); throw new Error('the extension did not load'); }
  b.extId = id;
  return b;
}

/* ------------------------------------------------------------------ checks */

// Every finished file under the download folder, as paths relative to it.
function filesIn(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (!/\.(crdownload|tmp)$/i.test(e.name)) out.push(r);
    }
  };
  try { walk(dir, ''); } catch (_) {}
  return out.sort();
}

const results = [];
async function check(id, expect, fn) {
  if (only && only !== id) return;
  const row = { id, expect, ok: false, observed: '' };
  try { const r = await fn(); row.ok = !!r.ok; row.observed = r.observed; }
  catch (e) { row.observed = 'harness error: ' + String((e && e.message) || e).split('\n')[0]; }
  results.push(row);
  console.log('[' + (row.ok ? ' ok ' : 'FAIL') + '] ' + id + '  ' + expect + '\n        -> ' + row.observed);
}

(async () => {
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snaffle-downloads-'));
  const cert = await throwawayCert();
  const A = await start(4701, 4702, { key: cert.key, cert: cert.cert, port: 4711, peerPort: 4712 });
  const B = await start(4702, 4701, { key: cert.key, cert: cert.cert, port: 4712, peerPort: 4711 });
  const b = await launch(dlDir);

  // New files since the last look, once they have stopped arriving.
  let known = new Set(filesIn(dlDir));
  const arrived = async (ms, count) => {
    const end = Date.now() + (ms || 12000);
    let fresh = [];
    while (Date.now() < end) {
      fresh = filesIn(dlDir).filter((f) => !known.has(f));
      if (fresh.length >= (count || 1)) { await sleep(400); fresh = filesIn(dlDir).filter((f) => !known.has(f)); break; }
      await sleep(200);
    }
    known = new Set(filesIn(dlDir));
    return fresh;
  };
  const settled = async (page, ms) => {
    const end = Date.now() + (ms || 8000);
    let last = '';
    while (Date.now() < end) {
      last = await page.toast();
      if (/^(Saved|Could not|No image|Streamed video|This video|Screenshot)/.test(last)) return last;
      await sleep(200);
    }
    return last;
  };
  const setCfg = async (patch) => {
    const opt = await b.open('chrome-extension://' + b.extId + '/options.html');
    await opt.eval('(async () => { const s = await chrome.storage.sync.get("cfg"); const next = SnaffleShared.toStore(Object.assign(SnaffleShared.effective(s.cfg), ' + JSON.stringify(patch) + ')); if (Object.keys(next).length <= 1) await chrome.storage.sync.remove("cfg"); else await chrome.storage.sync.set({ cfg: next }); })()');
    await sleep(200);
    await opt.close();
  };
  const said = (toast) => (/^Saved (?:\d+ images, starting with )?(Snaffle\/.+?\.[a-z0-9]{2,5})(?= \(|\.|$)/.exec(toast || '') || [])[1] || '';
  // The promise every save makes: the file is where the message says it is.
  const verdict = (toast, fresh, want) => ({
    ok: fresh.length === 1 && fresh[0] === want && said(toast) === want,
    observed: 'message "' + toast + '"; on disk: ' + (fresh.join(', ') || 'nothing new')
  });

  try {
    const grabPage = await b.open(A.origin + '/pages/grab.html');
    await sleep(600);

    await check('N01', 'A picture is saved under its own name in the Snaffle folder', async () => {
      await grabPage.hover('#plain img');
      await grabPage.press('KeyS', 's', 83, 1);
      const toast = await settled(grabPage);
      return verdict(toast, await arrived(), 'Snaffle/127.0.0.1/plain.png');
    });

    await check('N02', 'A picture with no extension in its address is named for what its bytes are (PNG), whatever the server calls it (WebP)', async () => {
      await grabPage.hover('#noext img');
      await grabPage.press('KeyS', 's', 83, 1);
      const toast = await settled(grabPage);
      return verdict(toast, await arrived(), 'Snaffle/127.0.0.1/808080.png');
    });

    await check('N03', 'A picture held only in the page (a canvas) is saved by name into the folder', async () => {
      await grabPage.hover('#canvas canvas');
      await grabPage.press('KeyS', 's', 83, 1);
      const toast = await settled(grabPage);
      const fresh = await arrived();
      const want = said(toast);
      return { ok: fresh.length === 1 && fresh[0] === want && /^Snaffle\/127\.0\.0\.1\/.+\.png$/.test(want), observed: 'message "' + toast + '"; on disk: ' + (fresh.join(', ') || 'nothing new') };
    });
    await grabPage.close();

    await check('N04', 'A rebuilt stream is saved under its name in the folder, not under a random one', async () => {
      const page = await b.open(A.origin + '/pages/stream.html');
      await page.until('/ready/.test(document.title)');
      await sleep(500);
      await page.hover('#vx');
      await page.press('KeyS', 's', 83, 1);
      const toast = await settled(page, 25000);
      const fresh = await arrived(15000);
      await page.close();
      return verdict(toast, fresh, 'Snaffle/127.0.0.1/video-111-240p.mp4');
    });

    await check('N05', 'An Instagram video is saved as account-shortcode-height.mp4 in the folder', async () => {
      const page = await b.open('https://www.instagram.com:4711/instagram/reel/Df2aGgPtPZQ/');
      await page.until('/ready/.test(document.title)');
      await sleep(500);
      await page.hover('#player');
      await page.press('KeyS', 's', 83, 1);
      const toast = await settled(page, 25000);
      const fresh = await arrived(15000);
      await page.close();
      return verdict(toast, fresh, 'Snaffle/instagram.com/instagram-Df2aGgPtPZQ-568p.mp4');
    });

    await check('N06', 'A screenshot saved straight away is named after the page, in the folder', async () => {
      await setCfg({ captureThen: 'save' });
      const page = await b.open(A.origin + '/pages/tall.html');
      await sleep(500);
      await page.hover('body');
      await page.press('KeyS', 'S', 83, 9);
      const toast = await settled(page, 30000);
      const fresh = await arrived(15000);
      await page.close();
      await setCfg({ captureThen: 'review' });
      return verdict(toast, fresh, 'Snaffle/127.0.0.1/Tall fixture.png');
    });

    await check('N07', 'A screenshot saved from its results page goes in the folder; as the second file of that name, the message gives the name it really got', async () => {
      const page = await b.open(A.origin + '/pages/tall.html');
      await sleep(500);
      await page.hover('body');
      await page.press('KeyS', 'S', 83, 9);
      let target = null;
      for (let i = 0; i < 150 && !target; i++) {
        target = (await b.targets()).find((t) => t.type === 'page' && /\/result\.html/.test(t.url));
        if (!target) await sleep(200);
      }
      if (!target) return { ok: false, observed: 'the results page never opened; message "' + await page.toast() + '"' };
      const result = await b.attach(target.targetId);
      await result.until('!!document.querySelector("#shots img") && !document.querySelector("[data-format=png]").disabled', 30000);
      await result.eval('document.querySelector("[data-format=png]").click()');
      await result.until('/^Saved|Could not/.test(document.getElementById("status").textContent)', 15000);
      const status = await result.eval('document.getElementById("status").firstChild.textContent');
      const fresh = await arrived(10000);
      await result.close();
      await page.close();
      return verdict(status, fresh, 'Snaffle/127.0.0.1/Tall fixture (1).png');
    });

    /* ---- named for what the bytes are ---- */

    const typesPage = await b.open(A.origin + '/pages/types.html');
    await typesPage.until('/ready/.test(document.title)');

    await check('N09', 'WebP that its address and its server both call PNG is saved as .webp', async () => {
      await typesPage.hover('#lie');
      await typesPage.press('KeyS', 's', 83, 1);
      const toast = await settled(typesPage);
      return verdict(toast, await arrived(), 'Snaffle/127.0.0.1/photo.webp');
    });

    await check('N10', '...and so is WebP the server will only call "some bytes"', async () => {
      await typesPage.hover('#vague');
      await typesPage.press('KeyS', 's', 83, 1);
      const toast = await settled(typesPage);
      return verdict(toast, await arrived(), 'Snaffle/127.0.0.1/scan.webp');
    });

    await check('N11', '...and WebP the page holds in memory, where it has no name or type to go by', async () => {
      await typesPage.hover('#held');
      await typesPage.press('KeyS', 's', 83, 1);
      const toast = await settled(typesPage);
      const fresh = await arrived();
      const want = said(toast);
      const head = fresh.length === 1 ? fs.readFileSync(path.join(dlDir, fresh[0])).subarray(8, 12).toString('latin1') : '';
      return { ok: fresh.length === 1 && fresh[0] === want && /^Snaffle\/127\.0\.0\.1\/.+\.webp$/.test(want) && head === 'WEBP',
        observed: 'message "' + toast + '"; on disk: ' + (fresh.join(', ') || 'nothing new') + (head ? ' (bytes say ' + head + ')' : '') };
    });
    await typesPage.close();

    /* ---- nothing half-written under a finished name ---- */

    await check('N12', 'While a file is still arriving it is not there under its own name; it appears, complete, only when it is done', async () => {
      const everything = () => { try { return fs.readdirSync(path.join(dlDir, 'Snaffle', '127.0.0.1')); } catch (_) { return []; } };
      const full = fs.statSync(path.join(ROOT, 'test', 'browser', 'media', 'tiny.mp4')).size;
      const page = await b.open(A.origin + '/pages/grab.html');
      await sleep(600);
      // The server sends half the file, waits four seconds, then sends the rest.
      A.slowMedia(4000);
      await page.hover('#video video');
      await page.press('KeyS', 's', 83, 1);
      let during = [], sawPartial = false, sawEarly = false;
      const end = Date.now() + 3000;
      while (Date.now() < end) {
        const now = everything();
        if (now.some((f) => /\.crdownload$/i.test(f))) { sawPartial = true; during = now; }
        if (now.includes('tiny.mp4')) sawEarly = true;
        await sleep(100);
      }
      A.slowMedia(0);
      const fresh = await arrived(15000);
      await sleep(500);
      const after = everything();
      const size = after.includes('tiny.mp4') ? fs.statSync(path.join(dlDir, 'Snaffle', '127.0.0.1', 'tiny.mp4')).size : 0;
      await page.close();
      return { ok: sawPartial && !sawEarly && fresh.join() === 'Snaffle/127.0.0.1/tiny.mp4' && size === full && !after.some((f) => /\.crdownload$/i.test(f)),
        observed: 'while arriving the folder held ' + (during.filter((f) => /crdownload|tiny/.test(f)).join(', ') || 'no sign of it') +
          (sawEarly ? ' AND tiny.mp4 already' : ', and no tiny.mp4') + '; afterwards tiny.mp4 of ' + size + ' bytes (the whole file is ' + full + ')' };
    });

    /* ---- a whole post ---- */

    await check('N13', 'A whole post saved with one key lands as one named file per slide, numbered in order', async () => {
      const page = await b.open('https://www.instagram.com:4711/someone/p/CAROUSEL7/?carousel=1&start=2');
      await page.until('/ready/.test(document.title)', 20000);
      await sleep(400);
      await page.hover('#post');
      await page.press('KeyA', 'a', 65, 1);
      let toast = '';
      const end = Date.now() + 60000;
      while (Date.now() < end) {
        toast = await page.toast();
        if (/^Saved (all )?\d+ /.test(toast) && !/still downloading|stalled at/.test(toast)) break;
        await sleep(300);
      }
      const fresh = await arrived(15000, 5);
      const slide = await page.eval('window.__car.index + 1');
      await page.close();
      const want = ['someone-CAROUSEL7-1.png', 'someone-CAROUSEL7-2-568p.mp4', 'someone-CAROUSEL7-3-568p.mp4', 'someone-CAROUSEL7-4.png', 'someone-CAROUSEL7-5.png']
        .map((f) => 'Snaffle/instagram.com/' + f);
      return { ok: fresh.join() === want.join() && toast === 'Saved all 5 from this post to Snaffle/instagram.com.' && slide === 2,
        observed: 'message "' + toast + '"; on disk: ' + (fresh.map((f) => f.split('/').pop()).join(', ') || 'nothing new') + '; the post is back on slide ' + slide };
    });

    /* ---- a message that arrives while nobody is looking ---- */

    await check('N14', 'A message that arrives while its tab is in the background is still there, with its time ahead of it, when the tab comes back', async () => {
      A.slow(700);
      const page = await b.open(A.origin + '/pages/one-stream.html?src=' + encodeURIComponent(A.origin + '/real/multi/master.m3u8'));
      await page.until('/ready/.test(document.title)');
      await sleep(500);
      await page.hover('#v');
      await page.press('KeyS', 's', 83, 1);
      await sleep(600);
      const other = await b.open(A.origin + '/article.html');
      await sleep(400);
      const state = await page.eval('document.visibilityState');
      const fresh = await arrived(40000);
      A.slow(0);
      // Longer than any message stays up once it is being looked at.
      await sleep(17000);
      const kept = await page.toast();
      await other.close();
      await page.send('Page.bringToFront');
      await sleep(800);
      const back = await page.eval('document.visibilityState');
      const shown = await page.toast();
      // And once it is in front, its time does run out.
      await sleep(17000);
      const later = await page.toast();
      await page.close();
      return { ok: state === 'hidden' && fresh.length === 1 && /^Saved /.test(kept) && /^Saved /.test(shown) && back === 'visible' && later === '',
        observed: 'the tab was ' + state + ' when the video finished; 17s later, still in the background: "' + (kept || '(gone)') + '"; brought to the front: "' + (shown || '(gone)') + '"; 17s after that: ' + (later ? '"' + later + '"' : 'gone, as it should be') };
    });

    await check('N08', 'Nothing was left loose in Downloads under a made-up name', async () => {
      const loose = filesIn(dlDir).filter((f) => !f.startsWith('Snaffle/'));
      return { ok: loose.length === 0, observed: loose.length ? 'outside the Snaffle folder: ' + loose.join(', ') : 'every file is inside the Snaffle folder (' + filesIn(dlDir).length + ' files)' };
    });
  } finally {
    await b.close();
    await A.close(); await B.close();
    try { fs.rmSync(dlDir, { recursive: true, force: true }); } catch (_) {}
  }

  const bad = results.filter((r) => !r.ok);
  console.log('\n' + results.length + ' checks: ' + (results.length - bad.length) + ' ok, ' + bad.length + ' failed' + (bad.length ? '\nFAILED: ' + bad.map((r) => r.id).join(', ') : ''));
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('RUN FAILED', e); process.exit(1); });
