/* Snaffle - options page */

const DEFAULTS = {
  enabled: true,
  key: { enabled: true, code: 'KeyS', label: 'Alt + S', ctrl: false, alt: true, shift: false, meta: false },
  mouse: { enabled: true, button: 1, label: 'Alt + Middle click', ctrl: false, alt: true, shift: false, meta: false },
  captureKey: { enabled: true, code: 'KeyS', label: 'Alt + Shift + S', ctrl: false, alt: true, shift: true, meta: false },
  galleryKey: { enabled: true, code: 'KeyI', label: 'Alt + Shift + I', ctrl: false, alt: true, shift: true, meta: false },
  folder: 'Snaffle/{host}',
  template: '{name}.{ext}',
  captureFormat: 'png',
  captureQuality: 92,
  captureHideFixed: true,
  captureFullWidth: true,
  galleryMinSize: 80,
  upgrade: true,
  preferLink: true,
  streamAssembly: true,
  posterFallback: true,
  saveAs: false,
  toast: true,
  outline: false,
  contextMenu: true
};

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const BUTTONS = ['Left click', 'Middle click', 'Right click', 'Back button', 'Forward button'];
const $ = (id) => document.getElementById(id);

const FLAGS = ['enabled', 'upgrade', 'preferLink', 'streamAssembly', 'posterFallback', 'saveAs', 'toast', 'outline', 'contextMenu',
               'captureHideFixed', 'captureFullWidth'];

let cfg = JSON.parse(JSON.stringify(DEFAULTS));

