# Research — Local neural TTS: alignment data, latency and shape (2026-09)

For ticket `.scratch/pdf-native-read-aloud/issues/11-local-neural-tts.md`.

Method: **hands-on measurement on this machine** for the two candidates that could be installed
cheaply (Piper, Kokoro), with repo source and model cards as primary evidence for licensing and
capability claims. Everything labelled **[measured]** was run here; everything labelled
**[documented]** is a published figure I did not reproduce and should be trusted accordingly.
Search results and blog posts were used only to locate primary sources.

**Test machine**: AMD Ryzen 7 5800H, 16 threads, 13 GB RAM, Linux, Python 3.10.12,
`onnxruntime` 1.23.2 (installs cleanly from PyPI, no build step). All timings are single-run
wall-clock on an otherwise idle machine, CPU only — **no GPU was used or needed**.

Working directory, still on disk: `/tmp/claude-1000/tts/` (venv, models, `bench_*.py`, `samples/`).

---

## TL;DR

1. **Yes — both models return alignment data, and Piper's is exact.** This is the load-bearing
   answer. Piper 1.8.0 returns a per-phoneme **sample count** for every phoneme it synthesised, and
   those counts **sum to the produced audio exactly — zero sample error, measured on three
   sentences** (§3.1). It is not an estimate laid over the audio; it *is* the allocation the vocoder
   used. Kokoro can do the same at phoneme level, but only through a **separate timestamped model
   export** (§3.2).

2. **Word-level highlighting is back on the table.** Both models emit a literal `' '` phoneme
   between words, so word spans fall straight out of the alignment stream by splitting on it. The
   catch is honest and measurable: espeak-ng **cliticises function words**, so "on the" comes back as
   one group `ɔnðə`. Over 106 words of textbook prose I measured **102 phoneme groups — a 3.8%
   deficit, with 3 of 8 sentences affected** (§3.3). The cursor would occasionally cover two words
   instead of one. It would never *drift*.

3. **Piper is startlingly fast and Kokoro is not.** Piper: **RTF 0.045 — 22x faster than real
   time**, ~200-350 ms to synthesise a whole sentence [measured]. Kokoro on the same CPU and the same
   sentences: **RTF 0.41-0.55, only 1.8-2.4x real time**, and **1.8-3.6 seconds per sentence**
   [measured]. Kokoro sustains playback but costs ~2-3 s of dead air when you press play. Piper's
   press-play latency is ~200 ms.

4. **Licensing is the trap, and the popular summary of it is wrong.** Piper is **GPL-3.0**, not MIT
   — the MIT `rhasspy/piper` was archived in October 2025 and the maintained
   `OHF-Voice/piper1-gpl` is GPL because it links espeak-ng (§5). Kokoro's *weights* are Apache-2.0,
   but the ordinary Python path (`kokoro-onnx` → `phonemizer` → espeak-ng) drags GPL in through the
   phonemiser anyway. Several 2026 write-ups still say "Piper (MIT)". They are stale.

5. **The timing seam [[04]] proposed and [[10]] cancelled does come back — but in a much better
   shape than either ticket imagined.** Audio arrives as a buffer, so the band moves off an audio
   clock rather than `onstart`/`onend`. But because the alignment is exact and known *before*
   playback starts, the band's position is a **lookup in a precomputed span table**, not a model.
   No cadence estimate, no drift, no re-seeding, no watchdog (§6).

6. **It is a Python sidecar, or a rewrite.** Both models run today as a Python process. There is a
   credible in-browser path for Kokoro (`kokoro-js` / Transformers.js, WASM or WebGPU) but **not a
   verified one for Piper**, and the browser path is exactly the one whose speed I could not measure
   (§4). This is the fact that matters most to [[08]].

7. **I cannot judge voice quality and did not try.** I generated four samples for you to listen to:
   `/tmp/claude-1000/tts/samples/{piper_lessac_medium,kokoro_af_heart,kokoro_bf_emma,kokoro_am_michael}.wav`
   (§7). The published consensus is that Kokoro is clearly the better voice; my measurements say it
   costs 12x the compute to get it.

---

## 1. What was actually installed, and how easily

Both installed without incident. This is itself a finding — "needs a model runtime" turned out to
cost one `pip install` each, no compiler, no CUDA, no system packages.

