# 10 — Where does the sync spike run, and does cloud TTS reopen now?

Type: grilling
Status: resolved

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

## Answer

**Linux only, no Mac or Windows available. So the word cursor is dropped: the highlight is a sentence band alone.** Stated preference — something functional over something overbuilt.

**This is not a degraded fallback. It removes the problem.**

The word cursor was the only thing that needed `onboundary`. Sentence highlighting doesn't need boundary events at all — because [[04]] already recommends chunking utterances **on sentence boundaries**, and if one utterance is one sentence, then `onstart` and `onend` fire at exactly the moments the band must move. Those two events are universally supported, on every backend including Linux's speech-dispatcher. Sync becomes exact and event-driven, with **no estimation, no drift, and no cadence model** — the entire class of failure [[04]] catalogued simply doesn't arise.

Consequences, recorded so later sessions don't rebuild what was deliberately dropped:

- **Native TTS stands.** Cloud TTS stays deferred, and is now deferred on *quality* grounds only. Word timestamps were the thing that made it structurally attractive; nothing needs them any more.
- **The timing seam is cancelled.** [[04]]'s `{wordIndex, atTime}` abstraction behind `BoundaryEventTiming` / `EstimatedCadenceTiming` / `TimestampTiming` was premised on word-level timing being needed and uncertain. With sentence-only highlighting driven by `onstart`/`onend`, it is an abstraction over a decision that is no longer live. Don't build it.
- **The voice picker's sync-capability labelling is cancelled too** — [[04]]'s `localService === false` predictor and probe utterance existed to warn about missing boundary events. Nothing depends on them now. Voice choice reduces to whatever sounds least bad locally.
- **Estimated cadence is cancelled.** No drift model, no re-seeding from chunk duration.
- **What still transfers from [[04]]**: sentence-sized chunking (now load-bearing rather than a prosody nicety), keeping ~2 utterances in flight, the wedged-queue guard, and the fact that `rate` cannot change mid-utterance — a rate change must `cancel()` and re-dispatch from the current sentence, which sentence-sized chunks make cheap.
- **Watch for**: whether Linux speech-dispatcher voices are listenable enough for sustained textbook reading, and whether `onend` fires promptly enough that the band doesn't lag between sentences. Both are [[05]]'s to judge.

Revisit only if the word cursor is genuinely missed once the sentence band is being used in anger, or if a Mac/Windows machine enters the picture.

**Premise challenged, 2026-09-05 — see [[11]].** Everything above assumes TTS means the Web Speech API. A locally-executed neural model (Kokoro, Piper) is neither browser TTS nor cloud TTS, and it escapes the squeeze from both ends: better voices *and*, if it exposes alignments, word timing on Linux. That does not retract this answer — one sentence per utterance is still the right shape, and the cancellations above were right *for browser TTS*. But two of them become contingent rather than settled: the **word cursor** could return, and the **timing seam** [[04]] proposed would come back in a new form, because audio arriving as a buffer moves the band off an audio clock rather than off `onstart`/`onend`. [[11]] establishes the facts; the decision is a later ticket, and it should wait for [[05]]'s verdict on whether the cheap thing was already good enough.
