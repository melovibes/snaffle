/* Snaffle - toolbar popup: the switch, what the triggers are, the two page
   actions, and what was saved lately. */

const S = SnaffleShared;
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const $ = (id) => document.getElementById(id);
const keyLabel = (t) => S.keyLabel(t, IS_MAC);
const mouseLabel = (t) => S.mouseLabel(t, IS_MAC);

const ask = (msg) => new Promise((res) => {
  chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r); });
});

function say(text) {
  const note = $('note');
  note.textContent = text;
  note.hidden = !text;
}

// The last few files Snaffle saved, each one a button that shows it in its folder.
function renderRecent() {
  chrome.downloads.search({ orderBy: ['-startTime'], limit: 40 }, (items) => {
    const mine = (items || []).filter((d) => d.byExtensionId === chrome.runtime.id && d.state === 'complete' && d.exists !== false).slice(0, 5);
    const list = $('recent');
    list.textContent = '';
    if (!mine.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Nothing saved yet.';
      list.appendChild(li);
      return;
    }
    for (const d of mine) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'file';
      const name = String(d.filename).split(/[\\/]/).pop();
      b.textContent = name;
      // The visible text is only the file name. Say what pressing it does in
      // the accessible name, which a tooltip alone does not reliably provide.
      b.setAttribute('aria-label', 'Show ' + name + ' in its folder');
      b.title = 'Show ' + name + ' in its folder';
      b.addEventListener('click', () => chrome.downloads.show(d.id));
      li.appendChild(b);
      list.appendChild(li);
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  const s = await chrome.storage.sync.get('cfg');
  const cfg = S.effective(s.cfg);

  const paint = () => {
    $('enabled').checked = !!cfg.enabled;
    document.body.classList.toggle('off', !cfg.enabled);
    $('keyLabel').textContent = keyLabel(cfg.key);
    $('mouseLabel').textContent = mouseLabel(cfg.mouse);
    $('keyWrap').classList.toggle('disabled', !cfg.key.enabled);
    $('mouseWrap').classList.toggle('disabled', !cfg.mouse.enabled);
    $('keyWrap').title = cfg.key.enabled ? '' : 'This trigger is turned off in Settings';
    $('mouseWrap').title = cfg.mouse.enabled ? '' : 'This trigger is turned off in Settings';
    $('captureLabel').textContent = cfg.captureKey.enabled ? keyLabel(cfg.captureKey) : 'no shortcut';
    $('galleryLabel').textContent = cfg.galleryKey.enabled ? keyLabel(cfg.galleryKey) : 'no shortcut';
    $('dest').textContent = 'Downloads' + (cfg.folder ? '/' + cfg.folder : '');
  };
  paint();
  renderRecent();

  $('enabled').addEventListener('change', async () => {
    cfg.enabled = $('enabled').checked;
    await chrome.storage.sync.set({ cfg: S.toStore(cfg) });
    paint();
  });

  // The toolbar popup acts on the tab it was opened over. Opened as a page of
  // its own with ?tab=<id> it acts on that tab instead, which is how the tests
  // drive it.
  const named = parseInt(new URLSearchParams(location.search).get('tab') || '', 10);
  const [tab] = Number.isInteger(named)
    ? [{ id: named }]
    : await chrome.tabs.query({ active: true, currentWindow: true });

  // Find out now whether this page is one Snaffle can work on, instead of
  // letting a button do nothing. Asking also loads Snaffle into a tab that was
  // open before it was installed.
  if (tab) {
    const ok = await ask({ type: 'canRun', tabId: tab.id });
    if (!ok || !ok.ok) {
      say('Snaffle cannot run on this page. Browser pages, the Web Store and other extensions are off limits.');
      $('capture').disabled = true;
      $('gallery').disabled = true;
    }
  }

  // The service worker loads the feature into the tab and starts it.
  const run = async (name) => {
    if (!tab) return;
    const r = await ask({ type: 'feature', name, tabId: tab.id });
    if (r && r.ok) { if (!Number.isInteger(named)) window.close(); return; }
    say((r && r.error) || 'Snaffle cannot run on this page.');
  };

  $('capture').addEventListener('click', () => run('capture'));
  $('gallery').addEventListener('click', () => run('gallery'));
  $('folder').addEventListener('click', () => chrome.downloads.showDefaultFolder());
  $('open').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
});
