<p align="center">
  <img src="icons/logo.png" alt="Snaffle" width="140">
</p>

<h1 align="center">Snaffle</h1>

<p align="center">
  Grab any image or video off a page with a key or a click.<br>
  Rebuild streamed video, capture whole pages, bulk-download the lot.
</p>

---

A Chrome extension that saves whatever image or video is under your mouse pointer, triggered by a key combination or a mouse click you assign yourself.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and pick this folder: `E:\claude_me\projects\Snaffle`
4. Reload any tabs that were already open — content scripts are only injected into pages loaded after install

Pin the toolbar icon for a quick on/off switch and a reminder of your triggers.

## Default triggers

| Trigger | Default | Does |
| --- | --- | --- |
| Keyboard | `Alt + S` | save the media under the pointer |
| Mouse | `Alt + Middle click` | save the media under the pointer |
| Keyboard | `Alt + Shift + S` | full-page screenshot |
| Keyboard | `Alt + Shift + I` | open the page media list |
| Right-click menu | — | "Save with Snaffle" on images and video |
| Toolbar popup | — | on/off switch, full-page capture, media list |

Both are reassignable in the options page (toolbar icon → **Open settings**, or the Extensions page → **Details** → **Extension options**). Click the recorder box, then press the key combo or click with the mouse button you want. Either trigger can be turned off independently.

Triggers are suppressed while you are typing in a text field, and the click trigger swallows the follow-up click, `auxclick`, and context menu so the page does not navigate or open a tab.

## What it can find

Detection walks the element stack under the cursor — including shadow DOM and elements hidden beneath transparent overlays, which is how sites like X and Instagram cover their images:

- `<img>`, including `<picture>` / `srcset` and common lazy-load attributes (`data-src`, `data-original`, `data-zoom-image`, …)
- `<video>` and `<audio>` with a real file URL, plus `<source>` children
- CSS `background-image` on any ancestor
- `<canvas>` (exported as PNG when the canvas is not cross-origin tainted)
- inline `<svg>` (serialized)
- links pointing straight at a media file, so a thumbnail wrapped in a link to the full-size JPEG grabs the JPEG

### Full-resolution upgrades

With **Try for the original resolution** on (default), Snaffle picks the largest `srcset` candidate and rewrites known thumbnail URLs:

- X / Twitter → `name=orig`
- Reddit `preview.redd.it` → `i.redd.it`
- Imgur size-suffixed IDs → original
- Wikimedia `/thumb/…` paths → original
- Shopify `_1024x1024` suffixes, Squarespace `?format=750w`
- Image proxies that embed the real URL (Substack, weserv, and similar)
- Generic `?width=&height=&quality=` resize parameters

Signed URLs (AWS signatures, Instagram/Facebook CDNs) are left untouched, since editing them returns a 403.

### Streamed video (X, and other HLS sites)

Video on X is not a file. The player fetches an HLS playlist and feeds thousands of small segments to a `MediaSource`, so the `<video>` element only holds a `blob:` URL that refers to memory, not to anything downloadable. Saving it means rebuilding the file.

Snaffle does that:

1. A `webRequest` listener records every `.m3u8` playlist and whole-file `.mp4` the page requests — playlists only, never the segment storm.
2. On a grab, the hovered video's poster gives the media id. X repeats that same id in the video URL (`ext_tw_video/<id>/`), so the right playlist is matched exactly even with a dozen videos in one timeline. If the id matches nothing, Snaffle refuses rather than guessing and handing you the wrong video.
3. The master playlist is parsed, the highest-resolution variant is chosen, and its segments are fetched six at a time with retries.
4. The init segment and media segments are concatenated into one Blob and saved as `.mp4` (fragmented MP4) or `.ts` for legacy streams.

The toast shows segment progress, and **Escape cancels**. Files land as `user-statusid-720p.mp4`, the resolution taken from the playlist. Turn it off with **Rebuild streamed video** in options, which reverts to saving the poster frame.

