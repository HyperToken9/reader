# 11 — Can a local neural TTS model replace the browser's voices, and what timing does it give back?

Type: research
Status: open
Blocked by: —

## Question

[[10]] dropped the word cursor and deferred voice quality, and both of those decisions rest on the same premise: **that TTS means the Web Speech API**. On Linux that API delivers no word-boundary events for any voice, and only speech-dispatcher's local voices, which are robotic. A locally-executed neural model breaks that premise from both ends at once — better voices *and* its own timing data — so this is worth establishing before [[05]]'s voice verdict is treated as final.

Named by the human: **Kokoro** (Kokoro-82M, ~82M params, Apache-2.0, claimed to run on CPU, ONNX builds exist) and "**omnitts**", which I can't place with confidence — find out what they meant, or what the nearest real thing is. Other candidates worth pricing at the same time: **Piper** (fast, small, phoneme-timed, built for exactly this), **MeloTTS**, **F5-TTS**, **XTTS-v2**, **Chatterbox**, and whatever has landed since. This area moves fast; prefer current model cards and repos over recollection.

For each serious candidate, establish:

- **Does it return alignment data**, and at what granularity — word, phoneme, or nothing? This is the load-bearing question, because it is the only thing that would reopen the word cursor [[10]] dropped. Piper emits phoneme timings; Kokoro goes through a phonemiser (misaki) that may or may not surface them. Note whether alignment comes free with synthesis or needs a separate forced-alignment pass.
- **Latency to first audio**, on CPU, on this machine, for one sentence. Reading aloud must start when you press play, not after a model warms up. Establish both cold-start and steady-state, and whether synthesis can be pipelined a sentence or two ahead the way [[04]] has utterances queued now.
- **Real-time factor** — can it synthesise faster than it speaks, on CPU alone? If it needs a GPU, say what happens without one.
- **How it is actually invoked from an app.** Python process? ONNX Runtime via `onnxruntime-node`? WASM in the browser? This is the fact that matters most to [[08]], because "needs a Python sidecar" and "runs in a tab" are different products.
- **Voice quality and voice choice**, honestly assessed. Sustained textbook reading is hours, not a demo sentence.
- **Licence and model weight size**, since these ship with the app.

Also answer the design question that falls out: if audio arrives as a buffer rather than through `speechSynthesis`, the band no longer moves on `onstart`/`onend` — it moves off the audio element's clock plus the alignment data. **That re-introduces the timing seam [[04]] proposed and [[10]] cancelled.** Say plainly whether it comes back, and in what shape.

Do not decide whether to adopt this; establish what is true. The decision is a later ticket, and it depends on [[05]]'s verdict on whether the cheap thing was already good enough.

## Answer