| | command | wheel / deps | outcome |
|---|---|---|---|
| ONNX Runtime | `pip install onnxruntime` | 1.23.2 | clean, ~30 s |
| Piper | `pip install piper-tts` | **1.8.0**, 34.1 MB manylinux wheel | clean; `onnx` also needed for alignments |
| Kokoro | `pip install kokoro-onnx` | pulls `espeakng-loader`, `phonemizer`, `numpy`, `onnxruntime` | clean |

Piper bundles its own espeak-ng data directory inside the wheel
(`venv/lib/python3.10/site-packages/piper/espeak-ng-data`), so there is no system espeak dependency.
Kokoro's `kokoro-onnx` uses `espeakng-loader` to the same end. Neither needed `apt`.

Model downloads:

| file | bytes | note |
|---|---|---|
| `en_US-lessac-medium.onnx` | 63,201,294 (63.2 MB) | Piper medium, 22,050 Hz |
| `en_US-ryan-high.onnx` | 120,786,792 (120.8 MB) | Piper high tier, size read from HF `x-linked-size` header |
| `kokoro-v1.0.onnx` | 325,532,387 (325.5 MB) | fp32, audio output only |
| `kokoro-timestamped-fp16.onnx` | 163,232,776 (163.2 MB) | fp16, **audio + durations** |
| `voices-v1.0.bin` | 28,214,398 (28.2 MB) | all 54 Kokoro voices in one file |

Piper's voice downloader is a module, not a separate service: `python -m piper.download_voices
en_US-lessac-medium --data-dir voices` took **4.9 s** for the 63 MB voice [measured].

---

## 2. Latency and real-time factor — measured on this machine

### 2.1 Piper 1.8.0, `en_US-lessac-medium`, CPU

Script: `/tmp/claude-1000/tts/bench_piper.py`.

```
import piper            :   112.1 ms
PiperVoice.load(...)    :   928.9 ms   <- includes the alignment "patch" step (§3.1)

COLD  1st sentence      :   355.9 ms synth /  6.78 s audio   RTF 0.052

STEADY STATE (with alignments)
   315.5 ms /  6.88 s   RTF 0.046   (124 chars)
   207.2 ms /  4.55 s   RTF 0.046   ( 79 chars)
   200.1 ms /  4.42 s   RTF 0.045   ( 79 chars)
   202.2 ms /  4.71 s   RTF 0.043   ( 85 chars)
   218.5 ms /  4.82 s   RTF 0.045   ( 84 chars)
   TOTAL RTF 0.0450  ->  22.2x faster than real time

No-alignment TOTAL RTF  0.0443   (alignments cost ~1.6% — effectively free)
```

**Cold start is ~1.04 s total** (112 ms import + 929 ms model load) and is paid once, at app
startup, not at press-play. **Press-play latency is one sentence's synthesis: ~200-350 ms.**

There is no meaningful warm-up curve — the "cold" first sentence at RTF 0.052 is barely slower than
steady state at 0.045. ONNX Runtime's graph optimisation happens at session creation, which is
already inside the 929 ms load.

**Piper does not stream sub-sentence.** `voice.synthesize()` returns an iterator, but the first
chunk it yielded for a 6.76 s sentence was the entire 6.76 s of audio, arriving at 300 ms
[measured]. So time-to-first-audio equals whole-sentence synthesis time. At 200-350 ms that is fine,
and it means the unit of scheduling stays the sentence — exactly the shape `prototype-05` already
has.

**Headroom is the real story.** While one 5 s sentence plays, Piper can synthesise ~110 s of audio.
A whole page can be rendered to audio during the first sentence.

### 2.2 Kokoro v1.0, `af_heart`, CPU

Scripts: `bench_kokoro.py`, `bench_kokoro_timed.py`.

```
import kokoro_onnx      :   196.9 ms
Kokoro() load (fp32)    :   958.8 ms

COLD  1st sentence      :  2576.9 ms synth /  7.77 s audio   RTF 0.332

STEADY STATE (default onnxruntime threading)
  3642.4 ms /  7.77 s   RTF 0.469
  3091.8 ms /  5.16 s   RTF 0.599
  2563.0 ms /  4.80 s   RTF 0.534
  3080.9 ms /  5.27 s   RTF 0.585
  3054.4 ms /  5.25 s   RTF 0.582
  TOTAL RTF 0.5464  ->  1.8x faster than real time
