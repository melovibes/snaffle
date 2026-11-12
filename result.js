/* Snaffle - the page a screenshot opens in, so it can be looked at before it
   is saved and the format chosen then rather than in advance. The capture
   script in the page sends the images here in chunks. */

const S = SnaffleShared;
const Pdf = SnafflePdf;
const $ = (id) => document.getElementById(id);

const id = new URLSearchParams(location.search).get('id') || '';
const incoming = [];    // per image: the chunks received so far
let parts = [];         // { blob, url, width, height }
let info = {};
let cfg = S.effective(null);
let lastSaved = null;   // download id of the most recent save

const formatButtons = () => Array.from(document.querySelectorAll('[data-format]'));

function setStatus(text, level, downloadId) {
  const el = $('status');
  el.className = 'status' + (level ? ' ' + level : '');
  el.textContent = text;
  if (downloadId != null) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'link';
    b.textContent = 'Show in folder';
    b.addEventListener('click', () => chrome.downloads.show(downloadId));
    el.appendChild(b);
  }
}

/* ----------------------------------------------------------- receiving */

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (!msg || msg.id !== id) return false;
  if (msg.type === 'resultPart') {
    const bin = atob(msg.b64 || '');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    (incoming[msg.part] = incoming[msg.part] || []).push(bytes);
    respond({ ok: true });
    return false;
  }
  if (msg.type === 'resultDone') {
    show(msg);
    respond({ ok: true });
    return false;
  }
  return false;
});

async function show(msg) {
  info = msg.info || {};
  parts = (msg.parts || []).map((p, i) => {
    const blob = new Blob(incoming[i] || [], { type: 'image/png' });
    return { blob, url: URL.createObjectURL(blob), width: p.width, height: p.height };
  });
  incoming.length = 0;

  const bytes = parts.reduce((n, p) => n + p.blob.size, 0);
  const tall = parts.reduce((n, p) => n + p.height, 0);
  document.title = 'Screenshot of ' + (info.title || info.host || 'a page') + ' - Snaffle';
  $('title').textContent = 'Screenshot of ' + (info.title || info.host || 'a page');
  $('facts').textContent = parts[0].width + ' x ' + tall + ' pixels, ' + S.sizeText(bytes) + ' as PNG' +
    (parts.length > 1 ? ', in ' + parts.length + ' pieces' : '') + '. Nothing has been saved yet.';
  $('name').value = info.name || 'screenshot';

  const main = $('shots');
  main.textContent = '';
  parts.forEach((p, i) => {
    if (parts.length > 1) {
      const label = document.createElement('p');
      label.className = 'piece';
      label.textContent = 'Piece ' + (i + 1) + ' of ' + parts.length;
      main.appendChild(label);
    }
    const img = document.createElement('img');
    img.src = p.url;
    img.width = p.width;
    img.height = p.height;
    img.alt = 'Screenshot of ' + (info.title || info.host || 'the page') + (parts.length > 1 ? ', piece ' + (i + 1) + ' of ' + parts.length : '');
    main.appendChild(img);
  });

  // The format chosen in the settings is offered first.
  const preferred = (cfg.captureFormat || 'png').toLowerCase();
  for (const b of formatButtons()) {
    b.disabled = false;
    b.classList.toggle('primary', b.dataset.format === preferred);
  }
  // The clipboard holds one image.
  $('copy').disabled = parts.length !== 1;
  if (parts.length !== 1) $('copy').title = 'A screenshot in several pieces cannot be copied as one image';

  if (info.notes) setStatus(info.notes.trim(), 'warn');

  // Come to the front now that there is something to look at.
  chrome.tabs.getCurrent((tab) => { if (tab) chrome.tabs.update(tab.id, { active: true }); });
}

/* -------------------------------------------------------------- saving */

function toCanvasBlob(canvas, type, quality) {
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('the image could not be encoded'))), type, quality));
}

async function asJpeg(part, quality) {
  const bmp = await createImageBitmap(part.blob);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';            // JPEG has no transparency
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const blob = await toCanvasBlob(canvas, 'image/jpeg', quality);
  canvas.width = 0;
  return blob;
}

