#!/usr/bin/env bash
# One-time setup for the speech engine.
#
# The Kokoro weights are ~500 MB and cannot live in git, so they go in
# $BLITZ_TTS_HOME (default ~/.local/share/blitz-tts) alongside a Python venv.
# This lives OUTSIDE /tmp on purpose: an earlier build kept it in /tmp and a
# routine cleanup wiped the whole engine.
#
# The stock kokoro-v1.0.onnx release cannot be used: it has no `duration`
# output, so there are no phoneme timings, so the highlight cursor never
# moves. We export our own from the PyTorch checkpoint to get that output.
set -euo pipefail

HOME_DIR="${BLITZ_TTS_HOME:-$HOME/.local/share/blitz-tts}"
KOKORO="$HOME_DIR/kokoro"
mkdir -p "$KOKORO"

echo "==> venv at $HOME_DIR/venv"
if [ ! -x "$HOME_DIR/venv/bin/python" ]; then
  python3 -m venv "$HOME_DIR/venv"
fi
"$HOME_DIR/venv/bin/pip" install --quiet --upgrade pip
"$HOME_DIR/venv/bin/pip" install --quiet kokoro-onnx onnxruntime numpy

echo "==> voices"
[ -f "$KOKORO/voices-v1.0.bin" ] || curl -fL --progress-bar -o "$KOKORO/voices-v1.0.bin" \
  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin

if [ -f "$KOKORO/kokoro-v1.0.fp16.onnx" ]; then
  echo "==> model already exported, skipping"
else
  command -v uv >/dev/null || { echo "uv is required for the export (https://docs.astral.sh/uv/)"; exit 1; }

  echo "==> exporting the model with a duration output (this pulls torch, ~10 min)"
  SRC="$HOME_DIR/kokoro-onnx-main"
  if [ ! -d "$SRC" ]; then
    curl -fL -o "$HOME_DIR/ko.tar.gz" https://github.com/thewh1teagle/kokoro-onnx/archive/refs/heads/main.tar.gz
    tar xzf "$HOME_DIR/ko.tar.gz" -C "$HOME_DIR"
    rm -f "$HOME_DIR/ko.tar.gz"
  fi
  mkdir -p "$SRC/checkpoints"
  [ -f "$SRC/checkpoints/config.json" ] || curl -fL --progress-bar -o "$SRC/checkpoints/config.json" \
    https://huggingface.co/hexgrad/Kokoro-82M/resolve/main/config.json
  [ -f "$SRC/checkpoints/kokoro-v1_0.pth" ] || curl -fL --progress-bar -o "$SRC/checkpoints/kokoro-v1_0.pth" \
    https://huggingface.co/hexgrad/Kokoro-82M/resolve/main/kokoro-v1_0.pth
  (cd "$SRC" && uv run scripts/export.py \
    -c checkpoints/config.json -p checkpoints/kokoro-v1_0.pth \
    -o "$KOKORO/kokoro-v1.0.onnx" --fp16)
fi

echo "==> verifying timings"
"$HOME_DIR/venv/bin/python" - "$KOKORO" <<'PY'
import sys, onnxruntime as ort
from kokoro_onnx import Kokoro
k = sys.argv[1]
s = ort.InferenceSession(f"{k}/kokoro-v1.0.fp16.onnx", providers=["CPUExecutionProvider"])
kok = Kokoro.from_session(s, f"{k}/voices-v1.0.bin")
assert kok.has_timings, "export has no duration output"
audio, sr, timings = kok.create_timed("Setup complete.", voice="bf_emma", speed=1.0, continuous=True)
print(f"    {len(audio)} samples at {sr} Hz, {len(timings)} phoneme timings")
PY

echo "==> speech engine ready in $HOME_DIR"
