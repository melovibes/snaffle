/* Snaffle - toolbar popup */

const DEFAULTS = {
  enabled: true,
  key: { enabled: true, code: 'KeyS', label: 'Alt + S', ctrl: false, alt: true, shift: false, meta: false },
  mouse: { enabled: true, button: 1, label: 'Alt + Middle click', ctrl: false, alt: true, shift: false, meta: false },
  captureKey: { enabled: true, code: 'KeyS', label: 'Alt + Shift + S', ctrl: false, alt: true, shift: true, meta: false },
  galleryKey: { enabled: true, code: 'KeyI', label: 'Alt + Shift + I', ctrl: false, alt: true, shift: true, meta: false },
  folder: 'Snaffle/{host}',
  template: '{name}.{ext}'
};

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const BUTTONS = ['Left click', 'Middle click', 'Right click', 'Back button', 'Forward button'];
const $ = (id) => document.getElementById(id);

function mods(t) {
  const p = [];
  if (t.ctrl) p.push('Ctrl');
  if (t.alt) p.push(IS_MAC ? 'Option' : 'Alt');
  if (t.shift) p.push('Shift');
  if (t.meta) p.push(IS_MAC ? 'Cmd' : 'Win');
  return p;
}

function keyLabel(t) {
  const p = mods(t);
  let n = t.code || '';
  if (/^Key[A-Z]$/.test(n)) n = n.slice(3);
  else if (/^Digit\d$/.test(n)) n = n.slice(5);
  else if (/^Arrow(.+)$/.test(n)) n = n.slice(5) + ' arrow';
  p.push(n || '?');
  return p.join(' + ');
}

function mouseLabel(t) {
  const p = mods(t);
  p.push(BUTTONS[t.button] || 'Button ' + t.button);
  return p.join(' + ');
}

document.addEventListener('DOMContentLoaded', async () => {
  const s = await chrome.storage.sync.get('cfg');
  const cfg = Object.assign({}, DEFAULTS, s.cfg || {});
  cfg.key = Object.assign({}, DEFAULTS.key, cfg.key || {});
  cfg.mouse = Object.assign({}, DEFAULTS.mouse, cfg.mouse || {});

  $('enabled').checked = !!cfg.enabled;
  $('keyLabel').textContent = keyLabel(cfg.key);
  $('mouseLabel').textContent = mouseLabel(cfg.mouse);
  $('keyState').textContent = cfg.key.enabled ? 'on' : 'off';
  $('keyState').className = 'state' + (cfg.key.enabled ? '' : ' off');
  $('mouseState').textContent = cfg.mouse.enabled ? 'on' : 'off';
  $('mouseState').className = 'state' + (cfg.mouse.enabled ? '' : ' off');
  $('captureLabel').textContent = keyLabel(cfg.captureKey);
  $('galleryLabel').textContent = keyLabel(cfg.galleryKey);
  $('dest').textContent = 'Downloads/' + (cfg.folder ? cfg.folder + '/' : '') + cfg.template;

  $('enabled').addEventListener('change', async () => {
    cfg.enabled = $('enabled').checked;
    await chrome.storage.sync.set({ cfg });
  });

  // Both actions run in the page's top frame.
  const runInPage = async (type) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { type }, { frameId: 0 }, () => void chrome.runtime.lastError);
    window.close();
  };

  $('capture').addEventListener('click', () => runInPage('captureNow'));
  $('gallery').addEventListener('click', () => runInPage('galleryNow'));

  $('open').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
});
