# 14 — Does the app adopt local neural TTS, and does the word cursor come back?

Type: grilling
Status: resolved
Blocked by: —

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

## Progress

**Two of the five decided (2026-09-05); the voice choice is with the human.**

- **The word cursor comes back.** [[10]] dropped it because Linux emits no boundary events; [[11]] removed that objection with alignment that partitions the waveform and cannot drift. The human confirmed they want it — it was the thing that impressed them about Nook in the first place. Two constraints on the build: about **1 word in 25 will highlight two words at once** (espeak cliticises `on the` into one group), and it must be designed **not to fight the spotlight**, which [[05]] chose as the band style. A moving cursor inside a punched-out mask is a different design problem from a cursor over a tint — treat that as part of the work, not a detail.
- **GPL-3.0 does not bind.** Personal use only for now, and GPL obligations attach on distribution. So Piper is available and the engine choice is on quality and speed alone. **Revisit this the moment distribution is contemplated** — the licence would then reach the whole app, and switching engines after the timing code is written is more expensive than it looks.

**New measurement, refining [[11]].** [[11]] benchmarked `medium` voices only (RTF 0.045). The `high` tier is **4–7× more expensive**: `en_US-ryan-high` RTF 0.177, `en_GB-cori-high` 0.182, `en_US-lessac-high` 0.343, against `en_US-hfc_female-medium` at 0.050. All still faster than real time and all still pipeline fine, but press-play latency goes from ~200 ms to roughly a second. So the quality/latency trade [[11]] found *between engines* also exists *within Piper*, and it is the same shape.

**Still open: which voice.** Samples generated at `/tmp/claude-1000/tts/samples2/` from the same paragraph, plus Kokoro's in `samples/`. The human's stated concern is expressiveness — [[05]] recorded the voice as "bearable but could be better, could be more expressive". Piper's ceiling is clear-and-neutral; Kokoro is the more expressive engine at ~2 s of dead air on play (hideable by synthesising sentence one during page render). That is the actual trade to settle.

## Answer

**Hard switch to Kokoro. Browser TTS is out of the product — no fallback, no dual path.** Decided on the human's ears, 2026-09-05, after a like-for-like comparison of eight Piper voices and seven Kokoro voices reading the same paragraph.

**Voice quality was always the deciding axis, and it went the opposite way to every measured one.** [[11]] concluded "Piper wins on every measured axis except licence and in-browser story". That stands as a measurement and loses as a decision, because the thing being optimised is an hour of listening, and no benchmark in [[11]] measured that. Worth remembering the next time a ticket reports a clean technical winner.

**Two findings that made the choice cheaper than it looked:**

- **Piper's `high` tier is not more expressive — it is less artefacted.** The quality tier is sample rate and model size; it does not change delivery. The human disliked `ryan-high` and `lessac-high` while preferring `hfc_female-medium` and `cori-high`, which is exactly what that predicts: tier is orthogonal to whether you like the voice. Do not reach for a higher tier to fix expressiveness.
- **The speed gap [[11]] reported is an artefact of comparing tiers.** [[11]] measured Piper `medium` (RTF 0.045) against Kokoro (0.41) and framed it as ~9×. Measured on identical text here: Kokoro is **RTF ~0.35**, against `lessac-high` 0.343 and `cori-high` 0.182. At the quality level actually wanted, Kokoro is level with Piper's high tier and about 2× the best-liked Piper voice. The "~2 s of dead air" objection largely evaporates, and what remains is hidden by synthesising sentence one during page render.

**Kokoro also has more room**: 54 voices against Piper's 38, 11 of them English female — the register the human preferred. And it is **Apache-2.0 on both code and weights**, so the licence question this ticket raised is now moot rather than merely dormant; if distribution ever happens, nothing has to change.

**Rate control: use both mechanisms, for different jobs.** Measured here: Kokoro's native `speed` scales the duration predictor rather than resampling, so **pitch is preserved** — `speed=1.5` yields 1.59× shorter audio, `1.25` yields 1.17× (roughly proportional, not exactly, so don't compute timings from the parameter — read them from the output). RTF stays ~0.35 at every speed. But native speed requires re-synthesis, so changing it mid-read discards the buffer and costs a gap. Therefore: **`<audio>.playbackRate` with `preservesPitch` for the live control** (instant, free, and it scales every word-timing span by a single constant, so the cursor stays correct), and **native `speed` for the baseline setting**. Do not use `AudioBufferSourceNode.playbackRate`, which resamples and shifts pitch.

**The two costs this incurs, stated plainly.** First, [[11]] found Kokoro's timings are a *second-class path*: the plain ONNX emits audio only, phoneme timings need the separate `-timestamped` re-export (fp16, 163 MiB), and `kokoro-onnx` silently fails to detect it because `_setup` checks for an output named `duration` while the export names it `durations`. Since this ticket also brought the word cursor back, that bug is now on the critical path rather than a curiosity. Second, Kokoro is Python today; [[11]] noted it has the only *documented* in-browser story, which is now the relevant one for [[08]] rather than an aside.

**What this changes elsewhere.** The map's founding "TTS is browser-native" constraint is retired. [[08]] narrows sharply and should now price a Kokoro-in-the-browser path specifically. [[16]] is the build.
