/* Takes the screenshots in docs/img from the real extension, against the
   local fixture pages:   node test/browser/shots.js
   Nothing here is mocked up; if the UI changes, run it again. */

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('./harness');
const { start } = require('./server');

const OUT = path.join(__dirname, '..', '..', 'docs', 'img');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const A = await start(4701, 4702);
  const B = await start(4702, 4701);
  const h = await launch({ width: 1100, height: 760 });
  const ext = 'chrome-extension://' + h.extId;
  const shot = (page, name, opts) => page.screenshot(Object.assign({ path: path.join(OUT, name) }, opts || {}));
  const tabIdOf = (re) => h.probe.evaluate(async (src) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => new RegExp(src).test(x.url || ''));
    return t ? t.id : null;
  }, re);

  // Something saved, so the popup's recent list and a toast have content.
  const grabPage = await h.newPage(A.origin + '/pages/grab.html');
  await sleep(600);
  await h.hover(grabPage, '#plain img');
  await grabPage.keyboard.press('Alt+KeyS');
  await sleep(900);
  await h.hover(grabPage, '#srcset img');
  await grabPage.keyboard.press('Alt+KeyS');
  await sleep(900);

  /* options, top of the page and the triggers with a warning showing */
  const opt = await h.context.newPage();
  await opt.setViewportSize({ width: 820, height: 900 });
  await opt.goto(ext + '/options.html');
  await sleep(400);
  await opt.click('#keyRec');
  await opt.keyboard.press('Alt+KeyD');
  await sleep(300);
  await shot(opt, 'options.png');
  await opt.click('#reset'); await opt.click('#reset');
  await sleep(300);
  await opt.close();

  /* popup, pointed at the fixture tab */
  const pop = await h.context.newPage();
  await pop.setViewportSize({ width: 320, height: 420 });
  await pop.goto(ext + '/popup.html?tab=' + await tabIdOf('grab\\.html'));
  await sleep(900);
  const height = await pop.evaluate(() => document.documentElement.scrollHeight);
  await pop.setViewportSize({ width: 320, height });
  // Under automation Chrome names downloads with ids, so the "recently
  // saved" list here is not what a user sees. Kept out of docs/ for that reason.
  await pop.screenshot({ path: path.join(require('os').tmpdir(), 'snaffle-popup.png') });
  await pop.close();

  /* toasts: a download in progress beside a saved file */
  A.slow(1500);
  const stream = await h.newPage(A.origin + '/pages/one-stream.html?src=' + encodeURIComponent(A.origin + '/real/multi/master.m3u8'));
  await stream.waitForFunction(() => /ready/.test(document.title), null, { timeout: 8000 });
  await sleep(500);
  await h.hover(stream, '#v');
  await stream.keyboard.press('Alt+KeyS');
  await sleep(2300);
  await h.hover(stream, '#pic');
  await stream.keyboard.press('Alt+KeyS');
  await sleep(1100);
  await shot(stream, 'toasts.png', { clip: { x: 620, y: 560, width: 480, height: 200 } });
  await stream.keyboard.press('Escape');
  A.slow(0);
  await sleep(600);
  await stream.close();

  /* media list, with a few cards selected */
  const list = await h.newPage(A.origin + '/pages/gallery.html');
  await list.waitForFunction(() => /ready/.test(document.title), null, { timeout: 8000 });
  await sleep(800);
  await list.mouse.move(700, 600);
  await list.keyboard.press('Alt+Shift+KeyI');
  await sleep(2500);
  await list.keyboard.press('Space');
  await list.keyboard.press('ArrowRight');
  await list.keyboard.press('ArrowRight');
  await list.keyboard.press('Space');
  await sleep(300);
  await shot(list, 'media-list.png');
  await list.close();

  /* a screenshot, on the page it opens in */
  const subject = await h.newPage(A.origin + '/pages/grab.html');
  await sleep(700);
  await subject.mouse.move(900, 300);
  const opened = h.context.waitForEvent('page', { timeout: 30000 });
  await subject.keyboard.press('Alt+Shift+KeyS');
  const result = await opened;
  await result.waitForFunction(() => document.querySelector('#shots img') && document.querySelector('#shots img').complete, null, { timeout: 30000 });
  await result.setViewportSize({ width: 1100, height: 760 });
  await sleep(500);
  await shot(result, 'result.png');
  await result.close();
  await subject.close();

  await h.close();
  await A.close(); await B.close();
  console.log('wrote', fs.readdirSync(OUT).join(', '));
})().catch((e) => { console.error(e); process.exit(1); });