```

I re-ran it with explicit thread tuning in case a bad default was understating it
(`intra_op_num_threads=16`, `ORT_ENABLE_ALL`), because publishing an unfair number would be worse
than publishing none:

```
tuned, fp32, one sentence:  2160 / 2056 / 2054 / 1827 ms   RTF 0.450 -> 0.381
tuned, fp16 timestamped:    steady-state TOTAL RTF 0.4089  ->  2.4x real time
                            model load 1558.2 ms
```

So Kokoro's honest best on this CPU is **RTF ~0.40, 2.4x real time, ~1.8-2.4 s per sentence**.
Thread tuning is worth ~25% and should be applied; it does not change the category.

### 2.3 The comparison that matters

| | Piper medium | Kokoro fp16 (tuned) |
|---|---|---|
| cold start (import + load) | **1.04 s** | 1.75 s |
| press-play latency (1 sentence) | **~200-350 ms** | ~1.8-2.4 s |
| RTF | **0.045** | 0.41 |
| speed vs real time | **22x** | 2.4x |
| audio synthesisable per 5 s of playback | ~110 s | ~12 s |

**Both can be pipelined ahead** the way [[04]] keeps two utterances in flight, and both stay ahead
of playback indefinitely. The difference is entirely in the *first* sentence. Kokoro's ~2 s of dead
air on pressing play is a real product defect, not a rounding error — though it is hideable by
synthesising the first sentence of a page during page render rather than on the play click.

---

## 3. Alignment data — the load-bearing question

### 3.1 Piper returns exact per-phoneme sample counts

Piper gained "experimental support for alignments" in **v1.3.1**, documented in
[`docs/ALIGNMENTS.md`](https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/ALIGNMENTS.md). The
current release is 1.8.0.

Two things must be true to get them, and both are cheap:

- The voice must be **"patched"** — an `onnx` graph edit that exposes the duration tensor the model
  already computes internally. Passing `include_alignments=True` to `PiperVoice.load()` does it in
  memory at load time (this is most of the 929 ms load cost); a CLI tool can pre-patch the file to
  avoid paying it per launch. Requires the `onnx` package, not just `onnxruntime`.
- `include_alignments=True` on the `synthesize()` call.

The `AudioChunk` dataclass then carries `phonemes`, `phoneme_ids`, `phoneme_id_samples` and
`phoneme_alignments` [verified by introspection]. A `PhonemeAlignment` is
`(phoneme, phoneme_ids, num_samples)`.

Measured output for `"The cat sat on the mat."` at 22,050 Hz:

```
phonemes: ['ð','ə',' ','k','ˈ','æ','t',' ','s','ˈ','æ','t',' ','ɔ','n','ð','ə',' ','m','ˈ','æ','t','.']

PhonemeAlignment(phoneme='^', num_samples=1280)   <- sentence-start sentinel
PhonemeAlignment(phoneme='ð', num_samples=1024)
PhonemeAlignment(phoneme='ə', num_samples=512)
PhonemeAlignment(phoneme=' ', num_samples=512)    <- word separator
PhonemeAlignment(phoneme='k', num_samples=768)
...
PhonemeAlignment(phoneme='$', num_samples=768)    <- sentence-end sentinel
```

**Accuracy — and this is the strongest claim in this document.** I checked whether the sample counts
account for the audio exactly, on three sentences of increasing length:

```
PIPER: sum(alignment samples) vs actual audio samples
  audio   29952   align   29952   delta  +0 samples =  +0.0 ms
  audio  147200   align  147200   delta  +0 samples =  +0.0 ms
  audio  102400   align  102400   delta  +0 samples =  +0.0 ms
```

**Zero error.** The alignment is a *partition* of the produced waveform, not a measurement of it.
This is structural, not luck: Piper is a VITS model, the duration predictor decides how many frames
each phoneme gets, and the vocoder then produces exactly that much audio. There is no possible
accumulating error, no calibration constant, and nothing to drift. Contrast [[04]] §6, where the
cadence fallback's error was *unbounded and linear*.

The important caveat on the word "accurate": these are the model's own **predicted** durations, so
they are exact with respect to *the audio Piper generated* and are not a claim about how a human
would have said it. For driving a highlight over that exact audio, that is precisely the right
notion of accuracy and the only one that matters.

Cost of alignments: **~1.6% synthesis overhead** (RTF 0.0450 vs 0.0443) [measured]. Effectively free.

### 3.2 Kokoro returns phoneme timings, but only from a different model file

The plain `kokoro-v1.0.onnx` **cannot** produce alignments. Read straight off the graph:

```
kokoro-v1.0.onnx
  INPUTS : [('tokens', [1,'sequence_length']), ('style',[1,256]), ('speed',[1])]
  OUTPUTS: [('audio', ['audio_length'])]                       <- audio only
