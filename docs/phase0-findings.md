# Phase 0 findings

First time the extension has been exercised end to end. The real extension is loaded into headless Chromium and driven with real pointer and keyboard input against local fixture pages. Every result is cross-checked three ways: the toast the user would read, Chrome's own download record, and the fixture server's request log.

```
npm install
npm run test:browser          # all areas, about 3 minutes
node test/browser/run.js grab # one area: grab | stream | shot | list | ui | life
```

**Result at the time: 47 checks, 19 pass, 28 fail.** A failing check is a defect in the extension, not a broken test.

## Status after Phase 1 (v1.1.0)

**49 checks: 38 pass, 11 known defects, 1 not observable under automation.**

Fixed, each with a check that now passes:

| Defect | Checks |
| --- | --- |
| Mouse trigger did nothing | G17, G20 |
| Images in a shadow root not found | G16 |
| Link-following never fired | G05 |
| Keyboard trigger over an iframe saved a different image | G18, G19 |
| Pointer outside the page saved a stale target | G27 |
| Encoded tracking URL hijacked the download | G06 |
| Background texture beat the photo | G04 |
| `data-` attribute holding an id trusted as a source | G07 |
| Web page saved as an image and reported as saved | G13 |
| "Saved" left standing after total failure | G15 |
| Canvas, SVG, recovered files, rebuilt video and screenshots ignored the folder | G09, G10, G14, S06, C01 |
| Sniffer recorded the extension's own playlist fetches | S03 |
| File size misreported | S06 |

Changed but not solved: with no media id and several streams on a page, Snaffle still takes the most recent stream, which can be the wrong video. It now says so in the toast (S02). Matching a stream to its video element on sites other than X is still open.

Still open, by phase:

| Check | Defect | Phase |
| --- | --- | --- |
| S04 | Split-audio streams save without sound | 2 |
| P05 | Defaults written to storage at install | 2 |
| X02 | Service worker fetches any URL it is asked for | 2 |
| L06 | Media list has no keyboard access | 3 |
| P02 | Recorded shortcut not saved until Save is pressed | 3 |
| C02 | Capture trusts `devicePixelRatio` instead of measuring the shot | 4 |
| C03 | Fixed elements hidden before the first shot | 4 |
| C04 | Inner scrolling containers not detected | 4 |
| C05 | No check that the tab is still in front | 4 |
| L02 | Thumbnails load full-size originals | 4 |
| L05 | Size filter not re-applied when dimensions arrive | 4 |

G12 (WebP named `.jpg`) has a fix that cannot be observed here: Chrome skips an extension's filename hook when downloads are driven through the automation protocol. The renaming logic is unit-tested; the end-to-end behaviour needs a manual check.

The rest of this document is the original Phase 0 record.

## Defects, ranked for Phase 1

### Broken outright

| Check | What happens | Cause |
| --- | --- | --- |
| G17, G20 | **The mouse trigger does nothing.** No download, no toast. | The split-view fix cancels `pointerdown`. Chromium then never sends the `mousedown` the grab waits for. Confirmed in isolation. |
| G16 | **Images inside a shadow root are not found.** | The hover "optimisation" replaced `composedPath()` with a walk up from the event target, which is retargeted to the shadow host. |
| G05 | **"Follow links to the full file" never fires** for `<a><img></a>`. The thumbnail is saved. | The image is reached before its parent link in the stack, so the link is never seen in time. |
| G18, G19 | **Keyboard trigger over an iframe saves a different image**: whatever the pointer last touched in the top page. | Key lands in the top frame, whose pointer position is stale while the pointer is over a frame. |

### Saves the wrong thing

| Check | What happens |
| --- | --- |
| G06 | A tracking parameter containing an encoded URL makes it download that page: `article.html` saved instead of the image. |
| G04 | A background texture on a container beats the photo under an overlay. |
| G07 | `data-image="12345"` is treated as a better source. The download 404s. |
| S02 | With no media id, hovering video b saves video c (the most recent playlist). No warning. |
| S03 | After any stream download, an id-less grab saves **the previously downloaded video**. The extension's own playlist fetches are recorded by its sniffer as if the page made them. |
| C05 | Switching tabs mid-capture: 4 of 5 screens in the image are the other tab. |

### Says "Saved" when it is not true

