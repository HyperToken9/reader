# Blitz

Read a textbook aloud **on the actual page**. For a PDF, that's the real
render — figures, equations, columns, all of it — with the reading experience
as an overlay on top: a band over the sentence being spoken and a cursor on
the word. For an EPUB, "the actual page" means its own reflowable HTML+CSS,
rendered by the browser exactly as the book's author wrote it, with the same
overlay on top of *that*.

That constraint is the whole point. Apps that read books aloud generally
extract the text into their own environment first, which for a PDF is exactly
where diagrams and equations fall apart. Nothing here re-extracts a PDF's
text or re-flows its layout. An EPUB is a different case — reflowable HTML
*is* its native form, so rendering its own markup in a browser is already
staying true to the original; there's no separate extraction step to avoid.

Planning and the prototypes that led to this live in
[`.scratch/pdf-native-read-aloud/`](../.scratch/pdf-native-read-aloud/).

## Running it

```sh
npm install             # also fetches libespeak-ng into vendor/ (see "Speech engine")
npm run dev             # Vite + Electron with hot reload
```

### Reading gestures

| Gesture | What it does |
| --- | --- |
| Ctrl + scroll wheel | Zoom, anchored on the pointer |
| Ctrl + `+` / `-` / `0` | Zoom in, out, back to 1.2× |
| Zoom slider | The same zoom, anchored on the middle of the view |

Zoom is a single CSS variable on the page container, so a wheel gesture resizes
the whole document with one style write and the already-drawn bitmaps stretch
to match; the pages re-rasterise once the gesture stops. An EPUB has no bitmap
to stretch — zoom there is a font-size variable inside each chapter's own
iframe, reflowed on every tick rather than debounced, since reflowing one
chapter (an isolated document, unlike the whole PDF) is cheap on its own.

The home page takes the same Ctrl + wheel and Ctrl + `+` / `-` / `0`, but has
a zoom of its own: CSS `zoom` on `.homeInner` (`renderer/home.js`), remembered
in `localStorage` as `blitz.homeZoom`. Neither zoom is the window's zoom, so
they never compound, and each view's keys act only while that view is
showing.

## EPUB

