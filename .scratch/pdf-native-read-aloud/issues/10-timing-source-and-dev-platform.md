# 10 — Where does the sync spike run, and does cloud TTS reopen now?

Type: grilling
Status: open

## Question

Surfaced by [[04]], and it invalidates an assumption the map was charted on.

Word-boundary support is a property of the **OS speech backend**, not the browser. Windows (SAPI) and macOS (`AVSpeechSynthesizer`) deliver `word` boundaries with `charIndex` and `charLength`. **Linux delivers none — in any browser, for any voice.** Chromium's `tts_linux.cc` never sends `TTS_EVENT_WORD`; Firefox's speech-dispatcher backend never calls `DispatchBoundary`.

This machine is Linux. So the word cursor — half the highlight design, and the specific thing that impressed the user about Nook — **cannot be built or evaluated here at all**. [[05]] cannot deliver its verdict on this machine. This is a hard blocker, not a quality concern.

There is a second, independent squeeze. Where boundaries *do* work, they work on **local** voices — and the local voices are the mediocre-sounding ones. In Edge on Windows the good "Online (Natural)" voices are exactly the remote ones that emit nothing. Native TTS cannot escape this: you pick voice quality or word sync, not both. For a textbook you intend to sit inside for hours, that trade lands harder than it would for a short article.

Decide:

- **Where the spike runs.** Is a macOS or Windows machine actually available to develop and demo on? If yes, the map proceeds as charted and this is merely an inconvenience. If no, native TTS cannot produce the prototype's headline feature and something has to give.
- **Whether the cloud-TTS deferral holds.** [[04]] recommends not reopening wholesale, but building the timing source as a named seam (`{wordIndex, atTime}`, with boundary-event / estimated-cadence / timestamp implementations) so switching stays cheap. Is that the right call, or does developing on Linux force cloud TTS — which returns word timestamps and is platform-independent — to become the prototype's primary path rather than its fallback?
- **The voice-quality trade**, on its own merits. Is a mediocre local voice tolerable for hours of textbook reading, given that the whole point is a pleasant sustained reading experience?
- **Degradation honesty.** [[04]] recommends that when boundaries are absent the word cursor be switched **off** and said so, rather than drifting confidently on an estimate — the sentence band can ride an estimate, the word cursor cannot. Confirm that is the desired behaviour.

Consult `grilling` and `domain-modeling` — this ticket also names the timing seam.

## Answer
