/* A pointer and a key label, drawn into the page for recordings and store
   screenshots. A headless browser has no pointer to capture, and a still
   picture cannot show which keys were pressed. Neither is part of Snaffle,
   and anything made with them says so.

   The function is handed to the browser and runs inside each page, so it
   must not refer to anything outside itself. */

function overlay() {
  if (window.top !== window || window.__demo) return;
  const cursor = document.createElement('div');
  cursor.id = '__demo_cursor';
  cursor.style.cssText = 'position:fixed;left:0;top:0;width:20px;height:24px;z-index:2147483647;pointer-events:none;' +
    'transform:translate(-100px,-100px);background:#111;' +
    'clip-path:polygon(0 0,0 76%,24% 58%,40% 96%,54% 90%,38% 54%,70% 54%);' +
    'filter:drop-shadow(0 0 1px #fff) drop-shadow(0 0 1px #fff) drop-shadow(0 2px 3px rgba(0,0,0,.45));';
  const keys = document.createElement('div');
  keys.id = '__demo_keys';
  keys.style.cssText = 'position:fixed;left:24px;bottom:24px;z-index:2147483647;pointer-events:none;opacity:0;' +
    'transition:opacity .18s;background:#111827;color:#fff;border-radius:9px;padding:9px 16px;' +
    'font:600 16px/1.2 system-ui,"Segoe UI",sans-serif;letter-spacing:.2px;box-shadow:0 6px 20px rgba(0,0,0,.28);';
  let timer = 0;
  const attach = () => {
    const root = document.documentElement;
    if (!root) return;
    // Last in the document, so nothing opened later sits on top of them.
    if (root.lastElementChild !== cursor) { root.appendChild(keys); root.appendChild(cursor); }
  };
  document.addEventListener('mousemove', (e) => {
    attach();
    cursor.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)';
  }, true);
  window.__demo = {
    // ms of 0 leaves the label up until it is changed or hidden.
    keys(text, ms) {
      attach();
      keys.textContent = text;
      keys.style.opacity = '1';
      clearTimeout(timer);
      if (ms !== 0) timer = setTimeout(() => { keys.style.opacity = '0'; }, ms || 1400);
    },
    hide(yes) {
      cursor.style.display = yes ? 'none' : '';
      keys.style.display = yes ? 'none' : '';
    }
  };
}

module.exports = { overlay };
