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

## Progress

**Settled (2026-09-05):** the human accepts an unnatural/robotic local voice for now, deferring voice quality. So the **voice-quality trade is resolved** — pick sync over naturalness — and the cloud-TTS deferral holds on quality grounds.

**Still open, and still blocking:** this does *not* clear the platform blocker, and the distinction matters. Boundary support is not a property of how natural a voice sounds — it is a property of the **OS speech backend**. On macOS and Windows the local (robotic) voices are exactly the ones that emit boundaries, so accepting a robotic voice fully solves it *there*. On **Linux no voice emits `word` events at all**: `tts_linux.cc` never sends `TTS_EVENT_WORD`, so there is no voice — robotic, natural, local or remote — that can be chosen to fix this. Accepting a worse voice cannot unblock a machine that emits no events.

So the remaining question narrows to one thing: **is a macOS or Windows machine available to build and demo [[05]] on?**

- If **yes** — everything is settled, native TTS stands, cloud TTS stays deferred, and [[05]] unblocks on that machine.
- If **no** — cloud TTS becomes the prototype's primary timing source by necessity rather than preference, since word timestamps arrive with the audio and are platform-independent.

Either way, build the timing seam [[04]] recommends (`{wordIndex, atTime}` behind `BoundaryEventTiming` / `EstimatedCadenceTiming` / `TimestampTiming`) so the answer stays cheap to change.

## Answer