async function filesFor(format) {
  if (format === 'png') return parts.map((p) => p.blob);
  const quality = Math.min(100, Math.max(10, cfg.captureQuality || 92)) / 100;
  const jpegs = [];
  for (const p of parts) jpegs.push(await asJpeg(p, quality));
  if (format === 'jpeg') return jpegs;
  const pages = [];
  for (let i = 0; i < parts.length; i++) {
    pages.push({ jpeg: new Uint8Array(await jpegs[i].arrayBuffer()), width: parts[i].width, height: parts[i].height });
  }
  return [new Blob(Pdf.build(pages), { type: 'application/pdf' })];
}

async function nextIndex() {
  const s = await chrome.storage.local.get('counter');
  const n = (s.counter || 0) + 1;
  await chrome.storage.local.set({ counter: n });
  return n;
}

function download(blob, filename) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: !!cfg.saveAs }, (downloadId) => {
      if (chrome.runtime.lastError || downloadId == null) {
        URL.revokeObjectURL(url);
        resolve({ ok: false, error: (chrome.runtime.lastError || {}).message || 'the browser would not save it' });
        return;
      }
      // Wait for it to land, so "Saved" is true when it is said.
      const tick = () => chrome.downloads.search({ id: downloadId }, (items) => {
        const item = items && items[0];
        if (!item) { resolve({ ok: false, error: 'the download disappeared' }); return; }
        if (item.state === 'complete') { URL.revokeObjectURL(url); resolve({ ok: true, id: downloadId }); return; }
        if (item.state === 'interrupted') {
          URL.revokeObjectURL(url);
          resolve({ ok: false, cancelled: item.error === 'USER_CANCELED', error: 'the browser would not save it' });
          return;
        }
        setTimeout(tick, 120);
      });
      tick();
    });
  });
}

async function save(format) {
  const buttons = formatButtons();
  buttons.forEach((b) => { b.disabled = true; });
  setStatus('Saving...', 'busy');
  try {
    const files = await filesFor(format);
    const ext = format === 'pdf' ? 'pdf' : format === 'jpeg' ? 'jpg' : 'png';
    const stem = $('name').value.trim() || info.name || 'screenshot';
    const index = await nextIndex();
    let firstPath = '';
    for (let i = 0; i < files.length; i++) {
      const tok = {
        name: stem + (files.length > 1 ? ' (' + (i + 1) + ' of ' + files.length + ')' : ''),
        ext, kind: 'screenshot', host: info.host || '', title: info.title || '', alt: ''
      };
      const path = S.buildPath(tok, cfg, index);
      const res = await download(files[i], path);
      if (!res.ok) {
        if (res.cancelled) setStatus('Not saved.', 'warn');
        else setStatus('Could not save it: ' + res.error + '.', 'bad');
        return;
      }
      lastSaved = res.id;
      if (!firstPath) firstPath = path;
    }
    setStatus(files.length > 1 ? 'Saved ' + files.length + ' files, starting with ' + firstPath + '.' : 'Saved ' + firstPath + '.', '', lastSaved);
  } catch (e) {
    setStatus('Could not save it: ' + ((e && e.message) || e) + '.', 'bad');
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

async function copy() {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': parts[0].blob })]);
    setStatus('Copied. Paste it wherever you like.', '');
  } catch (e) {
    setStatus('Could not copy it. Click this page first, then try again.', 'bad');
  }
}

/* --------------------------------------------------------------- start */

document.addEventListener('DOMContentLoaded', async () => {
  const s = await chrome.storage.sync.get('cfg');
  cfg = S.effective(s.cfg);

  for (const b of formatButtons()) b.addEventListener('click', () => save(b.dataset.format));
  $('copy').addEventListener('click', copy);

  // Tell the service worker this page is listening, which is the signal for
  // the capture script to start sending.
  chrome.runtime.sendMessage({ type: 'resultReady', id }, () => void chrome.runtime.lastError);

  // If nothing has arrived by now, it is not going to.
  setTimeout(() => {
    if (!parts.length) {
      $('facts').textContent = 'No screenshot arrived.';
      setStatus('The screenshot never reached this page. Go back to the tab and try again.', 'bad');
    }
  }, 60000);
});
