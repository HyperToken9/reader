# Map: PDF-native read-aloud

## Destination

A working prototype: a local web app that renders a textbook PDF at native fidelity (PDF.js canvas, zero reflow — diagrams, equations and multi-column layout exactly as authored) and overlays synchronized read-aloud — browser TTS speaking body prose in correct reading order, tracked by a sentence band drawn over the real page.

Reached when that prototype exists and has been driven against real textbook PDFs, well enough to judge whether the audio+highlight-over-native-render experience actually works.

## Notes

**Domain**: PDF rendering and text-layer geometry, document layout analysis (reading order, region classification), speech synthesis and utterance scheduling, overlay UI.

**Corpus**: `sample_books/` in the repo root (gitignored). Contents and their characterisation are recorded in [01](issues/01-test-pdf-corpus.md).

**This map carries execution.** The destination is a built artifact, not a document — prototype tickets produce running code, not proposals. Everything else on the route is still a decision.

**Sibling project in this repo**: `Reading Lenses` (`/src`, `manifest.json`) is an existing MV3 Chrome extension applying eight reading aids in-place to web pages. It is *not* this effort, but `src/content.js` already contains a working `speechSynthesis` + `onboundary` → word-mapping read-aloud implementation, including 220-word utterance chunking to dodge Chrome's long-utterance drop, and an estimated-cadence fallback for voices that emit no boundary events. Read it before re-deriving any of that — but note [04](issues/04-web-speech-boundary-reliability.md) superseded its 220-word chunking (wrong unit, cuts mid-sentence) and [10](issues/10-timing-source-and-dev-platform.md) made its boundary/cadence machinery unnecessary here. Its README documents the known limits, including that Chrome blocks extensions on the built-in PDF viewer — part of why this effort is an app, not an extension.

**Skills**: consult `grilling` and `domain-modeling` for decision tickets; `research` for AFK research; `prototype` for build spikes.

**Settled before charting** (context for every session):
- Visual surface must stay the real PDF. Background text/geometry extraction is fully permitted — the constraint is on the *view*, not on internal parsing.
- Assume an embedded text layer (born-digital or pre-OCR'd). No OCR.
- TTS is browser-native (Web Speech API). Cloud TTS is deferred on voice-quality grounds only; nothing structural needs it. Development and use are **Linux-only**.
- Highlight is a **sentence band alone — no word cursor** ([10](issues/10-timing-source-and-dev-platform.md)). Linux emits no word-boundary events, and rather than fake them, the word cursor was dropped. One sentence per utterance means `onstart`/`onend` drive the band exactly, with no estimation and no drift.
- Audio skips page headers/footers silently; equations, figures and footnotes get a brief spoken placeholder ("equation", "figure four") then are stepped over, since your eyes have the real thing on screen.
- Prototype front door is a single drag-dropped PDF. No library, no persistence.

## Decisions so far

<!-- one line per closed ticket: gist + link -->

- [02 — PDF.js text-layer geometry](issues/02-pdfjs-text-layer-geometry.md): per-word boxes are *not* in the API and are unavoidably approximate — but the route works: render the stock `TextLayer`, segment the concatenated page string with `Intl.Segmenter`, map offsets back to divs, and take `range.getClientRects()`. Highlights go in a separate normalised-fraction SVG overlay, so zoom costs nothing. Pin an exact `pdfjs-dist`; the API moved three times since 2024.

- [04 — Web Speech boundary reliability](issues/04-web-speech-boundary-reliability.md): boundary support belongs to the OS backend, not the browser — Windows and macOS deliver `word` events with `charIndex`+`charLength`; **Linux delivers none, ever**, which blocks the sync spike on this machine ([10](issues/10-timing-source-and-dev-platform.md)). `voice.localService === false` statically predicts zero boundaries, so the voice picker can label sync support before playback. Chunk on sentences (~8–12 s), not 220 words; when boundaries are absent, turn the word cursor off rather than drift.

- [03 — Reading-order algorithms](issues/03-reading-order-algorithms.md): **the crux risk is surmountable.** No JS library exists, so we write it — ~600–900 lines: kill running heads by cross-page repetition, cluster lines, split **bands before columns** (the fix for XY-cut's worst failure), find gutters by x-projection, read columns L→R. Tagged PDFs give a free fast path via MCID join but only ~12.6% are tagged, so use it only where it agrees with geometry. Ordering is easy; **classification is hard** — sidebars and boxed panels are geometrically identical to a narrow column. Error is cheap, though, because the reader sees the real page: the sentence band *is* the recovery UI.

- [10 — Timing source and dev platform](issues/10-timing-source-and-dev-platform.md): **the word cursor is dropped; the highlight is a sentence band alone.** Linux-only development, and Linux emits no word-boundary events for any voice. But one-sentence-per-utterance makes `onstart`/`onend` drive the band exactly — no estimation, no drift, no cadence model. Native TTS stands, and [04](issues/04-web-speech-boundary-reliability.md)'s timing seam, voice-capability probe and drift model are all **cancelled as overbuilding**.

## Not yet specified

- **Graduating the prototype into a v1 app** — persistence, a PDF library, remembered reading position, settings surface. Hangs on the prototype proving the core experience first.
- **Voice quality upgrade path** — if Linux speech-dispatcher voices prove too poor to sit with for hours, what a cloud-TTS tier (per-character cost, pre-synthesis, offline story) would look like. Deferred on quality grounds alone; [10](issues/10-timing-source-and-dev-platform.md) removed the structural reason to want it.
- **Word-level highlighting** — dropped by [10](issues/10-timing-source-and-dev-platform.md) because Linux emits no boundary events. Returns only if the sentence band proves insufficient in real use, or if a macOS/Windows machine enters the picture.
- **Scanned / image-only PDFs** — OCR to obtain a text layer at all. Assumed away for this effort; a real concern for textbooks sourced as scans.
- **The other Reading Lenses techniques over a PDF surface** — spacing, typeface swap, fixation anchoring, chromatic line guidance, masking, pacer, RSVP. To be revisited per-technique on use-case and importance, and harder here than in HTML since the page is rendered pixels, not reflowable text.
- **Browser-extension form factor** — overlaying this on PDFs already open in a browser. Blocked in Chrome's built-in viewer today; would need its own viewer. Future form factor, not this effort.
- **Real equation speech** — MathML/LaTeX-aware reading instead of announce-and-skip.

## Out of scope

- **Building and shipping the production v1 app.** The destination is a prototype that answers whether the experience works. Productionising it is a separate effort against a redrawn destination.
- **OCR / scanned-page support.** Ruled out by the embedded-text-layer assumption. Listed above as fog only insofar as a future effort may need it; this map will not chart it.