```

The community re-export
[`onnx-community/Kokoro-82M-v1.0-ONNX-timestamped`](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped)
(Apache-2.0) adds the durations tensor:

```
kokoro-timestamped-fp16.onnx
  INPUTS : [('input_ids',[1,'sequence_length']), ('style',[1,256]), ('speed',[1])]
  OUTPUTS: [('waveform',[1,'num_samples']), ('durations',[1,'sequence_length'])]
```

`kokoro-onnx` has a `create_timed()` API for exactly this, documented as *"Create audio and report
when each phoneme is spoken. The timings are empty unless the model exposes a duration output."*

**It silently returns nothing, and I found out why.** `Kokoro._setup` contains:

```python
self.has_timings = "duration" in {o.name for o in session.get_outputs()}
```

The export names the output **`durations`** (plural). The check looks for **`duration`** (singular),
so `has_timings` is `False`, `create_timed()` returns `timings=0`, and no error is raised. Forcing
`k.has_timings = True` immediately produced correct output:

```
audio 1.409 s  sr 24000  timings 23
Timing(phoneme='ð', start=0.0900, end=0.1170)
Timing(phoneme='ə', start=0.1170, end=0.1488)
Timing(phoneme=' ', start=0.1488, end=0.1973)
Timing(phoneme='k', start=0.1973, end=0.2482)
...
```

This is a one-line upstream bug worth reporting, and a one-line local workaround. But it is a fair
signal about maturity: **Piper's alignment path is a documented, tested feature; Kokoro's is a
community re-export plus a library that cannot detect it.**

Kokoro's timings are nicer to consume than Piper's — absolute `start`/`end` seconds rather than
sample counts you must cumulatively sum. Substantively they are the same thing from the same place:
a duration predictor's output.

The official PyTorch package (`hexgrad/kokoro`, `KPipeline`) goes one step further and computes
**word-level** `start_ts`/`end_ts` on its `MToken` objects, in
[`kokoro/pipeline.py`](https://github.com/hexgrad/kokoro/blob/main/kokoro/pipeline.py):

```python
if output is not None and output.pred_dur is not None:
    KPipeline.join_timestamps(tks, output.pred_dur)
```

with `t.start_ts = left / MAGIC_DIVISOR` and `MAGIC_DIVISOR = 80`. So word grouping is done for you
— but that path requires **PyTorch**, which is a far heavier dependency than anything else in this
document, and I did not install or measure it. **[documented, not measured]**

### 3.3 Getting *words* out of phonemes — measured, and honestly imperfect

Neither model hands you word spans in the ONNX path. Both emit a literal `' '` phoneme between
words, so the algorithm is: walk the alignment list, accumulate time, cut a span at every `' '`,
discard the `^`/`$` sentinels.

That yields groups, and the question is whether groups equal words. I measured it over 8 sentences
of textbook-style prose (`bench_align.py`):

```
words  17   groups  16   delta -1
words  11   groups  11   delta +0
words  14   groups  13   delta -1
words  11   groups  11   delta +0
words  13   groups  13   delta +0
words  13   groups  11   delta -2
words  13   groups  13   delta +0
words  14   groups  14   delta +0

