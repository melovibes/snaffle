# Changelog

## 1.4.1

- Screenshots of pages that are very wide as well as tall are split into shorter pieces, so they no longer need an enormous canvas.
- A paused capture gives up after three minutes in all, not three minutes since the tab was last looked at.
- The results page no longer reports a large screenshot as lost while it is still arriving.
- A message that a page had removed could be dismissed early when it was shown again. Fixed.
- Development: ESLint, tests run on GitHub for every push, and a recorded demo in the README.

## 1.4.0

- The full-page screenshot was rewritten. Fixed headers and footers appear once each; pages that scroll inside a box are captured in full; switching tabs pauses the capture; pages that grow as they scroll are followed; very tall pages become several images; the pixel ratio is measured rather than assumed.
- A screenshot opens on a page of its own, to be saved as PNG, JPEG or PDF, or copied. Saving straight away is still an option.
- A capture can be cancelled, from its message or with Escape.

## 1.3.1

The first packaged release.

- Saves the image or video under the pointer by key or click, choosing the largest version the page offers and falling back when a site refuses.
- Rebuilds streamed (HLS) video into one MP4 with its sound, using the bundled Mediabunny library.
- Full-page screenshots and a list of all the media on a page for bulk download.
- Options page, popup, messages with progress and cancel, keyboard and screen-reader support.