| Check | What happens |
| --- | --- |
| G13 | A URL answering with a web page is saved as `broken.jpg` and reported as saved. |
| G15 | Hotlink-protected cross-origin image: every fallback fails, no file exists, toast still reads "Saved far.png". |
| G07 | Same: download interrupted, toast says saved. |
| C02 | With an emulated device pixel ratio of 2 the screenshot is mostly blank, reported as saved. See "not verified" below. |

### Wrong place or wrong name

| Check | What happens |
| --- | --- |
| G09, G10, S01 | Canvas, SVG and rebuilt video ignore the configured folder and land in the Downloads root. |
| G12 | An extension-less WebP is named `.jpg`. |
| S01 | A 101 KB file is announced as "1 MB". |

### Screenshot

| Check | What happens |
| --- | --- |
| C03 | Fixed header and footer are missing from **every** screen, including the first. They are hidden before the first shot is taken, not after. |
| C04 | A page that scrolls inside a container yields one 700px screen of a 2500px document, with a plain "Saved". |

### Media list, settings, security

| Check | What happens |
| --- | --- |
| L02 | Opening the list fetches the 800x600 and 1600x1200 originals to draw thumbnails of images the page had only loaded at 200x150. |
| L05 | A 10x10 background image stays listed after its size is known, despite the 80px minimum. Select all skips it, so the card is on screen but unselectable in bulk. |
| L06 | Cards have no `tabindex` or role. The list cannot be used from the keyboard. |
| P02 | A recorded shortcut shows in the box but is not stored. After a reload the box reverts. Nothing marks it as unsaved. |
| P05 | All 20 defaults are written into storage at install. |
| S04 | A stream with separate audio is saved silent (the toast does say so). |
| X02 | The service worker fetched a loopback URL on request and returned its contents. |

## Review predictions: scorecard

| Outcome | Items |
| --- | --- |
| Confirmed (13) | 1 unwrap and no content check, 3 data attributes, 5 background beats photo, 6 iframes, 7 wrong video, 8 folder ignored, 9 silent video, 11 tab switch, 12 inner scroller, 16 thumbnails, 18 size filter, 19 open proxy, 20 frozen defaults |
| Wrong (2) | 4 stale hover after scrolling: Chromium re-sends hover after a scroll, so the right image is saved (G23). 17 `blob:` items in bulk download: they save fine (L03). |
| Different from predicted (2) | 13: fixed bars are not baked in mid-page, they are missing everywhere (C03). 21: after an extension reload an open tab still saves images through the page fallback, but into the Downloads root (X01). |
| Not tested (6) | 2 Reddit rewrite, 10 one video blocks other grabs, 14 canvas memory, 15 cancel and infinite scroll, 22 injection weight, 23 outline cost |

Six defects were not predicted at all: the dead mouse trigger, the shadow-root regression, the dead link-following option, the sniffer recording its own fetches, the standing "Saved" after total failure, and the `.jpg` naming of WebP.

## Verified working

Plain images, largest `srcset` candidate, images under a transparent overlay, CSS backgrounds, direct video files, same-origin hotlink recovery, the typing guard, the master switch, hover after wheel scrolling.

Id-matched stream rebuild is byte-exact against the source segments, and `ffprobe` reads the result as video plus audio at the correct 6.05s. Streams on a CDN without CORS rebuild through the service worker with the best rendition and pieces in order.

Screenshot stitching at device pixel ratio 1 is pixel-correct across five screens, scroll position is restored, and JPEG and PDF output are structurally valid.

The media list collects across a cross-origin iframe, and bulk download saved every selected item with an accurate count. Options and popup load with no console errors, and a saved shortcut takes effect in open tabs.

## Not verified

- **Real high-DPI screens.** C02 fails under *emulated* DPR 2, where Chromium returns a 1x capture while reporting `devicePixelRatio` 2. A physical high-DPI display may behave correctly. Either way the code should measure the capture instead of trusting `devicePixelRatio`.
- **Real sites.** X, Reddit, Instagram and the rest need a logged-in browser. Not worth doing until the dead mouse trigger and the wrong-image defects are fixed, since most of the matrix would just re-report them.
- **The toolbar popup's buttons.** A popup cannot be opened by automation.
- **Strict video players.** `ffprobe` accepts the rebuilt file. QuickTime, phone galleries and editors are untested.
- **Chrome with "Ask where to save each file" turned on.**
