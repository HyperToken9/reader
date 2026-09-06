# 08 — What platform does the real app ship on?

Type: grilling
Status: closed
Blocked by: 06

## Question

Deliberately deferred at charting time, and blocked on both spikes — because how heavily the prototype leans on PDF.js internals, browser text-layer geometry and Web Speech API behaviour *is* the evidence this decision needs. Deciding it before the spikes would be guessing.

The candidates, with the concern each carries:

- **Web app / PWA** — the prototype grows up in place, no port. Best PDF.js and text-layer story by far. Weakest offline, install and mobile-reading story.
- **Electron (or Tauri)** — same web core, real desktop app, filesystem access, offline. Tauri is far lighter than Electron and worth considering alongside it. Neither gets you to mobile.
- **Flutter** — the only candidate that credibly reaches mobile *and* desktop from one codebase. But its PDF tooling is much rougher: getting per-word bounding boxes out of a Flutter PDF widget is a genuinely open question, and if the answer is bad, everything the spikes proved has to be rebuilt on worse foundations.
- **Native mobile** — best reading ergonomics on a tablet, which is arguably where textbook reading actually happens. Highest cost, one platform at a time.
- **Capacitor-wrapped web** — keeps the web core, reaches mobile app stores. Compromise on both ends.

[[10]] narrowed this: development and use are Linux-only, which removes macOS/Windows-first options from serious contention and weakens the mobile-reach argument that was Flutter's main draw. It also means any candidate must carry a TTS story that works without word-boundary events.

**Both have now reported, and they point the same way — but less brutally than feared.** [[11]]: local TTS is two pip installs, 60–330 MiB of weights, Python today, and Piper has no verified browser path (espeak-ng is the blocker) while Kokoro's WASM path is the slow model. [[12]]: layout analysis is **already JS** — `onnxruntime-node`, 203 MiB, ~731 ms/page — so it needs Node, not Python, and an `onnxruntime-web` path exists but was **not measured**. So the honest position is: Electron/Tauri clears both cleanly; a pure browser app is not ruled out but rests on two unmeasured WASM numbers; Python is required only if local TTS is adopted ([[14]]).

One constraint to price before anything else: [[12]] found layout analysis must run **lazily, a page or two ahead of the speech cursor**, never over the whole document. That is exactly read-aloud's access pattern, so it costs nothing here — but it has to be designed in, not bolted on.

**Original framing, still relevant:** A local neural TTS model and a local document-layout model are independent ideas that make the same architectural demand: **a model runtime alongside the app** — very likely Python, possibly ONNX in Node, unlikely to be a browser tab. If both land, the "web app / PWA" candidate is effectively out, mobile-first is out, and the field narrows to Tauri or Electron with a sidecar process, or a local server with a browser front end. That would also make the porting-cost argument moot: whatever ships has to carry model weights and a runtime, so the PDF.js-and-Web-Speech portability that motivated this ticket stops being the deciding factor.

Note the reverse case too. If [[05]]'s verdict is that browser TTS and the sentence band are already good enough, and [[12]] finds the layout models too heavy for the gain, then nothing forces a local runtime and the web-app candidate is back at full strength. So this ticket really turns on how much machinery the experience needs, which is what those two research tickets and [[05]]'s verdict jointly establish.

Decide against real weight: where does textbook reading actually happen for this user — desk, laptop, tablet? Does that override the porting cost? And how much of the spike work survives each choice?

Consult `grilling` and `domain-modeling`.

## Answer

**Electron, packaged as an AppImage and a .deb. Downloadable desktop app; the browser is out.**

The human decided the *form*: "something that you can download and use." The runtime choice was delegated, and every piece of evidence this ticket was blocked on points the same way.

**Why not the browser.** [[12]]'s unmeasured `onnxruntime-web` path got measured, in [[06]]'s integration: the layout model in the page cost **86s on the first page** — a 213 MB model pulled into the tab, every session — and ~7s per page after, all on the thread painting the UI. With layout on, a trivial scroll loop could not complete in 180 seconds. That is what the reported "crashing instantaneously" actually was. The same model under `onnxruntime-node` in a process that is not the one painting: **~1.4s a page**. The browser candidate did not survive contact.

**Why Electron and not Tauri.** Tauri is genuinely lighter, and on a blank slate it would be a real contest. It is not a blank slate: the entire highlight pipeline — `TextLayer`, `Intl.Segmenter` offsets, `Range.getClientRects()` normalised into an SVG overlay — was built and judged against Chromium. Tauri renders in the system webview, which on Linux is WebKitGTK. Every geometry number this map has recorded would have to be re-verified there, and the thing being verified is sub-pixel highlight alignment. Electron ships the engine the work was validated on. The cost is a ~350 MB AppImage, and for a single-user desktop reader that is the cheaper side of the trade.

**Flutter, native mobile and Capacitor are out**, and not narrowly. [[02]] established that per-word boxes come from browser text-layer geometry that has no Flutter equivalent; rebuilding on worse foundations would discard [[05]], [[06]] and [[16]] together. [[10]]'s Linux-only constraint had already removed the mobile-reach argument that was Flutter's only real draw.

**What this costs.** Python is still required, because [[14]] adopted Kokoro and its only working implementation is `kokoro-onnx`. A downloadable app that asks the user to install Python is not finished, so `app/electron/tts.js` is deliberately a seam: the renderer only ever calls `synthesize`/`voices` over IPC and cannot see how speech is produced. Replacing the child process with an in-process `onnxruntime-node` engine changes that one file. Graduated to its own ticket.

**Built and verified.** `app/` on `dev`. Both models run in the Electron main process; the renderer reaches them over IPC with context isolation on and `nodeIntegration` off, so nothing listens on a port a browser could find. `npm run dist` produces `Blitz-0.1.0.AppImage` and `blitz_0.1.0_amd64.deb`. The AppImage was launched and driven, not assumed: speech engine ready, 54 voices, synthesize round trip returning words, spans and audio.
