/* Snaffle - code every part of the extension needs: defaults, config
   handling, labels, file naming, content-type rules. Loaded as the first
   content script, by importScripts in the service worker, and by a script tag
   in the extension pages. Node can require it for tests.

   `var` and the reuse guard are deliberate: this file is injected again into
   tabs that already have it when the extension updates. */
var SnaffleShared = (typeof SnaffleShared !== 'undefined' && SnaffleShared) || (function () {
  const CFG_VERSION = 2;

  const DEFAULTS = {
    enabled: true,
    key: { enabled: true, code: 'KeyS', ctrl: false, alt: true, shift: false, meta: false },
    mouse: { enabled: true, button: 1, ctrl: false, alt: true, shift: false, meta: false },
    captureKey: { enabled: true, code: 'KeyS', ctrl: false, alt: true, shift: true, meta: false },
    galleryKey: { enabled: true, code: 'KeyI', ctrl: false, alt: true, shift: true, meta: false },
    folder: 'Snaffle/{host}',
    template: '{name}.{ext}',
    captureThen: 'review',     // 'review' opens it to look at first; 'save' saves it straight away
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

  // Values that were once the default. Early versions wrote every default
  // into storage at install, so a stored value matching one of these was never
  // a choice the user made and must not pin them to an old default.
  const LEGACY_DEFAULTS = {
    folder: ['HoverGrab/{host}'],
    key: [{ enabled: true, code: 'KeyD', ctrl: false, alt: true, shift: false, meta: false }]
  };

  const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

  function merge(base, over) {
    const out = Object.assign({}, base);
    for (const k of Object.keys(over || {})) {
      const v = over[k];
      if (isObject(v) && isObject(base[k])) out[k] = merge(base[k], v);
      else if (v !== undefined) out[k] = v;
    }
    return out;
  }

  // Compare the fields that carry meaning. `label` was stored alongside
  // bindings by early versions and is derived, not chosen.
  function same(a, b) {
    if (isObject(a) && isObject(b)) {
      const keys = new Set(Object.keys(a).concat(Object.keys(b)));
      keys.delete('label');
      for (const k of keys) if (!same(a[k], b[k])) return false;
      return true;
    }
    return a === b;
  }

  // What the user actually changed: the stored object minus anything that
  // equals a default, current or historical. Only this is written to storage,
  // so a default can change in a later version and reach everyone who never
  // touched that setting.
  function overridesOf(cfg) {
    const out = {};
    for (const k of Object.keys(cfg || {})) {
      if (!(k in DEFAULTS)) continue;
      const v = cfg[k];
      if (same(v, DEFAULTS[k])) continue;
      if ((LEGACY_DEFAULTS[k] || []).some((old) => same(v, old))) continue;
      if (isObject(v)) { const copy = Object.assign({}, v); delete copy.label; out[k] = copy; }
      else out[k] = v;
    }
    return out;
  }

  // The settings in force: defaults, with the user's changes on top.
  function effective(stored) {
    return merge(DEFAULTS, overridesOf(stored));
  }

  // What to write to storage for a given set of settings.
  function toStore(cfg) {
    return Object.assign({ v: CFG_VERSION }, overridesOf(cfg));
  }

  /* ---------------------------------------------------------------- labels */

  const BUTTONS = ['Left click', 'Middle click', 'Right click', 'Back button', 'Forward button'];

  function modifiers(t, mac) {
    const parts = [];
    if (t.ctrl) parts.push('Ctrl');
    if (t.alt) parts.push(mac ? 'Option' : 'Alt');
    if (t.shift) parts.push('Shift');
    if (t.meta) parts.push(mac ? 'Cmd' : 'Win');
    return parts;
  }

  function keyLabel(t, mac) {
    const parts = modifiers(t || {}, mac);
    let name = (t && t.code) || '';
    if (/^Key[A-Z]$/.test(name)) name = name.slice(3);
    else if (/^Digit\d$/.test(name)) name = name.slice(5);
    else if (/^Numpad(.+)$/.test(name)) name = 'Numpad ' + name.slice(6);
    else if (/^Arrow(.+)$/.test(name)) name = name.slice(5) + ' arrow';
    parts.push(name || '?');
    return parts.join(' + ');
  }

  function mouseLabel(t, mac) {
    const parts = modifiers(t || {}, mac);
    parts.push(BUTTONS[t && t.button] || 'Button ' + (t && t.button));
    return parts.join(' + ');
  }

  /* ------------------------------------------------- shortcut collisions */

  const signature = (t) => (t.ctrl ? 'ctrl+' : '') + (t.alt ? 'alt+' : '') + (t.shift ? 'shift+' : '') + (t.meta ? 'meta+' : '');

  // Combinations Chrome acts on before a page ever hears of them. A trigger
  // set to one of these would simply never fire.
  const KEYS_CHROME_KEEPS = {
    'ctrl+KeyT': 'opening a new tab', 'ctrl+KeyN': 'opening a new window', 'ctrl+KeyW': 'closing the tab',
    'ctrl+shift+KeyT': 'reopening a closed tab', 'ctrl+shift+KeyN': 'opening an incognito window',
    'ctrl+shift+KeyW': 'closing the window', 'ctrl+Tab': 'switching tabs', 'ctrl+shift+Tab': 'switching tabs',
    'alt+F4': 'closing the window', 'ctrl+PageUp': 'switching tabs', 'ctrl+PageDown': 'switching tabs'
  };

  // Combinations Chrome uses, but which a page is offered first. Snaffle can
  // take these, at the cost of the usual meaning on web pages.
  const KEYS_CHROME_USES = {
    'alt+KeyD': 'jumping to the address bar', 'ctrl+KeyL': 'jumping to the address bar',
    'ctrl+KeyD': 'bookmarking the page', 'ctrl+KeyS': 'saving the page', 'ctrl+KeyP': 'printing',
    'ctrl+KeyF': 'find in page', 'ctrl+KeyG': 'find next', 'ctrl+KeyH': 'history', 'ctrl+KeyJ': 'downloads',
    'ctrl+KeyR': 'reloading', 'ctrl+KeyU': 'viewing page source', 'ctrl+KeyO': 'opening a file',
    'ctrl+KeyA': 'select all', 'ctrl+KeyC': 'copy', 'ctrl+KeyV': 'paste', 'ctrl+KeyX': 'cut',
    'ctrl+KeyZ': 'undo', 'ctrl+KeyY': 'redo', 'ctrl+KeyK': 'searching', 'ctrl+KeyE': 'searching',
    'ctrl+shift+KeyI': 'developer tools', 'ctrl+shift+KeyJ': 'developer tools', 'ctrl+shift+KeyC': 'developer tools',
    'ctrl+shift+Delete': 'clearing browsing data', 'ctrl+shift+KeyB': 'the bookmarks bar',
    'alt+ArrowLeft': 'going back', 'alt+ArrowRight': 'going forward', 'alt+Home': 'the home page',
    'alt+KeyE': 'the Chrome menu', 'alt+KeyF': 'the Chrome menu',
    'F5': 'reloading', 'F11': 'full screen', 'F12': 'developer tools', 'F3': 'find next', 'F1': 'help',
    'ctrl+Equal': 'zooming', 'ctrl+Minus': 'zooming', 'ctrl+Digit0': 'resetting zoom'
  };

  // What the user should know about a keyboard binding, or '' if nothing.
  // `blocked` means the binding cannot work at all.
  function keyWarning(t) {
    if (!t || !t.code) return { text: '', blocked: false };
    const sig = signature(t) + t.code;
    if (KEYS_CHROME_KEEPS[sig]) {
      return { text: 'Chrome keeps this for ' + KEYS_CHROME_KEEPS[sig] + ' and never passes it to a page, so it will not work.', blocked: true };
    }
    if (KEYS_CHROME_USES[sig]) {
      return { text: 'Chrome uses this for ' + KEYS_CHROME_USES[sig] + '. Snaffle will take it over on web pages.', blocked: false };
    }
    if (!signature(t) && /^(Key[A-Z]|Digit\d|Space|Enter|Backspace|Tab|Arrow.+)$/.test(t.code)) {
      return { text: 'With no Ctrl, Alt or Shift this fires whenever you press the key outside a text box, and many sites use single keys themselves.', blocked: false };
    }
    return { text: '', blocked: false };
  }

  function mouseWarning(t) {
    if (!t) return { text: '', blocked: false };
    const sig = signature(t);
    if (t.button === 3 || t.button === 4) {
      return { text: 'Back and Forward buttons make the browser navigate before a page can stop it, so this may not work.', blocked: false };
    }
    if (!sig && t.button === 0) return { text: 'A plain left click would fire on every click you make. Hold a modifier key.', blocked: true };
    if (!sig && t.button === 2) return { text: 'This replaces the right-click menu on every page.', blocked: false };
    if (!sig && t.button === 1) return { text: 'Middle click will stop opening links in new tabs.', blocked: false };
    if (t.button === 0) {
      const uses = {
        'ctrl+alt+': 'opening a link in split view', 'alt+': 'downloading a link',
        'ctrl+': 'opening a link in a new tab', 'shift+': 'opening a link in a new window',
        'ctrl+shift+': 'opening a link in a new tab'
      }[sig];
      if (uses) return { text: 'Chrome uses this for ' + uses + '. Snaffle will take it over on web pages.', blocked: false };
    }
    return { text: '', blocked: false };
  }

  /* ----------------------------------------------------------- file names */

  const pad = (n) => String(n).padStart(2, '0');

  function sanitizeSegment(s) {
    return String(s || '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 100);
  }

  function applyTemplate(tpl, tok, index) {
    const d = new Date();
    const map = {
      name: tok.name, ext: tok.ext, host: tok.host, title: tok.title, alt: tok.alt, kind: tok.kind,
      date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()),
      time: pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()),
      datetime: '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()),
      ts: String(Date.now()),
      index: String(index).padStart(4, '0')
    };
    return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (k in map ? (map[k] == null ? '' : map[k]) : m));
  }

  // The path a file is saved under, relative to the Downloads folder.
  function buildPath(rawTok, cfg, index) {
    const tok = Object.assign({}, rawTok);
    // An empty {name} would collapse the template to a bare extension.
    if (!tok.name) tok.name = tok.host || 'media';

    let name = applyTemplate(cfg.template || '{name}.{ext}', tok, index);
    name = name.split('/').map(sanitizeSegment).filter(Boolean).join('/');
    if (!name) name = (tok.host || 'media') + '-' + index + '.' + tok.ext;
    if (!/\.[a-z0-9]{1,5}$/i.test(name)) name += '.' + tok.ext;

    const folder = applyTemplate(cfg.folder || '', tok, index)
      .split('/').map(sanitizeSegment).filter(Boolean).join('/');
    return folder ? folder + '/' + name : name;
  }

  /* -------------------------------------------------------- content types */

  const MIME_EXT = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/x-icon': 'ico',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/ogg': 'ogg'
  };
  const cleanMime = (m) => String(m || '').toLowerCase().split(';')[0].trim();

  // Text is never the picture or video someone pointed at. SVG is the one
  // image type that calls itself XML.
  function notMedia(mime) {
    const m = cleanMime(mime);
    if (!m || /svg/.test(m)) return false;
    return /^text\/|html|json|xml|javascript/.test(m);
  }

  // The extension a file should carry, given what the server says it is. A
  // .jpg address that serves WebP is common, and the file should say what it holds.
  function nameForMime(filename, mime) {
    const real = MIME_EXT[cleanMime(mime)];
    if (!real) return filename;
    const had = (/\.([a-z0-9]{1,5})$/i.exec(filename) || [])[1] || '';
    const matches = had.toLowerCase() === real || (/^jpe?g$/i.test(had) && real === 'jpg');
    if (matches) return filename;
    return had ? filename.slice(0, -had.length) + real : filename + '.' + real;
  }

  const sizeText = (bytes) => (bytes >= 1048576
    ? (bytes / 1048576).toFixed(1) + ' MB'
    : Math.max(1, Math.round(bytes / 1024)) + ' KB');

  return {
    CFG_VERSION, DEFAULTS, LEGACY_DEFAULTS,
    merge, overridesOf, effective, toStore,
    BUTTONS, keyLabel, mouseLabel, keyWarning, mouseWarning,
    sanitizeSegment, applyTemplate, buildPath,
    MIME_EXT, cleanMime, notMedia, nameForMime, sizeText
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SnaffleShared;
