# 16 — Rebuild the reading loop on Kokoro, with a word cursor

Type: prototype
Status: open
Blocked by: —

## Question

[[14]] chose Kokoro by a hard switch — browser TTS is out, no fallback — and brought the word cursor back. Both change the core loop, so this rebuilds it. [[05]]'s prototype is the starting point; its geometry, spotlight and scheduling all survive.

**What changes.** `speechSynthesis.speak()` becomes synthesis to an audio buffer. Sentence advance stays an *event* — the audio element's `ended` maps one-to-one onto `speakOne()`'s `u.onend` in `prototype-05/main.js` — so [[10]]'s one-sentence-per-unit invariant is untouched and there is still no estimation and no drift. Word position becomes `requestAnimationFrame` reading the audio clock and binary-searching a span table computed **before the first sample plays**. [[11]] is explicit that this is a lookup, not a model: the cadence estimator, drift correction, re-seeding, watchdog and voice-capability labelling that [[04]] designed and [[10]] cancelled all stay cancelled.

**Known traps, all from [[11]] and [[14]] — do not rediscover them:**

- **Kokoro's timings are a second-class path.** The plain `kokoro-v1.0.onnx` emits audio only. Phoneme timings need the separate `-timestamped` re-export (fp16, 163 MiB, Apache-2.0). And `kokoro-onnx` **silently returns no timings**: `Kokoro._setup` tests for an output named `duration` while the export names it `durations`, so `has_timings` stays false with no error. [[11]] forced it true and got correct `Timing(phoneme, start, end)` immediately. This is now on the critical path, not a curiosity.
- **There is a word-level path worth checking first.** [[11]] noted the PyTorch `kokoro` package computes true word-level `start_ts`/`end_ts` in `join_timestamps`, rather than phonemes you must group yourself. It needs torch, which is heavy — but if it avoids the grouping problem below, price it before writing the grouper.
- **Grouping phonemes into words is imperfect and benignly so.** Split on the literal `' '` phoneme. Expect ~3.8% fewer groups than words, because espeak cliticises function words (`on the` → one group), so **~1 word in 25 highlights two words at once — never the wrong words**. Do not try to fix this with heuristics.
- **Map word spans onto [[02]]'s text-layer offsets by sequence alignment, not by zipping two lists.** [[11]] is emphatic: espeak *expands* numbers (`55` → "fifty five"), which adds groups where cliticisation removes them, and the two cut in opposite directions. Textbooks are full of numbers and [[11]]'s corpus deliberately avoided them, so this is measured-nowhere and load-bearing.
- **Rate control uses two mechanisms** ([[14]]). `<audio>.playbackRate` with `preservesPitch` for the live slider — instant, no re-synthesis, and it scales every span by one constant so the cursor stays correct. Kokoro's native `speed` for the baseline setting — better quality, pitch preserved, but it needs re-synthesis so changing it mid-read costs a gap. **Never** `AudioBufferSourceNode.playbackRate`, which resamples and shifts pitch. Note `speed` is not exactly a multiplier (1.5 → 1.59×), so read timings from the output rather than computing them from the parameter.
- **The app now owns the buffer queue.** `pump()` stops being "keep 2 utterances in flight" and becomes "keep N seconds of audio ahead", which needs a memory bound — do not buffer the page. Hide the ~2 s cold synthesis by synthesising sentence one during page render, not on the click.

**The design question this ticket must actually answer**, and the reason it is a prototype rather than a task: **what does a word cursor look like inside a spotlight?** [[05]] chose variant C — dim the page, punch the spoken sentence out of the mask. A cursor over a tint is a well-understood thing; a cursor inside a hole is not. Options to build and judge: a second, brighter punch-out for the current word; an underline riding within the lit band; a subtle weight or contrast shift. It must not fight the thing that made the spotlight win, which was calm.

Also judge: whether the voice holds up over a **chapter** rather than the paragraph [[14]] chose it on, and whether ~1-in-25 double-width highlighting is actually noticeable in use or invisible.

Keep it throwaway. The output is a working loop plus a judgement on the cursor.

## Answer
