/* Snaffle - options page */

const S = SnaffleShared;
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const $ = (id) => document.getElementById(id);
const keyLabel = (t) => S.keyLabel(t, IS_MAC);
const mouseLabel = (t) => S.mouseLabel(t, IS_MAC);

const FLAGS = ['enabled', 'upgrade', 'preferLink', 'streamAssembly', 'posterFallback', 'saveAs', 'toast', 'outline', 'contextMenu',
               'captureHideFixed', 'captureFullWidth'];

let cfg = S.effective(null);

/* --------------------------------------------------------------- preview */

function renderPreview() {
  const tok = { name: 'sunset-over-the-bay', ext: 'jpg', host: 'example.com', title: 'Example page', alt: 'A sunset', kind: 'image' };
  // The same function the downloader uses, so the preview cannot drift from it.
  const path = S.buildPath(tok, { template: $('template').value, folder: $('folder').value }, 42);
  $('preview').textContent = 'Downloads/' + path;
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
  }
  cfg.mouse.enabled = $('mouseEnabled').checked;
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
  // Only what differs from the defaults is stored.
  await chrome.storage.sync.set({ cfg: S.toStore(collect()) });
  render();
  flashStatus('Saved');
}

document.addEventListener('DOMContentLoaded', async () => {
  const s = await chrome.storage.sync.get('cfg');
  cfg = S.effective(s.cfg);
  render();
  bindKeyRecorder('key', 'keyRec', 'keyHint');
  bindKeyRecorder('captureKey', 'captureRec', 'captureHint');
  bindKeyRecorder('galleryKey', 'galleryRec', 'galleryHint');
  bindMouseRecorder();

  $('folder').addEventListener('input', renderPreview);
  $('template').addEventListener('input', renderPreview);
  $('save').addEventListener('click', save);
  $('reset').addEventListener('click', async () => {
    cfg = S.effective(null);
    await chrome.storage.sync.remove('cfg');
    render();
    flashStatus('Reset');
  });
});
