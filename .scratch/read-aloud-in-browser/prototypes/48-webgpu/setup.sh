#!/bin/sh
# PROTOTYPE 48 (throwaway): rebuild everything that is not committed.
#  - ref/: Blitz's Node engine, copied unmodified from origin/dev app/electron/speech,
#    plus prototype 17's kokorojs_phon.mjs (kokoro-js 1.2.1's phonemize, extracted)
#  - node_modules: onnxruntime-web 1.31.1, ort-speech (onnxruntime-node 1.23.2, as the app), koffi, phonemizer, puppeteer-core
#  - extension/ engine.browser.js, phonemize.browser.js, ort/, vendor/
# Needs the model in ~/.config/blitz/speech (Blitz downloads it on first speech) and
# espeak-ng 1.52 at ~/.local/share/blitz-tts/venv/.../espeakng_loader (as prototype 17).
set -e
cd "$(dirname "$0")"
mkdir -p ref
for f in engine.js phonemize.js vocab.json; do git show "origin/dev:app/electron/speech/$f" > "ref/$f"; done
git show origin/worktree-proto-17-node-speech:.scratch/pdf-native-read-aloud/prototypes/17-node-speech/kokorojs_phon.mjs > ref/kokorojs_phon.mjs
npm install --no-audit --no-fund
node scripts/make_browser.mjs
