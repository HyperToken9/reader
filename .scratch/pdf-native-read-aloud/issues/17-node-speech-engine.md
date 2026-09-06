# 17 — Take Python out of the download

Type: prototype
Status: open
Blocked by: 16

## Question

[08](08-ship-platform.md) shipped an app you can download, with one thing wrong with that sentence: speech is a Python child process, and `npm run setup:speech` asks the user to build a venv and export an ONNX model before the app can talk. That is a developer setup, not an install.

Everything else in the app is already native Node — the layout model runs on `onnxruntime-node` in the Electron main process. Speech is the only reason Python is in the picture, and only because [14](14-adopt-local-tts.md) adopted Kokoro and `kokoro-onnx` is the working implementation.

`app/electron/tts.js` was built as the seam for exactly this: the renderer calls `synthesize`/`voices` over IPC and cannot see how speech is produced, so the engine can be replaced without touching the reading loop.

What has to be answered:

- **Phonemization.** `kokoro-onnx` reaches espeak-ng through `misaki`/`espeakng-loader`. In JS the candidates are the `phonemizer` npm package (espeak-ng compiled to WASM, which is what `kokoro-js` uses) and calling a bundled espeak-ng binary. Do either produce phoneme strings *identical* to what the Python path produces? Not similar — identical, because [16](16-kokoro-reading-loop.md)'s word alignment content-matches phoneme groups against per-word phonemization, and a divergence there moves the highlight off the word.
- **What must be ported.** `create_timed`, the `continuous=True` sliding-window synthesis (adopted because kokoro-onnx returns *empty audio* on some sentences without it), the `duration` → phoneme-timing conversion, and `phoneme_groups`/`align_groups_to_words`. Roughly 400 lines of Python with real edge cases in it. Port, or keep Python and bundle a frozen interpreter?
- **Bundling instead.** PyInstaller or a relocated venv shipped inside the AppImage sidesteps the port entirely, at the cost of ~200 MB and a second runtime in the package. Weigh it honestly rather than assuming the port wins.
- **The weights either way.** ~500 MB of model, which cannot go in the bundle at a sane download size. First-run download with a progress UI, or an installer step?

Blocked by [16](16-kokoro-reading-loop.md) because the alignment behaviour a new engine has to reproduce is exactly what 16 is still being judged on. Porting against a target that may still move is wasted work.

## Answer
