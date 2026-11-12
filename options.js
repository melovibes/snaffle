/* Snaffle - options page. Every change is saved as it is made; there is no
   Save button to forget. */

const S = SnaffleShared;
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const $ = (id) => document.getElementById(id);
const keyLabel = (t) => S.keyLabel(t, IS_MAC);
const mouseLabel = (t) => S.mouseLabel(t, IS_MAC);

const FLAGS = ['enabled', 'upgrade', 'preferLink', 'streamAssembly', 'posterFallback', 'saveAs', 'toast', 'outline', 'contextMenu',
               'captureHideFixed', 'captureFullWidth'];

// Each trigger: the setting it edits, its on/off box, its recorder, its hint.
const TRIGGERS = [
  { field: 'key', kind: 'key', enabled: 'keyEnabled', rec: 'keyRec', hint: 'keyHint' },
  { field: 'mouse', kind: 'mouse', enabled: 'mouseEnabled', rec: 'mouseRec', hint: 'mouseHint' },
  { field: 'captureKey', kind: 'key', enabled: 'captureEnabled', rec: 'captureRec', hint: 'captureHint' },
  { field: 'galleryKey', kind: 'key', enabled: 'galleryEnabled', rec: 'galleryRec', hint: 'galleryHint' }
];

let cfg = S.effective(null);

/* ---------------------------------------------------------------- saving */

let saveTimer = 0;

function setStatus(text, busy) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('busy', !!busy);
}

// `now` for a choice that is complete the moment it is made (a tick box, a
// recorded shortcut). Typing waits for a pause instead of saving every letter.
function persist(now) {
  setStatus('Saving...', true);
  clearTimeout(saveTimer);
  const write = async () => {
    // Only what differs from the defaults is stored.
    await chrome.storage.sync.set({ cfg: S.toStore(collect()) });
    setStatus('All changes saved', false);
  };
  if (now) return write();
  saveTimer = setTimeout(write, 400);
  return Promise.resolve();
}

/* --------------------------------------------------------------- preview */

function renderPreview() {
  const tok = { name: 'sunset-over-the-bay', ext: 'jpg', host: 'example.com', title: 'Example page', alt: 'A sunset', kind: 'image' };
  // The same function the downloader uses, so the preview cannot drift from it.
  const path = S.buildPath(tok, { template: $('template').value, folder: $('folder').value }, 42);
  $('preview').textContent = 'Downloads/' + path;
}

/* ----------------------------------------------------------------- hints */

const bindingSig = (t) => [t.code != null ? t.code : 'b' + t.button, !!t.ctrl, !!t.alt, !!t.shift, !!t.meta].join('|');

// What the line under a recorder says. A clash with another trigger matters
// most, then what Chrome does with the combination, then nothing at all.
function renderHints() {
  const keySigs = TRIGGERS.filter((t) => t.kind === 'key').map((t) => bindingSig(cfg[t.field]));
  for (const t of TRIGGERS) {
    const el = $(t.hint);
    const b = cfg[t.field];
    let text = '', level = '';
    if (t.kind === 'key' && keySigs.filter((s) => s === bindingSig(b)).length > 1) {
      text = 'Another trigger uses the same keys. Only one of them will fire.';
      level = 'bad';
    } else {
      const w = t.kind === 'key' ? S.keyWarning(b) : S.mouseWarning(b);
      text = w.text;
      level = w.text ? (w.blocked ? 'bad' : 'warn') : '';
    }
    el.textContent = text;
    el.className = 'hint' + (level ? ' ' + level : '');
  }
}

/* ------------------------------------------------------------- recorders */

