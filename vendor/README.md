# Bundled third-party code

| File | What | Version | Licence |
| --- | --- | --- | --- |
| `mediabunny.min.mjs` | [Mediabunny](https://mediabunny.dev) media toolkit, browser ES module bundle | 1.65.2 | MPL-2.0, text in `mediabunny.LICENSE.txt` |

The file is the unmodified `dist/bundles/mediabunny.min.mjs` from the `mediabunny` npm package. To update it, install the new version and copy that file and its `LICENSE` here:

```
npm pack mediabunny@<version>
```

It is loaded only by `offscreen.js`, the hidden worker page that rebuilds streamed video.
