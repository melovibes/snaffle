/* Takes the pictures the Chrome Web Store asks for, into store-assets/:

     npm run store:shots

   Screenshots are 1280x800, the size the store wants, taken from the real
   extension on the made-up demo page. The pointer and the label naming the
   keys are drawn in (see overlay.js); everything else is the extension.
   The small promotional tile (440x280) is drawn from the logo. */

const fs = require('fs');
const path = require('path');
const { launch, sleep, ROOT } = require('./harness');
const { start } = require('./server');
const { overlay } = require('./overlay');

const OUT = path.join(ROOT, 'store-assets');
const W = 1280, H = 800;
// A name for the demo page, so saved files are not filed under an IP address.
const SITE = 'http://coastline.example:4701';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const A = await start(4701, 4702);
  const B = await start(4702, 4701);
  const h = await launch({ width: W, height: H, args: ['--host-resolver-rules=MAP coastline.example 127.0.0.1'] });
  await h.context.addInitScript(overlay);
  const ext = 'chrome-extension://' + h.extId;
  const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) });
  const label = (page, text) => page.evaluate((t) => window.__demo && window.__demo.keys(t, 0), text);
  const pointAt = async (page, selector, dx, dy) => {
    const box = await page.locator(selector).first().boundingBox();
    if (!box) throw new Error('no box for ' + selector);
    const x = box.x + box.width / 2 + (dx || 0), y = box.y + box.height / 2 + (dy || 0);
    await page.mouse.move(x - 8, y - 8);
    await page.mouse.move(x, y);
    await sleep(80);
    return { x, y };
  };

  const page = await h.context.newPage();
  await page.goto(SITE + '/pages/demo.html', { waitUntil: 'load' });
  await page.bringToFront();
  await sleep(700);

  /* 1. Saving the picture under the pointer */
  await pointAt(page, '#p1', 40, 30);
  await label(page, 'Alt + S');
  await page.keyboard.press('Alt+KeyS');
  const said = await h.settledToast(page, 8000);
  await sleep(300);
  await shot(page, 'screenshot-1-save.png');

  /* 2. The list of everything on the page */
  await page.keyboard.press('Alt+Shift+KeyI');
  await page.locator('#__snaffle_gallery .card').first().waitFor({ timeout: 8000 });
  await sleep(1500);
  for (const n of [1, 2, 5]) {
    const box = await page.locator('#__snaffle_gallery .card').nth(n).boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(150);
  }
  await pointAt(page, '#__snaffle_gallery [data-act="dl"]', 6, 10);
  // No key label here: it would sit on the list's own status line. And wait
  // for the earlier "Saved" message to go, so the picture is of the list.
  await page.evaluate(() => window.__demo.keys('', 1));
  for (let i = 0; i < 40 && await h.toast(page); i++) await sleep(250);
  await sleep(400);
  await shot(page, 'screenshot-2-media-list.png');
  await page.keyboard.press('Escape');
  await sleep(500);

  /* 3. The whole page as one picture, on the page it opens in */
  await page.evaluate(() => window.__demo.hide(true));
  await sleep(200);
  const opened = h.context.waitForEvent('page', { timeout: 60000 });
  await page.keyboard.press('Alt+Shift+KeyS');
  const result = await opened;
  await result.waitForFunction(() => {
    const img = document.querySelector('#shots img');
    return img && img.complete && img.naturalWidth > 0;
  }, null, { timeout: 60000 });
  await result.setViewportSize({ width: W, height: H });
  await result.evaluate(overlay);
  await pointAt(result, '[data-format="png"]', 10, 12);
  await sleep(500);
  await shot(result, 'screenshot-3-full-page.png');
  const facts = await result.evaluate(() => document.getElementById('facts').textContent);
  await result.close();
  await page.close();

  /* 4. The settings */
  const opt = await h.context.newPage();
  await opt.setViewportSize({ width: W, height: H });
  await opt.goto(ext + '/options.html');
  await sleep(600);
  await shot(opt, 'screenshot-4-settings.png');
  await opt.close();

  /* The small promotional tile */
  const logo = fs.readFileSync(path.join(ROOT, 'icons', 'icon128.png')).toString('base64');
  const tile = await h.context.newPage();
  await tile.setViewportSize({ width: 440, height: 280 });
  await tile.setContent(
    '<!doctype html><html><head><style>' +
    'html,body{margin:0;height:100%}' +
    'body{display:flex;align-items:center;gap:22px;padding:0 34px;box-sizing:border-box;' +
    'background:linear-gradient(135deg,#0f1b3d 0%,#1d4ed8 100%);color:#fff;font-family:system-ui,"Segoe UI",sans-serif}' +
    'img{width:104px;height:104px;border-radius:24px;box-shadow:0 10px 28px rgba(0,0,0,.35)}' +
    'b{display:block;font-size:40px;letter-spacing:-.5px;line-height:1.05}' +
    'span{display:block;margin-top:10px;font-size:17px;line-height:1.3;opacity:.92}' +
    '</style></head><body><img alt="" src="data:image/png;base64,' + logo + '">' +
    '<div><b>Snaffle</b><span>Save any image or video<br>with a key or a click</span></div></body></html>');
  await sleep(300);
  await tile.screenshot({ path: path.join(OUT, 'promo-small-440x280.png') });
  await tile.close();

  await h.close();
  await A.close(); await B.close();
  console.log('saved message: "' + said + '"');
  console.log('results page: "' + facts + '"');
  console.log('wrote ' + fs.readdirSync(OUT).join(', '));
})().catch((e) => { console.error(e); process.exit(1); });