function bindRecorder(t) {
  const btn = $(t.rec);
  const label = () => (t.kind === 'key' ? keyLabel(cfg[t.field]) : mouseLabel(cfg[t.field]));
  let listening = false;
  // "Pressed" means it is waiting for the keys or the click.
  btn.setAttribute('aria-pressed', 'false');

  const stop = () => {
    listening = false;
    btn.classList.remove('listening');
    btn.setAttribute('aria-pressed', 'false');
    btn.textContent = label();
    renderHints();
  };

  const start = () => {
    listening = true;
    btn.classList.add('listening');
    btn.setAttribute('aria-pressed', 'true');
    btn.textContent = t.kind === 'key' ? 'Press the keys...' : 'Click here with the button...';
    const hint = $(t.hint);
    hint.className = 'hint';
    hint.textContent = t.kind === 'key'
      ? 'Hold any of Ctrl, Alt, Shift and press a key. Escape cancels.'
      : 'Hold any of Ctrl, Alt, Shift and click this box with the button you want. Escape cancels.';
  };

  const record = (binding) => {
    cfg[t.field] = Object.assign({ enabled: cfg[t.field].enabled }, binding);
    stop();
    persist(true);
  };

  // A plain click (or Enter / Space) arms the recorder.
  btn.addEventListener('click', () => { if (!listening) start(); });
  btn.addEventListener('blur', () => { if (listening) stop(); });

  btn.addEventListener('keydown', (e) => {
    if (!listening) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { stop(); return; }
    if (t.kind !== 'key') return;
    if (/^(Control|Alt|Shift|Meta)$/.test(e.key)) return;
    record({ code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
  });

  if (t.kind === 'mouse') {
    btn.addEventListener('mousedown', (e) => {
      if (!listening) return;        // this is the click that arms it
      e.preventDefault();
      e.stopPropagation();
      // The click event that follows this press must not re-arm the recorder.
      const swallow = (ev) => { ev.preventDefault(); ev.stopImmediatePropagation(); };
      btn.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => btn.removeEventListener('click', swallow, true), 400);
      record({ button: e.button, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
    });
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    btn.addEventListener('auxclick', (e) => e.preventDefault());
  }
}

/* --------------------------------------------------------------- wiring */

function render() {
  for (const f of FLAGS) $(f).checked = !!cfg[f];
  for (const t of TRIGGERS) {
    $(t.enabled).checked = !!cfg[t.field].enabled;
    $(t.rec).textContent = t.kind === 'key' ? keyLabel(cfg[t.field]) : mouseLabel(cfg[t.field]);
  }
  $('folder').value = cfg.folder || '';
  $('template').value = cfg.template || '';
  $('captureFormat').value = cfg.captureFormat || 'png';
  $('captureQuality').value = cfg.captureQuality || 92;
  $('galleryMinSize').value = cfg.galleryMinSize || 0;
  // Quality means nothing for PNG, so the box is only there when it does.
  $('qualityRow').hidden = $('captureFormat').value === 'png';
  renderPreview();
  renderHints();
}

function collect() {
  for (const f of FLAGS) cfg[f] = $(f).checked;
  for (const t of TRIGGERS) cfg[t.field].enabled = $(t.enabled).checked;
  cfg.folder = $('folder').value.trim();
  cfg.template = $('template').value.trim() || '{name}.{ext}';
  cfg.captureFormat = $('captureFormat').value;
  cfg.captureQuality = Math.min(100, Math.max(10, parseInt($('captureQuality').value, 10) || 92));
  cfg.galleryMinSize = Math.max(0, parseInt($('galleryMinSize').value, 10) || 0);
  return cfg;
}

document.addEventListener('DOMContentLoaded', async () => {
  const s = await chrome.storage.sync.get('cfg');
  cfg = S.effective(s.cfg);
  render();
  TRIGGERS.forEach(bindRecorder);

  for (const id of FLAGS.concat(TRIGGERS.map((t) => t.enabled))) {
    $(id).addEventListener('change', () => persist(true));
  }
  $('captureFormat').addEventListener('change', () => {
    $('qualityRow').hidden = $('captureFormat').value === 'png';
    persist(true);
  });
  for (const id of ['folder', 'template']) {
    $(id).addEventListener('input', () => { renderPreview(); persist(false); });
  }
  for (const id of ['captureQuality', 'galleryMinSize']) {
    $(id).addEventListener('input', () => persist(false));
  }

  $('openFolder').addEventListener('click', () => chrome.downloads.showDefaultFolder());

  // Reset throws settings away, so it takes two presses.
  let armed = 0;
  $('reset').addEventListener('click', async () => {
    const btn = $('reset');
    if (!armed) {
      btn.textContent = 'Press again to reset everything';
      btn.classList.add('danger');
      armed = setTimeout(() => { armed = 0; btn.textContent = 'Reset everything to defaults'; btn.classList.remove('danger'); }, 4000);
      return;
    }
    clearTimeout(armed);
    armed = 0;
    clearTimeout(saveTimer);
    btn.textContent = 'Reset everything to defaults';
    btn.classList.remove('danger');
    cfg = S.effective(null);
    await chrome.storage.sync.remove('cfg');
    render();
    setStatus('Reset to defaults', false);
  });
});
