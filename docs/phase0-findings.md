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

## Status after Phase 2 (v1.2.0)

**59 checks: 51 pass, 8 known defects, 1 not observable under automation.**

Phase 2 moved the heavy work out of the page and the service worker into a hidden worker page, bundled the Mediabunny library to rebuild streams, and put the shared code in one module.

| Defect | Now | Checks |
| --- | --- | --- |
| Split-audio streams saved without sound | Merged into one file with sound | S04 |
| Joined files showed the wrong length in strict players; MPEG-TS saved as `.ts` | Written as a real MP4 with an index | S01, S09, S10 |
| A long video blocked every other grab and died with its tab | Runs in the worker page; other grabs proceed, navigation does not stop it, Escape cancels | S12, S13, S14 |
| Service worker fetched any URL and returned the bytes | No message returns fetched bytes; the read-back handler is gone | X02 |
| Defaults written to storage at install | Only changes are stored; old full copies are slimmed on update | P05, P06 |
| Files over 24 MB fell out of the folder | Bytes go to the worker page in chunks, at any size | G09, G10, G14, C01 |
| 1,500 lines injected into every frame | Screenshot and media-list code load on demand | F01 |
| Popup buttons did nothing on pages without the script | The script is loaded first; untouchable pages get a message | F01, F02 |
| A URL with `.m3u8` in its query string was recorded as a playlist | Judged by path, navigations ignored | S07 |
| Streams served only to their own site failed | A session rule adds the page as `Referer` | S11 |

Found while building it, and fixed: the library retries a failed request for ever by default, so a cancelled or dead stream never ended. It now gives up after three tries, and cancelling ends the job at once.

Not observable here, so unverified: the fresh copy of the content script injected into open tabs when the extension updates. Reloading an unpacked extension under automation removes it for good. What is checked is the two halves around it: injecting into a tab that already has a working copy does not double the grab (X03), and a copy that has lost the extension says to reload instead of half-working (X01).

## Status after Phase 3 (v1.3.0)

**76 checks: 72 pass, 4 known defects, 1 not observable under automation.**

Phase 3 was the interface: messages, the options page, the popup, and the media list.

| Problem | Now | Checks |
| --- | --- | --- |
| One message at a time, not clickable; a video's progress was overwritten by the next grab | Messages stack; a download keeps its own, with a progress bar and Cancel; saved files get "Show in folder" | G28, S15, S16 |
| With messages turned off there was no feedback at all | The setting silences confirmations only; failures and progress always show | G29 |
| A recorded shortcut looked applied but was not saved | Every change saves as it is made; there is no Save button | P02, P03, P10 |
| No warning for shortcuts Chrome uses, keeps, or that clash | Flagged as recorded | P08 |
| Mouse recorder could not be cancelled | Escape or clicking away cancels | P09 |
| Quality box shown for PNG | Shown only when the format has a quality | P07 |
| Reset wiped settings on one click | Takes a second press | P06 |
| Popup labels were cryptic; buttons did nothing on some pages | Says what each trigger does; says when it cannot run and disables its buttons; lists recent saves | P04, P11, P12 |
| Media list had no keyboard access, no backdrop, no focus trap | A modal dialog: arrows, Space, Ctrl+A, Tab kept inside, Escape closes | L06, L07, L08 |
| Media list rebuilt every card on each keystroke | Cards are made once and shown or hidden | L10 |
| Opening the list fetched full-size originals | Previews reuse what the page had loaded | L02 |
| Size filter was not applied again when sizes arrived | It is | L05 |
| A thumbnail and its linked full file were listed separately | One item, the full file | L04 |
| Bulk download counted files started, closed at once, and did not say what failed | Saves one at a time, stays open, names each failure and leaves it selected | L03, L11 |

Found while building it, and fixed: the typing guard looked at the retargeted event target, so typing in a text box inside a shadow root (web components) did not count as typing and a trigger could fire mid-word (G30).

## Status after Phase 4 (v1.4.0)

**83 checks: 83 pass, none known to fail, 1 not observable under automation.**

Phase 4 was the screenshot. The capture was rewritten rather than patched: the four tracked defects shared a cause, which was a single canvas sized once from numbers the browser reported.

| Defect | Now | Checks |
| --- | --- | --- |
| Fixed header and footer were missing from every screen | Top bars on the first screen, bottom bars on the last, neither repeated; bars that become fixed on scroll are caught as they appear | C03 |
| A page scrolling inside a container gave one screen | The scrolling box is found and unrolled; what is above stays on top and what is below follows it | C04, C14 |
| Switching tabs put the other tab in the image | The service worker checks the tab is in front before and after each shot; the capture pauses and resumes | C05 |
| The image was mostly blank when the reported pixel ratio and the shot disagreed | The scale is measured from the first shot | C02 |
| A long page could ask for about 1 GB of canvas | Images are at most 16,000px tall; a taller page is several images, each released as it is finished | C07 |
| A page that grows as it is scrolled was cut off at its starting height | Height is measured again after every screen, up to 100 screens | C08 |
| No way to cancel, and progress was a toolbar badge | A message with the screen count and a Cancel button; Escape cancels and restores the page | C10 |
| The open media list would have been photographed | Snaffle's own panels are hidden for each shot | - |
| A blind download in a format chosen beforehand | The screenshot opens on its own page; save as PNG, JPEG or PDF, or copy it, under a chosen name | C09, C12 |

Sideways-scrolling pages were already supported but untested, and now have a check (C13).