function merge(base, over) {
  const out = Object.assign({}, base);
  for (const k of Object.keys(over || {})) {
    const v = over[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object') out[k] = merge(base[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

function modString(t) {
  const parts = [];
  if (t.ctrl) parts.push('Ctrl');
  if (t.alt) parts.push(IS_MAC ? 'Option' : 'Alt');
  if (t.shift) parts.push('Shift');
  if (t.meta) parts.push(IS_MAC ? 'Cmd' : 'Win');
  return parts;
}

function keyLabel(t) {
  const parts = modString(t);
  let name = t.code || '';
  if (/^Key[A-Z]$/.test(name)) name = name.slice(3);
  else if (/^Digit\d$/.test(name)) name = name.slice(5);
  else if (/^Numpad(.+)$/.test(name)) name = 'Numpad ' + name.slice(6);
  else if (/^Arrow(.+)$/.test(name)) name = name.slice(5) + ' arrow';
  parts.push(name || '?');
  return parts.join(' + ');
}

function mouseLabel(t) {
  const parts = modString(t);
  parts.push(BUTTONS[t.button] || 'Button ' + t.button);
  return parts.join(' + ');
}

/* --------------------------------------------------------------- preview */

const pad = (n) => String(n).padStart(2, '0');

function sanitizeSegment(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 100);
}

function applyTemplate(tpl, tok) {
  const d = new Date();
  const map = {
    name: tok.name, ext: tok.ext, host: tok.host, title: tok.title, alt: tok.alt, kind: tok.kind,
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
    datetime: `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
    ts: String(Date.now()),
    index: '0042'
  };
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (k in map ? (map[k] == null ? '' : map[k]) : m));
}

function renderPreview() {
  const tok = { name: 'sunset-over-the-bay', ext: 'jpg', host: 'example.com', title: 'Example page', alt: 'A sunset', kind: 'image' };
  let name = applyTemplate($('template').value, tok).split('/').map(sanitizeSegment).filter(Boolean).join('/');
  if (!name) name = 'media.jpg';
  if (!/\.[a-z0-9]{1,5}$/i.test(name)) name += '.' + tok.ext;
  const folder = applyTemplate($('folder').value, tok).split('/').map(sanitizeSegment).filter(Boolean).join('/');
  $('preview').textContent = 'Downloads/' + (folder ? folder + '/' : '') + name;
}

/* ------------------------------------------------------------ recorders */

function bindKeyRecorder(field, btnId, hintId) {
  const btn = $(btnId);
  const idle = 'Click the box, then press the combination you want.';
  let listening = false;

  const stop = () => {
    listening = false;
    btn.classList.remove('listening');
    btn.textContent = keyLabel(cfg[field]);
    $(hintId).textContent = idle;
  };

  btn.addEventListener('click', () => {
    listening = true;
    btn.classList.add('listening');
    btn.textContent = 'Press a key...';
    $(hintId).textContent = 'Press Escape to cancel.';
    btn.focus();
  });

  btn.addEventListener('blur', () => { if (listening) stop(); });

  btn.addEventListener('keydown', (e) => {
    if (!listening) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { stop(); return; }
    if (/^(Control|Alt|Shift|Meta)$/.test(e.key)) return;
    cfg[field] = {
      enabled: cfg[field].enabled,
      code: e.code,
      ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey
    };
    cfg[field].label = keyLabel(cfg[field]);
    stop();
    warnCollisions();
  });
}

// Three bindings share one keydown stream, so an exact duplicate would make the
// lower-priority one dead. Say so at assignment time rather than never.
function warnCollisions() {
  const sig = (k) => [k.code, k.ctrl, k.alt, k.shift, k.meta].join('|');
  const fields = [['key', 'keyHint'], ['captureKey', 'captureHint'], ['galleryKey', 'galleryHint']];
  const counts = {};
  for (const [f] of fields) counts[sig(cfg[f])] = (counts[sig(cfg[f])] || 0) + 1;
  for (const [f, hint] of fields) {
    if (counts[sig(cfg[f])] > 1) {
      $(hint).textContent = 'This is the same combination as another action - only one of them will fire.';
    }
  }
}

function bindMouseRecorder() {
  const btn = $('mouseRec');
  let listening = false;

  const stop = () => {
    listening = false;
    btn.classList.remove('listening');
    btn.textContent = mouseLabel(cfg.mouse);
    $('mouseHint').textContent = 'Click the box using the button and modifiers you want.';
  };

  btn.addEventListener('mousedown', (e) => {
    if (!listening) {
      listening = true;
      btn.classList.add('listening');
      btn.textContent = 'Click here with your combination...';
      $('mouseHint').textContent = 'Any mouse button plus optional Ctrl / Alt / Shift.';
      e.preventDefault();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    cfg.mouse = {
      enabled: cfg.mouse.enabled,
      button: e.button,
      ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey
    };
    cfg.mouse.label = mouseLabel(cfg.mouse);
    stop();
    if (e.button === 0 && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      $('mouseHint').textContent = 'Careful: plain left click will trigger on every click you make.';
    }
  });

  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  btn.addEventListener('auxclick', (e) => e.preventDefault());
}

/* --------------------------------------------------------------- wiring */

const KEY_FIELDS = [
  ['key', 'keyEnabled', 'keyRec'],
  ['captureKey', 'captureEnabled', 'captureRec'],
  ['galleryKey', 'galleryEnabled', 'galleryRec']
];

function render() {
  for (const f of FLAGS) $(f).checked = !!cfg[f];
  for (const [field, enabledId, recId] of KEY_FIELDS) {
    $(enabledId).checked = !!cfg[field].enabled;
    $(recId).textContent = keyLabel(cfg[field]);
  }
  $('mouseEnabled').checked = !!cfg.mouse.enabled;
  $('mouseRec').textContent = mouseLabel(cfg.mouse);
  $('folder').value = cfg.folder || '';
  $('template').value = cfg.template || '';
  $('captureFormat').value = cfg.captureFormat || 'png';
  $('captureQuality').value = cfg.captureQuality || 92;
  $('galleryMinSize').value = cfg.galleryMinSize || 0;
  renderPreview();
  warnCollisions();
}

function collect() {
  for (const f of FLAGS) cfg[f] = $(f).checked;
  for (const [field, enabledId] of KEY_FIELDS) {
    cfg[field].enabled = $(enabledId).checked;
    cfg[field].label = keyLabel(cfg[field]);
  }
  cfg.mouse.enabled = $('mouseEnabled').checked;
  cfg.mouse.label = mouseLabel(cfg.mouse);
  cfg.folder = $('folder').value.trim();
  cfg.template = $('template').value.trim() || '{name}.{ext}';
  cfg.captureFormat = $('captureFormat').value;
  cfg.captureQuality = Math.min(100, Math.max(10, parseInt($('captureQuality').value, 10) || 92));
  cfg.galleryMinSize = Math.max(0, parseInt($('galleryMinSize').value, 10) || 0);
  return cfg;
}

function flashStatus(text) {
  const el = $('status');
  el.textContent = text;
  el.classList.add('on');
  setTimeout(() => el.classList.remove('on'), 1600);
}

async function save() {
  await chrome.storage.sync.set({ cfg: collect() });
  render();
  flashStatus('Saved');
}

document.addEventListener('DOMContentLoaded', async () => {
  const s = await chrome.storage.sync.get('cfg');
  cfg = merge(DEFAULTS, s.cfg || {});
  render();
  bindKeyRecorder('key', 'keyRec', 'keyHint');
  bindKeyRecorder('captureKey', 'captureRec', 'captureHint');
  bindKeyRecorder('galleryKey', 'galleryRec', 'galleryHint');
  bindMouseRecorder();

  $('folder').addEventListener('input', renderPreview);
  $('template').addEventListener('input', renderPreview);
  $('save').addEventListener('click', save);
  $('reset').addEventListener('click', async () => {
    cfg = JSON.parse(JSON.stringify(DEFAULTS));
    await chrome.storage.sync.set({ cfg });
    render();
    flashStatus('Reset');
  });
});