Opening a `.epub` (drag-and-drop or the file picker; sniffed by extension,
falling back to the file's magic bytes) routes to a separate renderer path in
[`renderer/epub.js`](renderer/epub.js) and the `docKind === "epub"` branches
in `renderer/main.js`, not a PDF.js document. Each spine chapter becomes one
sandboxed `<iframe sandbox="allow-same-origin">` — no `allow-scripts`, so the
book's own markup (and any script it ships) never runs, but the parent can
still read `contentDocument` synchronously to find real text nodes and build
real Ranges against them, the same role PDF.js's text layer plays for a PDF
page. Every resource a chapter references (images, stylesheets, fonts, and
the `url()`s inside them) is resolved to a `blob:` URL up front by
[`fflate`](https://github.com/101arrowz/fflate) unzipping the archive, so a
chapter renders with no `<base>` and no network reachability at all.

The same scroll-priority render queue, LRU canvas/iframe eviction, and
geometry index that make a 600-page PDF scroll smoothly (see "Reading
gestures" above) apply unchanged to chapters — `PageEntry` duck-types the
same shape either way, so that whole pipeline doesn't know which format it's
looking at. What's format-specific: a chapter's sentence *rects* are computed
lazily, the first time one is painted or hit-tested, rather than eagerly at
render time the way a PDF page's dozen sentences are — a chapter can hold
hundreds, and forcing `Range().getClientRects()` for all of them the moment
it scrolls into view would reintroduce the exact scroll stall fixed earlier
for PDF, just from a new cause. Hovering to preview a sentence likewise
doesn't test every sentence's rects on every mousemove; it asks the browser
directly which text offset sits under the pointer
(`caretRangeFromPoint`/`caretPositionFromPoint`) and binary-searches sentence
boundaries from there.

Other commands:

| Command | What it does |
| --- | --- |
| `npm run build` | Builds the renderer into `dist/renderer/` |
| `npm start` | Builds, then runs the app the way a packaged copy runs |
| `npm run smoke` | Launches the app and asserts it came up wired (see below) |
| `npm run dist` | Packages an AppImage and a .deb via electron-builder |
| `npm run speech:parity` | Checks the speech engine's word spans against the old Python engine's |
| `npm run speech:bench` | Warm real-time factor of the speech engine |

## Why Electron

The premise is a real PDF render with an overlay locked to it, and PDF.js in a
real browser engine is what makes that true. Electron is the browser engine we
already validated the whole highlight pipeline against, so shipping it means
shipping what we tested.

It also gives the two models a native Node process to live in. That is not a
detail: running the layout model in the *page* under onnxruntime-web cost 86s
on the first page and pulled 213 MB into the tab. In the main process under
onnxruntime-node it is ~1.4s a page, off the thread that paints the UI.

## How it fits together

```
electron/main.js        window, IPC handlers, owns both models
        preload.cjs     the only bridge to the renderer
        layout.js       PP-DocLayoutV2 via onnxruntime-node 1.29, in process
        tts.js          owns the speech engine; the renderer never sees how it works
        speech/         Kokoro in Node, in its own utilityProcess (see "Speech engine")
renderer/               PDF.js render, sentence geometry, highlight overlay, audio
        epub.js         EPUB parsing: unzip, resolve resources to blob: URLs, per spine chapter
```

Context isolation is on and `nodeIntegration` is off. The renderer gets
`window.blitz.{synthesize, voices, ttsStatus, prepareSpeech, onSpeechProgress,
analyzeLayout, layoutReady, ...}` and no other reach into Node.

## Speech engine

Speech is Kokoro, ported to Node (`electron/speech/`) from the Python engine
the app used to spawn. Nobody installs anything for it:

- **The weights download on the first press of play**, never at launch. The
  reading chrome shows an inline progress bar, the ~190 MB land once in
  `<userData>/speech/` (`~/.config/Blitz/speech` for the packaged app), and
  then it plays. Both files come from kokoro-onnx's GitHub releases, pinned by
  URL and sha256 in `electron/speech/model.js`. A download resumes where it
  stopped; a damaged one fails its checksum and is fetched again; a file that
  was truncated or written to after it was checked is fetched again rather
  than loaded. `BLITZ_SPEECH_DIR` points the app at another directory.
- **Phonemes come from libespeak-ng 1.52**, the build kokoro-onnx itself uses,
  called through koffi. `npm install` (and `npm run dist`) fetch it, with its
  English data only (~1.5 MB), from the espeakng-loader wheel into `vendor/`
  (`scripts/fetch-espeak.mjs`, pinned by sha256). It is GPL-3.0; the notice
  ships in `resources/licenses/`. Not the npm `phonemizer` package: its WASM
  espeak pronounces differently and matched the Python path on only 73% of
  sentences.
- **It runs in its own `utilityProcess`** on onnxruntime-node **1.23.2**, under
  the `ort-speech` npm alias, while the layout model stays on 1.29 in the main
  process. Two onnxruntime versions cannot share a process, 1.29 is ~20%
  slower on this graph and shifts timings, and a separate process keeps
  synthesis off the main process and the audio thread.

Two things are easy to get wrong:

- **The model must have a `duration` output.** Without it there are no
  phoneme timings, so the word cursor never moves — silently, with audio that
  sounds fine. The pinned `model-files-v1.1/kokoro-v1.0.fp16.onnx` has it (the
  original v1.0 release did not, which is why the app once exported its own),
  and the engine refuses to load a model without it.
- **Punctuation-only text has no phonemes.** Kokoro raises `Nothing to
  synthesize` on a "sentence" that is just `-` or `2.`. Hyphens *inside* words
  are fine (`well-known`, `Michaelis–Menten` and `self-organising` all
  synthesize); the failure is only ever a fragment with no letters in it, which
  the renderer filters before it asks for audio.

`npm run speech:parity` runs a 206-sentence corpus through the engine and
compares the word spans with what the Python engine produced
(`scripts/speech-parity/`). It compares spans, not audio: the model graph has
random ops, so audio is not bit-identical even Python against Python.

`tts.js` is the seam: the renderer only ever calls `synthesize`/`voices` and
gets back `{sr, audio_b64, words, spans}`.

## Testing

`npm run smoke` launches the real app under Electron, drives it over CDP, and
asserts the window came up wired: speech status answering, voice list
populated, viewer mounted, layout model answering, no console errors.
`BLITZ_SMOKE_SPEECH=1` also prepares speech (downloading the weights if they
are not there) and speaks a sentence through the engine's process. It then
*opens a PDF* and asserts page 1 finishes rendering with words in its text
layer. That second half exists because the first half once passed on a build
that could not open a single document: the window was healthy in every way the
test could see, and every file silently did nothing.

The fixture is a minimal PDF written by hand in `scripts/fixture-pdf.mjs`, so
the test needs nothing from `sample_books/`, which is gitignored. `npm run
smoke` does not yet open an EPUB — there's no hand-written EPUB fixture the
way there is a PDF one — so EPUB changes still need manual verification
against a real book from `sample_books/` until one exists.

`scripts/scroll-check.mjs <binary|.> <some.pdf>` is the other harness: it flings
a real several-hundred-page book, measures the frame gaps while it moves,
checks the page it lands on renders, then ctrl+wheel zooms and checks the point
under the pointer stayed under the pointer and the text and overlay layers
still cover the page. It is not part of `npm run smoke` because it needs a real
textbook, and those are gitignored. Run it when touching the scroll or zoom
path.

`npm run smoke:dist` runs the same checks against `release/linux-unpacked/`;
`BLITZ_SMOKE_BIN=release/Blitz-0.1.0.AppImage node scripts/smoke.mjs` runs them
against the AppImage. Run at least one of those before calling a build good —
the packaged app has now diverged from the source tree twice.

**Electron cannot be downgraded freely.** PDF.js 6 calls
`Uint8Array.prototype.toHex`, which needs Chromium 140+; on Electron 33
(Chromium 130) `getDocument()` rejected before parsing anything. Moving
backwards here breaks document loading silently, not loudly.

## Branches

| Branch | Holds |
| --- | --- |
| `main` | Released. Only ever fast-forwarded from `staging`. |
| `staging` | Release candidate: what is being verified by hand before it ships. |
| `dev` | Integration. Feature branches merge here. |
| `prototype/*` | Throwaway spikes that answered a question. Never merged; kept as primary sources. |

Work goes `feature → dev → staging → main`.