It refuses, with a clear message, when a stream is encrypted (`#EXT-X-KEY` with real DRM), uses byte-range segments, or runs longer than 3000 segments. DRM-protected services are not defeated by this and are not meant to be — it works on X because X's segments are served unencrypted to any player.

For a site whose CDN refuses cross-origin reads, segment fetching falls back to the service worker, which has host permissions.

## Full-page screenshots

`Alt + Shift + S`, or the popup button. Captures the whole scrollable page, not just the window.

Chrome only hands an extension the *visible* viewport, so the page is scrolled a screenful at a time, each screen is captured through the service worker, and the shots are drawn onto one canvas at the position the page actually scrolled to — which makes the short final screen overlap correctly instead of duplicating content.

Details that matter in practice:

- **Sticky headers are suppressed after the first screen.** Otherwise a fixed navbar is baked into the image once per screenful. Fixed elements are hidden (no reflow); sticky ones are pinned back to their flow position so they do not leave a gap. Toggleable.
- **`captureVisibleTab` is quota-limited** to roughly two calls a second. Captures are paced accordingly and the quota error is retried, which is why a long page takes a few seconds per screen.
- **Canvas limits are respected.** Chrome will not allocate past ~32000px a side or ~240M pixels, so a very long page is scaled down to fit rather than failing. The toast says when that happened.
- **Lazy images get a beat to load** after each scroll.
- Progress shows on the toolbar badge rather than in a toast, so the overlay never lands in the screenshot.
- Output is PNG, JPEG, or a single-page PDF. The PDF embeds the JPEG directly (`DCTDecode`) and clamps the page to the 14400pt limit while keeping aspect ratio.

Horizontal capture is included for pages wider than the window, and can be turned off.

## Page media list

`Alt + Shift + I`, or the popup button. Opens a panel of everything on the page, for picking and bulk downloading.

- Collects `<img>` (largest `srcset` candidate, after the full-resolution rewrites), `<video>` files and posters, CSS `background-image`, and links pointing at media files — **across all frames**, since `tabs.sendMessage` only returns one reply, each frame pushes its own list and the service worker gathers them.
- Sorted biggest first. Filter by minimum dimension, by file type (chips built from what the page actually has), and by URL substring.
- Dimensions come from the DOM where known and are filled in as thumbnails decode, so items whose size is not known yet are never hidden by the size filter.
- File sizes come from the Resource Timing API — no extra network requests — so they show only for resources the browser will report, which excludes cross-origin ones without `Timing-Allow-Origin`.
- Click cards to select, then Download. Files go through the same folder and naming templates, so `{index}` numbers a batch.
- Escape, the × button, or the trigger again closes it.

## File naming

Two templates in options, both accepting tokens:

| Token | Meaning |
| --- | --- |
| `{name}` `{ext}` | file name and extension from the URL |
| `{host}` | page domain, `www.` stripped |
| `{title}` `{alt}` | page title, image alt text |
| `{kind}` | `image`, `video`, or `audio` |
| `{date}` `{time}` `{datetime}` `{ts}` | timestamps |
| `{index}` | zero-padded running counter |

Defaults: folder `Snaffle/{host}`, name `{name}.{ext}` — so a photo from example.com lands in `Downloads/Snaffle/example.com/`. The options page shows a live preview of the resulting path. Characters Windows rejects are replaced with `_`; spaces and dashes are kept.

## How downloads are attempted

1. **Downloads API** with the resolved URL — normal path, respects your subfolder and the uniquify rule
2. **Page-context fetch** if that fails or the server rejects it — the page's own cookies and `Referer` apply, which defeats most hotlink protection
3. **Service-worker fetch** as a last resort, saved as a data URL (capped at 60 MB)

