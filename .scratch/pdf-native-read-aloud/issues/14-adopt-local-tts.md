# 14 — Does the app adopt local neural TTS, and does the word cursor come back?

Type: grilling
Status: open
Blocked by: 05

## Question

[[11]] settled the facts, and they came back better than the map assumed: Piper returns a per-phoneme partition of the waveform that **cannot drift**, at 22× real time and ~200 ms press-play latency, on this CPU. So the technical objection that killed word-level highlighting in [[10]] is gone. What remains is a decision, and it is a real one, because adoption is not free.

Decide:

- **Does browser TTS stay, get replaced, or become a fallback?** This is mostly [[05]]'s verdict to inform: if the speech-dispatcher voices turned out listenable and the sentence band already feels right, then this buys a nicer voice and a word cursor at the cost of a whole runtime. If they were unlistenable, the question answers itself.
- **Does the word cursor actually return?** [[10]] dropped it partly on technical grounds and partly because the human preferred something functional over something overbuilt. Only the technical half has changed. A cursor that is occasionally two words wide (3.8% of words, from espeak cliticising "on the" into one group) may or may not be worth it once the band exists and works.
- **Is GPL-3.0 acceptable?** [[11]] found Piper's maintained line is GPL-3.0 via espeak-ng — the MIT `rhasspy/piper` was archived in Oct 2025, and current write-ups still calling Piper MIT are stale. Kokoro is Apache-2.0 but 9× slower to first audio. Voices are licensed *individually*, so a shipped voice needs checking separately from the engine. If this is ever distributed, that choice propagates.
- **Is a Python sidecar acceptable**, given it also decides [[08]]? [[11]] found the install is two pip commands, which is cheaper than feared, but it is still a runtime and 60–330 MB of weights beside the app. Note [[12]] may make this moot by demanding a Python runtime anyway — if so, the marginal cost of local TTS drops to nearly nothing, and these two tickets should be decided together rather than in sequence.
- **Which model**, if adopted. Piper wins on every measured axis except licence and in-browser story; Kokoro wins on licence and is the only one with a documented WASM path. [[11]] lists what it could not measure: browser RTF, whether Piper runs in a browser at all, and long-run behaviour over a chapter rather than a sentence.

**Judge the voices before deciding anything else.** Samples are at `/tmp/claude-1000/tts/samples/` (`piper_lessac_medium.wav`, `kokoro_af_heart.wav`, `kokoro_bf_emma.wav`, `kokoro_am_michael.wav`). Sustained textbook reading is hours; a demo sentence flatters everything.

Consult `grilling` and `domain-modeling`.

## Answer