Not verified: a physical high-DPI display. C02 runs under an emulated ratio, which is the case that used to fail; the measuring fix covers both, but only the emulated one has been seen to work.

Nothing is left on the known-defect list. What remains is in the README under Tests: the things automation cannot reach.

## Status after Phase 5 (v1.4.1)

Phase 5 was housekeeping, plus a last read through the whole of the code.

- **Lint.** ESLint runs over every file (`npm run lint`). The first run found nothing wrong in the shipped code: the only reports were the deliberate `var X = X || ...` opening of the three files that can be loaded into a page twice, and two nits in the tests.
- **Continuous checks.** Lint, the offline checks, the browser checks and the release-zip check run on GitHub for every push to `main` and every pull request.
- **Demo.** `npm run demo` drives the real extension on a made-up page and turns Chromium's own screen recording into `docs/img/demo.gif`. Writing it turned up nothing in the extension; the one surprise was the script's own (it pointed at a picture below the fold, and Snaffle correctly said there was nothing under the pointer).

Found by reading, and fixed:

| Finding | Fix |
| --- | --- |
| A page that is very wide as well as tall could still ask for a canvas of about 1 GB: pieces were limited by height only | Pieces are limited by area too (64 million pixels), so a wide page gets shorter pieces |
| The three-minute limit on a paused capture started again each time the tab was looked at | One limit for the whole pause |
| The results page said "the screenshot never reached this page" after 60 seconds even if a very large one was still arriving | Only said when nothing at all has arrived |
| A status line left over from an earlier message could stay on the results page | Cleared when the screenshot is shown |
| Putting the page back after a capture could run twice if handing over to the results page failed | Runs once |

## Instagram video (v1.5.0)

Added after the plan was finished. How Instagram serves video was read off a real public reel before any code was written: nine files for one post (eight picture qualities and one of sound) on `cdninstagram.com`, fetched by the player in byte ranges through the address; all nine carrying the same asset id, their bitrate and the post's length; the address with the range removed returning the whole file with no cookies; and a cover picture lying exactly over the playing `<video>`, above it in paint order.

That last one explains what was reported: pointing at a playing video found the cover picture, not the video. Two further ways to reach "No image or video under the cursor" were closed at the same time, because the exact report could not be reproduced: a page-made `mouseout` that reads as the pointer leaving, and a video fed without any address.

| Check | What it proves |
| --- | --- |
| I01 | Pointing at a playing video under its cover saves one MP4 with picture and sound, named after the post |
| I02 | Each file is fetched whole, once, with its signed address byte for byte as the page wrote it; lower qualities are not fetched |
| I03 | A CDN that refuses whole files is read a range at a time, in order, to the end |
| I04 | With a later post loaded, the video is matched by its length and nothing is called a guess |
| I05 | With two posts of the same length, the most recent is saved and called a best guess |
| I06 | A video not yet started saves its cover picture |
| I07 | Pictures are named account-shortcode-number |
| I08 | A page-made "pointer left" does not stop a save |

The checks run against a copy of the site's behaviour served locally under Instagram's own host names. Beyond them, the merge was run once on that real reel's own files (1080x1920 VP9 with HE-AAC sound, 38 seconds): both fetched whole without cookies, merged, and decoded without error. Not tried: stories, live video, carousels of several videos, and anything behind a sign-in.

## Files saved under random names (v1.5.1)

Reported from use: Instagram videos were saved correctly but landed loose in Downloads as `84fa7945-....mp4`, while the message named the folder and file they should have had.

The cause was older and wider than Instagram. Since the file-extension correction was added, the extension has listened for Chrome's `onDeterminingFilename`. Once an extension does that, the name it passes to `downloads.download()` no longer counts on its own: Chrome uses what the listener suggests, and if it suggests nothing the file is named from its address. Direct downloads were registered with the listener and were fine. Everything saved from a copy held in memory was not, and its address is a random id: rebuilt streams (X as well as Instagram), screenshots saved either way, and pictures that exist only in the page.

It went unseen because the browser checks cannot see file names: the automation library takes over downloads and skips that hook, which is the limit recorded against G12 in Phase 0. The message, the bytes and the download record were all right; only the name on disk was wrong.

The fix registers every download with the listener before it starts, including those the results page starts itself. The larger change is a second harness, `test/browser/native.js`, which starts Chromium without the automation library's download handling and checks what lands on disk:

| Check | What it proves |
| --- | --- |
| N01 | A picture is saved under its own name in the Snaffle folder |
| N02 | A picture with no extension is named for what the server sent (closes G12) |
| N03 | A picture held only in the page is saved by name into the folder |
| N04 | A rebuilt stream is saved by name into the folder |
| N05 | An Instagram video is saved as account-shortcode-height.mp4 in the folder |
| N06 | A screenshot saved straight away is named after the page |
| N07 | A screenshot saved from its results page goes in the folder; a second file of the same name is reported under the numbered name Chrome gave it |
| N08 | Nothing is left loose in Downloads |

Run against 1.5.0 it failed N03, N04, N05, N07 and N08, reproducing the report. N07 also found that a message kept the asked-for name when Chrome had added " (1)" to it; messages now give the name the file really got.

Found by the browser checks, and fixed: the tab-switch check (C05) began failing about one run in two. The picture was always right; what went missing was the "Paused" message. When a page removes one of Snaffle's messages from the document, the message is made again the next time it is needed, but the old one's timer was left running and later dismissed its replacement. The tests remove messages between checks, which is how it showed. The timer is now cleared, and C05 fails if the message goes missing at any point while the tab is behind.

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