`data:` and `blob:` sources skip straight to step 2, since the browser cannot hand those to the Downloads API from another context.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest |
| `content.js` | hover tracking, media resolution, HLS assembly, triggers, toast/outline UI |
| `capture.js` | full-page screenshot: scroll, stitch, PNG/JPEG/PDF |
| `gallery.js` | page media list panel and bulk download |
| `background.js` | filename building, downloads, retries, playlist sniffer, screenshots, context menu |
| `options.html/.css/.js` | settings with key and mouse recorders |
| `popup.html/.css/.js` | on/off switch, trigger summary, capture and list buttons |
| `test/snaffle.test.js` | offline checks — `node test/snaffle.test.js` |
| `icons/` | generated PNG icons |

`capture.js` and `gallery.js` are separate content scripts in the same isolated world. `content.js` publishes a shared object (`window.__SNAFFLE`) holding the UI and download plumbing, and they attach themselves to it, so manifest load order matters. A test enforces both the order and that neither file reaches for a helper the core does not export.

## Icon

`icons/logo.png` is the master. Regenerate the set with:

```
pwsh -File tools/make-icons.ps1
```

32, 48 and 128 are resampled from the master. **16 is different artwork** — the full logo (claw, photo tile, sun, hills) turns to mush at 16 pixels, so the toolbar icon is the claw alone, which is the only part whose silhouette survives. Size-specific artwork is normal practice; Chrome picks the right file per context.

## Tests

```
node test/snaffle.test.js
```

55 checks over the parts that are easy to break and invisible in a browser: URL rewriting per site, `srcset` parsing, HLS master/media playlists and each refusal condition, file-name sanitizing and templates, the PDF writer's xref byte offsets, and static wiring — that every element id the UI scripts reach for exists in their HTML, that every saved option has a default, that the three key bindings do not ship colliding defaults.

The DOM and network halves are not covered: hover resolution, click suppression, the sniffer, segment assembly, and the screenshot stitching all need a real browser.

## Troubleshooting

**Something else happens instead of a download.** Chrome owns several click gestures on links, and X, Reddit, and most feeds wrap their media in links:

| Gesture | What Chrome does |
| --- | --- |
| `Ctrl + Alt + Click` | opens the link in **split view** |
| `Middle click` | opens the link in a new tab |
| `Alt + Click` | downloads the link target |
| `Ctrl + Click` | opens in a background tab |
| `Alt + D` | focuses the address bar |

Snaffle cancels the entire click sequence (`pointerdown` through `auxclick`) when it recognizes your trigger, which blocks these. If a browser gesture still fires, Snaffle did not see the click:

1. **Reload the tab.** Content scripts are only injected into pages loaded after the extension was installed or reloaded.
2. **Check the combination matches exactly.** The trigger requires those modifiers and no others — `Ctrl + Alt + Middle click` does not fire a trigger set to `Alt + Middle click`, so Chrome handles it instead.
3. **Look for a toast.** Any toast at all — including an error — means Snaffle intercepted the click. No toast means it never ran.
4. **Confirm it is on.** Toolbar icon, master switch, and the per-trigger on/off state.

**A video on X saves the poster image instead of the video.** Snaffle never saw the playlist, because the tab was loaded before the extension was installed or reloaded, or the video has not been played yet. Reload the tab, let the video start, then grab. The playlist is recorded the moment the player requests it.

**"That stream is too long to reassemble."** Over 3000 segments. That is roughly a feature-length video, and reassembling it in a browser tab is not sensible.

## Notes and limits

- Chrome does not run extensions on `chrome://` pages, the Web Store, or other extensions' pages — nothing will happen there.
- DRM-protected video cannot be saved.
- The extension asks for `<all_urls>` because media can be on any site, and because screenshots need it; and for `webRequest` so it can see the video playlist URLs a page requests. Chrome describes that permission as reading your browsing history. Nothing is read off-page and nothing is sent anywhere — recorded playlist URLs live in `chrome.storage.session`, which is memory-only, cleared when Chrome closes, and pruned after two hours. Downloads go straight to your disk.
- Settings live in `chrome.storage.sync`, so they follow your Chrome profile across machines.
