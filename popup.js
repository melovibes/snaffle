/* Snaffle - toolbar popup */

const S = SnaffleShared;
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const $ = (id) => document.getElementById(id);
const keyLabel = (t) => S.keyLabel(t, IS_MAC);
const mouseLabel = (t) => S.mouseLabel(t, IS_MAC);

document.addEventListener('DOMContentLoaded', async () => {
  const s = await chrome.storage.sync.get('cfg');
  const cfg = S.effective(s.cfg);

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
    await chrome.storage.sync.set({ cfg: S.toStore(cfg) });
  });

  // The service worker loads the feature into the tab and starts it. If the
  // page is one extensions cannot touch, it says so and the popup stays open
  // to show that, rather than closing as if something had happened.
  const run = async (name) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    chrome.runtime.sendMessage({ type: 'feature', name, tabId: tab.id }, (r) => {
      void chrome.runtime.lastError;
      if (r && r.ok) { window.close(); return; }
      $('note').textContent = (r && r.error) || 'Snaffle cannot run on this page.';
      $('note').classList.add('warn');
    });
  };

  $('capture').addEventListener('click', () => run('capture'));
  $('gallery').addEventListener('click', () => run('gallery'));

  $('open').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
});
