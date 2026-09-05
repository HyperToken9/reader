# 04 — How reliable are Web Speech API word-boundary events in 2026?

Type: research
Status: resolved

## Question

Sync accuracy depends entirely on `SpeechSynthesisUtterance`'s `onboundary` events firing, and firing with usable character offsets. This repo's own Reading Lenses README already records that some voices emit no boundary events at all, forcing an estimated-cadence fallback — establish how bad this really is before the sync design leans on it.

Start by reading `src/content.js` in this repo, which contains a working `speechSynthesis` + `onboundary` → word-mapping implementation with 220-word utterance chunking and a cadence fallback. Understand what it already solved, then research what remains:

- Current cross-browser and cross-platform state of `onboundary`: Chrome, Edge, Safari, Firefox, on macOS/Windows/Linux. Which voice families (local OS voices vs. remote/network voices) emit `word` boundary events, and which emit nothing? Is `charIndex` reliable, and is `charLength` populated?
- Chrome's long-utterance behaviour — the documented habit of silently dropping utterances past a length threshold. What is the actual limit, is it still present, and is ~220 words the right chunk size?
- What breaks at chunk boundaries: does splitting text into utterances audibly distort prosody, insert pauses, or misreport `charIndex` (per-utterance vs. absolute)?
- `pause()` / `resume()` / `cancel()` reliability, and behaviour on tab backgrounding — does synthesis keep running, and do boundary events keep arriving, when the tab isn't focused?
- Rate changes: does altering `rate` mid-utterance work, and does it corrupt boundary timing?
- If boundary events are absent for a voice, what is the best estimated-cadence model — and how badly does it drift over a paragraph?
- Is there a way to *detect* up front, before playback, whether a selected voice will emit boundary events, so the UI can steer the user to a working voice rather than degrading silently?

Report which voices/browsers to target for the prototype and what the fallback must cover.

## Answer

Full findings, with source-code citations: [`../research/04-web-speech-boundary-reliability.md`](../research/04-web-speech-boundary-reliability.md).

**Boundary support is a property of the OS backend, not the browser.** Read from engine source:
Windows (SAPI) and macOS (`AVSpeechSynthesizer`) deliver `word` boundaries with both `charIndex` and
`charLength`, in Chrome, Edge, Firefox and Safari. **Linux delivers none, in any browser, for any
voice** — Chromium's `tts_linux.cc` never declares or sends `TTS_EVENT_WORD`, and Firefox's
speech-dispatcher backend never calls `DispatchBoundary`. Chrome on Android: none. This repo's dev
machine is Linux, so **word sync cannot be evaluated here at all** — the spike must run on macOS or
Windows.

**Up-front detection: yes, and it is nearly free.** Chrome's "Google …" voices are supplied by a
component extension whose manifest declares `event_types: ["start","end","error"]` and
`"remote": true` for every voice — no `word`. Since `localService === !remote`, the test
`voice.localService === false` ⟹ **guaranteed zero boundary events**, statically, for the most common
failure case (and the same voices are the ones implicated in the ~15 s cut-off). Add a platform
knockout table (Linux / Chrome-Android / WebView), then a ~0.5 s `volume = 0` probe utterance for
whatever is left, cached per `voiceURI` in `localStorage`. Enough to label the voice picker
word-sync ✓ / sentence-only *before* playback. Note the app **loses** `chrome.tts`'s declarative
`eventTypes` — Web Speech does not expose it — which is why the probe is needed.

**220 words is the wrong chunk size**, on the wrong unit, and it cuts mid-sentence (prosody
stumble). Chunk on sentence boundaries to ~8-12 s of estimated audio; keep only two utterances in
flight. `charIndex` is per-utterance in every backend, so `content.js`'s `base + k` rebasing is
correct and transfers. `rate` cannot change mid-utterance in any implementation — a rate change must
`cancel()` and re-dispatch from the current word, which sentence-sized chunks make cheap.

**Fallback must cover five distinct failures**, not one: no boundaries at all; boundaries that freeze
mid-paragraph (open Firefox/macOS bug 1441503 — guard with non-monotonic-`charIndex` rejection);
`speak()` silently no-op'ing outside a user gesture on iOS (WebKit `return`s with no event); the
wedged-queue / ~15 s cut-off; and background-tab timer throttling to 1 Hz, which freezes the
estimator while synthesis and boundary events keep running. Biggest cheap win on the estimator:
**re-seed ms-per-character from each chunk's true `end` duration**, converting unbounded linear drift
into per-chunk-bounded drift. Even so — the estimate can carry the sentence band, **not** the word
cursor (a 15% rate error over 220 words is 20-30 words of drift). When boundaries are absent, turn
the word cursor **off** and say so, rather than drifting confidently.

**Verdict: native TTS is good enough for the prototype, conditionally**, on macOS/Windows with a
local voice. Don't reopen the cloud-TTS decision wholesale — but build the timing source as a named
seam now (`{wordIndex, atTime}`, with `BoundaryEventTiming` / `EstimatedCadenceTiming` /
stub `TimestampTiming`), so the switch stays cheap. Reopen early if the prototype must be developed
or demoed on Linux, or if the local-only voices prove unlistenable for textbook-length sessions —
note that in Edge on Windows the good-sounding "Online (Natural)" voices are exactly the remote ones
that emit nothing, a quality-vs-sync trade-off native TTS cannot escape.