TOTAL words 106  groups 102  delta -4  (-3.8%)   sentences with a mismatch: 3/8
```

The failure is systematic and benign: **espeak-ng cliticises unstressed function words onto their
neighbour.** Visible directly in the spans for `"The cat sat on the mat."`:

```
0.046 -> 0.116   ðə        "The"
0.139 -> 0.313   kˈæt      "cat"
0.337 -> 0.546   sˈæt      "sat"
0.580 -> 0.731   ɔnðə      "on the"   <- two words, one group
0.755 -> 1.207   mˈæt.     "mat."
```

Six orthographic words, five groups. Kokoro's timings show the identical grouping (`ɔ n ð ə` with no
intervening space), because both use espeak-ng.

**What this means for the word cursor**: it would highlight "on the" as a single unit, occasionally,
at a rate of roughly one merge per 25 words. It would never be *wrong* — the highlighted region
always genuinely contains the words being spoken at that instant. Compare [[04]] §6's rejected
estimator, which after one 220-word chunk was 20-30 words adrift and "actively misleading". A
cursor that is sometimes one word wide and sometimes two is a different and far more acceptable
class of imprecision.

**Two hazards I did not quantify, flagged honestly:**

- **Text normalisation changes the word count.** espeak-ng expands "55" to "fifty five" and "Dr." to
  "doctor", which *adds* groups. My corpus was deliberately written out in words, so this is
  untested. For textbook prose full of numbers, units and equations this could matter more than the
  clitic merges — and it cuts the opposite way, so the two do not cancel. Mapping groups back to
  PDF.js text-layer offsets ([[02]]) must therefore be an **alignment** between two sequences, not a
  zip of two equal-length lists.
- **Long-run desynchronisation.** With one sentence per synthesis call, a bad mapping can only be
  wrong within that sentence and resets at the next one. This is the same property that made
  [[10]]'s one-sentence-per-utterance decision correct, and it survives the switch to buffers intact.

---

## 4. How it is actually invoked from an app

This is the fact that matters most to [[08]], and it is the least favourable one.

**Today, on this machine, both are a Python process.** That is what I ran. `pip install piper-tts`,
load a voice, call `synthesize()`, get a numpy float array plus alignments. For a local prototype
served over `http://localhost` (which [[04]] §8 already requires for the PDF.js worker), a small
Python HTTP sidecar returning `{wav, spans[]}` per sentence is a genuinely small piece of work, and
Piper's 22x RTF means it would never be the bottleneck.

**In-browser paths, in decreasing order of confidence:**

