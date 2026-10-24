# Prototype 17 — speech without Python

Throwaway prototype for [#17](https://github.com/HyperToken9/reader/issues/17), run 2026-10-23. Evidence, not shippable code: the build ticket ports from here, it does not copy.

Measured on the dev machine (16 cores, 8 intra-op / 1 inter-op threads, CPU EP only) over `corpus/sentences.json` — 206 sentences / 3,969 words from 5 sample books, biased toward numbers, abbreviations, hyphens, quotes, symbols and code.

## Findings

**A. Phonemizer parity.** libespeak-ng 1.52 (the `.so` espeakng-loader ships) called from Node through koffi, plus a 111-line JS port of python-phonemizer's punctuation and post-processing (`phon.mjs`), is **206/206 sentences and 3969/3969 words byte-identical** to what kokoro-onnx feeds its tokenizer. Trimmed to English data it is still identical, at 1.5 MB (0.6 MB xz). The npm `phonemizer` (WASM) is not: 73% of sentences, because WASM only exposes espeak's trace-IPA mode (stresses lone function words: "the" → ðˈə) and an older dictionary. Alignment survived even that (0/4,032 groups changed words), but pronunciation and timings moved by up to 200 ms.

**B. Node port.** `kokoro_node.mjs`, ~320 lines: sliding window, crossfade, pauses, duration → timings, phoneme groups, alignment with a difflib port. Bit-matching Python needed numpy's round-half-to-even, float32 pairwise summation and float32 crossfade arithmetic.

| | words per group | spans incl. times | audio LSD | warm RTF |
|---|---|---|---|---|
| Python vs Python (noise floor: the graph has random ops) | 206/206 | 203/206 | 1.07 dB | 0.292 |
| Node + ORT 1.23.2 vs Python | 206/206 | 203/206 | 1.07 dB | 0.293 |
| Node + ORT 1.29 vs Python | 206/206 | 181/206 | 2.08 dB | 0.34–0.35 |

Audio is never bit-identical, not even Python vs Python, so parity tests compare word spans, not bytes. Two onnxruntime-node versions cannot load in one process (the shared library clashes).

**C. Bundling Python (PyInstaller one-dir).** 114 MB raw, 32.6 MB xz, cold start the same as the venv. Snags: it collects espeakng_loader, kokoro_onnx and phonemizer data by hand; it drags in the build host's espeak 1.50, PulseAudio and X11 through a fallback lookup; it ties to glibc ≥ 2.35; it needs a build per OS. It works, but keeps a second runtime for no gain.

**D. Model hosting.** kokoro-onnx's release `model-files-v1.1/kokoro-v1.0.fp16.onnx` (163.5 MB) already has the int64 `duration` output: same graph as our export, with weights within one fp16 ulp. No torch export is needed and nothing has to be self-hosted. `setup-speech.sh`'s comment that the stock release cannot be used is stale for v1.1.

**Licences.** Weights are Apache-2.0; espeak-ng is GPL-3.0 and ships under every option.

**Not measured:** memory, a 4-core machine, inside Electron (koffi + asarUnpack), a listening test, macOS/Windows.

## Running it

`npm install` here, then `node node_synth.mjs [--bench] [--wasm]` (`ORT_MODULE=` picks the onnxruntime build); `py_synth.py` imports the real `app/electron/tts_server.py` as the reference. `parity.mjs` answers A, `compare.mjs`/`spec_compare.py` answer B. Not committed, and rebuildable: `node_modules`, the venv, the PyInstaller build, the model downloads, the full per-sentence outputs, and `vendor/` (libespeak-ng.so plus the English espeak-ng-data, taken from the espeakng-loader wheel).
