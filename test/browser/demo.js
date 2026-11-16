/* Records docs/img/demo.gif:   npm run demo   (needs ffmpeg on the PATH)

   The real extension is driven on a made-up page served by the fixture
   server, and Chromium's own screen recording is turned into the GIF. Two
   things in the picture are drawn by this script and are not part of
   Snaffle: the pointer (a headless browser has none to record) and the label
   naming the keys being pressed. Everything else is the extension. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { launch, sleep } = require('./harness');
const { start } = require('./server');
const { overlay } = require('./overlay');

const OUT = path.join(__dirname, '..', '..', 'docs', 'img', 'demo.gif');
const W = 960, H = 600;

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'snaffle-demo-'));
  const A = await start(4701, 4702);
  const B = await start(4702, 4701);
  const h = await launch({ width: W, height: H, video: work });
  await h.context.addInitScript(overlay);

  let at = { x: W / 2, y: H / 2 };
  const glide = async (page, x, y, ms) => {
    const steps = Math.max(2, Math.round((ms || 600) / 16));
    const from = at;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
      await sleep(14);
    }
    at = { x, y };
  };
  const centre = async (page, selector) => {
    const box = await page.locator(selector).first().boundingBox();
    if (!box) throw new Error('no box for ' + selector);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const over = async (page, selector, ms) => { const c = await centre(page, selector); await glide(page, c.x, c.y, ms); };
  const label = (page, text, ms) => page.evaluate(([t, m]) => window.__demo && window.__demo.keys(t, m), [text, ms || 1400]);
  const press = async (page, text, combo) => { await label(page, text); await sleep(450); await page.keyboard.press(combo); };

  /* ---- the page ---- */
  const page = await h.context.newPage();
  const bornA = Date.now();
  await page.goto(A.origin + '/pages/demo.html', { waitUntil: 'load' });
  await page.bringToFront();
  await page.mouse.move(at.x, at.y);
  await sleep(900);
  const startA = Date.now() - bornA - 500;

  // Save the picture under the pointer. This one links to a larger original.
  await over(page, '#p0', 700);
  await sleep(250);
  await press(page, 'Alt + S', 'Alt+KeyS');
  await sleep(2300);

  await over(page, '#p2', 650);
  await sleep(200);
  await press(page, 'Alt + S', 'Alt+KeyS');
  await sleep(2100);

  // Everything on the page, in one list.
  await press(page, 'Alt + Shift + I', 'Alt+Shift+KeyI');
  await page.locator('#__snaffle_gallery .card').first().waitFor({ timeout: 8000 });
  await sleep(1500);
  for (const n of [1, 2, 5]) {
    const box = await page.locator('#__snaffle_gallery .card').nth(n).boundingBox();
    await glide(page, box.x + box.width / 2, box.y + box.height / 2, 420);
    await page.mouse.down(); await page.mouse.up();
    await sleep(320);
  }
  await over(page, '#__snaffle_gallery [data-act="dl"]', 520);
  await sleep(250);
  await page.mouse.down(); await page.mouse.up();
  await sleep(2600);
  await over(page, '#__snaffle_gallery [data-act="close"]', 420);
  await page.mouse.down(); await page.mouse.up();
  await sleep(700);

  // The whole page as one picture. The drawn-in pointer and label are taken
  // away first, so they are not in the screenshot.
  await label(page, 'Alt + Shift + S', 900);
  await sleep(900);
  await page.evaluate(() => window.__demo.hide(true));
  await sleep(250);
  const opened = h.context.waitForEvent('page', { timeout: 60000 });
  await page.keyboard.press('Alt+Shift+KeyS');
  const result = await opened;
  const bornB = Date.now();
  await result.waitForFunction(() => {
    const img = document.querySelector('#shots img');
    return img && img.complete && img.naturalWidth > 0;
  }, null, { timeout: 60000 });
  const endA = Date.now() - bornA;
  const startB = Date.now() - bornB + 150;

  /* ---- the page the screenshot opens on ---- */
  await result.setViewportSize({ width: W, height: H });
  await result.evaluate(overlay);
  at = { x: W / 2, y: H / 2 };
  await result.mouse.move(at.x - 4, at.y);
  await result.mouse.move(at.x, at.y);
  await sleep(1400);
  await over(result, '[data-format="png"]', 650);
  await sleep(300);
  await result.mouse.down(); await result.mouse.up();
  await sleep(1900);
  await glide(result, W / 2, H * 0.62, 500);
  for (let i = 0; i < 16; i++) { await result.mouse.wheel(0, 60); await sleep(70); }
  await sleep(1500);
  const endB = Date.now() - bornB;

  const videoA = await page.video().path();
  const videoB = await result.video().path();
  const said = await result.evaluate(() => document.getElementById('status').textContent);
  await h.context.close();
  await A.close(); await B.close();

  /* ---- two recordings into one GIF ---- */
  const sec = (ms) => (Math.max(0, ms) / 1000).toFixed(2);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-ss', sec(startA), '-to', sec(endA), '-i', videoA,
    '-ss', sec(startB), '-to', sec(endB), '-i', videoB,
    '-filter_complex',
    '[0:v]fps=10,scale=800:-1:flags=lanczos[a];[1:v]fps=10,scale=800:-1:flags=lanczos[b];' +
    '[a][b]concat=n=2:v=1:a=0,split[s0][s1];' +
    '[s0]palettegen=max_colors=160:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
    OUT
  ]);
  try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(h.work, { recursive: true, force: true }); } catch (_) {}

  console.log('wrote ' + path.relative(process.cwd(), OUT) + ', ' + (fs.statSync(OUT).size / 1048576).toFixed(1) + ' MB, ' +
              sec(endA - startA + endB - startB) + 's; the results page said: "' + said + '"');
})().catch((e) => { console.error(e); process.exit(1); });