- **Kokoro in the browser: credible and documented.** `npm i kokoro-js` (Transformers.js) runs
  Kokoro fully client-side with `device: "wasm" | "webgpu" | "cpu"` and dtypes `fp32/fp16/q8/q4/q4f16`,
  per the [ONNX community model card](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped)
  and [`kokoro-js` on npm](https://www.npmjs.com/package/kokoro-js). q8 is ~92 MB.
  **[documented — I did not run it, and did not measure browser RTF].** Given Kokoro's native CPU RTF
  of 0.41 here, WASM would plausibly be *slower* than real time and WebGPU faster; that gap is
  exactly the thing I could not measure and it decides the whole in-browser question.
- **Piper in the browser: unverified.** Piper's ONNX model is small and its inputs are simple, so
  running it under `onnxruntime-web` or `onnxruntime-node` is plausible on its face. The blocker is
  not the model, it is **espeak-ng** — the phonemiser is a C library that would need its own WASM
  build, and it is also the source of the GPL obligation (§5). Community WASM ports exist; I did not
  verify any of them. **[gap — treat as unproven]**
- `piper1-gpl` also ships a **C/C++ API (`libpiper`)** and a **web server**, per the repo README, so
  "no Python" does not have to mean "in the browser".

**The honest framing for [[08]]**: today this is a **local app with a model sidecar**, not a thing
that runs in a tab. Kokoro has the only documented tab-shaped story, and it is the slow model.
Piper has the numbers and not the browser story.

---

## 5. Licence and size — the trap

**Piper is GPL-3.0.** The repository is literally named `OHF-Voice/piper1-gpl` and carries `COPYING`
= GPL-3.0. The history: the original `rhasspy/piper` was **MIT** and was **archived read-only in
October 2025**; development moved to the Open Home Foundation's `piper1-gpl`, which is GPL because
it links **espeak-ng** (GPL) for phonemisation. Upstream states espeak is technically optional and
intended to be replaced, and v1.4.0 already added `--data.phoneme_type text` for supplying IPA
phonemes directly without espeak-ng — a plausible future escape hatch from the GPL, not a present
one.

> **Stale-guidance flag.** Multiple 2026 write-ups still summarise the field as "the genuinely safe
> commercial picks are Kokoro (Apache-2.0), Chatterbox (MIT), and **Piper (MIT)**". The Piper half
> of that is a year out of date. Anyone pinning MIT Piper is pinning archived, unmaintained code.

**Piper voice models are licensed separately and individually.** `docs/VOICES.md`: *"Piper is
intended for personal use and text to speech research only; we do not impose any additional
restrictions on voice models. Some voices may have restrictive licenses, however, so please review
them carefully!"* Each voice has its own `MODEL_CARD`. The one I used, `en_US-lessac-medium`, is
trained on the Blizzard 2013 Lessac corpus and inherits **CSTR Edinburgh's licence**, which is a
research licence, not a permissive one. **Per-voice licence review is mandatory, not a formality.**

**Kokoro-82M is Apache-2.0** (82M params, StyleTTS2 + ISTFTNet, v1.0 released 2025-01-27, 8
languages / 54 voices, trained only on permissively-licensed and public-domain audio, ~1000 A100
hours). The community ONNX exports are Apache-2.0 too. **But the ordinary Python route
(`kokoro-onnx`) depends on `phonemizer` + espeak-ng, so GPL re-enters through the phonemiser** even
though the weights are clean. The `kokoro-js`/Transformers.js route uses a JS phonemiser and is the
one that actually realises the Apache-2.0 promise.

**Shipping weight:**

| stack | bytes to ship |
|---|---|
| Piper runtime + 1 medium voice | 34.1 MB wheel + 63.2 MB = **~97 MB** |
| Piper runtime + 1 high voice | 34.1 MB + 120.8 MB = ~155 MB |
| Kokoro fp32 + all voices | 325.5 + 28.2 MB = ~354 MB |
| Kokoro fp16 timestamped + voices | 163.2 + 28.2 MB = **~191 MB** |
| Kokoro q8 (browser) + voices | ~92.4 + 28.2 MB = ~121 MB |

Kokoro's 28.2 MB `voices-v1.0.bin` buys **all 54 voices at once**; Piper charges 63 MB per voice, so
a multi-voice Piper app crosses over quickly.

---

## 6. The design question: does the timing seam come back?

**Yes — and it comes back smaller and safer than [[04]] designed it or [[10]] feared.**

The mechanical change is real. `speechSynthesis.speak()` is replaced by an `AudioBuffer` fed to an
`AudioBufferSourceNode` (or a blob URL on an `<audio>` element). `onstart`/`onend` are gone as the
band's clock. In their place:

- **Sentence advance** is still an event, not an estimate: `AudioBufferSourceNode.onended`, or the
  `ended` event on the audio element. This maps one-to-one onto `speakOne()`'s existing `u.onend` in
  `prototype-05/main.js:487`, and [[10]]'s "one sentence per unit" invariant is untouched.
- **Word position** is `requestAnimationFrame` reading `audioCtx.currentTime - startedAt` (or
  `audio.currentTime`) and **binary-searching a precomputed span array**. The spans are known in full
  before the first sample plays.

The distinction that matters, and the reason [[10]]'s cancellation was right *then* and is wrong
*now*: [[04]]'s seam was an abstraction over **an unsolved estimation problem**, with three
implementations because nobody knew which would work and all three could drift. There is no
estimation here. The alignment is exact (§3.1) and it is data, not a model. What replaces
`onstart`/`onend` is **a lookup table**, so the entire failure catalogue [[04]] §6 and [[10]] built
against — calibration error, unbounded linear drift, re-seeding at chunk end, the 1400 ms watchdog,
punctuation hold constants — is not merely unnecessary, it is inapplicable.

Concretely, what [[10]] cancelled and what its status becomes:

| [[10]] cancelled | status under local neural TTS |
|---|---|
| the word cursor | **reopened** — the reason it was dropped (Linux emits no boundaries) does not apply to a model that ships its own timings |
| `{wordIndex, atTime}` timing seam | **returns**, but as an exact span table, not a 3-implementation abstraction over an unknown |
| estimated cadence / drift model | **stays cancelled, permanently** — nothing to estimate |
| voice-picker sync-capability labelling | **stays cancelled** — every local voice has timings, so there is nothing to warn about |
| `localService === false` predictor | **stays cancelled** — no longer a browser voice |

Two genuinely new problems arrive that browser TTS did not have, and they should be named rather
than discovered later:

1. **Buffer lifecycle.** `speechSynthesis` owned the queue; now the app does. Pause/resume/seek/rate
   become the app's job. Most of this is *easier* — seeking within a sentence is now possible at all,
   which `speechSynthesis` never allowed — but `pump()` (`main.js:497`) grows from "keep 2 utterances
   queued" into "keep N seconds of synthesised audio ahead of the playhead", and needs a memory bound.
   Piper's 22x RTF makes a 1-2 sentence lookahead trivially sufficient; don't buffer the page.
2. **Rate change becomes cheap, and changes shape.** [[04]] §5.3 established that `rate` cannot
   change mid-utterance and requires `cancel()` + re-dispatch (`main.js:705`). With buffers,
   `playbackRate` on the source node changes speed instantly with no re-synthesis — but it also
   rescales every span, so the lookup must divide by the rate. Piper additionally has a native
   length-scale parameter that changes speed *without* pitch-shifting, which `playbackRate` does not.
   These are different products and the choice should be deliberate.

---

## 7. Voice quality — I did not judge it, and you should

I have no ears. Rather than repeat MOS scores I cannot verify, I synthesised the same four-sentence
textbook paragraph through both models and left the files for you:

```
/tmp/claude-1000/tts/samples/piper_lessac_medium.wav    Piper, en_US-lessac-medium
/tmp/claude-1000/tts/samples/kokoro_af_heart.wav        Kokoro, af_heart   (US female)
/tmp/claude-1000/tts/samples/kokoro_bf_emma.wav         Kokoro, bf_emma    (GB female)
/tmp/claude-1000/tts/samples/kokoro_am_michael.wav      Kokoro, am_michael (US male)
```

What can be said without ears:

- **The published consensus is strongly pro-Kokoro.** Its model card claims quality "comparable to
  larger models" at 82M params, and it is the model that got the attention in 2025. Piper is
  universally described as fast-and-decent rather than natural.
- **Kokoro offers 54 voices in one 28 MB file across 8 languages**; Piper offers many voices but at
  63 MB each and with per-voice licences (§5). For voice *choice*, Kokoro wins outright.
- **The relevant test is not a demo sentence.** The ticket is right that this is hours of sustained
  reading, where artefacts that are charming for ten seconds become intolerable. Both models are
  non-autoregressive and deterministic, so neither should exhibit the drift-into-nonsense failure
  that afflicts LLM-based TTS on long inputs — but per-sentence synthesis also means neither carries
  prosody across a sentence boundary, and whether that reads as "measured" or "flat" over a chapter
  is a listening judgement, not a measurement.
- Piper's medium tier is **22,050 Hz**; Kokoro is **24,000 Hz** [both measured from the output]. Piper
  has a `high` tier at 22,050 Hz with a larger model (120.8 MB) that I did not synthesise with.

**Recommendation: listen to those four files before anything else in this document is acted on.** If
Piper is listenable, the decision is easy, because everything else about Piper is better. If it is
not, the decision becomes a real trade between a 2 s press-play delay and a good voice.

---

## 8. The other candidates, and "omnitts"

These are **[documented, not measured]** — I prioritised getting real numbers for the two viable
candidates over surveying models this machine cannot run well.

- **"omnitts" — I could not identify it, and I do not believe it exists under that name.** No TTS
  project by that name surfaced. The most likely intended referents, in order: **OuteTTS** (v1.0,
  Sept 2025 — pure language-modelling TTS on a Qwen3 backbone, GGUF/llama.cpp friendly, zero-shot
  cloning), which is the closest phonetic match; or one of the **Qwen-Omni** multimodal models, which
  do speech output as one modality among several. Both are autoregressive LLM-based, which means
  **no duration predictor and therefore no free alignment** — timings would need a separate forced
  alignment pass. Worth a direct question to the human rather than more guessing.
- **MeloTTS** — named in the ticket; I did not get to it. **[gap]** It is VITS-family like Piper, so
  it would plausibly have the same duration-predictor alignment story, but I did not verify that.
- **XTTS-v2 (Coqui)** — licensed **CPML, non-commercial only**. Coqui shut down in January 2024, so
  **there is nobody left to sell a commercial licence**. That makes it a dead end for anything but
  personal use regardless of its merits.
- **F5-TTS** — code MIT, but the **published weights are CC-BY-NC-4.0** (the maintainers attribute
  this to the Emilia training set). "MIT" in headlines refers to the code only. Flow-matching
  architecture; heavy.
- **Chatterbox (Resemble AI)** — genuinely **MIT**, code and weights, with emotion control and
  zero-shot cloning. The most permissively licensed of the high-quality models. But it is a large
  autoregressive model built for GPU; on this CPU it would be far below real time, and like all
  autoregressive TTS it has no duration predictor to read alignments from.
- **Orpheus TTS (Canopy AI)** — **3B params, Llama-3 based**, ~8 GB VRAM at Q4/Q8, ~200 ms streaming
  latency *on a GPU*. This machine has 13 GB of system RAM and no usable GPU for it. Out of scope.

**The pattern worth extracting:** the models that give you alignment for free are exactly the
**non-autoregressive, duration-predictor** architectures — VITS (Piper) and StyleTTS2 (Kokoro).
Every LLM-based TTS (Orpheus, OuteTTS, Chatterbox, XTTS) generates audio tokens without ever
computing a phoneme duration, so word timing requires a **separate forced-alignment pass** over the
generated audio — a second model, more latency, and approximate results. **The architectures that
are fastest on CPU and the architectures that give you timings are the same architectures.** That is
a happy coincidence and it points hard at Piper and Kokoro.

---

## 9. What I did not establish

Stated plainly so it is not mistaken for settled:

- **Browser RTF for Kokoro under WASM or WebGPU.** Not measured. This single number decides whether
  the in-browser story is real (§4).
- **Whether Piper can run in a browser at all**, given espeak-ng. Unverified (§4).
- **Voice quality.** Not judged; samples provided (§7).
- **Text-normalisation effects on word mapping** — numbers, units, abbreviations, which textbooks are
  full of and my test corpus deliberately avoided (§3.3).
- **MeloTTS**, and any measurement of the §8 models.
- **Long-run behaviour** — I synthesised individual sentences, not a chapter. Memory growth,
  thermal throttling on sustained load, and whether RTF holds over thousands of sentences are all
  untested.
- **The PyTorch `kokoro` package's word-level timestamps** — read from source, never run (§3.2).

---

## Sources

Primary — repositories and source code:
- [OHF-Voice/piper1-gpl](https://github.com/OHF-Voice/piper1-gpl) — current Piper, GPL-3.0 (`COPYING`)
- [piper1-gpl `docs/ALIGNMENTS.md`](https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/ALIGNMENTS.md) — the alignment contract
- [piper1-gpl `CHANGELOG.md`](https://github.com/OHF-Voice/piper1-gpl/blob/main/CHANGELOG.md) — alignments added in v1.3.1; current 1.8.0
- [piper1-gpl `docs/VOICES.md`](https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/VOICES.md) — per-voice licences
- [rhasspy/piper](https://github.com/rhasspy/piper) — archived Oct 2025, MIT
- [rhasspy/piper#93 — licence question](https://github.com/rhasspy/piper/issues/93) and [discussion #582 — relation between piper and espeak](https://github.com/rhasspy/piper/discussions/582)
- [hexgrad/kokoro `kokoro/pipeline.py`](https://github.com/hexgrad/kokoro/blob/main/kokoro/pipeline.py) — `join_timestamps`, `MAGIC_DIVISOR = 80`
- `kokoro_onnx` installed source, `Kokoro._setup` / `Kokoro._infer` — the `"duration"` vs `"durations"` bug (§3.2)
- [SWivid/F5-TTS `LICENSE`](https://github.com/SWivid/F5-TTS/blob/main/LICENSE) — MIT code, CC-BY-NC weights
- [resemble-ai/chatterbox](https://github.com/resemble-ai/chatterbox) — MIT

Primary — model cards:
- [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) — 82M params, Apache-2.0, v1.0 2025-01-27
- [onnx-community/Kokoro-82M-v1.0-ONNX-timestamped](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped) — the durations export
- [Timestamp-extraction discussion on that repo](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped/discussions/2)
- [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) — voices + `MODEL_CARD` files; `en_US-lessac-medium` inherits the CSTR Blizzard 2013 licence
- [coqui/XTTS-v2](https://huggingface.co/coqui/XTTS-v2) and [CPML discussion #4304](https://github.com/coqui-ai/TTS/discussions/4304)
- [kokoro-js on npm](https://www.npmjs.com/package/kokoro-js)

Measured on this machine (scripts retained in `/tmp/claude-1000/tts/`):
- `bench_piper.py` — Piper cold start, TTFA, RTF, alignment dump
- `bench_align.py` — phoneme-group vs word counts over 8 sentences; per-group spans
- `bench_kokoro.py` — Kokoro fp32 cold start and RTF
- `bench_kokoro_timed.py` — Kokoro fp16 timestamped RTF and `create_timed()`
- `samples/*.wav` — four listenable samples (§7)
